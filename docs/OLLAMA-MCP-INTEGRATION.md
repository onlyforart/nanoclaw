# Ollama MCP Tool Integration

## Overview

Upgrade the container agent's Ollama MCP server from a plain text-in/text-out `ollama_generate` tool to a full `ollama_chat` tool that can discover and use all MCP tools available to the container agent. This gives local Ollama models the ability to call the same domain-specific tools (infrastructure queries, monitoring, status checks, etc.) that the primary Claude agent can use.

## Problem

Currently `ollama_generate` calls Ollama's `/api/generate` endpoint — plain text in, plain text out. When a scheduled task delegates work to Ollama (e.g. "check the health of system X"), Ollama can't actually call any MCP tools. It either hallucinates a response or correctly reports that tools are unavailable.

A standalone bridge CLI exists that solves this (connects to MCP servers, passes tools to Ollama, handles the tool-call loop), but it's not integrated into the container agent.

## Architecture

```
Claude Agent SDK
  |
  |-- calls ollama_chat via MCP (stdio)
  |
  v
ollama-mcp-stdio.ts (MCP server process)
  |
  |-- reads /workspace/mcp-servers-config/config.json
  |-- connects to each external MCP server via stdio (MCP client)
  |-- converts MCP tools to Ollama tool format
  |-- calls ollama.chat() with tools
  |-- handles tool-call loop (Ollama -> MCP server -> Ollama)
  |-- returns final text response
```

## Implementation Steps

### Step 1: Add Dependencies

**File:** `container/agent-runner/package.json`

Add `"ollama": "^0.5.0"` — Ollama client library with typed chat/tool support.

The `@modelcontextprotocol/sdk` dependency is already present (used for the MCP server side). It also provides the MCP client classes (`Client`, `StdioClientTransport`) needed to connect to external MCP servers.

`zod-to-json-schema` is NOT needed — the MCP SDK already returns JSON Schema from `listTools()`, and Ollama's `Tool` type accepts JSON Schema directly.

### Step 2: Create the MCP Client Module

**New file:** `container/agent-runner/src/ollama-mcp-client.ts`

Adapt the bridge's MCP client logic into the agent-runner package.

**Key differences from the bridge version:**

1. **Config format.** The container-side config at `/workspace/mcp-servers-config/config.json` has this shape (no `hostPath`):
   ```typescript
   interface ContainerMcpServerConfig {
     command: string;
     args: string[];
     tools: string[];
     env?: Record<string, string>;
     skill?: string;  // Relative path to SKILL.md (added in Step 3)
   }
   ```

2. **Skill discovery.** Read skill from the config's `skill` field, resolved against `/workspace/mcp-servers/{name}/`. Fall back to checking `/home/node/.claude/skills/{name}/SKILL.md` for skills that aren't colocated with the server.

3. **Environment handling.** The container-side config has pre-resolved env vars. Merge them with the current process environment when spawning the stdio transport (the container is already sandboxed).

4. **Tool name prefixing.** Use `{serverName}__{toolName}` format (double underscore) to avoid collisions between servers with same-named tools.

**Exports:**
```typescript
export interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];          // Ollama Tool format
  timeout?: number;
  skill?: string;         // Loaded SKILL.md content (stripped of frontmatter)
  skillInjected: boolean;
}

export interface ToolCallResult {
  content: string;
  skill?: string;  // Non-null on first call to a server with a skill
}

export function connectServer(name: string, config: ContainerMcpServerConfig): Promise<ConnectedServer>;
export function callTool(servers: ConnectedServer[], toolName: string, args: Record<string, unknown>): Promise<ToolCallResult>;
export function disconnectAll(servers: ConnectedServer[]): Promise<void>;
```

### Step 3: Add Skill Field to Container-Side Config

**File:** `src/container-runner.ts` (container-side config generation)

Include the `skill` field when the host-side server config has one:

```typescript
containerServers[name] = {
  command: server.command,
  args: server.args.map(/* ... existing path rewriting ... */),
  tools: server.tools || [],
  ...(Object.keys(resolvedEnv).length > 0 && { env: resolvedEnv }),
  ...(server.skill && { skill: server.skill }),  // NEW
};
```

The `skill` value (e.g., `"SKILL.md"`) is a relative path. The MCP client module resolves it against `/workspace/mcp-servers/{name}/`.

### Step 4: Rewrite ollama-mcp-stdio.ts

**File:** `container/agent-runner/src/ollama-mcp-stdio.ts`

Replace `ollama_generate` with `ollama_chat`. Keep `ollama_list_models` as-is.

#### 4a: Startup — Connect to MCP Servers

At module load time (before the MCP server transport connects):

1. Read `/workspace/mcp-servers-config/config.json`
2. Connect to each MCP server in parallel using `connectServer()`
3. Collect all Ollama-format tools from connected servers
4. Log tool count and names

If the config file does not exist or no servers connect, `ollama_chat` still works — text-only mode, equivalent to current `ollama_generate`.

#### 4b: The `ollama_chat` Tool

```typescript
server.tool(
  'ollama_chat',
  'Send a message to a local Ollama model with full tool access. The model can call any available MCP tools to answer your question. Use ollama_list_models first to see available models.',
  {
    model: z.string().describe('The model name'),
    message: z.string().describe('The user message to send'),
    system: z.string().optional().describe('Optional system prompt'),
    maxIterations: z.number().optional().describe('Max tool-calling rounds (default: 10)'),
  },
  async (args) => { /* ... */ }
);
```

#### 4c: Tool-Calling Loop

Inside the handler:

1. Build messages array (optional system prompt + user message)
2. Call `ollama.chat()` with model, messages, and all discovered tools
3. If response contains `tool_calls`:
   - Execute each tool call via `callTool()`
   - Inject skill instructions on first call per server (as system messages)
   - Push tool results back into messages
   - Call `ollama.chat()` again
   - Repeat until no more tool calls, max iterations, or timeout
4. Return final text response with metadata (model, iterations, duration)

**Safety limits:**
- Max iterations: default 10 (configurable per call)
- Per-tool-call timeout: 60s
- Total timeout: 5min

#### 4d: Graceful Shutdown

Register SIGTERM handler to disconnect MCP servers.

### Step 5: Streaming

**Decision: Start with `stream: false`, add streaming in a follow-up.**

Rationale:
- With streaming, tool calls are signaled in the final chunk — you must consume the entire stream before knowing if tools were called
- `stream: false` is simpler and matches the bridge's working pattern
- The MCP tool response is returned as a single text block (Claude sees the complete response)
- Streaming can be added later by accumulating chunks and checking the final chunk for tool calls

### Step 6: Rebuild

```bash
./container/build.sh
rm -rf data/sessions/*/task-run/agent-runner-src data/sessions/*/message-run/agent-runner-src  # Clear stale copies
```

No Dockerfile changes needed — the `ollama` dependency is picked up by `npm install`.

## Design Decisions

### Connection Lifecycle: Connect Once at Startup

MCP servers are connected when `ollama-mcp-stdio.ts` starts. This has the same lifetime as the container agent session.
- MCP server startup involves process spawning and capability negotiation — too slow per-call
- The container has a finite lifetime (one agent session), so cleanup is natural
- If an MCP server crashes mid-session, the tool call returns an error result to Ollama

### Tool Name Namespacing

Tools are prefixed as `{serverName}__{toolName}` (e.g., `monitoring__check_status`). This prevents collisions. The `callTool` function also handles unprefixed names (fallback search) since models sometimes drop prefixes.

### Skill Injection

Skills are injected as `system` messages in the Ollama conversation on the first tool call to each server. This provides domain context before the model processes the tool result. Skill content is loaded once at startup and cached.

### Error Boundaries

| Scenario | Behavior |
|----------|----------|
| Tool call fails | Error JSON returned as tool result (model can reason about it) |
| MCP server won't connect at startup | Logged, non-fatal — chat works without that server's tools |
| Max iterations hit | Loop stops, returns last response with note |
| Total timeout hit | Loop stops, returns partial response |

## File Change Summary

| File | Change | Description |
|------|--------|-------------|
| `container/agent-runner/package.json` | Modify | Add `ollama` dependency |
| `container/agent-runner/src/ollama-mcp-client.ts` | New | MCP client module for connecting to external servers |
| `container/agent-runner/src/ollama-mcp-stdio.ts` | Rewrite | Replace `ollama_generate` with `ollama_chat` + tool loop |
| `src/container-runner.ts` | Modify | Add `skill` field to container-side MCP config |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ollama model doesn't support tool calling | Tools ignored, text-only response | Document supported models (qwen3, mistral-small3.2) |
| Tool output too large for Ollama context | Model confusion or truncation | Truncate tool results to configurable max (e.g., 8KB) |
| Model calls wrong tool / hallucinates args | Tool error returned | Error handling + max iterations prevent loops |
| Two MCP clients (Claude + Ollama) to same server | Unlikely conflict — separate processes | Each has independent stdio connections |

## Testing Plan

1. **No tools:** Call `ollama_chat` with no MCP servers configured — verify plain text response
2. **With tools:** Configure a test MCP server, verify model can call tools and get results
3. **Skill injection:** Verify skill text injected on first tool call, not on subsequent calls
4. **Safety limits:** Verify max iterations and timeouts
5. **Error handling:** Kill an MCP server mid-conversation, verify graceful error
6. **Existing tasks:** Re-run the health check tasks that triggered this work
