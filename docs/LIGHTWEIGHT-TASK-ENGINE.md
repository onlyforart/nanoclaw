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
  ├─ model starts with "ollama:" ──────→ Ollama Engine (existing)
  │
  ├─ isScheduledTask && !useAgentSdk ──→ Claude API Engine (NEW)
  │
  └─ else ─────────────────────────────→ Agent SDK Engine (existing)
```

The new Claude API Engine mirrors the Ollama engine's structure:
- Minimal system prompt (from CLAUDE.md / group memory)
- MCP tool executor for tool calls (already shared with Ollama path)
- Simple tool-call loop with timeout and iteration limits
- Token usage tracking built in (API response includes usage)
- No built-in tools (no Bash, Read, Write, etc.)

## Implementation Plan (TDD)

### Phase 1: Database & Types

**Test first:** Add test in `src/task-scheduler.test.ts` asserting that `useAgentSdk` is read from the task and passed through to the container input.

1. Add `use_agent_sdk` column to `scheduled_tasks` table (migration in `src/db.ts`, default `0`/false)
2. Add `useAgentSdk?: boolean` to `ScheduledTask` interface in `src/types.ts`
3. Add `useAgentSdk?: boolean` to `ContainerInput` interface in `container/agent-runner/src/index.ts`
4. Pass it through in `src/task-scheduler.ts` when constructing container input

**Files:** `src/db.ts`, `src/types.ts`, `src/task-scheduler.ts`, `container/agent-runner/src/index.ts`

### Phase 2: Claude API Engine

**Test first:** Create `container/agent-runner/src/claude-api-engine.test.ts` mirroring the structure of `ollama-chat-engine.test.ts`:
- Mock `@anthropic-ai/sdk` Messages client
- Test: single text response (no tools) → returns immediately
- Test: tool call → executes tool → feeds result back → final response
- Test: multiple tool calls in sequence
- Test: timeout → returns with `timedOut: true`
- Test: max iterations → returns with `maxIterationsReached: true`
- Test: token accumulation across rounds
- Test: lazy skill injection on first tool call per server
- Test: repeated same-tool detection (stuck loop)

Then implement `container/agent-runner/src/claude-api-engine.ts`:

```typescript
export interface ClaudeApiOptions {
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
}

export interface ClaudeApiResult {
  response: string;
  iterations: number;
  timedOut: boolean;
  maxIterationsReached: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;            // computed from token counts + model pricing
}

export async function runClaudeApiChat(
  userMessage: string,
  options: ClaudeApiOptions,
): Promise<ClaudeApiResult>
```

**Core loop** (adapted from `ollama-chat-engine.ts`):
1. Build messages array: `[{ role: 'user', content: userMessage }]`
2. Call `anthropic.messages.create({ model, system, messages, tools, max_tokens, temperature })`
3. Check `stop_reason`:
   - `"end_turn"` → extract text, return as final response
   - `"tool_use"` → extract tool calls, execute via `executeTool`, append results, loop
4. Accumulate `response.usage.input_tokens` and `output_tokens` each round
5. Check timeout and iteration limits

**Model resolution:** Map short names to full model IDs:
- `"haiku"` → `"claude-haiku-4-5-20251001"`
- `"sonnet"` → `"claude-sonnet-4-6-20250514"`
- `"opus"` → `"claude-opus-4-6-20250514"`
- Pass through any full model ID as-is

**API authentication:** The credential proxy at `ANTHROPIC_BASE_URL` handles auth — the engine just needs the placeholder API key and base URL from the container environment (same as the Agent SDK path).

**Files:** `container/agent-runner/src/claude-api-engine.ts`, `container/agent-runner/src/claude-api-engine.test.ts`

### Phase 3: Tool Format Conversion

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

### Phase 4: System Prompt for Tasks

**Test first:** Add tests in `container/agent-runner/src/ollama-system-prompt.test.ts` (or a new file) for a task-specific prompt builder.

Adapt `buildOllamaSystemPrompt()` (or create `buildTaskSystemPrompt()`) to produce a minimal prompt for scheduled tasks:
- Identity line (assistant name)
- Group memory (CLAUDE.md)
- Global memory
- Channel overrides
- Scheduled task marker
- **No** Claude Code instructions, tool usage rules, safety guidelines, etc.

The existing `buildOllamaSystemPrompt()` already does most of this. Consider renaming/refactoring to share the memory-loading logic.

**Files:** `container/agent-runner/src/ollama-system-prompt.ts` (or new `task-system-prompt.ts`)

### Phase 5: Wire Up in Agent-Runner

**Test first:** Not easily unit-testable (integration). Verify via manual test run.

In `container/agent-runner/src/index.ts`, add the routing logic:

```typescript
// In the main function, after parsing containerInput:

if (isOllamaModel) {
  await runOllamaDirectMode(containerInput);
} else if (containerInput.isScheduledTask && !containerInput.useAgentSdk) {
  await runClaudeApiMode(containerInput);    // NEW
} else {
  await runAgentSdkMode(containerInput);     // existing query() path
}
```

The `runClaudeApiMode()` function:
1. Initialises `McpToolExecutor` (same as Ollama path)
2. Builds system prompt via `buildTaskSystemPrompt()`
3. Gets tools via `executor.getAnthropicTools()`
4. Calls `runClaudeApiChat()` with the task prompt
5. Writes output via `writeOutput()` including usage

**Files:** `container/agent-runner/src/index.ts`

### Phase 6: Add `@anthropic-ai/sdk` as Explicit Dependency

It's currently available as a transitive dependency of `claude-agent-sdk`, but should be explicit:

```bash
cd container/agent-runner && npm install @anthropic-ai/sdk
```

Then rebuild the container image (`./container/build.sh`).

**Files:** `container/agent-runner/package.json`

### Phase 7: Web UI (skill/web-ui branch)

Expose the `useAgentSdk` toggle on the task detail page:
- Checkbox: "Use full Agent SDK" (default unchecked)
- Help text: "Enable for tasks that need file access, bash, or web search. Disabled uses lightweight API calls with lower token usage."

**Files:** `webui/routes/tasks.ts`, `webui/public/app.js`

### Phase 8: IPC Task Creation

Update the `schedule_task` and `update_task` IPC tools to accept `use_agent_sdk` parameter so tasks can be configured via chat.

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
   - Container log shows "Claude API mode" (not "Starting query")
   - Token usage in `task_run_logs` shows ~3-5K (not ~58K)
   - Task output is correct
6. Set `useAgentSdk=true` on a task, verify it uses the full SDK path
7. Verify interactive messages still use the full SDK path
