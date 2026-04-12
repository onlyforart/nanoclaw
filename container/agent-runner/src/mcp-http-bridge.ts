/**
 * MCP Stdio-to-HTTP Bridge
 *
 * Standalone process that proxies MCP JSON-RPC between stdio (for the
 * Claude Agent SDK) and an HTTP MCP server (via StreamableHTTPClientTransport).
 *
 * This exists because the Claude SDK's native HTTP MCP transport silently hangs
 * (see https://github.com/anthropics/claude-agent-sdk-typescript/issues/183).
 * The Ollama direct mode path uses StreamableHTTPClientTransport in-process and
 * works correctly — this bridge wraps the same transport as a stdio process so
 * both paths use identical MCP communication.
 *
 * Usage:
 *   node mcp-http-bridge.js --url http://host:3201/mcp [--header Name:Value]
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

function log(msg: string): void {
  console.error(`[mcp-http-bridge] ${msg}`);
}

export interface BridgeArgs {
  url: string;
  headers: Record<string, string>;
}

/**
 * Parse command-line arguments.
 * Accepts --url <url> and --header <name>:<value> (repeatable).
 */
export function parseArgs(argv: string[]): BridgeArgs {
  let url: string | undefined;
  const headers: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && i + 1 < argv.length) {
      url = argv[++i];
    } else if (argv[i] === '--header' && i + 1 < argv.length) {
      const val = argv[++i];
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        headers[val.slice(0, colonIdx)] = val.slice(colonIdx + 1);
      }
    }
  }

  if (!url) {
    throw new Error('--url is required');
  }

  return { url, headers };
}

/**
 * Create the bridge: connect an MCP client to the remote HTTP server,
 * then expose a stdio MCP server that transparently proxies tools/list
 * and tools/call to the remote server.
 */
export async function createBridge(
  url: string,
  headers: Record<string, string>,
): Promise<{ client: Client; server: Server }> {
  // Connect to the remote HTTP server as a client
  const httpTransport = new StreamableHTTPClientTransport(
    new URL(url),
    { requestInit: { headers } },
  );

  const client = new Client({
    name: 'nanoclaw-mcp-http-bridge',
    version: '1.0.0',
  });

  await client.connect(httpTransport);
  log(`Connected to ${url}`);

  // Create a low-level MCP server on stdio that proxies requests
  const server = new Server(
    { name: 'mcp-http-bridge', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // Proxy tools/list — forward to remote server
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await client.listTools();
    return { tools: result.tools };
  });

  // Proxy tools/call — forward to remote server with raw arguments
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    log(`Proxying tools/call: ${name}`);
    try {
      const result = await client.callTool({ name, arguments: args });
      return { content: result.content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Tool ${name} error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  // Connect the server to stdio
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  log(`Stdio server ready`);

  return { client, server };
}

// Main entry point — only runs when executed directly (not imported by tests)
const isMain = process.argv[1]?.endsWith('mcp-http-bridge.js') ||
               process.argv[1]?.endsWith('mcp-http-bridge.ts');

if (isMain) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      await createBridge(args.url, args.headers);
    } catch (err) {
      log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  })();
}
