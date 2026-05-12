export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };

  /**
   * Per-query model override. When set, overrides whatever default the
   * provider was constructed with. Used by the per-message engine routing
   * path (engine-selector → message.model column on messages_in) so a
   * scheduled task can pick a specific model on a container that otherwise
   * runs a different default. Providers without a notion of "model" (the
   * Claude SDK provider — model is the SDK's concern) ignore it.
   */
  model?: string;

  /**
   * True when the primary triggering message is a scheduled task.
   * Routing input only — providers themselves don't behave differently
   * based on this; the RoutingProvider passes it to engine-selector to
   * resolve the (isScheduledTask && !useAgentSdk) → anthropic-api rule.
   */
  isScheduledTask?: boolean;

  /**
   * Per-message SDK override for scheduled tasks. When 1/true, route
   * through the Agent SDK even for a scheduled task; when 0/false/null,
   * route scheduled tasks through anthropic-api (the production default
   * — the SDK preset is too heavy for utility tasks). Routing input only.
   */
  useAgentSdk?: boolean;
}

// Provider-side MCP server config tracks the Anthropic Agent SDK's transport
// shape (stdio | http) directly. The transform from the operator-facing
// container.json union to this shape lives in `mcp-server-transform.ts`.
import type { SdkMcpServerConfig } from '../mcp-server-transform.js';
export type McpServerConfig = SdkMcpServerConfig;

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' };
