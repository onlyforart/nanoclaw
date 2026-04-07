# Fork-Specific Notes

This is a personal fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). It merges several upstream skill branches and adds custom integrations. This document helps agents (and humans) find things that differ from the upstream README.

## Git Remotes

| Remote | Repo | Purpose |
|--------|------|---------|
| `origin` | `onlyforart/nanoclaw` | This fork |
| `upstream` | `qwibitai/nanoclaw` | Official upstream |
| `slack` | `qwibitai/nanoclaw-slack` | Slack channel skill |
| `whatsapp` | `qwibitai/nanoclaw-whatsapp` | WhatsApp channel skill |

To pull upstream changes: `git fetch upstream && git merge upstream/main`

## Docker Sandbox Install (macOS)

To install this fork in a Docker AI Sandbox on an Apple Silicon Mac (M1+), with Docker Desktop 4.40+ installed:

```bash
curl -fsSL https://raw.githubusercontent.com/onlyforart/nanoclaw/main/install-docker-sandboxes-fork.sh | bash
```

Type `/setup` when Claude Code starts inside the sandbox.

## What This Fork Adds

### Merged from upstream skill branches

These features are delivered as upstream NanoClaw skill branches and merged into this fork:

- **Slack channel** (merged from `slack` remote)
- **WhatsApp channel** (merged from `whatsapp` remote)
- **Web UI task management** — create, edit, and delete scheduled tasks from the browser; tab persistence via URL hash; flexible "once" schedule dates (merged from `skill/web-ui`)

### Fork-specific additions

These features are unique to this fork:

- **External MCP server support** — domain-specific tools loaded from `data/mcp-servers.json`, mounted into containers at runtime. Supports both stdio and remote HTTP servers.
- **Ollama integration** — local model inference with full MCP tool-calling, plus direct mode that bypasses Claude entirely (see below)
- **Lightweight Anthropic API engine** — third execution path using the raw Messages API instead of the full Agent SDK, reducing token usage ~92% for scheduled tasks. Also available for interactive groups via the `anthropic:` model prefix. See [docs/LIGHTWEIGHT-TASK-ENGINE.md](docs/LIGHTWEIGHT-TASK-ENGINE.md).
- **Per-task and per-group model selection** with configurable tool-round limits and timeouts
- **Per-task timezone support**
- **Credential proxy rate limiting**
- **Agent teams disabled** (to reduce token usage)
- **Dual container slots** — message and task containers run independently per group; tasks never block user messages
- **Task session isolation** — isolated tasks use a separate `.claude-task/` directory, wiped before each run, preventing stale session file accumulation
- **Temperature and context mode** — configurable per-group temperature for Ollama models; editable context mode in the UI
- **Show thinking** — per-group `showThinking` toggle (Ollama only) that relays reasoning/thinking output from reasoning models to the channel as quoted text
- **Token usage tracking** — every task run logs `input_tokens`, `output_tokens`, and `cost_usd` (Claude only) to `task_run_logs`. Both Claude SDK and Ollama paths report token counts. Claude input totals include cache read and creation tokens.
- **MCP call timeout inheritance** — individual MCP tool calls inherit the task/container `timeoutMs` instead of the MCP SDK's 60s default, preventing premature timeouts on long-running tools

## Where Things Live

### Database

The **primary database** is `store/messages.db` (SQLite). This is the only database that matters. It holds:

- `chats` — chat/group metadata
- `messages` — full message history
- `scheduled_tasks` — recurring tasks with cron expressions (includes `use_agent_sdk` to opt specific tasks into the full Agent SDK)
- `task_run_logs` — task execution history (includes `input_tokens`, `output_tokens`, `cost_usd`)
- `router_state` — timestamps and agent state
- `sessions` — session IDs per group
- `registered_groups` — group-to-folder mappings

There is also a `data/nanoclaw.db` — this is **unused/legacy**. Ignore it.

> **Note:** The database schema includes backfill logic for Discord (`dc:`) and Telegram (`tg:`) JID patterns. These come from upstream channel skill branches that this fork has **not** merged and does not plan to merge. The backfill statements are harmless no-ops.

### Session / Auth Data

- `store/auth/` — WhatsApp Baileys authentication files (session keys, app-state-sync files)
- `store/auth-status.txt` — last known auth status
- `store/pairing-code.txt` — QR/pairing code for WhatsApp linking

### Logs

- `logs/nanoclaw.log` — main application log (pino-pretty format)
- `logs/nanoclaw.error.log` — error-level entries only
- `logs/setup.log` — output from `/setup` skill runs

Log level is controlled by the `LOG_LEVEL` environment variable (default: `info`).

### Container Session Logs

Each container run writes a log file to the group's own `logs/` directory:

```
groups/{name}/logs/container-{ISO-timestamp}.log
```

For example: `groups/slack_main/logs/container-2026-03-15T14-43-06-227Z.log`

Each log file contains:

- **Always:** timestamp, group name, duration, exit code, mount list, input summary
- **On error or when `LOG_LEVEL=debug`:** full stdin, stdout, stderr, and container args

These are the primary place to look when debugging a specific agent invocation. Find the relevant group folder and sort by timestamp to locate the run you care about.

### Per-Session Runtime State

Each group's container session generates runtime state under `data/sessions/{groupName}/`. Message and task containers use separate subdirectories to prevent race conditions:

```
data/sessions/{groupName}/
├── message-run/             # Message container state
│   ├── agent-runner-src/    # Agent-runner source (recompiled on startup)
│   ├── mcp-servers/         # Container-side MCP config
│   └── .claude/             # Claude SDK sessions (preserved for continuity)
└── task-run/                # Task container state (wiped before each isolated run)
    ├── agent-runner-src/
    ├── mcp-servers/
    └── .claude/
```

> **Important:** `agent-runner-src/` is only created once per group and never auto-updated. After changing any code in `container/agent-runner/src/`, you **must** delete the stale copies or they will shadow your changes:
>
> ```bash
> rm -rf data/sessions/*/task-run/agent-runner-src data/sessions/*/message-run/agent-runner-src/
> ```
>
> Then restart nanoclaw. The fresh source will be copied on the next container spawn.

### IPC (Inter-Process Communication)

Containers communicate with the host via atomic JSON files in `data/ipc/`:

```
data/ipc/
├── {groupFolder}/
│   ├── ollama_status.json       # Ollama activity status (if running)
│   ├── current_tasks.json       # Active tasks
│   └── available_groups.json    # Known chats/groups
├── messages/                    # Outbound messages (container → host)
├── tasks/                       # Task results (container → host)
└── input/                       # Follow-up input (host → container)
```

### Groups

Each group has an isolated workspace under `groups/{name}/`:

```
groups/
├── global/
│   ├── CLAUDE.md           # Shared memory for all groups (Claude backend)
│   └── OLLAMA.md           # Shared memory for all groups (Ollama backend, optional)
├── main/CLAUDE.md          # Admin / main channel
├── slack_main/CLAUDE.md    # Slack channel group
└── whatsapp_main/
    ├── CLAUDE.md           # WhatsApp group memory (Claude backend)
    └── OLLAMA.md           # WhatsApp group memory (Ollama backend, optional)
```

Group folders are mounted read-write into the container at `/workspace/group/`. The project root is mounted read-only at `/workspace/project/`. The global folder is mounted read-only at `/workspace/global/`.

**Ollama memory files:** When a group uses Ollama direct mode, the agent runner reads `OLLAMA.md` for its system prompt. If no `OLLAMA.md` exists, it falls back to `CLAUDE.md`. This allows groups to have different instructions per backend. The root-level `CLAUDE.md` is for Claude Code (this CLI tool) and is never read by either agent backend.

### Environment and Secrets

- `.env` — all secrets and configuration (not committed, see `.env.example` for the template)
- Secrets are **never** loaded into `process.env` — `src/env.ts` reads them on demand
- Containers never see API keys directly; the **credential proxy** (`src/credential-proxy.ts`) handles authenticated API calls on their behalf

## Ollama Integration

Ollama models can be used in two modes:

1. **Delegated mode** — Claude invokes Ollama via MCP tools (`ollama_chat`). Claude is still the primary agent; Ollama runs as a sub-tool.
2. **Direct mode** — Ollama runs as the primary agent, bypassing the Claude SDK entirely. No Anthropic API calls are made.

### Model String Convention

The `model` field on groups and tasks selects the backend:

| Model string | Backend | Example |
|--------------|---------|---------|
| `haiku`, `sonnet`, `opus` | Claude Agent SDK | `sonnet` |
| `claude:modelname` | Claude Agent SDK (explicit) | `claude:sonnet` |
| `anthropic:modelname` | Anthropic API (lightweight) | `anthropic:haiku` |
| `ollama:modelname` | Ollama direct (local) | `ollama:qwen3` |
| `ollama-remote:modelname` | Ollama direct (remote) | `ollama-remote:mistral` |

Set via IPC: `@Andy set this group to use ollama:qwen3`

Model names are resolved against installed models at runtime — short names like `mistral` or `qwen3` will match installed variants like `mistral-small3.2:latest` or `qwen3:14b` (exact match preferred, then prefix match).

### Delegated Mode (Ollama under Claude)

```
Claude Agent (in container)
  └─ calls ollama_chat / ollama_list_models via MCP
       └─ ollama-mcp-stdio.ts (MCP server, runs inside container)
            ├─ Reads /workspace/mcp-servers-config/config.json
            ├─ Converts MCP tool schemas to Ollama tool format
            ├─ Sends chat request to Ollama with tools attached
            ├─ Handles tool-call loop (Ollama calls tool → result → Ollama)
            └─ Returns final text response (or tool calls for Claude to execute)
```

### Direct Mode (Ollama as primary agent)

```
Agent Runner (in container) — three-way routing:
  ├─ ollama: / ollama-remote: prefix → Ollama engine
  │   ├─ Skips Claude SDK (no Anthropic API calls)
  │   ├─ Builds system prompt from OLLAMA.md (or CLAUDE.md fallback)
  │   └─ Runs ollama-chat-engine loop with tool calling
  ├─ anthropic: prefix or (scheduled task && !useAgentSdk) → Anthropic API engine
  │   ├─ Uses raw Messages API (minimal system prompt, MCP tools only)
  │   ├─ Builds system prompt from CLAUDE.md only
  │   └─ Runs anthropic-api-engine loop with session continuity
  └─ else (bare model name or claude: prefix) → Claude Agent SDK
```

In direct mode:
- No Anthropic credentials are passed to the container
- No persistent sessions (each invocation is a fresh conversation)
- Shorter default timeouts (5 min vs 30 min for Claude)
- `OLLAMA.md` files are used for system prompt (falling back to `CLAUDE.md`)
- Streaming mode is used for Ollama API calls (avoids Node's 300s HTTP headers timeout for slow CPU inference)
- `OLLAMA_HOST` and `OLLAMA_REMOTE_HOST` env vars are forwarded to the container

### Key Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/ollama-chat-engine.ts` | Core chat loop with tool calling for direct mode |
| `container/agent-runner/src/mcp-tool-executor.ts` | MCP client that spawns server processes for direct mode |
| `container/agent-runner/src/ollama-system-prompt.ts` | System prompt builder (reads OLLAMA.md / CLAUDE.md) |
| `container/agent-runner/src/ollama-mcp-stdio.ts` | MCP server for delegated mode (`ollama_chat` tool) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Stdio MCP server for NanoClaw IPC (messages, tasks, groups) |
| `container/agent-runner/src/mcp-config.ts` | Converts container-side MCP config to Claude SDK format |
| `container/agent-runner/src/mcp-http-bridge.ts` | Stdio-to-HTTP proxy so Claude SDK can use remote MCP servers |
| `src/connection-profiles.ts` | Model string parsing and backend-specific defaults |
| `src/remote-mcp.ts` | Host-side remote MCP server discovery and URL rewriting |
| `data/backend-defaults.json` | Installation-specific default limits per backend |
| `docs/OLLAMA-DIRECT-MODE.md` | Design spec for direct mode |
| `docs/OLLAMA-MCP-INTEGRATION.md` | Design spec for delegated mode |
| `data/mcp-servers.json` | Host-side MCP server definitions (tools, paths, env vars) |

### Configuration

- `OLLAMA_HOST` in `.env` — local Ollama server URL (default: `http://host.docker.internal:11434`)
- `OLLAMA_REMOTE_HOST` in `.env` — remote Ollama server URL (for `ollama-remote:` prefix)
- `data/backend-defaults.json` — per-backend default limits (copy from `data/backend-defaults.json.example` and customise)
- MCP servers are defined in `data/mcp-servers.json` with their host paths, commands, tool lists, and optional skill files
- At container launch, `src/container-runner.ts` resolves host paths into container-side config and mounts MCP server directories read-only

### Configurable Limits

Limits can be set at three levels (most specific wins):

1. **Per-task** — `maxToolRounds` and `timeoutMs` on individual scheduled tasks
2. **Per-group** — `maxToolRounds` and `timeoutMs` on registered groups
3. **Per-backend** — `data/backend-defaults.json` (installation-specific)
4. **Hardcoded** — built-in fallbacks

Example `data/backend-defaults.json`:

```json
{
  "claude": {
    "maxToolRounds": 0,
    "timeoutMs": 1800000
  },
  "ollama": {
    "maxToolRounds": 10,
    "timeoutMs": 300000
  },
  "anthropic-api": {
    "maxToolRounds": 15,
    "timeoutMs": 300000
  }
}
```

`maxToolRounds: 0` means unlimited (SDK manages). For Ollama, the default is 10 rounds. For the Anthropic API engine, the default is 15 rounds.

### MCP Tool Call Timeout

Individual MCP tool calls inherit the task or container `timeoutMs` rather than the MCP SDK's default 60s. This prevents long-running tools (e.g. PagePilot scripts with 60s+ observation periods) from being killed prematurely. The timeout flows from `data/backend-defaults.json` → per-group/task override → container input → MCP executor.

### Token Usage Tracking

Every task run records token usage in `task_run_logs`:

- `input_tokens` — total input tokens (for Claude: includes cache read + cache creation tokens)
- `output_tokens` — output tokens generated
- `cost_usd` — API cost (Claude only; null for Ollama)

Both the Claude Agent SDK and Ollama direct mode paths report token counts. The Claude SDK's `total_cost_usd` is captured directly from the API response.

```sql
-- Daily token usage and cost by task
SELECT t.id, date(r.run_at) as day,
  sum(r.input_tokens) as total_in, sum(r.output_tokens) as total_out,
  round(sum(r.cost_usd), 4) as total_cost, count(*) as runs
FROM task_run_logs r JOIN scheduled_tasks t ON r.task_id = t.id
WHERE r.run_at >= date('now', '-7 days')
GROUP BY t.id, day ORDER BY day DESC, total_cost DESC;
```

### Limits (legacy defaults)

- Max 10 tool-calling rounds per Ollama invocation (configurable)
- 5-minute timeout per Ollama invocation (configurable)
- 30-minute timeout per Claude invocation (configurable)
- Status written to `data/ipc/{group}/ollama_status.json` in real time

## Anthropic API Engine (Lightweight)

A third execution path that uses the raw Anthropic Messages API (`@anthropic-ai/sdk`) instead of the full Claude Agent SDK. This eliminates ~50K tokens of system prompt overhead per call, reducing costs ~92% for scheduled tasks.

### When it's used

1. **Scheduled tasks** — all scheduled tasks use the lightweight engine by default (unless `useAgentSdk` is set to true on the task)
2. **Interactive groups with `anthropic:` prefix** — groups configured with a model like `anthropic:haiku` use the lightweight engine for all messages

### What it provides

- Minimal system prompt (from `CLAUDE.md` only, no SDK bloat)
- MCP tool calling (same tools as Ollama path)
- Session continuity for interactive groups (conversation history carried across IPC iterations)
- Auto-compaction at 75% of model context window
- Interactive `/compact` command
- Stuck loop detection (same algorithm as Ollama engine)
- Lazy skill injection (system prompt grows as tools from new servers are called)
- Token usage tracking (input, output, cache read, cache creation)

### What it does NOT provide

- No built-in tools (no Bash, Read, Write, Edit, Glob, Grep, etc.)
- No web search or web fetch
- No file system access
- No agent teams / subagents

Tasks that need these capabilities should set `useAgentSdk: true`.

### Key files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/anthropic-api-engine.ts` | Core chat loop with tool calling |
| `container/agent-runner/src/task-system-prompt.ts` | System prompt builder (CLAUDE.md only) |
| `src/connection-profiles.ts` | `anthropic:` prefix routing, `anthropic-api` backend defaults |
| `docs/LIGHTWEIGHT-TASK-ENGINE.md` | Full design spec |

### Per-task SDK override

The `useAgentSdk` boolean on scheduled tasks (default `false`) controls which engine runs:

- `false` (default) — lightweight Anthropic API engine
- `true` — full Claude Agent SDK with all built-in tools

Set via IPC chat: include `use_agent_sdk: true` when creating or updating a task. Also configurable in the web UI as the "Use full Agent SDK" checkbox.

## External MCP Servers

Domain-specific tools are defined in `data/mcp-servers.json`. Two types are supported:

**Stdio servers** (mounted into the container):

```json
{
  "hostPath": "/path/to/server",
  "command": "node",
  "args": ["build/index.js"],
  "tools": ["tool_name_1", "tool_name_2"],
  "env": ["ENV_VAR_1"],
  "skill": "SKILL.md"
}
```

- `hostPath` is resolved at container launch time — the server directory is mounted read-only into the container
- `env` lists environment variable names to forward from `.env` (values are never hardcoded)
- `skill` points to an instruction file (relative to the server directory) that gets injected into the Ollama context on first use
- `awsAuth: true` enables AWS credential forwarding via the credential proxy

**Remote HTTP servers** (accessed over the network):

```json
{
  "type": "remote",
  "url": "http://host:3201/mcp",
  "tools": ["tool_name_1"],
  "headers": { "Authorization": "Bearer ..." }
}
```

Remote servers run on the host (or elsewhere on the network). At container launch, `src/container-runner.ts` discovers tool schemas from the remote URL and rewrites the URL so the container can reach it via the Docker bridge gateway. For the Claude SDK path, `mcp-http-bridge.ts` wraps the HTTP transport as a stdio process (because the SDK's native HTTP MCP transport silently hangs). The Ollama direct mode path uses `StreamableHTTPClientTransport` in-process.

The container-side config (generated at `data/sessions/{group}/mcp-servers/config.json`) strips `hostPath` and pre-resolves environment variables.

## PagePilot Shared Script Library

[PagePilot](https://github.com/onlyforart/pagepilot) is one of the external MCP servers (registered in `data/mcp-servers.json`). It compiles a small DSL into Playwright-based ES modules for web scraping and monitoring. NanoClaw exposes its scripts to in-container agents through a **two-layer registry**:

| Layer | Mount path | Mode | Backed by |
|---|---|---|---|
| **Writable (per-group)** | `/workspace/group/.pagepilot` | rw | `groups/{name}/.pagepilot/` on the host |
| **Shared (read-only fallback)** | `/workspace/shared-pagepilot` | ro | `groups/.pagepilot/` on the host (typically a symlink to a private archive) |

The in-container PagePilot MCP server reads two env vars set in `.env`:

```sh
PAGEPILOT_STORE=/workspace/group/.pagepilot                # writable layer
PAGEPILOT_STORE_SHARED=/workspace/shared-pagepilot         # colon-separated read-only fallbacks
```

### Lookup semantics

PagePilot's `Registry` walks the writable layer first, then each shared layer in order, and returns the first match. So:

- `pp_get` and `pp_run` against any group find a script even if it only exists in the shared library
- `pp_compile` always writes to the **per-group** writable layer — no group can mutate the shared library through MCP tools
- `pp_update` against a shared-only script refuses unless `overwrite: true` is passed (which forks the script down into the writable layer first)
- `pp_delete` refuses to remove shared scripts entirely

Run history (`runs/`) lives only in the writable layer — execution logs are per-group, never shared.

### Hosting the shared library

`groups/.pagepilot/` is gitignored so it can be backed by anything you like — a normal directory of test scripts, a checkout of a private repo, or a symlink to a private workspace sibling. Mount the directory and PagePilot will pick it up; you don't need to restart NanoClaw unless you change the env vars or container-runner mount config.

The conventional layout for a private archive is a sibling of `nanoclaw/` in the workspace, symlinked into place:

```
~/nanoclaw-workspace/
├── nanoclaw/
│   └── groups/
│       └── .pagepilot → ../../<private-archive-dir>      (gitignored symlink)
└── <private-archive-dir>/
    ├── .git/
    └── scripts/
        └── <script-name>/
            ├── source.pp
            ├── compiled.mjs
            └── meta.json
```

Replace `<private-archive-dir>` with whatever you've named your private repo. The relative symlink target keeps the path stable across different host home directories.

### Authoring new scripts

Use the PagePilot **explorer** MCP server (`pagepilot-explorer`, also wired into NanoClaw) to inspect a page from a coding agent before writing the `.pp` source. Tools include `explore_snapshot`, `explore_frames`, `explore_eval`, and `explore_watch` (temporal observation for "is this data flowing"). Once you've worked out selectors:

1. Write `source.pp` in `<archive>/scripts/<name>/`
2. `pagepilot check <file>` — validate
3. `pagepilot compile <file> -o <dir>/compiled.mjs` — compile
4. Update `<dir>/meta.json` (name, description, tags, sha256 of source)
5. Commit to the private archive

The script is then immediately available to every group via `pp_run name="<name>"`.

## Container System

Every agent invocation spawns an isolated container:

- **Image:** `nanoclaw-agent:latest` (built with `./container/build.sh`)
- **Runtime:** Docker or Podman on Linux, Docker Sandboxes or Apple Container on macOS
- **Timeout:** 30 minutes (configurable via `CONTAINER_TIMEOUT`)
- **Concurrency:** max 5 simultaneous containers (configurable via `MAX_CONCURRENT_CONTAINERS`)
- **Security:** non-root user, read-only project mount, credential proxy for API access

### Dual container slots

Each group has two independent container slots:

- **Message slot** — for user-initiated messages; uses `message-run/` for all per-container state, with `.claude/` preserved across runs for session continuity
- **Task slot** — for scheduled tasks; uses `task-run/` for all per-container state, wiped entirely before each isolated task run to guarantee clean state

Message and task containers run **concurrently** — a scheduled task never blocks a user message, and vice versa. Both count toward the global `MAX_CONCURRENT_CONTAINERS` limit. Tasks queue behind other tasks; messages queue behind other messages.

### Concurrency invariant — one task container per group

**IMPORTANT:** The current design assumes at most **one task container per group** at any time. The `task-run/` directory is shared by all task runs for a group and is wiped (`rm -rf`) before each isolated run. This is safe only because the `GroupQueue` serialises task execution per group — the next task cannot start until the previous task's container has fully exited.

If concurrent task containers per group are ever needed, the `task-run/` directory model must be replaced with **per-run unique directories** (e.g. `task-run-{taskId}-{timestamp}/`) with cleanup after the container exits rather than before the next one starts. Without this change, concurrent tasks would wipe each other's mounted directories mid-execution.

### Stale Build Cache

After rebuilding the container image, always delete stale `agent-runner-src` copies:

```bash
rm -rf data/sessions/*/task-run/agent-runner-src data/sessions/*/message-run/agent-runner-src
```

Then restart the service. Otherwise containers may run old code.

## Service Management (Linux)

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

The `XDG_RUNTIME_DIR` export is required in non-login shells (e.g., when running from Claude Code's bash environment).

## Web UI

A lightweight web-based management interface, delivered as a skill branch (`skill/web-ui`) and merged into this fork. The full spec and implementation plan are in [docs/WEB-UI.md](docs/WEB-UI.md). The overall container and credential security model is documented in [docs/SECURITY.md](docs/SECURITY.md).

### What it does

The web UI lets you view and edit groups, system prompts, scheduled tasks, and live container status from a browser. It is a **separate process** from the main NanoClaw orchestrator — you can start, stop, or restart it without affecting message processing.

| Page | Purpose |
|------|---------|
| Dashboard | Health status, active containers (auto-refreshes), all groups |
| Global Prompts | Edit `groups/global/CLAUDE.md` and `OLLAMA.md` |
| Group Detail | Settings (model, limits, temperature), prompt editor, task list, task creation |
| Task Detail | Prompt editor, schedule/model/timezone/context-mode settings, run history, deletion |

The UI is read/write for configuration (prompts, model selection, task schedules) but **view-only for containers** — it cannot start or stop agent containers.

### Architecture

```
┌──────────────┐  mTLS  ┌──────────────────────┐
│   Browser    │───────▶│  nanoclaw-webui       │
│  (+ client   │◀───────│  (Node.js, port 3100) │
│   cert)      │        └──────────┬───────────┘
└──────────────┘                   │
                     ┌─────────────┼─────────────┐
                     │             │             │
               ┌─────▼─────┐ ┌────▼────┐ ┌──────▼──────┐
               │  SQLite    │ │  Files  │ │  Docker CLI │
               │ messages.db│ │ groups/ │ │  docker ps  │
               └───────────┘ └─────────┘ └─────────────┘

Completely separate from the main orchestrator process.
Shares the same SQLite DB and groups/ filesystem.
```

The web UI reads and writes the same `store/messages.db` database and `groups/` filesystem as the orchestrator. SQLite WAL mode handles concurrent access; the UI sets a 5-second busy timeout to handle brief write contention gracefully.

### Security model

The web UI uses **mutual TLS (mTLS)** — both the server and the client must present certificates signed by the same private CA. This is the sole authentication mechanism, and it operates at the TLS layer, below HTTP.

**What this means in practice:**

- **Connections without a valid client certificate are rejected at the TLS handshake.** No HTTP request is ever processed, no error page is served, no endpoint is reachable. The browser simply fails to connect.
- **Safe to expose on LAN or WAN.** Security does not depend on localhost binding or network firewalls. Only devices with an issued client certificate can connect, regardless of network exposure. (The default bind address is `127.0.0.1`; set `WEBUI_BIND=0.0.0.0` to listen on all interfaces.)
- **No passwords, no API keys, no session tokens.** Authentication is handled entirely by the TLS handshake. There are no login forms, no bearer tokens, and no cookies to steal.
- **CSRF is blocked by two independent layers.** The server sets no `Access-Control-Allow-Origin` header, so browsers send a CORS preflight for non-simple methods (`PATCH`, `PUT`). The preflight itself must complete a TLS handshake requiring the client certificate — which browsers won't attach to cross-origin preflights. Even if a future browser bug bypassed this, the mTLS requirement still blocks the request.

**What the web UI never sees:**

- API keys (Anthropic, OpenAI, Slack, etc.)
- OAuth tokens or WhatsApp session credentials
- The credential proxy or any container secrets
- The `.env` file (except for `WEBUI_*` and `ASSISTANT_NAME` variables)

The web UI has no mechanism to read, forward, or leak credentials, because it simply does not load them.

**Additional hardening:**

| Protection | Detail |
|------------|--------|
| Private key permissions | All auto-generated keys are mode `0600`; startup warns on overly permissive files |
| Path traversal (API) | Group folder names validated via `isValidGroupFolder()` regex before any file I/O |
| Path traversal (static) | `path.resolve()` + `startsWith()` check against the `public/` root |
| Request body limit | 1 MB maximum; larger payloads receive `413 Payload Too Large` |
| SQL injection | All queries use parameterized statements |
| No container control | View-only for running containers; cannot start, stop, or exec into them |
| No message history | Messages contain personal data and are not exposed through the UI |

### Certificate management

On first startup, the server auto-generates a complete PKI under `data/tls/`:

```
data/tls/
├── ca-cert.pem            # Self-signed CA (10-year lifetime)
├── ca-key.pem             # CA private key (mode 0600)
├── server-cert.pem        # Server cert, signed by CA (1 year, auto-renews)
├── server-key.pem         # Server private key (mode 0600)
└── clients/
    ├── default-cert.pem   # Default client cert (1 year)
    ├── default-key.pem    # Client private key
    ├── default.p12        # PKCS#12 for Linux/Firefox (password: nanoclaw)
    └── default-nopass.p12 # PKCS#12 for macOS (empty password)
```

The server certificate includes SANs for `localhost`, `127.0.0.1`, the machine hostname, and all non-loopback IPv4 addresses (for LAN access). Server certs auto-renew on expiry without affecting client trust. Users can supply their own certificates via `WEBUI_TLS_CA`, `WEBUI_TLS_CERT`, and `WEBUI_TLS_KEY` environment variables.

To add a client certificate for a new device:

```bash
./webui/scripts/add-client.sh phone
# → data/tls/clients/phone.p12 (password: nanoclaw)
# → data/tls/clients/phone-nopass.p12 (macOS)
```

### Key files

| File | Purpose |
|------|---------|
| `webui/start.ts` | Entry point: reads config, loads mTLS, starts server |
| `webui/server.ts` | HTTPS server, route dispatch, static file serving |
| `webui/tls.ts` | Certificate generation, renewal, validation |
| `webui/router.ts` | Hand-rolled path matching, JSON body parser (~150 LOC) |
| `webui/db.ts` | SQLite access (groups, tasks, task runs) |
| `webui/routes/` | Route handlers (groups, prompts, tasks, containers) |
| `webui/public/` | Vue 3 + TailwindCSS frontend (CDN, no build step) |
| `webui/scripts/` | `add-client.sh`, `install-service.sh`, `uninstall-service.sh` |
| `docs/WEB-UI.md` | Full specification and implementation plan |
| `docs/SECURITY.md` | Overall NanoClaw security model |

### Running the web UI

```bash
npm run build:webui   # Compile TypeScript + copy frontend assets
npm run webui:dev     # Development with hot reload (tsx)
node dist/webui/start.js  # Production

# Service management (Linux)
./webui/scripts/install-service.sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user start nanoclaw-webui
```

### Technology choices

- **No new npm dependencies.** Uses Node built-ins (`https`, `fs`, `crypto`, `child_process`), plus `better-sqlite3`, `cron-parser`, and `pino` (already installed).
- **No framework.** Hand-rolled router (~150 LOC) instead of Express. The API surface is small (7 route patterns).
- **No frontend build step.** Vue 3 and TailwindCSS loaded from CDN. The frontend is vanilla HTML/CSS/JS.

## Troubleshooting

### Ollama direct mode: `fetch failed` / `ECONNREFUSED`

If an Ollama direct mode invocation fails immediately with `ECONNREFUSED 172.17.0.1:11434` or `fetch failed`, Ollama is not running. The container resolves `host.docker.internal` to the Docker bridge IP, so if Ollama isn't listening, the connection is refused.

```bash
# Check status
systemctl status ollama

# Start it (requires sudo — it's a system service, not a user service)
sudo systemctl start ollama
```

Ollama does not auto-restart after being stopped. After any host reboot or manual stop, you must start it again before using `ollama:` model prefixes.
