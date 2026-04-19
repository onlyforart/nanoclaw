// Host-side MCP tool invoker. Spawns an MCP server subprocess from
// data/mcp-servers.json, calls a named tool, returns the parsed JSON
// response. Each call spawns + terminates a subprocess (no pool) —
// adds ~200 ms per call but keeps the contract simple. Pool later if
// volume demands it.
//
// Scope: stdio servers only. Remote (HTTP) servers are not supported
// by this invoker — deliberate, since the deterministic auto-answer
// callers only target purpose-built local stdio MCP servers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { StdioMcpServerEntry } from './remote-mcp.js';

// Shared env-var allow-list — see container/agent-runner/src/mcp-safe-env.json
// for the docstring. Loaded at module init from the container tree
// because that's the canonical location (container builds include it
// as part of the agent-runner-src staging). Both host and container
// agree on exactly the same list.
const MCP_SAFE_ENV_KEYS: string[] = (() => {
  // __dirname at runtime is nanoclaw/dist/. The container source
  // file is two levels up, then into container/agent-runner/src.
  // At dev time (tests) the module resolves via tsx and __dirname
  // is nanoclaw/src/ — same relative path works.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(
      here,
      '..',
      'container',
      'agent-runner',
      'src',
      'mcp-safe-env.json',
    ),
    path.join(
      here,
      '..',
      '..',
      'container',
      'agent-runner',
      'src',
      'mcp-safe-env.json',
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
        safe_keys: string[];
      };
      return data.safe_keys;
    }
  }
  logger.error(
    { candidates },
    'mcp-safe-env.json not found — falling back to a narrow default; playwright-using MCP servers may fail to locate browsers',
  );
  return ['PATH', 'HOME', 'NODE_ENV'];
})();

export interface InvokeMcpToolArgs {
  server: string;
  name: string;
  args?: Record<string, unknown>;
}

export class McpInvokerError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'server-not-found'
      | 'server-not-stdio'
      | 'tool-not-allowed'
      | 'tool-error'
      | 'malformed-response'
      | 'transport-error',
  ) {
    super(message);
    this.name = 'McpInvokerError';
  }
}

interface McpServersFile {
  servers: Record<string, Record<string, unknown>>;
}

function loadMcpServersFile(): McpServersFile {
  const configPath = path.join(DATA_DIR, 'mcp-servers.json');
  if (!fs.existsSync(configPath)) {
    return { servers: {} };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return { servers: parsed.servers ?? {} };
  } catch (err) {
    logger.error({ configPath, err }, 'Failed to load mcp-servers.json');
    return { servers: {} };
  }
}

interface HostStdioEntry {
  entry: StdioMcpServerEntry;
  hostEnv: Record<string, string> | undefined;
}

function resolveStdioServer(serverName: string): HostStdioEntry {
  const { servers } = loadMcpServersFile();
  const entry = servers[serverName];
  if (!entry) {
    throw new McpInvokerError(
      `MCP server "${serverName}" not found in mcp-servers.json`,
      'server-not-found',
    );
  }
  if ('url' in entry) {
    throw new McpInvokerError(
      `MCP server "${serverName}" is remote (url-based); stdio invoker does not support it`,
      'server-not-stdio',
    );
  }
  if (typeof entry.hostPath !== 'string' || typeof entry.command !== 'string') {
    throw new McpInvokerError(
      `MCP server "${serverName}" entry is missing hostPath or command`,
      'server-not-stdio',
    );
  }
  // Optional `hostEnv` field (not part of the container-runner schema)
  // lets local invocations inject env vars the MCP server needs but
  // that aren't exported to the parent nanoclaw process. Values are
  // passed through verbatim; operator is responsible for keeping the
  // mcp-servers.json file correct.
  let hostEnv: Record<string, string> | undefined;
  const raw = (entry as Record<string, unknown>).hostEnv;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const accum: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') accum[k] = v;
    }
    if (Object.keys(accum).length > 0) hostEnv = accum;
  }
  return { entry: entry as unknown as StdioMcpServerEntry, hostEnv };
}

export function toolIsAllowed(
  entry: Pick<StdioMcpServerEntry, 'tools'>,
  toolName: string,
): boolean {
  const tools = entry.tools;
  if (Array.isArray(tools)) return tools.includes(toolName);
  return Object.values(tools).some((list) => list.includes(toolName));
}

/**
 * Extract the first text content part from a tools/call result and
 * parse it as JSON. MCP tools in this codebase return
 * `{ content: [{ type: 'text', text: '...' }] }` with a JSON payload
 * inside the text. If the content is not JSON (or not present), throw.
 */
export function parseToolResult(result: unknown): unknown {
  const r = result as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  if (r?.isError) {
    const text = r.content?.[0]?.text ?? '(no text)';
    throw new McpInvokerError(
      `MCP tool returned isError=true: ${text.slice(0, 500)}`,
      'tool-error',
    );
  }
  const first = r?.content?.[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new McpInvokerError(
      'MCP tool response missing text content part',
      'malformed-response',
    );
  }
  try {
    return JSON.parse(first.text);
  } catch {
    throw new McpInvokerError(
      `MCP tool text content was not valid JSON: ${first.text.slice(0, 200)}`,
      'malformed-response',
    );
  }
}

/**
 * Spawn the MCP server subprocess, call the tool, parse the JSON
 * response, terminate. Designed for use from host_pipeline tasks
 * where the caller has no long-lived MCP client.
 */
// Ceiling is driven by the slowest tool a trivial-answer shape is
// allowed to call. Browser-driven checks (pagepilot-style stored
// scripts) routinely take 60–90 s on a live page. Fast health-probe
// MCP tools return in under 5 s and aren't affected by the raised
// ceiling.
export async function invokeMcpTool(
  params: InvokeMcpToolArgs,
  timeoutMs = 120_000,
): Promise<unknown> {
  const { entry, hostEnv } = resolveStdioServer(params.server);
  if (!toolIsAllowed(entry, params.name)) {
    throw new McpInvokerError(
      `Tool "${params.name}" is not listed for server "${params.server}"`,
      'tool-not-allowed',
    );
  }

  // Build env from the shared MCP_SAFE_ENV_KEYS allow-list plus
  // any per-server hostEnv overrides from mcp-servers.json.
  // getDefaultEnvironment() remains the lowest layer so irrelevant
  // but non-sensitive vars the SDK exposes still pass through.
  const safeFromProcess: Record<string, string> = {};
  for (const key of MCP_SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) safeFromProcess[key] = v;
  }
  const envPayload: Record<string, string> = {
    ...getDefaultEnvironment(),
    ...safeFromProcess,
    ...(hostEnv ?? {}),
  };

  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: entry.hostPath,
    env: envPayload,
  });

  const client = new Client(
    { name: 'nanoclaw-host-invoker', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    // SDK's own request timeout defaults to 60s, which aborts any
    // tool that takes longer (pagepilot widget runs routinely take
    // 60–90s). Pass it explicitly, matching the outer timeoutMs plus
    // a small buffer so the outer Promise.race fires first with a
    // clearer error message.
    const result = await Promise.race([
      client.callTool(
        { name: params.name, arguments: params.args ?? {} },
        undefined,
        { timeout: timeoutMs + 5_000 },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new McpInvokerError(
                `MCP tool call timed out after ${timeoutMs} ms`,
                'transport-error',
              ),
            ),
          timeoutMs,
        ),
      ),
    ]);
    return parseToolResult(result);
  } catch (err) {
    if (err instanceof McpInvokerError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new McpInvokerError(
      `MCP transport error: ${message}`,
      'transport-error',
    );
  } finally {
    try {
      await client.close();
    } catch {
      /* swallow — caller already has the tool result or a thrown error */
    }
  }
}
