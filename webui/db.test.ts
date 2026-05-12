import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  initDb,
  closeDb,
  getAllGroups,
  getGroupByFolder,
  updateGroup,
  getTasksByGroup,
  getTaskById,
  updateTask,
  getTaskRuns,
  getEvents,
  getIntakeLogs,
  getObservations,
  getObservationById,
  upsertLabel,
  getPipelineTasks,
  getPipelineTokenUsage,
  getPassiveChannels,
  getAllAgentGroups,
  getAgentGroupByFolder,
  getMessagingGroups,
  getWiringsForAgentGroup,
} from './db.js';

let tmpDir: string;

/**
 * Hand-rolled v2 schema, mirroring:
 *   - src/db/migrations/001-initial.ts (agent_groups, messaging_groups,
 *     messaging_group_agents)
 *   - src/db/migrations/010-engage-modes.ts (engage_mode/engage_pattern/
 *     sender_scope/ignored_message_policy; drops trigger_rules + response_scope)
 *   - src/db/migrations/014-wiring-agent-settings.ts (is_main, model,
 *     temperature, max_tool_rounds, timeout_ms, show_thinking; partial
 *     unique index)
 *   - nanoclaw-pipeline/src/migrations.ts (observed_messages,
 *     pipeline_intake_log, observation_labels, pipeline_clusters,
 *     pipeline_passive_subscriptions, pipeline_scheduled_tasks,
 *     pipeline_task_run_logs, pipeline_events; plus
 *     pipeline_replies_blocked column on messaging_group_agents)
 *
 * The schema mirror lives here (not loaded from migration modules)
 * because webui has no host code import — it owns its own DB
 * connection and only needs the table shapes its queries hit.
 */
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-db-test-'));
  const dbPath = path.join(tmpDir, 'v2.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE agent_groups (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      folder         TEXT NOT NULL UNIQUE,
      agent_provider TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );

    CREATE TABLE messaging_group_agents (
      id                     TEXT PRIMARY KEY,
      messaging_group_id     TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id         TEXT NOT NULL REFERENCES agent_groups(id),
      session_mode           TEXT DEFAULT 'shared',
      priority               INTEGER DEFAULT 0,
      created_at             TEXT NOT NULL,
      engage_mode            TEXT,
      engage_pattern         TEXT,
      sender_scope           TEXT,
      ignored_message_policy TEXT,
      is_main                INTEGER NOT NULL DEFAULT 0,
      model                  TEXT,
      temperature            REAL,
      max_tool_rounds        INTEGER,
      timeout_ms             INTEGER,
      show_thinking          INTEGER,
      pipeline_replies_blocked INTEGER DEFAULT 0,
      UNIQUE(messaging_group_id, agent_group_id)
    );
    CREATE UNIQUE INDEX uniq_messaging_group_agents_main
      ON messaging_group_agents (agent_group_id)
      WHERE is_main = 1;

    CREATE TABLE pipeline_scheduled_tasks (
      id                     TEXT PRIMARY KEY,
      group_folder           TEXT NOT NULL,
      chat_jid               TEXT NOT NULL,
      prompt                 TEXT NOT NULL,
      schedule_type          TEXT NOT NULL,
      schedule_value         TEXT NOT NULL,
      context_mode           TEXT NOT NULL DEFAULT 'isolated',
      model                  TEXT,
      temperature            REAL,
      timezone               TEXT,
      max_tool_rounds        INTEGER,
      timeout_ms             INTEGER,
      use_agent_sdk          INTEGER,
      allowed_tools          TEXT,
      allowed_send_targets   TEXT,
      execution_mode         TEXT NOT NULL DEFAULT 'container',
      subscribed_event_types TEXT,
      fallback_poll_ms       INTEGER,
      next_run               TEXT,
      last_run               TEXT,
      last_result            TEXT,
      status                 TEXT DEFAULT 'active',
      created_at             TEXT NOT NULL
    );

    CREATE TABLE pipeline_task_run_logs (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id                     TEXT NOT NULL,
      run_at                      TEXT NOT NULL,
      duration_ms                 INTEGER NOT NULL,
      status                      TEXT NOT NULL,
      result                      TEXT,
      error                       TEXT,
      input_tokens                INTEGER,
      output_tokens               INTEGER,
      cache_read_input_tokens     INTEGER,
      cache_creation_input_tokens INTEGER,
      cost_usd                    REAL,
      FOREIGN KEY (task_id) REFERENCES pipeline_scheduled_tasks(id)
    );

    CREATE TABLE pipeline_events (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      type                   TEXT NOT NULL,
      source_group           TEXT NOT NULL,
      source_task_id         TEXT,
      payload                TEXT NOT NULL,
      dedupe_key             TEXT,
      created_at             TEXT NOT NULL,
      expires_at             TEXT,
      status                 TEXT NOT NULL DEFAULT 'pending',
      claimed_by             TEXT,
      claimed_at             TEXT,
      processed_at           TEXT,
      result_note            TEXT
    );

    CREATE TABLE pipeline_intake_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id          INTEGER NOT NULL,
      raw_text_hash     TEXT NOT NULL,
      source_type       TEXT NOT NULL,
      source_group      TEXT NOT NULL,
      source_task_id    TEXT,
      source_channel    TEXT,
      source_message_id TEXT,
      reason            TEXT NOT NULL,
      submitted_at      TEXT NOT NULL,
      processed_at      TEXT,
      observation_id    INTEGER
    );

    CREATE TABLE observed_messages (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chat_jid          TEXT,
      source_message_id        TEXT,
      source_type              TEXT NOT NULL DEFAULT 'passive_channel',
      source_task_id           TEXT,
      source_group             TEXT,
      intake_reason            TEXT,
      intake_event_id          INTEGER,
      thread_id                TEXT,
      related_observation_ids  TEXT,
      raw_text                 TEXT NOT NULL,
      sanitised_json           TEXT,
      sanitiser_model          TEXT,
      sanitiser_version        TEXT,
      flags                    TEXT,
      created_at               TEXT NOT NULL,
      sanitised_at             TEXT
    );

    CREATE TABLE observation_labels (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id        INTEGER NOT NULL REFERENCES observed_messages(id),
      labeller              TEXT NOT NULL DEFAULT 'human',
      intent                TEXT,
      form                  TEXT,
      imperative_content    TEXT,
      addressee             TEXT,
      embedded_instructions TEXT,
      adversarial_smell     INTEGER,
      notes                 TEXT,
      expected_json         TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT
    );

    CREATE TABLE pipeline_clusters (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source_channel      TEXT NOT NULL,
      cluster_key         TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active',
      summary             TEXT NOT NULL,
      observation_ids     TEXT NOT NULL,
      observation_count   INTEGER NOT NULL DEFAULT 0,
      last_observation_at TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      resolved_at         TEXT
    );

    CREATE TABLE pipeline_passive_subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_type TEXT    NOT NULL,
      platform_id  TEXT    NOT NULL,
      cursor       TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
  `);

  // --- Agent groups (two v1 "groups" become two agent_groups) ---
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('ag-main', 'Main Chat', 'whatsapp_main', 'claude', '2024-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('ag-family', 'Family Chat', 'whatsapp_family', 'ollama', '2024-01-02T00:00:00.000Z');

  // --- Messaging groups (the chat channels) ---
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('mg-main', 'whatsapp', 'main@s.whatsapp.net', 'Main Chat', 1, '2024-01-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('mg-family', 'whatsapp', 'family@g.us', 'Family Chat', 1, '2024-01-02T00:00:00.000Z');

  // --- Wirings (messaging_group_agents) ---
  // Main: is_main=1, no per-wiring overrides (defaults), engage_pattern '@Andy'.
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, session_mode, priority, created_at,
        engage_mode, engage_pattern, sender_scope, ignored_message_policy, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'wire-main', 'mg-main', 'ag-main', 'shared', 0, '2024-01-01T00:00:00.000Z',
    'pattern', '@Andy', 'all', 'drop', 1,
  );
  // Family: is_main=0, model + max_tool_rounds + timeout_ms overrides.
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, session_mode, priority, created_at,
        engage_mode, engage_pattern, sender_scope, ignored_message_policy,
        is_main, model, max_tool_rounds, timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'wire-family', 'mg-family', 'ag-family', 'shared', 0, '2024-01-02T00:00:00.000Z',
    'pattern', '@Andy', 'all', 'drop', 0, 'ollama:qwen3', 10, 300000,
  );

  // --- User scheduled tasks (group_folder = ag.folder) ---
  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status,
        created_at, context_mode, model, timezone, max_tool_rounds, timeout_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'task-1', 'whatsapp_main', 'main@s.whatsapp.net', 'Send briefing',
    'cron', '0 9 * * 1-5', '2024-06-03T09:00:00.000Z', 'active',
    '2024-01-01T00:00:00.000Z', 'group', 'sonnet', 'America/New_York', null, null,
  );
  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status,
        created_at, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'task-2', 'whatsapp_main', 'main@s.whatsapp.net', 'Weekly report',
    'cron', '0 8 * * 5', '2024-06-07T08:00:00.000Z', 'active',
    '2024-01-05T00:00:00.000Z', 'isolated',
  );
  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status,
        created_at, context_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'task-3', 'whatsapp_family', 'family@g.us', 'Family reminder',
    'cron', '0 18 * * *', '2024-06-03T18:00:00.000Z', 'paused',
    '2024-02-01T00:00:00.000Z', 'isolated',
  );

  // --- Pipeline tasks ---
  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status,
        created_at, context_mode, model, execution_mode, allowed_tools, subscribed_event_types)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'pipeline:sanitiser', 'whatsapp_main', 'main@s.whatsapp.net', 'Extract observations',
    'cron', '*/1 * * * *', '2024-06-03T10:00:00.000Z', 'active',
    '2024-01-01T00:00:00.000Z', 'isolated', 'ollama:gemma4', 'host_pipeline',
    '[]', '["intake.raw"]',
  );
  db.prepare(
    `INSERT INTO pipeline_scheduled_tasks
       (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status,
        created_at, context_mode, model, execution_mode, allowed_tools)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'pipeline:monitor', 'whatsapp_main', 'main@s.whatsapp.net', 'Cluster observations',
    'cron', '*/2 * * * *', '2024-06-03T10:00:00.000Z', 'active',
    '2024-01-01T00:00:00.000Z', 'isolated', 'ollama:gemma4', 'container',
    '["consume_events","publish_event"]',
  );

  // --- Task run logs ---
  db.prepare(
    `INSERT INTO pipeline_task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('task-1', '2024-06-02T09:00:00.000Z', 5000, 'success', 'Briefing sent', null);
  db.prepare(
    `INSERT INTO pipeline_task_run_logs (task_id, run_at, duration_ms, status, result, error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('task-1', '2024-06-01T09:00:00.000Z', 3000, 'error', null, 'Timeout');
  db.prepare(
    `INSERT INTO pipeline_task_run_logs
       (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('pipeline:sanitiser', '2024-06-02T10:00:00.000Z', 1500, 'success', 'Processed 5 messages', null, 500, 250);
  db.prepare(
    `INSERT INTO pipeline_task_run_logs
       (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('pipeline:sanitiser', '2024-06-02T10:01:00.000Z', 800, 'success', 'Processed 2 messages', null, 200, 100);

  // --- Passive subscription (v2: replaces v1's registered_groups mode='passive') ---
  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('mg-passive', 'slack', 'CPASSIVE', 'Passive Channel', 1, '2024-03-01T00:00:00.000Z');
  db.prepare(
    `INSERT INTO pipeline_passive_subscriptions
       (channel_type, platform_id, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('slack', 'CPASSIVE', 1, '2024-03-01T00:00:00.000Z', '2024-03-01T00:00:00.000Z');

  // --- Pipeline events ---
  db.prepare(
    `INSERT INTO pipeline_events (type, source_group, source_task_id, payload, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('observation.support', 'slack_main', 'pipeline:sanitiser', '{"summary":"INC down"}', '2024-06-01T10:00:00.000Z', 'pending');
  db.prepare(
    `INSERT INTO pipeline_events
       (type, source_group, source_task_id, payload, created_at, status, claimed_by, claimed_at, processed_at, result_note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('observation.support', 'slack_main', 'pipeline:sanitiser', '{"summary":"fixed"}', '2024-06-01T11:00:00.000Z', 'done', 'pipeline:monitor', '2024-06-01T11:01:00.000Z', '2024-06-01T11:02:00.000Z', 'processed');

  // --- Intake log ---
  db.prepare(
    `INSERT INTO pipeline_intake_log
       (event_id, raw_text_hash, source_type, source_group, source_task_id, reason, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(1, 'abc123', 'task', 'slack_main', 'pipeline:monitor', 'found during investigation', '2024-06-01T10:30:00.000Z');
  db.prepare(
    `INSERT INTO pipeline_intake_log
       (event_id, raw_text_hash, source_type, source_group, source_task_id, reason, submitted_at, processed_at, observation_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(2, 'def456', 'task', 'slack_main', 'pipeline:monitor', 'another find', '2024-06-01T11:30:00.000Z', '2024-06-01T11:35:00.000Z', 42);

  // --- Observed messages + labels ---
  db.prepare(
    `INSERT INTO observed_messages (source_chat_jid, source_message_id, source_type, raw_text, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('slack:CPASSIVE', 'msg-obs-1', 'passive_channel', 'INC12345 is down again', '2024-06-01T10:00:00.000Z');
  db.prepare(
    `INSERT INTO observed_messages
       (source_chat_jid, source_message_id, source_type, raw_text, sanitised_json, created_at, sanitised_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('slack:CPASSIVE', 'msg-obs-2', 'passive_channel', 'Fixed the auth issue', '{"fact_summary":"auth fixed"}', '2024-06-01T11:00:00.000Z', '2024-06-01T11:01:00.000Z');
  db.prepare(
    `INSERT INTO observed_messages
       (source_type, source_task_id, source_group, intake_reason, intake_event_id, raw_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('task_intake', 'pipeline:monitor', 'slack_main', 'found during investigation', 99, 'forwarded log content', '2024-06-01T12:00:00.000Z');

  db.prepare(
    `INSERT INTO observation_labels
       (observation_id, labeller, intent, form, imperative_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(2, 'human', 'status_update', 'free_prose', 'none', '2024-06-01T12:00:00.000Z');

  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// v2-native entity helpers (consumed by Commit 2's redesigned UX)
// ---------------------------------------------------------------------------

describe('getAllAgentGroups', () => {
  it('returns every agent_group, ordered by name', () => {
    const groups = getAllAgentGroups();
    expect(groups).toHaveLength(2);
    expect(groups[0].folder).toBe('whatsapp_family');
    expect(groups[1].folder).toBe('whatsapp_main');
  });

  it('exposes agent_provider', () => {
    const family = getAllAgentGroups().find((g) => g.folder === 'whatsapp_family')!;
    expect(family.agent_provider).toBe('ollama');
  });
});

describe('getAgentGroupByFolder', () => {
  it('returns one agent_group by folder', () => {
    const main = getAgentGroupByFolder('whatsapp_main');
    expect(main).toBeDefined();
    expect(main!.id).toBe('ag-main');
    expect(main!.name).toBe('Main Chat');
  });

  it('returns undefined for unknown folder', () => {
    expect(getAgentGroupByFolder('nope')).toBeUndefined();
  });
});

describe('getMessagingGroups', () => {
  it('returns all messaging_groups', () => {
    const groups = getMessagingGroups();
    expect(groups.length).toBeGreaterThanOrEqual(3); // main + family + passive
  });

  it('exposes channel_type, platform_id, is_group', () => {
    const main = getMessagingGroups().find((g) => g.id === 'mg-main')!;
    expect(main.channel_type).toBe('whatsapp');
    expect(main.platform_id).toBe('main@s.whatsapp.net');
    expect(main.is_group).toBe(1);
  });
});

describe('getWiringsForAgentGroup', () => {
  it('returns wirings for one agent_group', () => {
    const wirings = getWiringsForAgentGroup('ag-main');
    expect(wirings).toHaveLength(1);
    expect(wirings[0].is_main).toBe(1);
    expect(wirings[0].engage_pattern).toBe('@Andy');
  });

  it('exposes per-wiring agent settings (model, max_tool_rounds, timeout_ms)', () => {
    const wirings = getWiringsForAgentGroup('ag-family');
    expect(wirings).toHaveLength(1);
    expect(wirings[0].model).toBe('ollama:qwen3');
    expect(wirings[0].max_tool_rounds).toBe(10);
    expect(wirings[0].timeout_ms).toBe(300000);
    expect(wirings[0].is_main).toBe(0);
  });

  it('returns empty for unknown agent_group', () => {
    expect(getWiringsForAgentGroup('nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v1-compat: groups
// ---------------------------------------------------------------------------

describe('getAllGroups (v1-compat)', () => {
  it('returns one row per agent_group (folder uniqueness preserved)', () => {
    const groups = getAllGroups();
    expect(groups).toHaveLength(2);
    const folders = groups.map((g) => g.folder).sort();
    expect(folders).toEqual(['whatsapp_family', 'whatsapp_main']);
  });

  it('returns groups sorted by name', () => {
    const groups = getAllGroups();
    expect(groups[0].name).toBe('Family Chat');
    expect(groups[1].name).toBe('Main Chat');
  });

  it('flattens per-wiring fields into v1 shape', () => {
    const family = getAllGroups().find((g) => g.folder === 'whatsapp_family')!;
    expect(family.jid).toBe('family@g.us');
    expect(family.name).toBe('Family Chat');
    expect(family.trigger_pattern).toBe('@Andy');
    expect(family.is_main).toBe(0);
    expect(family.model).toBe('ollama:qwen3');
    expect(family.max_tool_rounds).toBe(10);
    expect(family.timeout_ms).toBe(300000);
    expect(family.requires_trigger).toBe(1);
  });
});

describe('getGroupByFolder (v1-compat)', () => {
  it('returns the main wiring for a folder', () => {
    const main = getGroupByFolder('whatsapp_main');
    expect(main).toBeDefined();
    expect(main!.jid).toBe('main@s.whatsapp.net');
    expect(main!.is_main).toBe(1);
  });

  it('returns undefined for non-existent folder', () => {
    expect(getGroupByFolder('nonexistent')).toBeUndefined();
  });
});

describe('updateGroup (v1-compat → messaging_group_agents primary wiring)', () => {
  it('updates model on the is_main wiring', () => {
    updateGroup('whatsapp_family', { model: 'haiku' });
    expect(getGroupByFolder('whatsapp_family')!.model).toBe('haiku');
  });

  it('updates max_tool_rounds and timeout_ms', () => {
    updateGroup('whatsapp_family', { max_tool_rounds: 20, timeout_ms: 600000 });
    const family = getGroupByFolder('whatsapp_family')!;
    expect(family.max_tool_rounds).toBe(20);
    expect(family.timeout_ms).toBe(600000);
  });

  it('updates pipeline_replies_blocked', () => {
    updateGroup('whatsapp_main', { pipeline_replies_blocked: 1 });
    expect(getGroupByFolder('whatsapp_main')!.pipeline_replies_blocked).toBe(1);
  });

  it('updates threading_mode (→ session_mode)', () => {
    updateGroup('whatsapp_family', { threading_mode: 'per-thread' });
    expect(getGroupByFolder('whatsapp_family')!.threading_mode).toBe('per-thread');
  });

  it('returns false when no updates provided', () => {
    expect(updateGroup('whatsapp_family', {})).toBe(false);
  });

  it('returns false for non-existent folder', () => {
    expect(updateGroup('nonexistent', { model: 'haiku' })).toBe(false);
  });

  it('does not affect other fields', () => {
    updateGroup('whatsapp_family', { model: 'haiku' });
    const family = getGroupByFolder('whatsapp_family')!;
    expect(family.max_tool_rounds).toBe(10);
    expect(family.name).toBe('Family Chat');
  });
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('getTasksByGroup', () => {
  it('includes pipeline:* tasks running for the group', () => {
    // pipeline:* tasks are owned by the pipeline plugin but execute in
    // a specific group's session — they belong in the group's task list
    // alongside any container-mode tasks. The Pipeline overview also
    // surfaces them, which is fine (different navigation surface).
    const tasks = getTasksByGroup('whatsapp_main');
    expect(tasks.some((t) => t.id.startsWith('pipeline:'))).toBe(true);
  });

  it('returns empty array for group with no tasks', () => {
    expect(getTasksByGroup('nonexistent')).toEqual([]);
  });

  it('returns tasks sorted by next_run', () => {
    const tasks = getTasksByGroup('whatsapp_main');
    const taskIds = tasks.map((t) => t.id);
    expect(taskIds.indexOf('task-1')).toBeLessThan(taskIds.indexOf('task-2'));
  });

  it('includes all expected fields', () => {
    const task = getTasksByGroup('whatsapp_main')[0];
    expect(task.id).toBe('task-1');
    expect(task.prompt).toBe('Send briefing');
    expect(task.schedule_type).toBe('cron');
    expect(task.schedule_value).toBe('0 9 * * 1-5');
    expect(task.context_mode).toBe('group');
    expect(task.model).toBe('sonnet');
    expect(task.timezone).toBe('America/New_York');
    expect(task.status).toBe('active');
  });
});

describe('getTaskById', () => {
  it('returns a task by id', () => {
    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('Send briefing');
  });

  it('returns undefined for non-existent id', () => {
    expect(getTaskById('nonexistent')).toBeUndefined();
  });
});

describe('updateTask', () => {
  it('updates prompt', () => {
    updateTask('task-1', { prompt: 'New prompt' });
    expect(getTaskById('task-1')!.prompt).toBe('New prompt');
  });

  it('updates status', () => {
    updateTask('task-1', { status: 'paused' });
    expect(getTaskById('task-1')!.status).toBe('paused');
  });

  it('updates multiple fields at once', () => {
    updateTask('task-1', {
      prompt: 'Updated',
      model: 'haiku',
      max_tool_rounds: 5,
      timeout_ms: 60000,
    });
    const task = getTaskById('task-1')!;
    expect(task.prompt).toBe('Updated');
    expect(task.model).toBe('haiku');
    expect(task.max_tool_rounds).toBe(5);
    expect(task.timeout_ms).toBe(60000);
  });

  it('returns false when no updates provided', () => {
    expect(updateTask('task-1', {})).toBe(false);
  });

  it('returns false for non-existent task', () => {
    expect(updateTask('nonexistent', { status: 'paused' })).toBe(false);
  });
});

describe('getTaskRuns', () => {
  it('returns runs for a task ordered by most recent first', () => {
    const runs = getTaskRuns('task-1');
    expect(runs).toHaveLength(2);
    expect(runs[0].run_at).toBe('2024-06-02T09:00:00.000Z');
    expect(runs[1].run_at).toBe('2024-06-01T09:00:00.000Z');
  });

  it('respects the limit parameter', () => {
    const runs = getTaskRuns('task-1', 1);
    expect(runs).toHaveLength(1);
  });

  it('returns empty array for task with no runs', () => {
    expect(getTaskRuns('task-2')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Events / Intake / Observations
// ---------------------------------------------------------------------------

describe('getEvents', () => {
  it('returns all events when no filters', () => {
    expect(getEvents()).toHaveLength(2);
  });

  it('filters by type', () => {
    expect(getEvents({ types: ['observation.support'] })).toHaveLength(2);
  });

  it('filters by status', () => {
    const events = getEvents({ status: 'pending' });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('pending');
  });

  it('respects limit', () => {
    expect(getEvents({ limit: 1 })).toHaveLength(1);
  });

  it('returns events ordered by created_at desc', () => {
    const events = getEvents();
    expect(events[0].created_at).toBe('2024-06-01T11:00:00.000Z');
    expect(events[1].created_at).toBe('2024-06-01T10:00:00.000Z');
  });
});

describe('getIntakeLogs', () => {
  it('returns all intake logs', () => {
    expect(getIntakeLogs()).toHaveLength(2);
  });

  it('excludes processed logs when requested', () => {
    const logs = getIntakeLogs({ includeProcessed: false });
    expect(logs).toHaveLength(1);
    expect(logs[0].processed_at).toBeNull();
  });

  it('respects limit', () => {
    expect(getIntakeLogs({ limit: 1 })).toHaveLength(1);
  });
});

describe('getObservations', () => {
  it('returns all observations', () => {
    expect(getObservations()).toHaveLength(3);
  });

  it('includes label status', () => {
    const obs = getObservations();
    const labelled = obs.find((o) => o.id === 2);
    const unlabelled = obs.find((o) => o.id === 1);
    expect(labelled!.has_label).toBe(1);
    expect(unlabelled!.has_label).toBe(0);
  });

  it('filters by labelled status', () => {
    expect(getObservations({ labelled: true })).toHaveLength(1);
    expect(getObservations({ labelled: false })).toHaveLength(2);
  });

  it('filters by source_type', () => {
    expect(getObservations({ sourceType: 'passive_channel' })).toHaveLength(2);
    expect(getObservations({ sourceType: 'task_intake' })).toHaveLength(1);
  });
});

describe('getObservationById', () => {
  it('returns observation with label', () => {
    const obs = getObservationById(2);
    expect(obs).toBeDefined();
    expect(obs!.raw_text).toBe('Fixed the auth issue');
    expect(obs!.label).toBeDefined();
    expect(obs!.label!.intent).toBe('status_update');
  });

  it('returns observation without label', () => {
    const obs = getObservationById(1);
    expect(obs!.label).toBeNull();
  });

  it('returns undefined for non-existent id', () => {
    expect(getObservationById(999)).toBeUndefined();
  });
});

describe('upsertLabel', () => {
  it('inserts a new label', () => {
    upsertLabel(1, { intent: 'bug_report', form: 'free_prose', imperative_content: 'none' });
    expect(getObservationById(1)!.label!.intent).toBe('bug_report');
  });

  it('updates an existing label', () => {
    upsertLabel(2, { intent: 'fyi', notes: 'reclassified' });
    const obs = getObservationById(2);
    expect(obs!.label!.intent).toBe('fyi');
    expect(obs!.label!.notes).toBe('reclassified');
  });
});

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

describe('getPipelineTasks', () => {
  it('returns only pipeline:* tasks', () => {
    const tasks = getPipelineTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.id.startsWith('pipeline:'))).toBe(true);
  });

  it('includes model and execution_mode', () => {
    const sanitiser = getPipelineTasks().find((t) => t.id === 'pipeline:sanitiser')!;
    expect(sanitiser.model).toBe('ollama:gemma4');
    expect(sanitiser.execution_mode).toBe('host_pipeline');
  });
});

describe('getPipelineTokenUsage', () => {
  it('aggregates token usage for pipeline tasks', () => {
    const usage = getPipelineTokenUsage(365 * 3);
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].input_tokens).toBe(700);
    expect(usage[0].output_tokens).toBe(350);
  });
});

describe('getPassiveChannels (v2: pipeline_passive_subscriptions)', () => {
  it('returns enabled passive subscriptions joined with messaging_groups', () => {
    const channels = getPassiveChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Passive Channel');
    expect(channels[0].jid).toBe('CPASSIVE');
    expect(channels[0].mode).toBe('passive');
  });

  it('omits disabled subscriptions', () => {
    // No additional fixture work — disabled subs simply don't appear.
    expect(getPassiveChannels().length).toBe(1);
  });
});
