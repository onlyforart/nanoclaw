# Direct Ollama Mode: Implementation Plan

Allow groups and tasks to use Ollama models directly, bypassing the Claude Agent SDK entirely. This eliminates Anthropic API usage for groups/tasks where a local (or network-local) model is sufficient.

## Current State

Today, the `model` field on `RegisteredGroup` and `ScheduledTask` accepts Claude model aliases (`haiku`, `sonnet`, `opus`). The agent runner always calls the Claude Agent SDK's `query()` function. Ollama is available *under* Claude as an MCP tool (`ollama_chat`), but Claude must be invoked first to delegate to it.

The Ollama MCP server (`ollama-mcp-stdio.ts`) already supports multi-turn conversations with full MCP tool calling (up to 10 rounds, 5-minute timeout). It reads tool schemas from the shared MCP config and routes tool execution back through Claude. This existing code is the foundation for direct mode.

## Design

### Model String Convention

Reuse the existing `model` field with a URI-like prefix:

```
ollama:qwen3             # Local Ollama (OLLAMA_HOST from .env)
ollama-remote:mistral    # Remote Ollama (OLLAMA_REMOTE_HOST from .env)
haiku                    # Claude (existing behavior)
sonnet                   # Claude (existing behavior)
```

No database schema changes needed. The `model TEXT` column already stores arbitrary strings.

### Connection Profiles

A new concept: **connection profiles** define per-backend execution parameters. These replace the current hardcoded constants.

```typescript
// src/connection-profiles.ts (new file)

interface ConnectionProfile {
  backend: 'claude' | 'ollama';
  ollamaHost?: string;        // Only for ollama backend
  ollamaModel?: string;       // Only for ollama backend (extracted from model string)
  maxToolRounds: number;       // Claude default: unlimited (SDK handles it), Ollama default: 10
  timeoutMs: number;           // Claude default: 1800000 (30min), Ollama default: 300000 (5min)
  containerTimeoutMs: number;  // Hard container kill timeout
  idleTimeoutMs: number;       // Time to keep container alive after last output
}
```

**Resolution order** (most specific wins):
1. Per-task overrides (from `ScheduledTask` fields)
2. Per-group overrides (from `RegisteredGroup` fields)
3. Backend defaults (Claude vs Ollama have different defaults)
4. Global defaults (from environment / config.ts)

### Per-Connection Limits

Currently `CONTAINER_TIMEOUT`, `IDLE_TIMEOUT`, `DEFAULT_MAX_ITERATIONS`, and `TOTAL_TIMEOUT_MS` are global constants. These need to become configurable per group/task.

**Database changes** (new columns via migration):

```sql
-- registered_groups
ALTER TABLE registered_groups ADD COLUMN max_tool_rounds INTEGER DEFAULT NULL;
ALTER TABLE registered_groups ADD COLUMN timeout_ms INTEGER DEFAULT NULL;

-- scheduled_tasks
ALTER TABLE scheduled_tasks ADD COLUMN max_tool_rounds INTEGER DEFAULT NULL;
ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms INTEGER DEFAULT NULL;
```

NULL means "use backend default". This keeps existing groups/tasks working unchanged.

**ContainerInput changes:**

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  // New fields
  maxToolRounds?: number;
  timeoutMs?: number;
}
```

## Implementation Phases

### Phase 1: Connection Profiles and Configurable Limits

**Goal:** Make execution parameters configurable per group/task, independent of Ollama work.

#### 1a. Create `src/connection-profiles.ts`

New module that parses a model string and returns a `ConnectionProfile`:

```typescript
export function resolveProfile(
  model: string | undefined,
  overrides?: { maxToolRounds?: number; timeoutMs?: number },
): ConnectionProfile {
  if (model?.startsWith('ollama:') || model?.startsWith('ollama-remote:')) {
    const [prefix, ollamaModel] = model.split(':', 2);
    const host = prefix === 'ollama-remote'
      ? readEnvFile(['OLLAMA_REMOTE_HOST']).OLLAMA_REMOTE_HOST || 'http://localhost:11434'
      : readEnvFile(['OLLAMA_HOST']).OLLAMA_HOST || 'http://host.docker.internal:11434';

    return {
      backend: 'ollama',
      ollamaHost: host,
      ollamaModel,
      maxToolRounds: overrides?.maxToolRounds ?? 10,
      timeoutMs: overrides?.timeoutMs ?? 300_000,      // 5 min
      containerTimeoutMs: overrides?.timeoutMs ?? 360_000,  // 6 min (timeout + grace)
      idleTimeoutMs: 30_000,  // 30s idle for Ollama (no persistent session)
    };
  }

  return {
    backend: 'claude',
    maxToolRounds: overrides?.maxToolRounds ?? 0,  // 0 = unlimited (SDK manages)
    timeoutMs: overrides?.timeoutMs ?? 1_800_000,  // 30 min
    containerTimeoutMs: overrides?.timeoutMs ?? CONTAINER_TIMEOUT,
    idleTimeoutMs: IDLE_TIMEOUT,
  };
}
```

#### 1b. Database migration

Add `max_tool_rounds` and `timeout_ms` columns to `registered_groups` and `scheduled_tasks`.

#### 1c. Update `ContainerInput` and pass-through

- `src/container-runner.ts`: Accept and pass `maxToolRounds` and `timeoutMs` in `ContainerInput`. Use `profile.containerTimeoutMs` and `profile.idleTimeoutMs` for the container-level timeouts (replacing the current global `CONTAINER_TIMEOUT` / `IDLE_TIMEOUT` usage).
- `src/index.ts` (`runAgent`): Call `resolveProfile(group.model, { maxToolRounds: group.maxToolRounds, timeoutMs: group.timeoutMs })`, pass profile values into `ContainerInput`.
- `src/task-scheduler.ts` (`runTask`): Same, using task-level overrides.

#### 1d. Update IPC

- `src/ipc.ts`: Accept `maxToolRounds` and `timeoutMs` in `register_group`, `update_group`, `schedule_task`, and `update_task` handlers.
- `container/agent-runner/src/ipc-mcp-stdio.ts`: Expose these fields in the MCP tool schemas so agents can set them.

#### 1e. Update types

- `src/types.ts`: Add `maxToolRounds?: number` and `timeoutMs?: number` to `RegisteredGroup` and `ScheduledTask`.

**Files changed:** `src/connection-profiles.ts` (new), `src/types.ts`, `src/db.ts`, `src/config.ts`, `src/container-runner.ts`, `src/index.ts`, `src/task-scheduler.ts`, `src/ipc.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`

### Phase 2: Ollama Direct Runner

**Goal:** Add an alternate code path in the agent runner that drives Ollama directly instead of the Claude SDK.

#### Why not share MCP server processes with the Claude SDK?

Today, when Ollama runs *under* Claude (as an MCP tool), it avoids spawning its own MCP server processes. Instead, it returns tool-call requests back to Claude, and Claude executes them through MCP servers that the SDK already started. This is efficient because both Ollama and Claude share the same running server processes.

In Ollama direct mode, Claude isn't running at all — so there are no existing MCP servers to share. The SDK doesn't expose its MCP connections; it spawns and owns them internally. There's no API to reach into a `query()` session and borrow its MCP handles.

This means the `McpToolExecutor` (below) must spawn its own MCP server processes. But this is **not duplication** — each container invocation runs exactly one backend (Claude *or* Ollama, never both). Whichever backend runs is responsible for starting the MCP servers it needs. The total number of MCP server processes per container is the same either way.

These servers are lightweight Node.js scripts that start in milliseconds and use minimal memory, so the overhead is negligible.

#### 2a. Extract reusable Ollama chat logic

Refactor `ollama-mcp-stdio.ts` to extract the core chat loop into a shared module:

```typescript
// container/agent-runner/src/ollama-chat-engine.ts (new file)

export interface OllamaChatOptions {
  host: string;
  model: string;
  systemPrompt?: string;
  maxIterations: number;
  timeoutMs: number;
  tools: Tool[];           // Ollama tool format
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>;
  executeTool: (mcpToolName: string, args: Record<string, unknown>) => Promise<string>;
}

export async function runOllamaChat(
  messages: Message[],
  options: OllamaChatOptions,
): Promise<{ response: string; iterations: number }> {
  // Core loop: send to Ollama, handle tool calls, repeat
  // Extracted from ollama-mcp-stdio.ts session logic
}
```

The key difference from the MCP-tool version: instead of returning tool calls to Claude for execution, this engine executes them directly by spawning MCP server processes and calling tools via JSON-RPC.

#### 2b. Create MCP tool executor

The agent runner needs to call MCP tools (nanoclaw IPC, external servers) without Claude. Create a lightweight MCP client:

```typescript
// container/agent-runner/src/mcp-tool-executor.ts (new file)

export class McpToolExecutor {
  private servers: Map<string, ChildProcess>;

  // Start MCP server processes (same ones Claude would start)
  async initialize(mcpConfig: Record<string, McpServerEntry>): Promise<void>;

  // Call a tool by its MCP name (e.g., 'mcp__nanoclaw__send_message')
  async callTool(mcpToolName: string, args: Record<string, unknown>): Promise<string>;

  // Graceful shutdown
  async close(): Promise<void>;
}
```

This spawns the same MCP servers (nanoclaw IPC, external servers) and communicates via JSON-RPC over stdio, exactly as Claude's SDK does internally.

#### 2c. Add Ollama direct path to agent runner

Modify `container/agent-runner/src/index.ts` `main()`:

```typescript
async function main(): Promise<void> {
  const containerInput = /* ... existing parse ... */;

  if (containerInput.model?.startsWith('ollama:') || containerInput.model?.startsWith('ollama-remote:')) {
    await runOllamaDirectMode(containerInput);
    return;
  }

  // ... existing Claude SDK path unchanged ...
}

async function runOllamaDirectMode(input: ContainerInput): Promise<void> {
  const [prefix, model] = input.model!.split(':', 2);
  const host = prefix === 'ollama-remote'
    ? process.env.OLLAMA_REMOTE_HOST || 'http://localhost:11434'
    : process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

  // 1. Initialize MCP tool executor with nanoclaw + external servers
  const executor = new McpToolExecutor();
  await executor.initialize(loadMcpConfig());

  // 2. Build system prompt from CLAUDE.md + global CLAUDE.md
  const systemPrompt = buildSystemPrompt(input);

  // 3. Run Ollama chat loop with tool calling
  const result = await runOllamaChat(
    [{ role: 'user', content: input.prompt }],
    {
      host,
      model,
      systemPrompt,
      maxIterations: input.maxToolRounds || 10,
      timeoutMs: input.timeoutMs || 300_000,
      tools: executor.getOllamaTools(),
      toolNameMap: executor.getToolNameMap(),
      executeTool: (name, args) => executor.callTool(name, args),
    },
  );

  // 4. Write output in same format as Claude path
  writeOutput({ status: 'success', result: result.response });

  await executor.close();
}
```

#### 2d. Pass OLLAMA_REMOTE_HOST to container

In `src/container-runner.ts`, when the model starts with `ollama-remote:`, read `OLLAMA_REMOTE_HOST` from `.env` and pass it as a container environment variable:

```typescript
if (input.model?.startsWith('ollama-remote:')) {
  const remoteHost = readEnvFile(['OLLAMA_REMOTE_HOST']).OLLAMA_REMOTE_HOST;
  if (remoteHost) {
    args.push('-e', `OLLAMA_REMOTE_HOST=${remoteHost}`);
  }
}
```

The existing `OLLAMA_HOST` is already available in the container environment (used by `ollama-mcp-stdio.ts`).

#### 2e. Skip credential proxy for Ollama-only containers

When the profile backend is `ollama`, the container doesn't need Anthropic credentials. Skip the `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `CLAUDE_CODE_OAUTH_TOKEN` environment variables in `buildContainerArgs()`. This is a minor optimization but also reduces the attack surface.

**Files changed:** `container/agent-runner/src/ollama-chat-engine.ts` (new), `container/agent-runner/src/mcp-tool-executor.ts` (new), `container/agent-runner/src/index.ts`, `src/container-runner.ts`

### Phase 3: Session Handling and IPC Differences

**Goal:** Handle the differences between Claude's session model and Ollama's stateless model.

#### 3a. No persistent sessions for Ollama

Claude uses session IDs to resume conversations. Ollama has no built-in session concept. For Ollama direct mode:

- Don't pass or persist `sessionId`.
- Don't resume sessions. Each invocation is a fresh conversation.
- Still include recent message history in the prompt (the orchestrator already formats this in `processGroupMessages`).

The agent runner's query loop (run query -> wait for IPC -> run new query) still works: each iteration is a new Ollama chat call.

#### 3b. No compaction hooks

The `PreCompact` hook that archives transcripts before context compaction is Claude-specific. Skip it in Ollama mode. Ollama conversations are short enough that archiving isn't needed.

#### 3c. IPC input polling

The existing IPC input polling (follow-up messages written to `/workspace/ipc/input/`) works unchanged. In Ollama mode, each follow-up message triggers a new `runOllamaChat()` call with the full message as prompt.

#### 3d. Idle timeout

Ollama containers should have a shorter idle timeout since there's no persistent session to maintain. The connection profile already handles this (30s default for Ollama vs 30min for Claude).

**Files changed:** `container/agent-runner/src/index.ts`

### Phase 4: System Prompt Construction

**Goal:** Give Ollama models the context they need to function as NanoClaw agents.

#### 4a. Build system prompt from CLAUDE.md files

Claude gets its context from CLAUDE.md files loaded by the SDK. For Ollama, we need to construct an equivalent system prompt:

```typescript
function buildSystemPrompt(input: ContainerInput): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful assistant.`);

  // Load group CLAUDE.md
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    parts.push('## Group Memory\n' + fs.readFileSync(groupClaudeMd, 'utf-8'));
  }

  // Load global CLAUDE.md
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!input.isMain && fs.existsSync(globalClaudeMd)) {
    parts.push('## Shared Memory\n' + fs.readFileSync(globalClaudeMd, 'utf-8'));
  }

  if (input.isScheduledTask) {
    parts.push('This is a scheduled task running automatically, not a direct user message.');
  }

  return parts.join('\n\n');
}
```

#### 4b. Tool descriptions in system prompt

The MCP tool executor knows all available tools and their descriptions. Include a tool summary in the system prompt so the model knows what it can do (the existing `ollama-mcp-stdio.ts` already does this pattern).

**Files changed:** `container/agent-runner/src/index.ts` or `container/agent-runner/src/ollama-chat-engine.ts`

### Phase 5: Environment and Networking

**Goal:** Ensure Ollama is reachable from containers.

#### 5a. Local Ollama

Already works. `OLLAMA_HOST` defaults to `http://host.docker.internal:11434`, which resolves to the host machine from inside Docker.

#### 5b. Remote Ollama

Add `OLLAMA_REMOTE_HOST` to `.env.example`:

```bash
# Remote Ollama server (for ollama-remote: prefix)
# OLLAMA_REMOTE_HOST=http://192.168.1.100:11434
```

The container needs network access to the remote host. Docker's default bridge network allows outbound connections, so this should work without special configuration. If the remote Ollama is on a different subnet, the user may need to configure Docker networking, but that's outside NanoClaw's scope.

#### 5c. Host gateway fallback

The existing `ollamaFetch()` fallback (try `host.docker.internal`, fall back to `localhost`) should be preserved in the chat engine.

**Files changed:** `.env.example`, `src/container-runner.ts`

## Risk Assessment

### Model Capability

Ollama models are significantly less capable than Claude at complex multi-step tool calling. Mitigations:
- Configurable `maxToolRounds` lets users tune per group/task
- The system prompt explicitly lists available tools and encourages their use
- Simple tasks (notifications, summaries, lookups) are the primary use case

### No Session Persistence

Ollama doesn't maintain conversation state between invocations. Each message is a standalone call. The orchestrator already prepends recent message history to the prompt, which provides context. For groups that need deeper memory, the CLAUDE.md file serves as persistent context.

### Tool Calling Reliability

Ollama tool calling depends on the model. Some models (qwen3, mistral-small3.2) handle it well. Others may ignore tools or produce malformed calls. The `maxToolRounds` limit prevents infinite loops. The MCP tool executor should validate tool call arguments before execution.

### Container Image Size

No change. The container already includes the Ollama npm package (used by `ollama-mcp-stdio.ts`).

## Migration

No breaking changes. Existing groups and tasks continue to work exactly as before. The `ollama:` and `ollama-remote:` prefixes are opt-in.

To switch an existing group to Ollama:
```
@Andy set this group to use ollama:qwen3
```

The agent (running as Claude) would call `update_group` IPC with `model: 'ollama:qwen3'`. From the next message onward, the group uses Ollama directly.

## Testing Plan

1. **Unit tests:** `resolveProfile()` correctly parses model strings and applies overrides
2. **Integration test:** `McpToolExecutor` can start an MCP server and call a tool
3. **End-to-end:** Send a message to a group with `model: 'ollama:qwen3'`, verify it gets a response without any Anthropic API calls
4. **Tool calling:** Verify Ollama can call `send_message` and `schedule_task` IPC tools
5. **Timeout:** Verify configurable timeouts work at both container and chat-engine levels
6. **Fallback:** If Ollama is unreachable, error is reported cleanly (not a hang)

## File Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `src/connection-profiles.ts` | New | Parse model strings, resolve connection profiles |
| `src/types.ts` | Modify | Add `maxToolRounds`, `timeoutMs` to `RegisteredGroup` and `ScheduledTask` |
| `src/db.ts` | Modify | Migration for new columns, update queries |
| `src/container-runner.ts` | Modify | Use profile for timeouts, pass new fields, skip creds for Ollama |
| `src/index.ts` | Modify | Resolve profile before `runContainerAgent` |
| `src/task-scheduler.ts` | Modify | Resolve profile before `runContainerAgent` |
| `src/ipc.ts` | Modify | Accept new fields in IPC handlers |
| `container/agent-runner/src/index.ts` | Modify | Branch on model prefix, add `runOllamaDirectMode` |
| `container/agent-runner/src/ollama-chat-engine.ts` | New | Extracted Ollama chat loop with direct tool execution |
| `container/agent-runner/src/mcp-tool-executor.ts` | New | Lightweight MCP client for tool execution without Claude |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Modify | Expose new fields in MCP tool schemas |
| `.env.example` | Modify | Add `OLLAMA_REMOTE_HOST` |

## Estimated Complexity

- **Phase 1** (configurable limits): Straightforward. Mostly plumbing new fields through existing paths.
- **Phase 2** (Ollama direct runner): Medium. The chat engine is mostly extracted from existing code. The MCP tool executor is the most novel piece — it needs to implement the JSON-RPC client protocol for MCP, but the discovery code in `container-runner.ts` already demonstrates this pattern.
- **Phase 3** (session handling): Small. Mostly skipping things.
- **Phase 4** (system prompts): Small. Template construction.
- **Phase 5** (networking): Small. Mostly configuration.

Phases 1 and 2 are the bulk of the work. Phases 3-5 are incremental and can be folded into Phase 2 as needed.
