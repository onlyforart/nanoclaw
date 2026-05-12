import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestDb, closeDb, runMigrations } from './index.js';
import { getDb } from './connection.js';
import { insertContainerTaskRunLog } from './container-task-run-logs.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('container_task_run_logs migration + helper', () => {
  it('migration creates the table with the expected columns', () => {
    const cols = (
      getDb().prepare('PRAGMA table_info(container_task_run_logs)').all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'task_id',
        'agent_group_id',
        'group_folder',
        'run_at',
        'duration_ms',
        'status',
        'result',
        'error',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'cost_usd',
      ]),
    );
  });

  it('insertContainerTaskRunLog round-trips a row', () => {
    insertContainerTaskRunLog({
      task_id: 'task-abc',
      agent_group_id: 'ag-1',
      group_folder: 'slack_main',
      run_at: '2026-05-12T16:00:00Z',
      duration_ms: 1234,
      status: 'success',
      result: 'ok',
      model: 'haiku',
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 12000,
      cache_creation_input_tokens: 0,
    });

    const row = getDb()
      .prepare(`SELECT * FROM container_task_run_logs WHERE task_id = 'task-abc'`)
      .get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.group_folder).toBe('slack_main');
    expect(row.input_tokens).toBe(1000);
    expect(row.cache_read_input_tokens).toBe(12000);
    expect(row.cost_usd).toBeNull();
  });

  it('insertContainerTaskRunLog defaults missing optional fields to NULL', () => {
    insertContainerTaskRunLog({
      task_id: 'task-min',
      agent_group_id: 'ag-1',
      group_folder: 'slack_main',
      run_at: '2026-05-12T16:00:00Z',
      duration_ms: 1,
      status: 'success',
    });

    const row = getDb()
      .prepare(`SELECT * FROM container_task_run_logs WHERE task_id = 'task-min'`)
      .get() as Record<string, unknown>;
    expect(row.result).toBeNull();
    expect(row.model).toBeNull();
    expect(row.input_tokens).toBeNull();
    expect(row.cache_read_input_tokens).toBeNull();
  });

  it('index idx_container_task_run_logs_lookup exists', () => {
    const indexes = getDb()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='container_task_run_logs'`,
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_container_task_run_logs_lookup');
  });
});
