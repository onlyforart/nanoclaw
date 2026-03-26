/**
 * MCP Server Config Builder for Claude SDK Mode
 *
 * Converts the container-side MCP server config into the format expected by
 * the Claude Agent SDK's `mcpServers` option. HTTP entries are rewritten to
 * stdio entries that spawn the mcp-http-bridge process, ensuring the same
 * StreamableHTTPClientTransport is used as in Ollama direct mode.
 */

interface McpConfigEntry {
  type?: 'http';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  tools?: string[];
  env?: Record<string, string>;
}

type StdioServerEntry = { command: string; args: string[]; env?: Record<string, string> };

interface BuildResult {
  mcpServers: Record<string, StdioServerEntry>;
  mcpTools: string[];
}

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

/**
 * Build SDK-compatible mcpServers config from container-side config.
 *
 * - Stdio entries pass through unchanged.
 * - HTTP entries are rewritten to spawn mcp-http-bridge.js as a stdio child process.
 * - Tool allowlists are built identically regardless of transport type.
 */
export function buildSdkMcpServers(
  mcpConfig: Record<string, McpConfigEntry>,
  bridgePath: string,
): BuildResult {
  const mcpServers: Record<string, StdioServerEntry> = {};
  const mcpTools: string[] = [];

  for (const [name, server] of Object.entries(mcpConfig)) {
    if (server.type === 'http' && server.url) {
      // Remote MCP server — rewrite to stdio bridge
      const args = [bridgePath, '--url', server.url];
      if (server.headers) {
        for (const [k, v] of Object.entries(server.headers)) {
          args.push('--header', `${k}:${v}`);
        }
      }
      mcpServers[name] = { command: 'node', args };
    } else if (server.command) {
      // Stdio MCP server — pass through
      mcpServers[name] = {
        command: server.command,
        args: server.args || [],
        ...(server.env && { env: server.env }),
      };
    } else {
      log(`Skipping MCP server ${name}: no command or url`);
      continue;
    }

    for (const tool of server.tools || []) {
      mcpTools.push(`mcp__${name}__${tool}`);
    }
    log(`Loaded external MCP server: ${name} (${server.tools?.length || 0} tools, type: ${server.type || 'stdio'})`);
  }

  return { mcpServers, mcpTools };
}
