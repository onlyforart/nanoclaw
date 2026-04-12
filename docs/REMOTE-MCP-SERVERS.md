# Remote MCP Servers

Specification for connecting agent containers to MCP servers that run as long-lived processes on the host, with credentials isolated on the host side.

**Status:** Specification (not yet implemented)

## Problem

NanoClaw's current MCP server architecture requires every server to be spawned as a child process **inside** the agent container. The host resolves environment variables from `.env` and writes them into the container-side config. The container's MCP executor (or Claude SDK) then spawns the server process with those values in its environment.

This means credential values are **visible inside the container** — in the MCP config file, in process environment variables, and in `/proc/<pid>/environ`. While the container is isolated from the host, a compromised or prompt-injected agent could read these values during its execution.

For the Anthropic API, this is solved by the credential proxy: the container sends requests with a placeholder key, and the host-side proxy injects real credentials before forwarding upstream. But this approach only works for HTTP APIs where the proxy can inject headers.

Services that embed credentials in connection strings (MongoDB, PostgreSQL, Redis, etc.) or use non-HTTP protocols cannot use the existing credential proxy pattern. Installing their MCP servers inside the agent container would expose connection strings — including usernames and passwords — to the sandboxed agent process.

## Solution

Run credential-bearing MCP servers as **long-lived processes on the host** (or in their own containers on the host network). Agent containers connect to them over HTTP using the MCP protocol's Streamable HTTP transport. Credentials never cross the container boundary.

```
Agent Container                           Host
┌───────────────────┐                    ┌──────────────────────────┐
│                   │                    │  MCP Authorization Proxy │
│  mcp-tool-executor│── HTTP ───────────▶│  (per-group policy       │
│  (HTTP transport) │  X-NanoClaw-Group  │   enforcement)           │
│                   │                    └──────────┬───────────────┘
│  Claude SDK       │── HTTP ───────────▶           │ Forward allowed
│  (HTTP transport) │  X-NanoClaw-Group             │ calls only
│                   │                    ┌──────────▼───────────────┐
│  No credentials   │                    │  Remote MCP Server       │
│  in this zone     │                    │  (long-lived process)    │
└───────────────────┘                    │                          │
                                         │  Has credentials:        │
                                         │  - Connection strings    │
                                         │  - API keys              │
                                         └──────────┬───────────────┘
                                                    │
                                           ┌────────▼────────┐
                                           │  Upstream        │
                                           │  (MongoDB, etc.) │
                                           └─────────────────┘
```

This extends — not replaces — the existing stdio-based MCP server support. Servers that do not handle credentials (or where credential exposure is acceptable) can continue to run inside the container as child processes.

## Terminology

| Term | Meaning |
|------|---------|
| **Stdio MCP server** | Existing pattern. Server binary is mounted into the container and spawned as a child process. Communication via JSON-RPC over stdin/stdout. |
| **Remote MCP server** | New pattern. Server runs on the host as a long-lived process. Communication via MCP Streamable HTTP transport. |
| **Streamable HTTP** | MCP protocol transport over HTTP POST. Defined in the MCP specification. Supported by `@modelcontextprotocol/sdk` as `StreamableHTTPClientTransport`. |
| **MCP authorization proxy** | HTTP reverse proxy between agent containers and remote MCP servers. Inspects tool call arguments and enforces per-group access policies. |
| **Access tier** | A named set of permissions (allowed tools, databases, collections) that can be assigned to one or more groups. |

## Configuration

### Host-side: `data/mcp-servers.json`

Remote MCP servers are declared in the same `data/mcp-servers.json` file as stdio servers, distinguished by the presence of a `url` field instead of `hostPath` + `command` + `args`.

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": {
        "read": [
          "find", "aggregate", "count", "list-collections",
          "list-databases", "collection-schema", "collection-indexes",
          "db-stats", "explain", "export"
        ],
        "write": [
          "insert-many", "update-many",
          "create-collection", "create-index", "drop-index"
        ],
        "admin": [
          "delete-many", "drop-collection", "drop-database",
          "rename-collection"
        ]
      },
      "readOnly": true,
      "skill": "MONGODB.md"
    },

    "domain-tools": {
      "hostPath": "/home/user/custom-mcp-servers/domain-tools",
      "command": "node",
      "args": ["build/index.js"],
      "tools": ["check_venue_status", "get_maintenance_schedule"],
      "skill": "SKILL.md"
    }
  }
}
```

#### The `tools` field

The `tools` field accepts two formats:

**Flat array** (backward compatible — existing format):
```json
"tools": ["find", "aggregate", "count"]
```
All listed tools are registered. No access-level distinction. This is equivalent to the pre-remote-MCP behavior.

**Access-level object** (new format):
```json
"tools": {
  "read": ["find", "aggregate", "count", "list-collections", ...],
  "write": ["insert-many", "update-many", "create-collection", ...],
  "admin": ["delete-many", "drop-collection", "drop-database"]
}
```
Keys are access levels (arbitrary strings; `read`, `write`, `admin` are conventional). Values are arrays of tool names. The orchestrator resolves which levels to include based on:

- **`readOnly: true` on the server entry (Phase 1):** Only tools in the `read` level are registered. The MCP server is expected to run in read-only mode (e.g. `--readOnly` flag), so write/admin tools would fail at the server anyway — filtering them out avoids wasted tool calls and keeps the model's tool surface small.
- **`readOnly: false` or absent:** All levels are flattened and registered (same as a flat array).
- **Phase 2 (proxy with policies):** The group's policy tier determines which access levels are included. A `readonly-analytics` tier might allow only `read`; a `readwrite-agent-data` tier allows `read` + `write`; an `admin` tier allows all levels. See Per-Group Access Control below.

The container-side config always receives a **flat array** of tool names — access levels are resolved on the host and never cross the container boundary.

#### Remote server fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | HTTP(S) URL of the remote MCP server's Streamable HTTP endpoint. |
| `tools` | `string[]` or `Record<string, string[]>` | Yes | Tool allowlist. Flat array (all tools registered) or object keyed by access level (`read`, `write`, `admin`). See "The `tools` field" above. |
| `readOnly` | `boolean` | No | When `true` and `tools` uses the access-level format, only `read`-level tools are registered. Matches the MCP server's `--readOnly` mode. Default: `false`. |
| `skill` | `string` | No | Skill/instruction file. See "Skill Files for Remote Servers" below for resolution rules. |
| `headers` | `Record<string, string>` | No | Additional HTTP headers sent with every MCP request (e.g. for server-level auth tokens — see Security Model below). |

#### Distinguishing server types

A server entry is classified as:
- **Remote** if it has a `url` field.
- **Stdio** if it has a `hostPath` field (and no `url`).

A server entry MUST NOT have both `url` and `hostPath`. If both are present, the entry is rejected at startup with a configuration error.

#### Backward Compatibility

This feature is fully backward compatible:

- **Existing `mcp-servers.json` files work unchanged.** All new fields (`url`, `proxy`, `policies`, `headers`) are optional. Entries with only `hostPath` + `command` + `args` continue to be treated as stdio servers with identical behavior to the pre-remote-MCP codebase.
- **The `tools` field accepts both formats.** A flat `string[]` array (existing format) continues to work — all listed tools are registered with no access-level filtering. The new `Record<string, string[]>` format (keyed by access level) is opt-in.
- **The `proxy` field defaults to `false`.** Remote servers without `proxy: true` connect directly with no authorization proxy involvement.
- **No new required environment variables.** `MCP_PROXY_PORT` is optional (defaults to 3401). The proxy is only started if at least one server has `proxy: true`.
- **Container-side config format is extended, not changed.** Stdio entries in the generated `config.json` retain their existing shape (no `type` field). Only remote entries add the new `type: 'http'` field. The agent-runner treats entries without a `type` field identically to before.
- **No changes to the container image.** The `@modelcontextprotocol/sdk` in the agent-runner already supports `StreamableHTTPClientTransport`. No Dockerfile rebuild is needed for remote MCP support.

**Required:** Backward compatibility must be verified by explicit tests. Each step in the implementation plan includes test cases that confirm existing stdio-only configurations continue to work identically. A `mcp-servers.json` with no remote entries must produce the same container config, volume mounts, and runtime behavior as before this feature was added.

### Container-side: `/workspace/mcp-servers-config/config.json`

The generated container-side config includes remote servers with their URL and pre-discovered tool schemas:

```json
{
  "mongodb": {
    "type": "http",
    "url": "http://host.docker.internal:3200/mcp",
    "tools": ["find", "aggregate", "count"],
    "toolSchemas": [
      {
        "name": "find",
        "description": "Run a find query against a MongoDB collection",
        "inputSchema": { "type": "object", "properties": { "...": "..." } }
      }
    ],
    "skillContent": "# MongoDB MCP Server\n\nUse these tools to query the analytics database..."
  },
  "domain-tools": {
    "command": "node",
    "args": ["/workspace/mcp-servers/domain-tools/build/index.js"],
    "tools": ["check_venue_status", "get_maintenance_schedule"],
    "skill": "SKILL.md",
    "toolSchemas": ["..."]
  }
}
```

Key differences from stdio entries:
- Has `"type": "http"` field (stdio entries have no `type` field, preserving backward compatibility).
- Has `url` instead of `command` + `args`.
- The `url` is rewritten from `127.0.0.1` to `host.docker.internal` (same gateway resolution used by the credential proxy).
- No `env` field — credentials stay on the host.
- No volume mount — there is no server directory to mount.
- Has `skillContent` (inline string) instead of `skill` (file path). Skill content is resolved and inlined by the orchestrator at config generation time. See "Skill Files for Remote Servers" for how the host-side `skill` field is resolved into `skillContent`.
- The `tools` array is a **flat list** — access levels from the host-side config have already been resolved. The container never sees access-level metadata.

### Environment: `.env`

Each remote MCP server's credentials are configured in `.env` and referenced only by the server's startup script (never by NanoClaw's config):

```bash
# MongoDB MCP Server
MDB_CONNECTION_STRING=mongodb://user:password@mongodb.example.com:27017/mydb
MDB_MCP_PORT=3200
```

NanoClaw does **not** read, parse, or forward these variables. They exist solely for the server's own process or systemd unit. This is a deliberate separation: NanoClaw's `.env` reader (`src/env.ts`) only loads variables it explicitly requests by name, so adding new variables does not create accidental exposure.

## Server Lifecycle

### Startup

Remote MCP servers are **not managed by NanoClaw**. They must be started independently before the orchestrator starts, or the orchestrator must tolerate their absence.

Recommended: run each remote server as a systemd user service (Linux) or launchd agent (macOS), alongside the existing `nanoclaw` and `nanoclaw-webui` services.

### Startup Validation

When the orchestrator starts, for each remote MCP server entry:

1. **Connectivity check**: HTTP GET (or MCP `initialize` handshake) to the configured `url`. Timeout: 5 seconds.
2. **Tool schema discovery**: MCP `tools/list` request. Discovered tools are intersected with the configured `tools` allowlist. Tools not in the allowlist are discarded. Tools in the allowlist but not discovered are logged as warnings.
3. **Outcome on failure**: Log a warning and skip the server. The orchestrator starts normally. Containers launched while the server is down will not have access to its tools. This is consistent with how missing `hostPath` directories are handled for stdio servers.

Schema discovery results are cached for the lifetime of the orchestrator process. A restart re-discovers schemas.

> **Implementation note — policy reload timing:** YAML policy files in `data/mcp-policies/` are re-read from disk on every container spawn (not cached at startup). This means edited policy files take effect on the next agent invocation without restarting NanoClaw. However, the policy *assignments* (`policies.default` and `policies.groups` in `mcp-servers.json`) are loaded once at orchestrator startup — changes to tier-to-group mappings require a restart.

### Runtime

- The remote server runs continuously, independent of container lifecycle.
- Multiple agent containers may connect to the same remote server concurrently.
- The server is responsible for its own connection pooling, concurrency limits, and error handling.
- If the remote server becomes unavailable mid-conversation, tool calls will fail with an error returned to the agent (same as any MCP tool failure).

### Health Monitoring

No active health monitoring is specified. If the remote server crashes:
- In-flight tool calls fail with a transport error.
- New containers will fail tool schema discovery for that server (logged as warning).
- The orchestrator continues operating; other tools and servers are unaffected.

Future work may add periodic health checks and web UI status display, but this is out of scope for the initial implementation.

## Agent-Side Integration

### Claude SDK Mode (non-Ollama)

The Claude Agent SDK defines `McpHttpServerConfig` (`{ type: 'http', url, headers }`) in its types, but the HTTP transport silently hangs in practice (see [claude-agent-sdk-typescript#183](https://github.com/anthropics/claude-agent-sdk-typescript/issues/183)). Instead, the agent-runner converts HTTP MCP entries into stdio entries that spawn a **stdio-to-HTTP bridge** process.

The bridge (`container/agent-runner/src/mcp-http-bridge.ts`) uses the same `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk` that the Ollama direct mode path uses — one transport implementation, two invocation modes. This ensures identical MCP communication regardless of which backend runs the prompt.

```
Claude SDK                     Bridge Process               Remote MCP Server
┌──────────┐   stdio JSON-RPC  ┌──────────────────┐  HTTP   ┌──────────────┐
│ query()  │──────────────────▶│ mcp-http-bridge  │────────▶│ eks-kubectl  │
│          │◀──────────────────│ (child process)  │◀────────│ (host:3201)  │
└──────────┘                   └──────────────────┘         └──────────────┘
```

At runtime, the agent-runner rewrites container config entries:

```typescript
// Container config (from orchestrator):
{ "eks-kubectl": { "type": "http", "url": "http://172.17.0.1:3201/mcp", ... } }

// Rewritten for SDK mcpServers:
{ "eks-kubectl": { "command": "node", "args": ["mcp-http-bridge.js", "--url", "http://172.17.0.1:3201/mcp"] } }
```

The bridge accepts `--url <url>` and optional `--header <name>:<value>` (repeatable) arguments. Headers from the container config (e.g. `X-NanoClaw-Group` for the authorization proxy) are passed through.

### Ollama Direct Mode

The `McpToolExecutor` class (`container/agent-runner/src/mcp-tool-executor.ts`) currently supports only `StdioClientTransport`. It must be extended to support `StreamableHTTPClientTransport` for remote servers.

The `initialize()` method branches on the presence of `type: 'http'` in the server config:

- **Stdio server** (no `type` field or `type: 'stdio'`): existing behavior — spawn child process via `StdioClientTransport`.
- **HTTP server** (`type: 'http'`): create a `StreamableHTTPClientTransport` with the configured `url` and optional `headers`. Connect the MCP `Client` to it. Tool discovery and invocation proceed identically.

The `McpServerConfig` interface is extended:

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

The `close()` method must handle both transport types. For HTTP transports, this means closing the `Client` (which terminates the HTTP session). No child process cleanup is needed.

## Security Model

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Agent reads credentials from environment or filesystem | Credentials exist only on the host. Container receives a proxy URL, not a connection string. |
| Agent calls tools outside its group's permissions | Authorization proxy evaluates tool name and resource arguments against the group's YAML policy. Default-deny: unlisted tools and resources are rejected. |
| Agent accesses databases or collections outside its scope | Proxy inspects `database` and `collection` arguments in every `tools/call` request body. Requests targeting resources not in the group's `resources.allow` are rejected. |
| Agent spoofs group identity header | Header is embedded in read-only mounted config. Defense-in-depth: optional per-group HMAC token validated by proxy (HMAC key never enters container). |
| Agent bypasses proxy by connecting directly to MCP server | Bind the real MCP server to `127.0.0.1` on a non-standard port. The proxy is the only listener on the container-reachable port. Optionally, the MCP server can require a shared secret header that only the proxy knows. |
| Agent connects directly to upstream (bypassing MCP entirely) | Network-level: upstream service (e.g. MongoDB) should not be reachable from the container network, or should require credentials the container does not have. |
| Malicious MCP request causes server-side damage | Authorization proxy denies destructive tools (`delete-many`, `drop-collection`, etc.) for non-admin tiers. Even if the tool is allowed, resource scoping limits the blast radius to permitted databases/collections. |
| Container-to-container lateral movement via the proxy | Proxy evaluates each request independently using the caller's group identity. Group A cannot access Group B's resources even though they share the same proxy endpoint. |
| Another process on the host connects to the MCP server | Real MCP server bound to `127.0.0.1`. Proxy bound to `127.0.0.1` (or docker0 bridge on Linux). Only containers and host processes can reach it. |
| Policy file tampering | Policy files are on the host filesystem, outside the container. Agents cannot read or modify them. |
| Man-in-the-middle between container and host | Traffic flows over the Docker bridge network (`host.docker.internal`), which is local to the machine. For remote Docker hosts or cross-machine setups, use HTTPS for the proxy URL and configure TLS certificates. |

### Credential Boundary

```
                        ┌─── Credential boundary ───┐
                        │                            │
  Container             │         Host               │
  ┌──────────┐          │  ┌──────────────────┐      │
  │ Agent    │──HTTP───▶│  │ Remote MCP       │      │
  │          │          │  │ Server           │      │
  │ Sees:    │          │  │                  │      │
  │ - URL    │          │  │ Sees:            │      │
  │ - tools  │          │  │ - Conn string    │      │
  │ - schemas│          │  │ - API keys       │      │
  │          │          │  │ - OAuth tokens   │      │
  └──────────┘          │  └──────────────────┘      │
                        │                            │
                        └────────────────────────────┘
```

The credential boundary is identical in principle to the existing Anthropic credential proxy: the container knows how to reach the service (a URL) but not how to authenticate to the upstream.

### Network Binding

The remote MCP server MUST bind to an address reachable from containers:

| Platform | MCP server bind address | Container connects to |
|----------|------------------------|-----------------------|
| Linux (bare-metal Docker) | `127.0.0.1` or docker0 bridge IP | `host.docker.internal:<port>` |
| macOS (Docker Desktop) | `127.0.0.1` | `host.docker.internal:<port>` |
| macOS (Apple Container) | `127.0.0.1` | `host.docker.internal:<port>` |

This matches the binding strategy used by the credential proxy (`src/container-runtime.ts: detectProxyBindHost()`). However, unlike the credential proxy, the remote MCP server is not started by NanoClaw, so it must be configured to bind correctly by the operator.

For Linux bare-metal: if the MCP server binds to `127.0.0.1`, containers using the default Docker bridge network can reach it because `host.docker.internal` resolves to the host's loopback via Docker's `--add-host` mechanism (Docker 20.10+). For older Docker versions or custom network configurations, bind to the docker0 bridge IP instead.

### Per-Group Access Control (MCP Authorization Proxy)

#### Problem

A remote MCP server has a single set of credentials (e.g. a database connection string or API key) and exposes its full tool set to any connected client. All agent containers connect to the same server URL. Without additional enforcement:

- Every group can call every tool (including destructive ones).
- Every group can access every resource the credentials grant (databases, buckets, schemas, etc.).
- A prompt-injected agent in a low-privilege group can read or modify data belonging to other groups.

Some upstream services support their own RBAC (e.g. MongoDB Atlas Cloud, PostgreSQL roles, AWS IAM policies). But not all deployments enforce it — development databases, local instances, and services with permissive default configs may accept any authenticated connection with full privileges. We therefore cannot rely solely on the upstream service's access control.

#### Solution: MCP Authorization Proxy

An HTTP reverse proxy runs on the host between agent containers and the remote MCP server. It:

1. Identifies the calling group from a request header (`X-NanoClaw-Group`).
2. Looks up the group's access policy.
3. Inspects the MCP `tools/call` request body — tool name and arguments.
4. Allows or denies the call based on the policy.
5. Forwards allowed calls to the real MCP server; returns an MCP error for denied calls.

```
Container                          Host
┌────────────┐   X-NanoClaw-Group  ┌────────────────────┐        ┌──────────────┐
│ Agent      │──────────────────▶  │ Authorization Proxy │──────▶ │ Remote MCP   │
│            │◀──────────────────  │ (port 3401)         │◀────── │ (port 3200)  │
└────────────┘   MCP response      └────────────────────┘        └──────────────┘
                                          │
                                   Reads policy from
                                   data/mcp-policies/
```

This is architecturally identical to the credential proxy (`src/credential-proxy.ts`), which inspects HTTP requests and injects credentials. The authorization proxy inspects MCP request bodies and enforces access policies. Both are lightweight HTTP servers on the host.

#### Policy Configuration

Policies are defined in YAML files under `data/mcp-policies/`. Each file defines an **access tier** — a named set of permissions for a specific remote MCP server. The policy format is server-agnostic: it constrains **tool names** and **argument values** without knowing what the underlying service is.

**File:** `data/mcp-policies/{server-name}/{tier-name}.yaml`

```yaml
# data/mcp-policies/mongodb/readonly-analytics.yaml
#
# Read-only access to the analytics database.
# Assigned to groups that consume reports but should not modify data.

tools:
  allow:
    - find
    - aggregate
    - count
    - collection-schema
    - collection-indexes
    - db-stats
    - explain
    - export
    - list-collections

arguments:
  database:
    allow:
      - analytics
  collection:
    allow:
      - "events"
      - "sessions"
      - "reports"
```

```yaml
# data/mcp-policies/mongodb/readwrite-agent-data.yaml
#
# Read-write access to the agent_data database.
# For groups that persist structured information from agent tasks.

tools:
  allow:
    - find
    - aggregate
    - count
    - collection-schema
    - collection-indexes
    - db-stats
    - explain
    - list-collections
    - insert-many
    - update-many
    - create-collection
    - create-index
  deny:
    - delete-many
    - drop-collection
    - drop-database
    - drop-index
    - rename-collection

arguments:
  database:
    allow:
      - agent_data
  collection:
    allow:
      - "*"
```

```yaml
# data/mcp-policies/mongodb/admin.yaml
#
# Full access. Main group only.

tools:
  allow: ["*"]

arguments: {}
```

The same policy format works for any MCP server. For example, a hypothetical S3 MCP server:

```yaml
# data/mcp-policies/s3/read-reports-bucket.yaml

tools:
  allow:
    - get_object
    - list_objects
    - head_object
  deny:
    - delete_object
    - put_object

arguments:
  bucket:
    allow:
      - reports-prod
  prefix:
    allow:
      - "2026/*"
    deny:
      - "2026/internal/*"
```

Or a Postgres MCP server:

```yaml
# data/mcp-policies/postgres/readonly-public.yaml

tools:
  allow:
    - query
  deny:
    - execute

arguments:
  schema:
    allow:
      - public
```

#### Policy Evaluation Rules

**Tools:**

1. If `tools.deny` is present, any tool listed there is rejected — deny takes precedence over allow.
2. If `tools.allow` is present, only tools listed there are permitted.
3. `"*"` matches all tools.
4. A tool call for an unlisted tool is denied (default-deny).

**Arguments:**

The `arguments` section defines constraints on tool call argument values. Each key is an **argument name** (matching the name in the tool's input schema). Each value has optional `allow` and `deny` lists.

1. For each constrained argument name, the proxy extracts the value from the tool call's `arguments` object.
2. If the argument is **not present** in the tool call (e.g. `list-databases` has no `collection` argument), the constraint is skipped for that call — the tool allowlist alone governs access.
3. If the argument **is present**, it is checked:
   - If `deny` is defined and the value matches any deny pattern → **reject**.
   - If `allow` is defined and the value does **not** match any allow pattern → **reject**.
   - Otherwise → **pass**.
4. All constrained arguments must pass. A call is rejected if any single argument fails.

**Pattern matching:**

- Exact string match: `"analytics"` matches only `"analytics"`.
- Wildcard: `"*"` matches any value.
- Glob: `"2026/*"` matches `"2026/jan"`, `"2026/feb/data"`, etc. Uses simple prefix matching (split on `/` or `.`).
- The proxy does NOT support regex. Globs are sufficient for hierarchical resource names and avoid regex injection risks.

**Evaluation order:** tool check first, then argument checks. A call must pass all checks.

**No arguments section:** If the `arguments` key is absent or empty (`arguments: {}`), no argument constraints are applied — the tool allowlist alone governs access. This is the "admin" or "unrestricted" pattern.

#### Why This Is Server-Agnostic

The proxy knows nothing about MongoDB, Postgres, S3, or any other service. It only knows:

1. **Tool names** — strings from the MCP `tools/call` request.
2. **Argument names and values** — key-value pairs from the request's `arguments` object.
3. **Allow/deny lists** — string patterns from the YAML policy.

The policy author decides which argument names matter for access control. For MongoDB that's `database` and `collection`. For S3 it might be `bucket` and `prefix`. For a custom API it could be `endpoint` and `method`. The proxy doesn't care — it just matches strings.

This means:
- Adding a new MCP server type requires **zero proxy code changes** — only a new policy file.
- The proxy can front any MCP server that uses named arguments (which is all of them, per the MCP spec).
- Tool schemas (discovered at startup) can optionally be used to validate that constrained argument names actually exist in the tool's input schema, logging warnings for typos.

#### Group-to-Tier Assignment

Groups are assigned to access tiers in `data/mcp-servers.json` via a new `policies` field on remote server entries:

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "proxy": true,
      "tools": {
        "read": [
          "find", "aggregate", "count", "list-collections",
          "list-databases", "collection-schema", "collection-indexes",
          "db-stats", "explain", "export"
        ],
        "write": [
          "insert-many", "update-many",
          "create-collection", "create-index"
        ],
        "admin": [
          "delete-many", "drop-collection", "drop-database",
          "rename-collection"
        ]
      },
      "policies": {
        "default": "readonly-analytics",
        "groups": {
          "main": "admin",
          "slack_ops": "readwrite-agent-data",
          "whatsapp_reports": "readonly-analytics"
        }
      },
      "skill": "MONGODB.md"
    }
  }
}
```

When `proxy: true` is set, the `readOnly` flag is ignored — the proxy's per-group policies determine which access levels each group can use. Policy tiers can reference access levels by name (see YAML policy examples below).

**Resolution order:**

1. Look up the group's folder name in `policies.groups`.
2. If not found, use `policies.default`.
3. If no `policies.default`, deny all access (fail-closed).

The tier name maps to `data/mcp-policies/{server-name}/{tier-name}.yaml`.

#### Proxy Behavior

**When `proxy: true` is set on a remote server entry:**

1. The orchestrator starts the MCP authorization proxy on a dedicated port (`MCP_PROXY_PORT`, default 3401; port 3100 is reserved for the web UI), alongside the credential proxy.
2. The container-side config receives the **proxy URL** (not the real MCP server URL). E.g. `http://host.docker.internal:3401/mongodb` instead of `http://host.docker.internal:3200/mcp`.
3. The proxy URL includes the server name as a path segment, so a single proxy can front multiple remote servers.
4. The orchestrator injects `X-NanoClaw-Group: {groupFolder}` into the container-side config's `headers` field. The container passes this header with every MCP request.
5. The proxy reads the header, resolves the access tier, evaluates the policy, and either forwards or rejects.

**When `proxy: true` is NOT set** (or absent):

The container connects directly to the remote MCP server. No authorization proxy, no group header. This is the simpler path for servers that don't need per-group scoping.

**When `proxy: true` is set but `policies` is absent:**

The proxy starts and routes requests, but **all `tools/call` requests are denied** (fail-closed). The proxy requires a policy tier for each group, and with no assignments configured, `resolveTier()` returns `null` for every group. The container-runner's tool filtering also finds no tier, so the container config's `tools` array is empty — the model won't even see the tools. To enable access, add a `policies` field with at least a `default` tier pointing to a YAML policy file in `data/mcp-policies/`.

#### Pre-Filtered Tool Exposure

Access control is enforced at **two layers**, not one:

1. **Build time (container config generation):** When the orchestrator builds the per-group container config at `data/sessions/{groupFolder}/mcp-servers/config.json`, it resolves the group's policy tier and **filters the `tools` and `toolSchemas` arrays** to include only tools the group is permitted to call. The model never sees tools outside its tier.

2. **Runtime (proxy enforcement):** If the model somehow attempts a tool call that wasn't in its tool list (e.g. by guessing a name), the proxy rejects it.

This means:

- The Claude SDK's `allowedTools` list for a proxied server contains only the group's permitted tools. The model's tool-calling interface shows only what the group can use.
- The Ollama direct mode `McpToolExecutor` registers only the group's permitted tools. Ollama's function-calling schema contains only permitted tools.
- The `tools/list` response from the proxy returns all tools (for protocol correctness), but the agent-runner never registers tools that aren't in its filtered config. The config is the source of truth for what the model sees.

**Example:** If `mcp-servers.json` lists 14 tools for the mongodb server and the `readonly-analytics` tier allows 9 of them, a group assigned to that tier will have only those 9 tools in its container config. The model has no way to discover or call the other 5.

```
mcp-servers.json                    Container config (slack_ops)
─────────────────                   ────────────────────────────
tools: [                            tools: [
  find,                               find,
  aggregate,                           aggregate,
  count,                               count,
  list-collections,                    list-collections,
  list-databases,                      collection-schema,
  collection-schema,                   collection-indexes,
  collection-indexes,                  db-stats,
  insert-many,          ──filter──▶    explain,
  update-many,                         export
  create-collection,                 ]
  create-index,
  db-stats,
  explain,
  export
]
```

This is the primary enforcement mechanism. The proxy's runtime check is defense-in-depth.

#### Proxy Request Flow

```
1. Container sends MCP request to proxy:
   POST /mongodb HTTP/1.1
   X-NanoClaw-Group: slack_ops
   Content-Type: application/json

   {"jsonrpc":"2.0","id":1,"method":"tools/call",
    "params":{"name":"find","arguments":{"database":"agent_data","collection":"tasks","filter":{}}}}

2. Proxy parses request:
   - Server: "mongodb" (from URL path)
   - Group: "slack_ops" (from header)
   - Tier: "readwrite-agent-data" (from policies.groups)
   - Tool: "find" (from params.name)
   - Database: "agent_data" (from params.arguments.database)
   - Collection: "agent_data.tasks" (constructed)

3. Policy evaluation:
   - Tool "find" in tools.allow? YES
   - Tool "find" in tools.deny? NO
   - Database "agent_data" in resources.allow.databases? YES
   - Collection "agent_data.tasks" matches "agent_data.*"? YES
   → ALLOW

4. Proxy forwards request to real MCP server:
   POST /mcp HTTP/1.1
   Content-Type: application/json
   (same body)

5. Proxy returns MCP server response to container.
```

**Denied request:**

```
3. Policy evaluation:
   - Tool "delete-many" in tools.deny? YES
   → DENY

4. Proxy returns MCP error (does NOT forward):
   {"jsonrpc":"2.0","id":1,"error":{"code":-32600,
    "message":"Access denied: tool 'delete-many' is not permitted for group 'slack_ops'"}}
```

#### Group Identity Security

The `X-NanoClaw-Group` header is set by the **orchestrator** when generating the container-side config. The container passes it through but cannot forge a different group identity because:

1. The container-side config is written by the host and mounted **read-only** at `/workspace/mcp-servers-config/config.json`.
2. The header value is embedded in the config file. The agent reads it and passes it along, but the config file itself cannot be modified by the agent.
3. Even if an agent crafted a direct HTTP request with a different header, the proxy can optionally validate the header against the container's source IP and the known group-to-container mapping. However, since containers share the Docker bridge network, IP-based validation is weak. The primary protection is the read-only config mount.

For defense-in-depth, the proxy can also accept a **per-group HMAC token** instead of (or alongside) the group name. The orchestrator generates a short-lived HMAC of the group folder name using a secret key, and the proxy validates it. This prevents group spoofing even if the agent can craft arbitrary HTTP requests. The HMAC key never enters the container.

```
# Container config (generated by orchestrator, read-only mount):
{
  "mongodb": {
    "type": "http",
    "url": "http://host.docker.internal:3401/mongodb",
    "headers": {
      "X-NanoClaw-Group": "slack_ops",
      "X-NanoClaw-Token": "hmac-sha256:abc123..."
    }
  }
}
```

The HMAC approach is recommended but optional. Without it, the system still provides meaningful protection: the agent would need to discover the header mechanism, understand the proxy protocol, and craft a raw HTTP request — all while running in an ephemeral container with no persistent network knowledge.

## URL Rewriting

The `url` in `data/mcp-servers.json` is a **host-side** address. Containers cannot reach `127.0.0.1` on the host. The orchestrator rewrites the URL when generating the container-side config:

| Host-side URL | Container-side URL |
|---------------|--------------------|
| `http://127.0.0.1:3200/mcp` | `http://host.docker.internal:3200/mcp` |
| `http://localhost:3200/mcp` | `http://host.docker.internal:3200/mcp` |
| `http://172.17.0.1:3200/mcp` | Passed through unchanged |
| `http://mcp.example.com:3200/mcp` | Passed through unchanged |
| `https://mcp.example.com/mcp` | Passed through unchanged |

Rewriting applies only to `127.0.0.1` and `localhost`. All other hostnames are passed through verbatim. This matches the pattern used by the credential proxy (`ANTHROPIC_BASE_URL` rewriting).

## Tool Schema Discovery

### At Orchestrator Startup

For remote servers, the orchestrator performs tool schema discovery over HTTP (not stdio):

1. Create a `StreamableHTTPClientTransport` to the configured `url`.
2. Connect an MCP `Client`.
3. Call `client.listTools()`.
4. Filter discovered tools against the configured `tools` allowlist.
5. Cache the filtered schemas.
6. Disconnect.

This is the remote equivalent of the existing `discoverToolSchemas()` function, which spawns a stdio process, sends `initialize` + `tools/list`, and kills the process. The remote version connects, queries, and disconnects — the server continues running.

### At Container Launch

Cached schemas are written into the container-side config (same as for stdio servers). This avoids redundant discovery from inside the container:

- **Claude SDK mode**: The SDK discovers tools by connecting to the HTTP URL itself. Pre-cached schemas are informational (used for allowed-tools registration).
- **Ollama direct mode**: `McpToolExecutor` uses pre-cached schemas if present, avoiding a redundant `tools/list` call. Falls back to runtime discovery if schemas are missing.

## Example: MongoDB MCP Server

The specification above is server-agnostic — it works with any MCP server that supports Streamable HTTP transport. This section walks through a concrete deployment using `mongodb-mcp-server` (https://github.com/mongodb-js/mongodb-mcp-server) as an illustrative example. The same pattern applies to any remote MCP server (PostgreSQL, S3, custom APIs, etc.) — substitute the server-specific details (package name, connection string, port, tool names) as appropriate.

### Deployment

Run as a systemd user service alongside `nanoclaw` and `nanoclaw-webui`:

```ini
# ~/.config/systemd/user/mongodb-mcp.service
[Unit]
Description=MongoDB MCP Server
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/npx -y mongodb-mcp-server \
  --connectionString %E/nanoclaw/mongodb-connection-string \
  --transport http \
  --port 3200 \
  --readOnly
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

The connection string is read from a file or environment variable managed by systemd, not by NanoClaw. NanoClaw's `.env` may contain `MDB_MCP_PORT=3200` for documentation purposes, but NanoClaw does not read or forward it.

**`--readOnly` coordination:** The server's `--readOnly` flag and the config's `"readOnly": true` must agree. In Phase 1, both should be set — the server rejects writes at the MCP level, and the orchestrator doesn't register write tools (avoiding wasted attempts). In Phase 2, when the proxy handles per-group access control, remove both: the server runs with full capabilities, and the proxy determines which groups can call which tools.

Alternatively, run as a Docker container on the host network:

```bash
docker run -d \
  --name mongodb-mcp \
  --network host \
  -e MDB_MCP_CONNECTION_STRING="mongodb://user:pass@host:27017/db" \
  mdb/mongodb-mcp-server \
  --transport http --port 3200 --readOnly
```

### Recommended Tool Configuration

Define all tools in the access-level format, even if Phase 2 (proxy) is not yet in use. This makes the transition seamless:

```json
"tools": {
  "read": [
    "find", "aggregate", "count", "list-collections", "list-databases",
    "collection-schema", "collection-indexes", "db-stats", "explain",
    "export"
  ],
  "write": [
    "insert-many", "update-many", "create-collection", "create-index",
    "drop-index"
  ],
  "admin": [
    "delete-many", "drop-collection", "drop-database", "rename-collection"
  ]
}
```

**Phase 1 deployment:** Set `"readOnly": true` on the server entry **and** run the MCP server with `--readOnly`. Both sides agree: the server refuses write operations, and the orchestrator doesn't register write/admin tools. When you're ready to enable writes, remove `"readOnly": true` from the config and remove `--readOnly` from the server's systemd unit.

**Phase 2 deployment:** Set `"proxy": true` and configure per-group policies. The `readOnly` flag is ignored when `proxy` is active — policies control per-group access levels instead.

### Skill Bundles for Remote Servers

Skills follow the [Anthropic skill directory convention](https://code.claude.com/docs/en/skills): a directory with `SKILL.md` as the entrypoint, plus optional supporting files — reference documents, scripts, templates, and examples:

```
mongodb/
├── SKILL.md              # Main instructions (required)
├── reference/
│   ├── schema.md         # Database schema documentation
│   └── query-patterns.md # Common query patterns
├── scripts/
│   └── explain-plan.sh   # Script the agent can execute
└── examples/
    └── aggregation.md    # Example aggregation pipelines
```

`SKILL.md` references supporting files via markdown links (e.g. `[Schema docs](reference/schema.md)`). The agent-runner already resolves these references at runtime: it follows relative links, reads the referenced files, and inlines their content into the agent's context (see `container/agent-runner/src/index.ts:676-697`).

For **stdio servers**, the skill directory lives inside the server's `hostPath` and is mounted into the container alongside the server code. This works because the server directory is already volume-mounted.

For **remote servers**, there is no `hostPath` to mount. The skill bundle must be obtained separately and placed where the container can access it.

#### Skill delivery for remote servers

The existing container-runner (`src/container-runner.ts:265-275`) already syncs `container/skills/` directories into each group's session at `/home/node/.claude/skills/`. This is the delivery mechanism for remote server skills — regardless of how the skill is obtained, it ends up as a directory in `container/skills/{server-name}/` on the host, and the existing sync handles the rest.

**Resolution priority** — the orchestrator resolves the `skill` field for remote servers in this order:

1. **Local directory (convention):** If `container/skills/{server-name}/SKILL.md` exists, use it. This is the default and most common case — the operator authors the skill locally. The `skill` field in `mcp-servers.json` names the entrypoint file within the directory (default: `SKILL.md`).

2. **Local directory (explicit path):** If `skill` contains a path separator (`/`) and points to an existing file, it is treated as a path relative to the project root. E.g. `"skill": "container/skills/mongodb/SKILL.md"`.

3. **HTTP bundle fetch:** If `skill` starts with `http://` or `https://`:
   - If the URL ends in `.tar.gz` or `.zip`, the orchestrator fetches and extracts the archive into `container/skills/{server-name}/` at startup. This enables MCP server operators to publish complete skill bundles.
   - If the URL points to a single file (no archive extension), it is fetched and written to `container/skills/{server-name}/SKILL.md`. Referenced markdown files are resolved as relative URLs against the skill URL's base path (e.g. if `SKILL.md` contains `[Schema](reference/schema.md)`, the orchestrator fetches `{base-url}/reference/schema.md`).
   - Fetched bundles are cached locally. The orchestrator re-fetches only if the local copy is missing or on explicit restart.

4. **MCP resources (automatic discovery):** During tool schema discovery (Step 2), the orchestrator also calls `resources/list` on the remote server. If the server exposes resources with a URI scheme of `skill://` (e.g. `skill://mongodb/SKILL`), their content is fetched and written to `container/skills/{server-name}/`. This requires no `skill` field in the config — discovery is automatic. Servers that don't implement MCP resources simply return an empty list (or an error, which is ignored).

If multiple sources resolve successfully, the first match wins (local > HTTP > MCP resource).

#### How it reaches the container

Once the skill bundle is in `container/skills/{server-name}/`, the existing pipeline handles delivery:

1. **Sync (container-runner.ts:265-275):** The `container/skills/{server-name}/` directory is copied into the group's session directory at `data/sessions/{group}/.claude/skills/{server-name}/`, which is mounted at `/home/node/.claude/skills/{server-name}/` in the container.

2. **Agent-runner resolution (index.ts:662-704):** The agent-runner looks for skill files at `/home/node/.claude/skills/{server-name}/SKILL.md` as a fallback candidate. When found, it:
   - Strips YAML frontmatter
   - Resolves relative markdown links (`[Title](reference/schema.md)`) by reading and inlining the referenced files
   - Stores the assembled content in the `serverSkills` map for lazy injection

3. **Lazy injection (ollama-chat-engine.ts:252-261):** On the first tool call from a given MCP server, the skill content is injected as a system message. Scripts and other non-markdown files remain available at the filesystem path for the agent to execute.

4. **Claude SDK mode:** The Claude SDK has access to the skill directory at `/home/node/.claude/skills/{server-name}/` and can read files from it. SKILL.md content is available for the model to reference.

#### Inline skill content for Ollama direct mode

For Ollama direct mode, the orchestrator additionally inlines the assembled skill content (SKILL.md + resolved markdown references) into the container-side config as a `skillContent` field:

```json
{
  "mongodb": {
    "type": "http",
    "url": "http://host.docker.internal:3200/mcp",
    "tools": ["find", "aggregate", "count"],
    "skillContent": "# MongoDB MCP Server\n\nUse these tools to query...\n\n### Schema\n\n..."
  }
}
```

This allows the agent-runner to use `skillContent` directly for lazy injection without reading from the filesystem. The filesystem copy is still present for scripts and other non-markdown assets that need to be executed.

#### What the skill file should contain

A skill bundle for a remote MCP server (e.g. `container/skills/{server-name}/SKILL.md`) should include:

- Available tools and what each does
- Connection context (what service/instance this connects to)
- Schema or resource conventions (naming, structure, patterns)
- Example operations for common tasks
- Guidance on choosing between similar tools (e.g. `query` vs `aggregate`, `get_object` vs `list_objects`)
- Note which tool access levels are available (if using `readOnly` or policy-based filtering)
- Links to supporting reference docs for detailed schema, API, or runbook information

This is injected into the Ollama context on first tool use (same mechanism as existing skill files).

## Changes Required

### New files

- **`src/mcp-auth-proxy.ts`** — MCP authorization proxy. HTTP server that accepts MCP requests from containers, evaluates per-group YAML policies, and forwards allowed calls to the real remote MCP server. Architecturally similar to `src/credential-proxy.ts`.
- **`data/mcp-policies/{server}/{tier}.yaml`** — Per-server, per-tier access policy files.
- **`container/skills/{server-name}/`** — Skill bundle directories for remote MCP servers (one per server, following the Anthropic skill directory convention).

### `src/container-runner.ts`

- Parse `url`-based entries in `data/mcp-servers.json` as remote servers.
- Support `tools` as either `string[]` (backward compat) or `Record<string, string[]>` (access levels).
- Resolve access-level tools based on `readOnly` flag (Phase 1) or proxy policies (Phase 2).
- Skip `hostPath` resolution, existence check, and volume mounting for remote servers.
- Perform tool schema discovery over HTTP (new code path alongside existing stdio discovery).
- Rewrite `127.0.0.1` / `localhost` URLs to `host.docker.internal` in container-side config.
- Write `type: 'http'` and `url` fields into container-side config for remote entries.
- Resolve skill bundles for remote servers and inline assembled content as `skillContent`.
- Reject entries that have both `url` and `hostPath`.
- For `proxy: true` entries: rewrite the container-side URL to point at the authorization proxy (not the real MCP server). Inject `X-NanoClaw-Group` header (and optional HMAC token) into the container config's `headers` field, resolved per-group.

### `src/index.ts`

- Start the MCP authorization proxy alongside the credential proxy at orchestrator startup.
- Pass proxy config (port, policy directory, upstream server URLs) from `mcp-servers.json`.

### `container/agent-runner/src/mcp-tool-executor.ts`

- Import `StreamableHTTPClientTransport` from `@modelcontextprotocol/sdk`.
- Branch `initialize()` on `config.type === 'http'`: use HTTP transport instead of stdio.
- Handle HTTP transport cleanup in `close()`.

### `container/agent-runner/src/index.ts`

- When building the `mcpServers` config for the Claude SDK, pass remote entries with `type: 'http'` and `url` (instead of `command` + `args`).

### `container/agent-runner/package.json`

- Verify `@modelcontextprotocol/sdk` version includes `StreamableHTTPClientTransport` (available since SDK v1.8.0; current version is v1.12.1+).

### `package.json` (root)

- Add `@modelcontextprotocol/sdk` for host-side HTTP schema discovery.
- Add `yaml` (or `js-yaml`) for YAML policy parsing.

### No changes to:

- `src/credential-proxy.ts` — remote MCP servers handle their own credentials; the auth proxy is a separate concern.
- `src/env.ts` — no new env vars are read by NanoClaw.
- `container/Dockerfile` — no new packages installed in the agent image.
- `docs/SECURITY.md` — reference this document for the remote MCP security model.
