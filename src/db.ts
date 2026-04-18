import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  EventRow,
  EventStatus,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add model column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN model TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add timezone column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add model column to registered_groups if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN model TEXT DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add temperature column to registered_groups
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN temperature REAL DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add temperature column to scheduled_tasks
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN temperature REAL DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add per-group configurable limits (Ollama direct mode)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN max_tool_rounds INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN timeout_ms INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN show_thinking INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add mode and threading_mode columns to registered_groups (observation pipeline)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN mode TEXT NOT NULL DEFAULT 'active'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN threading_mode TEXT NOT NULL DEFAULT 'temporal'`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN pipeline_replies_blocked INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add per-task configurable limits (Ollama direct mode)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN max_tool_rounds INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add use_agent_sdk column (lightweight task engine: default false)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN use_agent_sdk INTEGER DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }

  // Add capability allow-lists (observation pipeline)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN allowed_tools TEXT`);
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN allowed_send_targets TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add execution_mode and subscribed_event_types columns (pipeline YAML loader)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'container'`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN subscribed_event_types TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN fallback_poll_ms INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add batch_size column (Phase F2.b: cap consume_events limit per task)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN batch_size INTEGER DEFAULT NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add token usage columns to task_run_logs
  try {
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN input_tokens INTEGER`);
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN output_tokens INTEGER`);
    database.exec(`ALTER TABLE task_run_logs ADD COLUMN cost_usd REAL`);
  } catch {
    /* columns already exist */
  }

  // Add cache token breakdown columns
  try {
    database.exec(
      `ALTER TABLE task_run_logs ADD COLUMN cache_read_input_tokens INTEGER`,
    );
    database.exec(
      `ALTER TABLE task_run_logs ADD COLUMN cache_creation_input_tokens INTEGER`,
    );
  } catch {
    /* columns already exist */
  }

  // --- Cross-channel delivery dedup (persisted across restarts) ---

  database.exec(`
    CREATE TABLE IF NOT EXISTS cross_channel_deliveries (
      key TEXT PRIMARY KEY,
      delivered_at TEXT NOT NULL
    );
  `);

  // --- Event bus (shared infrastructure — both core and plugins produce/consume) ---

  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_task_id TEXT,
      payload TEXT NOT NULL,
      dedupe_key TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      claimed_by TEXT,
      claimed_at TEXT,
      processed_at TEXT,
      result_note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_pending
      ON events(status, type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe
      ON events(type, dedupe_key) WHERE dedupe_key IS NOT NULL;
  `);
  // Pipeline-specific tables (observed_messages, pipeline_intake_log,
  // observation_labels, reextraction_cache, pipeline_clusters) live in the
  // nanoclaw-pipeline plugin. See nanoclaw-pipeline/src/migrations.ts.
  // The plugin's startup hook applies its migrations at boot via
  // execMigrationSql above.
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** Run a raw SQL statement (for plugin migrations). Swallows errors (idempotent). */
export function execMigrationSql(sql: string): void {
  try {
    db.exec(sql);
  } catch {
    /* table/column already exists */
  }
}

/**
 * Return the underlying database handle. Intended for plugins that prepare
 * their own statements against core's shared connection (see nanoclaw-pipeline).
 * Behaves identically in production and test — tests use the in-memory handle
 * installed by _initTestDatabase().
 */
export function getDb(): Database.Database {
  return db;
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function readChatMessages(
  chatJid: string,
  since?: string,
  limit: number = 50,
  includeBotMessages: boolean = false,
): { messages: NewMessage[]; cursor: string } {
  const sinceTs = since || '';
  const botFilter = includeBotMessages ? '' : 'AND is_bot_message = 0';

  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        ${botFilter}
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db.prepare(sql).all(chatJid, sinceTs, limit) as NewMessage[];

  const cursor = rows.length > 0 ? rows[rows.length - 1].timestamp : sinceTs;

  return { messages: rows, cursor };
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, temperature, timezone, max_tool_rounds, timeout_ms, use_agent_sdk, allowed_tools, allowed_send_targets, execution_mode, subscribed_event_types, fallback_poll_ms, batch_size, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.model || null,
    task.temperature ?? null,
    task.timezone || null,
    task.maxToolRounds ?? null,
    task.timeoutMs ?? null,
    task.useAgentSdk ? 1 : 0,
    task.allowedTools ? JSON.stringify(task.allowedTools) : null,
    task.allowedSendTargets ? JSON.stringify(task.allowedSendTargets) : null,
    task.executionMode || 'container',
    task.subscribedEventTypes
      ? JSON.stringify(task.subscribedEventTypes)
      : null,
    task.fallbackPollMs ?? null,
    task.batchSize ?? null,
    task.next_run,
    task.status,
    task.created_at,
  );
}

const TASK_SELECT = `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, model, temperature, timezone, max_tool_rounds AS maxToolRounds, timeout_ms AS timeoutMs, use_agent_sdk AS useAgentSdk, allowed_tools, allowed_send_targets, execution_mode AS executionMode, subscribed_event_types, fallback_poll_ms AS fallbackPollMs, batch_size AS batchSize, next_run, last_run, last_result, status, created_at FROM scheduled_tasks`;

function parseTaskRow(row: any): ScheduledTask {
  return {
    ...row,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    allowedSendTargets: row.allowed_send_targets
      ? JSON.parse(row.allowed_send_targets)
      : null,
    executionMode: row.executionMode || 'container',
    subscribedEventTypes: row.subscribed_event_types
      ? JSON.parse(row.subscribed_event_types)
      : null,
  };
}

export function getTaskById(id: string): ScheduledTask | undefined {
  const row = db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id);
  return row ? parseTaskRow(row) : undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(`${TASK_SELECT} WHERE group_folder = ? ORDER BY created_at DESC`)
    .all(groupFolder)
    .map(parseTaskRow);
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare(`${TASK_SELECT} ORDER BY created_at DESC`)
    .all()
    .map(parseTaskRow);
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
      | 'model'
      | 'temperature'
      | 'timezone'
      | 'maxToolRounds'
      | 'timeoutMs'
      | 'useAgentSdk'
      | 'allowedTools'
      | 'allowedSendTargets'
      | 'executionMode'
      | 'subscribedEventTypes'
      | 'fallbackPollMs'
      | 'batchSize'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.temperature !== undefined) {
    fields.push('temperature = ?');
    values.push(updates.temperature);
  }
  if (updates.timezone !== undefined) {
    fields.push('timezone = ?');
    values.push(updates.timezone);
  }
  if (updates.maxToolRounds !== undefined) {
    fields.push('max_tool_rounds = ?');
    values.push(updates.maxToolRounds);
  }
  if (updates.timeoutMs !== undefined) {
    fields.push('timeout_ms = ?');
    values.push(updates.timeoutMs);
  }
  if (updates.useAgentSdk !== undefined) {
    fields.push('use_agent_sdk = ?');
    values.push(updates.useAgentSdk ? 1 : 0);
  }
  if (updates.allowedTools !== undefined) {
    fields.push('allowed_tools = ?');
    values.push(
      updates.allowedTools ? JSON.stringify(updates.allowedTools) : null,
    );
  }
  if (updates.allowedSendTargets !== undefined) {
    fields.push('allowed_send_targets = ?');
    values.push(
      updates.allowedSendTargets
        ? JSON.stringify(updates.allowedSendTargets)
        : null,
    );
  }
  if (updates.executionMode !== undefined) {
    fields.push('execution_mode = ?');
    values.push(updates.executionMode || 'container');
  }
  if (updates.subscribedEventTypes !== undefined) {
    fields.push('subscribed_event_types = ?');
    values.push(
      updates.subscribedEventTypes
        ? JSON.stringify(updates.subscribedEventTypes)
        : null,
    );
  }
  if (updates.fallbackPollMs !== undefined) {
    fields.push('fallback_poll_ms = ?');
    values.push(updates.fallbackPollMs ?? null);
  }
  if (updates.batchSize !== undefined) {
    fields.push('batch_size = ?');
    values.push(updates.batchSize ?? null);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `${TASK_SELECT} WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ? ORDER BY next_run`,
    )
    .all(now)
    .map(parseTaskRow);
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?,
        status = CASE WHEN ? IS NULL AND schedule_type != 'event' THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

/**
 * Advance only next_run, leaving last_run / last_result / status untouched.
 * Used for no-op scheduler skips (e.g. pre-flight: no pending events) so
 * the task's displayed history keeps reflecting the last REAL execution
 * rather than flipping to "ran just now" every minute.
 */
export function bumpTaskNextRun(id: string, nextRun: string | null): void {
  db.prepare(`UPDATE scheduled_tasks SET next_run = ? WHERE id = ?`).run(
    nextRun,
    id,
  );
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
    log.input_tokens ?? null,
    log.output_tokens ?? null,
    log.cache_read_input_tokens ?? null,
    log.cache_creation_input_tokens ?? null,
    log.cost_usd ?? null,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
        model: string | null;
        temperature: number | null;
        max_tool_rounds: number | null;
        timeout_ms: number | null;
        show_thinking: number | null;
        mode: string | null;
        threading_mode: string | null;
        pipeline_replies_blocked: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    model: row.model || undefined,
    temperature:
      row.temperature != null && String(row.temperature) !== ''
        ? row.temperature
        : undefined,
    maxToolRounds: row.max_tool_rounds ?? undefined,
    timeoutMs: row.timeout_ms ?? undefined,
    showThinking: row.show_thinking === 1 ? true : undefined,
    mode: (row.mode as RegisteredGroup['mode']) || undefined,
    threadingMode:
      (row.threading_mode as RegisteredGroup['threadingMode']) || undefined,
    pipelineRepliesBlocked: row.pipeline_replies_blocked === 1,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, model, temperature, max_tool_rounds, timeout_ms, show_thinking, mode, threading_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.model || null,
    group.temperature ?? null,
    group.maxToolRounds ?? null,
    group.timeoutMs ?? null,
    group.showThinking ? 1 : null,
    group.mode || 'active',
    group.threadingMode || 'temporal',
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
    model: string | null;
    temperature: number | null;
    max_tool_rounds: number | null;
    timeout_ms: number | null;
    show_thinking: number | null;
    mode: string | null;
    threading_mode: string | null;
    pipeline_replies_blocked: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
      model: row.model || undefined,
      temperature: row.temperature ?? undefined,
      maxToolRounds: row.max_tool_rounds ?? undefined,
      timeoutMs: row.timeout_ms ?? undefined,
      showThinking: row.show_thinking === 1 ? true : undefined,
      mode: (row.mode as RegisteredGroup['mode']) || undefined,
      threadingMode:
        (row.threading_mode as RegisteredGroup['threadingMode']) || undefined,
      pipelineRepliesBlocked: row.pipeline_replies_blocked === 1,
    };
  }
  return result;
}

export function updateRegisteredGroup(
  jid: string,
  updates: Partial<
    Pick<
      RegisteredGroup,
      | 'model'
      | 'temperature'
      | 'maxToolRounds'
      | 'timeoutMs'
      | 'showThinking'
      | 'mode'
      | 'threadingMode'
      | 'pipelineRepliesBlocked'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.pipelineRepliesBlocked !== undefined) {
    fields.push('pipeline_replies_blocked = ?');
    values.push(updates.pipelineRepliesBlocked ? 1 : 0);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model || null);
  }
  if (updates.temperature !== undefined) {
    fields.push('temperature = ?');
    values.push(updates.temperature ?? null);
  }
  if (updates.maxToolRounds !== undefined) {
    fields.push('max_tool_rounds = ?');
    values.push(updates.maxToolRounds ?? null);
  }
  if (updates.timeoutMs !== undefined) {
    fields.push('timeout_ms = ?');
    values.push(updates.timeoutMs ?? null);
  }
  if (updates.showThinking !== undefined) {
    fields.push('show_thinking = ?');
    values.push(updates.showThinking ? 1 : null);
  }
  if (updates.mode !== undefined) {
    fields.push('mode = ?');
    values.push(updates.mode || 'active');
  }
  if (updates.threadingMode !== undefined) {
    fields.push('threading_mode = ?');
    values.push(updates.threadingMode || 'temporal');
  }

  if (fields.length === 0) return;

  values.push(jid);
  db.prepare(
    `UPDATE registered_groups SET ${fields.join(', ')} WHERE jid = ?`,
  ).run(...values);
}

// --- Observation labels ---

// --- Pipeline helpers (shared event-bus consumer) ---

export function bumpConsumerTaskNextRun(eventType: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE scheduled_tasks
       SET next_run = ?
     WHERE status = 'active'
       AND subscribed_event_types LIKE ?`,
  ).run(now, `%${eventType}%`);
}

export function getPassiveGroups(): Array<{ jid: string; folder: string }> {
  return db
    .prepare(`SELECT jid, folder FROM registered_groups WHERE mode = 'passive'`)
    .all() as Array<{ jid: string; folder: string }>;
}

// --- Events ---

export function publishEvent(
  type: string,
  sourceGroup: string,
  sourceTaskId: string | null,
  payload: string,
  dedupeKey?: string | null,
  ttlSeconds?: number | null,
): { id: number; isNew: boolean } {
  const now = new Date().toISOString();
  const expiresAt =
    ttlSeconds != null
      ? new Date(Date.now() + ttlSeconds * 1000).toISOString()
      : null;

  if (dedupeKey) {
    // Check for existing unprocessed event with same (type, dedupe_key)
    const existing = db
      .prepare(
        `SELECT id FROM events WHERE type = ? AND dedupe_key = ? AND status IN ('pending', 'claimed')`,
      )
      .get(type, dedupeKey) as { id: number } | undefined;
    if (existing) return { id: existing.id, isNew: false };
  }

  const result = db
    .prepare(
      `INSERT INTO events (type, source_group, source_task_id, payload, dedupe_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      type,
      sourceGroup,
      sourceTaskId,
      payload,
      dedupeKey ?? null,
      now,
      expiresAt,
    );

  return { id: result.lastInsertRowid as number, isNew: true };
}

export function consumeEvents(
  types: string[],
  claimedBy: string,
  limit: number,
): EventRow[] {
  const now = new Date().toISOString();

  // Support glob patterns: observation.* → LIKE 'observation.%'
  const hasGlob = types.some((t) => t.includes('*'));
  let typeFilter: string;
  let typeParams: string[];

  if (hasGlob) {
    const conditions = types.map(() => 'type LIKE ?');
    typeFilter = `(${conditions.join(' OR ')})`;
    typeParams = types.map((t) => t.replace(/\*/g, '%'));
  } else {
    const placeholders = types.map(() => '?').join(', ');
    typeFilter = `type IN (${placeholders})`;
    typeParams = types;
  }

  // Atomic claim: select pending, non-expired events and update in one statement
  const rows = db
    .prepare(
      `UPDATE events
         SET status = 'claimed', claimed_by = ?, claimed_at = ?
       WHERE id IN (
         SELECT id FROM events
          WHERE status = 'pending'
            AND ${typeFilter}
            AND (expires_at IS NULL OR expires_at > ?)
          ORDER BY created_at
          LIMIT ?
       )
       RETURNING *`,
    )
    .all(claimedBy, now, ...typeParams, now, limit) as EventRow[];

  return rows;
}

/**
 * Check whether any events of the given types are currently truly
 * pending (status='pending'). Used by the scheduler's pre-flight to
 * decide whether to invoke the consumer task at all.
 *
 * This is intentionally narrower than getRecentEvents(..., false),
 * which counts both 'pending' and 'claimed' as "unprocessed". Orphan
 * claims (from crashes or restarts mid-processing) can never be
 * returned by consumeEvents — which only claims 'pending' rows — so
 * the scheduler should not fire the task on them either, or it burns
 * LLM tokens on a guaranteed no-op.
 */
export function hasPendingEventsOfTypes(types: string[]): boolean {
  if (!types || types.length === 0) return false;

  const hasGlob = types.some((t) => t.includes('*'));
  let typeFilter: string;
  let params: string[];
  if (hasGlob) {
    const conditions = types.map(() => 'type LIKE ?');
    typeFilter = `(${conditions.join(' OR ')})`;
    params = types.map((t) => t.replace(/\*/g, '%'));
  } else {
    const placeholders = types.map(() => '?').join(', ');
    typeFilter = `type IN (${placeholders})`;
    params = types;
  }

  const now = new Date().toISOString();
  const row = db
    .prepare(
      `SELECT 1 AS found FROM events
        WHERE status = 'pending'
          AND ${typeFilter}
          AND (expires_at IS NULL OR expires_at > ?)
        LIMIT 1`,
    )
    .get(...params, now) as { found: number } | undefined;
  return !!row;
}

/**
 * Get an event's payload by its ID.
 * Used for pipeline auto-routing: the container passes the consumed event ID,
 * and the host looks up the specific event to extract source context.
 */
export function getEventPayloadById(eventId: number): string | undefined {
  const row = db
    .prepare('SELECT payload FROM events WHERE id = ?')
    .get(eventId) as { payload: string } | undefined;
  return row?.payload;
}

// --- Cross-channel delivery dedup ---

export function isCrossChannelDelivered(key: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM cross_channel_deliveries WHERE key = ?')
    .get(key);
  return !!row;
}

export function recordCrossChannelDeliveryDB(key: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO cross_channel_deliveries (key, delivered_at) VALUES (?, ?)`,
  ).run(key, new Date().toISOString());
}

export function _clearCrossChannelDeliveries(): void {
  db.prepare('DELETE FROM cross_channel_deliveries').run();
}

export function ackEvent(
  eventId: number,
  status: 'done' | 'failed',
  note?: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE events SET status = ?, processed_at = ?, result_note = ? WHERE id = ?`,
  ).run(status, now, note ?? null, eventId);
}

export function getRecentEvents(
  types?: string[],
  limit?: number,
  includeProcessed?: boolean,
): EventRow[] {
  const maxRows = limit ?? 50;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (types && types.length > 0) {
    const hasGlob = types.some((t) => t.includes('*'));
    if (hasGlob) {
      const globs = types.map(() => 'type LIKE ?');
      conditions.push(`(${globs.join(' OR ')})`);
      params.push(...types.map((t) => t.replace(/\*/g, '%')));
    } else {
      const placeholders = types.map(() => '?').join(', ');
      conditions.push(`type IN (${placeholders})`);
      params.push(...types);
    }
  }

  if (!includeProcessed) {
    conditions.push(`status IN ('pending', 'claimed')`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(maxRows);

  return db
    .prepare(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params) as EventRow[];
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
