# Lightweight Task Engine: Direct Anthropic API for Scheduled Tasks

## Problem

Scheduled tasks use the full Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with the `claude_code` system prompt preset. This adds ~50K tokens of system context per API call — tool schemas for 15+ built-in tools (Bash, Read, Write, Edit, Glob, Grep, etc.) plus the full Claude Code instruction set. A simple monitoring task that calls one MCP tool and formats the output costs ~58.5K tokens per run. At 144 runs/day, this is ~$7/day ($213/month) on Haiku.

The actual task work — prompt, tool call, tool result, formatted response — is ~3-5K tokens.

## Solution

Add a third execution path in the agent-runner: a lightweight chat loop using `@anthropic-ai/sdk` (the plain Anthropic Messages API) with a minimal system prompt and only the MCP tools the task needs. This is the same architectural pattern as the existing Ollama direct mode engine.

**Default behaviour:** Scheduled tasks use the lightweight engine. Interactive (user-entered) messages continue using the full Agent SDK.

**Per-task override:** A `useAgentSdk` boolean field on `scheduled_tasks` (default `false`). When `true`, the task uses the full Agent SDK path. This allows specific tasks that need file access, bash, web search, or other built-in tools to opt in.

## Architecture

```
Container Input
  │
  ├─ model starts with "ollama:" or "ollama-remote:" ──────→ Ollama Engine (existing)
  │
  ├─ (isScheduledTask && !useAgentSdk) || model starts with "anthropic:" ──→ Anthropic API Engine (NEW)
  │
  └─ else (model may *optionally* start with "claude:" for documentation purposes) ────→ Agent SDK Engine (existing)
```

The new Anthropic API Engine mirrors the Ollama engine's structure:
- Minimal system prompt (from CLAUDE.md / group memory)
- MCP tool executor for tool calls (already shared with Ollama path)
- Simple tool-call loop with timeout and iteration limits
- Token usage tracking built in (API response includes usage)
- No built-in tools (no Bash, Read, Write, etc.)

**Backend defaults:** `data/backend-defaults.json` gains an `anthropic-api` key alongside the existing `claude` and `ollama` keys. The `anthropic-api` backend uses its own hardcoded fallbacks (`maxToolRounds: 15`, `timeoutMs: 300000`) when no config file entry exists. The priority chain is the same as the other backends: per-task → per-group → `backend-defaults.json` → hardcoded.

Example `data/backend-defaults.json`:

```json
{
  "claude": { "maxToolRounds": 0, "timeoutMs": 1800000 },
  "ollama": { "maxToolRounds": 10, "timeoutMs": 300000 },
  "anthropic-api": { "maxToolRounds": 15, "timeoutMs": 300000 }
}
```

**Model prefixes:** Two new prefixes are recognised by `connection-profiles.ts`:

| Prefix | Backend | Effect |
|--------|---------|--------|
| `anthropic:` | `anthropic-api` | Lightweight API engine for both interactive and scheduled messages. Use for groups with an intentionally limited MCP-only toolset. |
| `claude:` | `claude` | Explicit Agent SDK path. Stripped before passing to the SDK. Documentary — equivalent to no prefix. |

`ConnectionProfile.backend` becomes `'claude' | 'ollama' | 'anthropic-api'`. The `anthropic:` prefix is parsed the same way as `ollama:` — strip prefix, pass model name through, resolve defaults from the `anthropic-api` backend config.

**Host-side routing impact:** Two call sites check `isOllamaModel()` to decide behaviour:

1. **`src/container-runner.ts:608`** — decides whether to inject `ANTHROPIC_BASE_URL` and credentials into the container. The `anthropic-api` backend **does** need the credential proxy (it calls the Anthropic API), so `isOllamaModel()` returning false is correct. No change needed.
2. **`:cloud:` emoji prefix** in `src/task-scheduler.ts:210` and `src/index.ts:294` — prefixes responses from non-Ollama models with `:cloud:`. The `anthropic-api` backend should also get this prefix. Current logic (`!isOllamaModel()`) is correct. No change needed.

The `anthropic:` prefix model string flows through unchanged to the container, where the agent-runner strips it for routing (same as `ollama:`).

## Implementation Plan (TDD)

### Phase 1: Database, Types & Connection Profiles

**Test first:** Add test in `src/task-scheduler.test.ts` asserting that `useAgentSdk` is read from the task and passed through to the container input. Add tests in `src/connection-profiles.test.ts` for the new `anthropic:` and `claude:` prefixes and the `anthropic-api` backend defaults.

1. Add `use_agent_sdk` column to `scheduled_tasks` table (migration in `src/db.ts`, default `0`/false)
2. Add `useAgentSdk?: boolean` to `ScheduledTask` interface in `src/types.ts`
3. Add `use_agent_sdk AS useAgentSdk` to the `TASK_SELECT` constant in `src/db.ts`
4. Add `useAgentSdk?: boolean` to `ContainerInput` interface in `container/agent-runner/src/index.ts`
5. Pass it through in `src/task-scheduler.ts` when constructing container input
6. Extend `ConnectionProfile.backend` to `'claude' | 'ollama' | 'anthropic-api'` in `src/connection-profiles.ts`
7. Add `anthropic:` prefix handling in `resolveProfile()` — strip prefix, resolve defaults from `anthropic-api` backend config, set `backend: 'anthropic-api'`
8. Add `claude:` prefix handling in `resolveProfile()` — strip prefix, resolve defaults from `claude` backend config (same as no-prefix path)
9. Add `HARDCODED_ANTHROPIC_API` defaults: `{ maxToolRounds: 15, timeoutMs: 300_000 }`. Set `containerTimeoutMs = timeoutMs + 60_000`. Set `idleTimeoutMs = IDLE_TIMEOUT` (same as Claude SDK — interactive sessions carry conversation history and are worth keeping alive)
10. Add `isAnthropicApiModel()` export (mirrors `isOllamaModel()`)
11. Update `data/backend-defaults.json.example` with the `anthropic-api` key

**Files:** `src/db.ts`, `src/types.ts`, `src/task-scheduler.ts`, `src/connection-profiles.ts`, `src/connection-profiles.test.ts`, `container/agent-runner/src/index.ts`, `data/backend-defaults.json.example`

### Phase 2: Add `@anthropic-ai/sdk` as Explicit Dependency

It's currently available as a transitive dependency of `claude-agent-sdk`, but must be explicit before Phase 3 can import it:

```bash
cd container/agent-runner && npm install @anthropic-ai/sdk
```

Then rebuild the container image (`./container/build.sh`).

**Files:** `container/agent-runner/package.json`

### Phase 3: Anthropic API Engine

**Test first:** Create `container/agent-runner/src/anthropic-api-engine.test.ts` mirroring the structure of `ollama-chat-engine.test.ts`:
- Mock `@anthropic-ai/sdk` Messages client
- Test: single text response (no tools) → returns immediately
- Test: tool call → executes tool → feeds result back → final response
- Test: multiple tool calls in sequence
- Test: timeout → returns with `timedOut: true`
- Test: max iterations → returns with `maxIterationsReached: true`
- Test: token accumulation across rounds
- Test: lazy skill injection on first tool call per server (system prompt grows)
- Test: repeated same-tool detection (stuck loop — 3 consecutive same-tool+same-result → abort)
- Test: auto-compaction triggers when input tokens exceed threshold
- Test: auto-compaction replaces messages with summary + recent exchange
- Test: existingMessages are carried through and new user message is appended

Then implement `container/agent-runner/src/anthropic-api-engine.ts`:

```typescript
export interface AnthropicApiOptions {
  model: string;              // e.g. "haiku" → resolved to full model ID
  systemPrompt?: string;
  temperature?: number;
  maxIterations: number;
  timeoutMs: number;
  tools: AnthropicTool[];     // Anthropic SDK tool format
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>;
  executeTool: (mcpToolName: string, args: Record<string, unknown>) => Promise<string>;
  onStatus?: (status: string) => void;
  serverSkills?: Map<string, string>;
  /** Existing conversation history for session continuity (interactive mode). */
  existingMessages?: MessageParam[];
}

export interface AnthropicApiResult {
  response: string;
  iterations: number;
  timedOut: boolean;
  maxIterationsReached: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Updated conversation history — pass back as existingMessages for the next call. */
  messages: MessageParam[];
}

export async function runAnthropicApiChat(
  userMessage: string,
  options: AnthropicApiOptions,
): Promise<AnthropicApiResult>
```

**Note:** No `costUSD` field. The raw Messages API returns token counts but not cost. Cost is left `null` in `task_run_logs` (same as Ollama). It can be derived externally from token counts if needed.

**Core loop** (adapted from `ollama-chat-engine.ts`):
1. Start from `existingMessages` if provided, otherwise `[]`. Append `{ role: 'user', content: userMessage }`.
2. Call `anthropic.messages.create({ model, system, messages, tools, max_tokens: 4096, temperature })`
   - `max_tokens: 4096` is a sensible default for task responses. Can be made configurable later if needed.
3. Check `stop_reason`:
   - `"end_turn"` → extract text, append assistant message to history, return result with updated `messages` array
   - `"tool_use"` → extract tool calls, execute via `executeTool`, append assistant + tool_result messages, loop
4. Accumulate `response.usage.input_tokens` and `output_tokens` each round (also `cache_read_input_tokens` and `cache_creation_input_tokens` when present)
5. Check timeout and iteration limits

**Session continuity:** The returned `messages` array contains the full conversation history. For scheduled tasks (single-shot), this is discarded. For interactive `anthropic:` groups, the outer IPC loop passes it back as `existingMessages` on the next call — giving the model full context of the ongoing conversation. The Anthropic API's prompt caching means the repeated prefix is served from cache at reduced cost. Unlike the Ollama path (which starts fresh each IPC iteration), this gives interactive `anthropic:` groups persistent memory within a container session.

**Context compaction:** The messages array grows with each exchange and will eventually approach the model's context window limit. Two compaction mechanisms are supported:

1. **Auto-compaction** — after each `messages.create()` call, check `response.usage.input_tokens` against a threshold (75% of the model's context window). When exceeded, trigger compaction before the next user message. The compaction call asks the model to summarize the conversation so far, then replaces the messages array with `[{ role: 'user', content: '<summary>' }, { role: 'assistant', content: 'Understood, continuing.' }]` plus the most recent exchange. This keeps the conversation coherent while freeing context space.

2. **Interactive `/compact`** — when the user message is exactly `/compact`, skip normal processing and trigger compaction immediately regardless of token count. Return a confirmation message (e.g., "Conversation compacted — {before} → {after} tokens"). The `/compact` command is detected and handled inside `runAnthropicApiMode()` before calling `runAnthropicApiChat()`.

The compaction call uses the same model, API key, and credential proxy as the main chat. It does NOT count toward the `maxIterations` limit. The compaction prompt is:

```
Summarize the key points, decisions, and context from this conversation so far.
Be concise but preserve all information needed to continue the conversation coherently.
Include any pending tasks, open questions, or commitments made.
```

Auto-compaction is logged: `[anthropic-engine] Auto-compacting: {input_tokens} tokens exceeds threshold ({threshold})`.

**Context window sizes:** The `/v1/models` response (already fetched for model resolution) includes the model's context window size. Use this to compute the 75% threshold dynamically. If the models endpoint is unavailable, fall back to a conservative default (e.g., 150K tokens — fits all current Claude models).

**Model resolution:** At engine startup (before the chat loop), call `GET /v1/models` through `ANTHROPIC_BASE_URL` (credential proxy handles auth). Cache the response for the lifetime of this invocation. Resolve short names by matching against the returned model IDs:
- `"haiku"` → find model ID containing `haiku`, prefer latest by date suffix
- `"sonnet"` → same pattern
- `"opus"` → same pattern
- Pass through any full model ID as-is (user may have specified one directly)

This avoids a hardcoded mapping table and automatically picks up new models.

**Stuck loop detection:** Port the existing algorithm from `ollama-chat-engine.ts` (lines 138-352). Track three variables: `repeatToolName`, `repeatToolResult`, `repeatCount`. When the same tool returns the same result 3 consecutive times (`REPEAT_THRESHOLD = 3`), abort and return a descriptive error. This catches deterministic failures without being too aggressive (a single retry is reasonable; three identical results means the model is stuck).

**Skill injection:** Use the "rebuild system prompt" approach. The `system` parameter is rebuilt before each `messages.create()` call to include any newly-triggered skill content:

```typescript
let systemPrompt = baseSystemPrompt;
const injectedSkills = new Set<string>();

// In the tool-call handling, before the next messages.create():
if (serverName && serverSkills?.has(serverName) && !injectedSkills.has(serverName)) {
  systemPrompt += `\n\n<tool-instructions name="${serverName}">\n${serverSkills.get(serverName)!}\n</tool-instructions>`;
  injectedSkills.add(serverName);
}
```

This keeps skill instructions in the system prompt where Claude models follow them most reliably. The stable prefix is prompt-cached; only the appended skill content adds incremental cost.

**API authentication:** The credential proxy at `ANTHROPIC_BASE_URL` handles auth — the engine just needs the placeholder API key and base URL from the container environment (same as the Agent SDK path).

**Files:** `container/agent-runner/src/anthropic-api-engine.ts`, `container/agent-runner/src/anthropic-api-engine.test.ts`

### Phase 4: Tool Format Conversion

**Test first:** Add tests in `container/agent-runner/src/mcp-tool-executor.test.ts` for a new `getAnthropicTools()` method.

Add `getAnthropicTools()` to `McpToolExecutor` that returns tool schemas in Anthropic SDK format:

```typescript
// Anthropic tool format
{
  name: "lmax-venues__check_venue_status",
  description: "...",
  input_schema: { type: "object", properties: { ... } }
}
```

This is nearly identical to the Ollama format (`getOllamaTools()`) — the only difference is `input_schema` vs `parameters` and no `type: 'function'` wrapper.

**Files:** `container/agent-runner/src/mcp-tool-executor.ts`

### Phase 5: System Prompt for Anthropic API Tasks

**Test first:** Create `container/agent-runner/src/task-system-prompt.test.ts` with tests for the new `buildTaskSystemPrompt()` function.

Create a distinct `buildTaskSystemPrompt()` in a new file `container/agent-runner/src/task-system-prompt.ts`. This function always reads `CLAUDE.md` (never `OLLAMA.md`) because this is the Claude backend — just without the SDK bloat. It does **not** load `OLLAMA-SYSTEM.md` base instructions (those contain Ollama-specific tool-calling syntax rules).

Contents:
- Identity line (assistant name)
- Group memory (`CLAUDE.md` only)
- Global memory (`CLAUDE.md` only)
- Channel overrides (e.g. `SLACK.md`)
- Scheduled task marker (when applicable)
- **No** Claude Code instructions, tool usage rules, safety guidelines, etc.

Share the `readMemoryFile()` helper from `ollama-system-prompt.ts` (extract to a shared module or duplicate — it's 10 lines). Pass explicit filename lists:

```typescript
readMemoryFile('/workspace/group', 'CLAUDE.md')        // Anthropic API path
readMemoryFile('/workspace/group', 'OLLAMA.md', 'CLAUDE.md')  // Ollama path (existing)
```

**Files:** `container/agent-runner/src/task-system-prompt.ts`, `container/agent-runner/src/task-system-prompt.test.ts`

### Phase 6: Wire Up in Agent-Runner

**Test first:** Not easily unit-testable (integration). Verify via manual test run.

In `container/agent-runner/src/index.ts`, add the routing logic in `main()`:

```typescript
// Strip claude: prefix (documentary only — routes to Agent SDK like bare model names)
if (containerInput.model?.startsWith('claude:')) {
  containerInput.model = containerInput.model.slice('claude:'.length);
}

if (containerInput.model?.startsWith('ollama:') || containerInput.model?.startsWith('ollama-remote:')) {
  await runOllamaDirectMode(containerInput);
} else if (containerInput.model?.startsWith('anthropic:') || (containerInput.isScheduledTask && !containerInput.useAgentSdk)) {
  await runAnthropicApiMode(containerInput);    // NEW
} else {
  // existing Agent SDK query() path
}
```

The `runAnthropicApiMode()` function mirrors `runOllamaDirectMode()` (lines 589-816):
1. Strip `anthropic:` prefix from model string (if present)
2. Load MCP config from `/workspace/mcp-servers-config/config.json`
3. Add nanoclaw IPC server (same tool restrictions as Ollama scheduled tasks: `send_message`, `send_cross_channel_message`, `list_tasks` only for scheduled tasks)
4. Initialise `McpToolExecutor` with `callTimeoutMs`
5. Load skill files for lazy injection (same logic as Ollama path, lines 680-738)
6. Build system prompt via `buildTaskSystemPrompt()`
7. Get tools via `executor.getAnthropicTools()` and `executor.getToolNameMap()`
8. Call `runAnthropicApiChat()` with the task prompt
9. Write output via `writeOutput()` including token usage (no cost)
10. Support the IPC message loop for interactive `anthropic:` groups (wait for next message, repeat — same control flow as Ollama path lines 756-812). Unlike Ollama, carry conversation history across iterations: keep the `messages` array returned from `runAnthropicApiChat()` and pass it back as `existingMessages` on the next call. This gives interactive sessions persistent context within the container's lifetime.
11. Handle `/compact` command: when the incoming IPC message is exactly `/compact`, run a compaction cycle on the current messages array (same logic as auto-compaction but unconditional), write the result count to output, and continue waiting for the next message. Do not pass `/compact` through to `runAnthropicApiChat()`.

**Files:** `container/agent-runner/src/index.ts`

### Phase 7: Web UI (skill/web-ui branch)

Expose the `useAgentSdk` toggle on the task detail page:
- Checkbox: "Use full Agent SDK" (default unchecked)
- Help text: "Enable for tasks that need file access, bash, or web search. Disabled uses lightweight API calls with lower token usage."

**Files:** `webui/routes/tasks.ts`, `webui/public/app.js`

### Phase 8: IPC Task Creation & Group Model Setting

Update the `schedule_task` and `update_task` IPC tools to accept `use_agent_sdk` parameter so tasks can be configured via chat.

Also update the `model` parameter descriptions in `schedule_task` and `update_task` to document the `anthropic:` prefix option alongside the existing `ollama:` prefix.

**Files:** `container/agent-runner/src/ipc-mcp-stdio.ts`

## Expected Impact

| Metric | Before (Agent SDK) | After (API Engine) |
|--------|-------------------:|-------------------:|
| System prompt tokens | ~40-50K | ~1-2K |
| Tool schema tokens | ~4-8K (36+ tools) | ~0.5-1K (1-3 tools) |
| Total tokens/run | ~58.5K | ~3-5K |
| Cost/run (Haiku) | ~$0.049 | ~$0.004 |
| Cost/day (144 runs) | ~$7.08 | ~$0.58 |
| Cost/month | ~$213 | ~$17 |

~92% reduction in token usage and cost for scheduled tasks.

## Verification

1. Run full test suite: `npx vitest run`
2. Build: `npm run build`
3. Rebuild container: `./container/build.sh`
4. Clear caches, restart nanoclaw
5. Trigger a haiku scheduled task, verify:
   - Container log shows "Anthropic API mode" (not "Starting query")
   - Token usage in `task_run_logs` shows ~3-5K (not ~58K)
   - Task output is correct
6. Set `useAgentSdk=true` on a task, verify it uses the full SDK path
7. Verify interactive messages on a default (no-prefix) group still use the full SDK path
8. Set a group to `anthropic:sonnet`, send two messages in sequence, verify:
   - Both route to Anthropic API engine
   - Second response shows awareness of the first exchange (session continuity)
   - MCP tools work correctly
9. Set a group to `claude:sonnet`, verify it routes to Agent SDK (prefix stripped)
10. In an `anthropic:` group with active session, send `/compact`, verify:
    - Compaction occurs (log shows "Auto-compacting" or "Compact requested")
    - Confirmation message shows before/after token counts
    - Next message still has conversational context (summary preserved)
11. In an `anthropic:` group, have a long enough conversation to trigger auto-compaction, verify:
    - Log shows auto-compaction trigger
    - Conversation continues coherently after compaction
