/**
 * CLI arg parsing for `pnpm migrate-v1` (scripts/migrate-from-v1.ts).
 *
 * Kept in its own module so the parser is unit-testable in isolation
 * (no DB access, no side effects). The entry script consumes the
 * resolved shape and decides what to chdir / what to write.
 */

export type MigrationMode = 'sandbox' | 'live';

export interface MigrationArgs {
  /** sandbox = write into a /tmp scratch dir; live = write into the v2 install. */
  mode: MigrationMode;
  /** Absolute path to the v1 install (containing `store/messages.db`). */
  v1Root: string;
  /**
   * Absolute path to the v2 install root (containing `data/`, `groups/`).
   * Live mode: required. Sandbox mode: defaults to a generated /tmp path.
   */
  v2Root: string;
  /** wired-only = only groups with inferable channel; all = include orphans. */
  selection: 'wired-only' | 'all';
  /** Skip phases 1-5, run only Phase 6 against existing v2Root state. */
  validateOnly: boolean;
}

export class ArgsError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): MigrationArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) bools.add(a.slice(2));
    else flags.set(a.slice(2, eq), a.slice(eq + 1));
  }

  const mode = (flags.get('mode') ?? 'sandbox') as MigrationMode;
  if (mode !== 'sandbox' && mode !== 'live') {
    throw new ArgsError(`--mode must be 'sandbox' or 'live' (got '${mode}')`);
  }

  const v1Root = flags.get('v1-root') ?? env.NANOCLAW_V1_PATH ?? '';
  if (!v1Root) {
    throw new ArgsError(
      `v1 install path required: pass --v1-root=/path/to/nanoclaw or set NANOCLAW_V1_PATH`,
    );
  }

  const selection = (flags.get('selection') ?? env.NANOCLAW_MIGRATE_SELECTION ?? 'wired-only') as
    | 'wired-only'
    | 'all';
  if (selection !== 'wired-only' && selection !== 'all') {
    throw new ArgsError(`--selection must be 'wired-only' or 'all' (got '${selection}')`);
  }

  const v2Root =
    flags.get('v2-root') ??
    (mode === 'sandbox' ? `/tmp/nanoclaw-v1-migration-${Date.now()}` : process.cwd());

  return {
    mode,
    v1Root,
    v2Root,
    selection,
    validateOnly: bools.has('validate-only'),
  };
}
