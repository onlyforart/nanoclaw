/**
 * Thin DB access layer for the e2e test harness. Opens the same
 * SQLite file the live nanoclaw process uses; relies on WAL concurrency
 * so we can inject rows while the daemon is running.
 *
 * Test rows are tagged by `sender_name LIKE '%(e2e-test)'` plus a
 * `source_type` value the harness reserves for itself. Cleanup uses
 * both markers.
 */

import Database from 'better-sqlite3';
import path from 'node:path';

const DEFAULT_DB_PATH = path.join(
  process.cwd(),
  'store',
  'messages.db',
);

let db: Database.Database | null = null;

export function openDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (!db) {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export const TEST_SOURCE_TYPE = 'e2e_test';
export const TEST_SENDER_SUFFIX = '(e2e-test)';

/**
 * Insert a synthetic observed_messages row. Returns the row id. Sender
 * info lives inside sanitised_json (sender_id / sender_name) — there's
 * no dedicated column on observed_messages.
 */
export function insertTestObservation(input: {
  source_chat_jid: string;
  source_message_id: string;
  raw_text: string;
  sanitised_json: string;
  sanitiser_version: string;
  created_at: string;
}): number {
  const database = openDb();
  const res = database
    .prepare(
      `INSERT INTO observed_messages
         (source_chat_jid, source_message_id, source_type,
          raw_text,
          sanitised_json, sanitiser_model, sanitiser_version,
          sanitised_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.source_chat_jid,
      input.source_message_id,
      TEST_SOURCE_TYPE,
      input.raw_text,
      input.sanitised_json,
      'e2e-test-harness',
      input.sanitiser_version,
      input.created_at,
      input.created_at,
    );
  return res.lastInsertRowid as number;
}

/**
 * Publish an observation.passive event pointing at a synthetic
 * observation row. The monitor's consume_events picks this up.
 */
export function publishObservationEvent(input: {
  observation_id: number;
  source_channel: string;
  source_message_id: string | null;
  sanitised: unknown;
  created_at: string;
}): number {
  const database = openDb();
  const payload = JSON.stringify({
    observation_id: input.observation_id,
    source_message_id: input.source_message_id,
    source_channel: input.source_channel,
    sanitised: input.sanitised,
  });
  const res = database
    .prepare(
      `INSERT INTO events
         (type, source_group, source_task_id, payload, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'observation.passive',
      input.source_channel,
      'e2e-test-harness',
      payload,
      `e2e-obs:${input.observation_id}`,
      input.created_at,
    );
  return res.lastInsertRowid as number;
}

/**
 * Bump the consumer task (pipeline:monitor) next_run to now so the
 * scheduler picks up the newly-published events on its next tick
 * without waiting for the fallback poll interval.
 */
export function bumpConsumerNextRun(taskId: string): void {
  openDb()
    .prepare(`UPDATE scheduled_tasks SET next_run = ? WHERE id = ?`)
    .run(new Date().toISOString(), taskId);
}

export interface ClusterSnapshot {
  id: number;
  cluster_key: string;
  status: string;
  summary: string;
  observation_count: number;
  observation_ids: number[];
  last_observation_at: string;
}

/**
 * Fetch clusters that contain any of the given observation ids (i.e.
 * the clusters this scenario's observations were assigned to).
 */
export function getClustersByObservations(
  observationIds: number[],
): ClusterSnapshot[] {
  if (observationIds.length === 0) return [];
  const rows = openDb()
    .prepare(
      `SELECT id, cluster_key, status, summary, observation_count,
              observation_ids, last_observation_at
         FROM pipeline_clusters
        ORDER BY last_observation_at DESC
        LIMIT 50`,
    )
    .all() as Array<{
    id: number;
    cluster_key: string;
    status: string;
    summary: string;
    observation_count: number;
    observation_ids: string;
    last_observation_at: string;
  }>;

  const idSet = new Set(observationIds);
  return rows
    .map((r) => {
      let parsed: number[] = [];
      try {
        const arr = JSON.parse(r.observation_ids);
        if (Array.isArray(arr)) {
          parsed = arr.filter((x): x is number => typeof x === 'number');
        }
      } catch {
        /* malformed */
      }
      return { ...r, observation_ids: parsed };
    })
    .filter((c) => c.observation_ids.some((id) => idSet.has(id)));
}

export interface DownstreamEventRow {
  id: number;
  type: string;
  status: string;
  payload: string;
  created_at: string;
  result_note: string | null;
}

/**
 * Fetch downstream (candidate.*, human_review_required, etc.) events
 * whose payload references any of the given observation ids.
 */
export function getDownstreamEvents(
  observationIds: number[],
  since: string,
): DownstreamEventRow[] {
  if (observationIds.length === 0) return [];
  const placeholders = observationIds.map(() => '?').join(',');
  return openDb()
    .prepare(
      `SELECT e.id, e.type, e.status, e.payload, e.created_at, e.result_note
         FROM events e
        WHERE e.created_at >= ?
          AND (e.type LIKE 'candidate.%'
               OR e.type = 'human_review_required'
               OR e.type = 'pipeline_event_timeout'
               OR e.type = 'pipeline_delivery_failed')
          AND EXISTS (
            SELECT 1 FROM json_each(json_extract(e.payload, '$.observation_ids')) je
             WHERE je.value IN (${placeholders})
          )
        ORDER BY e.created_at ASC, e.id ASC`,
    )
    .all(since, ...observationIds) as DownstreamEventRow[];
}

/**
 * Delete all e2e-test rows: observations tagged TEST_SOURCE_TYPE, the
 * observation.passive events referencing them, and any pipeline_clusters
 * that contain only test observations. Live rows are untouched.
 */
export function cleanupTestRows(): {
  observations: number;
  events: number;
  clusters: number;
} {
  const database = openDb();

  // Observations to remove
  const obsRows = database
    .prepare(
      `SELECT id FROM observed_messages WHERE source_type = ?`,
    )
    .all(TEST_SOURCE_TYPE) as Array<{ id: number }>;
  const obsIds = obsRows.map((r) => r.id);

  let clustersDeleted = 0;
  if (obsIds.length > 0) {
    const placeholders = obsIds.map(() => '?').join(',');
    // Find clusters composed entirely of test observations and drop them.
    const candidateClusters = database
      .prepare(
        `SELECT id, observation_ids FROM pipeline_clusters
          WHERE EXISTS (
            SELECT 1 FROM json_each(observation_ids) je
             WHERE je.value IN (${placeholders})
          )`,
      )
      .all(...obsIds) as Array<{ id: number; observation_ids: string }>;

    const testOnlyClusterIds: number[] = [];
    for (const c of candidateClusters) {
      try {
        const ids = JSON.parse(c.observation_ids) as number[];
        if (ids.every((id) => obsIds.includes(id))) {
          testOnlyClusterIds.push(c.id);
        }
      } catch {
        /* skip */
      }
    }
    if (testOnlyClusterIds.length > 0) {
      const clPh = testOnlyClusterIds.map(() => '?').join(',');
      const res = database
        .prepare(`DELETE FROM pipeline_clusters WHERE id IN (${clPh})`)
        .run(...testOnlyClusterIds);
      clustersDeleted = res.changes;
    }
  }

  // Delete events originating from the harness OR whose payload references
  // a test observation id.
  const eventsDelete = database
    .prepare(
      `DELETE FROM events
        WHERE source_task_id = ?
           OR dedupe_key LIKE ?
           OR dedupe_key LIKE ?`,
    )
    .run('e2e-test-harness', 'e2e-obs:%', 'timeout:%');

  // Delete observation rows last (events may FK-reference them logically)
  const obsDelete = database
    .prepare(`DELETE FROM observed_messages WHERE source_type = ?`)
    .run(TEST_SOURCE_TYPE);

  return {
    observations: obsDelete.changes,
    events: eventsDelete.changes,
    clusters: clustersDeleted,
  };
}
