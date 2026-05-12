/**
 * Pure helpers for ollama-mcp-stdio.ts.
 *
 * Extracted so they can be unit-tested without booting the MCP
 * stdio server (the entry-point file `await`s on
 * `server.connect(transport)` at top level, so importing it
 * always tries to attach a transport).
 *
 * Anything in here must be free of fs/network/process-stdio side
 * effects. Time-dependent helpers (`generateSessionId`,
 * `checkSessionLimits`) are pure with respect to their inputs;
 * they read `Date.now()` only when the caller does not pass an
 * explicit `now`.
 */
import type { Message, Tool } from 'ollama';

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  tools: string[];
  env?: Record<string, string>;
  skill?: string;
  toolSchemas?: ToolSchema[];
}

export interface MappedToolCall {
  mcpTool: string;
  arguments: Record<string, unknown>;
}

export interface SessionLimitsState {
  iterations: number;
  maxIterations: number;
  startTime: number;
}

/** Normalize Ollama tool-call arguments — some models hand back a JSON string. */
export function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** Generate a per-session id. Suffix randomness keeps ids unique even if
 *  two requests land in the same millisecond. */
export function generateSessionId(): string {
  return `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Rewrite "you have access to X tools" → "Use X tools" so the model
 *  treats it as an instruction rather than a capability question. */
export function cleanUserMessage(msg: string): string {
  return msg.replace(/you have access to (the )?/gi, 'Use ').trim();
}

/** Pull the server name out of `mcp__{server}__{tool}`. Server name is
 *  underscore-free by convention (matches mcp-tool-executor's parser).
 *  Returns null on malformed input. */
export function extractServerNameFromMcpName(toolName: string): string | null {
  const m = toolName.match(/^mcp__([^_]+)__/);
  return m ? m[1] : null;
}

/** Map raw Ollama tool_calls to the MCP-prefixed shape Claude expects.
 *  Unknown names pass through unprefixed (the engine will reject — better
 *  than synthesising a wrong prefix here). */
export function mapToolCallsToMcp(
  rawCalls: Array<{ function: { name: string; arguments: unknown } }>,
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>,
): MappedToolCall[] {
  return rawCalls.map((tc) => {
    const ollamaName = tc.function.name;
    const mapping = toolNameMap.get(ollamaName);
    return {
      mcpTool: mapping?.mcpTool ?? ollamaName,
      arguments: normalizeArgs(tc.function.arguments),
    };
  });
}

/** Build the JSON envelope returned to Claude when Ollama wants tools
 *  executed. Pretty-printed (2-space) so logs are readable. */
export function serializeToolCallsNeeded(
  sessionId: string,
  toolCalls: MappedToolCall[],
  instructions: string,
): string {
  return JSON.stringify(
    {
      status: 'tool_calls_needed',
      sessionId,
      toolCalls,
      instructions,
    },
    null,
    2,
  );
}

/** Find the most recent assistant message with non-empty content,
 *  falling back to a caller-supplied default. Used when a session
 *  terminates due to iteration/timeout limits and we want to return
 *  whatever Ollama last produced. */
export function pickLastAssistantContent(
  messages: Array<Pick<Message, 'role' | 'content'>>,
  fallback: string,
): string {
  return (
    messages
      .filter((m) => m.role === 'assistant' && m.content)
      .pop()?.content || fallback
  );
}

/** Parse a container.json `mcpServers` block into tool registrations.
 *  Mirrors v1's loadToolSchemas() but pure: no fs, no skill loading
 *  (callers handle skills separately).
 *
 *  Skips entries with no `toolSchemas` (or empty toolSchemas) — these
 *  are SDK-managed servers without pre-resolved schemas.
 */
export function parseToolConfig(configEntries: Record<string, McpServerEntry>): {
  tools: Tool[];
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>;
} {
  const tools: Tool[] = [];
  const toolNameMap = new Map<string, { mcpTool: string; serverName: string }>();

  for (const [name, entry] of Object.entries(configEntries)) {
    if (!entry.toolSchemas || entry.toolSchemas.length === 0) continue;

    for (const schema of entry.toolSchemas) {
      const ollamaToolName = `${name}__${schema.name}`;
      const mcpToolName = `mcp__${name}__${schema.name}`;

      toolNameMap.set(ollamaToolName, { mcpTool: mcpToolName, serverName: name });

      tools.push({
        type: 'function',
        function: {
          name: ollamaToolName,
          description: schema.description ?? '',
          parameters: schema.inputSchema as Tool['function']['parameters'],
        },
      });
    }
  }

  return { tools, toolNameMap };
}

/** Decide whether a session has exhausted its iteration cap or wall-clock
 *  budget. Pure — pass `now` explicitly in tests. */
export function checkSessionLimits(
  session: SessionLimitsState,
  totalTimeoutMs: number,
  now: number = Date.now(),
): { exceeded: false } | { exceeded: true; reason: 'iterations' | 'timeout' } {
  if (session.iterations > session.maxIterations) {
    return { exceeded: true, reason: 'iterations' };
  }
  if (now - session.startTime > totalTimeoutMs) {
    return { exceeded: true, reason: 'timeout' };
  }
  return { exceeded: false };
}
