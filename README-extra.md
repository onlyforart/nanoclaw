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
- **Reset scripts** — YAML-defined multi-step restart procedures in `data/reset-scripts/`, executed via the `run_reset_script` MCP tool. Handles ordering, readiness waits, and failure recovery.
- **Ollama integration** — local model inference with full MCP tool-calling, plus direct mode that bypasses Claude entirely (see below)
- **Per-task and per-group model selection** with configurable tool-round limits and timeouts
- **Per-task timezone support**
- **Credential proxy rate limiting**
- **Agent teams disabled** (to reduce token usage)
- **Dual container slots** — message and task containers run independently per group; tasks never block user messages
- **Task session isolation** — isolated tasks use a separate `.claude-task/` directory, wiped before each run, preventing stale session file accumulation
- **Temperature and context mode** — configurable per-group temperature for Ollama models; editable context mode in the UI

## Where Things Live

### Database

The **primary database** is `store/messages.db` (SQLite). This is the only database that matters. It holds:

- `chats` — chat/group metadata
- `messages` — full message history
- `scheduled_tasks` — recurring tasks with cron expressions
- `task_run_logs` — task execution history
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

Each group's container session generates runtime state under `data/sessions/{groupName}/`:

- `agent-runner-src/` — per-group copy of the agent-runner TypeScript source, recompiled on each container startup
- `mcp-servers/config.json` — container-side MCP server configuration (pre-resolved paths, no host paths)
- `.claude/` — Claude Code project state and backups

> **Important:** `agent-runner-src/` is only created once per group and never auto-updated. After changing any code in `container/agent-runner/src/`, you **must** delete the stale copies or they will shadow your changes:
>
> ```bash
> rm -rf data/sessions/*/agent-runner-src/
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
| `haiku`, `sonnet`, `opus` | Claude (existing) | `sonnet` |
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
Agent Runner (in container)
  ├─ Detects ollama: or ollama-remote: model prefix
  ├─ Skips Claude SDK entirely (no Anthropic API calls)
  ├─ Spawns MCP server processes (nanoclaw IPC, external servers)
  ├─ Builds system prompt from OLLAMA.md (or CLAUDE.md fallback)
  ├─ Runs ollama-chat-engine loop with tool calling
  └─ Outputs results in same format as Claude path
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
| `src/connection-profiles.ts` | Model string parsing and backend-specific defaults |
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
  }
}
```

`maxToolRounds: 0` means unlimited (SDK manages). For Ollama, the default is 10 rounds.

### Limits (legacy defaults)

- Max 10 tool-calling rounds per Ollama invocation (configurable)
- 5-minute timeout per Ollama invocation (configurable)
- 30-minute timeout per Claude invocation (configurable)
- Status written to `data/ipc/{group}/ollama_status.json` in real time

## External MCP Servers

Domain-specific tools are defined in `data/mcp-servers.json`. Each entry specifies:

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

The container-side config (generated at `data/sessions/{group}/mcp-servers/config.json`) strips `hostPath` and pre-resolves environment variables.

## Reset Scripts

Multi-step restart procedures are defined as YAML files in `data/reset-scripts/`, organised by cluster:

```
data/reset-scripts/
├── staging/
│   ├── perps-mdv.yaml
│   └── md-perps.yaml
├── prod1/
│   ├── perps-mdv.yaml
│   └── md-perpld.yaml
└── prod2/
    └── md-perpld.yaml
```

These scripts are loaded by the `eks-kubectl` MCP server at startup (via the `RESET_SCRIPTS_DIR` environment variable on the `eks-kubectl-mcp` systemd unit). They provide `list_reset_scripts` and `run_reset_script` tools that handle restart ordering, readiness waits, and failure recovery in a single tool call.

Scripts use the [k8s-restart-scripts](../reset-language/) YAML format. The cluster is inferred from the directory name (e.g. `staging/` → cluster `staging`).

## Container System

Every agent invocation spawns an isolated container:

- **Image:** `nanoclaw-agent:latest` (built with `./container/build.sh`)
- **Runtime:** Docker or Podman on Linux, Docker Sandboxes or Apple Container on macOS
- **Timeout:** 30 minutes (configurable via `CONTAINER_TIMEOUT`)
- **Concurrency:** max 5 simultaneous containers (configurable via `MAX_CONCURRENT_CONTAINERS`)
- **Security:** non-root user, read-only project mount, credential proxy for API access

### Dual container slots

Each group has two independent container slots:

- **Message slot** — for user-initiated messages; uses `.claude/` for session continuity across conversations
- **Task slot** — for scheduled tasks; uses `.claude-task/` which is wiped before each isolated task run

Message and task containers run **concurrently** — a scheduled task never blocks a user message, and vice versa. Both count toward the global `MAX_CONCURRENT_CONTAINERS` limit. Tasks queue behind other tasks; messages queue behind other messages.

### Stale Build Cache

After rebuilding the container image, always delete stale `agent-runner-src` copies:

```bash
rm -rf data/sessions/*/agent-runner-src
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
