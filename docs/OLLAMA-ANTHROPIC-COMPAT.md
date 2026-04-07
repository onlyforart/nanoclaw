# Ollama Anthropic Compatibility: Evaluation

**Date:** 2026-03-26
**Reference:** https://docs.ollama.com/api/anthropic-compatibility

## Background

Ollama now exposes `/v1/messages` — the same endpoint the Claude Agent SDK uses. In theory, we could set `ANTHROPIC_BASE_URL=http://ollama-host:11434` and the SDK would talk to Ollama directly, eliminating ~1,200 lines of custom Ollama integration code across 7 files.

This document evaluates whether that simplification is viable today.

## What the compatibility layer supports

- Core messaging, multi-turn conversations, system prompts
- Streaming with multiple event types
- Vision (base64 images only, not URLs)
- Tool use (function calling with definitions and results)
- Extended thinking (basic, budget_tokens not enforced)
- Standard parameters: model, max_tokens, temperature, top_p, top_k, stop sequences

## What the compatibility layer does NOT support

- Token counting endpoint (`/v1/messages/count_tokens`)
- Tool choice enforcement (`tool_choice: "required"` etc.)
- Prompt caching
- Batch processing
- Server-sent error events during streaming
- PDF documents, citations
- Request metadata

API key is accepted but not validated. Token counts are approximations.

## What we'd gain by switching

Deleting the following custom code:

| File | Lines | Purpose |
|------|-------|---------|
| `container/agent-runner/src/ollama-chat-engine.ts` | 283 | Custom chat loop with tool calling |
| `container/agent-runner/src/mcp-tool-executor.ts` | 192 | Lightweight MCP client for direct mode |
| `container/agent-runner/src/ollama-system-prompt.ts` | 77 | System prompt builder (OLLAMA.md preference) |
| `container/agent-runner/src/ollama-mcp-stdio.ts` | ~100 | MCP server for delegated mode |
| `container/OLLAMA-SYSTEM.md` | 15 | Tool usage rules for Ollama |

Plus simplification of `connection-profiles.ts`, `container-runner.ts`, and the agent runner entry point (`index.ts`).

SDK features like session persistence, streaming, and agent teams would work automatically.

## What we'd lose

The custom code exists because Ollama models are less reliable at agentic tasks than Claude. It provides guardrails the SDK doesn't need for Claude.

| Custom feature | Why it matters | Compat layer equivalent |
|---|---|---|
| Max tool rounds (default 10) | Prevents infinite tool-calling loops with weaker models | None — SDK uses unlimited rounds |
| Nudge logic | When Ollama stops calling tools prematurely, the engine nudges it to continue | None — SDK doesn't compensate for weaker models |
| OLLAMA.md separate prompts | Different instructions per backend (Ollama needs explicit "you MUST call tools" coaching) | Would need a workaround — SDK reads CLAUDE.md |
| Remote fallback | `ollama-remote:` tries remote host, falls back to local if unreachable | Would need custom logic elsewhere |
| Reachability checks | 3 retries before declaring Ollama down | SDK would just fail on first attempt |

## What could break silently

- **Tool choice enforcement**: SDK may send `tool_choice`, Ollama ignores it — tools may not be called when expected
- **Streaming errors**: If Ollama errors mid-stream, SDK may hang instead of getting a clean error event
- **Session resume**: Ollama almost certainly doesn't implement this — `resume`/`resumeSessionAt` would silently no-op
- **Token budgeting**: Approximate token counts could cause SDK to misjudge context limits
- **Prompt caching**: SDK sends cache hints, Ollama ignores them — functionally harmless but wasted overhead

## Recommendation

**Don't rip out the custom integration yet, but start a migration path.**

The compatibility layer is a protocol adapter, not a behavioral one. The custom code compensates for model capability gaps that still exist.

### Short term

Keep direct mode as-is. It works, it's tested, and the guardrails are load-bearing.

### Medium term

Test the compat layer with the most capable Ollama model (e.g. `qwen3:14b`) by pointing the SDK at Ollama for a single test group. Evaluate whether tool calling works end-to-end without nudge logic and round limits. The results will show how much custom code is still necessary.

### Long term

As Ollama models improve at tool calling, the guardrails become less necessary. At that point, the compat layer becomes a genuine simplification — only model-string routing (to set the base URL) and OLLAMA.md prompt logic would need to survive.
