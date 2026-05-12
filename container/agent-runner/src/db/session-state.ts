/**
 * Persistent key/value state for the container. Lives in outbound.db
 * (container-owned, already scoped per channel/thread).
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * `(provider, engine-kind)` pair so that mixed-engine sessions don't
 * cross-pollute (a synthetic anthropic-api id never gets fed back to
 * the Claude SDK, which would always fail to resume from it). Switching
 * providers is therefore lossless: each provider's last thread per
 * engine stays on file and resumes cleanly if the user flips back.
 */
import { getOutboundDb } from './connection.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string, engineKind?: string): string {
  const suffix = engineKind ? `:${engineKind.toLowerCase()}` : '';
  return `continuation:${providerName.toLowerCase()}${suffix}`;
}

function getValue(key: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT value FROM session_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function setValue(key: string, value: string): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, new Date().toISOString());
}

function deleteValue(key: string): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(key);
}

/**
 * One-time migration of legacy continuation rows.
 *
 * Two legacy shapes get migrated forward to the (provider, engine-kind)
 * shape:
 *
 *   1. The pre-per-provider single key `sdk_session_id`. Adopted into the
 *      current provider's SDK slot (only the SDK ever wrote real
 *      continuations — non-SDK engines emit synthetic ids that aren't
 *      reload-meaningful — so SDK is the right target).
 *   2. The pre-engine-kind per-provider key `continuation:{provider}` that
 *      shipped before per-engine namespacing. Adopted into the SDK slot
 *      under the same provider for the same reason.
 *
 * Both legacy rows are deleted so future flips never re-read a stale id
 * through the wrong lens. Returns the continuation the caller should use
 * at startup for the SDK engine (either the current SDK slot, the adopted
 * legacy value, or undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const sdkKey = continuationKey(providerName, 'sdk');
  const sdkCurrent = getValue(sdkKey);

  // Phase 1: drop pre-per-provider single key
  const phase1Legacy = getValue(LEGACY_KEY);
  if (phase1Legacy !== undefined) {
    deleteValue(LEGACY_KEY);
    if (sdkCurrent === undefined) {
      // Phase 2 (provider-only key) might also exist; phase 1 wins.
      setValue(sdkKey, phase1Legacy);
      const phase2Key = continuationKey(providerName);
      if (getValue(phase2Key) !== undefined) deleteValue(phase2Key);
      return phase1Legacy;
    }
  }

  // Phase 2: drop pre-engine-kind per-provider key, adopt into SDK slot
  const phase2Key = continuationKey(providerName);
  const phase2Legacy = getValue(phase2Key);
  if (phase2Legacy !== undefined) {
    deleteValue(phase2Key);
    if (sdkCurrent === undefined) {
      setValue(sdkKey, phase2Legacy);
      return phase2Legacy;
    }
  }

  return sdkCurrent;
}

export function getContinuation(providerName: string, engineKind?: string): string | undefined {
  return getValue(continuationKey(providerName, engineKind));
}

export function setContinuation(providerName: string, id: string, engineKind?: string): void {
  setValue(continuationKey(providerName, engineKind), id);
}

export function clearContinuation(providerName: string, engineKind?: string): void {
  deleteValue(continuationKey(providerName, engineKind));
}
