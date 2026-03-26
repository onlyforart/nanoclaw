/**
 * Tests for MCP authorization proxy (Step 11).
 *
 * Tests derived from the specification (docs/REMOTE-MCP-SERVERS.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import {
  startMcpAuthProxy,
  type McpAuthProxyConfig,
} from './mcp-auth-proxy.js';
import { loadPolicies, type PolicySet, type PolicyAssignments } from './mcp-policy.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Helper to make HTTP requests to the proxy
function proxyRequest(
  port: number,
  serverName: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/${serverName}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(responseBody),
            });
          } catch {
            resolve({ status: res.statusCode!, body: responseBody });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Mock upstream MCP server
function createMockUpstream(): {
  server: http.Server;
  port: number;
  requests: Array<{ method: string; body: unknown }>;
  start: () => Promise<number>;
  stop: () => Promise<void>;
} {
  const requests: Array<{ method: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ method: parsed.method, body: parsed });
      // Return a valid MCP response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: {
            content: [{ type: 'text', text: 'mock response' }],
          },
        }),
      );
    });
  });

  return {
    server,
    port: 0,
    requests,
    start: () =>
      new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address() as { port: number };
          resolve(addr.port);
        });
      }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('MCP Authorization Proxy', () => {
  let proxy: http.Server | null = null;
  let proxyPort: number;
  let mockUpstream: ReturnType<typeof createMockUpstream>;
  let upstreamPort: number;
  let tmpDir: string;

  async function setupProxy(
    overrides: Partial<McpAuthProxyConfig> = {},
  ): Promise<void> {
    mockUpstream = createMockUpstream();
    upstreamPort = await mockUpstream.start();

    // Create policy files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-proxy-test-'));
    const mongoDir = path.join(tmpDir, 'mongodb');
    fs.mkdirSync(mongoDir, { recursive: true });
    fs.writeFileSync(
      path.join(mongoDir, 'readonly.yaml'),
      `tools:\n  allow:\n    - find\n    - aggregate\n    - count\n`,
    );
    fs.writeFileSync(
      path.join(mongoDir, 'admin.yaml'),
      `tools:\n  allow: ["*"]\n`,
    );

    const policies = loadPolicies(tmpDir);

    const assignments = new Map<string, PolicyAssignments>();
    assignments.set('mongodb', {
      defaultTier: 'readonly',
      groups: { main: 'admin' },
    });

    const config: McpAuthProxyConfig = {
      upstreams: new Map([
        ['mongodb', `http://127.0.0.1:${upstreamPort}`],
      ]),
      policies,
      assignments,
      ...overrides,
    };

    const result = await startMcpAuthProxy(0, '127.0.0.1', config);
    proxy = result.server;
    proxyPort = result.port;
  }

  afterEach(async () => {
    if (proxy) {
      await new Promise<void>((resolve) => proxy!.close(() => resolve()));
      proxy = null;
    }
    if (mockUpstream) {
      await mockUpstream.stop();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('forwards allowed tools/call to upstream', async () => {
    await setupProxy();

    const { status, body } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find', arguments: { collection: 'users' } },
      },
      { 'X-NanoClaw-Group': 'slack_ops' }, // gets 'readonly' default tier
    );

    expect(status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
    expect(mockUpstream.requests[0].method).toBe('tools/call');
  });

  it('blocks denied tools/call with MCP error', async () => {
    await setupProxy();

    const { status, body } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delete-many', arguments: {} },
      },
      { 'X-NanoClaw-Group': 'slack_ops' }, // readonly tier
    );

    expect(status).toBe(200); // MCP errors are still 200 HTTP with error body
    const b = body as { error?: { code: number; message: string } };
    expect(b.error).toBeDefined();
    expect(b.error!.code).toBe(-32600);
    expect(mockUpstream.requests).toHaveLength(0); // NOT forwarded
  });

  it('forwards initialize unconditionally', async () => {
    await setupProxy();

    const { status } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      },
      { 'X-NanoClaw-Group': 'slack_ops' },
    );

    expect(status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
  });

  it('forwards tools/list unconditionally', async () => {
    await setupProxy();

    const { status } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      },
      { 'X-NanoClaw-Group': 'slack_ops' },
    );

    expect(status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
  });

  it('returns 400 for missing group header', async () => {
    await setupProxy();

    const { status } = await proxyRequest(proxyPort, 'mongodb', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'find', arguments: {} },
    });

    expect(status).toBe(400);
  });

  it('returns 404 for unknown server', async () => {
    await setupProxy();

    const { status } = await proxyRequest(
      proxyPort,
      'unknown-server',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find', arguments: {} },
      },
      { 'X-NanoClaw-Group': 'main' },
    );

    expect(status).toBe(404);
  });

  it('denies when no tier matches for group (fail-closed)', async () => {
    // Setup with no default tier and group not in assignments
    const assignments = new Map<string, PolicyAssignments>();
    assignments.set('mongodb', {
      groups: { main: 'admin' }, // no defaultTier
    });

    await setupProxy({ assignments });

    const { status, body } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'find', arguments: {} },
      },
      { 'X-NanoClaw-Group': 'unknown_group' },
    );

    expect(status).toBe(200);
    const b = body as { error?: { code: number } };
    expect(b.error).toBeDefined();
    expect(mockUpstream.requests).toHaveLength(0);
  });

  it('admin tier allows all tools', async () => {
    await setupProxy();

    const { status } = await proxyRequest(
      proxyPort,
      'mongodb',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'drop-database', arguments: {} },
      },
      { 'X-NanoClaw-Group': 'main' }, // admin tier
    );

    expect(status).toBe(200);
    expect(mockUpstream.requests).toHaveLength(1);
  });
});
