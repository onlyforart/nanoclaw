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

## What This Fork Adds

Compared to upstream `main`, this fork includes:

- **Slack channel** (merged from `slack` remote)
- **WhatsApp channel** (merged from `whatsapp` remote)
- **External MCP server support** — domain-specific tools loaded from `data/mcp-servers.json`, mounted into containers at runtime
- **Ollama integration** — local model inference with full MCP tool-calling, plus direct mode that bypasses Claude entirely (see below)
- **Per-task and per-group model selection** with configurable tool-round limits and timeouts
- **Per-task timezone support**
- **Credential proxy rate limiting**
- **Agent teams disabled** (to reduce token usage)

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

- `agent-runner-src/` — compiled TypeScript for that session's container
- `mcp-servers/config.json` — container-side MCP server configuration (pre-resolved paths, no host paths)
- `.claude/` — Claude Code project state and backups

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
| `src/connection-profiles.ts` | Model string parsing and backend-specific defaults |
| `data/backend-defaults.json` | Installation-specific default limits per backend |
| `docs/OLLAMA-DIRECT-MODE.md` | Design spec for direct mode |
| `docs/OLLAMA-MCP-INTEGRATION.md` | Design spec for delegated mode |
| `data/mcp-servers.json` | Host-side MCP server definitions (tools, paths, env vars) |

### Configuration

- `OLLAMA_HOST` in `.env` — local Ollama server URL (default: `http://host.docker.internal:11434`)
- `OLLAMA_REMOTE_HOST` in `.env` — remote Ollama server URL (for `ollama-remote:` prefix)
- `data/backend-defaults.json` — per-backend default limits (see below)
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

## Container System

Every agent invocation spawns an isolated container:

- **Image:** `nanoclaw-agent:latest` (built with `./container/build.sh`)
- **Runtime:** Docker or Podman on Linux, Docker Sandboxes or Apple Container on macOS
- **Timeout:** 30 minutes (configurable via `CONTAINER_TIMEOUT`)
- **Concurrency:** max 5 simultaneous containers (configurable via `MAX_CONCURRENT_CONTAINERS`)
- **Security:** non-root user, read-only project mount, credential proxy for API access

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
