import Database from 'better-sqlite3';
import path from 'node:path';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'store', 'messages.db');

let db: Database.Database;

export function initDb(dbPath?: string): void {
  db = new Database(dbPath ?? DEFAULT_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}

export interface GroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  is_main: number;
  requires_trigger: number;
  model: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
}

export interface TaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  model: string | null;
  timezone: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
}

export interface TaskRunRow {
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

// --- Groups ---

export function getAllGroups(): GroupRow[] {
  return db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, is_main, requires_trigger,
              model, max_tool_rounds, timeout_ms
       FROM registered_groups ORDER BY name`,
    )
    .all() as GroupRow[];
}

export function getGroupByFolder(folder: string): GroupRow | undefined {
  return db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, is_main, requires_trigger,
              model, max_tool_rounds, timeout_ms
       FROM registered_groups WHERE folder = ?`,
    )
    .get(folder) as GroupRow | undefined;
}

export function updateGroup(
  folder: string,
  updates: { model?: string; max_tool_rounds?: number; timeout_ms?: number },
): boolean {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.model !== undefined) {
    setClauses.push('model = ?');
    values.push(updates.model);
  }
  if (updates.max_tool_rounds !== undefined) {
    setClauses.push('max_tool_rounds = ?');
    values.push(updates.max_tool_rounds);
  }
  if (updates.timeout_ms !== undefined) {
    setClauses.push('timeout_ms = ?');
    values.push(updates.timeout_ms);
  }

  if (setClauses.length === 0) return false;

  values.push(folder);
  const result = db
    .prepare(`UPDATE registered_groups SET ${setClauses.join(', ')} WHERE folder = ?`)
    .run(...values);
  return result.changes > 0;
}

// --- Tasks ---

export function getTasksByGroup(groupFolder: string): TaskRow[] {
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, model, timezone, max_tool_rounds, timeout_ms,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks WHERE group_folder = ? ORDER BY next_run`,
    )
    .all(groupFolder) as TaskRow[];
}

export function getTaskById(id: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, model, timezone, max_tool_rounds, timeout_ms,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks WHERE id = ?`,
    )
    .get(id) as TaskRow | undefined;
}

export function updateTask(
  id: string,
  updates: {
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    model?: string;
    timezone?: string;
    max_tool_rounds?: number;
    timeout_ms?: number;
    status?: string;
    next_run?: string;
  },
): boolean {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return false;

  values.push(id);
  const result = db
    .prepare(`UPDATE scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

// --- Task Runs ---

export function getTaskRuns(taskId: string, limit: number = 20): TaskRunRow[] {
  return db
    .prepare(
      `SELECT run_at, duration_ms, status, result, error
       FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskRunRow[];
}
