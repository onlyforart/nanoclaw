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
} from './db.js';

let tmpDir: string;

// Create a temporary database with the real schema, then point the webui db at it
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-db-test-'));
  const dbPath = path.join(tmpDir, 'messages.db');

  // Create the schema directly (mirrors src/db.ts createSchema)
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0,
      model TEXT DEFAULT NULL,
      temperature REAL DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL,
      timeout_ms INTEGER DEFAULT NULL,
      show_thinking INTEGER DEFAULT NULL,
      mode TEXT NOT NULL DEFAULT 'active',
      threading_mode TEXT NOT NULL DEFAULT 'temporal'
    );

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
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      model TEXT DEFAULT NULL,
      temperature REAL DEFAULT NULL,
      timezone TEXT DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL,
      timeout_ms INTEGER DEFAULT NULL,
      use_agent_sdk INTEGER DEFAULT 0,
      allowed_tools TEXT,
      allowed_send_targets TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'container',
      subscribed_event_types TEXT
    );

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cost_usd REAL,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );

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

    CREATE TABLE IF NOT EXISTS pipeline_intake_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      raw_text_hash TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_task_id TEXT,
      source_channel TEXT,
      source_message_id TEXT,
      reason TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      processed_at TEXT,
      observation_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS observed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chat_jid TEXT,
      source_message_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'passive_channel',
      source_task_id TEXT,
      source_group TEXT,
      intake_reason TEXT,
      intake_event_id INTEGER,
      thread_id TEXT,
      related_observation_ids TEXT,
      raw_text TEXT NOT NULL,
      sanitised_json TEXT,
      sanitiser_model TEXT,
      sanitiser_version TEXT,
      flags TEXT,
      created_at TEXT NOT NULL,
      sanitised_at TEXT
    );

    CREATE TABLE IF NOT EXISTS observation_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id INTEGER NOT NULL,
      labeller TEXT NOT NULL DEFAULT 'human',
      intent TEXT,
      form TEXT,
      imperative_content TEXT,
      addressee TEXT,
      embedded_instructions TEXT,
      adversarial_smell INTEGER,
      notes TEXT,
      expected_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );
  `);

  // Seed test data
  db.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, model, max_tool_rounds, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'main@s.whatsapp.net', 'Main Chat', 'whatsapp_main', '@Andy', '2024-01-01T00:00:00.000Z', 1, null, null, null,
  );
  db.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, model, max_tool_rounds, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'family@g.us', 'Family Chat', 'whatsapp_family', '@Andy', '2024-01-02T00:00:00.000Z', 0, 'ollama:qwen3', 10, 300000,
  );

  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, model, timezone, max_tool_rounds, timeout_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'task-1', 'whatsapp_main', 'main@s.whatsapp.net', 'Send briefing', 'cron', '0 9 * * 1-5', '2024-06-03T09:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'group', 'sonnet', 'America/New_York', null, null,
  );
  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'task-2', 'whatsapp_main', 'main@s.whatsapp.net', 'Weekly report', 'cron', '0 8 * * 5', '2024-06-07T08:00:00.000Z', 'active', '2024-01-05T00:00:00.000Z', 'isolated',
  );
  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'task-3', 'whatsapp_family', 'family@g.us', 'Family reminder', 'cron', '0 18 * * *', '2024-06-03T18:00:00.000Z', 'paused', '2024-02-01T00:00:00.000Z', 'isolated',
  );

  // Seed pipeline tasks
  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, model, execution_mode, allowed_tools, subscribed_event_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'pipeline:sanitiser', 'whatsapp_main', 'main@s.whatsapp.net', 'Extract observations', 'cron', '*/1 * * * *', '2024-06-03T10:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'isolated', 'ollama:gemma4', 'host_pipeline', '[]', '["intake.raw"]',
  );
  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, model, execution_mode, allowed_tools) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'pipeline:monitor', 'whatsapp_main', 'main@s.whatsapp.net', 'Cluster observations', 'cron', '*/2 * * * *', '2024-06-03T10:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'isolated', 'ollama:gemma4', 'container', '["consume_events","publish_event"]',
  );

  // Seed task run logs
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-02T09:00:00.000Z', 5000, 'success', 'Briefing sent', null,
  );
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-01T09:00:00.000Z', 3000, 'error', null, 'Timeout',
  );
  // Pipeline task run logs
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'pipeline:sanitiser', '2024-06-02T10:00:00.000Z', 1500, 'success', 'Processed 5 messages', null, 500, 250,
  );
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'pipeline:sanitiser', '2024-06-02T10:01:00.000Z', 800, 'success', 'Processed 2 messages', null, 200, 100,
  );

  // Seed a passive group
  db.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, is_main, mode, threading_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'slack:CPASSIVE', 'Passive Channel', 'slack_passive', '@Andy', '2024-03-01T00:00:00.000Z', 0, 'passive', 'thread_aware',
  );

  // Seed events
  db.prepare(`INSERT INTO events (type, source_group, source_task_id, payload, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'observation.support', 'slack_main', 'pipeline:sanitiser', '{"summary":"INC down"}', '2024-06-01T10:00:00.000Z', 'pending',
  );
  db.prepare(`INSERT INTO events (type, source_group, source_task_id, payload, created_at, status, claimed_by, claimed_at, processed_at, result_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'observation.support', 'slack_main', 'pipeline:sanitiser', '{"summary":"fixed"}', '2024-06-01T11:00:00.000Z', 'done', 'pipeline:monitor', '2024-06-01T11:01:00.000Z', '2024-06-01T11:02:00.000Z', 'processed',
  );

  // Seed intake logs
  db.prepare(`INSERT INTO pipeline_intake_log (event_id, raw_text_hash, source_type, source_group, source_task_id, reason, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    1, 'abc123', 'task', 'slack_main', 'pipeline:monitor', 'found during investigation', '2024-06-01T10:30:00.000Z',
  );
  db.prepare(`INSERT INTO pipeline_intake_log (event_id, raw_text_hash, source_type, source_group, source_task_id, reason, submitted_at, processed_at, observation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    2, 'def456', 'task', 'slack_main', 'pipeline:monitor', 'another find', '2024-06-01T11:30:00.000Z', '2024-06-01T11:35:00.000Z', 42,
  );

  // Seed observed messages
  db.prepare(`INSERT INTO observed_messages (source_chat_jid, source_message_id, source_type, raw_text, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    'slack:CPASSIVE', 'msg-obs-1', 'passive_channel', 'INC12345 is down again', '2024-06-01T10:00:00.000Z',
  );
  db.prepare(`INSERT INTO observed_messages (source_chat_jid, source_message_id, source_type, raw_text, sanitised_json, created_at, sanitised_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'slack:CPASSIVE', 'msg-obs-2', 'passive_channel', 'Fixed the auth issue', '{"fact_summary":"auth fixed"}', '2024-06-01T11:00:00.000Z', '2024-06-01T11:01:00.000Z',
  );
  db.prepare(`INSERT INTO observed_messages (source_type, source_task_id, source_group, intake_reason, intake_event_id, raw_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'task_intake', 'pipeline:monitor', 'slack_main', 'found during investigation', 99, 'forwarded log content', '2024-06-01T12:00:00.000Z',
  );

  // Seed a label for observation 2
  db.prepare(`INSERT INTO observation_labels (observation_id, labeller, intent, form, imperative_content, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    2, 'human', 'status_update', 'free_prose', 'none', '2024-06-01T12:00:00.000Z',
  );

  db.close();

  // Init the webui db module pointing at this temp database
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Groups ---

describe('getAllGroups', () => {
  it('returns all registered groups', () => {
    const groups = getAllGroups();
    expect(groups).toHaveLength(3);
  });

  it('returns groups sorted by name', () => {
    const groups = getAllGroups();
    expect(groups[0].name).toBe('Family Chat');
    expect(groups[1].name).toBe('Main Chat');
  });

  it('includes all expected fields', () => {
    const groups = getAllGroups();
    const family = groups.find((g) => g.folder === 'whatsapp_family')!;
    expect(family.jid).toBe('family@g.us');
    expect(family.name).toBe('Family Chat');
    expect(family.trigger_pattern).toBe('@Andy');
    expect(family.is_main).toBe(0);
    expect(family.requires_trigger).toBe(1);
    expect(family.model).toBe('ollama:qwen3');
    expect(family.max_tool_rounds).toBe(10);
    expect(family.timeout_ms).toBe(300000);
  });
});

describe('getGroupByFolder', () => {
  it('returns the group for a valid folder', () => {
    const group = getGroupByFolder('whatsapp_main');
    expect(group).toBeDefined();
    expect(group!.jid).toBe('main@s.whatsapp.net');
    expect(group!.is_main).toBe(1);
  });

  it('returns undefined for non-existent folder', () => {
    expect(getGroupByFolder('nonexistent')).toBeUndefined();
  });
});

describe('updateGroup', () => {
  it('updates model', () => {
    updateGroup('whatsapp_family', { model: 'haiku' });
    const group = getGroupByFolder('whatsapp_family');
    expect(group!.model).toBe('haiku');
  });

  it('updates max_tool_rounds and timeout_ms', () => {
    updateGroup('whatsapp_family', { max_tool_rounds: 20, timeout_ms: 600000 });
    const group = getGroupByFolder('whatsapp_family');
    expect(group!.max_tool_rounds).toBe(20);
    expect(group!.timeout_ms).toBe(600000);
  });

  it('returns false when no updates provided', () => {
    expect(updateGroup('whatsapp_family', {})).toBe(false);
  });

  it('returns false for non-existent folder', () => {
    expect(updateGroup('nonexistent', { model: 'haiku' })).toBe(false);
  });

  it('does not affect other fields', () => {
    updateGroup('whatsapp_family', { model: 'haiku' });
    const group = getGroupByFolder('whatsapp_family');
    expect(group!.max_tool_rounds).toBe(10); // unchanged
    expect(group!.name).toBe('Family Chat'); // unchanged
  });
});

// --- Tasks ---

describe('getTasksByGroup', () => {
  it('returns tasks for a group', () => {
    const tasks = getTasksByGroup('whatsapp_main');
    expect(tasks).toHaveLength(4); // 2 regular + 2 pipeline
  });

  it('returns empty array for group with no tasks', () => {
    expect(getTasksByGroup('nonexistent')).toEqual([]);
  });

  it('returns tasks sorted by next_run', () => {
    const tasks = getTasksByGroup('whatsapp_main');
    // task-1 (June 3) before task-2 (June 7); pipeline tasks also in the mix
    const taskIds = tasks.map((t: any) => t.id);
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

  it('updates schedule fields', () => {
    updateTask('task-1', { schedule_type: 'once', schedule_value: '2025-01-01T00:00:00Z' });
    const task = getTaskById('task-1')!;
    expect(task.schedule_type).toBe('once');
    expect(task.schedule_value).toBe('2025-01-01T00:00:00Z');
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

// --- Task Runs ---

describe('getTaskRuns', () => {
  it('returns runs for a task ordered by most recent first', () => {
    const runs = getTaskRuns('task-1');
    expect(runs).toHaveLength(2);
    expect(runs[0].run_at).toBe('2024-06-02T09:00:00.000Z');
    expect(runs[1].run_at).toBe('2024-06-01T09:00:00.000Z');
  });

  it('includes all expected fields', () => {
    const runs = getTaskRuns('task-1');
    expect(runs[0].duration_ms).toBe(5000);
    expect(runs[0].status).toBe('success');
    expect(runs[0].result).toBe('Briefing sent');
    expect(runs[0].error).toBeNull();
    expect(runs[1].status).toBe('error');
    expect(runs[1].error).toBe('Timeout');
  });

  it('respects the limit parameter', () => {
    const runs = getTaskRuns('task-1', 1);
    expect(runs).toHaveLength(1);
    expect(runs[0].run_at).toBe('2024-06-02T09:00:00.000Z');
  });

  it('returns empty array for task with no runs', () => {
    expect(getTaskRuns('task-2')).toEqual([]);
  });

  it('returns empty array for non-existent task', () => {
    expect(getTaskRuns('nonexistent')).toEqual([]);
  });
});

// --- Group mode + threading_mode ---

describe('group mode and threading_mode', () => {
  it('returns mode field from getAllGroups', () => {
    const groups = getAllGroups();
    const passive = groups.find((g) => g.folder === 'slack_passive')!;
    expect(passive.mode).toBe('passive');
  });

  it('returns threading_mode field from getGroupByFolder', () => {
    const group = getGroupByFolder('slack_passive');
    expect(group!.threading_mode).toBe('thread_aware');
  });

  it('defaults mode to active for groups without explicit mode', () => {
    const group = getGroupByFolder('whatsapp_main');
    expect(group!.mode).toBe('active');
  });

  it('updates mode via updateGroup', () => {
    updateGroup('whatsapp_family', { mode: 'passive' });
    const group = getGroupByFolder('whatsapp_family');
    expect(group!.mode).toBe('passive');
  });

  it('updates threading_mode via updateGroup', () => {
    updateGroup('whatsapp_family', { threading_mode: 'thread_aware' });
    const group = getGroupByFolder('whatsapp_family');
    expect(group!.threading_mode).toBe('thread_aware');
  });
});

// --- Task capability fields ---

describe('task allowed_tools and allowed_send_targets', () => {
  it('returns null for tasks without allowed_tools', () => {
    const task = getTaskById('task-1');
    expect(task!.allowed_tools).toBeNull();
  });

  it('updates allowed_tools via updateTask', () => {
    updateTask('task-1', { allowed_tools: '["consume_events","publish_event"]' });
    const task = getTaskById('task-1');
    expect(task!.allowed_tools).toBe('["consume_events","publish_event"]');
  });

  it('updates allowed_send_targets via updateTask', () => {
    updateTask('task-1', { allowed_send_targets: '["slack:CPASSIVE"]' });
    const task = getTaskById('task-1');
    expect(task!.allowed_send_targets).toBe('["slack:CPASSIVE"]');
  });

  it('updates execution_mode via updateTask', () => {
    updateTask('task-1', { execution_mode: 'host_pipeline' });
    const task = getTaskById('task-1');
    expect(task!.execution_mode).toBe('host_pipeline');
  });

  it('updates subscribed_event_types via updateTask', () => {
    updateTask('task-1', { subscribed_event_types: '["intake.raw"]' });
    const task = getTaskById('task-1');
    expect(task!.subscribed_event_types).toBe('["intake.raw"]');
  });
});

// --- Events ---

describe('getEvents', () => {
  it('returns all events when no filters', () => {
    const events = getEvents();
    expect(events).toHaveLength(2);
  });

  it('filters by type', () => {
    const events = getEvents({ types: ['observation.support'] });
    expect(events).toHaveLength(2);
  });

  it('filters by status', () => {
    const events = getEvents({ status: 'pending' });
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('pending');
  });

  it('respects limit', () => {
    const events = getEvents({ limit: 1 });
    expect(events).toHaveLength(1);
  });

  it('returns events ordered by created_at desc', () => {
    const events = getEvents();
    expect(events[0].created_at).toBe('2024-06-01T11:00:00.000Z');
    expect(events[1].created_at).toBe('2024-06-01T10:00:00.000Z');
  });
});

// --- Intake logs ---

describe('getIntakeLogs', () => {
  it('returns all intake logs', () => {
    const logs = getIntakeLogs();
    expect(logs).toHaveLength(2);
  });

  it('excludes processed logs when requested', () => {
    const logs = getIntakeLogs({ includeProcessed: false });
    expect(logs).toHaveLength(1);
    expect(logs[0].processed_at).toBeNull();
  });

  it('includes processed logs when requested', () => {
    const logs = getIntakeLogs({ includeProcessed: true });
    expect(logs).toHaveLength(2);
  });

  it('respects limit', () => {
    const logs = getIntakeLogs({ limit: 1 });
    expect(logs).toHaveLength(1);
  });

  it('returns logs ordered by submitted_at desc', () => {
    const logs = getIntakeLogs();
    expect(logs[0].submitted_at).toBe('2024-06-01T11:30:00.000Z');
  });
});

// --- Observations ---

describe('getObservations', () => {
  it('returns all observations', () => {
    const obs = getObservations();
    expect(obs).toHaveLength(3);
  });

  it('includes label status', () => {
    const obs = getObservations();
    const labelled = obs.find((o: any) => o.id === 2);
    const unlabelled = obs.find((o: any) => o.id === 1);
    expect(labelled!.has_label).toBe(1);
    expect(unlabelled!.has_label).toBe(0);
  });

  it('filters by labelled status', () => {
    const labelled = getObservations({ labelled: true });
    expect(labelled).toHaveLength(1);
    expect(labelled[0].id).toBe(2);

    const unlabelled = getObservations({ labelled: false });
    expect(unlabelled).toHaveLength(2);
  });

  it('filters by source_type', () => {
    const passive = getObservations({ sourceType: 'passive_channel' });
    expect(passive).toHaveLength(2);

    const intake = getObservations({ sourceType: 'task_intake' });
    expect(intake).toHaveLength(1);
  });

  it('respects limit and offset', () => {
    const page1 = getObservations({ limit: 2, offset: 0 });
    expect(page1).toHaveLength(2);

    const page2 = getObservations({ limit: 2, offset: 2 });
    expect(page2).toHaveLength(1);
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
    expect(obs).toBeDefined();
    expect(obs!.raw_text).toBe('INC12345 is down again');
    expect(obs!.label).toBeNull();
  });

  it('returns undefined for non-existent id', () => {
    expect(getObservationById(999)).toBeUndefined();
  });
});

describe('upsertLabel', () => {
  it('inserts a new label', () => {
    upsertLabel(1, {
      intent: 'bug_report',
      form: 'free_prose',
      imperative_content: 'none',
      addressee: 'nobody',
    });

    const obs = getObservationById(1);
    expect(obs!.label).toBeDefined();
    expect(obs!.label!.intent).toBe('bug_report');
  });

  it('updates an existing label', () => {
    upsertLabel(2, {
      intent: 'fyi',
      notes: 'reclassified',
    });

    const obs = getObservationById(2);
    expect(obs!.label!.intent).toBe('fyi');
    expect(obs!.label!.notes).toBe('reclassified');
  });
});

// --- Pipeline ---

describe('getPipelineTasks', () => {
  it('returns only pipeline:* tasks', () => {
    const tasks = getPipelineTasks();
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t: any) => t.id.startsWith('pipeline:'))).toBe(true);
  });

  it('includes model, execution_mode, and allowed_tools', () => {
    const tasks = getPipelineTasks();
    const sanitiser = tasks.find((t: any) => t.id === 'pipeline:sanitiser');
    expect(sanitiser).toBeDefined();
    expect(sanitiser!.model).toBe('ollama:gemma4');
    expect(sanitiser!.execution_mode).toBe('host_pipeline');
  });
});

describe('getPipelineTokenUsage', () => {
  it('returns aggregated token usage for pipeline tasks', () => {
    const usage = getPipelineTokenUsage(365 * 3); // wide window to catch seed data
    expect(usage.length).toBeGreaterThanOrEqual(1);
    expect(usage[0].input_tokens).toBe(700); // 500 + 200
    expect(usage[0].output_tokens).toBe(350); // 250 + 100
  });
});

describe('getPassiveChannels', () => {
  it('returns groups with mode=passive', () => {
    const channels = getPassiveChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('Passive Channel');
    expect(channels[0].mode).toBe('passive');
  });
});
