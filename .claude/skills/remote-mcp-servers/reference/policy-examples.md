# Policy Examples

Policy files live in `data/mcp-policies/{server-name}/{tier-name}.yaml`.

## Read-only analytics

```yaml
# data/mcp-policies/mongodb/readonly-analytics.yaml

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
      - events
      - sessions
      - reports
```

## Read-write to specific database

```yaml
# data/mcp-policies/mongodb/readwrite-agent-data.yaml

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

arguments:
  database:
    allow:
      - agent_data
  collection:
    allow:
      - "*"
```

## Full admin access

```yaml
# data/mcp-policies/mongodb/admin.yaml

tools:
  allow: ["*"]

arguments: {}
```

## S3 read-only to specific bucket

```yaml
# data/mcp-policies/s3/read-reports.yaml

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
      - reports-staging
```

## Pattern matching

- `"*"` matches any value
- `"prefix*"` matches values starting with `prefix` (e.g., `"reports*"` matches `"reports-prod"`)
- No regex support (security: avoids injection)
- Deny always takes precedence over allow
