#!/usr/bin/env node
/**
 * Stub MCP server for K.1.f step 8.5 pipeline dry-run.
 *
 * Returns deterministic JSON for a single tool `check_status` so the
 * pipeline's trivial-answerer can complete its full obs → reply →
 * channel.deliver flow without depending on a live MCP server.
 *
 * The pipeline's `host-mcp-invoker` resolves servers from
 * `data/mcp-servers.json`, spawns this script as a stdio subprocess,
 * sends MCP-protocol RPCs over stdin/stdout, then terminates. Each
 * call is a fresh process — same lifecycle as the production MCP
 * tooling.
 *
 * The response shape is `{ content: [{ type: 'text', text: '<json>' }] }`
 * matching `parseToolResult`'s contract in `host-mcp-invoker.ts`. The
 * inner JSON is what the trivial-answerer's healthy_when rule reads.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'test-mcp-stub', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'check_status',
      description: 'Returns canned status JSON. K.1.f step 8.5 dry-run only.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'Target name (echoed back)' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'check_status') {
    throw new Error(`Unknown tool: ${req.params.name}`);
  }
  const target = req.params.arguments?.target ?? 'TEST';
  const payload = { healthy: true, label: target, status: 'ok' };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
});

await server.connect(new StdioServerTransport());
