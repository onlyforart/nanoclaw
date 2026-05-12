/**
 * Phase 4 — port v1 pipeline tables to v2.db. Runs after Phase 2.5 has
 * applied pipeline plugin migrations (so the v2 target tables exist).
 *
 * v1 source tables (in store/messages.db) and v2 destinations:
 *   - events                        → pipeline_events
 *   - observed_messages             → observed_messages (same name)
 *   - pipeline_clusters             → pipeline_clusters (same name)
 *   - pipeline_intake_log           → pipeline_intake_log (same name)
 *   - observation_labels            → observation_labels (same name)
 *   - reextraction_cache            → reextraction_cache (same name)
 *   - cross_channel_deliveries      → pipeline_cross_channel_deliveries
 *   - scheduled_tasks (WHERE execution_mode='host_pipeline')
 *                                   → pipeline_scheduled_tasks (drop execution_mode col)
 *   - task_run_logs (last 30 days)  → pipeline_task_run_logs
 *   - router_state (sanitiser_cursor:*)
 *                                   → pipeline_passive_subscriptions
 *
 * Idempotency: INSERT OR IGNORE on primary keys + unique indices.
 * Re-running produces identical row counts (no duplicates).
 *
 * Foreign keys: v2 pipeline_task_run_logs has FK to pipeline_scheduled_tasks.
 * Container task_run_logs entries reference container scheduled_tasks ids
 * that aren't in pipeline_scheduled_tasks — those FKs are inert because
 * better-sqlite3's default `new Database()` opens with FK enforcement OFF.
 * When the live nanoclaw service later opens v2.db with FK ON, existing
 * orphan rows are tolerated (FK is enforced for new writes only).
 */
import type Database from 'better-sqlite3';

import { inferChannelType, v2PlatformId } from '../../setup/migrate-v1/shared.js';

export interface PipelineMigratorOpts {
  /** ms epoch used to compute the 30-day window for task_run_logs (Q2=b). */
  taskRunLogsNow: number;
}

export interface PipelineMigratorResult {
  perTable: Record<string, number>;
  skipped: string[];
}

const TASK_RUN_LOGS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function migratePipelineTables(
  v1Db: Database.Database,
  v2Db: Database.Database,
  opts: PipelineMigratorOpts,
): PipelineMigratorResult {
  const perTable: Record<string, number> = {};
  const skipped: string[] = [];

  // Container-mode task_run_logs reference scheduled_tasks ids that we
  // intentionally don't port (only host_pipeline rows go to
  // pipeline_scheduled_tasks). Those become orphan FKs in
  // pipeline_task_run_logs. Disable FK enforcement for the bulk INSERT;
  // re-enable at the end. Production opens v2.db via getDb() with FK on,
  // tolerates orphan rows (FK is enforced for new writes only).
  const fkWas = (v2Db.pragma('foreign_keys', { simple: true }) as number) ?? 0;
  v2Db.pragma('foreign_keys = OFF');

  perTable.pipeline_events = portEvents(v1Db, v2Db, skipped);
  perTable.observed_messages = portObservedMessages(v1Db, v2Db, skipped);
  perTable.pipeline_clusters = portPipelineClusters(v1Db, v2Db, skipped);
  perTable.pipeline_intake_log = portPipelineIntakeLog(v1Db, v2Db, skipped);
  perTable.observation_labels = portObservationLabels(v1Db, v2Db, skipped);
  perTable.reextraction_cache = portReextractionCache(v1Db, v2Db, skipped);
  perTable.pipeline_cross_channel_deliveries = portCrossChannelDeliveries(v1Db, v2Db, skipped);
  perTable.pipeline_scheduled_tasks = portScheduledTasksHostPipeline(v1Db, v2Db, skipped);
  perTable.pipeline_task_run_logs = portTaskRunLogs(v1Db, v2Db, opts.taskRunLogsNow, skipped);
  perTable.pipeline_passive_subscriptions = portPassiveSubscriptions(v1Db, v2Db, skipped);

  v2Db.pragma(`foreign_keys = ${fkWas ? 'ON' : 'OFF'}`);

  return { perTable, skipped };
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
}

function portEvents(v1Db: Database.Database, v2Db: Database.Database, skipped: string[]): number {
  if (!tableExists(v1Db, 'events')) {
    skipped.push('events not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM events`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_events
       (id, type, source_group, source_task_id, payload, dedupe_key, created_at,
        expires_at, status, claimed_by, claimed_at, processed_at, result_note,
        attempted_by_trivial, trivial_failure_reason, replied_at)
       VALUES (@id, @type, @source_group, @source_task_id, @payload, @dedupe_key,
               @created_at, @expires_at, @status, @claimed_by, @claimed_at,
               @processed_at, @result_note, @attempted_by_trivial,
               @trivial_failure_reason, @replied_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run({
        id: r.id ?? null,
        type: r.type,
        source_group: r.source_group,
        source_task_id: r.source_task_id ?? null,
        payload: r.payload,
        dedupe_key: r.dedupe_key ?? null,
        created_at: r.created_at,
        expires_at: r.expires_at ?? null,
        status: r.status,
        claimed_by: r.claimed_by ?? null,
        claimed_at: r.claimed_at ?? null,
        processed_at: r.processed_at ?? null,
        result_note: r.result_note ?? null,
        attempted_by_trivial: r.attempted_by_trivial ?? 0,
        trivial_failure_reason: r.trivial_failure_reason ?? null,
        replied_at: r.replied_at ?? null,
      });
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portObservedMessages(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'observed_messages')) {
    skipped.push('observed_messages not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM observed_messages`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO observed_messages
       (id, source_chat_jid, source_message_id, source_type, source_task_id,
        source_group, intake_reason, intake_event_id, thread_id,
        related_observation_ids, raw_text, sanitised_json, sanitiser_model,
        sanitiser_version, flags, created_at, sanitised_at)
       VALUES (@id, @source_chat_jid, @source_message_id, @source_type,
               @source_task_id, @source_group, @intake_reason, @intake_event_id,
               @thread_id, @related_observation_ids, @raw_text, @sanitised_json,
               @sanitiser_model, @sanitiser_version, @flags, @created_at,
               @sanitised_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portPipelineClusters(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'pipeline_clusters')) {
    skipped.push('pipeline_clusters not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM pipeline_clusters`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_clusters
       (id, source_channel, cluster_key, status, summary, observation_ids,
        observation_count, last_observation_at, created_at, updated_at,
        resolved_at)
       VALUES (@id, @source_channel, @cluster_key, @status, @summary,
               @observation_ids, @observation_count, @last_observation_at,
               @created_at, @updated_at, @resolved_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portPipelineIntakeLog(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'pipeline_intake_log')) {
    skipped.push('pipeline_intake_log not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM pipeline_intake_log`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_intake_log
       (id, event_id, raw_text_hash, source_type, source_group, source_task_id,
        source_channel, source_message_id, reason, submitted_at, processed_at,
        observation_id)
       VALUES (@id, @event_id, @raw_text_hash, @source_type, @source_group,
               @source_task_id, @source_channel, @source_message_id, @reason,
               @submitted_at, @processed_at, @observation_id)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portObservationLabels(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'observation_labels')) {
    skipped.push('observation_labels not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM observation_labels`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO observation_labels
       (id, observation_id, labeller, intent, form, imperative_content,
        addressee, embedded_instructions, adversarial_smell, notes,
        expected_json, created_at, updated_at)
       VALUES (@id, @observation_id, @labeller, @intent, @form,
               @imperative_content, @addressee, @embedded_instructions,
               @adversarial_smell, @notes, @expected_json, @created_at,
               @updated_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portReextractionCache(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'reextraction_cache')) {
    skipped.push('reextraction_cache not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM reextraction_cache`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO reextraction_cache
       (id, observation_id, field_name, sanitiser_version, result_json, created_at)
       VALUES (@id, @observation_id, @field_name, @sanitiser_version,
               @result_json, @created_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portCrossChannelDeliveries(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'cross_channel_deliveries')) {
    skipped.push('cross_channel_deliveries not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM cross_channel_deliveries`)
    .all() as Array<{ key: string; delivered_at: string }>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_cross_channel_deliveries (key, delivered_at)
       VALUES (?, ?)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<{ key: string; delivered_at: string }>) => {
    for (const r of items) {
      const info = stmt.run(r.key, r.delivered_at);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portScheduledTasksHostPipeline(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'scheduled_tasks')) {
    skipped.push('scheduled_tasks not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT * FROM scheduled_tasks WHERE execution_mode = 'host_pipeline'`)
    .all() as Array<Record<string, unknown>>;
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
        context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms,
        use_agent_sdk, allowed_tools, allowed_send_targets, subscribed_event_types,
        fallback_poll_ms, batch_size, next_run, last_run, last_result, status,
        created_at)
       VALUES (@id, @group_folder, @chat_jid, @prompt, @schedule_type,
               @schedule_value, @context_mode, @model, @temperature, @timezone,
               @max_tool_rounds, @timeout_ms, @use_agent_sdk, @allowed_tools,
               @allowed_send_targets, @subscribed_event_types, @fallback_poll_ms,
               @batch_size, @next_run, @last_run, @last_result, @status,
               @created_at)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      // Strip execution_mode — table is host_pipeline by definition.
      const { execution_mode: _drop, ...rest } = r as Record<string, unknown> & { execution_mode?: unknown };
      void _drop;
      const info = stmt.run(rest);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portTaskRunLogs(
  v1Db: Database.Database,
  v2Db: Database.Database,
  now: number,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'task_run_logs')) {
    skipped.push('task_run_logs not present in v1 — skipped');
    return 0;
  }
  const cutoff = new Date(now - TASK_RUN_LOGS_WINDOW_MS).toISOString();
  const rows = v1Db
    .prepare(`SELECT * FROM task_run_logs WHERE run_at >= ?`)
    .all(cutoff) as Array<Record<string, unknown>>;
  // FK enforcement is OFF on our handle (better-sqlite3 default), so
  // container-task task_run_logs (whose task_id refers to scheduled_tasks
  // rows NOT in pipeline_scheduled_tasks) land cleanly as orphan rows.
  const stmt = v2Db.prepare(
    `INSERT OR IGNORE INTO pipeline_task_run_logs
       (id, task_id, run_at, duration_ms, status, result, error,
        input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, cost_usd)
       VALUES (@id, @task_id, @run_at, @duration_ms, @status, @result, @error,
               @input_tokens, @output_tokens, @cache_read_input_tokens,
               @cache_creation_input_tokens, @cost_usd)`,
  );
  let n = 0;
  const tx = v2Db.transaction((items: Array<Record<string, unknown>>) => {
    for (const r of items) {
      const info = stmt.run(r);
      if (info.changes > 0) n += 1;
    }
  });
  tx(rows);
  return n;
}

function portPassiveSubscriptions(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  if (!tableExists(v1Db, 'router_state')) {
    skipped.push('router_state not present in v1 — skipped');
    return 0;
  }
  const rows = v1Db
    .prepare(`SELECT key, value FROM router_state`)
    .all() as Array<{ key: string; value: string }>;
  // v1 chats provides channel_name for inferChannelType.
  const chatChannelByJid = new Map<string, string | null>();
  if (tableExists(v1Db, 'chats')) {
    const chats = v1Db
      .prepare(`SELECT jid, channel FROM chats`)
      .all() as Array<{ jid: string; channel: string | null }>;
    for (const c of chats) chatChannelByJid.set(c.jid, c.channel);
  }

  const stmt = v2Db.prepare(
    `INSERT INTO pipeline_passive_subscriptions
       (channel_type, platform_id, cursor, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(channel_type, platform_id) DO UPDATE SET
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`,
  );
  const now = new Date().toISOString();
  let n = 0;
  for (const r of rows) {
    if (!r.key.startsWith('sanitiser_cursor:')) {
      skipped.push(`router_state: dropped non-cursor key "${r.key}"`);
      continue;
    }
    const jid = r.key.slice('sanitiser_cursor:'.length);
    const channelType = inferChannelType(jid, chatChannelByJid.get(jid) ?? null);
    if (!channelType) {
      skipped.push(`router_state: cannot infer channel_type from "${r.key}"`);
      continue;
    }
    const platformId = v2PlatformId(channelType, jid);
    stmt.run(channelType, platformId, r.value, now, now);
    n += 1;
  }
  return n;
}
