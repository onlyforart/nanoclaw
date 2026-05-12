import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb } from './connection.js';
import {
  clearContinuation,
  getContinuation,
  migrateLegacyContinuation,
  setContinuation,
} from './session-state.js';

beforeEach(() => {
  initTestSessionDb();
});

function seedLegacy(value: string): void {
  getOutboundDb()
    .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('sdk_session_id', value, new Date().toISOString());
}

describe('session-state — per-provider continuations (no engineKind — bare key)', () => {
  // The bare-provider key shape is preserved as a public API for callers
  // that don't need engine-kind namespacing (legacy callers, tests). New
  // callers in poll-loop pass engineKind to keep engines isolated.
  test('set/get round-trip, case-insensitive provider key', () => {
    setContinuation('claude', 'claude-conv-1');
    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('Claude')).toBe('claude-conv-1');
    expect(getContinuation('CLAUDE')).toBe('claude-conv-1');
  });

  test('providers are isolated — switching reads the right slot', () => {
    setContinuation('claude', 'claude-conv-1');
    setContinuation('codex', 'codex-thread-xyz');

    expect(getContinuation('claude')).toBe('claude-conv-1');
    expect(getContinuation('codex')).toBe('codex-thread-xyz');
  });

  test('clearContinuation only affects the specified provider', () => {
    setContinuation('claude', 'keep-me');
    setContinuation('codex', 'drop-me');

    clearContinuation('codex');

    expect(getContinuation('claude')).toBe('keep-me');
    expect(getContinuation('codex')).toBeUndefined();
  });

  test('unknown provider returns undefined', () => {
    expect(getContinuation('never-used')).toBeUndefined();
  });
});

describe('session-state — per-(provider, engineKind) continuations', () => {
  test('engine-kind suffix isolates slots within the same provider', () => {
    setContinuation('claude', 'sdk-conv', 'sdk');
    setContinuation('claude', 'ollama-conv', 'ollama');
    setContinuation('claude', 'api-conv', 'anthropic-api');

    expect(getContinuation('claude', 'sdk')).toBe('sdk-conv');
    expect(getContinuation('claude', 'ollama')).toBe('ollama-conv');
    expect(getContinuation('claude', 'anthropic-api')).toBe('api-conv');
  });

  test('engine-kind suffix is case-insensitive', () => {
    setContinuation('claude', 'x', 'SDK');
    expect(getContinuation('claude', 'sdk')).toBe('x');
    expect(getContinuation('Claude', 'Sdk')).toBe('x');
  });

  test('clear scoped to engine-kind leaves sibling slots intact', () => {
    setContinuation('claude', 'sdk-conv', 'sdk');
    setContinuation('claude', 'api-conv', 'anthropic-api');

    clearContinuation('claude', 'sdk');

    expect(getContinuation('claude', 'sdk')).toBeUndefined();
    expect(getContinuation('claude', 'anthropic-api')).toBe('api-conv');
  });

  test('bare-provider key and engineKind keys do not alias each other', () => {
    setContinuation('claude', 'bare');
    setContinuation('claude', 'with-sdk', 'sdk');

    expect(getContinuation('claude')).toBe('bare');
    expect(getContinuation('claude', 'sdk')).toBe('with-sdk');
  });
});

describe('session-state — legacy migration', () => {
  test('phase-1 legacy (sdk_session_id) lands in the new SDK slot', () => {
    seedLegacy('old-session-id');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('old-session-id');
    expect(getContinuation('claude', 'sdk')).toBe('old-session-id');
  });

  test('always deletes legacy row regardless of migration outcome', () => {
    seedLegacy('old-session-id');
    setContinuation('claude', 'existing', 'sdk');

    migrateLegacyContinuation('claude');

    // After migration the legacy key must be gone, whether or not it was adopted.
    // A subsequent migration for a different provider must not see it.
    const resultAfterSecondCall = migrateLegacyContinuation('codex');
    expect(resultAfterSecondCall).toBeUndefined();
  });

  test('prefers existing SDK slot over legacy', () => {
    seedLegacy('legacy-value');
    setContinuation('claude', 'sdk-value', 'sdk');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('sdk-value');
    expect(getContinuation('claude', 'sdk')).toBe('sdk-value');
  });

  test('no legacy row — returns SDK slot value (possibly undefined)', () => {
    expect(migrateLegacyContinuation('claude')).toBeUndefined();

    setContinuation('codex', 'codex-value', 'sdk');
    expect(migrateLegacyContinuation('codex')).toBe('codex-value');
  });

  test('migration is idempotent on a second call (legacy already gone)', () => {
    seedLegacy('once');

    const first = migrateLegacyContinuation('claude');
    expect(first).toBe('once');

    const second = migrateLegacyContinuation('claude');
    expect(second).toBe('once');
  });

  test('phase-2 legacy (bare-provider key) lands in the SDK slot and is cleaned up', () => {
    // Pre-engine-kind v2 wrote `continuation:claude` — only SDK ever
    // produced reload-meaningful values, so adopt into the SDK slot.
    setContinuation('claude', 'pre-engine-kind-value');

    const adopted = migrateLegacyContinuation('claude');

    expect(adopted).toBe('pre-engine-kind-value');
    expect(getContinuation('claude', 'sdk')).toBe('pre-engine-kind-value');
    // Bare key got cleaned up so future flips don't re-read it.
    expect(getContinuation('claude')).toBeUndefined();
  });

  test('phase-2 legacy yields to existing SDK slot', () => {
    setContinuation('claude', 'pre-engine-kind-value');
    setContinuation('claude', 'sdk-already-set', 'sdk');

    const result = migrateLegacyContinuation('claude');

    expect(result).toBe('sdk-already-set');
    expect(getContinuation('claude', 'sdk')).toBe('sdk-already-set');
    expect(getContinuation('claude')).toBeUndefined();
  });
});
