import type { Migration } from './index.js';

/**
 * Central log of CONTAINER-mode scheduled-task runs. v1 nanoclaw had a
 * single `task_run_logs` table covering both container and host tasks;
 * the v2 cutover retired it and the pipeline plugin added its own
 * pipeline-only `pipeline_task_run_logs`. Container task runs went
 * unrecorded — webui token-usage / cost charts therefore broke for
 * every non-pipeline group.
 *
 * Container engine emits a `run_report` message (kind='run_report') into
 * messages_out at task completion; the host's `delivery.ts` reads it
 * and inserts here. No FK to a tasks table: container task definitions
 * live in per-session `messages_in` rows, not centrally, so there's
 * nothing to reference.
 *
 * Columns mirror the pipeline-side `pipeline_task_run_logs` so the
 * webui can `UNION ALL` the two tables cleanly. Index on (group_folder,
 * run_at) for the daily-bucket query.
 */
export const migration015: Migration = {
  version: 15,
  name: 'container-task-run-logs',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS container_task_run_logs (
        id                          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id                     TEXT NOT NULL,
        agent_group_id              TEXT NOT NULL,
        group_folder                TEXT NOT NULL,
        run_at                      TEXT NOT NULL,
        duration_ms                 INTEGER NOT NULL,
        status                      TEXT NOT NULL,
        result                      TEXT,
        error                       TEXT,
        model                       TEXT,
        input_tokens                INTEGER,
        output_tokens               INTEGER,
        cache_read_input_tokens     INTEGER,
        cache_creation_input_tokens INTEGER,
        cost_usd                    REAL
      );
      CREATE INDEX IF NOT EXISTS idx_container_task_run_logs_lookup
        ON container_task_run_logs(group_folder, run_at);
      CREATE INDEX IF NOT EXISTS idx_container_task_run_logs_by_task
        ON container_task_run_logs(task_id, run_at);
    `);
  },
};
