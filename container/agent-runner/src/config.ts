/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

const CONFIG_PATH = '/workspace/agent/container.json';

/** Tools field on a remote MCP server: flat array (legacy) or access-level object. */
export type ToolsDef = string[] | Record<string, string[]>;

/** Stdio MCP server entry (existing pattern). */
export interface StdioMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  instructions?: string;
}

/**
 * Remote (HTTP) MCP server entry. Host pre-resolves `toolSchemas` at
 * container spawn — agent-runner does not hit the upstream itself for
 * schema discovery. Field set is kept verbatim with v1's
 * `RemoteMcpServerEntry`; `proxy`/`policies` are dormant until the
 * `mcp-auth-proxy` startup is wired.
 */
export interface RemoteMcpServerConfig {
  url: string;
  tools: ToolsDef;
  readOnly?: boolean;
  proxy?: boolean;
  policies?: { default?: string; groups?: Record<string, string> };
  headers?: Record<string, string>;
  skill?: string;
  instructions?: string;
  toolSchemas?: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

/** Discriminate by presence of `url`. */
export type McpServerEntry = StdioMcpServerConfig | RemoteMcpServerConfig;

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerEntry>;
}

const DEFAULT_MAX_MESSAGES = 10;

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
  };

  return _config;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
