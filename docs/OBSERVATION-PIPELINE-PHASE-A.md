# Observation Pipeline — Phase A Implementation Plan

## Context

The observation pipeline ([OBSERVATION-PIPELINE.md](OBSERVATION-PIPELINE.md)) lets one NanoClaw group monitor messages from another channel passively, sanitise them into structured observations, and respond through a human-gated path. Phase A is "unblocked infrastructure" — 8 work items that add new tables, columns, MCP tools, and enforcement. None changes existing behaviour until a pipeline task uses it.

Phase B (corpus) is largely complete. Phase A is the critical path.

## Ordering & PR Structure

Items are ordered by dependency. PRs 1–3 can proceed in parallel; PR 4 depends on 1+3; PR 5 depends on all.

```
PR 1 (events table + observed_messages)  ───┐
PR 2 (passive mode + read_chat_messages) ───┼── PR 4 (reliable send + YAML loader)
PR 3 (capability allow-lists)  ─────────────┘         │
                                                       └── PR 5 (web UI)
```

---

## PR 1: Events table + observed_messages skeleton (Items 1 + 4)

Pure additive schema — no existing behaviour changes.

### Item 1: `events` table + MCP tools

**src/db.ts** — in `createSchema()`:
- `CREATE TABLE IF NOT EXISTS events (...)` with exact schema from spec ([OBSERVATION-PIPELINE.md lines 99–119](OBSERVATION-PIPELINE.md))
- Two indexes: `idx_events_pending`, `idx_events_dedupe`
- New exported functions:
  - `publishEvent(type, sourceGroup, sourceTaskId, payload, dedupeKey?, ttlSeconds?)` — INSERT with ON CONFLICT dedupe. Returns `{ id, isNew }`.
  - `consumeEvents(types[], claimedBy, limit)` — atomic `UPDATE...RETURNING` to claim pending events
  - `ackEvent(eventId, status, note?)` — finalise as `done` or `failed`
  - `getRecentEvents(types?, limit?, includeProcessed?)` — for web UI

**src/types.ts** — add `EventRow` interface, `EventStatus` type

**container/agent-runner/src/ipc-mcp-stdio.ts** — three new `server.tool()`:
- `publish_event` — uses `writeIpcFileAndWaitForResult` (type: `'publish_event'`)
- `consume_events` — uses `writeIpcFileAndWaitForResult` (type: `'consume_events'`)
- `ack_event` — uses `writeIpcFileAndWaitForResult` (type: `'ack_event'`)

**src/ipc.ts** — three new cases in `processTaskIpc()`:
- `'publish_event'` → calls db `publishEvent()`, stub `bumpConsumerTaskNextRun()` (no-op until PR 4)
- `'consume_events'` → calls db `consumeEvents()`
- `'ack_event'` → calls db `ackEvent()`

**container/agent-runner/src/index.ts** — add `'publish_event'`, `'consume_events'`, `'ack_event'` to BOTH nanoclaw tool arrays (L654–670 Ollama, L850–863 Claude SDK), in both scheduled and non-scheduled lists. The `allowed_tools` mechanism (PR 3) will later restrict access.

**Tests (TDD — tests first):**
- `src/db.test.ts`: publishEvent insert + dedupe, consumeEvents atomic claim, ackEvent status transition, expired events skipped
- `src/ipc.test.ts` or new `src/ipc-events.test.ts`: IPC handler round-trip for publish/consume/ack cycle

### Item 4: `observed_messages` table

**src/db.ts** — in `createSchema()`:
- `CREATE TABLE IF NOT EXISTS observed_messages (...)` with schema from spec ([OBSERVATION-PIPELINE.md lines 192–209](OBSERVATION-PIPELINE.md))
- Unique index on `(source_chat_jid, source_message_id)`
- Stub functions: `insertObservedMessage()`, `getUnprocessedObservations()`, `updateObservationSanitised()`

**src/types.ts** — add `ObservedMessageRow` interface

**Tests:** insert, dedup, query unprocessed, update sanitised fields

---

## PR 2: Passive mode + read_chat_messages (Items 2 + 3)

Tightly coupled — passive mode captures messages; read_chat_messages reads them.

### Item 2: `mode` column on `registered_groups`

**src/db.ts** — migration:
```ts
try { database.exec(`ALTER TABLE registered_groups ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'`); } catch {}
```
- Update `getRegisteredGroup()` (~L713), `setRegisteredGroup()` (~L740), `getAllRegisteredGroups()` (~L784) to include `mode`

**src/types.ts** — add `mode?: 'active' | 'passive' | 'control'` to `RegisteredGroup` (L35–48)

**src/index.ts** — two short-circuit points:
1. `startMessageLoop()` (~L479): after looking up `group`, `if (group.mode === 'passive') continue;` before `queue.enqueueMessageCheck`
2. `processGroupMessages()` (~L220): `if (group.mode === 'passive') return true;` (belt-and-suspenders)

Messages are already stored in the DB by the channel handler before reaching the dispatch loop, so they remain available for read_chat_messages.

**src/ipc.ts** — in `handleRegisterGroup()` and `handleUpdateGroup()`: accept and persist `mode`

**container/agent-runner/src/ipc-mcp-stdio.ts** — add optional `mode` param to `register_group` and `update_group` tools

**Tests:**
- `src/db.test.ts`: register group with mode, verify round-trip
- `src/ipc-cross-channel.test.ts` (extend existing): passive mode group doesn't trigger agent

### Item 3: `read_chat_messages` MCP tool

**src/db.ts** — new function:
- `readChatMessages(chatJid, since?, limit?, includeBotMessages?)` → `{ messages: [...], cursor: string }`
  Uses `messages` table, filters by `timestamp > since`, returns last message timestamp as cursor

**container/agent-runner/src/ipc-mcp-stdio.ts** — new `server.tool()`:
- `read_chat_messages(target_group, since?, limit?, include_bot_messages?)` — resolves group via `available_groups.json`, uses `writeIpcFileAndWaitForResult`. Tool description includes observation framing from spec lines 181–185.

**src/ipc.ts** — new handler: `'read_chat_messages'` → calls `readChatMessages()`, returns result

**container/agent-runner/src/index.ts** — add `'read_chat_messages'` to both nanoclaw tool arrays (both scheduled and non-scheduled lists)

**Tests:**
- `src/db.test.ts`: readChatMessages with various `since` values, cursor, bot filtering
- IPC handler test: mock db, verify result structure

---

## PR 3: Capability allow-lists (Item 5)

Security-critical. Touches hot paths (container launch, IPC message handling).

### Item 5: `allowed_tools` + `allowed_send_targets`

**src/db.ts** — two migrations:
```ts
try { database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN allowed_tools TEXT`); } catch {}
try { database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN allowed_send_targets TEXT`); } catch {}
```
- Update task SELECT, `createTask()`, `updateTask()` to handle both columns (JSON text ↔ string[] parsing)

**src/types.ts** — add to `ScheduledTask`:
- `allowedTools?: string[] | null`
- `allowedSendTargets?: string[] | null`

**src/container-runner.ts** — add to `ContainerInput` (L54–68):
- `allowedTools?: string[] | null`
- `allowedSendTargets?: string[] | null`

**src/task-scheduler.ts** — in `runTask()` (~L185), pass to ContainerInput:
```ts
allowedTools: task.allowedTools ?? undefined,
allowedSendTargets: task.allowedSendTargets ?? undefined,
```

**container/agent-runner/src/index.ts** — modify tool filtering at BOTH paths (L654–670, L850–863):
- If `containerInput.allowedTools` is a non-null array, intersect it with current tool list
- Pass `allowedSendTargets` to MCP server via env `NANOCLAW_ALLOWED_SEND_TARGETS` (JSON)

**container/agent-runner/src/ipc-mcp-stdio.ts** — in `send_cross_channel_message`:
- Read `NANOCLAW_ALLOWED_SEND_TARGETS` env var
- If set, parse as JSON array, reject target not in list before sending

**src/ipc.ts** — host-side enforcement in cross_channel_message handler (~L174–197):
- Add `sourceTaskId` to cross-channel IPC data (container-side sends it)
- Host looks up task's `allowed_send_targets` from DB, rejects if target not listed
- Only enforced when `sourceTaskId` is present (backwards-compatible)

**Tests (TDD):**
- `src/db.test.ts`: createTask with allowed_tools/allowed_send_targets, verify round-trip
- `src/ipc-cross-channel.test.ts` (extend): cross-channel from task with restricted targets → blocked; unrestricted → allowed
- Container-side: test `NANOCLAW_ALLOWED_SEND_TARGETS` enforcement in send_cross_channel_message

---

## PR 4: Reliable cross-channel send + YAML loader (Items 6 + 7)

### Item 6: `send_cross_channel_message` reliability

**container/agent-runner/src/ipc-mcp-stdio.ts** — modify `send_cross_channel_message`:
1. Switch `writeIpcFile()` → `writeIpcFileAndWaitForResult()` (one-line change at ~L170)
2. Add optional `idempotency_key` parameter (z.string().optional())
3. Return actual success/failure from host

**src/ipc.ts** — modify cross_channel_message handler:
1. Add idempotency: in-memory Map of recent keys per target, 5-minute window (reuse pattern from `recentDeliveries` L60–95)
2. Write `.result` file after `sendMessage()` completes or fails (currently only task IPC gets results — extend to message IPC)
3. Wrap `sendMessage` in retry helper

**src/outbound-retry.ts** — new file:
- `sendWithRetry(sendFn, jid, text, maxRetries=3)` — exponential backoff (1s/2s/4s)
- Returns success/failure. On permanent failure, logs error.
- Keep it simple: no persistent queue for Phase A.

**Tests:**
- `src/outbound-retry.test.ts`: retries on transient errors, gives up after max
- IPC test: idempotency key dedup, wait-for-result confirmation

### Item 7: Pipeline YAML spec loader

**src/pipeline-loader.ts** — new file:
- `loadPipelineSpec(filePath)` — parse YAML, validate required fields (name, version, model, cron, system, tools, send_targets)
- `reconcilePipelineTasks(specs, teamGroupFolder, teamChatJid)` — for each spec:
  - ID convention: `pipeline:{spec.name}` (e.g. `pipeline:sanitiser`)
  - If no DB row exists, create task with mapped fields
  - If row exists and spec.version > stored version, update prompt/model/tools/targets
  - If versions match, no-op
  - `type: 'host_pipeline'` tasks: create DB row but mark as non-executable (Phase D adds host-side execution). Use convention: `context_mode: 'host_pipeline'`
- `loadAllPipelineSpecs(dir?)` — reads `pipeline/*.yaml`, calls `loadPipelineSpec` for each

**src/db.ts** — migration for latency mitigation:
```ts
try { database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN subscribed_event_types TEXT`); } catch {}
```
- `bumpConsumerTaskNextRun(eventType)` — `UPDATE scheduled_tasks SET next_run = ? WHERE status = 'active' AND subscribed_event_types LIKE ...`

**src/types.ts** — add `subscribedEventTypes?: string[] | null` to `ScheduledTask`

**src/index.ts** — call `reconcilePipelineTasks()` at startup, after `initDatabase()` and before `startSchedulerLoop()`

**pipeline/** — create directory with example YAML specs from the design doc (sanitiser.yaml, monitor.yaml, solver.yaml, responder.yaml). These are documentation/templates until Phase D/E wire them up.

**Tests (TDD):**
- `src/pipeline-loader.test.ts`: parse valid YAML, reject invalid, reconcile create/update/no-op, bumpConsumerTaskNextRun

---

## PR 5: Web UI surfaces (Item 8)

**Branch:** `skill/web-ui` — merge main into it first (currently ~10 commits behind), then implement, then merge back to main.

### Group detail: mode toggle

**webui/db.ts** — add `mode` to `GroupRow`, all GROUP SELECTs, `updateGroup()`
**webui/routes/groups.ts** — add `mode` to response and PATCH handler
**webui/public/app.js** — Settings tab: add mode dropdown (active/passive/control)

### Task detail: allowed_tools + allowed_send_targets

**webui/db.ts** — add `allowed_tools`, `allowed_send_targets` to `TaskRow`, ALLOWED_COLUMNS set, all TASK SELECTs
**webui/routes/tasks.ts** — add to response, create, and patch handlers (camelCase ↔ snake_case)
**webui/public/app.js** — Settings tab: add two textarea fields for JSON arrays

### Events log page

**webui/routes/events.ts** — new file: `handleGetEvents(query)`, `handleGetEventById(id)`
**webui/db.ts** — `getEvents(types?, status?, limit?)`, `getEventById(id)`
**webui/server.ts** — add routes: `GET /api/v1/events`, `GET /api/v1/events/:id`
**webui/public/app.js** — new Events tab/page: table with type, source_group, status, created_at, claimed_by. Expandable rows for payload JSON. Filters for type and status.

**Tests:** extend `webui/db.test.ts` with event queries; HTTP route tests

---

## Design Decisions (to resolve during implementation)

1. **bumpConsumerTaskNextRun**: Use `subscribed_event_types` column on scheduled_tasks (populated by YAML loader). Stub as no-op in PR 1, wire up in PR 4.

2. **Host-side allowed_send_targets enforcement**: Add `sourceTaskId` to cross-channel IPC data. Container passes `process.env.NANOCLAW_TASK_ID` (new env var, set by container-runner for scheduled tasks). Host looks up task's `allowed_send_targets`.

3. **Pipeline YAML group resolution**: Use env var or config for team channel JID/folder. The YAML specs don't encode the target — the loader receives it as a parameter.

4. **`host_pipeline` task type**: Create DB rows but don't execute in Phase A. Scheduler skips tasks where `context_mode === 'host_pipeline'`. Phase D adds host-side execution.

5. **Outbound retry**: Simple in-process wrapper with 3 retries + backoff. No persistent queue until Phase E.

6. **Event TTL cleanup**: Lazy — `consumeEvents` skips expired rows. Add background cleanup later if needed.

---

## Verification

After all PRs merge:
1. `npm run build` — compiles cleanly
2. `vitest run` — all tests pass
3. Register a group with `mode: 'passive'` via IPC — verify messages captured but agent not invoked
4. Use `read_chat_messages` from main group — verify messages from passive group returned
5. Create a task with `allowed_tools: ["send_message"]` — verify only send_message available in container
6. Create a task with `allowed_send_targets: ["slack_main"]` — verify cross-channel to other targets rejected
7. Publish/consume/ack events via MCP tools — verify full lifecycle
8. Place YAML specs in `pipeline/`, restart — verify tasks created in DB
9. Web UI: verify mode dropdown, allowed_tools/targets fields, events page
10. `./container/build.sh` + delete stale agent-runner-src + restart — verify container tools work

## Files Summary

| File | PRs | Nature |
|------|-----|--------|
| src/db.ts | 1,2,3,4 | schema + queries |
| src/types.ts | 1,2,3,4 | interfaces |
| src/ipc.ts | 1,2,3,4 | IPC handlers |
| src/index.ts | 2,4 | passive short-circuit, loader call |
| src/task-scheduler.ts | 3 | pass allowed_* to ContainerInput |
| src/container-runner.ts | 3 | ContainerInput interface |
| src/pipeline-loader.ts | 4 | **new** |
| src/outbound-retry.ts | 4 | **new** |
| container/agent-runner/src/ipc-mcp-stdio.ts | 1,2,3,4 | MCP tools |
| container/agent-runner/src/index.ts | 1,3 | tool arrays |
| webui/db.ts | 5 | queries |
| webui/routes/groups.ts | 5 | mode field |
| webui/routes/tasks.ts | 5 | allowed_* fields |
| webui/routes/events.ts | 5 | **new** |
| webui/server.ts | 5 | event routes |
| webui/public/app.js | 5 | UI additions |
