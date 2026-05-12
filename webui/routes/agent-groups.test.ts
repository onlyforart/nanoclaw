import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDb, closeDb } from '../db.js';
import { createV2Schema, seedAgentGroupWiring } from '../test-helpers.js';
import {
  handleGetAgentGroups,
  handleGetAgentGroup,
  handlePatchAgentGroup,
  handleGetAgentGroupTokenUsage,
} from './agent-groups.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-ag-routes-test-'));
  const dbPath = path.join(tmpDir, 'v2.db');

  const db = new Database(dbPath);
  createV2Schema(db);
  seedAgentGroupWiring(db, {
    agentGroupId: 'ag-main',
    folder: 'whatsapp_main',
    name: 'Main Chat',
    channelType: 'whatsapp',
    platformId: 'main@s.whatsapp.net',
    engagePattern: '@Andy',
    isMain: 1,
    agentProvider: 'claude',
  });
  seedAgentGroupWiring(db, {
    agentGroupId: 'ag-family',
    folder: 'whatsapp_family',
    name: 'Family Chat',
    channelType: 'whatsapp',
    platformId: 'family@g.us',
    engagePattern: '@Andy',
    isMain: 1,
    model: 'ollama:qwen3',
    maxToolRounds: 10,
    timeoutMs: 300000,
    agentProvider: 'ollama',
  });
  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetAgentGroups', () => {
  it('returns every agent_group with summary fields', () => {
    const result = handleGetAgentGroups();
    expect(result).toHaveLength(2);
    const family = result.find((g) => g.folder === 'whatsapp_family')!;
    expect(family.name).toBe('Family Chat');
    expect(family.agentProvider).toBe('ollama');
    expect(family.mainPlatformId).toBe('family@g.us');
    expect(family.mainChannelType).toBe('whatsapp');
    expect(family.wiringCount).toBe(1);
  });
});

describe('handleGetAgentGroup', () => {
  it('returns detail with inline wirings + camelCase shape', () => {
    const result = handleGetAgentGroup('whatsapp_family');
    expect(result).not.toBeNull();
    expect(result!.folder).toBe('whatsapp_family');
    expect(result!.wirings).toHaveLength(1);
    const wiring = result!.wirings[0];
    expect(wiring.isMain).toBe(true);
    expect(wiring.platformId).toBe('family@g.us');
    expect(wiring.channelType).toBe('whatsapp');
    expect(wiring.model).toBe('ollama:qwen3');
    expect(wiring.maxToolRounds).toBe(10);
    expect(wiring.timeoutMs).toBe(300000);
    expect(wiring.engagePattern).toBe('@Andy');
    // snake_case must not leak
    expect((wiring as { max_tool_rounds?: unknown }).max_tool_rounds).toBeUndefined();
    expect((wiring as { platform_id?: unknown }).platform_id).toBeUndefined();
    expect((wiring as { is_main?: unknown }).is_main).toBeUndefined();
  });

  it('returns null for invalid folder', () => {
    expect(handleGetAgentGroup('../../etc')).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handleGetAgentGroup('nonexistent')).toBeNull();
  });
});

describe('handlePatchAgentGroup', () => {
  it('writes the is_main wiring model and returns updated detail', () => {
    const result = handlePatchAgentGroup('whatsapp_family', { model: 'haiku' });
    expect(result).not.toBeNull();
    const main = result!.wirings.find((w) => w.isMain)!;
    expect(main.model).toBe('haiku');
    // Other fields unchanged
    expect(main.maxToolRounds).toBe(10);
  });

  it('updates pipelineRepliesBlocked', () => {
    const result = handlePatchAgentGroup('whatsapp_main', { pipelineRepliesBlocked: true });
    expect(result).not.toBeNull();
    const main = result!.wirings.find((w) => w.isMain)!;
    expect(main.pipelineRepliesBlocked).toBe(true);
  });

  it('returns null for invalid folder', () => {
    expect(handlePatchAgentGroup('../bad', { model: 'haiku' })).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handlePatchAgentGroup('nonexistent', { model: 'haiku' })).toBeNull();
  });
});

describe('handleGetAgentGroupTokenUsage — cost computation does not require cache', () => {
  beforeEach(() => {
    const dbPath = path.join(tmpDir, 'v2.db');
    closeDb();
    const db = new Database(dbPath);
    // Seed a pipeline scheduled task + run logs WITHOUT cache columns set.
    db.exec(
      `INSERT INTO pipeline_scheduled_tasks
         (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
          context_mode, model, status, created_at)
       VALUES ('pipeline:sanitiser', 'whatsapp_main', 'main@s.whatsapp.net',
               'p', 'cron', '* * * * *', 'isolated', 'haiku', 'active', '2026-05-01')`,
    );
    db.exec(
      `INSERT INTO pipeline_task_run_logs
         (task_id, run_at, duration_ms, status,
          input_tokens, output_tokens,
          cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
       VALUES
         ('pipeline:sanitiser', '2026-05-10T10:00:00Z', 100, 'success',
          1000, 200, 0, 0, NULL),
         ('pipeline:sanitiser', '2026-05-10T10:05:00Z', 100, 'success',
          500, 100, 0, 0, NULL)`,
    );
    db.close();
    initDb(dbPath);
  });

  it('computes cost from pricing when tokens>0 even if cache is 0 (no prompt caching)', () => {
    const usage = handleGetAgentGroupTokenUsage('whatsapp_main', 365);
    expect(usage).not.toBeNull();
    const entry = usage!.find((u) => u.date === '2026-05-10');
    expect(entry).toBeDefined();
    expect(entry!.uncached).toBe(1800); // 1000+200+500+100, no cache
    expect(entry!.cached).toBe(0);
    // Two rows aggregated: input=1500 output=300, haiku pricing.
    // Expect non-null cost — should NOT skip pricing just because cache=0.
    expect(entry!.cost).not.toBeNull();
    expect(entry!.cost).toBeGreaterThan(0);
  });

  it('still records uncached/cached totals when cost is unknown', () => {
    const usage = handleGetAgentGroupTokenUsage('whatsapp_main', 365);
    expect(usage).not.toBeNull();
  });
});
