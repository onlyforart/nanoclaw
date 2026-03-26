---
name: remote-mcp-servers
description: Connect agent containers to MCP servers running on the host over HTTP, with credential isolation and optional per-group access control via an authorization proxy.
disable-model-invocation: true
---

# Remote MCP Servers

Connect agent containers to MCP servers that run as long-lived processes on the host. Credentials stay on the host — containers see only a URL and tool schemas.

## What This Does

- **Credential isolation:** MCP servers with database connection strings, API keys, or OAuth tokens run on the host. Containers connect over HTTP — no credentials cross the container boundary.
- **Access-level tools:** The `tools` field supports both flat arrays (backward compatible) and access-level objects (`read`/`write`/`admin`). Set `readOnly: true` to register only read-level tools.
- **Per-group policies (optional):** An MCP authorization proxy enforces YAML policies per group. Different groups can have different tool and argument access.
- **Skill bundles:** Instruction files are resolved and inlined at config time — no filesystem mount needed for remote servers.

## Adding a Remote MCP Server

### 1. Start the MCP server on the host

Run it as a systemd service, launchd agent, or manually. It must support `--transport http` (Streamable HTTP transport).

Example for MongoDB:
```bash
npx mongodb-mcp-server --connectionString "$MDB_CONNECTION_STRING" --transport http --port 3200 --readOnly
```

### 2. Add to `data/mcp-servers.json`

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": {
        "read": ["find", "aggregate", "count", "list-collections"],
        "write": ["insert-many", "update-many"],
        "admin": ["delete-many", "drop-collection"]
      },
      "readOnly": true,
      "skill": "SKILL.md"
    }
  }
}
```

Remote entries have `url` instead of `hostPath`/`command`/`args`. A server MUST NOT have both.

### 3. Create a skill bundle (optional)

```
container/skills/{server-name}/
  SKILL.md              # Main instructions
  reference/
    schema.md           # Database schema docs
    query-patterns.md   # Common query examples
```

The orchestrator finds `container/skills/{name}/SKILL.md` by convention. Skill content is assembled (frontmatter stripped, referenced `.md` files inlined) and embedded in the container config as `skillContent`.

### 4. Restart NanoClaw

The orchestrator discovers remote servers at startup. Check logs for `Discovered remote MCP tool schemas`.

## Per-Group Access Control (Authorization Proxy)

For servers that need per-group permissions:

### 1. Enable the proxy

Add `proxy: true` and `policies` to the server entry:

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": { "read": ["find"], "write": ["insert-many"], "admin": ["drop-collection"] },
      "proxy": true,
      "policies": {
        "default": "readonly",
        "groups": {
          "main": "admin",
          "slack_analytics": "readonly"
        }
      }
    }
  }
}
```

### 2. Create YAML policy files

```
data/mcp-policies/{server-name}/{tier-name}.yaml
```

Example `data/mcp-policies/mongodb/readonly.yaml`:
```yaml
tools:
  allow:
    - find
    - aggregate
    - count
    - list-collections

arguments:
  database:
    allow:
      - analytics
```

Example `data/mcp-policies/mongodb/admin.yaml`:
```yaml
tools:
  allow: ["*"]
```

### 3. Restart NanoClaw

The proxy starts on port 3401 (configurable via `MCP_PROXY_PORT`). Container configs for proxied servers point to the proxy URL with the group identity header injected.

## Configuration Reference

### Remote server fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | HTTP URL of the MCP server endpoint |
| `tools` | `string[]` or `Record<string, string[]>` | Yes | Tool allowlist (flat or access-level) |
| `readOnly` | boolean | No | Only register `read`-level tools (default: false) |
| `proxy` | boolean | No | Route through authorization proxy (default: false) |
| `policies` | object | No | `{ default?: string, groups?: Record<string, string> }` |
| `headers` | `Record<string, string>` | No | Additional HTTP headers for every request |
| `skill` | string | No | Skill file path or name |

### Policy evaluation

1. **Deny takes precedence** over allow (both tools and arguments)
2. **No allow list = default-deny**
3. **Arguments not present** in the tool call are skipped
4. Pattern matching: `"*"` (any), `"prefix*"` (starts-with), exact match

## Troubleshooting

**Schema discovery fails (warning logged, server skipped):**
- Is the MCP server running? Check `systemctl --user status {service-name}`
- Does the URL match? Test with `curl -X POST http://127.0.0.1:3200/mcp`
- Port conflict? Check nothing else is on the configured port

**Container can't reach remote server:**
- URL is rewritten from `127.0.0.1`/`localhost` to `host.docker.internal` automatically
- On Linux, ensure Docker 20.10+ (for `--add-host=host.docker.internal:host-gateway`)

**Proxy denies all requests:**
- Check policy files exist in `data/mcp-policies/{server}/{tier}.yaml`
- Verify the group's tier is listed in `policies.groups` or a `policies.default` exists
- Check YAML syntax (use `yaml` lint)

## Full Specification

See [docs/REMOTE-MCP-SERVERS.md](docs/REMOTE-MCP-SERVERS.md) for the complete specification and [docs/REMOTE-MCP-SERVERS-PLAN.md](docs/REMOTE-MCP-SERVERS-PLAN.md) for the implementation plan.
