/**
 * K.1.f step 9.0 Commit 2 — per-wiring agent settings resolver.
 *
 * Resolves the effective `model`, `temperature`, `max_tool_rounds`,
 * `timeout_ms`, `show_thinking` for a session at container spawn time.
 * Precedence (Q2 ★a from the step 9.0 plan):
 *
 *   1. messaging_group_agents column (per-wiring override)
 *   2. data/backend-defaults.json[agent_group.agent_provider] (per-provider)
 *   3. NULL — no env var injected; container falls through to its
 *      engine's own default
 *
 * `wiringSettingsToEnv` converts the resolved record into a
 * `Record<string, string>` of `NANOCLAW_*` env vars suitable for
 * `-e KEY=VALUE` injection by container-runner. NULL fields are
 * skipped entirely (no env entry) so the container can tell "operator
 * left this unset" apart from "operator explicitly set this to empty".
 *
 * agent-shared session caveat (step 9.0 plan risk #1): when
 * `session.messaging_group_id` is null (which can happen for sessions
 * created with `session_mode='agent-shared'`), no wiring lookup is
 * possible. The resolver falls back to backend-defaults wholesale and
 * the per-wiring override is silently absent. Per-message wiring
 * resolution for agent-shared is deferred until v2 actually wires that
 * mode in production.
 */
import fs from 'node:fs';
import path from 'node:path';

import { getMessagingGroupAgentByPair } from './db/messaging-groups.js';
import { log } from './log.js';
import type { AgentGroup, Session } from './types.js';

export interface ResolvedWiringSettings {
  model: string | null;
  temperature: number | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  show_thinking: number | null;
}

interface BackendDefaultEntry {
  model?: string;
  temperature?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  // show_thinking deliberately absent — v1's backend-defaults.json never
  // carried it; per-wiring NULL just means "engine default".
}

function loadBackendDefaultsFor(provider: string | null): BackendDefaultEntry {
  if (!provider) return {};
  // Resolve at call time (not module load) so the file is read against the
  // current process working directory — config.ts caches its DATA_DIR at
  // import time, which is too eager for tests that chdir into a sandbox.
  const p = path.join(process.cwd(), 'data', 'backend-defaults.json');
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, BackendDefaultEntry>;
    return raw[provider] ?? {};
  } catch (err) {
    log.warn('Failed to parse backend-defaults.json — falling back to empty', { err });
    return {};
  }
}

export function resolveWiringSettings(session: Session, agentGroup: AgentGroup): ResolvedWiringSettings {
  const defaults = loadBackendDefaultsFor(agentGroup.agent_provider);

  // agent-shared session — no per-wiring override possible.
  if (!session.messaging_group_id) {
    return {
      model: defaults.model ?? null,
      temperature: defaults.temperature ?? null,
      max_tool_rounds: defaults.maxToolRounds ?? null,
      timeout_ms: defaults.timeoutMs ?? null,
      show_thinking: null,
    };
  }

  const wiring = getMessagingGroupAgentByPair(session.messaging_group_id, session.agent_group_id);

  return {
    model: wiring?.model ?? defaults.model ?? null,
    temperature: wiring?.temperature ?? defaults.temperature ?? null,
    max_tool_rounds: wiring?.max_tool_rounds ?? defaults.maxToolRounds ?? null,
    timeout_ms: wiring?.timeout_ms ?? defaults.timeoutMs ?? null,
    show_thinking: wiring?.show_thinking ?? null,
  };
}

export function wiringSettingsToEnv(settings: ResolvedWiringSettings): Record<string, string> {
  const env: Record<string, string> = {};
  if (settings.model != null) env.NANOCLAW_MODEL = settings.model;
  if (settings.temperature != null) env.NANOCLAW_TEMPERATURE = String(settings.temperature);
  if (settings.max_tool_rounds != null) env.NANOCLAW_MAX_TOOL_ROUNDS = String(settings.max_tool_rounds);
  if (settings.timeout_ms != null) env.NANOCLAW_TIMEOUT_MS = String(settings.timeout_ms);
  if (settings.show_thinking != null) env.NANOCLAW_SHOW_THINKING = String(settings.show_thinking);
  return env;
}
