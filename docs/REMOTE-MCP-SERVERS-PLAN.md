# Remote MCP Servers — Implementation Plan

Step-by-step plan for implementing the [Remote MCP Servers specification](REMOTE-MCP-SERVERS.md). Each step is a self-contained, testable unit of work. Steps are ordered by dependency: each step builds on the previous ones.

The implementation is split into three phases:
- **Phase 1 (Steps 1–9):** Remote MCP server connectivity — containers can call MCP servers on the host over HTTP, with credential isolation.
- **Phase 2 (Steps 10–13):** MCP authorization proxy — per-group tool and argument filtering, so different groups have different access levels.
- **Phase 3 (Step 14):** Skill packaging — bundle as a NanoClaw skill branch for installation into any NanoClaw instance.

Phase 1 is useful on its own (credential isolation). Phase 2 adds per-group access control. Phase 3 makes it distributable.

## Implementation Rules

These rules govern how this plan is executed. They are **non-negotiable** — if any rule conflicts with a step in the plan, the rule wins. Stop and ask for clarification rather than violating a rule.

### Branch discipline

- **Work on a dedicated branch** (e.g. `skill/remote-mcp-servers`). Create it from `main` before starting.
- **Do not touch the `main` branch** during this work. No commits, no merges, no cherry-picks to `main`. The branch will later be installed as a NanoClaw skill.
- **Do not push** until explicitly asked. Commits stay local.

### Live system safety

- **NanoClaw is running.** Do not modify, restart, stop, or interfere with the running instance. This means:
  - Do not modify files in `data/`, `store/`, `groups/`, or `logs/` that the running process reads.
  - Do not run `npm install` on the main working tree if it would disrupt the running process (use the branch's own install context).
  - Do not run `systemctl` commands for nanoclaw or nanoclaw-webui.
  - Build and test commands (`npm run build`, `npm test`) are safe — they write to `dist/` and do not affect the running process.

### Strict TDD

- **Write tests first, from the spec.** Tests must be derived from the specification (REMOTE-MCP-SERVERS.md), not from knowledge of the implementation code. Read the spec, write the test, then write the code to make it pass.
- **Fix bugs in the code, not the tests.** If a test fails, the code is wrong — fix the code. Only modify a test if it clearly does not match the spec (document why in the commit message).
- **Tests must pass before moving on.** Do not proceed to the next step until all tests for the current step are green.

### Commit discipline

- **Commit after each major phase** (Phase 1, Phase 2), and **only when all tests are 100% passing**.
- Intermediate commits within a phase are encouraged for checkpointing, but phase-boundary commits are mandatory.
- **Do not push.** Commits stay local on the branch until explicitly instructed otherwise.
- Follow the repository's existing commit message style (see recent `git log`).

### Conflict resolution

- **Stop if you cannot reconcile these rules** with a step in the plan, with the spec, or with the current state of the codebase. Explain the problem clearly and wait for clarification. Do not guess, do not skip, do not work around.

### Skill packaging

- **Write a NanoClaw skill file** (`SKILL.md` + supporting files) following the NanoClaw skill directory convention so that this feature can later be installed into this or another NanoClaw installation as a skill branch. The skill bundle should be self-contained: another operator should be able to merge the skill branch and have remote MCP server support without manual setup beyond configuration.

## Prerequisites

- Read and understand [REMOTE-MCP-SERVERS.md](REMOTE-MCP-SERVERS.md) (specification)
- Read and understand [SECURITY.md](SECURITY.md) (existing security model)
- A running MongoDB instance accessible from the host (for end-to-end testing)
- The `mongodb-mcp-server` npm package installed globally or available via `npx`

---

# Phase 1: Remote MCP Server Connectivity

## Step 1: Config Parsing — Accept `url`-based Entries in `mcp-servers.json`

**File:** `src/container-runner.ts` (lines 328–471, the MCP server block inside `buildVolumeMounts`)

**What to change:**

The server iteration loop (line 360) currently casts every entry to a type with required `hostPath`, `command`, and `args`. Refactor to support two entry shapes:

1. Define a discriminated union type for parsed server entries:

```typescript
/** Tools field: flat array (backward compat) or access-level object */
type ToolsDef = string[] | Record<string, string[]>;

/** Resolve a ToolsDef to a flat array of tool names, filtered by readOnly flag */
function resolveTools(tools: ToolsDef, readOnly?: boolean): string[] {
  if (Array.isArray(tools)) return tools; // flat array — all tools
  if (readOnly) return tools['read'] || [];
  return Object.values(tools).flat();
}

interface StdioMcpServerEntry {
  hostPath: string;
  command: string;
  args: string[];
  tools: ToolsDef;
  env?: string[];
  awsAuth?: boolean;
  skill?: string;
}

interface RemoteMcpServerEntry {
  url: string;
  tools: ToolsDef;
  readOnly?: boolean;
  proxy?: boolean;
  policies?: { default?: string; groups?: Record<string, string> };
  headers?: Record<string, string>;
  skill?: string;
}

type McpServerEntry = StdioMcpServerEntry | RemoteMcpServerEntry;

function isRemoteEntry(entry: McpServerEntry): entry is RemoteMcpServerEntry {
  return 'url' in entry;
}
```

2. At the top of the loop body, classify the entry:
   - If it has both `url` and `hostPath`, log an error and `continue` (skip it).
   - If it has `url`, treat as remote.
   - If it has `hostPath`, treat as stdio (existing path).
   - If it has neither, log an error and `continue`.

3. For remote entries, skip:
   - `hostPath` resolution and `fs.existsSync` check
   - Volume mount creation
   - `awsAuth` handling
   - Environment variable resolution from `.env`

   Instead, proceed directly to tool schema discovery (Step 2) and container config generation (Step 3).

4. Resolve the `tools` field using `resolveTools(entry.tools, entry.readOnly)`. For stdio entries, `readOnly` is not applicable — pass `undefined` so all tools are included (backward compatible). The resolved flat array is what goes into `containerServers[name].tools` and is used for schema filtering.

**How to test:**

Add a remote entry to `data/mcp-servers.json` with a dummy URL. Start the orchestrator. Verify:
- No crash or unhandled error.
- Log message indicates the remote server was detected.
- No volume mount is created for the remote entry.
- Existing stdio servers continue to work unchanged (backward compat).

Add an entry with both `url` and `hostPath`. Verify it is rejected with a logged error.

**Backward compatibility tests** (must pass before proceeding):
- A `mcp-servers.json` with only stdio entries (flat `tools` arrays) produces identical container config, volume mounts, and runtime behavior as before this change.
- A `mcp-servers.json` with remote entries using flat `tools` arrays works (all tools registered).
- A remote entry with `tools` as an access-level object and `readOnly: true` registers only `read`-level tools.
- A remote entry with `tools` as an access-level object and no `readOnly` registers all levels.

---

## Step 2: Tool Schema Discovery over HTTP

**File:** `src/container-runner.ts`

**What to change:**

Add a new function `discoverRemoteToolSchemas` alongside the existing `discoverToolSchemas` (line 70). The existing function spawns a stdio process; the new one connects over HTTP.

```typescript
async function discoverRemoteToolSchemas(
  url: string,
  headers?: Record<string, string>,
): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  // 1. Import StreamableHTTPClientTransport from @modelcontextprotocol/sdk/client/streamableHttp.js
  // 2. Create transport with { url: new URL(url), requestInit: { headers } }
  // 3. Create MCP Client, connect to transport
  // 4. Call client.listTools() with a 5-second timeout (AbortController)
  // 5. Extract and return tool schemas
  // 6. Close client (disconnect cleanly)
  // 7. On any error, log warning and return []
}
```

**Dependencies:**

The host-side `src/` codebase does not currently depend on `@modelcontextprotocol/sdk`. The existing `discoverToolSchemas` uses raw JSON-RPC over stdio to avoid this dependency. Two options:

- **Option A: Add `@modelcontextprotocol/sdk` to the host's `package.json`** — cleanest, reuses the same SDK the container uses. The SDK is already in `node_modules` as a transitive dependency of the agent-runner build, but it should be declared explicitly.
- **Option B: Raw HTTP JSON-RPC** — send `initialize` and `tools/list` as HTTP POST requests with `fetch()`, mimicking what the stdio version does. Avoids a new dependency but duplicates protocol logic.

**Recommendation:** Option A. The SDK is small and already present. Add `@modelcontextprotocol/sdk` to the root `package.json` `dependencies`.

**In the server loop (Step 1):** For remote entries, call `discoverRemoteToolSchemas(entry.url, entry.headers)` instead of the stdio `discoverToolSchemas()`.

**How to test:**

1. Start a mongodb-mcp-server locally: `npx mongodb-mcp-server --transport http --port 3200 --connectionString mongodb://localhost:27017/test`
2. Add a remote entry to `mcp-servers.json` pointing to `http://127.0.0.1:3200/mcp`.
3. Start the orchestrator. Verify tool schemas are discovered and logged.
4. Stop the MCP server, restart orchestrator. Verify a warning is logged and the server is skipped (not a crash).

---

## Step 3: URL Rewriting and Container Config Generation

**File:** `src/container-runner.ts`

**What to change:**

1. Add a URL rewriting helper:

```typescript
function rewriteUrlForContainer(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      parsed.hostname = CONTAINER_HOST_GATEWAY; // 'host.docker.internal'
    }
    return parsed.toString();
  } catch {
    return url; // pass through malformed URLs; they'll fail at runtime
  }
}
```

   Import `CONTAINER_HOST_GATEWAY` from `./container-runtime.js` (already imported in this file).

2. Extend the `containerServers` type (line 345) to include remote server fields:

```typescript
const containerServers: Record<string, {
  // Stdio (existing)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // Remote (new)
  type?: 'http';
  url?: string;
  headers?: Record<string, string>;
  // Common
  tools: string[];
  skill?: string;
  skillContent?: string;
  toolSchemas?: Array<{ name: string; description?: string; inputSchema: unknown }>;
}> = {};
```

3. For remote entries, write a container config entry with `type: 'http'` and the rewritten URL. Use `resolveTools()` from Step 1 to flatten access-level tools:

```typescript
const resolvedTools = resolveTools(entry.tools, entry.readOnly);
const skillContent = resolveRemoteSkillContent(name, entry.skill);

containerServers[name] = {
  type: 'http',
  url: rewriteUrlForContainer(entry.url),
  tools: resolvedTools,
  ...(entry.headers && { headers: entry.headers }),
  ...(skillContent && { skillContent }),
  ...(toolSchemas.length > 0 && { toolSchemas }),
};
```

4. Add a `resolveRemoteSkillContent` helper that resolves the skill bundle and returns the assembled markdown content (SKILL.md + inlined references):

```typescript
function resolveRemoteSkillContent(
  serverName: string,
  skill?: string,
): string | undefined {
  // Priority 1: Local skill directory (convention)
  const conventionPath = path.join('container', 'skills', serverName, 'SKILL.md');
  if (fs.existsSync(conventionPath)) {
    return assembleSkillContent(conventionPath);
  }

  // Priority 2: Local file (explicit path)
  if (skill && !skill.startsWith('http') && skill.includes('/')) {
    if (fs.existsSync(skill)) {
      return assembleSkillContent(skill);
    }
  }

  // Priority 3: Local file (bare filename in container/skills/)
  if (skill && !skill.startsWith('http') && !skill.includes('/')) {
    const barePath = path.join('container', 'skills', skill);
    if (fs.existsSync(barePath)) {
      return assembleSkillContent(barePath);
    }
  }

  // Priority 4: HTTP fetch (handled in Step 8)
  // Priority 5: MCP resources (handled in Step 8)

  return undefined;
}

/** Read a skill file, strip frontmatter, inline referenced .md files */
function assembleSkillContent(skillPath: string): string {
  let content = fs.readFileSync(skillPath, 'utf-8');
  content = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

  const skillDir = path.dirname(skillPath);
  const refPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  const inlined: string[] = [];
  let match;
  while ((match = refPattern.exec(content)) !== null) {
    const [, title, relPath] = match;
    const refFile = path.resolve(skillDir, relPath);
    if (fs.existsSync(refFile)) {
      try {
        const refContent = fs.readFileSync(refFile, 'utf-8').trim();
        if (refContent) inlined.push(`### ${title}\n\n${refContent}`);
      } catch { /* skip */ }
    }
  }
  if (inlined.length > 0) content += '\n\n' + inlined.join('\n\n');
  return content || undefined;
}
```

This mirrors the same inlining logic the agent-runner uses at runtime (`index.ts:674-697`), moved to the host side so remote server skills don't need filesystem access in the container for reference resolution.

   Note: no `command`, `args`, or `env` fields. For `proxy: true` entries, URL rewriting is deferred to Step 11 (Phase 2), which rewrites to the proxy URL instead of the real server URL.

**How to test:**

After Steps 1–3, start the orchestrator with a remote entry configured. Inspect the generated file at `data/sessions/{group}/mcp-servers/config.json`. Verify:
- The remote entry has `"type": "http"` and a `url` containing `host.docker.internal`.
- It has `toolSchemas` if discovery succeeded.
- It does not have `command`, `args`, or `env`.
- Existing stdio entries are unchanged (no `type` field, have `command` and `args`).

---

## Step 4: Agent-Runner — HTTP Transport in `McpToolExecutor` (Ollama Direct Mode)

**File:** `container/agent-runner/src/mcp-tool-executor.ts`

**What to change:**

1. Add import:

```typescript
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```

2. Extend the `McpServerConfig` interface (line 15):

```typescript
export interface McpServerConfig {
  // Stdio (existing)
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // HTTP (new)
  type?: 'http';
  url?: string;
  headers?: Record<string, string>;
  // Common
  tools: string[];
  toolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}
```

3. In `initialize()` (line 50), branch on `config.type`:

```typescript
for (const [name, config] of Object.entries(mcpConfig)) {
  try {
    let transport;
    if (config.type === 'http' && config.url) {
      transport = new StreamableHTTPClientTransport(
        new URL(config.url),
        { requestInit: config.headers ? { headers: config.headers } : undefined },
      );
    } else if (config.command) {
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args || [],
        env: { ...process.env, ...(config.env || {}), ...(extraEnv || {}) },
      });
    } else {
      log(`Skipping MCP server ${name}: no command or url`);
      continue;
    }

    const client = new Client({ name: `nanoclaw-ollama-${name}`, version: '1.0.0' });
    await client.connect(transport);
    // ... rest unchanged
  }
}
```

4. Track transport type per server (for cleanup). Add a `transportType` field to `ConnectedServer`:

```typescript
interface ConnectedServer {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: string[];
  type: 'stdio' | 'http';
}
```

5. `close()` is unchanged — `client.close()` works for both transport types. The MCP SDK handles transport-specific cleanup internally.

**How to test:**

**Unit tests** (`container/agent-runner/src/mcp-tool-executor.test.ts`):

The existing tests mock `StdioClientTransport`. Add parallel tests that:
- Mock `StreamableHTTPClientTransport` alongside `StdioClientTransport`.
- Create a config with `type: 'http'` and `url`.
- Verify `StreamableHTTPClientTransport` is instantiated with the correct URL.
- Verify `StdioClientTransport` is NOT instantiated for HTTP entries.
- Verify tool schema registration works identically for both types.
- Verify `close()` calls `client.close()` for HTTP servers.
- Verify a config entry with no `command` and no `url` is skipped with a log.

**Integration test** (manual):

1. Run mongodb-mcp-server on the host with `--transport http --port 3200`.
2. Configure a remote entry in `mcp-servers.json`.
3. Trigger an Ollama direct mode invocation for a group.
4. Verify the agent can call MongoDB tools (e.g. `find`, `list-databases`).

---

## Step 5: Agent-Runner — HTTP Transport for Claude SDK Mode

**File:** `container/agent-runner/src/index.ts` (lines 411–433 and 462–477)

**What to change:**

1. In the MCP config loading block (line 411), handle entries with `type: 'http'`:

> **Note:** The container-side config (`/workspace/mcp-servers-config/config.json`) is a **flat object** keyed by server name — it does NOT have a `servers` wrapper. This differs from the host-side `data/mcp-servers.json` which wraps entries in `{ "servers": { ... } }`. The existing code already iterates `Object.entries(mcpConfig)` (flat), so no unwrapping is needed here.

```typescript
const mcpConfigPath = '/workspace/mcp-servers-config/config.json';
if (fs.existsSync(mcpConfigPath)) {
  try {
    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    for (const [name, srv] of Object.entries(mcpConfig)) {
      const server = srv as {
        type?: 'http';
        url?: string;
        headers?: Record<string, string>;
        command?: string;
        args?: string[];
        tools?: string[];
        env?: Record<string, string>;
        skillContent?: string;
      };

      if (server.type === 'http' && server.url) {
        // Remote MCP server — pass to SDK as HTTP type
        additionalMcpServers[name] = {
          type: 'http',
          url: server.url,
          ...(server.headers && { headers: server.headers }),
        };
      } else if (server.command) {
        // Stdio MCP server — existing behavior
        additionalMcpServers[name] = {
          command: server.command,
          args: server.args || [],
          ...(server.env && { env: server.env }),
        };
      }

      for (const tool of server.tools || []) {
        additionalMcpTools.push(`mcp__${name}__${tool}`);
      }
    }
  } catch (err) { /* ... */ }
}
```

2. Update the type of `additionalMcpServers` to accept both shapes:

```typescript
const additionalMcpServers: Record<string,
  | { command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
> = {};
```

The Claude Agent SDK already accepts `{ type: 'http'; url: string; headers?: Record<string, string> }` in its `McpServerConfig` type (confirmed in `docs/SDK_DEEP_DIVE.md`). No SDK changes needed.

3. In the skill loading block (line 662), handle `skillContent` for remote servers:

```typescript
const serverSkills = new Map<string, string>();
for (const [name, config] of Object.entries(mcpConfig)) {
  const cfg = config as { skill?: string; skillContent?: string };

  // Remote servers: use pre-assembled skillContent from container config
  if (cfg.skillContent) {
    serverSkills.set(name, cfg.skillContent);
    log(`Loaded inline skill for ${name} (${cfg.skillContent.length} chars)`);
    continue;
  }

  // Stdio servers: existing file-based resolution (unchanged)
  if (!cfg.skill) continue;
  const candidates = [
    `/workspace/mcp-servers/${name}/${cfg.skill}`,
    `/home/node/.claude/skills/${name}/SKILL.md`,
  ];
  // ... rest of existing code unchanged
}
```

The `skillContent` field is set by the orchestrator's `resolveRemoteSkillContent()` (Step 3) and contains the fully assembled SKILL.md with all referenced markdown files already inlined. The agent-runner uses it directly for lazy injection without filesystem access.

For stdio servers, the existing file-based resolution continues unchanged — `skillContent` is never set for stdio entries, so the existing code path is preserved.

**How to test:**

1. Start a remote MCP server on the host.
2. Trigger a Claude SDK mode invocation (non-Ollama model) for a group.
3. Verify the agent can call remote MCP tools.
4. Check container logs for MCP connection messages.
5. Verify inline skill content appears in the skill loading log for remote servers.
6. Verify stdio server skills still load via the existing file-based path.

---

## Step 6: Host-Side Dependency — Add MCP SDK and YAML Parser

**File:** `package.json` (root)

**What to change:**

```bash
npm install @modelcontextprotocol/sdk@^1.12.1 yaml
```

- `@modelcontextprotocol/sdk` — needed for Step 2 (`discoverRemoteToolSchemas`). The SDK is already a transitive dependency but should be declared explicitly.
- `yaml` — needed for Phase 2 (YAML policy parsing). Install now to avoid a second dependency change later. The `yaml` package is a zero-dependency YAML 1.2 parser (~50 KB).

**How to test:**

`npm run build` succeeds. `discoverRemoteToolSchemas` can import from the SDK without errors.

---

## Step 7: MongoDB MCP Server Deployment

**Not a code change.** This step sets up the MongoDB MCP server as a systemd user service on the host.

### 7a. Install mongodb-mcp-server

```bash
npm install -g mongodb-mcp-server
```

Verify: `mongodb-mcp-server --help` works.

### 7b. Create systemd service

Create `~/.config/systemd/user/mongodb-mcp.service`:

```ini
[Unit]
Description=MongoDB MCP Server
After=network.target

[Service]
Type=simple
Environment=MDB_MCP_CONNECTION_STRING=mongodb://user:pass@host:27017/db
ExecStart=/usr/bin/npx -y mongodb-mcp-server --connectionString ${MDB_MCP_CONNECTION_STRING} --transport http --port 3200
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

**Note:** The connection string is in the systemd unit's `Environment=` directive (readable only by the user). NanoClaw's `.env` does not contain it.

For **Atlas Cloud** deployments, use a connection string with MongoDB RBAC credentials scoped to the appropriate privileges. Atlas enforces authentication, so RBAC provides a real second layer of defense alongside the authorization proxy. For **Atlas Local** deployments, RBAC is not enforced (`--transitionToAuth`), so the proxy is the sole access control layer.

```bash
systemctl --user daemon-reload
systemctl --user enable mongodb-mcp
systemctl --user start mongodb-mcp
```

### 7c. Configure NanoClaw

Add to `data/mcp-servers.json`:

```json
"mongodb": {
  "url": "http://127.0.0.1:3200/mcp",
  "tools": {
    "read": [
      "find", "aggregate", "count", "list-collections", "list-databases",
      "collection-schema", "collection-indexes", "db-stats", "explain", "export"
    ],
    "write": [
      "insert-many", "update-many", "create-collection", "create-index", "drop-index"
    ],
    "admin": [
      "delete-many", "drop-collection", "drop-database", "rename-collection"
    ]
  },
  "readOnly": true
}
```

Define all tools with access levels upfront, but set `"readOnly": true` to match the server's `--readOnly` flag. Only `read`-level tools are registered in Phase 1. When you're ready for Phase 2 (proxy with per-group policies), remove `"readOnly": true` and add `"proxy": true` + `"policies"` — the access levels are already defined.

### 7d. Test end-to-end

1. Verify `systemctl --user status mongodb-mcp` shows active.
2. Restart NanoClaw. Check logs for `Discovered MCP tool schemas` for the mongodb server.
3. Send a message to the agent that exercises a MongoDB tool (e.g. "list all databases").
4. Verify the agent receives results and responds correctly.

---

## Step 8: Skill Bundle

**Directory:** `container/skills/mongodb/` (new)

Create a skill bundle following the [Anthropic skill directory convention](https://code.claude.com/docs/en/skills). The bundle is a directory with `SKILL.md` as the entrypoint, plus optional supporting files:

```
container/skills/mongodb/
├── SKILL.md              # Main instructions (required)
├── reference/
│   ├── schema.md         # Database schema documentation
│   └── query-patterns.md # Common query patterns and examples
└── scripts/
    └── explain-plan.sh   # Helper script for query plan analysis (optional)
```

**`SKILL.md` content should include:**
- Available tools and what each does
- Connection context (what database/cluster this connects to)
- Schema conventions if any (collection naming, field patterns)
- Guidance on when to use `aggregate` vs `find`
- Note that destructive tools are not available (if using read-only allowlist)
- Links to supporting reference docs: `[Schema](reference/schema.md)`, `[Query patterns](reference/query-patterns.md)`

Keep `SKILL.md` under 500 lines (per Anthropic guidelines). Move detailed reference material to supporting files.

**Reference in `mcp-servers.json`:**

```json
"mongodb": {
  "url": "http://127.0.0.1:3200/mcp",
  "tools": { "read": ["find", "aggregate", "count", "..."] },
  "readOnly": true,
  "skill": "SKILL.md"
}
```

The `skill` field names the entrypoint file within the `container/skills/mongodb/` directory. For the convention case (server name matches directory name), this is optional — the orchestrator finds `container/skills/mongodb/SKILL.md` automatically.

**Delivery pipeline:**

1. The existing container-runner sync (`src/container-runner.ts:265-275`) copies `container/skills/mongodb/` into the session directory at `data/sessions/{group}/.claude/skills/mongodb/`.
2. The `resolveRemoteSkillContent()` helper from Step 3 reads `SKILL.md`, strips frontmatter, inlines referenced `.md` files, and writes the assembled content as `skillContent` in the container config.
3. In the container, the agent-runner uses `skillContent` for Ollama lazy injection. The full skill directory is also available at `/home/node/.claude/skills/mongodb/` for scripts and Claude SDK file access.

### Step 8b: HTTP and MCP Resource Skill Fetch (Optional)

**File:** `src/container-runner.ts`

Extend `resolveRemoteSkillContent` to handle HTTP URLs and MCP resources:

**HTTP fetch:**
```typescript
if (skill?.startsWith('http://') || skill?.startsWith('https://')) {
  const skillDir = path.join('container', 'skills', serverName);
  if (skill.endsWith('.tar.gz') || skill.endsWith('.zip')) {
    // Fetch archive, extract to skillDir
    await fetchAndExtractArchive(skill, skillDir);
  } else {
    // Fetch single file, resolve relative markdown links as relative URLs
    fs.mkdirSync(skillDir, { recursive: true });
    const content = await fetchUrl(skill);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    // Resolve referenced .md files from URL base path
    await fetchReferencedFiles(content, skill, skillDir);
  }
  return assembleSkillContent(path.join(skillDir, 'SKILL.md'));
}
```

**MCP resource discovery** (during schema discovery in Step 2):
```typescript
// After tools/list, also try resources/list
try {
  const resources = await client.listResources();
  for (const res of resources.resources || []) {
    if (res.uri.startsWith('skill://')) {
      const content = await client.readResource({ uri: res.uri });
      // Write to container/skills/{serverName}/
      // ...
    }
  }
} catch { /* MCP resources not supported — ignore */ }
```

This step is optional for Phase 1. Local skill directories are sufficient for the initial deployment. HTTP fetch and MCP resource discovery can be added later without changing the delivery pipeline.

**How to test:**

1. Create `container/skills/mongodb/SKILL.md` with reference links to `reference/schema.md`.
2. Trigger an Ollama direct mode invocation that calls a MongoDB tool.
3. Verify the skill content appears in the agent's context (visible in container logs at `LOG_LEVEL=debug`).
4. Verify referenced content from `schema.md` is inlined.
5. Verify scripts in `scripts/` are accessible at `/home/node/.claude/skills/mongodb/scripts/` in the container.

---

## Step 9: Phase 1 Tests

### Unit Tests

**`src/container-runner.test.ts`** (new file or added to existing):

| Test case | What it verifies |
|-----------|------------------|
| Remote entry parsed correctly | `url` entry produces `type: 'http'` in container config |
| Stdio entry unchanged | Existing entries still produce `command` + `args` config |
| Dual entry rejected | Entry with both `url` and `hostPath` is skipped with error log |
| Neither entry rejected | Entry with no `url` and no `hostPath` is skipped with error log |
| URL rewriting: localhost | `http://localhost:3200/mcp` → `http://host.docker.internal:3200/mcp` |
| URL rewriting: 127.0.0.1 | `http://127.0.0.1:3200/mcp` → `http://host.docker.internal:3200/mcp` |
| URL rewriting: external | `https://mcp.example.com/mcp` → unchanged |
| URL rewriting: bridge IP | `http://172.17.0.1:3200/mcp` → unchanged |
| No volume mount for remote | Remote entry does not add to `mounts[]` |
| No env resolution for remote | Remote entry does not call `readEnvFile` |
| Headers passed through | `headers` field appears in container config |
| Missing remote server | Discovery failure produces warning, not crash |
| **Backward compat: stdio-only config** | `mcp-servers.json` with only stdio entries produces identical config to before |
| **Backward compat: flat tools array** | Remote entry with `tools: ["a", "b"]` registers both tools |
| **Access-level tools + readOnly** | `tools: { read: ["a"], write: ["b"] }` + `readOnly: true` → only `["a"]` in config |
| **Access-level tools, no readOnly** | `tools: { read: ["a"], write: ["b"] }` → `["a", "b"]` in config |
| **Skill bundle resolved** | Remote entry with `container/skills/{name}/SKILL.md` → `skillContent` in config |
| **Skill references inlined** | SKILL.md with `[Ref](reference/doc.md)` → inlined content in `skillContent` |

**`container/agent-runner/src/mcp-tool-executor.test.ts`** (extend existing):

| Test case | What it verifies |
|-----------|------------------|
| HTTP transport created for `type: 'http'` | `StreamableHTTPClientTransport` instantiated with correct URL |
| Stdio transport created for command entry | Existing behavior preserved |
| Headers passed to HTTP transport | `requestInit.headers` set correctly |
| Mixed config (stdio + HTTP) | Both transports created, tools registered for both |
| Entry with no command or URL skipped | Log message, no crash |
| Close handles both transport types | `client.close()` called for all servers |
| Tool call routing works for HTTP servers | `callTool` dispatches to correct server regardless of transport |

### Integration Tests (Manual Checklist)

| # | Scenario | Expected result |
|---|----------|-----------------|
| 1 | Orchestrator starts with remote entry, MCP server running | Schemas discovered, logged |
| 2 | Orchestrator starts with remote entry, MCP server not running | Warning logged, server skipped, orchestrator starts |
| 3 | Ollama direct mode calls remote MCP tool | Tool executes, result returned to agent |
| 4 | Claude SDK mode calls remote MCP tool | Tool executes, result returned to agent |
| 5 | Multiple containers call remote server concurrently | All succeed (no connection conflicts) |
| 6 | Remote server crashes mid-conversation | Tool call returns error, agent handles gracefully |
| 7 | Stdio and remote servers coexist | Both types work in same invocation |
| 8 | Skill bundle injected on first remote tool use (Ollama) | Skill content + inlined references in agent context |
| 9 | Container config has no credentials | Inspect `data/sessions/*/mcp-servers/config.json` — no connection strings |
| 10 | Skill bundle scripts accessible in container | `/home/node/.claude/skills/{name}/scripts/` exists and is executable |
| 11 | Stdio-only mcp-servers.json unchanged | Identical behavior to pre-remote-MCP codebase |

---

# Phase 2: MCP Authorization Proxy

Phase 2 adds per-group access control for remote MCP servers. The authorization proxy is a lightweight HTTP reverse proxy on the host that inspects MCP `tools/call` requests and enforces YAML access policies per group.

The primary win is **per-group tool filtering** — controlling which MCP tools each group can call. Argument-level filtering (e.g. restricting which databases, buckets, or schemas a group can access) is a best-effort second layer: it works well for MCP servers with consistent argument naming, but is not guaranteed to catch every access path (e.g. tools that accept raw queries or embedded DSLs).

For upstream services that support their own RBAC (e.g. MongoDB Atlas Cloud, PostgreSQL roles, AWS IAM), combine the proxy with the service's native access control for defense-in-depth. For services without enforced RBAC (e.g. Atlas Local, development databases), the proxy is the sole access control mechanism.

## Step 10: YAML Policy Loader

**File:** `src/mcp-policy.ts` (new)

**What to build:**

A module that loads and evaluates YAML access policies from `data/mcp-policies/`.

```typescript
import { parse as parseYaml } from 'yaml';

interface PolicyRule {
  tools: { allow?: string[]; deny?: string[] };
  arguments?: Record<string, { allow?: string[]; deny?: string[] }>;
}

interface PolicySet {
  /** server name → tier name → parsed policy */
  policies: Map<string, Map<string, PolicyRule>>;
  /** server name → { default tier, group → tier } */
  assignments: Map<string, { defaultTier?: string; groups: Map<string, string> }>;
}

/** Load all policies from data/mcp-policies/ */
function loadPolicies(policyDir: string): PolicySet;

/** Resolve the tier for a given server + group */
function resolveTier(policySet: PolicySet, serverName: string, groupFolder: string): PolicyRule | null;

/** Evaluate a tool call against a policy. Returns { allowed: boolean; reason?: string }. */
function evaluatePolicy(
  policy: PolicyRule,
  toolName: string,
  args: Record<string, unknown>,
): { allowed: boolean; reason?: string };
```

**Policy evaluation logic:**

1. **Tool check:**
   - If `tools.deny` contains the tool name (or `"*"`) → deny.
   - If `tools.allow` is defined and does NOT contain the tool name (and no `"*"` in allow) → deny.
   - Otherwise → pass tool check.

2. **Argument check** (for each key in `policy.arguments`):
   - Extract the value of that argument name from the tool call's `args`.
   - If the argument is not present in the tool call → skip (no constraint).
   - If `deny` patterns match the value → deny.
   - If `allow` patterns are defined and none match → deny.
   - Otherwise → pass.

3. Both checks must pass.

**Pattern matching for argument values:**

- `"*"` — matches anything.
- `"exact"` — exact string match.
- `"prefix*"` — matches if the value starts with `prefix` (glob-style). Splits on `.` and `/` for hierarchical matching.
- No regex support (avoids injection risks).

**How to test:**

Unit tests for `evaluatePolicy`:

| Policy | Tool | Args | Expected |
|--------|------|------|----------|
| `tools.allow: [find]` | `find` | `{}` | allowed |
| `tools.allow: [find]` | `delete-many` | `{}` | denied (tool not in allow) |
| `tools.deny: [delete-many]`, `tools.allow: [*]` | `delete-many` | `{}` | denied (deny takes precedence) |
| `tools.allow: [find]`, `arguments.database.allow: [analytics]` | `find` | `{database: "analytics"}` | allowed |
| `tools.allow: [find]`, `arguments.database.allow: [analytics]` | `find` | `{database: "secrets"}` | denied (database not in allow) |
| `tools.allow: [find]`, `arguments.database.allow: [analytics]` | `find` | `{}` | allowed (no database arg → skip check) |
| `arguments.collection.deny: [users]` | `find` | `{collection: "users"}` | denied |
| `arguments.bucket.allow: [reports*]` | `get_object` | `{bucket: "reports-prod"}` | allowed (prefix match) |
| `tools.allow: [*]`, no arguments section | any tool | any args | allowed |
| Empty policy (no allow, no deny) | any tool | any args | denied (default-deny) |

---

## Step 11: Authorization Proxy Server

**File:** `src/mcp-auth-proxy.ts` (new)

**What to build:**

An HTTP server that accepts MCP requests from containers, evaluates per-group policies, and forwards allowed calls to the real remote MCP server. Architecturally identical to `src/credential-proxy.ts`.

```typescript
export function startMcpAuthProxy(
  port: number,
  host: string,
  config: {
    /** server name → upstream URL */
    upstreams: Map<string, string>;
    policies: PolicySet;
  },
): Promise<Server>;
```

**Request routing:**

```
POST /{serverName}  →  look up upstream URL  →  evaluate policy  →  forward or reject
```

1. Parse URL path to extract server name: `POST /mongodb` → server `"mongodb"`.
2. Read `X-NanoClaw-Group` header → group folder name.
3. Optionally validate `X-NanoClaw-Token` HMAC (if configured).
4. Parse JSON body. If `method !== 'tools/call'`, forward unconditionally (e.g. `initialize`, `tools/list` are always allowed — the proxy should not interfere with MCP handshake or schema discovery).
5. For `tools/call`: extract `params.name` (tool name) and `params.arguments` (args object).
6. Resolve tier: `resolveTier(policies, serverName, groupFolder)`.
7. Evaluate: `evaluatePolicy(tier, toolName, args)`.
8. If allowed: forward request body to upstream URL, pipe response back.
9. If denied: return MCP JSON-RPC error `{ "jsonrpc": "2.0", "id": ..., "error": { "code": -32600, "message": "Access denied: ..." } }`.

**Non-`tools/call` passthrough:**

The proxy MUST forward these MCP methods without policy evaluation:
- `initialize` — MCP handshake
- `notifications/initialized` — MCP handshake completion
- `tools/list` — tool discovery (the container needs this for schema registration)
- Any other method that is not `tools/call`

Only `tools/call` is subject to policy evaluation. This keeps the proxy simple and avoids interfering with MCP protocol negotiation.

**Error handling:**

- Missing `X-NanoClaw-Group` header → `400` with descriptive error.
- Unknown server name in URL → `404`.
- No policy found for group (no tier match and no default) → deny with `403`.
- Upstream server unreachable → `502 Bad Gateway`.

**Binding:**

Same strategy as the credential proxy: bind to `PROXY_BIND_HOST` (docker0 bridge IP on Linux, `127.0.0.1` on macOS). Port defaults to `MCP_PROXY_PORT` (default: 3401), configurable via `.env` or `src/config.ts`.

**How to test:**

Unit tests (mock upstream):

| Scenario | Expected |
|----------|----------|
| `tools/call` with allowed tool | Forward to upstream, return response |
| `tools/call` with denied tool | Return MCP error, do NOT forward |
| `tools/call` with allowed tool but denied argument | Return MCP error |
| `initialize` request | Forward unconditionally |
| `tools/list` request | Forward unconditionally |
| Missing group header | `400` error |
| Unknown server name | `404` error |
| No policy for group | MCP error (denied) |

---

## Step 12: Orchestrator Integration

**Files:** `src/index.ts`, `src/container-runner.ts`

### 12a. Start the proxy at orchestrator startup

**File:** `src/index.ts`

After starting the credential proxy, start the MCP authorization proxy:

```typescript
import { startMcpAuthProxy } from './mcp-auth-proxy.js';
import { loadPolicies } from './mcp-policy.js';

// Build upstream map and policies from mcp-servers.json
const mcpConfig = JSON.parse(fs.readFileSync('data/mcp-servers.json', 'utf-8'));
const upstreams = new Map<string, string>();
for (const [name, srv] of Object.entries(mcpConfig.servers || {})) {
  const server = srv as { url?: string; proxy?: boolean };
  if (server.url && server.proxy) {
    upstreams.set(name, server.url);
  }
}

if (upstreams.size > 0) {
  const policies = loadPolicies(path.join(DATA_DIR, 'mcp-policies'));
  // Merge policy assignments from mcp-servers.json into the policy set
  for (const [name, srv] of Object.entries(mcpConfig.servers || {})) {
    const server = srv as { policies?: { default?: string; groups?: Record<string, string> } };
    if (server.policies) {
      policies.assignments.set(name, {
        defaultTier: server.policies.default,
        groups: new Map(Object.entries(server.policies.groups || {})),
      });
    }
  }
  await startMcpAuthProxy(MCP_PROXY_PORT, PROXY_BIND_HOST, { upstreams, policies });
}
```

### 12b. Rewrite container config for proxied servers

**File:** `src/container-runner.ts`

For remote entries with `proxy: true`, the container-side config must:

1. Point the URL at the proxy (not the real upstream):
   ```typescript
   const proxyUrl = `http://${CONTAINER_HOST_GATEWAY}:${MCP_PROXY_PORT}/${name}`;
   ```

2. Inject the group identity header:
   ```typescript
   containerServers[name] = {
     type: 'http',
     url: proxyUrl,
     headers: {
       'X-NanoClaw-Group': group.folder,
       ...(entry.headers || {}),
     },
     tools: resolvedToolsForGroup,  // see 12c
     // ...
   };
   ```

3. The `tools` array in the container config should be filtered to only include tools the group's policy allows. This prevents the agent from even seeing tools it can't call (defense-in-depth — the proxy also enforces, but reducing the tool surface avoids wasted attempts).

### 12c. Per-group tool filtering

When generating the container-side config for a `proxy: true` server:

1. Resolve the group's tier from `policies.groups[groupFolder]` or `policies.default`.
2. Load the tier's YAML policy.
3. Filter the server's `tools` array: keep only tools that pass `evaluatePolicy(tier, toolName, {})` (tool check with empty args — argument filtering happens at the proxy).
4. Filter the `toolSchemas` array to match.
5. Write only the permitted tools into the container config.

This means different groups see different tool lists for the same remote server. The per-group container config at `data/sessions/{groupFolder}/mcp-servers/config.json` is already group-specific, so this requires no new file structure.

**How to test:**

1. Configure mongodb with `proxy: true` and policies giving `main` admin access and `slack_ops` read-only.
2. Start orchestrator. Verify:
   - MCP auth proxy starts on port 3401.
   - `data/sessions/main/mcp-servers/config.json` has all tools for mongodb.
   - `data/sessions/slack_ops/mcp-servers/config.json` has only read tools for mongodb.
   - Both point to `http://host.docker.internal:3401/mongodb` (proxy URL), not the real server.
   - Both have `X-NanoClaw-Group` header set to their respective group folder.
3. Trigger a tool call from `slack_ops` to a denied tool. Verify it gets an MCP error.
4. Trigger a tool call from `main` to the same tool. Verify it succeeds.

---

## Step 13: Phase 2 Tests

### Unit Tests

**`src/mcp-policy.test.ts`** (new):

See Step 10 test table. Additionally:

| Test case | What it verifies |
|-----------|------------------|
| Load YAML policy from file | Parses correctly, returns PolicyRule |
| Missing policy file | Returns null, logs warning |
| Malformed YAML | Returns null, logs error |
| Tier resolution: explicit group | Correct tier returned |
| Tier resolution: fallback to default | Default tier returned when group not listed |
| Tier resolution: no default, no match | Returns null (fail-closed) |
| Glob pattern: `prefix*` matches | `"reports*"` matches `"reports-prod"` |
| Glob pattern: `prefix*` no match | `"reports*"` does not match `"logs-prod"` |
| Wildcard `"*"` matches anything | `"*"` matches `"anything"` |

**`src/mcp-auth-proxy.test.ts`** (new):

| Test case | What it verifies |
|-----------|------------------|
| Allowed tool call forwarded | Request reaches upstream, response returned |
| Denied tool call blocked | MCP error returned, upstream NOT called |
| Argument constraint enforced | Tool allowed but arg denied → MCP error |
| `initialize` forwarded unconditionally | No policy evaluation |
| `tools/list` forwarded unconditionally | No policy evaluation |
| Missing group header | `400` response |
| Unknown server | `404` response |
| No tier for group | MCP error (denied) |
| Upstream error | `502` response |
| Concurrent requests | All evaluated independently |

### Integration Tests (Manual Checklist)

| # | Scenario | Expected result |
|---|----------|-----------------|
| 1 | Main group calls admin-tier tool | Allowed, succeeds |
| 2 | Non-main group calls tool outside its tier | Denied, MCP error returned to agent |
| 3 | Non-main group calls allowed tool with denied argument value | Denied (if argument constraints configured) |
| 4 | Non-main group calls allowed tool with allowed argument value | Allowed, succeeds |
| 5 | Group not in policies, default tier exists | Default tier applied |
| 6 | Group not in policies, no default tier | All access denied |
| 7 | Policy file edited while orchestrator running | Requires restart (policies loaded at startup) |
| 8 | Proxy and direct remote servers coexist | Proxied servers go through proxy, non-proxied go direct |
| 9 | Atlas Cloud with RBAC + proxy | Both layers enforce access (defense-in-depth) |

---

# Phase 3: Skill Packaging

## Step 14: NanoClaw Skill Bundle

**Directory:** `.claude/skills/remote-mcp-servers/` (on the skill branch)

Package this feature as a NanoClaw skill so it can be installed into any NanoClaw instance by merging the skill branch. The skill file describes the feature, guides setup, and references the implementation files.

**What to create:**

```
.claude/skills/remote-mcp-servers/
├── SKILL.md                    # Main skill instructions
├── reference/
│   ├── spec.md                 # Pointer to docs/REMOTE-MCP-SERVERS.md
│   ├── config-examples.md      # Example mcp-servers.json configs
│   └── policy-examples.md      # Example YAML policy files
└── scripts/
    └── add-remote-server.sh    # Interactive setup helper (optional)
```

**`SKILL.md` content:**

```yaml
---
name: remote-mcp-servers
description: Connect agent containers to MCP servers running on the host over HTTP, with credential isolation and optional per-group access control via an authorization proxy.
disable-model-invocation: true
---
```

The markdown body should include:
- What the feature does (one paragraph summary)
- How to add a remote MCP server to `data/mcp-servers.json` (with both flat and access-level `tools` examples)
- How to create a skill bundle for the server in `container/skills/{name}/`
- How to set up the MCP authorization proxy (Phase 2)
- How to create YAML policy files
- Pointers to the full spec and plan docs
- Troubleshooting: common issues (server not running, port conflicts, schema discovery failures)

**Branch structure:**

The `skill/remote-mcp-servers` branch should contain all implementation code plus the skill bundle. When merged into another NanoClaw installation's `main`, the operator gets:
- The code changes (container-runner, agent-runner, proxy, policy loader)
- The skill file (for discoverability and documentation)
- Example policy files in `data/mcp-policies/`
- The spec and plan docs

**How to test:**

1. Verify the skill appears when asking Claude "What skills are available?"
2. Verify `/remote-mcp-servers` can be invoked and provides setup guidance.
3. Verify the branch merges cleanly into a fresh NanoClaw `main` (or at least identify expected conflicts).

**Commit:** After this step, commit with a message summarizing the full feature. This is the final commit on the skill branch.

---

# Dependency Graph (All Phases)

```
Phase 1: Remote MCP Connectivity
═════════════════════════════════

Step 6: Dependencies ────────────────┐
                                     │
Step 1: Config parsing ──────────────┤
                                     │
Step 2: HTTP schema discovery ───────┘
         │
         ▼
Step 3: URL rewriting + container config
         │
         ├───▶ Step 4: McpToolExecutor HTTP (Ollama)
         │
         └───▶ Step 5: Claude SDK mode HTTP
                  │
                  ▼
         Step 7: MongoDB deployment ──▶ Step 8: Skill file
                                              │
                                              ▼
                                       Step 9: Phase 1 tests

Phase 2: Authorization Proxy
════════════════════════════

Step 10: Policy loader ──────────────┐
                                     │
Step 11: Proxy server ───────────────┘
         │
         ▼
Step 12: Orchestrator integration
   (depends on Phase 1 Steps 1-3)
         │
         ▼
Step 13: Phase 2 tests

Phase 3: Skill Packaging
════════════════════════

Step 14: NanoClaw skill bundle
   (depends on all previous steps)
```

**Parallelizable:**
- Steps 4 and 5 are independent (both depend on Step 3).
- Steps 10 and 11 can start during Phase 1 (they have no Phase 1 dependency until Step 12).
- Step 7 can start at any time (deployment, not code).
- Step 6 should be done before Step 2.
- Step 14 must be last (it packages everything).

**Commit points:**
- After Step 9 (Phase 1 complete, all tests passing) — commit.
- After Step 13 (Phase 2 complete, all tests passing) — commit.
- After Step 14 (skill packaging complete) — final commit. Do not push.

---

# Files Changed (Summary)

| File | Change type | Step |
|------|-------------|------|
| `package.json` (root) | Add `@modelcontextprotocol/sdk`, `yaml` | 6 |
| `src/container-runner.ts` | Extend MCP server loop: remote entries, `ToolsDef` union type, `resolveTools()`, `resolveRemoteSkillContent()`, URL rewriting, proxy URL rewriting, per-group tool filtering | 1, 2, 3, 12 |
| `container/agent-runner/src/mcp-tool-executor.ts` | Extend `McpServerConfig`, add HTTP transport branch | 4 |
| `container/agent-runner/src/index.ts` | Handle `type: 'http'` and `skillContent` entries in SDK/Ollama config loading | 5 |
| `data/mcp-servers.json` | Add remote server entry (e.g. mongodb) with `tools` access levels, `proxy`, and `policies` | 7, 12 |
| `container/skills/{server-name}/` | New skill bundle directory per remote server | 8 |
| `src/mcp-policy.ts` | New: YAML policy loader and evaluator | 10 |
| `src/mcp-auth-proxy.ts` | New: MCP authorization proxy HTTP server | 11 |
| `src/index.ts` | Start auth proxy at orchestrator startup | 12 |
| `data/mcp-policies/{server}/*.yaml` | New: per-tier policy files | 12 |
| `src/mcp-policy.test.ts` | New: policy evaluation tests | 13 |
| `src/mcp-auth-proxy.test.ts` | New: proxy tests | 13 |
| `src/container-runner.test.ts` | New or extended: backward compat, access-level tools, skill resolution tests | 9 |
| `container/agent-runner/src/mcp-tool-executor.test.ts` | Extended: HTTP transport, mixed config tests | 9 |
| `.claude/skills/remote-mcp-servers/SKILL.md` | New: NanoClaw skill file for feature discoverability and setup | 14 |
| `.claude/skills/remote-mcp-servers/reference/` | New: config and policy examples | 14 |

**Files NOT changed:**

| File | Reason |
|------|--------|
| `src/credential-proxy.ts` | Separate concern (API key injection vs access control) |
| `src/env.ts` | No new env vars read by NanoClaw |
| `container/Dockerfile` | No new packages in agent image |
| `src/container-runtime.ts` | `CONTAINER_HOST_GATEWAY` and `PROXY_BIND_HOST` already exported |
| `container/agent-runner/package.json` | SDK already at `^1.12.1` |

---

# Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `StreamableHTTPClientTransport` not in SDK v1.12.1 | Low (added in v1.8.0) | Verify import before starting. Upgrade SDK if needed. |
| Remote MCP server's `--transport http` unstable | Medium | Test manually. Fall back to SSE transport if needed. Server-specific risk. |
| Host-side MCP SDK import ESM/CJS issues | Medium | Host is ESM, SDK exports ESM. Test import path early (Step 6). |
| Multiple containers overload single MCP server | Low | Most MCP servers are stateless. Upstream service handles connection pooling. |
| Proxy adds latency to every tool call | Low | Proxy is on localhost, HTTP parsing is trivial. Expect <1ms overhead per call. |
| Agent crafts raw HTTP to bypass proxy tool filter | Low | Proxy is the enforcement layer. Container config only lists allowed tools (double enforcement). HMAC token prevents group spoofing. |
| Argument-based filtering has gaps for complex queries | Expected | Argument filtering is best-effort. The primary enforcement is tool-level filtering. Combine with upstream RBAC for defense-in-depth where available. |
| YAML policy syntax errors break startup | Medium | Policy loader validates on load, logs errors for malformed files, and skips them (fail-closed: no policy = no access). |
| Skill bundle fetch (HTTP/MCP resources) fails | Low | Local skill directories are the primary mechanism. HTTP fetch is a convenience; failure falls through gracefully. |
| Backward compat regression for stdio-only configs | Medium | Explicit backward compat tests in Step 9. Stdio entries must produce identical output to pre-remote-MCP codebase. |
| `tools` field type change breaks existing parsers | Low | Flat `string[]` continues to work. Access-level `Record<string, string[]>` is opt-in. `resolveTools()` handles both. |
