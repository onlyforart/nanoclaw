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
- **Ollama integration** — local model inference with full MCP tool-calling (see below)
- **Per-task and per-group model selection**
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
├── global/CLAUDE.md       # Shared memory for all groups
├── main/CLAUDE.md         # Admin / main channel
├── slack_main/CLAUDE.md   # Slack channel group
└── whatsapp_main/CLAUDE.md # WhatsApp channel group
```

Group folders are mounted read-write into the container at `/workspace/group/`. The project root is mounted read-only at `/workspace/project/`. The global folder is mounted read-only at `/workspace/global/`.

### Environment and Secrets

- `.env` — all secrets and configuration (not committed, see `.env.example` for the template)
- Secrets are **never** loaded into `process.env` — `src/env.ts` reads them on demand
- Containers never see API keys directly; the **credential proxy** (`src/credential-proxy.ts`) handles authenticated API calls on their behalf

## Ollama Integration

The Ollama connector lets local models (running via [Ollama](https://ollama.com)) use the same MCP tools available to the Claude agent. This is useful for scheduled tasks that can run cheaply on a local model instead of calling the Anthropic API.

### How It Works

```
Claude Agent (in container)
  └─ calls ollama_chat / ollama_list_models via MCP
       └─ ollama-mcp-stdio.ts (MCP server, runs inside container)
            ├─ Reads /workspace/mcp-servers-config/config.json
            ├─ Connects to each configured MCP server as a client
            ├─ Converts MCP tool schemas to Ollama tool format
            ├─ Sends chat request to Ollama with tools attached
            ├─ Handles tool-call loop (Ollama calls tool → result → Ollama)
            └─ Returns final text response (or tool calls for Claude to execute)
```

### Key Files

| File | Purpose |
|------|---------|
| `container/agent-runner/src/ollama-mcp-stdio.ts` | MCP server exposing `ollama_chat` and `ollama_list_models` |
| `docs/OLLAMA-MCP-INTEGRATION.md` | Full design spec and architecture decisions |
| `scripts/ollama-watch.sh` | Desktop notification watcher for Ollama activity (macOS) |
| `data/mcp-servers.json` | Host-side MCP server definitions (tools, paths, env vars) |

### Configuration

- `OLLAMA_HOST` in `.env` controls the Ollama server URL (default: `http://host.docker.internal:11434` so containers can reach the host)
- MCP servers are defined in `data/mcp-servers.json` with their host paths, commands, tool lists, and optional skill files
- At container launch, `src/container-runner.ts` resolves host paths into container-side config and mounts MCP server directories read-only

### Limits

- Max 10 tool-calling rounds per `ollama_chat` invocation
- 5-minute total timeout per invocation
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
