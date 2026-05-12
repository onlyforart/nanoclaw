/**
 * Transform a runtime MCP server entry (operator-facing union) into the
 * Anthropic Agent SDK's MCP server shape (transport-facing union).
 *
 * Keeps fork-specific fields (`tools`/`readOnly`/`proxy`/`policies`/`skill`/
 * `instructions`/`toolSchemas`) out of the SDK view — those are consumed
 * elsewhere (CLAUDE.md composition, host-side proxy/policy code), not by
 * the SDK transport.
 */
import type { McpHttpServerConfig, McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { McpServerEntry } from './config.js';

export type SdkMcpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export function toSdkMcpServer(entry: McpServerEntry): SdkMcpServerConfig {
  if ('url' in entry) {
    const out: McpHttpServerConfig = { type: 'http', url: entry.url };
    if (entry.headers !== undefined) out.headers = entry.headers;
    return out;
  }
  return {
    type: 'stdio',
    command: entry.command,
    args: entry.args,
    env: entry.env,
  };
}
