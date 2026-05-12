import Database from 'better-sqlite3';
import path from 'node:path';

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'v2.db');

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

// ---------------------------------------------------------------------------
// v2 entity-model interfaces (for Commit 2 agent-group-primary UI)
// ---------------------------------------------------------------------------

export interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

export interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number;
  unknown_sender_policy: string;
  created_at: string;
}

export interface WiringRow {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: string | null;
  engage_pattern: string | null;
  sender_scope: string | null;
  ignored_message_policy: string | null;
  session_mode: string;
  priority: number;
  is_main: number;
  model: string | null;
  temperature: number | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  show_thinking: number | null;
  pipeline_replies_blocked: number;
  created_at: string;
}

// ---------------------------------------------------------------------------
// v1-compat shims (routes that Commit 2 will redesign still consume these)
// ---------------------------------------------------------------------------
// GroupRow is a flat per-wiring view. Each (agent_group, messaging_group)
// wiring becomes one row. Returns one row per agent_group folder (the
// is_main wiring, or first by priority) so v1 consumers that assume
// folder uniqueness keep working until Commit 2 reshapes the routes.

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
  pipeline_replies_blocked: number;
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
  fallback_poll_ms: number | null;
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

// ---------------------------------------------------------------------------
// v2-native entity helpers (Commit 2 will consume these for the redesigned UX)
// ---------------------------------------------------------------------------

export function getAllAgentGroups(): AgentGroupRow[] {
  return db
    .prepare(
      `SELECT id, name, folder, agent_provider, created_at
       FROM agent_groups ORDER BY name`,
    )
    .all() as AgentGroupRow[];
}

export function getAgentGroupByFolder(folder: string): AgentGroupRow | undefined {
  return db
    .prepare(
      `SELECT id, name, folder, agent_provider, created_at
       FROM agent_groups WHERE folder = ?`,
    )
    .get(folder) as AgentGroupRow | undefined;
}

export function getMessagingGroups(): MessagingGroupRow[] {
  return db
    .prepare(
      `SELECT id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at
       FROM messaging_groups ORDER BY channel_type, platform_id`,
    )
    .all() as MessagingGroupRow[];
}

export function getMessagingGroupById(id: string): MessagingGroupRow | undefined {
  return db
    .prepare(
      `SELECT id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at
       FROM messaging_groups WHERE id = ?`,
    )
    .get(id) as MessagingGroupRow | undefined;
}

export function getAgentGroupsForMessagingGroup(messagingGroupId: string): AgentGroupRow[] {
  return db
    .prepare(
      `SELECT ag.id, ag.name, ag.folder, ag.agent_provider, ag.created_at
       FROM agent_groups ag
       JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
       WHERE mga.messaging_group_id = ?
       ORDER BY mga.is_main DESC, mga.priority DESC, ag.name`,
    )
    .all(messagingGroupId) as AgentGroupRow[];
}

export function getWiringsForAgentGroup(agentGroupId: string): WiringRow[] {
  return db
    .prepare(
      `SELECT id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
              sender_scope, ignored_message_policy, session_mode, priority, is_main,
              model, temperature, max_tool_rounds, timeout_ms, show_thinking,
              pipeline_replies_blocked, created_at
       FROM messaging_group_agents WHERE agent_group_id = ?
       ORDER BY is_main DESC, priority DESC, created_at`,
    )
    .all(agentGroupId) as WiringRow[];
}

// ---------------------------------------------------------------------------
// v1-compat: groups (composite query: agent_groups ⨝ messaging_group_agents ⨝ messaging_groups)
// ---------------------------------------------------------------------------

const FLAT_GROUP_SELECT = `
  SELECT
    mg.platform_id                                                AS jid,
    COALESCE(mg.name, ag.name)                                    AS name,
    ag.folder                                                     AS folder,
    COALESCE(mga.engage_pattern, '')                              AS trigger_pattern,
    COALESCE(mga.is_main, 0)                                      AS is_main,
    CASE WHEN mga.engage_mode = 'pattern' AND mga.engage_pattern = '.'
         THEN 0 ELSE 1 END                                        AS requires_trigger,
    mga.model                                                     AS model,
    mga.temperature                                               AS temperature,
    mga.max_tool_rounds                                           AS max_tool_rounds,
    mga.timeout_ms                                                AS timeout_ms,
    mga.show_thinking                                             AS show_thinking,
    'active'                                                      AS mode,
    COALESCE(mga.session_mode, 'shared')                          AS threading_mode,
    COALESCE(mga.pipeline_replies_blocked, 0)                     AS pipeline_replies_blocked
  FROM agent_groups ag
  JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
  JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
`;

export function getAllGroups(): GroupRow[] {
  return db
    .prepare(
      `${FLAT_GROUP_SELECT}
       WHERE mga.id = (
         SELECT id FROM messaging_group_agents
         WHERE agent_group_id = ag.id
         ORDER BY is_main DESC, priority DESC, created_at
         LIMIT 1
       )
       ORDER BY name`,
    )
    .all() as GroupRow[];
}

export function getGroupByFolder(folder: string): GroupRow | undefined {
  return db
    .prepare(
      `${FLAT_GROUP_SELECT}
       WHERE ag.folder = ?
         AND mga.id = (
           SELECT id FROM messaging_group_agents
           WHERE agent_group_id = ag.id
           ORDER BY is_main DESC, priority DESC, created_at
           LIMIT 1
         )`,
    )
    .get(folder) as GroupRow | undefined;
}

export function updateGroup(
  folder: string,
  updates: {
    model?: string | null;
    temperature?: number | null;
    max_tool_rounds?: number;
    timeout_ms?: number;
    show_thinking?: number | null;
    mode?: string;
    threading_mode?: string;
    pipeline_replies_blocked?: number;
  },
): boolean {
  const wiring = db
    .prepare(
      `SELECT mga.id AS id
       FROM agent_groups ag
       JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id
       WHERE ag.folder = ?
       ORDER BY mga.is_main DESC, mga.priority DESC, mga.created_at
       LIMIT 1`,
    )
    .get(folder) as { id: string } | undefined;
  if (!wiring) return false;

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
  if (updates.threading_mode !== undefined) {
    setClauses.push('session_mode = ?');
    values.push(updates.threading_mode);
  }
  if (updates.pipeline_replies_blocked !== undefined) {
    setClauses.push('pipeline_replies_blocked = ?');
    values.push(updates.pipeline_replies_blocked);
  }
  // `mode` has no direct v2 equivalent (passive moved to
  // pipeline_passive_subscriptions; engage_mode covers active variants).
  // Commit 2's redesign surfaces engage_mode + passive subscriptions
  // explicitly. The field is accepted on input but not persisted.

  if (setClauses.length === 0) return false;

  values.push(wiring.id);
  const result = db
    .prepare(`UPDATE messaging_group_agents SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Tasks (table renamed: scheduled_tasks → pipeline_scheduled_tasks)
// ---------------------------------------------------------------------------

const TASK_SELECT = `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk,
       allowed_tools, allowed_send_targets, execution_mode, subscribed_event_types, fallback_poll_ms,
       next_run, last_run, last_result, status, created_at
FROM pipeline_scheduled_tasks`;

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
    `INSERT INTO pipeline_scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
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
      `${TASK_SELECT} WHERE group_folder = ? AND id NOT LIKE 'pipeline:%' ORDER BY next_run`,
    )
    .all(groupFolder) as TaskRow[];
}

export function getTaskById(id: string): TaskRow | undefined {
  return db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as TaskRow | undefined;
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
    fallback_poll_ms?: number | null;
    status?: string;
    next_run?: string;
  },
): boolean {
  const ALLOWED_COLUMNS = new Set([
    'prompt', 'schedule_type', 'schedule_value', 'context_mode',
    'model', 'temperature', 'timezone', 'max_tool_rounds',
    'timeout_ms', 'use_agent_sdk', 'status', 'next_run',
    'allowed_tools', 'allowed_send_targets', 'execution_mode', 'subscribed_event_types', 'fallback_poll_ms',
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
    .prepare(`UPDATE pipeline_scheduled_tasks SET ${setClauses.join(', ')} WHERE id = ?`)
    .run(...values);
  return result.changes > 0;
}

export function deleteTask(id: string): boolean {
  db.prepare(`DELETE FROM pipeline_task_run_logs WHERE task_id = ?`).run(id);
  const result = db.prepare(`DELETE FROM pipeline_scheduled_tasks WHERE id = ?`).run(id);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Token usage
// ---------------------------------------------------------------------------

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
  // Per-wiring model lives on messaging_group_agents (is_main wiring); fall
  // back to task.model.
  return db
    .prepare(
      `SELECT date(r.run_at) as date,
              COALESCE(NULLIF(t.model, ''), mga.model) as model,
              SUM(COALESCE(r.input_tokens, 0)) as input_tokens,
              SUM(COALESCE(r.output_tokens, 0)) as output_tokens,
              SUM(COALESCE(r.cache_read_input_tokens, 0)) as cache_read,
              SUM(COALESCE(r.cache_creation_input_tokens, 0)) as cache_creation,
              SUM(r.cost_usd) as actual_cost,
              COUNT(r.cost_usd) as rows_with_cost,
              COUNT(*) as total_rows
       FROM pipeline_task_run_logs r
       JOIN pipeline_scheduled_tasks t ON r.task_id = t.id
       LEFT JOIN agent_groups ag ON t.group_folder = ag.folder
       LEFT JOIN messaging_group_agents mga ON mga.agent_group_id = ag.id AND mga.is_main = 1
       WHERE t.group_folder = ?
         AND r.run_at >= date('now', ? || ' days')
       GROUP BY date(r.run_at), COALESCE(NULLIF(t.model, ''), mga.model)
       ORDER BY date(r.run_at)`,
    )
    .all(groupFolder, -(days - 1)) as DailyModelTokenRow[];
}

// ---------------------------------------------------------------------------
// Pipeline tasks / token usage / passive subscriptions
// ---------------------------------------------------------------------------

export function getPipelineTasks(): TaskRow[] {
  return db.prepare(`${TASK_SELECT} WHERE id LIKE 'pipeline:%' ORDER BY id`).all() as TaskRow[];
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
       FROM pipeline_task_run_logs r
       WHERE r.task_id LIKE 'pipeline:%'
         AND r.run_at >= date('now', ? || ' days')
       GROUP BY date(r.run_at), r.task_id
       ORDER BY date(r.run_at)`,
    )
    .all(-(days - 1)) as PipelineTokenUsageRow[];
}

export function getPassiveChannels(): GroupRow[] {
  // v2 moved passive observation from registered_groups.mode='passive' to
  // pipeline_passive_subscriptions. Join with messaging_groups (and any
  // existing agent_group wiring) to emit a v1-compat shape that
  // routes/pipeline.ts can render. Subscriptions WITHOUT a wired
  // agent_group still surface (with synthetic folder + empty agent fields).
  return db
    .prepare(
      `SELECT
         pps.platform_id                                       AS jid,
         COALESCE(mg.name, pps.platform_id)                    AS name,
         COALESCE(ag.folder, '')                               AS folder,
         ''                                                    AS trigger_pattern,
         0                                                     AS is_main,
         0                                                     AS requires_trigger,
         NULL                                                  AS model,
         NULL                                                  AS temperature,
         NULL                                                  AS max_tool_rounds,
         NULL                                                  AS timeout_ms,
         NULL                                                  AS show_thinking,
         'passive'                                             AS mode,
         'shared'                                              AS threading_mode,
         0                                                     AS pipeline_replies_blocked
       FROM pipeline_passive_subscriptions pps
       LEFT JOIN messaging_groups mg
         ON mg.channel_type = pps.channel_type AND mg.platform_id = pps.platform_id
       LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id AND mga.is_main = 1
       LEFT JOIN agent_groups ag ON ag.id = mga.agent_group_id
       WHERE pps.enabled = 1
       ORDER BY name`,
    )
    .all() as GroupRow[];
}

// ---------------------------------------------------------------------------
// Task run logs (table renamed)
// ---------------------------------------------------------------------------

export function getTaskRuns(taskId: string, limit: number = 20): TaskRunRow[] {
  return db
    .prepare(
      `SELECT run_at, duration_ms, status, result, error
       FROM pipeline_task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`,
    )
    .all(taskId, limit) as TaskRunRow[];
}

// ---------------------------------------------------------------------------
// Events (table renamed: events → pipeline_events)
// ---------------------------------------------------------------------------

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
    .prepare(
      `SELECT id, type, source_group, source_task_id, payload, dedupe_key, created_at,
              expires_at, status, claimed_by, claimed_at, processed_at, result_note
       FROM pipeline_events ${where} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as EventRow[];
}

// ---------------------------------------------------------------------------
// Pipeline intake log
// ---------------------------------------------------------------------------

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
      `SELECT id, event_id, raw_text_hash, source_type, source_group, source_task_id,
              source_channel, source_message_id, reason, submitted_at, processed_at,
              observation_id
       FROM pipeline_intake_log ${condition}
       ORDER BY submitted_at DESC, id DESC LIMIT ?`,
    )
    .all(limit) as IntakeLogRow[];
}

// ---------------------------------------------------------------------------
// Observations + labels
// ---------------------------------------------------------------------------

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
    .get(id) as Omit<ObservationDetailRow, 'label'> | undefined;
  if (!row) return undefined;

  const label = db
    .prepare(
      `SELECT id, labeller, intent, form, imperative_content, addressee,
              embedded_instructions, adversarial_smell, notes, expected_json,
              created_at, updated_at
       FROM observation_labels WHERE observation_id = ?`,
    )
    .get(id) as ObservationLabelRow | undefined;

  return { ...row, label: label ?? null };
}

// ---------------------------------------------------------------------------
// Pipeline clusters
// ---------------------------------------------------------------------------

export type ClusterStatus = 'active' | 'resolved' | 'expired';

export interface ClusterListRow {
  id: number;
  source_channel: string;
  cluster_key: string;
  status: ClusterStatus;
  summary: string;
  observation_count: number;
  last_observation_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface ClusterDetailRow extends ClusterListRow {
  observation_ids: string;
}

export interface ClusterObservationRow {
  id: number;
  source_chat_jid: string | null;
  raw_text: string;
  created_at: string;
}

export function getClusters(opts?: {
  status?: ClusterStatus;
  sourceChannel?: string;
  limit?: number;
  offset?: number;
}): ClusterListRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (opts?.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.sourceChannel) {
    conditions.push('source_channel = ?');
    params.push(opts.sourceChannel);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  const offset = opts?.offset ?? 0;
  return db
    .prepare(
      `SELECT id, source_channel, cluster_key, status, summary,
              observation_count, last_observation_at,
              created_at, updated_at, resolved_at
       FROM pipeline_clusters
       ${where}
       ORDER BY last_observation_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ClusterListRow[];
}

export function getClusterById(id: number): ClusterDetailRow | undefined {
  return db
    .prepare(
      `SELECT id, source_channel, cluster_key, status, summary,
              observation_ids, observation_count, last_observation_at,
              created_at, updated_at, resolved_at
       FROM pipeline_clusters WHERE id = ?`,
    )
    .get(id) as ClusterDetailRow | undefined;
}

export function getClusterObservations(ids: number[]): ClusterObservationRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, source_chat_jid, raw_text, created_at
       FROM observed_messages WHERE id IN (${placeholders})
       ORDER BY id`,
    )
    .all(...ids) as ClusterObservationRow[];
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

export interface ExportableObservationRow {
  id: number;
  source_type: string;
  raw_text: string;
  sanitised_json: string;
  expected_json: string;
}

export function getExportableObservations(): ExportableObservationRow[] {
  return db
    .prepare(
      `SELECT o.id, o.source_type, o.raw_text, o.sanitised_json, l.expected_json
       FROM observed_messages o
       JOIN observation_labels l ON l.observation_id = o.id
       WHERE o.sanitised_json IS NOT NULL AND l.expected_json IS NOT NULL
       ORDER BY o.id`,
    )
    .all() as ExportableObservationRow[];
}
