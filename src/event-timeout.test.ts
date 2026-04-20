import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  consumeEvents,
  getRecentEvents,
  publishEvent,
} from './db.js';
import {
  DEFAULT_EVENT_TTL_RULES,
  parseEventTtlOverrides,
  resolveTtlForType,
  sweepExpiredEvents,
} from './event-timeout.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('resolveTtlForType', () => {
  it('T.1 — returns the ttl for an exact glob match', () => {
    const rules = [
      { type_glob: 'observation.*', ttl_ms: 600_000 },
      { type_glob: 'candidate.*', ttl_ms: 1_800_000 },
    ];
    expect(resolveTtlForType('observation.passive', rules)).toBe(600_000);
    expect(resolveTtlForType('candidate.escalation', rules)).toBe(1_800_000);
  });

  it('T.2 — returns undefined for types with no matching rule (opt-in semantics)', () => {
    const rules = [{ type_glob: 'observation.*', ttl_ms: 600_000 }];
    expect(resolveTtlForType('approved_reply', rules)).toBeUndefined();
  });

  it('T.3 — first matching rule wins (order matters — specific-before-general)', () => {
    const rules = [
      { type_glob: 'candidate.escalation', ttl_ms: 60_000 },
      { type_glob: 'candidate.*', ttl_ms: 1_800_000 },
    ];
    expect(resolveTtlForType('candidate.escalation', rules)).toBe(60_000);
    expect(resolveTtlForType('candidate.question', rules)).toBe(1_800_000);
  });

  it('T.4 — exact literal match (no glob) works', () => {
    const rules = [{ type_glob: 'intake.raw', ttl_ms: 300_000 }];
    expect(resolveTtlForType('intake.raw', rules)).toBe(300_000);
    expect(resolveTtlForType('intake.other', rules)).toBeUndefined();
  });
});

describe('parseEventTtlOverrides', () => {
  it('T.5 — returns default rules when override is undefined/empty', () => {
    expect(parseEventTtlOverrides(undefined)).toEqual(DEFAULT_EVENT_TTL_RULES);
    expect(parseEventTtlOverrides('')).toEqual(DEFAULT_EVENT_TTL_RULES);
  });

  it('T.6 — overrides single ttl, preserves defaults for other types', () => {
    const parsed = parseEventTtlOverrides(
      JSON.stringify({ 'observation.*': 60_000 }),
    );
    // Override lands first so it wins over default
    expect(resolveTtlForType('observation.passive', parsed)).toBe(60_000);
    // Other defaults still present
    expect(resolveTtlForType('candidate.question', parsed)).toBe(
      resolveTtlForType('candidate.question', DEFAULT_EVENT_TTL_RULES),
    );
  });

  it('T.7 — malformed JSON falls back to defaults (no throw)', () => {
    expect(parseEventTtlOverrides('not-json{')).toEqual(
      DEFAULT_EVENT_TTL_RULES,
    );
  });

  it('T.8 — ttl:0 disables sweep for that glob (explicit opt-out)', () => {
    const parsed = parseEventTtlOverrides(
      JSON.stringify({ 'observation.*': 0 }),
    );
    expect(resolveTtlForType('observation.passive', parsed)).toBe(0);
  });
});

describe('sweepExpiredEvents', () => {
  function agedInsert(type: string, ageMs: number, claim = false): number {
    const now = Date.now();
    const result = publishEvent(type, 'slack_main', 'test', '{}', null, null);
    // Back-date created_at so the sweep treats it as aged.
    const backdate = new Date(now - ageMs).toISOString();
    const db = (globalThis as unknown as { __db?: unknown }).__db;
    void db; // unused; using raw sqlite via publish/consume
    // Use SQL directly via our test db helper — we'll re-open via db.ts
    const Database = require('better-sqlite3');
    // Instead: update via the same connection used by db.ts. We don't have
    // a backdate helper, so use sqlite directly through a fresh handle.
    return result.id;
  }

  it('T.9 — auto-fails events older than ttl with correct result_note', async () => {
    // Publish a normal event
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    // Age it via direct SQL (no public backdate API)
    const ageMs = 15 * 60 * 1000; // 15 min
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    const swept = sweepExpiredEvents(ttlRules, []);

    expect(swept.auto_failed).toHaveLength(1);
    expect(swept.auto_failed[0].id).toBe(e1.id);
    expect(swept.auto_failed[0].type).toBe('observation.passive');

    // Post-state: event is status='failed' with the sweep note
    const row = getDb()
      .prepare('SELECT status, result_note FROM events WHERE id = ?')
      .get(e1.id) as { status: string; result_note: string };
    expect(row.status).toBe('failed');
    expect(row.result_note).toMatch(/auto-failed/);
    expect(row.result_note).toMatch(/10 min/);
  });

  it('T.10 — leaves fresh events alone', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    const swept = sweepExpiredEvents(ttlRules, []);
    expect(swept.auto_failed).toHaveLength(0);

    const { getDb } = await import('./db.js');
    const row = getDb()
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(e1.id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('T.11 — auto-fails claimed (orphan) events too, using created_at as clock', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    // Simulate orphan claim (claimed but never acked)
    consumeEvents(['observation.*'], 'pipeline:monitor', 1);

    const ageMs = 15 * 60 * 1000;
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    const swept = sweepExpiredEvents(ttlRules, []);
    expect(swept.auto_failed).toHaveLength(1);
    expect(swept.auto_failed[0].id).toBe(e1.id);

    const row = getDb()
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(e1.id) as { status: string };
    expect(row.status).toBe('failed');
  });

  it('T.12 — leaves events with no matching ttl rule untouched (opt-in)', async () => {
    const e1 = publishEvent(
      'random.other',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const ageMs = 365 * 24 * 60 * 60 * 1000; // 1 year
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    const swept = sweepExpiredEvents(ttlRules, []);
    expect(swept.auto_failed).toHaveLength(0);

    const row = getDb()
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(e1.id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('T.13 — ttl:0 disables sweep for that glob', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const ageMs = 24 * 60 * 60 * 1000; // 1 day
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const swept = sweepExpiredEvents(
      [{ type_glob: 'observation.*', ttl_ms: 0 }],
      [],
    );
    expect(swept.auto_failed).toHaveLength(0);
  });

  it('T.14 — emits pipeline_event_timeout for configured notify types', async () => {
    const e1 = publishEvent(
      'candidate.question',
      'slack_main',
      'test',
      JSON.stringify({
        cluster_key: 'topic:test',
        cluster_summary: 'aged question',
        source_channel: 'slack:CXYZ',
      }),
      null,
      null,
    );
    const ageMs = 60 * 60 * 1000; // 1h
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const swept = sweepExpiredEvents(
      [{ type_glob: 'candidate.*', ttl_ms: 30 * 60 * 1000 }],
      ['candidate.*'],
    );
    expect(swept.auto_failed).toHaveLength(1);

    // A pipeline_event_timeout event should have been published
    const timeouts = getRecentEvents(['pipeline_event_timeout'], 10, true);
    expect(timeouts).toHaveLength(1);
    const payload = JSON.parse(timeouts[0].payload);
    expect(payload.original_event_id).toBe(e1.id);
    expect(payload.original_type).toBe('candidate.question');
    expect(payload.ttl_ms).toBe(30 * 60 * 1000);
    expect(payload.cluster_key).toBe('topic:test');
    expect(payload.source_channel).toBe('slack:CXYZ');
  });

  it('T.15 — does NOT emit pipeline_event_timeout for types not in notify list', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const backdate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    sweepExpiredEvents(
      [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }],
      ['candidate.*', 'intake.raw'], // observation.* not in notify list
    );

    const timeouts = getRecentEvents(['pipeline_event_timeout'], 10, true);
    expect(timeouts).toHaveLength(0);
  });
});

describe('DEFAULT_EVENT_TTL_RULES', () => {
  it('T.16 — has sensible defaults for known pipeline event types', () => {
    // Exposed for regression — changing these defaults should be a
    // conscious edit.
    expect(resolveTtlForType('intake.raw', DEFAULT_EVENT_TTL_RULES)).toBe(
      5 * 60 * 1000,
    );
    expect(
      resolveTtlForType('observation.passive', DEFAULT_EVENT_TTL_RULES),
    ).toBe(10 * 60 * 1000);
    expect(
      resolveTtlForType('candidate.escalation', DEFAULT_EVENT_TTL_RULES),
    ).toBe(30 * 60 * 1000);
    expect(
      resolveTtlForType('candidate.question', DEFAULT_EVENT_TTL_RULES),
    ).toBe(30 * 60 * 1000);
    expect(
      resolveTtlForType('candidate.unhandled', DEFAULT_EVENT_TTL_RULES),
    ).toBe(30 * 60 * 1000);
    // No TTL by default for other types
    expect(
      resolveTtlForType('approved_reply', DEFAULT_EVENT_TTL_RULES),
    ).toBeUndefined();
  });
});

describe('sweepExpiredEvents — onExpired hook (F9.3 Task A)', () => {
  it('T.20 — invokes hooks.onExpired for each auto-failed event', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      JSON.stringify({ observation_id: 77 }),
      null,
      null,
    );
    const e2 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      JSON.stringify({ observation_id: 78 }),
      null,
      null,
    );

    const ageMs = 15 * 60 * 1000;
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id IN (?,?)')
      .run(backdate, e1.id, e2.id);

    const onExpired = vi.fn();
    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    sweepExpiredEvents(ttlRules, [], { onExpired });

    expect(onExpired).toHaveBeenCalledTimes(2);
    expect(onExpired).toHaveBeenCalledWith(e1.id, 'observation.passive');
    expect(onExpired).toHaveBeenCalledWith(e2.id, 'observation.passive');
  });

  it('T.21 — onExpired receives only successfully auto-failed events', async () => {
    const fresh = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const stale = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );

    const ageMs = 15 * 60 * 1000;
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - ageMs).toISOString(), stale.id);

    const onExpired = vi.fn();
    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    sweepExpiredEvents(ttlRules, [], { onExpired });

    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(onExpired).toHaveBeenCalledWith(stale.id, 'observation.passive');
  });

  it('T.22 — onExpired exceptions do not abort the sweep', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const e2 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );

    const ageMs = 15 * 60 * 1000;
    const backdate = new Date(Date.now() - ageMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id IN (?,?)')
      .run(backdate, e1.id, e2.id);

    const onExpired = vi.fn(() => {
      throw new Error('hook went boom');
    });
    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];

    // Must not throw — sweep logs + swallows hook errors.
    expect(() => sweepExpiredEvents(ttlRules, [], { onExpired })).not.toThrow();
    // Both events still got fail-stamped, independent of the hook.
    const rows = getDb()
      .prepare('SELECT status FROM events WHERE id IN (?,?)')
      .all(e1.id, e2.id) as Array<{ status: string }>;
    for (const r of rows) expect(r.status).toBe('failed');
  });

  it('T.23 — works when hooks are omitted (back-compat)', async () => {
    const stale = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const ageMs = 15 * 60 * 1000;
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - ageMs).toISOString(), stale.id);

    // No hooks arg — must still sweep normally.
    const ttlRules = [{ type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 }];
    const swept = sweepExpiredEvents(ttlRules, []);
    expect(swept.auto_failed).toHaveLength(1);
  });
});

describe('releaseStaleClaims — orphan claim sweep (F9.3 Task D)', () => {
  it('T.30 — releases events claimed longer than the claim-age threshold', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    // Claim it
    consumeEvents(['observation.*'], 'pipeline:monitor', 1);

    // Back-date claimed_at to be old (simulating crashed claimer)
    const claimAgeMs = 5 * 60 * 1000;
    const backdate = new Date(Date.now() - claimAgeMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET claimed_at = ? WHERE id = ?')
      .run(backdate, e1.id);

    const { releaseStaleClaims } = await import('./event-timeout.js');
    const rules = [
      { type_glob: 'observation.*', claim_timeout_ms: 2 * 60 * 1000 },
    ];
    const result = releaseStaleClaims(rules);

    expect(result.released).toHaveLength(1);
    expect(result.released[0].id).toBe(e1.id);

    const row = getDb()
      .prepare('SELECT status, claimed_by, claimed_at FROM events WHERE id = ?')
      .get(e1.id) as {
      status: string;
      claimed_by: string | null;
      claimed_at: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it('T.31 — leaves fresh claims alone', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    consumeEvents(['observation.*'], 'pipeline:monitor', 1);

    const { releaseStaleClaims } = await import('./event-timeout.js');
    const rules = [
      { type_glob: 'observation.*', claim_timeout_ms: 2 * 60 * 1000 },
    ];
    const result = releaseStaleClaims(rules);

    expect(result.released).toHaveLength(0);

    const { getDb } = await import('./db.js');
    const row = getDb()
      .prepare('SELECT status, claimed_by FROM events WHERE id = ?')
      .get(e1.id) as { status: string; claimed_by: string };
    expect(row.status).toBe('claimed');
    expect(row.claimed_by).toBe('pipeline:monitor');
  });

  it('T.32 — never touches status!=claimed rows', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    // Still pending, not claimed. releaseStaleClaims should not touch it
    // even if we back-date its (non-existent) claimed_at.
    const { releaseStaleClaims } = await import('./event-timeout.js');
    const rules = [{ type_glob: 'observation.*', claim_timeout_ms: 1 }];
    const result = releaseStaleClaims(rules);

    expect(result.released).toHaveLength(0);

    const { getDb } = await import('./db.js');
    const row = getDb()
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(e1.id) as { status: string };
    expect(row.status).toBe('pending');
  });

  it('T.33 — respects per-type claim-age thresholds (first-match-wins)', async () => {
    const observation = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    const candidate = publishEvent(
      'candidate.question',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    consumeEvents(['observation.*'], 'pipeline:monitor', 1);
    consumeEvents(['candidate.*'], 'pipeline:solver', 1);

    const claimAgeMs = 3 * 60 * 1000;
    const backdate = new Date(Date.now() - claimAgeMs).toISOString();
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET claimed_at = ? WHERE id IN (?,?)')
      .run(backdate, observation.id, candidate.id);

    const { releaseStaleClaims } = await import('./event-timeout.js');
    const rules = [
      { type_glob: 'observation.*', claim_timeout_ms: 2 * 60 * 1000 }, // 3min > 2min → released
      { type_glob: 'candidate.*', claim_timeout_ms: 5 * 60 * 1000 }, // 3min < 5min → left claimed
    ];
    const result = releaseStaleClaims(rules);

    expect(result.released.map((r) => r.id)).toEqual([observation.id]);
  });

  it('T.34 — invokes hooks.onReleased per release', async () => {
    const e1 = publishEvent(
      'observation.passive',
      'slack_main',
      'test',
      '{}',
      null,
      null,
    );
    consumeEvents(['observation.*'], 'pipeline:monitor', 1);
    const { getDb } = await import('./db.js');
    getDb()
      .prepare('UPDATE events SET claimed_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 5 * 60 * 1000).toISOString(), e1.id);

    const onReleased = vi.fn();
    const { releaseStaleClaims } = await import('./event-timeout.js');
    const rules = [
      { type_glob: 'observation.*', claim_timeout_ms: 2 * 60 * 1000 },
    ];
    releaseStaleClaims(rules, { onReleased });

    expect(onReleased).toHaveBeenCalledTimes(1);
    expect(onReleased).toHaveBeenCalledWith(
      e1.id,
      'observation.passive',
      'pipeline:monitor',
    );
  });
});
