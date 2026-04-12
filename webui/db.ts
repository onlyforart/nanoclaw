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
  temperature: number | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  show_thinking: number | null;
  mode: string;
  threading_mode: string;
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
  temperature: number | null;
  timezone: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  use_agent_sdk: number;
  allowed_tools: string | null;
  allowed_send_targets: string | null;
  execution_mode: string;
  subscribed_event_types: string | null;
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
              model, temperature, max_tool_rounds, timeout_ms, show_thinking,
              mode, threading_mode
       FROM registered_groups ORDER BY name`,
    )
    .all() as GroupRow[];
}

export function getGroupByFolder(folder: string): GroupRow | undefined {
  return db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, is_main, requires_trigger,
              model, temperature, max_tool_rounds, timeout_ms, show_thinking,
              mode, threading_mode
       FROM registered_groups WHERE folder = ?`,
    )
    .get(folder) as GroupRow | undefined;
}

export function updateGroup(
  folder: string,
  updates: { model?: string; temperature?: number | null; max_tool_rounds?: number; timeout_ms?: number; show_thinking?: number | null; mode?: string; threading_mode?: string },
): boolean {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.model !== undefined) {
    setClauses.push('model = ?');
    values.push(updates.model);
  }
  if (updates.temperature !== undefined) {
    setClauses.push('temperature = ?');
    values.push(updates.temperature);
  }
  if (updates.max_tool_rounds !== undefined) {
    setClauses.push('max_tool_rounds = ?');
    values.push(updates.max_tool_rounds);
  }
  if (updates.timeout_ms !== undefined) {
    setClauses.push('timeout_ms = ?');
    values.push(updates.timeout_ms);
  }
  if (updates.show_thinking !== undefined) {
    setClauses.push('show_thinking = ?');
    values.push(updates.show_thinking);
  }
  if (updates.mode !== undefined) {
    setClauses.push('mode = ?');
    values.push(updates.mode);
  }
  if (updates.threading_mode !== undefined) {
    setClauses.push('threading_mode = ?');
    values.push(updates.threading_mode);
  }

  if (setClauses.length === 0) return false;

  values.push(folder);
  const result = db
    .prepare(`UPDATE registered_groups SET ${setClauses.join(', ')} WHERE folder = ?`)
    .run(...values);
  return result.changes > 0;
}

// --- Tasks ---

export function createTask(task: {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string;
  model: string | null;
  temperature: number | null;
  timezone: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  use_agent_sdk?: number;
  next_run: string | null;
  status: string;
  created_at: string;
}): void {
  db.prepare(
    `INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk,
       next_run, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id, task.group_folder, task.chat_jid, task.prompt,
    task.schedule_type, task.schedule_value, task.context_mode,
    task.model, task.temperature, task.timezone,
    task.max_tool_rounds, task.timeout_ms, task.use_agent_sdk ?? 0,
    task.next_run, task.status, task.created_at,
  );
}

export function getTasksByGroup(groupFolder: string): TaskRow[] {
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk,
              allowed_tools, allowed_send_targets, execution_mode, subscribed_event_types,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks WHERE group_folder = ? ORDER BY next_run`,
    )
    .all(groupFolder) as TaskRow[];
}

export function getTaskById(id: string): TaskRow | undefined {
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk,
              allowed_tools, allowed_send_targets, execution_mode, subscribed_event_types,
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
    context_mode?: string;
    model?: string;
    temperature?: number;
    timezone?: string;
    max_tool_rounds?: number;
    timeout_ms?: number;
    use_agent_sdk?: number;
    allowed_tools?: string | null;
    allowed_send_targets?: string | null;
    execution_mode?: string;
    subscribed_event_types?: string | null;
    status?: string;
    next_run?: string;
  },
): boolean {
  const ALLOWED_COLUMNS = new Set([
    'prompt', 'schedule_type', 'schedule_value', 'context_mode',
    'model', 'temperature', 'timezone', 'max_tool_rounds',
    'timeout_ms', 'use_agent_sdk', 'status', 'next_run',
    'allowed_tools', 'allowed_send_targets', 'execution_mode', 'subscribed_event_types',
  ]);

  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && ALLOWED_COLUMNS.has(key)) {
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

export function deleteTask(id: string): boolean {
  db.prepare(`DELETE FROM task_run_logs WHERE task_id = ?`).run(id);
  const result = db.prepare(`DELETE FROM scheduled_tasks WHERE id = ?`).run(id);
  return result.changes > 0;
}

// --- Token Usage ---

export interface DailyTokenUsageRow {
  date: string;
  uncached: number;
  cached: number;
  cost: number | null;
}

interface DailyModelTokenRow {
  date: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_creation: number;
  actual_cost: number | null;
  rows_with_cost: number;
  total_rows: number;
}

export function getGroupDailyTokensByModel(groupFolder: string, days: number = 30): DailyModelTokenRow[] {
  return db
    .prepare(
      `SELECT date(r.run_at) as date,
              COALESCE(NULLIF(t.model, ''), g.model) as model,
              SUM(COALESCE(r.input_tokens, 0)) as input_tokens,
              SUM(COALESCE(r.output_tokens, 0)) as output_tokens,
              SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read,
              SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation,
              SUM(r.cost_usd) as actual_cost,
              COUNT(r.cost_usd) as rows_with_cost,
              COUNT(*) as total_rows
       FROM task_run_logs r
       JOIN scheduled_tasks t ON r.task_id = t.id
       LEFT JOIN registered_groups g ON t.group_folder = g.folder
       WHERE t.group_folder = ?
         AND r.run_at >= date('now', ? || ' days')
       GROUP BY date(r.run_at), COALESCE(NULLIF(t.model, ''), g.model)
       ORDER BY date(r.run_at)`,
    )
    .all(groupFolder, -(days - 1)) as DailyModelTokenRow[];
}

// --- Task Runs ---

// --- Pipeline ---

export function getPipelineTasks(): TaskRow[] {
  return db
    .prepare(
      `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
              context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk,
              allowed_tools, allowed_send_targets, execution_mode, subscribed_event_types,
              next_run, last_run, last_result, status, created_at
       FROM scheduled_tasks WHERE id LIKE 'pipeline:%' ORDER BY id`,
    )
    .all() as TaskRow[];
}

export interface PipelineTokenUsageRow {
  date: string;
  task_id: string;
  input_tokens: number;
  output_tokens: number;
  runs: number;
}

export function getPipelineTokenUsage(days: number = 30): PipelineTokenUsageRow[] {
  return db
    .prepare(
      `SELECT date(r.run_at) as date,
              r.task_id,
              SUM(COALESCE(r.input_tokens, 0)) as input_tokens,
              SUM(COALESCE(r.output_tokens, 0)) as output_tokens,
              COUNT(*) as runs
       FROM task_run_logs r
       WHERE r.task_id LIKE 'pipeline:%'
         AND r.run_at >= date('now', ? || ' days')
       GROUP BY date(r.run_at), r.task_id
       ORDER BY date(r.run_at)`,
    )
    .all(-(days - 1)) as PipelineTokenUsageRow[];
}

export function getPassiveChannels(): GroupRow[] {
  return db
    .prepare(
      `SELECT jid, name, folder, trigger_pattern, is_main, requires_trigger,
              model, temperature, max_tool_rounds, timeout_ms, show_thinking,
              mode, threading_mode
       FROM registered_groups WHERE mode = 'passive' ORDER BY name`,
    )
    .all() as GroupRow[];
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

// --- Events ---

export interface EventRow {
  id: number;
  type: string;
  source_group: string;
  source_task_id: string | null;
  payload: string;
  dedupe_key: string | null;
  created_at: string;
  expires_at: string | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  processed_at: string | null;
  result_note: string | null;
}

export function getEvents(opts?: {
  types?: string[];
  status?: string;
  limit?: number;
}): EventRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.types && opts.types.length > 0) {
    const placeholders = opts.types.map(() => '?').join(', ');
    conditions.push(`type IN (${placeholders})`);
    params.push(...opts.types);
  }
  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  params.push(limit);

  return db
    .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as EventRow[];
}

// --- Pipeline Intake Logs ---

export interface IntakeLogRow {
  id: number;
  event_id: number;
  raw_text_hash: string;
  source_type: string;
  source_group: string;
  source_task_id: string | null;
  source_channel: string | null;
  source_message_id: string | null;
  reason: string;
  submitted_at: string;
  processed_at: string | null;
  observation_id: number | null;
}

export function getIntakeLogs(opts?: {
  includeProcessed?: boolean;
  limit?: number;
}): IntakeLogRow[] {
  const includeProcessed = opts?.includeProcessed ?? true;
  const limit = opts?.limit ?? 100;
  const condition = includeProcessed ? '' : 'WHERE processed_at IS NULL';

  return db
    .prepare(
      `SELECT * FROM pipeline_intake_log ${condition}
       ORDER BY submitted_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as IntakeLogRow[];
}

// --- Observations + Labels ---

export interface ObservationListRow {
  id: number;
  source_chat_jid: string | null;
  source_message_id: string | null;
  source_type: string;
  raw_text: string;
  created_at: string;
  sanitised_json: string | null;
  has_label: number;
}

export interface ObservationDetailRow {
  id: number;
  source_chat_jid: string | null;
  source_message_id: string | null;
  source_type: string;
  source_task_id: string | null;
  source_group: string | null;
  intake_reason: string | null;
  raw_text: string;
  sanitised_json: string | null;
  flags: string | null;
  created_at: string;
  sanitised_at: string | null;
  label: ObservationLabelRow | null;
}

export interface ObservationLabelRow {
  id: number;
  labeller: string;
  intent: string | null;
  form: string | null;
  imperative_content: string | null;
  addressee: string | null;
  embedded_instructions: string | null;
  adversarial_smell: number | null;
  notes: string | null;
  expected_json: string | null;
  created_at: string;
  updated_at: string | null;
}

export function getObservations(opts?: {
  labelled?: boolean;
  sourceType?: string;
  limit?: number;
  offset?: number;
}): ObservationListRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.sourceType) {
    conditions.push('o.source_type = ?');
    params.push(opts.sourceType);
  }
  if (opts?.labelled === true) {
    conditions.push('l.id IS NOT NULL');
  } else if (opts?.labelled === false) {
    conditions.push('l.id IS NULL');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;

  return db
    .prepare(
      `SELECT o.id, o.source_chat_jid, o.source_message_id, o.source_type,
              o.raw_text, o.created_at, o.sanitised_json,
              CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END AS has_label
       FROM observed_messages o
       LEFT JOIN observation_labels l ON l.observation_id = o.id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ObservationListRow[];
}

export function getObservationById(id: number): ObservationDetailRow | undefined {
  const row = db
    .prepare(
      `SELECT id, source_chat_jid, source_message_id, source_type,
              source_task_id, source_group, intake_reason,
              raw_text, sanitised_json, flags, created_at, sanitised_at
       FROM observed_messages WHERE id = ?`,
    )
    .get(id) as any;
  if (!row) return undefined;

  const label = db
    .prepare('SELECT * FROM observation_labels WHERE observation_id = ?')
    .get(id) as ObservationLabelRow | undefined;

  return { ...row, label: label ?? null };
}

export function upsertLabel(
  observationId: number,
  fields: {
    intent?: string;
    form?: string;
    imperative_content?: string;
    addressee?: string;
    embedded_instructions?: string;
    adversarial_smell?: boolean;
    notes?: string;
    expected_json?: string;
  },
): void {
  const now = new Date().toISOString();
  const existing = db
    .prepare('SELECT id FROM observation_labels WHERE observation_id = ?')
    .get(observationId) as { id: number } | undefined;

  if (existing) {
    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        setClauses.push(`${key} = ?`);
        values.push(key === 'adversarial_smell' ? (value ? 1 : 0) : value);
      }
    }
    values.push(existing.id);
    db.prepare(
      `UPDATE observation_labels SET ${setClauses.join(', ')} WHERE id = ?`,
    ).run(...values);
  } else {
    db.prepare(
      `INSERT INTO observation_labels
         (observation_id, labeller, intent, form, imperative_content, addressee,
          embedded_instructions, adversarial_smell, notes, expected_json, created_at)
       VALUES (?, 'human', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      observationId,
      fields.intent ?? null,
      fields.form ?? null,
      fields.imperative_content ?? null,
      fields.addressee ?? null,
      fields.embedded_instructions ?? null,
      fields.adversarial_smell != null ? (fields.adversarial_smell ? 1 : 0) : null,
      fields.notes ?? null,
      fields.expected_json ?? null,
      now,
    );
  }
}
