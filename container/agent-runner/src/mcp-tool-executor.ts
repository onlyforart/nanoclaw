/**
 * MCP Tool Executor
 *
 * Lightweight MCP client that spawns MCP server processes and calls tools
 * via JSON-RPC over stdio. Used in Ollama direct mode where the Claude SDK
 * (which normally manages MCP connections) is not running.
 *
 * Each MCP server process is started once and reused for all tool calls.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// MCP_SAFE_ENV_KEYS is shared with the host-side host-mcp-invoker.ts
// via a JSON file so the two invoker paths see identical envs.
// Loaded once at module init.
const MCP_SAFE_ENV_KEYS: string[] = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const data = JSON.parse(
    readFileSync(join(here, 'mcp-safe-env.json'), 'utf-8'),
  ) as { safe_keys: string[] };
  return data.safe_keys;
})();

function buildSafeMcpEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_SAFE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (overrides) Object.assign(env, overrides);
  return env;
}
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from 'ollama';
import type { AnthropicTool } from './anthropic-api-engine.js';

export interface McpServerConfig {
  // Stdio (existing)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP (new — remote MCP servers)
  type?: 'http';
  url?: string;
  headers?: Record<string, string>;
  // Common
  tools: string[];
  toolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}

interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: string[];
  transportType: 'stdio' | 'http';
}

function log(msg: string): void {
  console.error(`[mcp-executor] ${msg}`);
}

export class McpToolExecutor {
  private servers = new Map<string, ConnectedServer>();
  /** Maps MCP tool name (mcp__{server}__{tool}) -> server name */
  private toolToServer = new Map<string, string>();
  /** Maps Ollama tool name ({server}__{tool}) -> { mcpTool, serverName } */
  private ollamaToolMap = new Map<string, { mcpTool: string; serverName: string }>();
  /** Ollama-format tool schemas */
  private ollamaTools: Tool[] = [];
  /** Anthropic API format tool schemas */
  private anthropicTools: AnthropicTool[] = [];
  /** Per-call timeout inherited from task/container timeout */
  private callTimeoutMs: number | undefined;

  /**
   * Initialize MCP server connections.
   * Spawns each configured server process and discovers its tools.
   */
  async initialize(
    mcpConfig: Record<string, McpServerConfig>,
    extraEnv?: Record<string, string>,
    options?: { callTimeoutMs?: number },
  ): Promise<void> {
    this.callTimeoutMs = options?.callTimeoutMs;
    for (const [name, config] of Object.entries(mcpConfig)) {
      try {
        let transport: StdioClientTransport | StreamableHTTPClientTransport;
        let transportType: 'stdio' | 'http';

        if (config.type === 'http' && config.url) {
          // Remote MCP server — connect over HTTP
          transport = new StreamableHTTPClientTransport(
            new URL(config.url),
            {
              requestInit: config.headers
                ? { headers: config.headers }
                : undefined,
            },
          );
          transportType = 'http';
        } else if (config.command) {
          // Stdio MCP server — spawn child process.
          // Safe-env allow-list is shared with host-mcp-invoker.ts
          // via mcp-safe-env.ts so the two invoker paths see the
          // same environment. Per-server `env` entries win over the
          // allow-list defaults.
          const env = buildSafeMcpEnv({ ...(config.env ?? {}), ...(extraEnv ?? {}) });
          transport = new StdioClientTransport({
            command: config.command,
            args: config.args || [],
            env,
          });
          transportType = 'stdio';
        } else {
          log(`Skipping MCP server ${name}: no command or url`);
          continue;
        }

        const client = new Client({
          name: `nanoclaw-ollama-${name}`,
          version: '1.0.0',
        });

        await client.connect(transport);

        this.servers.set(name, {
          client,
          transport,
          tools: config.tools,
          transportType,
        });

        // Register tool mappings
        for (const toolName of config.tools) {
          const mcpToolName = `mcp__${name}__${toolName}`;
          this.toolToServer.set(mcpToolName, name);
        }

        // Build Ollama tool schemas: use pre-discovered schemas if available,
        // otherwise discover dynamically via MCP tools/list
        let schemas = config.toolSchemas;
        if (!schemas || schemas.length === 0) {
          try {
            const listResult = await client.listTools();
            const toolSet = new Set(config.tools);
            schemas = listResult.tools
              .filter((t) => toolSet.has(t.name))
              .map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
              }));
            if (schemas.length > 0) {
              log(`Discovered ${schemas.length} tool schema(s) from ${name}`);
            }
          } catch (err) {
            log(`Failed to discover tools from ${name}: ${err instanceof Error ? err.message : String(err)}`);
            schemas = [];
          }
        }

        for (const schema of schemas) {
          const ollamaToolName = `${name}__${schema.name}`;
          const mcpToolName = `mcp__${name}__${schema.name}`;

          this.ollamaToolMap.set(ollamaToolName, {
            mcpTool: mcpToolName,
            serverName: name,
          });

          this.ollamaTools.push({
            type: 'function',
            function: {
              name: ollamaToolName,
              description: schema.description ?? '',
              parameters: schema.inputSchema as Tool['function']['parameters'],
            },
          });

          this.anthropicTools.push({
            name: ollamaToolName,
            description: schema.description ?? '',
            input_schema: schema.inputSchema as Record<string, unknown>,
          });
        }

        log(`Connected to MCP server: ${name} (${config.tools.length} tools, ${schemas.length} schemas)`);
      } catch (err) {
        log(`Failed to connect to MCP server ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    log(`Initialized ${this.servers.size} MCP server(s), ${this.ollamaTools.length} tool(s)`);
  }

  /**
   * Call a tool by its MCP name (e.g., 'mcp__nanoclaw__send_message').
   */
  async callTool(mcpToolName: string, args: Record<string, unknown>): Promise<string> {
    // Parse server name and tool name from mcp__{server}__{tool}
    const match = mcpToolName.match(/^mcp__([^_]+)__(.+)$/);
    if (!match) {
      throw new Error(`Invalid MCP tool name format: ${mcpToolName}`);
    }

    const [, serverName, toolName] = match;
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

    log(`Calling tool: ${mcpToolName} with args: ${JSON.stringify(args).slice(0, 200)}`);

    const callStart = Date.now();
    const result = await server.client.callTool({
      name: toolName,
      arguments: args,
    }, undefined, {
      timeout: this.callTimeoutMs,
    });
    const callMs = Date.now() - callStart;

    // Extract text content from the MCP result
    const textParts = (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!);

    const output = textParts.join('\n') || '(no output)';
    log(`Tool ${mcpToolName} completed in ${(callMs / 1000).toFixed(1)}s (${output.length} chars)`);
    return output;
  }

  /** Get all tools in Ollama format for passing to ollama.chat(). */
  getOllamaTools(): Tool[] {
    return this.ollamaTools;
  }

  /** Get all tools in Anthropic API format for passing to messages.create(). */
  getAnthropicTools(): AnthropicTool[] {
    return this.anthropicTools;
  }

  /** Get the mapping from Ollama tool names to MCP tool names. */
  getToolNameMap(): Map<string, { mcpTool: string; serverName: string }> {
    return this.ollamaToolMap;
  }

  /** Gracefully shut down all MCP server processes. */
  async close(): Promise<void> {
    for (const [name, server] of this.servers) {
      try {
        await server.client.close();
        log(`Closed MCP server: ${name}`);
      } catch (err) {
        log(`Error closing MCP server ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.servers.clear();
  }
}
