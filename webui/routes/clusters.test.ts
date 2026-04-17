import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDb, closeDb } from '../db.js';
import { HttpError } from '../router.js';
import { handleGetClusters, handleGetCluster } from './clusters.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-clusters-test-'));
  const dbPath = path.join(tmpDir, 'messages.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE pipeline_clusters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_channel TEXT NOT NULL,
      cluster_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT NOT NULL,
      observation_ids TEXT NOT NULL,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observation_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      UNIQUE(source_channel, cluster_key)
    );
    CREATE TABLE observed_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chat_jid TEXT,
      source_message_id TEXT,
      source_type TEXT NOT NULL DEFAULT 'passive_channel',
      raw_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // 3 clusters: active (newest), resolved (middle), expired (oldest)
  const insert = db.prepare(
    `INSERT INTO pipeline_clusters
       (source_channel, cluster_key, status, summary, observation_ids,
        observation_count, last_observation_at, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    'slack:CXYZ', 'topic:alpha', 'active',
    'Alpha cluster summary',
    JSON.stringify([10, 11]), 2,
    '2026-04-17T12:00:00.000Z',
    '2026-04-17T11:00:00.000Z',
    '2026-04-17T12:00:00.000Z',
    null,
  );
  insert.run(
    'slack:CXYZ', 'topic:beta', 'resolved',
    'Beta cluster resolved',
    JSON.stringify([20]), 1,
    '2026-04-17T10:00:00.000Z',
    '2026-04-17T09:00:00.000Z',
    '2026-04-17T10:30:00.000Z',
    '2026-04-17T10:30:00.000Z',
  );
  insert.run(
    'slack:COTHER', 'topic:gamma', 'expired',
    'Gamma cluster expired',
    JSON.stringify([30, 31, 32]), 3,
    '2026-04-16T08:00:00.000Z',
    '2026-04-16T07:00:00.000Z',
    '2026-04-17T08:00:00.000Z',
    null,
  );

  // Seed matching observations for the detail endpoint
  const insObs = db.prepare(
    `INSERT INTO observed_messages (id, source_chat_jid, raw_text, created_at)
     VALUES (?, ?, ?, ?)`,
  );
  insObs.run(10, 'slack:CXYZ', 'first alpha message', '2026-04-17T11:00:00.000Z');
  insObs.run(11, 'slack:CXYZ', 'second alpha message', '2026-04-17T12:00:00.000Z');
  insObs.run(20, 'slack:CXYZ', 'beta message', '2026-04-17T09:00:00.000Z');

  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetClusters', () => {
  it('7a.1 — returns all 3 rows by default, camelCase, ordered lastObservationAt DESC', () => {
    const rows = handleGetClusters({});
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.clusterKey)).toEqual([
      'topic:alpha', // 12:00
      'topic:beta', // 10:00
      'topic:gamma', // 08:00 previous day
    ]);
    const first = rows[0];
    expect(first.sourceChannel).toBe('slack:CXYZ');
    expect(first.status).toBe('active');
    expect(first.observationCount).toBe(2);
    expect(first.lastObservationAt).toBe('2026-04-17T12:00:00.000Z');
    expect(first.createdAt).toBe('2026-04-17T11:00:00.000Z');
    expect(first.updatedAt).toBe('2026-04-17T12:00:00.000Z');
    expect(first.resolvedAt).toBeNull();
    const resolved = rows[1];
    expect(resolved.resolvedAt).toBe('2026-04-17T10:30:00.000Z');
  });

  it('7a.2 — filters by status=active', () => {
    const rows = handleGetClusters({ status: 'active' });
    expect(rows).toHaveLength(1);
    expect(rows[0].clusterKey).toBe('topic:alpha');
  });

  it('7a.3 — filters by sourceChannel', () => {
    const rows = handleGetClusters({ sourceChannel: 'slack:COTHER' });
    expect(rows).toHaveLength(1);
    expect(rows[0].clusterKey).toBe('topic:gamma');
  });

  it('7a.4 — honours limit + offset', () => {
    const rows = handleGetClusters({ limit: '1', offset: '1' });
    expect(rows).toHaveLength(1);
    expect(rows[0].clusterKey).toBe('topic:beta'); // second in DESC order
  });

  it('7a.7 — list response has camelCase keys only (no snake_case leaks)', () => {
    const rows = handleGetClusters({});
    const sample = rows[0] as unknown as Record<string, unknown>;
    const keys = Object.keys(sample);
    for (const k of keys) {
      expect(k.includes('_')).toBe(false);
    }
    expect(keys).toEqual(
      expect.arrayContaining([
        'id',
        'sourceChannel',
        'clusterKey',
        'status',
        'summary',
        'observationCount',
        'lastObservationAt',
        'createdAt',
        'updatedAt',
        'resolvedAt',
      ]),
    );
  });
});

describe('handleGetCluster', () => {
  it('7a.5 — returns full row with parsed observationIds (number array)', () => {
    const row = handleGetCluster(1);
    expect(row.id).toBe(1);
    expect(row.clusterKey).toBe('topic:alpha');
    expect(row.observationIds).toEqual([10, 11]);
    expect(Array.isArray(row.observationIds)).toBe(true);
    expect(typeof row.observationIds[0]).toBe('number');
  });

  it('7a.6 — throws HttpError(404) for missing id', () => {
    expect(() => handleGetCluster(99999)).toThrow(HttpError);
    try {
      handleGetCluster(99999);
    } catch (err) {
      expect((err as HttpError).statusCode).toBe(404);
    }
  });

  it('7a.7 — detail response has camelCase keys only', () => {
    const row = handleGetCluster(1) as unknown as Record<string, unknown>;
    for (const k of Object.keys(row)) {
      expect(k.includes('_')).toBe(false);
    }
  });

  it('7a.8 — detail.observations lists constituent observation summaries', () => {
    const row = handleGetCluster(1);
    expect(Array.isArray(row.observations)).toBe(true);
    expect(row.observations).toHaveLength(2);
    const ids = row.observations.map((o) => o.id).sort((a, b) => a - b);
    expect(ids).toEqual([10, 11]);
    const obs = row.observations.find((o) => o.id === 10)!;
    expect(obs.rawText).toBe('first alpha message');
    expect(obs.createdAt).toBe('2026-04-17T11:00:00.000Z');
    expect(obs.sourceChatJid).toBe('slack:CXYZ');
    for (const o of row.observations) {
      for (const k of Object.keys(o)) {
        expect(k.includes('_')).toBe(false);
      }
    }
  });
});
