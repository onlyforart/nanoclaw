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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { StdioMcpServerEntry } from './remote-mcp.js';

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

function resolveStdioServer(serverName: string): StdioMcpServerEntry {
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
  return entry as unknown as StdioMcpServerEntry;
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
  const entry = resolveStdioServer(params.server);
  if (!toolIsAllowed(entry, params.name)) {
    throw new McpInvokerError(
      `Tool "${params.name}" is not listed for server "${params.server}"`,
      'tool-not-allowed',
    );
  }

  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    cwd: entry.hostPath,
  });

  const client = new Client(
    { name: 'nanoclaw-host-invoker', version: '0.1.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await Promise.race([
      client.callTool({ name: params.name, arguments: params.args ?? {} }),
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
