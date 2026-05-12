/**
 * Tests for the wiring-settings resolver — K.1.f step 9.0 Commit 2.
 *
 * Resolves the effective per-wiring agent settings (model, temperature,
 * max_tool_rounds, timeout_ms, show_thinking) for a session by reading
 * the messaging_group_agents row and falling back to backend-defaults
 * for any NULL fields. Per Q2 ★(a): wiring NULL →
 * `data/backend-defaults.json[agent_group.agent_provider]`. NULL fields
 * remain NULL when no backend-default exists (e.g. `model` /
 * `temperature` / `show_thinking` which the v1 fork's
 * backend-defaults.json doesn't typically carry).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from './db/index.js';
import type { AgentGroup, Session } from './types.js';
import { resolveWiringSettings, wiringSettingsToEnv } from './wiring-settings-resolve.js';

const TMP = '/tmp/nanoclaw-wiring-settings-test';

function now() {
  return new Date().toISOString();
}

function writeBackendDefaults(contents: Record<string, Record<string, unknown>>): void {
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'data', 'backend-defaults.json'), JSON.stringify(contents));
}

function clearBackendDefaults(): void {
  const p = path.join(TMP, 'data', 'backend-defaults.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function makeSession(opts: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
    ...opts,
  };
}

function makeAgentGroup(provider: string | null = 'claude'): AgentGroup {
  return {
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: provider,
    created_at: now(),
  };
}

beforeEach(() => {
  // Each test runs in /tmp/<TMP> so DATA_DIR-resolution sees our fixtures.
  // config.ts reads DATA_DIR from process.cwd() ⨯ 'data' so we chdir.
  fs.mkdirSync(TMP, { recursive: true });
  process.chdir(TMP);

  const db = initTestDb();
  runMigrations(db);

  // Standard fixtures shared by most tests
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: 'claude',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack',
    platform_id: 'C_TEST_1',
    name: 'Test Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(() => {
  closeDb();
  clearBackendDefaults();
});

describe('resolveWiringSettings', () => {
  it('WR1 — wiring values take precedence over backend-defaults', () => {
    writeBackendDefaults({
      claude: { maxToolRounds: 0, timeoutMs: 1_800_000 },
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
      model: 'claude-haiku-4.5',
      temperature: 0.4,
      max_tool_rounds: 50, // overrides backend-default 0
      timeout_ms: 300_000, // overrides backend-default 1_800_000
      show_thinking: 1,
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup('claude'));
    expect(resolved.model).toBe('claude-haiku-4.5');
    expect(resolved.temperature).toBe(0.4);
    expect(resolved.max_tool_rounds).toBe(50);
    expect(resolved.timeout_ms).toBe(300_000);
    expect(resolved.show_thinking).toBe(1);
  });

  it('WR2 — NULL wiring fields fall back to backend-defaults[provider]', () => {
    writeBackendDefaults({
      claude: { maxToolRounds: 25, timeoutMs: 600_000 },
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
      // model / temperature / max_tool_rounds / timeout_ms / show_thinking all NULL
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup('claude'));
    expect(resolved.model).toBeNull(); // no backend-default → null
    expect(resolved.temperature).toBeNull();
    expect(resolved.max_tool_rounds).toBe(25); // fell back to defaults
    expect(resolved.timeout_ms).toBe(600_000);
    expect(resolved.show_thinking).toBeNull();
  });

  it('WR3 — both wiring and defaults NULL → null in resolved settings', () => {
    // No backend-defaults file written.
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup('claude'));
    expect(resolved.model).toBeNull();
    expect(resolved.temperature).toBeNull();
    expect(resolved.max_tool_rounds).toBeNull();
    expect(resolved.timeout_ms).toBeNull();
    expect(resolved.show_thinking).toBeNull();
  });

  it('WR4 — agent-shared session (messaging_group_id=null) uses backend-defaults wholesale', () => {
    writeBackendDefaults({
      claude: { maxToolRounds: 25, timeoutMs: 600_000 },
    });
    // No wiring lookup possible — no messaging_group_id on session.
    const resolved = resolveWiringSettings(makeSession({ messaging_group_id: null }), makeAgentGroup('claude'));
    expect(resolved.max_tool_rounds).toBe(25);
    expect(resolved.timeout_ms).toBe(600_000);
    // Backend-defaults doesn't carry model/temp/show_thinking by convention.
    expect(resolved.model).toBeNull();
  });

  it('WR5 — unknown agent_provider yields no backend-defaults; all NULL', () => {
    writeBackendDefaults({
      claude: { maxToolRounds: 25, timeoutMs: 600_000 },
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup('mystery-provider'));
    expect(resolved.max_tool_rounds).toBeNull();
    expect(resolved.timeout_ms).toBeNull();
  });

  it('WR6 — missing backend-defaults.json → behaves as empty defaults', () => {
    // No file written.
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
      model: 'ollama:llama3.1',
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup('claude'));
    expect(resolved.model).toBe('ollama:llama3.1');
    expect(resolved.max_tool_rounds).toBeNull();
    expect(resolved.timeout_ms).toBeNull();
  });

  it('WR7 — null agent_provider falls through (no provider-specific defaults applied)', () => {
    writeBackendDefaults({
      claude: { maxToolRounds: 25, timeoutMs: 600_000 },
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });

    const resolved = resolveWiringSettings(makeSession(), makeAgentGroup(null));
    expect(resolved.max_tool_rounds).toBeNull();
    expect(resolved.timeout_ms).toBeNull();
  });
});

describe('wiringSettingsToEnv', () => {
  it('WE1 — emits NANOCLAW_* env vars for set fields, skips nulls', () => {
    const env = wiringSettingsToEnv({
      model: 'claude-haiku-4.5',
      temperature: 0.4,
      max_tool_rounds: 50,
      timeout_ms: 300_000,
      show_thinking: 1,
    });
    expect(env).toEqual({
      NANOCLAW_MODEL: 'claude-haiku-4.5',
      NANOCLAW_TEMPERATURE: '0.4',
      NANOCLAW_MAX_TOOL_ROUNDS: '50',
      NANOCLAW_TIMEOUT_MS: '300000',
      NANOCLAW_SHOW_THINKING: '1',
    });
  });

  it('WE2 — skips null fields entirely (no env entry rather than empty string)', () => {
    const env = wiringSettingsToEnv({
      model: null,
      temperature: null,
      max_tool_rounds: 50,
      timeout_ms: null,
      show_thinking: null,
    });
    expect(env).toEqual({ NANOCLAW_MAX_TOOL_ROUNDS: '50' });
  });

  it('WE3 — all nulls → empty object', () => {
    expect(
      wiringSettingsToEnv({
        model: null,
        temperature: null,
        max_tool_rounds: null,
        timeout_ms: null,
        show_thinking: null,
      }),
    ).toEqual({});
  });

  it('WE4 — temperature=0 emits "0" (falsy but not null)', () => {
    const env = wiringSettingsToEnv({
      model: null,
      temperature: 0,
      max_tool_rounds: null,
      timeout_ms: null,
      show_thinking: 0,
    });
    expect(env.NANOCLAW_TEMPERATURE).toBe('0');
    expect(env.NANOCLAW_SHOW_THINKING).toBe('0');
  });
});
