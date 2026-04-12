/**
 * MCP Authorization Proxy
 *
 * HTTP reverse proxy between agent containers and remote MCP servers.
 * Inspects MCP tools/call requests and enforces per-group access policies.
 *
 * Architecturally identical to the credential proxy (src/credential-proxy.ts):
 * a lightweight HTTP server on the host that intercepts and evaluates requests.
 *
 * See docs/REMOTE-MCP-SERVERS.md for the full specification.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpRequest } from 'http';

import { logger } from './logger.js';
import {
  evaluatePolicy,
  resolveTier,
  type PolicySet,
  type PolicyAssignments,
} from './mcp-policy.js';

export interface McpAuthProxyConfig {
  /** server name → upstream URL */
  upstreams: Map<string, string>;
  policies: PolicySet;
  /** server name → policy assignments (default tier, group → tier) */
  assignments: Map<string, PolicyAssignments>;
}

/**
 * Start the MCP authorization proxy.
 * Returns the server instance and the actual port (useful when port=0).
 */
export function startMcpAuthProxy(
  port: number,
  host: string,
  config: McpAuthProxyConfig,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      handleRequest(req, res, config).catch((err) => {
        logger.error({ err }, 'MCP auth proxy unhandled error');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal proxy error' }));
        }
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as { port: number };
      logger.info({ port: addr.port, host }, 'MCP authorization proxy started');
      resolve({ server, port: addr.port });
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: McpAuthProxyConfig,
): Promise<void> {
  // Parse server name from URL path: POST /{serverName}
  const serverName = (req.url || '/').replace(/^\//, '').replace(/\/.*$/, '');
  if (!serverName) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing server name in URL path' }));
    return;
  }

  // Look up upstream
  const upstreamUrl = config.upstreams.get(serverName);
  if (!upstreamUrl) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown server: ${serverName}` }));
    return;
  }

  // Read request body
  const body = await readBody(req);
  let parsed: {
    jsonrpc?: string;
    id?: number | string;
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  // For non-tools/call methods, forward unconditionally
  if (parsed.method !== 'tools/call') {
    await forwardToUpstream(upstreamUrl, body, res);
    return;
  }

  // tools/call requires group header
  const groupFolder = req.headers['x-nanoclaw-group'] as string | undefined;
  if (!groupFolder) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing X-NanoClaw-Group header' }));
    return;
  }

  // Resolve policy tier
  const assignments = config.assignments.get(serverName);
  if (!assignments) {
    sendMcpError(res, parsed.id, 'No policy assignments for this server');
    return;
  }

  const policy = resolveTier(
    config.policies,
    serverName,
    groupFolder,
    assignments,
  );
  if (!policy) {
    sendMcpError(
      res,
      parsed.id,
      `No policy tier found for group '${groupFolder}'`,
    );
    return;
  }

  // Evaluate policy
  const toolName = parsed.params?.name || '';
  const toolArgs = (parsed.params?.arguments || {}) as Record<string, unknown>;
  const result = evaluatePolicy(policy, toolName, toolArgs);

  if (!result.allowed) {
    logger.info(
      {
        server: serverName,
        group: groupFolder,
        tool: toolName,
        reason: result.reason,
      },
      'MCP tool call denied by policy',
    );
    sendMcpError(res, parsed.id, `Access denied: ${result.reason}`);
    return;
  }

  // Forward allowed request to upstream
  await forwardToUpstream(upstreamUrl, body, res);
}

function sendMcpError(
  res: ServerResponse,
  id: number | string | undefined,
  message: string,
): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32600, message },
    }),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function forwardToUpstream(
  upstreamUrl: string,
  body: string,
  clientRes: ServerResponse,
): Promise<void> {
  const url = new URL(upstreamUrl);

  return new Promise((resolve, reject) => {
    const proxyReq = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (proxyRes) => {
        clientRes.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(clientRes);
        proxyRes.on('end', resolve);
      },
    );

    proxyReq.on('error', (err) => {
      logger.warn(
        { url: upstreamUrl, err: err.message },
        'Upstream MCP server unreachable',
      );
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { 'Content-Type': 'application/json' });
        clientRes.end(JSON.stringify({ error: 'Bad Gateway' }));
      }
      resolve();
    });

    proxyReq.write(body);
    proxyReq.end();
  });
}
