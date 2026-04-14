# Observation Pipeline — Persistent Cluster State

Design spec for cluster-aware monitoring with compacted summaries.

## Problem

The monitor processes observations independently per invocation. Related messages about the same topic (e.g., a change-control being approved, pushed, tested, confirmed) arrive across minutes and are classified individually as `fyi/status_update` — missing the operationally significant cluster. The corpus analysis identified that clustering on temporal proximity, participant overlap, and topic signals is the right approach for low-threading channels.

## Design: Cluster Journal

A `pipeline_clusters` table stores a **compacted running summary** per active cluster. The monitor reads active clusters alongside new observations, classifies observations against existing clusters, and updates the cluster summary. Summaries are periodically compacted to prevent unbounded growth.

### Schema

```sql
CREATE TABLE IF NOT EXISTS pipeline_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel TEXT NOT NULL,
  cluster_key TEXT NOT NULL,           -- e.g. "CHG0038216" or "topic:widget-loading"
  status TEXT NOT NULL DEFAULT 'active', -- active | resolved | expired
  summary TEXT NOT NULL,               -- compacted cluster summary (rolling)
  observation_ids TEXT NOT NULL,        -- JSON array of all observation IDs
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_observation_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(source_channel, cluster_key)
);
```

Key decisions:
- `cluster_key` is a human-readable identifier derived by the monitor (ticket number, topic slug, etc.)
- `summary` is the compacted record — updated after each batch, compacted when it grows too long
- `observation_ids` is an audit trail (array of IDs, not the full observations)
- Clusters expire after a configurable period of inactivity (e.g. 24h)

### IPC tools for cluster state

Two new tools in the MCP server, handled on the host side:

**`get_active_clusters`** — returns active clusters for given source channels
```
Parameters:
  source_channels: string[]

Returns:
  { clusters: [{ id, cluster_key, source_channel, summary, observation_count, last_observation_at }] }
```

**`update_cluster`** — create or update a cluster with new observations
```
Parameters:
  source_channel: string
  cluster_key: string
  summary: string              -- updated summary including new observations
  observation_ids: number[]    -- IDs to add to the cluster
  status?: 'active' | 'resolved'
```

### Monitor flow (updated)

```
Step 1: Call consume_events to get new observations
Step 2: If no events, stop
Step 3: Call get_active_clusters for the source channels in this batch
Step 4: For each observation:
  - Check if it relates to an existing active cluster (by topic, ticket,
    participant, temporal proximity)
  - If yes: merge into the existing cluster
  - If no: start a new cluster
Step 5: For each cluster that changed:
  - Call update_cluster with the new summary and added observation IDs
  - If the cluster now meets escalation triggers, publish candidate.escalation
Step 6: Ack all consumed events
```

The monitor sees the cluster summaries (not raw messages) so it can relate new messages to ongoing activity without re-reading old observations.

### Compaction strategy

The `summary` field is written by the monitor on each update. It's already a compacted representation — the monitor summarises the cluster state in natural language, not raw message concatenation. As the cluster grows, the summary stays bounded because the monitor rewrites it each time (incorporating new information into the existing summary).

No separate compaction step needed — the monitor IS the compactor. Each invocation reads the previous summary + new observations and writes an updated summary. The summary is bounded by the monitor's output, not by observation count.

### Cluster lifecycle

| Status | Meaning |
|--------|---------|
| `active` | Receiving new observations, summary updated regularly |
| `resolved` | Monitor detects resolution (fix_announcement + confirmation) and marks resolved |
| `expired` | No new observations for 24h — periodic cleanup marks as expired |

### Escalation from clusters

Clusters can trigger escalation in two ways:

1. **Immediate**: a new observation in the cluster matches individual triggers (incident, issue, fresh_report)
2. **Accumulated**: the cluster summary indicates operational significance even though no single message does (e.g., deployment cluster with confirmation)

The monitor decides based on the cluster summary, not individual messages.

## Files to modify

| File | Change |
|------|--------|
| `src/db.ts` | `pipeline_clusters` table, CRUD functions (`getActiveClusters`, `upsertCluster`, `expireStaleClusters`) |
| `src/ipc.ts` | Handle `get_active_clusters` and `update_cluster` IPC types |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | New MCP tools: `get_active_clusters`, `update_cluster` |
| `pipeline/monitor.yaml` | Updated prompt with cluster-aware flow |
| `src/host-pipeline-executor.ts` | Call `expireStaleClusters` during cleanup |

## Verification

1. `npm test` — all tests pass
2. `npm run build` — compiles
3. Manual: post related messages in passive channel, verify:
   - First message creates a new cluster
   - Follow-up messages merge into the existing cluster
   - Cluster summary updates reflect all messages
   - Deployment confirmations trigger escalation from the cluster
   - Clusters expire after inactivity
