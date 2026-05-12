/**
 * §4.5 step 14 C4 — composite plugin-host bootstrap helper.
 *
 * Spec encoded here:
 *   - bootstrapAgentGroup creates agent_groups + filesystem +
 *     messaging_groups + messaging_group_agents wiring + sessions in
 *     one shot and returns the row triple.
 *   - Idempotent: re-running with the same agentGroupId returns the
 *     existing rows without throwing.
 *   - Filesystem init is idempotent (per-step existence checks in
 *     initGroupFilesystem).
 *   - When (channel_type, platform_id) UNIQUE matches an existing
 *     messaging_groups row with a different id, the existing row is
 *     reused (no UNIQUE-violation throw).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { findSessionForAgent } from './db/sessions.js';
import { inboundDbPath, outboundDbPath, sessionDir } from './session-manager.js';
import { bootstrapAgentGroup } from './plugin-bootstrap.js';

// Override DATA_DIR + GROUPS_DIR so filesystem effects land under a test dir.
// vi.mock is hoisted, so the path literals must be inlined here (cannot
// reference a top-level const).
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-plugin-bootstrap-test',
    GROUPS_DIR: '/tmp/nanoclaw-plugin-bootstrap-test/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-plugin-bootstrap-test';

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

const SAMPLE_INPUT = {
  agentGroupId: 'pipeline-monitor',
  name: 'Pipeline Monitor',
  folder: 'pipeline-monitor',
  claudeLocalMd: 'You are the pipeline monitor.',
  messagingGroup: {
    id: 'mg-pipeline-monitor',
    channelType: 'system',
    platformId: 'system:pipeline:monitor',
  },
  wiring: {
    id: 'mga-pipeline-monitor',
  },
  sessionId: 'sess-pipeline-monitor',
};

describe('bootstrapAgentGroup — first run creates all rows', () => {
  it('B1 — creates agent_groups, messaging_groups, mga, session', () => {
    const result = bootstrapAgentGroup(SAMPLE_INPUT);

    expect(result.agentGroup.id).toBe('pipeline-monitor');
    expect(result.agentGroup.folder).toBe('pipeline-monitor');
    expect(result.messagingGroup.channel_type).toBe('system');
    expect(result.messagingGroup.platform_id).toBe('system:pipeline:monitor');
    expect(result.session.id).toBe('sess-pipeline-monitor');
    expect(result.session.agent_group_id).toBe('pipeline-monitor');
    expect(result.session.status).toBe('active');
  });

  it('B2 — agent_groups row is queryable by id', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const row = getAgentGroup('pipeline-monitor');
    expect(row).toBeDefined();
    expect(row?.name).toBe('Pipeline Monitor');
  });

  it('B3 — messaging_groups row is queryable by (channel_type, platform_id)', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const row = getMessagingGroupByPlatform('system', 'system:pipeline:monitor');
    expect(row).toBeDefined();
    expect(row?.id).toBe('mg-pipeline-monitor');
  });

  it('B4 — session is findable by (agentGroupId, messagingGroupId, null thread)', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const sess = findSessionForAgent('pipeline-monitor', 'mg-pipeline-monitor', null);
    expect(sess).toBeDefined();
    expect(sess?.id).toBe('sess-pipeline-monitor');
  });

  it('B5 — creates session inbound.db on disk with messages_in schema applied', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const inPath = inboundDbPath('pipeline-monitor', 'sess-pipeline-monitor');
    expect(fs.existsSync(inPath)).toBe(true);

    const inDb = new Database(inPath, { readonly: true });
    try {
      const tables = (
        inDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      )
        .map((r) => r.name)
        .sort();
      // messages_in is the minimum required surface; full schema is asserted
      // by session-manager tests. Bootstrap's job is "make this DB usable".
      expect(tables).toContain('messages_in');
      expect(tables).toContain('destinations');
      expect(tables).toContain('session_routing');
    } finally {
      inDb.close();
    }
  });

  it('B5b — creates session outbound.db on disk so the container can connect on first wake', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const outPath = outboundDbPath('pipeline-monitor', 'sess-pipeline-monitor');
    expect(fs.existsSync(outPath)).toBe(true);

    const outDb = new Database(outPath, { readonly: true });
    try {
      const tables = (
        outDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toContain('messages_out');
      expect(tables).toContain('processing_ack');
    } finally {
      outDb.close();
    }
  });

  it('B5c — creates session outbox directory', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    const outbox = path.join(sessionDir('pipeline-monitor', 'sess-pipeline-monitor'), 'outbox');
    expect(fs.existsSync(outbox)).toBe(true);
  });
});

describe('bootstrapAgentGroup — idempotency', () => {
  it('B6 — second call with same input returns existing rows without throwing', () => {
    const first = bootstrapAgentGroup(SAMPLE_INPUT);
    const second = bootstrapAgentGroup(SAMPLE_INPUT);
    expect(second.agentGroup.id).toBe(first.agentGroup.id);
    expect(second.messagingGroup.id).toBe(first.messagingGroup.id);
    expect(second.session.id).toBe(first.session.id);
  });

  it('B6b — re-running re-creates on-disk DBs when session row exists but files were deleted', () => {
    // This is the production-recovery case: a pre-fix install created the
    // session row in the central DB but never the on-disk DBs. Re-running
    // bootstrap must heal the filesystem without depending on a fresh insert.
    bootstrapAgentGroup(SAMPLE_INPUT);
    const inPath = inboundDbPath('pipeline-monitor', 'sess-pipeline-monitor');
    const outPath = outboundDbPath('pipeline-monitor', 'sess-pipeline-monitor');
    expect(fs.existsSync(inPath)).toBe(true);

    // Simulate the broken state: row exists in central DB, files are gone.
    fs.rmSync(sessionDir('pipeline-monitor', 'sess-pipeline-monitor'), { recursive: true });
    expect(fs.existsSync(inPath)).toBe(false);

    bootstrapAgentGroup(SAMPLE_INPUT);
    expect(fs.existsSync(inPath)).toBe(true);
    expect(fs.existsSync(outPath)).toBe(true);
  });

  it('B7 — re-bootstrap preserves the original created_at timestamps', () => {
    const first = bootstrapAgentGroup(SAMPLE_INPUT);
    const t1 = first.agentGroup.created_at;
    // sleep a tick to ensure clock advances
    return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
      const second = bootstrapAgentGroup(SAMPLE_INPUT);
      expect(second.agentGroup.created_at).toBe(t1);
    });
  });
});

describe('bootstrapAgentGroup — multiple agent groups in one DB', () => {
  it('B8 — distinct ids produce distinct rows', () => {
    bootstrapAgentGroup(SAMPLE_INPUT);
    bootstrapAgentGroup({
      ...SAMPLE_INPUT,
      agentGroupId: 'pipeline-solver',
      name: 'Pipeline Solver',
      folder: 'pipeline-solver',
      messagingGroup: {
        id: 'mg-pipeline-solver',
        channelType: 'system',
        platformId: 'system:pipeline:solver',
      },
      wiring: { id: 'mga-pipeline-solver' },
      sessionId: 'sess-pipeline-solver',
    });

    expect(getAgentGroup('pipeline-monitor')).toBeDefined();
    expect(getAgentGroup('pipeline-solver')).toBeDefined();
    expect(getMessagingGroup('mg-pipeline-monitor')).toBeDefined();
    expect(getMessagingGroup('mg-pipeline-solver')).toBeDefined();
  });
});
