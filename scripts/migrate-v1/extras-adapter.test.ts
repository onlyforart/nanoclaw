/**
 * TDD tests for the Phase 3 extras adapter.
 *
 * The adapter runs AFTER upstream tooling has seeded agent_groups,
 * messaging_groups, messaging_group_agents, and per-session messages_in
 * rows. Its job is to backfill the columns upstream doesn't know about
 * (our fork extras) and to seed `user_roles(role='owner')` from v1's
 * `is_main` rows.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrations/index.js';

import { applyExtras } from './extras-adapter.js';
import { buildFixtureV1Db } from './build-fixture.js';

interface Ctx {
  tmpDir: string;
  v1Db: Database.Database;
  v2Db: Database.Database;
  v2Path: string;
}

function seedV2PostUpstream(v2Db: Database.Database): {
  agAlphaId: string;
  agBetaId: string;
  agGammaId: string;
  mgaAlpha: string;
  mgaBeta: string;
  mgaGamma: string;
} {
  const t = '2025-12-04T00:00:00Z';
  v2Db.exec(`
    INSERT INTO agent_groups (id, name, folder, created_at) VALUES
      ('ag-alpha', 'Alpha', 'alpha-folder', '${t}'),
      ('ag-beta',  'Beta',  'beta-folder',  '${t}'),
      ('ag-gamma', 'Gamma', 'gamma-folder', '${t}');
    INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at) VALUES
      ('mg-alpha', 'slack',    'slack:C000ALPHA',          'Alpha', 1, '${t}'),
      ('mg-beta',  'telegram', 'telegram:-1001',            'Beta',  1, '${t}'),
      ('mg-gamma', 'whatsapp', 'whatsapp:111-222@g.us',     'Gamma', 1, '${t}');
    INSERT INTO messaging_group_agents
      (id, messaging_group_id, agent_group_id, priority, created_at) VALUES
      ('mga-alpha', 'mg-alpha', 'ag-alpha', 0, '${t}'),
      ('mga-beta',  'mg-beta',  'ag-beta',  0, '${t}'),
      ('mga-gamma', 'mg-gamma', 'ag-gamma', 0, '${t}');
  `);
  return {
    agAlphaId: 'ag-alpha',
    agBetaId: 'ag-beta',
    agGammaId: 'ag-gamma',
    mgaAlpha: 'mga-alpha',
    mgaBeta: 'mga-beta',
    mgaGamma: 'mga-gamma',
  };
}

function seedV2MessagesIn(
  v2Path: string,
  agId: string,
  sessionId: string,
  taskId: string,
  initialContent: object,
): { inboundDbPath: string } {
  const sessionDir = path.join(path.dirname(v2Path), 'v2-sessions', agId, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const inbound = new Database(path.join(sessionDir, 'inbound.db'));
  inbound.exec(`
    CREATE TABLE messages_in (
      id TEXT PRIMARY KEY,
      seq INTEGER UNIQUE,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      content TEXT NOT NULL
    );
    INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES
      ('${taskId}', 2, 'task', '2025-12-04T00:00:00Z', 'pending',
       '${JSON.stringify(initialContent).replace(/'/g, "''")}');
  `);
  inbound.close();
  return { inboundDbPath: path.join(sessionDir, 'inbound.db') };
}

describe('extras adapter — registered_groups → messaging_group_agents', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupCtx();
    seedV2PostUpstream(ctx.v2Db);
  });
  afterEach(() => teardown(ctx));

  it('backfills non-NULL extras onto the matching messaging_group_agents row', () => {
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    expect(r.registeredGroupsBackfilled).toBe(1);
    const row = ctx.v2Db
      .prepare(`SELECT model, max_tool_rounds, timeout_ms, temperature, show_thinking
                FROM messaging_group_agents WHERE id = 'mga-alpha'`)
      .get() as Record<string, unknown>;
    expect(row.model).toBe('claude-sonnet-4-5');
    expect(row.max_tool_rounds).toBe(30);
    expect(row.timeout_ms).toBe(600000);
    expect(row.temperature).toBe(0.4);
    expect(row.show_thinking).toBe(1);
  });

  it('leaves messaging_group_agents untouched when all v1 extras are NULL', () => {
    applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    const row = ctx.v2Db
      .prepare(`SELECT model, max_tool_rounds FROM messaging_group_agents WHERE id = 'mga-beta'`)
      .get() as Record<string, unknown>;
    expect(row.model).toBeNull();
    expect(row.max_tool_rounds).toBeNull();
  });

  it('skips v1 rows whose folder + jid have no v2 match (warns in skipped[])', () => {
    ctx.v2Db.exec(`DELETE FROM messaging_group_agents WHERE id = 'mga-alpha'`);
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    expect(r.skipped.some((s) => s.includes('alpha-folder'))).toBe(true);
  });

  it('is idempotent — running twice produces identical state', () => {
    applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    const row = ctx.v2Db
      .prepare(`SELECT model FROM messaging_group_agents WHERE id = 'mga-alpha'`)
      .get() as { model: string };
    expect(row.model).toBe('claude-sonnet-4-5');
  });
});

describe('extras adapter — is_main → user_roles(owner)', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupCtx();
    seedV2PostUpstream(ctx.v2Db);
  });
  afterEach(() => teardown(ctx));

  it('seeds users + user_roles owner row when ownerUserId is set', () => {
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    expect(r.ownerSeeded).toBe(true);
    const user = ctx.v2Db
      .prepare(`SELECT id, kind FROM users WHERE id = 'slack:U001'`)
      .get() as { id: string; kind: string };
    expect(user.id).toBe('slack:U001');
    expect(user.kind).toBe('slack');
    const role = ctx.v2Db
      .prepare(`SELECT role, agent_group_id FROM user_roles WHERE user_id = 'slack:U001'`)
      .get() as { role: string; agent_group_id: string | null };
    expect(role.role).toBe('owner');
    expect(role.agent_group_id).toBeNull();
  });

  it('skips owner seeding when ownerUserId is unset; adds an actionable note', () => {
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { v2DbPath: ctx.v2Path });
    expect(r.ownerSeeded).toBe(false);
    expect(r.skipped.some((s) => s.includes('NANOCLAW_V1_OWNER_USER_ID'))).toBe(true);
  });

  it('does not seed owner when no v1 row has is_main=1', () => {
    ctx.v1Db.exec(`UPDATE registered_groups SET is_main = 0`);
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    expect(r.ownerSeeded).toBe(false);
    const count = ctx.v2Db
      .prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE role = 'owner'`)
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('is idempotent: running twice does not duplicate the owner role', () => {
    applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    const count = ctx.v2Db
      .prepare(`SELECT COUNT(*) AS n FROM user_roles WHERE user_id = 'slack:U001'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('rejects ownerUserId without a channel prefix (id must be "<channel>:<handle>")', () => {
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'no-prefix-id', v2DbPath: ctx.v2Path });
    expect(r.ownerSeeded).toBe(false);
    expect(r.skipped.some((s) => s.includes('must be "<channel>:<handle>"'))).toBe(true);
  });
});

describe('extras adapter — scheduled_tasks → messages_in content blob', () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupCtx();
    seedV2PostUpstream(ctx.v2Db);
  });
  afterEach(() => teardown(ctx));

  function seedSession(agId: string, mgId: string): string {
    const sessionId = `session-${agId}`;
    ctx.v2Db
      .prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, created_at)
         VALUES (?, ?, ?, '2025-12-04T00:00:00Z')`,
      )
      .run(sessionId, agId, mgId);
    return sessionId;
  }

  it('extends upstream messages_in content blob with v1 extras for container-mode tasks', () => {
    const sessionAlpha = seedSession('ag-alpha', 'mg-alpha');
    seedV2MessagesIn(ctx.v2Path, 'ag-alpha', sessionAlpha, 'task-alpha-daily', {
      prompt: 'daily summary',
      script: null,
      migrated_from_v1: { original_id: 'task-alpha-daily', context_mode: 'isolated' },
    });

    const r = applyExtras(ctx.v1Db, ctx.v2Db, { ownerUserId: 'slack:U001', v2DbPath: ctx.v2Path });
    expect(r.scheduledTasksBackfilled).toBeGreaterThanOrEqual(1);

    const sessionDir = path.join(
      path.dirname(ctx.v2Path),
      'v2-sessions',
      'ag-alpha',
      sessionAlpha,
    );
    const inbound = new Database(path.join(sessionDir, 'inbound.db'), { readonly: true });
    const row = inbound
      .prepare(`SELECT content FROM messages_in WHERE id = 'task-alpha-daily'`)
      .get() as { content: string };
    inbound.close();
    const parsed = JSON.parse(row.content);
    expect(parsed.migrated_from_v1.v1_extras.max_tool_rounds).toBe(50);
    expect(parsed.migrated_from_v1.v1_extras.timezone).toBe('UTC');
    expect(parsed.migrated_from_v1.context_mode).toBe('isolated');
  });

  it('skips host_pipeline tasks — those go to pipeline_scheduled_tasks (Phase 4)', () => {
    const sessionGamma = seedSession('ag-gamma', 'mg-gamma');
    // Notably: pipeline:sanitiser should NOT be in messages_in — but if a buggy
    // upstream re-import seeds it anyway, the adapter must not write to it.
    seedV2MessagesIn(ctx.v2Path, 'ag-gamma', sessionGamma, 'pipeline:sanitiser', {
      prompt: 'sanitise',
      migrated_from_v1: { original_id: 'pipeline:sanitiser' },
    });
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { v2DbPath: ctx.v2Path });
    const sessionDir = path.join(
      path.dirname(ctx.v2Path),
      'v2-sessions',
      'ag-gamma',
      sessionGamma,
    );
    const inbound = new Database(path.join(sessionDir, 'inbound.db'), { readonly: true });
    const row = inbound
      .prepare(`SELECT content FROM messages_in WHERE id = 'pipeline:sanitiser'`)
      .get() as { content: string };
    inbound.close();
    const parsed = JSON.parse(row.content);
    // host_pipeline row should NOT have v1_extras backfilled by this adapter.
    expect(parsed.migrated_from_v1.v1_extras).toBeUndefined();
    // No counter increment for this row.
    expect(r.skipped.some((s) => s.includes('host_pipeline'))).toBe(true);
  });

  it('emits actionable note when a container task has no corresponding messages_in row', () => {
    seedSession('ag-alpha', 'mg-alpha');
    const r = applyExtras(ctx.v1Db, ctx.v2Db, { v2DbPath: ctx.v2Path });
    expect(r.skipped.some((s) => s.includes('task-alpha-daily'))).toBe(true);
  });
});

// ── Helpers ────────────────────────────────────────────────────────────

function setupCtx(): Ctx {
  const tmpDir = path.join(
    os.tmpdir(),
    `extras-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(tmpDir, { recursive: true });
  const v1Db = buildFixtureV1Db(path.join(tmpDir, 'v1.db'));
  const v2Path = path.join(tmpDir, 'data', 'v2.db');
  fs.mkdirSync(path.dirname(v2Path), { recursive: true });
  const v2Db = new Database(v2Path);
  runMigrations(v2Db);
  return { tmpDir, v1Db, v2Db, v2Path };
}

function teardown(ctx: Ctx): void {
  ctx.v1Db.close();
  ctx.v2Db.close();
  fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
}
