import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../src/db/migrations/index.js';

import { buildFixtureV1Db } from './build-fixture.js';
import { computeRowCounts, renderRowCountReport } from './validator.js';

describe('migrate-v1 row-count validator', () => {
  let tmpDir: string;
  let v1Db: Database.Database;
  let v2Db: Database.Database;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `migrate-v1-validator-${Date.now()}-${Math.random()}`);
    v1Db = buildFixtureV1Db(path.join(tmpDir, 'v1.db'));
    v2Db = new Database(path.join(tmpDir, 'v2.db'));
    runMigrations(v2Db);
  });

  afterEach(() => {
    v1Db.close();
    v2Db.close();
  });

  it('counts fixture v1 rows correctly', () => {
    const r = computeRowCounts(v1Db, v2Db);
    expect(r.v1.chats).toBe(3);
    expect(r.v1.messages).toBe(5);
    expect(r.v1.registered_groups).toBe(3);
    expect(r.v1.scheduled_tasks).toBe(4);
    expect(r.v1.task_run_logs).toBe(8);
    expect(r.v1.sessions).toBe(1);
    expect(r.v1.router_state).toBe(3);
    expect(r.v1.events).toBe(3);
    expect(r.v1.observed_messages).toBe(2);
    expect(r.v1.pipeline_clusters).toBe(1);
    expect(r.v1.pipeline_intake_log).toBe(0);
    expect(r.v1.observation_labels).toBe(0);
    expect(r.v1.reextraction_cache).toBe(1);
    expect(r.v1.cross_channel_deliveries).toBe(2);
  });

  it('reports 0 rows in empty post-migration v2 tables', () => {
    const r = computeRowCounts(v1Db, v2Db);
    expect(r.v2.agent_groups).toBe(0);
    expect(r.v2.messaging_groups).toBe(0);
    expect(r.v2.messaging_group_agents).toBe(0);
    expect(r.v2.sessions).toBe(0);
  });

  it('reports null for pipeline plugin tables when plugin is not loaded', () => {
    // Worktree's runMigrations doesn't include pipeline plugin migrations
    // (those register at plugin-load time via registerMigration()). The
    // validator must gracefully report null, not throw.
    const r = computeRowCounts(v1Db, v2Db);
    expect(r.v2.pipeline_events).toBeNull();
    expect(r.v2.pipeline_task_run_logs).toBeNull();
    expect(r.v2.pipeline_passive_subscriptions).toBeNull();
  });

  it('surfaces actionable notes when plugin tables are absent but v1 had data', () => {
    const r = computeRowCounts(v1Db, v2Db);
    expect(r.notes).toContain(
      'v1 has router_state rows but v2 has no pipeline_passive_subscriptions table — the pipeline plugin migrations have not run yet.',
    );
    expect(r.notes).toContain(
      'v1 has task_run_logs rows but v2 has no pipeline_task_run_logs table — pipeline plugin migrations missing.',
    );
  });

  it('renders a markdown report with all v1 tables in stable order', () => {
    const r = computeRowCounts(v1Db, v2Db);
    const md = renderRowCountReport(r);
    expect(md).toMatch(/^## Row count report/);
    expect(md).toContain('| `chats` |');
    expect(md).toContain('| `registered_groups` |');
    expect(md).toContain('| `pipeline_clusters` |');
    expect(md).toContain('### Notes');
  });

  it('reports zero v1 rows for absent tables when v1 db is empty', () => {
    const emptyDb = new Database(':memory:');
    const r = computeRowCounts(emptyDb, v2Db);
    expect(r.v1.chats).toBeNull();
    expect(r.v1.messages).toBeNull();
    emptyDb.close();
  });
});

// fullDiff tests removed: they exercised the validator against the real
// pipeline plugin migrations imported cross-repo. After K.1.h step D, the
// pluggable seam in plugin-migrations.ts means nanoclaw no longer knows
// about any specific plugin's schema, so an in-repo test would have to
// stub-mock the plugin migrations and would lose its real-data fidelity.
// Coverage of the diff path is via the K.1.g sandbox dry-run + Phase B
// live run, both of which exercise fullDiff end-to-end with the real
// plugin loaded.
