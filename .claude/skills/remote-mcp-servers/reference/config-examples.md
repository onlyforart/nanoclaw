# Configuration Examples

## Minimal remote server (no proxy)

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": ["find", "aggregate", "count"],
      "skill": "SKILL.md"
    }
  }
}
```

## Access-level tools with readOnly

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": {
        "read": [
          "find", "aggregate", "count", "list-collections",
          "collection-schema", "collection-indexes", "db-stats"
        ],
        "write": ["insert-many", "update-many", "create-collection"],
        "admin": ["delete-many", "drop-collection", "drop-database"]
      },
      "readOnly": true,
      "skill": "SKILL.md"
    }
  }
}
```

Only `read`-level tools are registered. Define all levels upfront for when you enable the proxy later.

## Proxied server with per-group policies

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": {
        "read": ["find", "aggregate", "count"],
        "write": ["insert-many", "update-many"],
        "admin": ["delete-many", "drop-collection"]
      },
      "proxy": true,
      "policies": {
        "default": "readonly",
        "groups": {
          "main": "admin",
          "slack_analytics": "readonly",
          "slack_ops": "readwrite"
        }
      }
    }
  }
}
```

## Mixed stdio and remote servers

```json
{
  "servers": {
    "mongodb": {
      "url": "http://127.0.0.1:3200/mcp",
      "tools": ["find", "aggregate"],
      "readOnly": true
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
