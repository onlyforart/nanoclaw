/**
 * Per-type event TTL sweep.
 *
 * Background: orphaned 'pending'/'claimed' events accumulate silently
 * (e.g. from crashes mid-processing) and:
 *  - bloat the events table
 *  - make dedup keys linger (same dedupe_key as a fresh event → fresh event
 *    treated as duplicate)
 *  - confuse the operator (webui shows many "in-flight" events that aren't)
 *
 * This module auto-fails events that have been pending past a per-type TTL.
 * TTLs are glob-matched; first matching rule wins. Types with no matching
 * rule are NEVER auto-failed (opt-in semantics).
 *
 * For a configurable subset of types, a follow-on `pipeline_event_timeout`
 * event is published so the operator sees the loss in the webui events
 * page / cluster journal.
 */

import { getDb, publishEvent } from './db.js';
import { logger } from './logger.js';

export interface TtlRule {
  type_glob: string; // exact string or "foo.*" glob
  ttl_ms: number; // 0 → disabled for this glob
}

export const DEFAULT_EVENT_TTL_RULES: readonly TtlRule[] = Object.freeze([
  { type_glob: 'intake.raw', ttl_ms: 5 * 60 * 1000 },
  { type_glob: 'observation.*', ttl_ms: 10 * 60 * 1000 },
  { type_glob: 'candidate.*', ttl_ms: 30 * 60 * 1000 },
]);

/**
 * Types that, when auto-failed by the sweep, should publish a follow-on
 * `pipeline_event_timeout` event so the operator notices. Observations are
 * intentionally silent — losing an orphaned obs isn't actionable and would
 * just create noise.
 */
export const DEFAULT_EVENT_TIMEOUT_NOTIFY: readonly string[] = Object.freeze([
  'candidate.*',
  'intake.raw',
]);

function globToLike(glob: string): string {
  return glob.replace(/\*/g, '%');
}

function typeMatchesGlob(type: string, glob: string): boolean {
  if (!glob.includes('*')) return type === glob;
  const pattern = new RegExp(
    '^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
  );
  return pattern.test(type);
}

/**
 * Resolve the TTL (ms) for a specific event type. Returns undefined when
 * no rule matches (→ no auto-fail). ttl_ms === 0 is a deliberate disable.
 * First-match wins, so specific rules must precede general ones.
 */
export function resolveTtlForType(
  type: string,
  rules: readonly TtlRule[],
): number | undefined {
  for (const rule of rules) {
    if (typeMatchesGlob(type, rule.type_glob)) return rule.ttl_ms;
  }
  return undefined;
}

/**
 * Parse a JSON overrides string (env var shape: `{"glob":ms,...}`) into a
 * rules array. Overrides land BEFORE defaults so they win on first-match.
 * Malformed JSON falls back to defaults with a log warning — never throws.
 */
export function parseEventTtlOverrides(raw: string | undefined): TtlRule[] {
  if (!raw) return [...DEFAULT_EVENT_TTL_RULES];

  let parsed: Record<string, unknown>;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      logger.warn(
        { raw },
        'PIPELINE_EVENT_TTL_OVERRIDES must be a JSON object {glob: ms}; ignoring',
      );
      return [...DEFAULT_EVENT_TTL_RULES];
    }
    parsed = obj as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      { err, raw },
      'PIPELINE_EVENT_TTL_OVERRIDES is not valid JSON; ignoring',
    );
    return [...DEFAULT_EVENT_TTL_RULES];
  }

  const overrides: TtlRule[] = [];
  for (const [glob, ttl] of Object.entries(parsed)) {
    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0) {
      overrides.push({ type_glob: glob, ttl_ms: ttl });
    } else {
      logger.warn(
        { glob, ttl },
        'PIPELINE_EVENT_TTL_OVERRIDES entry has non-numeric or negative ttl; ignoring',
      );
    }
  }
  return [...overrides, ...DEFAULT_EVENT_TTL_RULES];
}

export interface SweepResult {
  auto_failed: Array<{ id: number; type: string }>;
}

export interface SweepHooks {
  /**
   * Called once per event auto-failed by the sweep, after the status
   * transition is durably committed. Used by the pipeline plugin to
   * route observation.* TTL-expiry into its silent-fail recovery path
   * (route the lost question through to the solver). Best-effort —
   * exceptions are caught + logged so one misbehaving hook can't abort
   * the sweep for the remaining victims.
   */
  onExpired?: (eventId: number, eventType: string) => void;
}

/**
 * Sweep expired events: auto-fail any pending/claimed event older than its
 * type's TTL. Idempotent — safe to call repeatedly. For each expired event
 * whose type matches a notify glob, publish a `pipeline_event_timeout`
 * event pointing at the original. The optional `hooks.onExpired` callback
 * fires once per successfully-swept event so callers can wire follow-on
 * behaviour without subclassing the sweep.
 */
export function sweepExpiredEvents(
  rules: readonly TtlRule[],
  notifyTypeGlobs: readonly string[],
  hooks: SweepHooks = {},
): SweepResult {
  const db = getDb();
  const now = Date.now();

  const auto_failed: Array<{ id: number; type: string }> = [];

  for (const rule of rules) {
    if (rule.ttl_ms <= 0) continue;
    const cutoff = new Date(now - rule.ttl_ms).toISOString();

    const isGlob = rule.type_glob.includes('*');
    const typeClause = isGlob ? 'type LIKE ?' : 'type = ?';
    const typeParam = isGlob ? globToLike(rule.type_glob) : rule.type_glob;

    // Find victims, but skip any already processed by a more-specific
    // earlier rule in this same sweep.
    const victims = db
      .prepare(
        `SELECT id, type, payload FROM events
          WHERE status IN ('pending','claimed')
            AND ${typeClause}
            AND created_at < ?`,
      )
      .all(typeParam, cutoff) as Array<{
      id: number;
      type: string;
      payload: string;
    }>;

    if (victims.length === 0) continue;

    const nowIso = new Date().toISOString();
    const ttlMinutes = Math.round(rule.ttl_ms / 60000);
    const note = `auto-failed after ${ttlMinutes} min pending (ttl sweep)`;

    const failStmt = db.prepare(
      `UPDATE events
          SET status = 'failed', processed_at = ?, result_note = ?
        WHERE id = ? AND status IN ('pending','claimed')`,
    );

    for (const v of victims) {
      const res = failStmt.run(nowIso, note, v.id);
      if (res.changes === 0) continue; // raced with another writer
      auto_failed.push({ id: v.id, type: v.type });

      if (hooks.onExpired) {
        try {
          hooks.onExpired(v.id, v.type);
        } catch (err) {
          logger.warn(
            { err, eventId: v.id, eventType: v.type },
            'sweepExpiredEvents onExpired hook threw — continuing',
          );
        }
      }

      const shouldNotify = notifyTypeGlobs.some((g) =>
        typeMatchesGlob(v.type, g),
      );
      if (shouldNotify) {
        const meta = extractNotifyMeta(v.payload);
        publishEvent(
          'pipeline_event_timeout',
          'system',
          'event-timeout-sweep',
          JSON.stringify({
            original_event_id: v.id,
            original_type: v.type,
            ttl_ms: rule.ttl_ms,
            swept_at: nowIso,
            ...meta,
          }),
          `timeout:${v.id}`,
          null,
        );
      }
    }
  }

  if (auto_failed.length > 0) {
    logger.warn(
      {
        count: auto_failed.length,
        types: [...new Set(auto_failed.map((a) => a.type))],
      },
      'Event timeout sweep auto-failed stale events',
    );
  }
  return { auto_failed };
}

/**
 * Per-type claim-age rule. Events that have been in `claimed` state
 * longer than `claim_timeout_ms` are released back to `pending` so
 * another consumer can try — distinct from the event-TTL sweep which
 * keys off `created_at` and marks events permanently failed.
 */
export interface ClaimAgeRule {
  type_glob: string;
  claim_timeout_ms: number;
}

/**
 * Default claim-age thresholds. Short enough that a crashed consumer
 * doesn't block the pipeline for long; long enough that a legitimately
 * slow consumer (e.g. pagepilot widget runs taking ~60 s + overhead)
 * won't have its claim yanked mid-run.
 */
export const DEFAULT_CLAIM_AGE_RULES: readonly ClaimAgeRule[] = Object.freeze([
  // Monitor + sanitiser claims are short-lived in the happy path;
  // anything >5 min is a crashed consumer.
  { type_glob: 'observation.*', claim_timeout_ms: 5 * 60 * 1000 },
  // Solver runs (pagepilot widget observation + LLM reply) can take
  // 90–120s; 10 min gives generous headroom.
  { type_glob: 'candidate.*', claim_timeout_ms: 10 * 60 * 1000 },
]);

export interface ReleaseResult {
  released: Array<{ id: number; type: string; claimed_by: string | null }>;
}

export interface ReleaseHooks {
  /** Fires once per successfully released (claimed → pending) event. */
  onReleased?: (
    eventId: number,
    eventType: string,
    prevClaimedBy: string | null,
  ) => void;
}

/**
 * Release events stuck in `claimed` longer than the per-type claim-age
 * threshold. This handles crashed / hung consumers: their claim would
 * otherwise persist until the event-TTL sweep gave up on the event
 * entirely. Releasing instead of failing lets a fresh consumer take
 * another run — important for pipeline liveness.
 *
 * Idempotent; safe to call every scheduler tick. Race-safe: the
 * UPDATE is conditional on status='claimed' so a consumer that
 * successfully acks between our read and write wins.
 */
export function releaseStaleClaims(
  rules: readonly ClaimAgeRule[],
  hooks: ReleaseHooks = {},
): ReleaseResult {
  const db = getDb();
  const now = Date.now();
  const released: ReleaseResult['released'] = [];

  for (const rule of rules) {
    if (rule.claim_timeout_ms <= 0) continue;
    const cutoff = new Date(now - rule.claim_timeout_ms).toISOString();

    const isGlob = rule.type_glob.includes('*');
    const typeClause = isGlob ? 'type LIKE ?' : 'type = ?';
    const typeParam = isGlob ? globToLike(rule.type_glob) : rule.type_glob;

    const victims = db
      .prepare(
        `SELECT id, type, claimed_by FROM events
          WHERE status = 'claimed'
            AND ${typeClause}
            AND claimed_at < ?`,
      )
      .all(typeParam, cutoff) as Array<{
      id: number;
      type: string;
      claimed_by: string | null;
    }>;

    if (victims.length === 0) continue;

    // Skip victims a previous (more specific) rule in THIS sweep already
    // touched — protects first-match-wins ordering across overlapping globs.
    const alreadyHandled = new Set(released.map((r) => r.id));

    const releaseStmt = db.prepare(
      `UPDATE events
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL
        WHERE id = ? AND status = 'claimed'`,
    );

    for (const v of victims) {
      if (alreadyHandled.has(v.id)) continue;
      const res = releaseStmt.run(v.id);
      if (res.changes === 0) continue; // consumer acked between read & write
      released.push({ id: v.id, type: v.type, claimed_by: v.claimed_by });

      if (hooks.onReleased) {
        try {
          hooks.onReleased(v.id, v.type, v.claimed_by);
        } catch (err) {
          logger.warn(
            { err, eventId: v.id, eventType: v.type },
            'releaseStaleClaims onReleased hook threw — continuing',
          );
        }
      }
    }
  }

  if (released.length > 0) {
    logger.warn(
      {
        count: released.length,
        types: [...new Set(released.map((r) => r.type))],
      },
      'Released stale claims back to pending',
    );
  }
  return { released };
}

function extractNotifyMeta(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, unknown> = {};
    for (const key of [
      'cluster_key',
      'cluster_summary',
      'source_channel',
      'source_message_id',
      'observation_ids',
    ]) {
      if (key in parsed) out[key] = parsed[key];
    }
    return out;
  } catch {
    return {};
  }
}
