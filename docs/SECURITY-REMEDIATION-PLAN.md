# Security Remediation Plan

Detailed plan for addressing findings from the [March 2026 Security Review](SECURITY-REVIEW-2026-03.md). Organised into four phases by urgency.

---

## Phase 1 — Critical (do before next deploy)

### 1.1 Column-Name Allowlist in `updateTask()`

**Finding:** C1
**File:** `webui/db.ts:190-201`
**Effort:** Small (15 min)

Add a static allowlist of valid column names inside `updateTask()`. Reject any key not in the set.

```typescript
const ALLOWED_COLUMNS = new Set([
  'prompt', 'schedule_type', 'schedule_value', 'context_mode',
  'model', 'temperature', 'timezone', 'max_tool_rounds',
  'timeout_ms', 'status', 'next_run',
]);

for (const [key, value] of Object.entries(updates)) {
  if (value !== undefined && ALLOWED_COLUMNS.has(key)) {
    setClauses.push(`${key} = ?`);
    values.push(value);
  }
}
```

**Verification:** Add a unit test that passes a key like `"prompt = 'x'; DROP TABLE scheduled_tasks; --"` and confirms it is silently ignored.

---

### 1.2 Environment Allowlist for MCP Server Subprocesses

**Finding:** C2
**File:** `container/agent-runner/src/mcp-tool-executor.ts:82-86`
**Effort:** Small (15 min)

Replace the `...process.env` spread with an explicit allowlist:

```typescript
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'NODE_ENV', 'TZ', 'LANG', 'LC_ALL'];

const env: Record<string, string> = {};
for (const key of SAFE_ENV_KEYS) {
  if (process.env[key]) env[key] = process.env[key]!;
}
Object.assign(env, config.env || {}, extraEnv || {});
```

This ensures only explicitly declared variables reach MCP servers. The `config.env` block (from `mcp-servers.json`) still supplies server-specific vars like `OLLAMA_HOST`.

**Verification:** Log the env keys passed to a test MCP server; confirm only allowlisted keys plus config-declared keys appear.

---

### 1.3 Read-Only Agent-Runner Source Mount

**Finding:** C3
**Files:** `src/container-runner.ts:332`, `container/Dockerfile:71`
**Effort:** Medium (1-2 hours) — requires entrypoint change and container rebuild

**Option A (preferred): Pre-compile at image build time.**

1. In `Dockerfile`, add a build step that compiles the agent-runner:
   ```dockerfile
   COPY agent-runner/src/ /app/src/
   COPY agent-runner/tsconfig.json /app/
   RUN cd /app && npx tsc --outDir /app/compiled
   RUN chmod -R a-w /app/compiled
   ```

2. Change the entrypoint to skip compilation and run the pre-compiled output:
   ```bash
   #!/bin/bash
   set -e
   # Use pre-compiled if available, else compile from mounted source (dev mode)
   if [ -d /app/compiled ]; then
     ln -sf /app/node_modules /app/compiled/node_modules
     cat > /tmp/input.json
     exec node /app/compiled/index.js < /tmp/input.json
   else
     cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
     ln -s /app/node_modules /tmp/dist/node_modules
     chmod -R a-w /tmp/dist
     cat > /tmp/input.json
     exec node /tmp/dist/index.js < /tmp/input.json
   fi
   ```

3. In `container-runner.ts`, mount agent-runner source as **read-only**:
   ```typescript
   mounts.push({
     hostPath: groupAgentRunnerDir,
     containerPath: '/app/src',
     readonly: true,
   });
   ```

**Option B (simpler): Just make the mount read-only.**

Change the mount in `container-runner.ts` to read-only. The entrypoint already compiles to `/tmp/dist` (a writable tmpfs), so compilation still works — the agent just can't modify the source.

**Verification:** Start a container, attempt to write to `/app/src/index.ts`, confirm `EROFS` (read-only filesystem).

---

## Phase 2 — High (this sprint)

### 2.1 Drop Container Capabilities

**Finding:** H1
**File:** `src/container-runner.ts` — `buildContainerArgs()`
**Effort:** Small (15 min)

Add after the `--rm` flag:

```typescript
args.push(
  '--cap-drop=ALL',
  '--cap-add=CHOWN',
  '--cap-add=SETUID',
  '--cap-add=SETGID',
);
```

`CHOWN`/`SETUID`/`SETGID` are needed because the entrypoint runs as a non-root user that may need to adjust file ownership of mounted volumes. Test by running a full message + task cycle and confirming no permission errors.

If the agent doesn't need any of these, simplify to just `--cap-drop=ALL`.

**Verification:** Run `docker inspect <container>` during execution, confirm `CapAdd` is minimal and `CapDrop` includes `ALL`.

---

### 2.2 Container Resource Limits

**Finding:** H2
**File:** `src/container-runner.ts` — `buildContainerArgs()`
**Effort:** Small (15 min)

Add resource constraints:

```typescript
args.push(
  '--memory', '2g',
  '--memory-swap', '2g',   // No swap — OOM-kill rather than swap-thrash
  '--cpus', '2',
  '--pids-limit', '256',
);
```

Consider making these configurable via `data/backend-defaults.json` if different backends need different limits. Ollama direct mode may need more memory for model loading.

**Verification:** Inside a container, run `cat /sys/fs/cgroup/memory.max` and confirm it shows the limit.

---

### 2.3 Container Network Restriction

**Finding:** H3
**File:** `src/container-runner.ts` — `buildContainerArgs()`
**Effort:** Medium (1-2 hours)

**Option A (simple): Custom bridge network with iptables.**

1. Create a dedicated Docker network at startup:
   ```bash
   docker network create --driver bridge nanoclaw-agent-net
   ```

2. Add `--network nanoclaw-agent-net` to container args.

3. Add iptables rules that allow only:
   - Credential proxy (`host.docker.internal:3001`)
   - MCP auth proxy (`host.docker.internal:3401`)
   - Ollama (`OLLAMA_HOST`, `OLLAMA_REMOTE_HOST`)
   - DNS (for `host.docker.internal` resolution)
   - Block everything else (especially `169.254.169.254`)

**Option B (strictest): `--network=none` + explicit proxy.**

Use `--network=none` and have the credential proxy also proxy Ollama requests. This eliminates all container networking but requires proxy changes.

**Recommendation:** Start with Option A. Document the iptables rules in `docs/SECURITY.md`.

**Verification:** From inside a container, `curl http://169.254.169.254/` should fail. `curl $ANTHROPIC_BASE_URL/v1/messages` should succeed.

---

### 2.4 Web UI Security Headers

**Finding:** H4
**File:** `webui/server.ts` — `json()` function and static file handler
**Effort:** Small (20 min)

Add a helper that sets security headers on every response:

```typescript
function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com; connect-src 'self'");
}
```

Call at the top of the request handler, before any `json()` or static file write.

Note: `'unsafe-eval'` is needed for Vue.js template compilation (runtime compiler). If you switch to pre-compiled templates, remove it.

**Verification:** Check response headers with `curl -I https://localhost:3100/api/v1/health --cert ...`.

---

### 2.5 Subresource Integrity for CDN Dependencies

**Finding:** H5
**File:** `webui/public/index.html`
**Effort:** Small (15 min)

1. Pin exact CDN versions (not `@3` range).
2. Generate SRI hashes:
   ```bash
   curl -s https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js | openssl dgst -sha384 -binary | openssl base64 -A
   ```
3. Add `integrity` and `crossorigin` attributes:
   ```html
   <script src="https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js"
     integrity="sha384-<hash>" crossorigin="anonymous"></script>
   ```

**Alternative:** Download the files into `webui/public/vendor/` and serve them locally. Eliminates CDN dependency entirely. This is the safer option for a security-critical admin UI.

**Verification:** Tamper with the `integrity` hash, confirm the browser refuses to execute the script.

---

### 2.6 Credential Proxy Path and Method Validation

**Finding:** H6
**File:** `src/credential-proxy.ts`
**Effort:** Small (15 min)

Add validation at the top of the request handler:

```typescript
const ALLOWED_METHODS = new Set(['GET', 'POST']);
const ALLOWED_PATH_PREFIXES = ['/v1/', '/oauth/'];

if (!ALLOWED_METHODS.has(req.method ?? '')) {
  res.writeHead(405);
  res.end('Method not allowed');
  return;
}

if (!ALLOWED_PATH_PREFIXES.some(p => req.url?.startsWith(p))) {
  res.writeHead(403);
  res.end('Forbidden path');
  return;
}
```

**Verification:** From a container, attempt `curl -X DELETE $ANTHROPIC_BASE_URL/v1/something` and confirm `405`.

---

### 2.7 MCP Auth Proxy Request Body Size Limit

**Finding:** H7
**File:** `src/mcp-auth-proxy.ts:171-177`
**Effort:** Small (10 min)

Add a size check in `readBody()`:

```typescript
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
let size = 0;

req.on('data', (chunk) => {
  size += chunk.length;
  if (size > MAX_BODY_SIZE) {
    req.destroy();
    reject(new Error('Request body too large'));
    return;
  }
  data += chunk;
});
```

**Verification:** Send a 2MB POST to the MCP proxy, confirm it returns an error before reading the entire body.

---

## Phase 3 — Medium (this month)

### 3.1 P12 Certificate Password

**Finding:** M1
**File:** `webui/tls.ts:165,172,301`
**Effort:** Small (20 min)

Generate a random password per installation and store it alongside the certificate:

```typescript
const password = crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(clientDir, 'password.txt'), password, { mode: 0o600 });
```

Use this password in the `openssl pkcs12` commands. Update the setup log message to reference the password file rather than printing it inline.

---

### 3.2 MCP Server Name Validation

**Finding:** M2
**File:** `src/container-runner.ts:500`
**Effort:** Small (10 min)

Validate server names before using them in paths:

```typescript
const MCP_SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

for (const [name, srv] of Object.entries(mcpConfig.servers || {})) {
  if (!MCP_SERVER_NAME_RE.test(name)) {
    logger.error({ server: name }, 'Invalid MCP server name, skipping');
    continue;
  }
  // ... existing logic
}
```

---

### 3.3 Skill File Path Containment

**Finding:** M3
**File:** `src/remote-mcp.ts:157`
**Effort:** Small (15 min)

After resolving the path, verify it stays within the skill directory:

```typescript
const refFile = path.resolve(skillDir, relPath);
if (!refFile.startsWith(path.resolve(skillDir) + path.sep)) {
  logger.warn({ refFile, skillDir }, 'Skill ref escapes directory, skipping');
  continue;
}
```

Apply the same check in `container/agent-runner/src/index.ts` where skill candidates are resolved.

---

### 3.4 IPC JSON Schema Validation

**Finding:** M4
**File:** `src/ipc.ts:154,229`
**Effort:** Medium (1 hour)

Use `zod` (already a dependency) to validate IPC messages:

```typescript
import { z } from 'zod';

const IpcMessageSchema = z.object({
  type: z.literal('message'),
  chatJid: z.string().max(200),
  text: z.string().max(100_000),
}).strict();

const IpcTaskSchema = z.object({
  type: z.literal('schedule_task'),
  prompt: z.string().max(50_000),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().max(200),
  // ... other fields
}).strict();
```

The `.strict()` modifier rejects unknown keys, preventing prototype pollution and unexpected fields.

Add similar schemas for cross-channel messages, task management operations, and other IPC message types.

---

### 3.5 Bound the `limit` Query Parameter

**Finding:** M5
**File:** `webui/server.ts:178-182`
**Effort:** Trivial (5 min)

```typescript
const limit = query.limit ? Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100) : 20;
```

---

### 3.6 Refuse to Run as Root

**Finding:** M6
**File:** `src/container-runner.ts:624-629`
**Effort:** Small (10 min)

Add a startup check:

```typescript
const hostUid = process.getuid?.();
if (hostUid === 0) {
  logger.fatal('NanoClaw must not run as root. Use a non-root user or set --user in your service file.');
  process.exit(1);
}
```

Place this in `src/index.ts` at startup, before any container operations.

---

### 3.7 Cross-Channel Messaging ACL

**Finding:** M7
**File:** `src/ipc.ts:174-197`
**Effort:** Medium (1 hour)

If the current "any group can message any group" behaviour is intentional, document it explicitly in `docs/SECURITY.md` and move on.

If restriction is desired, add a simple ACL:
- Main group can send to any group (existing behaviour)
- Non-main groups can only send to their own chat JID
- Add an optional `cross_channel_targets` allowlist per group in the DB

---

### 3.8 Log 500 Errors in Web UI

**Finding:** M8
**File:** `webui/server.ts:212`
**Effort:** Trivial (5 min)

```typescript
} else {
  logger.error({ err, path: req.url, method: req.method }, 'Unhandled error in request handler');
  json(res, 500, { error: 'Internal server error' });
}
```

---

### 3.9 SSRF Prevention for Remote MCP Servers

**Finding:** M9
**Files:** `src/remote-mcp.ts:127-137`, `container/agent-runner/src/mcp-tool-executor.ts:69-78`
**Effort:** Small (20 min)

Add URL validation before connecting to remote MCP servers:

```typescript
function isAllowedMcpUrl(urlStr: string): boolean {
  const url = new URL(urlStr);
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname;
  // Block metadata endpoints, loopback, and link-local
  if (host === '169.254.169.254') return false;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  if (host.startsWith('169.254.')) return false;
  if (host.startsWith('10.') || host.startsWith('172.') || host.startsWith('192.168.')) {
    // Allow if explicitly configured, log a warning otherwise
    logger.warn({ url: urlStr }, 'Remote MCP server URL points to private network');
  }
  return true;
}
```

---

### 3.10 Validate Ollama Tool Arguments Against Schema

**Finding:** M10
**File:** `container/agent-runner/src/ollama-chat-engine.ts:234-248`
**Effort:** Medium (1 hour)

Before calling `executeTool()`, validate arguments against the tool's `inputSchema`:

```typescript
const toolDef = allTools.find(t => t.name === mcpName);
if (toolDef?.inputSchema) {
  const valid = validateAgainstSchema(args, toolDef.inputSchema);
  if (!valid) {
    log(`  Tool ${mcpName}: invalid arguments, skipping`);
    messages.push({ role: 'tool', content: 'Error: invalid arguments for this tool' });
    continue;
  }
}
```

Use `zod` or `ajv` for JSON Schema validation. This prevents hallucinated or malformed arguments from reaching MCP servers.

---

### 3.11 Web UI Audit Logging

**Finding:** M11
**Files:** `webui/server.ts`, `webui/routes/*`
**Effort:** Medium (1 hour)

Add a request logger that captures:
- Client certificate CN (from `req.socket.getPeerCertificate()`)
- HTTP method and path
- Response status code
- For mutating operations (PATCH, POST, DELETE): the resource ID

```typescript
const cert = (req.socket as TLSSocket).getPeerCertificate?.();
const clientCN = cert?.subject?.CN ?? 'unknown';
logger.info({ method, path: urlPath, clientCN, status }, 'api request');
```

---

## Phase 4 — Low Priority (backlog)

| ID | Task | Finding | Effort |
|----|------|---------|--------|
| 4.1 | Change `/home/node` to `chmod 755` in Dockerfile | L1 | Trivial |
| 4.2 | Upgrade CA key to 4096-bit RSA | L2 | Small |
| 4.3 | Filter response headers in credential proxy (allowlist safe headers) | L3 | Small |
| 4.4 | Add socket + request timeout to credential proxy upstream calls | L4 | Small |
| 4.5 | Clamp `RATE_LIMIT_BUFFER_REQUESTS` and `MAX_PROXY_CONCURRENCY` to valid ranges | L5, L6 | Trivial |
| 4.6 | Add allowlist reload on SIGHUP | L7 | Small |
| 4.7 | Add per-IP rate limiting to web UI | L8 | Medium |
| 4.8 | Validate timezone strings against IANA database | L9 | Small |
| 4.9 | Add cache-busting version hash to static assets | L10 | Small |
| 4.10 | Run `npm audit fix` for picomatch and rollup | Deps | Trivial |

---

## Testing Strategy

### For each fix, verify:

1. **Positive test:** The intended functionality still works (task updates, MCP servers spawn, containers run, web UI serves pages).
2. **Negative test:** The attack vector is blocked (malicious column name rejected, oversized body rejected, `--cap-drop=ALL` visible in container inspect, etc.).
3. **Regression test:** Run the existing message + task cycle end-to-end after applying each phase.

### Specific test cases to add:

| Test | Validates |
|------|-----------|
| `updateTask()` with invalid column name key | C1 fix |
| MCP subprocess env vars contain only allowlisted keys | C2 fix |
| Container `/app/src` is read-only | C3 fix |
| Container has no `CAP_NET_RAW` | H1 fix |
| Container OOM-killed at memory limit | H2 fix |
| Container cannot reach `169.254.169.254` | H3 fix |
| `curl -I` response includes `X-Frame-Options: DENY` | H4 fix |
| Browser rejects tampered CDN script | H5 fix |
| `DELETE /v1/messages` returns 405 from proxy | H6 fix |
| 2MB POST to MCP proxy returns error | H7 fix |
| IPC message with `__proto__` key is rejected by schema | M4 fix |
| `?limit=999999` returns at most 100 rows | M5 fix |
| NanoClaw exits immediately if run as root | M6 fix |

---

## Prioritised Checklist

```
Phase 1 — Critical (before next deploy)
[ ] 1.1  Column-name allowlist in updateTask()
[ ] 1.2  Env allowlist for MCP subprocesses
[ ] 1.3  Read-only agent-runner source mount + container rebuild

Phase 2 — High (this sprint)
[ ] 2.1  --cap-drop=ALL on containers
[ ] 2.2  --memory / --cpus / --pids-limit on containers
[ ] 2.3  Container network restriction
[ ] 2.4  Web UI security headers
[ ] 2.5  SRI hashes (or vendor locally) for CDN deps
[ ] 2.6  Credential proxy path + method validation
[ ] 2.7  MCP auth proxy body size limit

Phase 3 — Medium (this month)
[ ] 3.1   Random P12 password per installation
[ ] 3.2   MCP server name validation
[ ] 3.3   Skill file path containment
[ ] 3.4   IPC JSON schema validation (zod)
[ ] 3.5   Bound limit query parameter
[ ] 3.6   Refuse to run as root
[ ] 3.7   Cross-channel messaging ACL (or document)
[ ] 3.8   Log 500 errors in web UI
[ ] 3.9   SSRF prevention for remote MCP URLs
[ ] 3.10  Validate Ollama tool args against schema
[ ] 3.11  Web UI audit logging

Phase 4 — Low (backlog)
[ ] 4.1-4.10  See table above
```
