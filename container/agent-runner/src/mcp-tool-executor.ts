/**
 * MCP Tool Executor
 *
 * Lightweight MCP client that spawns MCP server processes and calls tools
 * via JSON-RPC over stdio. Used in Ollama direct mode where the Claude SDK
 * (which normally manages MCP connections) is not running.
 *
 * Each MCP server process is started once and reused for all tool calls.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from 'ollama';

export interface McpServerConfig {
  command: string;
  args: string[];
  tools: string[];
  env?: Record<string, string>;
  toolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}

interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport;
  tools: string[];
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

  /**
   * Initialize MCP server connections.
   * Spawns each configured server process and discovers its tools.
   */
  async initialize(
    mcpConfig: Record<string, McpServerConfig>,
    extraEnv?: Record<string, string>,
  ): Promise<void> {
    for (const [name, config] of Object.entries(mcpConfig)) {
      try {
        const env: Record<string, string> = {
          ...process.env as Record<string, string>,
          ...(config.env || {}),
          ...(extraEnv || {}),
        };

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env,
        });

        const client = new Client({
          name: `nanoclaw-ollama-${name}`,
          version: '1.0.0',
        });

        await client.connect(transport);

        this.servers.set(name, { client, transport, tools: config.tools });

        // Register tool mappings
        for (const toolName of config.tools) {
          const mcpToolName = `mcp__${name}__${toolName}`;
          this.toolToServer.set(mcpToolName, name);
        }

        // Build Ollama tool schemas from pre-discovered schemas
        if (config.toolSchemas) {
          for (const schema of config.toolSchemas) {
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
          }
        }

        log(`Connected to MCP server: ${name} (${config.tools.length} tools)`);
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
