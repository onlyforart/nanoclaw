/**
 * Read per-wiring agent-settings env vars set by container-runner at
 * session spawn (K.1.f step 9.0).
 *
 * Provider implementations call these to apply the per-wiring override
 * with a fallback to the provider's existing constant. Empty string and
 * unset are both treated as "no override". Non-numeric / negative values
 * also fall through to the provided default (operator typos shouldn't
 * fail the spawn — they just lose the override).
 *
 * NANOCLAW_MODEL is read elsewhere (poll-loop.ts pickRoutingFields) so
 * the model override flows through the existing routing-fields path
 * rather than the per-provider defaults below.
 *
 * NANOCLAW_TEMPERATURE and NANOCLAW_SHOW_THINKING are intentionally NOT
 * wired here — runtime application of those two requires extending the
 * provider/engine interface, which is deferred to a follow-up commit
 * (see project_webui_postcutover.md for the operator-confirmed deferral).
 */

/**
 * Read an integer-valued env var. Returns `fallback` when the var is
 * unset, empty, non-numeric, or negative. Zero is preserved (some v1
 * backend-defaults use maxToolRounds=0 to mean "no rounds" / unlimited
 * depending on the engine — leave that semantic to the engine).
 */
export function envIntOr(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  // parseInt-style: allow only integer values; reject floats so an
  // operator typing "1.5" into NANOCLAW_TIMEOUT_MS doesn't silently get
  // 1 ms timeouts.
  return Number.isInteger(n) ? n : fallback;
}

/** Effective max-tool-rounds: NANOCLAW_MAX_TOOL_ROUNDS ?? provider default. */
export function maxToolRoundsOr(fallback: number): number {
  return envIntOr('NANOCLAW_MAX_TOOL_ROUNDS', fallback);
}

/** Effective request timeout (ms): NANOCLAW_TIMEOUT_MS ?? provider default. */
export function timeoutMsOr(fallback: number): number {
  return envIntOr('NANOCLAW_TIMEOUT_MS', fallback);
}
