# Security Review — March 2026

Comprehensive review of NanoClaw's security posture covering the credential proxy, container isolation, web UI, IPC system, MCP/Ollama integration, and dependency chain.

**Scope:** All code in `src/`, `webui/`, `container/agent-runner/src/`, and configuration files.
**Date:** 2026-03-26
**Baseline:** commit `91886ee` (main branch)

---

## Summary

The core security architecture (credential proxy, container isolation, IPC authorization) is well-designed and fundamentally sound. The main risk areas are:

1. **Container hardening** was never done — no capability dropping, no resource limits, no network restriction. The expanding feature set (MCP tools, Ollama, web UI) makes this increasingly urgent.
2. **Web UI** introduced new attack surface: a structural SQL injection pattern, missing HTTP security headers, CDN dependencies without integrity checks, and a hardcoded certificate password.
3. **MCP server integration** passes the full process environment to subprocesses, doesn't validate server names for path traversal, and has SSRF risk on HTTP remote servers.
4. **Ollama direct mode** mounts agent-runner source read-write, enabling persistence across message container runs if an agent modifies the source.

---

## Findings

### CRITICAL — Fix Before Next Deploy

#### C1. SQL Column Injection Pattern in `webui/db.ts:190-201`

`updateTask()` interpolates `Object.entries()` keys directly into SQL:

```typescript
for (const [key, value] of Object.entries(updates)) {
  if (value !== undefined) {
    setClauses.push(`${key} = ?`);   // KEY IS NOT VALIDATED
    values.push(value);
  }
}
db.prepare(`UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
```

**Current exposure:** The only caller (`routes/tasks.ts:186-196`) constructs the `updates` object using hardcoded column names, so the HTTP API is not directly exploitable today. However, the function is exported and any new caller that passes unsanitized keys creates instant SQL injection. This is a structural defect.

**Contrast:** `updateGroup()` in the same file explicitly checks each property individually (lines 90-105), which is the safe pattern.

**Impact:** Database tampering, unauthorized data modification, potential data exfiltration.

#### C2. Full `process.env` Forwarded to MCP Server Subprocesses

**File:** `container/agent-runner/src/mcp-tool-executor.ts:82-86`

```typescript
const env: Record<string, string> = {
  ...process.env as Record<string, string>,
  ...(config.env || {}),
  ...(extraEnv || {}),
};
```

Every environment variable in the container process is forwarded to every MCP server subprocess. This violates least privilege. While the container itself has limited env vars (placeholder credentials, `TZ`, Ollama hosts), any future additions to the container environment would automatically leak to all MCP servers.

**Impact:** Credential leakage to untrusted MCP server processes; violates principle of least privilege.

#### C3. Agent-Runner Source Mounted Read-Write + Recompiled at Startup

**Files:** `src/container-runner.ts:332`, `container/Dockerfile:71`

The agent-runner TypeScript source is mounted read-write into the container at `/app/src` and recompiled on every startup (`npx tsc` in the entrypoint script). The `message-run` path **preserves** `agent-runner-src/` across runs (only `task-run` wipes it).

**Attack scenario:**
1. A compromised agent in a message container modifies `/app/src/index.ts` to exfiltrate credentials
2. On the next message for the same group, the modified source is compiled and executed
3. The backdoored agent-runner runs with full container privileges

**Impact:** Persistent code execution across container invocations for the same group.

---

### HIGH — Should Fix Soon

#### H1. No Container Capability Dropping

**File:** `src/container-runner.ts:586`

Containers run with Docker's default capability set (14 capabilities), including `CAP_NET_RAW` (raw sockets / network scanning), `CAP_DAC_OVERRIDE` (bypass file permission checks on mounted files), `CAP_SETUID`/`CAP_SETGID` (privilege escalation), and `CAP_CHOWN`.

None of these are required for the agent workload.

#### H2. No Container Resource Limits

**File:** `src/container-runner.ts:586`

No `--memory`, `--cpus`, or `--pids-limit` flags. A malicious or runaway agent can OOM-kill the host, starve CPU for other processes, or fork-bomb via unlimited PIDs.

#### H3. No Container Network Restriction

**File:** `src/container-runner.ts:586`

Containers have unrestricted outbound network access. They can scan internal networks, hit cloud metadata endpoints (`169.254.169.254`), contact arbitrary external hosts, or exfiltrate data. The only expected network targets are the credential proxy and (optionally) Ollama.

#### H4. Missing HTTP Security Headers in Web UI

**File:** `webui/server.ts:48-55`

No security headers set on HTTP responses:
- `Content-Security-Policy` — no XSS/injection protection
- `X-Content-Type-Options: nosniff` — MIME sniffing attacks
- `X-Frame-Options: DENY` — clickjacking
- `Strict-Transport-Security` — HSTS enforcement
- `Cache-Control: no-store` — sensitive data cached by browsers

Even with mTLS, these prevent attacks from compromised CDN scripts or cached data leakage.

#### H5. No Subresource Integrity (SRI) on CDN Scripts

**File:** `webui/public/index.html`

Vue.js and TailwindCSS loaded from CDN (`unpkg.com`, `cdn.tailwindcss.com`) without `integrity` attributes. A CDN compromise injects arbitrary JavaScript into the admin UI, which has full API access to modify tasks, prompts, and group settings.

#### H6. Credential Proxy Doesn't Validate Request Path or Method

**File:** `src/credential-proxy.ts:98-99`

The proxy forwards `req.url` and `req.method` verbatim to the upstream Anthropic API. A container could craft `DELETE` requests, `PUT` requests, or hit non-API endpoints.

```typescript
path: req.url,
method: req.method,
```

#### H7. MCP Auth Proxy Has No Request Body Size Limit

**File:** `src/mcp-auth-proxy.ts:171-177`

`readBody()` accumulates the entire request body in memory without any size limit. A malicious container can send an arbitrarily large payload to exhaust host memory.

---

### MEDIUM — Defense-in-Depth Gaps

#### ~~M1. Hardcoded P12 Certificate Password~~ — Not Applicable

Passwordless P12 client certificates are used in practice (required for macOS Safari compatibility). The password-protected export path is vestigial and unused. No action needed.

#### M2. MCP Server Names Not Validated for Path Traversal

**File:** `src/container-runner.ts:500`

Names from `data/mcp-servers.json` used directly in container mount paths:

```typescript
const containerPath = `/workspace/mcp-servers/${name}`;
```

A malicious config entry like `"../../../etc"` could mount at unexpected container paths. The config file is local and trusted, but defense-in-depth requires validation.

#### M3. Skill File Path Traversal via Referenced Markdown Links

**File:** `src/remote-mcp.ts:157`

Skill files use `path.resolve(skillDir, relPath)` on markdown link targets without verifying the resolved path stays inside the skill directory. A skill containing `[ref](../../../etc/passwd)` would read arbitrary host files.

#### M4. No IPC Schema Validation

**File:** `src/ipc.ts:154,229`

JSON files from containers parsed with `JSON.parse()` without structure validation. No protection against:
- Prototype pollution (`__proto__`, `constructor.prototype`)
- Oversized payloads (megabytes of JSON)
- Unexpected field types

#### M5. Unbounded `limit` Query Parameter in Web UI

**File:** `webui/server.ts:178-182`

```typescript
const limit = query.limit ? parseInt(query.limit, 10) : 20;
```

No upper bound. `?limit=999999999` on the task runs endpoint could cause large DB reads and memory consumption.

#### M6. Container Runs as Root When Host Process Is Root

**File:** `src/container-runner.ts:624-629`

The `--user` flag is skipped when `hostUid === 0`. If NanoClaw ever runs as root (accidentally or by misconfiguration), containers get full root privileges.

#### M7. Cross-Channel Messaging Has No ACL

**File:** `src/ipc.ts:174-197`

Any group's agent can send messages to any other registered group. This is documented as intentional, but a compromised non-main agent can spam or impersonate messages across all channels.

#### M8. Web UI 500 Errors Not Logged

**File:** `webui/server.ts:212`

Non-HttpError exceptions are caught and return `500` but are never logged, making security incidents invisible:

```typescript
} else {
  json(res, 500, { error: 'Internal server error' });  // No logging
}
```

#### M9. SSRF Risk on HTTP Remote MCP Servers

**Files:** `src/remote-mcp.ts:127-137`, `container/agent-runner/src/mcp-tool-executor.ts:69-78`

HTTP URLs for remote MCP servers are passed to `StreamableHTTPClientTransport` without validation. If `data/mcp-servers.json` is modified (or a config injection occurs), requests could target `http://169.254.169.254/` (cloud metadata), `http://localhost:8080/admin`, or other internal endpoints.

#### M10. Ollama Tool Arguments Not Validated Against Schema

**File:** `container/agent-runner/src/ollama-chat-engine.ts:234-248`

Tool arguments returned by Ollama are parsed and passed to `executeTool()` without validation against the tool's declared `inputSchema`. A hallucinating model could pass unexpected argument types or structures.

#### M11. No Audit Logging in Web UI

**Files:** `webui/*`

No logging of which client certificates are used, what API operations are performed, who modified tasks or groups, or failed authentication attempts.

---

### LOW — Worth Noting

| ID | Issue | Location | Notes |
|----|-------|----------|-------|
| L1 | `/home/node` is `chmod 777` | `Dockerfile:74` | Should be `755` |
| L2 | 2048-bit RSA keys | `tls.ts:75,109,145` | Adequate but 4096-bit preferred for CA |
| L3 | Response headers forwarded from upstream | `credential-proxy.ts:147` | Could leak `Set-Cookie` etc. |
| L4 | No upstream request timeout | `credential-proxy.ts:94-101` | Hanging upstream = resource leak |
| L5 | Rate limit buffer env-configurable to 0 | `rate-limiter.ts:30-33` | Disables proactive buffer |
| L6 | `MAX_PROXY_CONCURRENCY` env-configurable | `rate-limiter.ts:35-37` | Can be set arbitrarily high |
| L7 | Mount allowlist cached for process lifetime | `mount-security.ts:22-24` | Changes require restart |
| L8 | No web UI rate limiting | `webui/*` | DoS via rapid API calls |
| L9 | Timezone field not validated | `webui/routes/tasks.ts:128,206` | Accepts arbitrary strings |
| L10 | No cache busting on static assets | `webui/public/` | Stale JS/CSS after updates |

---

### Transitive Dependency Vulnerabilities

`npm audit` reports 2 HIGH severity issues:

| Package | Version Range | Vulnerability | CVE/GHSA | CVSS |
|---------|--------------|---------------|----------|------|
| picomatch | >=4.0.0 <4.0.4 | ReDoS via extglob quantifiers | GHSA-c2c7-rcm5-vvqj | 7.5 |
| rollup | >=4.0.0 <4.59.0 | Path traversal / arbitrary file write | GHSA-mw96-cpmx-2vgc | — |

Both are in build tooling (not production runtime), but should be fixed with `npm audit fix`.

---

### What's Working Well

These aspects of the security model are solid:

- **Credential proxy architecture** — real secrets never enter containers; placeholder tokens replaced at the proxy layer
- **`.env` shadow-mounted as `/dev/null`** in containers — prevents reading secrets from project root
- **`readEnvFile()` avoids `process.env`** — secrets don't leak to child processes
- **Group folder validation** — `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/` prevents path traversal
- **Mount allowlist** with comprehensive default blocked patterns (`.ssh`, `.gnupg`, `.aws`, `.docker`, `credentials`, `.env`, etc.)
- **IPC authorization** — non-main groups restricted to self-management
- **Gitleaks pre-commit hook** for secret scanning with custom rules
- **Parameterized SQL** used everywhere (except the `updateTask` column name issue)
- **mTLS enforcement** at the transport layer for web UI — no unauthenticated access
- **Static file path traversal protection** — `path.resolve()` + `startsWith()` check
- **No hardcoded secrets** in source code — verified by grep and gitleaks
- **Migration to OneCLI Agent Vault** underway for external credential management
