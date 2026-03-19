# NanoClaw Web UI — Specification & Implementation Plan

## Delivery

This feature is delivered as a skill (`/add-web-ui`), not merged into the core codebase. The upstream NanoClaw philosophy is "no monitoring dashboard; ask Claude what's happening" and "don't add features, add skills." A web UI is a fork-level enhancement — useful for users who want it, but not something every NanoClaw installation should carry.

The skill branch (`skill/web-ui`) contains the full implementation. The SKILL.md guides Claude Code to merge the branch, build the web UI, generate TLS certificates, and install the service unit. Users who don't run `/add-web-ui` are unaffected — no build cost, no extra files in `dist/`, no changes to the core orchestrator.

## Overview

A lightweight web-based management interface for NanoClaw. Runs as a standalone Node.js process (separate from the main NanoClaw orchestrator) serving a REST API and static frontend over HTTPS with mutual TLS (mTLS) authentication. Provides read/write access to groups, system prompts, scheduled tasks, and live container status.

## Goals

1. View and edit the global system prompt (`groups/global/CLAUDE.md`)
2. List all registered groups (including the main group)
3. Per-group: view/edit the group's system prompts (`CLAUDE.md`, `OLLAMA.md`)
4. Per-group: list scheduled tasks
5. Per-task: view/edit the prompt and settings (schedule, model, timezone, limits, status)
6. View currently active containers
7. Configurable HTTPS port and bind address
8. Mutual TLS (mTLS) with auto-generated private CA, server cert, and client certs
9. Systemd unit for independent start/stop (plus launchd on macOS, nohup fallback)
10. Safe to expose on LAN or WAN — connections without a valid client certificate are rejected at the TLS handshake

## Non-Goals

- No real-time WebSocket push (polling is sufficient for this scale)
- No message history viewer (messages contain personal data; out of scope)
- No task creation/deletion (keep initial scope to viewing and editing existing entities)
- No modification of `.env` or secrets

## Architecture

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
```

The web UI is a **separate process** from the NanoClaw orchestrator. It reads the same SQLite database (read-only for groups/tasks, writes only to `registered_groups` and `scheduled_tasks`) and the same filesystem. This avoids any coupling to the orchestrator's runtime state and means the UI can be started/stopped independently.

### Why a separate process?

- The orchestrator is a tight polling loop. Embedding an HTTP server adds failure modes and complicates shutdown.
- Independent lifecycle: restart the UI without affecting message processing.
- Different security posture: the UI never touches API keys or the credential proxy.

## Configuration

New environment variables in `.env`:

```bash
# Web UI
WEBUI_PORT=3100
WEBUI_BIND=127.0.0.1

# TLS certificate paths (optional — auto-generated if not set)
WEBUI_TLS_CA=
WEBUI_TLS_CERT=
WEBUI_TLS_KEY=
```

The bind address defaults to `127.0.0.1` (localhost only). Set `WEBUI_BIND=0.0.0.0` to expose on all interfaces — this is safe because mTLS rejects connections that don't present a valid client certificate at the TLS handshake, before any HTTP processing occurs.

The web UI process reads these from `.env` via the existing `readEnvFile()` utility. It also reads `ASSISTANT_NAME` for display purposes.

## TLS — Mutual TLS (mTLS)

The web UI uses mutual TLS for both encryption and authentication. The server requires clients to present a certificate signed by the same private CA that signed the server certificate. Connections without a valid client certificate are rejected at the TLS handshake — no HTTP request is ever processed.

This means the web UI is safe to expose on a LAN or the public internet. Only devices with an issued client certificate can connect.

### Certificate hierarchy

On first startup, if no certificates are configured, the server auto-generates a complete PKI:

```
data/tls/
├── ca-cert.pem              # Self-signed CA certificate (10 year lifetime)
├── ca-key.pem               # CA private key (mode 0600)
├── server-cert.pem          # Server certificate, signed by CA (1 year)
├── server-key.pem           # Server private key (mode 0600)
└── clients/
    ├── default-cert.pem     # Default client certificate, signed by CA (1 year)
    ├── default-key.pem      # Default client private key
    └── default.p12          # PKCS#12 bundle for browser import
```

### Certificate generation

All certificates are generated at startup via `child_process.execSync` calling `openssl`.

**Step 1 — Private CA** (once, on first startup):

```bash
# CA private key
openssl genrsa -out data/tls/ca-key.pem 2048

# Self-signed CA certificate (10 years)
openssl req -x509 -new -nodes -key data/tls/ca-key.pem \
  -sha256 -days 3650 -out data/tls/ca-cert.pem \
  -subj "/CN=nanoclaw-ca"
```

**Step 2 — Server certificate** (signed by CA):

```bash
openssl genrsa -out data/tls/server-key.pem 2048

openssl req -new -key data/tls/server-key.pem \
  -subj "/CN=nanoclaw-webui" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:$(hostname)" \
  -out data/tls/server.csr

# -copy_extensions copyall copies the SAN from the CSR into the signed cert.
# This is safe here because we generate the CSR ourselves in the line above.
# Do NOT use copyall to sign externally-submitted CSRs — it would allow the
# submitter to inject arbitrary extensions (e.g. basicConstraints: CA:TRUE).
openssl x509 -req -in data/tls/server.csr \
  -CA data/tls/ca-cert.pem -CAkey data/tls/ca-key.pem -CAcreateserial \
  -days 365 -sha256 \
  -copy_extensions copyall \
  -out data/tls/server-cert.pem

rm data/tls/server.csr
```

The SAN includes `localhost`, `127.0.0.1`, and the machine's hostname (evaluated at generation time via shell expansion) so browsers accept the certificate when accessing by any of these names. **Known limitation**: if the hostname changes after cert generation, the cert won't match the new hostname — delete `data/tls/server-cert.pem` and restart to regenerate. To add custom domains or LAN IPs to the SAN, see the `regen-server-cert.sh` note under Open Questions.

**Step 3 — Default client certificate** (signed by CA):

```bash
openssl genrsa -out data/tls/clients/default-key.pem 2048

openssl req -new -key data/tls/clients/default-key.pem \
  -subj "/CN=default" \
  -out data/tls/clients/default.csr

openssl x509 -req -in data/tls/clients/default.csr \
  -CA data/tls/ca-cert.pem -CAkey data/tls/ca-key.pem -CAcreateserial \
  -days 365 -sha256 \
  -out data/tls/clients/default-cert.pem

# PKCS#12 bundle for browser import.
# -legacy flag is required for compatibility with older browsers and
# macOS Keychain — OpenSSL 3.x changed the default PKCS#12 encryption
# algorithm and some clients can't read the new format.
openssl pkcs12 -export -legacy \
  -out data/tls/clients/default.p12 \
  -inkey data/tls/clients/default-key.pem \
  -in data/tls/clients/default-cert.pem \
  -certfile data/tls/ca-cert.pem \
  -passout pass:nanoclaw

rm data/tls/clients/default.csr
```

The `.p12` bundle is what browsers import. The export password (`nanoclaw`) is required by the PKCS#12 format; the user types it once during import.

### Adding client certificates

Each device (laptop, phone, tablet) gets its own client certificate. A helper script generates them:

```bash
# Run from the project root (the script resolves data/tls/ relative to cwd)
./webui/scripts/add-client.sh <name>
# e.g.: ./webui/scripts/add-client.sh phone
# → data/tls/clients/phone.p12
```

The script is a bash file (not TypeScript), so it lives in the source tree and is not compiled into `dist/`. It must be run from the project root. The script runs the Step 3 commands above with the given name, including the `-legacy` flag for PKCS#12 compatibility. It prints the path to the `.p12` file and the import password. To revoke a client, delete its cert/key files and restart the server (the CA simply won't have signed a replacement; the old cert will continue to work until it expires, but the `tls.ts` module can optionally maintain a CRL file — see Certificate lifecycle below).

### Certificate lifecycle

- **Server cert expiry warning**: the startup script logs a warning if the server certificate expires within 30 days.
- **Server cert auto-renewal**: if the server certificate has expired, the startup script generates a new one signed by the existing CA. Client certificates and browser trust are unaffected — they trust the CA, not the server cert directly.
- **Client cert expiry**: client certificates are valid for 1 year. The `add-client.sh` script can be re-run with the same name to generate a replacement. The old `.p12` must be removed from the browser and the new one imported.
- **CA cert lifetime**: 10 years. The CA cert is the long-lived root of trust. If it expires, all server and client certs must be regenerated.
- **Custom certificates are never auto-renewed** — if `WEBUI_TLS_CA`/`WEBUI_TLS_CERT`/`WEBUI_TLS_KEY` are set and any cert is expired, the server logs an error and refuses to start.
- **Private key permissions**: all auto-generated private keys (`ca-key.pem`, `server-key.pem`, client keys) are written with mode `0600`. The startup script warns if existing key files have overly permissive permissions.

### Custom certificates

Users can provide their own CA, server cert, and server key by setting all three environment variables in `.env`:

```bash
WEBUI_TLS_CA=/path/to/ca-cert.pem
WEBUI_TLS_CERT=/path/to/server-cert.pem
WEBUI_TLS_KEY=/path/to/server-key.pem
```

All three must be set together. The CA is used to verify client certificates. Client certs must be signed by the provided CA.

**Limitation**: the CA serves double duty — it's both the issuer of the server cert (for browser trust) and the trust anchor for verifying client certs. In environments where the server cert comes from a different CA than client certs (e.g., server cert from Let's Encrypt, client certs from an internal CA), a separate `WEBUI_TLS_CLIENT_CA` override would be needed. This is not supported in v1 — custom certs require the same CA for both server and client.

### Browser setup

Two things must be imported into the browser:

1. **CA certificate** (`data/tls/ca-cert.pem`) — so the browser trusts the server certificate without warnings.
   - **Linux/Chrome**: Settings > Privacy and Security > Security > Manage certificates > Authorities > Import
   - **macOS**: Double-click the `.pem`, add to login keychain, then mark as "Always Trust" for SSL
   - **Firefox**: Settings > Privacy & Security > View Certificates > Authorities > Import

2. **Client certificate** (`data/tls/clients/<name>.p12`) — so the browser can authenticate to the server.
   - **Linux/Chrome**: Settings > Privacy and Security > Security > Manage certificates > Your Certificates > Import (password: `nanoclaw`)
   - **macOS**: Double-click the `.p12`, import into login keychain (password: `nanoclaw`)
   - **Firefox**: Settings > Privacy & Security > View Certificates > Your Certificates > Import (password: `nanoclaw`)

After importing both, the browser connects without warnings and the server accepts the connection. The install script prints these instructions on first install.

## Data Access

### SQLite (via `better-sqlite3`)

The web UI opens `store/messages.db` directly (same as the orchestrator). SQLite WAL mode supports multiple concurrent readers and a single writer. However, `better-sqlite3` is synchronous — if the orchestrator is mid-write when the UI attempts a write, the call will block or fail with `SQLITE_BUSY`.

**Busy timeout**: the UI's database connection must set `db.pragma('busy_timeout = 5000')` immediately after opening. This tells SQLite to retry for up to 5 seconds before returning `SQLITE_BUSY`, which is more than enough for the orchestrator's brief writes to complete. Without this, PATCH requests will intermittently 500 and be difficult to debug.

| Operation | Table | Access |
|-----------|-------|--------|
| List groups | `registered_groups` | read |
| Update group settings | `registered_groups` | write (model, max_tool_rounds, timeout_ms) |
| List tasks for group | `scheduled_tasks` | read |
| Get task detail | `scheduled_tasks` | read |
| Update task | `scheduled_tasks` | write (prompt, schedule_type, schedule_value, model, timezone, max_tool_rounds, timeout_ms, status) |
| Recent task runs | `task_run_logs` | read |

**Note on `registered_groups` columns**: this table also has `trigger_pattern`, `container_config`, `requires_trigger`, and `is_main`. The GET endpoints expose `isMain`, `requiresTrigger`, and `trigger` (mapped from `trigger_pattern`). `container_config` is not exposed in v1 — it's a JSON blob for container-level overrides that is better left to the orchestrator.

**Column naming**: the database uses snake_case (`max_tool_rounds`, `timeout_ms`, `schedule_type`, `schedule_value`, `context_mode`). The REST API uses camelCase (`maxToolRounds`, `timeoutMs`, `scheduleType`, `scheduleValue`, `contextMode`). Route handlers map between the two conventions on read and write.

**Note on `context_mode`**: this field is returned in task responses (as `contextMode`) but is intentionally not writable via `PATCH`. Changing context mode on an existing task (from `isolated` to `group` or vice versa) alters session semantics mid-lifecycle and could cause the agent to reference stale or missing session state. If a user needs a different context mode, they should create a new task via the orchestrator.

**Latency of changes**: updates to group settings (`model`, `maxToolRounds`, `timeoutMs`) and task fields are written directly to SQLite. The orchestrator reads these values on each polling cycle or container invocation — changes take effect on the next agent invocation for that group, not retroactively on any currently running container.

### Filesystem

| Operation | Path | Access |
|-----------|------|--------|
| Read/write global prompt | `groups/global/CLAUDE.md` | read/write |
| Read/write global Ollama prompt | `groups/global/OLLAMA.md` | read/write |
| Read/write group prompt | `groups/{folder}/CLAUDE.md` | read/write |
| Read/write group Ollama prompt | `groups/{folder}/OLLAMA.md` | read/write |

All file paths are validated against `groups/` — the folder name is validated by importing `isValidGroupFolder()` from `src/group-folder.ts`, which enforces:
- Regex: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` (starts with alphanumeric, max 64 chars)
- Rejects untrimmed strings, strings containing `/`, `\`, or `..`
- Rejects the reserved folder name `'global'` (which has its own dedicated endpoints)

This prevents path traversal and ensures the folder name maps to a valid directory under `groups/`. All file reads/writes use explicit `'utf-8'` encoding.

**Backup on write**: before overwriting any prompt file, the handler renames the existing file to `{filename}.bak` (e.g., `CLAUDE.md.bak`). Only one backup is kept — the most recent previous version. This provides a simple undo mechanism if a user accidentally blanks a prompt. The backup is a cheap safety net: one `fs.renameSync()` call before the write.

### Docker CLI

Active containers are discovered via `execFile` (async, no shell):

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync('docker',
  ['ps', '--filter', 'name=nanoclaw-', '--format', '{{json .}}'],
  { timeout: 5000 });
```

Using the promisified `execFile` instead of `execSync` avoids blocking the event loop (important if multiple browser tabs are polling) and avoids shell injection by not going through a shell. The container name pattern is `nanoclaw-{safeName}-{epochMs}` (e.g., `nanoclaw-slack-main-1711000000000`), where `safeName` is the group folder with non-alphanumeric characters replaced by hyphens and `epochMs` is `Date.now()`. The group folder is extracted by stripping the `nanoclaw-` prefix and the trailing `-{digits}` suffix. Route handlers that call async operations return a `Promise` — the router awaits handler results before writing the response.

**Known limitation**: if the Docker daemon is under heavy load, `docker ps` may be slow. The `/api/v1/containers` endpoint uses a 5-second timeout on the `execFile` call and returns an empty array with a warning header if it times out.

## REST API

Base path: `/api/v1`

All endpoints accept and return `application/json`. Request bodies are limited to **1 MB** to prevent memory exhaustion from accidental or malicious large payloads. Requests exceeding this limit receive `413 Payload Too Large`.

### Groups

```
GET  /api/v1/groups
  → [{ jid, name, folder, model, maxToolRounds, timeoutMs, isMain, requiresTrigger, trigger }]

GET  /api/v1/groups/:folder
  → { jid, name, folder, model, maxToolRounds, timeoutMs, isMain, requiresTrigger, trigger }

PATCH /api/v1/groups/:folder
  Body: { model?, maxToolRounds?, timeoutMs? }
  → updated group object
  Note: changes take effect on the group's next agent invocation, not retroactively.
```

### Prompts

```
GET  /api/v1/prompts/global
  → { claude: string, ollama: string | null }

PUT  /api/v1/prompts/global
  Body: { claude?: string, ollama?: string }
  → { claude: string, ollama: string | null }
  Note: existing file is backed up to .bak before overwriting.

GET  /api/v1/groups/:folder/prompts
  → { claude: string, ollama: string | null }

PUT  /api/v1/groups/:folder/prompts
  Body: { claude?: string, ollama?: string }
  → { claude: string, ollama: string | null }
  Note: existing file is backed up to .bak before overwriting.
```

### Tasks

```
GET  /api/v1/groups/:folder/tasks
  → [{ id, prompt, scheduleType, scheduleValue, contextMode, model, timezone,
       maxToolRounds, timeoutMs, nextRun, lastRun, lastResult, status, createdAt }]

GET  /api/v1/tasks/:id
  → task object (same fields as above)

PATCH /api/v1/tasks/:id
  Body: { prompt?, scheduleType?, scheduleValue?, model?, timezone?,
          maxToolRounds?, timeoutMs?, status? }
  → updated task object
  Note: contextMode is intentionally read-only (see Data Access section).

GET  /api/v1/tasks/:id/runs?limit=20
  → [{ runAt, durationMs, status, result, error }]
  Note: task_run_logs also has id (auto-increment PK) and task_id (FK) columns;
        these are used for querying but not exposed in the response.
```

### Containers

```
GET  /api/v1/containers
  → [{ name, group, status, created, runningFor }]
  Note: async Docker CLI call with 5s timeout. Returns [] on timeout.
```

### Health

```
GET  /api/v1/health
  → { status: "ok", version: string, uptime: number }
```

## Frontend

A single-page application served as static files from the same Node.js process. Built with vanilla HTML/CSS/JS (no build step, no framework) to keep dependencies minimal and align with NanoClaw's philosophy.

### Pages / Views

1. **Dashboard** — overview of all groups, active containers count, link to global prompts
2. **Global Prompts** — editor for `groups/global/CLAUDE.md` and `OLLAMA.md`
3. **Group Detail** — group settings (model, limits), prompt editor, task list
4. **Task Detail** — task prompt editor, settings form, recent run history

### UI Components

- **Prompt editor**: `<textarea>` with monospace font. No rich editor — these are markdown files. Save button with confirmation.
- **Settings form**: simple `<input>` / `<select>` fields for model, schedule, limits.
- **Container list**: table with auto-refresh (poll `/api/v1/containers` every 5 seconds).
- **Task list**: table sorted by next_run, with status badges.

### Static File Serving

The frontend lives in `webui/public/` in the source tree. Since these are vanilla HTML/CSS/JS files (no build step), the TypeScript build does not transform them. The `npm run build:webui` script compiles the TypeScript and then copies `webui/public/` to `dist/webui/public/` so that the compiled server can serve them from a path relative to itself. This is part of the standalone `build:webui` script, not a `postbuild` hook — the web UI build is independent of the main `npm run build`.

The server resolves all static file paths against the `public/` directory root and verifies that the resolved path starts with that root (`path.resolve()` + `startsWith()` check) to prevent path traversal on hand-crafted HTTP requests that bypass the browser.

API routes are prefixed with `/api/v1/` to avoid conflicts with static file paths.

## File Structure

```
webui/
├── server.ts              # HTTPS server, request router, static file serving
├── tls.ts                 # mTLS: CA + server + client cert loading / generation / renewal
├── db.ts                  # Database access (opens store/messages.db directly)
├── router.ts              # Path-matching utility and JSON body parser
├── routes/
│   ├── groups.ts          # Group CRUD handlers
│   ├── prompts.ts         # Prompt read/write handlers (with .bak backup)
│   ├── tasks.ts           # Task CRUD handlers
│   └── containers.ts      # Async Docker CLI wrapper
├── public/
│   ├── index.html         # SPA shell
│   ├── style.css          # Styles
│   └── app.js             # Client-side JS (fetch + DOM manipulation)
├── scripts/
│   ├── add-client.sh      # Generate a new client certificate (.p12)
│   ├── install-service.sh # Install systemd/launchd/nohup service
│   └── uninstall-service.sh
└── start.ts               # Entry point: reads config, loads mTLS, starts server
```

### `webui/router.ts` — request routing and body parsing

The server uses a small hand-rolled router rather than a framework. This module provides:

- **Path matching with parameters**: a `match(pattern, url)` function that extracts named segments (e.g., `/groups/:folder` matches `/groups/slack_main` and returns `{ folder: 'slack_main' }`). Patterns are compiled to regexes at startup, not per-request.
- **JSON body parser**: reads the request body with a 1 MB size limit, parses as JSON, returns 400 on malformed input or 413 if oversized. All request body handling goes through this single function.
- **Query string parsing**: extracts `?limit=20` etc. from the URL.
- **Content-Type validation**: rejects non-JSON bodies on routes that expect JSON.
- **Async handler support**: route handlers may return a `Promise`. The router awaits the result before writing the response. This allows handlers like `/containers` to use promisified `execFile` without callbacks.
- **Error wrapper**: catches handler exceptions (including rejected promises) and returns structured JSON error responses.

This is roughly 100-150 lines of code. It's more work than importing Express, but the API surface is small (7 route patterns) and the dependency-free property is worth preserving.

## Implementation Plan

### Phase 1: Backend API

1. **`webui/tls.ts`** — Manages the full mTLS certificate hierarchy. On first run, generates the private CA (10 year lifetime), server cert (1 year, signed by CA), and a default client cert (1 year, signed by CA) into `data/tls/` using `openssl` via `execSync`. Returns `{ ca, cert, key }` buffers for `https.createServer()`. Checks server certificate expiry: warns if <30 days remaining, auto-regenerates if expired (re-signs with existing CA — client certs and browser trust are unaffected). Custom certificates (`WEBUI_TLS_CA`/`WEBUI_TLS_CERT`/`WEBUI_TLS_KEY`) are never auto-renewed — log error and refuse to start if expired. Sets all private key files to mode `0600`; warns at startup if existing key files have overly permissive permissions.

2. **`webui/db.ts`** — Open `store/messages.db` with `better-sqlite3`. Immediately set `busy_timeout = 5000` via pragma. Export query functions for groups, tasks, task runs. Reuse the same SQL patterns from `src/db.ts` but in a read-focused module (no migrations, no schema creation). All queries use parameterized statements.

3. **`webui/router.ts`** — Path-matching utility (pattern → regex compiler, named param extraction), JSON body parser (1 MB limit, Content-Type validation), query string parser, error-handling wrapper. See "request routing and body parsing" section above.

4. **`webui/routes/groups.ts`** — `GET /groups`, `GET /groups/:folder`, `PATCH /groups/:folder`. The PATCH handler validates the folder name and maps camelCase request fields (`maxToolRounds`, `timeoutMs`) to snake_case columns (`max_tool_rounds`, `timeout_ms`) before writing. GET responses map back to camelCase.

5. **`webui/routes/prompts.ts`** — `GET/PUT /prompts/global`, `GET/PUT /groups/:folder/prompts`. Reads/writes `CLAUDE.md` and `OLLAMA.md` files with explicit `'utf-8'` encoding. Validates folder names via imported `isValidGroupFolder()`. Returns 404 if group folder doesn't exist on disk. Before overwriting, renames existing file to `.bak`.

6. **`webui/routes/tasks.ts`** — `GET /groups/:folder/tasks`, `GET /tasks/:id`, `PATCH /tasks/:id`, `GET /tasks/:id/runs`. The PATCH handler updates allowed fields (`context_mode` is intentionally excluded). Recomputes `next_run` when schedule changes (using `cron-parser`).

7. **`webui/routes/containers.ts`** — `GET /containers`. Uses `execFile` (async, no shell) to run `docker ps --filter name=nanoclaw- --format '{{json .}}'` with a 5-second timeout. Parses output, extracts group folder from container name pattern `nanoclaw-{safeName}-{epochMs}` (strips prefix and trailing digits). Returns empty array on timeout.

8. **`webui/server.ts`** — Creates `https.createServer()` with mTLS options from `tls.ts`: `{ ca, cert, key, requestCert: true, rejectUnauthorized: true }`. The `requestCert` + `rejectUnauthorized` combination ensures the TLS handshake fails for any client that doesn't present a certificate signed by the CA. Registers routes via `router.ts`. Serves static files from the `public/` directory with path traversal protection (`path.resolve()` + `startsWith()` check). No Express dependency.

9. **`webui/start.ts`** — Entry point. Reads `WEBUI_PORT` and `WEBUI_BIND` from `.env`. Loads or generates mTLS certificates via `tls.ts`. Opens the database (with busy timeout). Starts the HTTPS server on the configured bind address (default `127.0.0.1`). Logs startup URL with pino. On first run (when certificates are generated), logs the path to the default client `.p12` file and import instructions.

### Phase 2: Frontend

10. **`webui/public/index.html`** — SPA shell with `<nav>` sidebar and `<main>` content area. Client-side routing via hash fragments (`#/`, `#/groups/slack_main`, `#/tasks/abc123`).

11. **`webui/public/style.css`** — Clean, minimal styling. Dark/light based on `prefers-color-scheme`. Monospace for prompt editors. Responsive layout.

12. **`webui/public/app.js`** — Fetch-based API client. Hash router. Renders views by building DOM elements. Auto-refreshes container list on an interval.

### Phase 3: Service Management

13. **`webui/scripts/install-service.sh`** — Detects platform (systemd vs launchd vs nohup fallback). Generates and installs the appropriate service unit. Follows the same pattern as `setup/service.ts`.

    **systemd unit** (`nanoclaw-webui.service`):
    ```ini
    [Unit]
    Description=NanoClaw Web UI
    After=network.target

    [Service]
    Type=simple
    ExecStart={nodePath} {projectRoot}/dist/webui/start.js
    WorkingDirectory={projectRoot}
    Restart=always
    RestartSec=5
    Environment=HOME={homeDir}
    Environment=PATH=/usr/local/bin:/usr/bin:/bin:{homeDir}/.local/bin
    StandardOutput=append:{projectRoot}/logs/webui.log
    StandardError=append:{projectRoot}/logs/webui.error.log

    [Install]
    WantedBy=default.target
    ```

    **launchd plist** (`com.nanoclaw-webui.plist`):
    ```xml
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
      "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.nanoclaw-webui</string>
        <key>ProgramArguments</key>
        <array>
            <string>{nodePath}</string>
            <string>{projectRoot}/dist/webui/start.js</string>
        </array>
        <key>WorkingDirectory</key>
        <string>{projectRoot}</string>
        <key>RunAtLoad</key>
        <true/>
        <key>KeepAlive</key>
        <true/>
        <key>EnvironmentVariables</key>
        <dict>
            <key>PATH</key>
            <string>/usr/local/bin:/usr/bin:/bin:{homeDir}/.local/bin</string>
            <key>HOME</key>
            <string>{homeDir}</string>
        </dict>
        <key>StandardOutPath</key>
        <string>{projectRoot}/logs/webui.log</string>
        <key>StandardErrorPath</key>
        <string>{projectRoot}/logs/webui.error.log</string>
    </dict>
    </plist>
    ```

    **nohup fallback** (`start-webui.sh`):
    ```bash
    #!/bin/bash
    set -euo pipefail
    cd {projectRoot}

    PID_FILE={projectRoot}/webui.pid

    # Stop existing instance if running
    if [ -f "$PID_FILE" ]; then
      OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
      if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Stopping existing web UI (PID $OLD_PID)..."
        kill "$OLD_PID" 2>/dev/null || true
        sleep 2
      fi
    fi

    # Truncate logs if over 50 MB (no logrotate in nohup mode)
    for f in {projectRoot}/logs/webui.log {projectRoot}/logs/webui.error.log; do
      if [ -f "$f" ] && [ "$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)" -gt 52428800 ]; then
        tail -c 10485760 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
        echo "Truncated $f (kept last 10 MB)"
      fi
    done

    echo "Starting NanoClaw Web UI..."
    nohup {nodePath} {projectRoot}/dist/webui/start.js \
      >> {projectRoot}/logs/webui.log \
      2>> {projectRoot}/logs/webui.error.log &

    echo $! > "$PID_FILE"
    echo "Web UI started (PID $!)"
    echo "URL: https://localhost:${WEBUI_PORT:-3100}"
    echo "Logs: tail -f {projectRoot}/logs/webui.log"
    ```

14. **`webui/scripts/add-client.sh`** — Generates a new client certificate signed by the CA. Takes a single argument (the client name, e.g., `phone`). Creates `data/tls/clients/{name}-cert.pem`, `{name}-key.pem`, and `{name}.p12`. Prints the `.p12` path and the import password. Refuses to overwrite existing certs for the same name (pass `--force` to regenerate).

15. **`webui/scripts/uninstall-service.sh`** — Stops and removes the service unit. For nohup fallback, reads the PID file, checks whether the PID is still alive (`kill -0`) before attempting to kill, and cleans up the PID file.

### Phase 4: Integration

16. **`package.json`** — Add scripts:
    ```json
    {
      "build:webui": "tsc -p webui/tsconfig.json && cp -r webui/public dist/webui/public",
      "webui": "node dist/webui/start.js",
      "webui:dev": "tsx webui/start.ts"
    }
    ```

    The web UI is an **optional** component — `npm run build` compiles only the core orchestrator (unchanged). `npm run build:webui` compiles the web UI separately and copies the static frontend assets. This keeps the web UI opt-in: users who don't want it pay no build cost and have no extra output in `dist/`.

17. **`.env.example`** — Add `WEBUI_PORT`, `WEBUI_BIND`, `WEBUI_TLS_CA`, `WEBUI_TLS_CERT`, and `WEBUI_TLS_KEY` entries.

18. **`webui/tsconfig.json`** — A separate TypeScript config for the web UI, extending the root config:
    ```json
    {
      "extends": "../tsconfig.json",
      "compilerOptions": {
        "rootDir": ".",
        "outDir": "../dist/webui",
        "declaration": false,
        "declarationMap": false
      },
      "include": ["./**/*"],
      "exclude": ["public"]
    }
    ```

    This keeps the root `tsconfig.json` untouched (`rootDir: ./src`, `outDir: ./dist`). The web UI compiles independently into `dist/webui/`. The main build is not affected in any way — no changes to existing include/exclude paths or output structure.

    **Cross-project import caveat**: the web UI imports `isValidGroupFolder()` from `src/group-folder.ts` (e.g., `import { isValidGroupFolder } from '../src/group-folder'`). Because `rootDir` is set to `webui/`, TypeScript will refuse to compile a file outside that root. To solve this, widen `rootDir` to `..` (the project root) and adjust `include` to pull in only the specific source files needed:

    ```json
    {
      "extends": "../tsconfig.json",
      "compilerOptions": {
        "rootDir": "..",
        "outDir": "../dist/webui",
        "declaration": false,
        "declarationMap": false
      },
      "include": ["./**/*", "../src/group-folder.ts"],
      "exclude": ["public"]
    }
    ```

    With `rootDir: ".."`, the compiler mirrors the source tree structure under `outDir`, so `webui/server.ts` compiles to `dist/webui/webui/server.ts` and `src/group-folder.ts` compiles to `dist/webui/src/group-folder.js`. The `build:webui` script and entry point path must account for this extra nesting (e.g., `node dist/webui/webui/start.js`). Alternatively, create a thin re-export file `webui/group-folder.ts` that re-exports from `../src/group-folder` and keep `rootDir: "."` — this avoids the nesting issue at the cost of one extra file.

## Dependencies

No new npm dependencies. The backend uses:
- `https` (Node built-in) for the HTTPS server
- `fs` (Node built-in) for reading TLS certificates and prompt files
- `crypto` (Node built-in) for parsing X.509 certificate expiry dates (CA, server, and client certs)
- `child_process.execFile` (Node built-in) for async `docker ps`
- `child_process.execSync` (Node built-in) for `openssl` CA, server, and client certificate generation
- `better-sqlite3` (already installed) for database access
- `cron-parser` (already installed) for recomputing next_run
- `pino` (already installed) for logging
- `isValidGroupFolder()` from `src/group-folder.ts` for folder name validation (imported, not duplicated)

The frontend is vanilla HTML/CSS/JS with no build step.

### System requirements

- `openssl` CLI — required for generating the private CA, server certificate, and client certificates (including PKCS#12 bundles). Present by default on macOS and all mainstream Linux distributions.

## Security

- **Mutual TLS (mTLS)** — the primary security boundary. The server requires clients to present a certificate signed by the private CA. Connections without a valid client certificate are rejected at the TLS handshake, before any HTTP request is processed. This makes the web UI safe to expose on a LAN or the public internet.
- **Private CA** — a self-signed CA certificate is auto-generated on first run. All server and client certificates are signed by this CA. The CA key (`data/tls/ca-key.pem`) is the root of trust and must be protected (`mode 0600`).
- **Configurable bind address** — defaults to `127.0.0.1`. Can be set to `0.0.0.0` for LAN/WAN access. The security model does not depend on localhost binding — mTLS provides authentication regardless of network exposure.
- **CSRF protection** — two independent layers block cross-origin attacks. First, no `Access-Control-Allow-Origin` header is set on any response, so browsers send a CORS preflight (OPTIONS) for non-simple methods (`PATCH`, `PUT`). The preflight itself must complete a TLS handshake that requires the client certificate, creating a chicken-and-egg problem: the browser won't attach the client cert to a preflight for a cross-origin request, and the server won't complete the handshake without it. Second, even if a future browser bug bypassed preflight, the mTLS handshake still requires the client certificate, which the attacker's origin cannot trigger the browser to send cross-origin. Since no CORS headers are set, the server behaves identically regardless of which hostname or IP the browser uses to reach it.
- **No secrets** — the web UI never reads API keys, OAuth tokens, or other credentials from `.env`. It only reads `WEBUI_PORT`, `WEBUI_BIND`, `WEBUI_TLS_CA`, `WEBUI_TLS_CERT`, `WEBUI_TLS_KEY`, and `ASSISTANT_NAME`.
- **Private key permissions** — all auto-generated private keys (CA, server, client) are written with mode `0600` (owner read/write only). The startup script warns if existing key files have overly permissive permissions.
- **Path traversal prevention (API)** — group folder names are validated by importing and calling `isValidGroupFolder()` from `src/group-folder.ts` before any file I/O.
- **Path traversal prevention (static files)** — all static file paths are resolved with `path.resolve()` and checked with `startsWith()` against the `public/` directory root. Requests that escape the root return 403.
- **Request body size limit** — incoming request bodies are capped at 1 MB. Requests exceeding this receive `413 Payload Too Large`.
- **SQLite safety** — all queries use parameterized statements. Busy timeout (5 seconds) is set on the UI's connection to handle contention with the orchestrator.
- **No container control** — the UI can only *view* running containers, not start/stop them.

## Platform Support

Must work on both Linux and macOS. Platform-specific considerations:

- **TLS generation**: `openssl` is available on both platforms. The `-addext` and `-copy_extensions` flags require OpenSSL 1.1.1+ (LibreSSL on macOS supports it as of macOS 13+; for older macOS, fall back to a config file approach). The `openssl pkcs12 -export` command for generating `.p12` bundles works on both platforms, but the `-legacy` flag is required for compatibility: OpenSSL 3.x changed the default PKCS#12 encryption algorithm, and older browsers plus macOS Keychain cannot read the new format. If `-legacy` is not available (OpenSSL < 3.0), it can be omitted — the old default algorithm is already the compatible one. The implementation should try with `-legacy` first and fall back to without.
- **Service management**: `install-service.sh` detects the platform and generates systemd (Linux) or launchd (macOS) units, with a nohup fallback for WSL or environments without a service manager. Same pattern as `setup/service.ts`.
- **Docker CLI**: `docker ps` works identically on both platforms.
- **File permissions**: `0600` for TLS private keys works on both platforms.
- **Certificate import**: browser setup instructions cover Chrome/Linux, macOS Keychain, and Firefox for both CA trust and client certificate import.
- **Static file copying**: `cp -r` in the `build:webui` script works on both platforms.
- **Log rotation**: not handled by the web UI itself. On Linux, use `logrotate` for `logs/webui.log` and `logs/webui.error.log`. On macOS, use `newsyslog`. The install-service script should note this and optionally install a logrotate config. For the nohup fallback, the start script truncates logs that exceed 50 MB before starting.

## Open Questions

1. **Task creation/deletion** — Intentionally excluded from v1 to limit scope. Could be added later by reusing `createTask()` and `deleteTask()` from `src/db.ts` patterns.
2. **Live orchestrator state** — The UI cannot see in-memory state like `GroupQueue` pending counts. The `docker ps` approach covers active containers, which is the most useful runtime view. A simple next step would be a `data/orchestrator-status.json` file the orchestrator writes on each loop iteration with timestamps, queue depths, and error counts — the web UI just reads the file. No IPC protocol needed. The file must be written atomically (write to a temp file in the same directory, then `fs.renameSync` into place) so the web UI never reads a half-written file.
3. **Client certificate revocation** — Deleting a client cert's files prevents generating a new `.p12`, but the existing cert remains valid until expiry. For immediate revocation, `tls.ts` could maintain a CRL (certificate revocation list) file that the server loads on startup and checks during the TLS handshake. This is straightforward with Node's `tls.createServer({ crl })` option but adds operational complexity. Note that Node's `crl` option requires a server restart to pick up changes; for hot-reload, `server.setSecureContext()` would be needed instead. Not needed for v1 — the short (1 year) cert lifetime and small number of clients make this low-priority.
4. **Server cert SAN customization** — The auto-generated server cert includes `localhost`, `127.0.0.1`, and `$(hostname)`. Users who want to access the web UI via a custom domain or specific LAN IP need additional SANs. A `regen-server-cert.sh` script that accepts additional SANs as arguments would cover this. Not a v1 blocker since the default SANs cover the common cases.
5. **Separate client CA** — The custom cert path (`WEBUI_TLS_CA`/`WEBUI_TLS_CERT`/`WEBUI_TLS_KEY`) uses a single CA for both server cert issuance and client cert verification. A `WEBUI_TLS_CLIENT_CA` override would support environments where these CAs differ (e.g., server cert from Let's Encrypt, client certs from an internal CA). Low priority — the auto-generated PKI doesn't have this problem, and custom cert users who need split CAs are an edge case.
