import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDb, closeDb } from '../db.js';
import { handleGetGroupTasks, handleGetTask, handleCreateTask, handlePatchTask, handleGetTaskRuns } from './tasks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-tasks-test-'));
  const dbPath = path.join(tmpDir, 'messages.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY, group_folder TEXT NOT NULL, chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL, schedule_type TEXT NOT NULL, schedule_value TEXT NOT NULL,
      next_run TEXT, last_run TEXT, last_result TEXT, status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL, context_mode TEXT DEFAULT 'isolated',
      model TEXT DEFAULT NULL, temperature REAL DEFAULT NULL, timezone TEXT DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL, timeout_ms INTEGER DEFAULT NULL,
      use_agent_sdk INTEGER DEFAULT 0,
      allowed_tools TEXT, allowed_send_targets TEXT,
      execution_mode TEXT NOT NULL DEFAULT 'container',
      subscribed_event_types TEXT,
      fallback_poll_ms INTEGER DEFAULT NULL
    );
    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      run_at TEXT NOT NULL, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
      result TEXT, error TEXT
    );
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT, folder TEXT UNIQUE, trigger_pattern TEXT,
      is_main INTEGER DEFAULT 0, requires_trigger INTEGER DEFAULT 1,
      model TEXT, temperature REAL, max_tool_rounds INTEGER, timeout_ms INTEGER,
      show_thinking INTEGER DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'active',
      threading_mode TEXT NOT NULL DEFAULT 'temporal'
    );
  `);

  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, model, temperature, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'task-1', 'slack_main', 'slack@main', 'Daily standup', 'cron', '0 9 * * 1-5',
    '2024-06-03T09:00:00.000Z', 'active', '2024-01-01T00:00:00.000Z', 'group', 'sonnet', null, 'America/New_York',
  );
  db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode, use_agent_sdk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'task-2', 'slack_main', 'slack@main', 'Weekly digest', 'cron', '0 8 * * 5',
    '2024-06-07T08:00:00.000Z', 'paused', '2024-02-01T00:00:00.000Z', 'isolated', 1,
  );

  db.prepare(`INSERT INTO registered_groups (jid, name, folder, trigger_pattern) VALUES (?, ?, ?, ?)`).run(
    'slack@main', 'Main', 'slack_main', '@bot',
  );

  db.prepare(`INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'task-1', '2024-06-02T09:00:00.000Z', 4500, 'success', 'Done', null,
  );
  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetGroupTasks', () => {
  it('returns tasks in camelCase', () => {
    const tasks = handleGetGroupTasks('slack_main');
    expect(tasks).toHaveLength(2);
    const t = tasks[0];
    expect(t.id).toBe('task-1');
    expect(t.scheduleType).toBe('cron');
    expect(t.scheduleValue).toBe('0 9 * * 1-5');
    expect(t.contextMode).toBe('group');
    expect(t.nextRun).toBe('2024-06-03T09:00:00.000Z');
    expect(t.createdAt).toBe('2024-01-01T00:00:00.000Z');
    // snake_case should not leak
    expect((t as any).schedule_type).toBeUndefined();
    expect((t as any).context_mode).toBeUndefined();
    expect((t as any).next_run).toBeUndefined();
    expect((t as any).created_at).toBeUndefined();
  });
});

describe('handleGetTask', () => {
  it('returns a task in camelCase', () => {
    const t = handleGetTask('task-1');
    expect(t).not.toBeNull();
    expect(t!.prompt).toBe('Daily standup');
    expect(t!.scheduleType).toBe('cron');
  });

  it('returns null for non-existent task', () => {
    expect(handleGetTask('nonexistent')).toBeNull();
  });
});

describe('handlePatchTask', () => {
  it('updates prompt and returns camelCase result', () => {
    const result = handlePatchTask('task-1', { prompt: 'Updated standup' });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.prompt).toBe('Updated standup');
    }
  });

  it('maps camelCase input to snake_case for DB', () => {
    const result = handlePatchTask('task-1', {
      scheduleType: 'once',
      scheduleValue: '2025-01-01T00:00:00Z',
      maxToolRounds: 5,
      timeoutMs: 60000,
    });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.scheduleType).toBe('once');
      expect(result.task.scheduleValue).toBe('2025-01-01T00:00:00Z');
      expect(result.task.maxToolRounds).toBe(5);
      expect(result.task.timeoutMs).toBe(60000);
    }
  });

  it('allows contextMode to be updated', () => {
    const result = handlePatchTask('task-1', { contextMode: 'isolated' });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.contextMode).toBe('isolated');
    }
  });

  it('returns error for non-existent task', () => {
    const result = handlePatchTask('nonexistent', { prompt: 'x' });
    expect('error' in result).toBe(true);
  });

  it('recomputes next_run when schedule value changes', () => {
    const result = handlePatchTask('task-1', { scheduleValue: '30 12 * * *' });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.nextRun).toBeTruthy();
      // next_run should be different from the original seed value
      expect(result.task.nextRun).not.toBe('2024-06-03T09:00:00.000Z');
    }
  });

  it('recomputes next_run when schedule type changes', () => {
    const result = handlePatchTask('task-1', {
      scheduleType: 'interval',
      scheduleValue: '3600000',
    });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.nextRun).toBeTruthy();
      const nextRun = new Date(result.task.nextRun!).getTime();
      expect(nextRun).toBeGreaterThan(Date.now());
    }
  });

  it('returns error for invalid cron expression', () => {
    const result = handlePatchTask('task-1', { scheduleValue: 'bad cron' });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBeTruthy();
    }
  });

  it('recomputes next_run when timezone changes', () => {
    const result = handlePatchTask('task-1', { timezone: 'Europe/London' });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.timezone).toBe('Europe/London');
      expect(result.task.nextRun).toBeTruthy();
    }
  });
});

describe('useAgentSdk', () => {
  it('returns useAgentSdk in task response', () => {
    const t1 = handleGetTask('task-1');
    expect(t1).not.toBeNull();
    expect(t1!.useAgentSdk).toBe(false);

    const t2 = handleGetTask('task-2');
    expect(t2).not.toBeNull();
    expect(t2!.useAgentSdk).toBe(true);
  });

  it('includes useAgentSdk in group tasks listing', () => {
    const tasks = handleGetGroupTasks('slack_main');
    expect(tasks).toHaveLength(2);
    const sdkTask = tasks.find(t => t.id === 'task-2');
    expect(sdkTask!.useAgentSdk).toBe(true);
  });

  it('can update useAgentSdk via patch', () => {
    const result = handlePatchTask('task-1', { useAgentSdk: true });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.useAgentSdk).toBe(true);
    }
  });

  it('can set useAgentSdk to false via patch', () => {
    const result = handlePatchTask('task-2', { useAgentSdk: false });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.useAgentSdk).toBe(false);
    }
  });

  it('can create task with useAgentSdk', () => {
    const result = handleCreateTask('slack_main', {
      prompt: 'SDK task',
      scheduleType: 'interval',
      scheduleValue: '60000',
      useAgentSdk: true,
    });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.useAgentSdk).toBe(true);
    }
  });

  it('defaults useAgentSdk to false on create', () => {
    const result = handleCreateTask('slack_main', {
      prompt: 'Default task',
      scheduleType: 'interval',
      scheduleValue: '60000',
    });
    expect('task' in result).toBe(true);
    if ('task' in result) {
      expect(result.task.useAgentSdk).toBe(false);
    }
  });
});

describe('handleGetTaskRuns', () => {
  it('returns runs in camelCase', () => {
    const runs = handleGetTaskRuns('task-1');
    expect(runs).toHaveLength(1);
    expect(runs[0].runAt).toBe('2024-06-02T09:00:00.000Z');
    expect(runs[0].durationMs).toBe(4500);
    expect(runs[0].status).toBe('success');
    expect((runs[0] as any).run_at).toBeUndefined();
    expect((runs[0] as any).duration_ms).toBeUndefined();
  });

  it('respects limit', () => {
    const runs = handleGetTaskRuns('task-1', 0);
    // limit 0 means nothing returned
    expect(runs).toHaveLength(0);
  });

  it('returns empty for task with no runs', () => {
    expect(handleGetTaskRuns('task-2')).toEqual([]);
  });
});
