import { getDb } from './connection.js';

export interface ContainerTaskRunLog {
  task_id: string;
  agent_group_id: string;
  group_folder: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result?: string | null;
  error?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cost_usd?: number | null;
}

export function insertContainerTaskRunLog(log: ContainerTaskRunLog): void {
  getDb()
    .prepare(
      `INSERT INTO container_task_run_logs
        (task_id, agent_group_id, group_folder, run_at, duration_ms, status,
         result, error, model,
         input_tokens, output_tokens,
         cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      log.task_id,
      log.agent_group_id,
      log.group_folder,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result ?? null,
      log.error ?? null,
      log.model ?? null,
      log.input_tokens ?? null,
      log.output_tokens ?? null,
      log.cache_read_input_tokens ?? null,
      log.cache_creation_input_tokens ?? null,
      log.cost_usd ?? null,
    );
}
