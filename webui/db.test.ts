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
      max_tool_rounds INTEGER DEFAULT NULL,
      timeout_ms INTEGER DEFAULT NULL
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
      timezone TEXT DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL,
      timeout_ms INTEGER DEFAULT NULL
    );

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

  // Seed task run logs
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-02T09:00:00.000Z', 5000, 'success', 'Briefing sent', null,
  );
  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-01T09:00:00.000Z', 3000, 'error', null, 'Timeout',
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
    expect(groups).toHaveLength(2);
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
    expect(tasks).toHaveLength(2);
  });

  it('returns empty array for group with no tasks', () => {
    expect(getTasksByGroup('nonexistent')).toEqual([]);
  });

  it('returns tasks sorted by next_run', () => {
    const tasks = getTasksByGroup('whatsapp_main');
    expect(tasks[0].id).toBe('task-1'); // 2024-06-03
    expect(tasks[1].id).toBe('task-2'); // 2024-06-07
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
