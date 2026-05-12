/**
 * Single-entry orchestrator for the v1 → v2 live data migration
 * (K.1.f step 12 of the v1→v2 migration plan).
 *
 * Usage:
 *   pnpm migrate-v1 -- --v1-root=/path/to/v1 --mode=sandbox
 *   pnpm migrate-v1 -- --v1-root=/path/to/v1 --mode=live
 *   pnpm migrate-v1 -- --v1-root=/path/to/v1 --validate-only
 *
 * The script chains 7 phases:
 *   1.   Snapshot v1 DB (sandbox mode only; live reads in place).
 *   2.   Run vendored upstream `setup/migrate-v1/*` sub-steps in order.
 *   2.5. Apply pipeline plugin migrations (creates plugin-owned tables).
 *   3.   Apply extras adapter (per-wiring engine settings + owner role).
 *   4.   Run pipeline-tables migrator (9 v1 pipeline tables + router_state).
 *   5.   Build legacy archive (chats + messages → data/legacy-v1-readonly.db).
 *   6.   Validate (row-count parity + full table diff per Q7=c).
 *
 * Output: `scripts/v1-migration-reports/<timestamp>.md` + non-zero
 * exit code if any phase fails.
 *
 * CRITICAL: this file MUST NOT statically import anything from `src/`
 * — `src/config.ts` captures `process.cwd()` at module-load time, and
 * the orchestrator needs to chdir into the v2 root BEFORE that happens.
 * All v2/setup imports are dynamic (`await import(...)`) and run after
 * the chdir.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ArgsError, parseArgs } from './migrate-v1/args.js';

const REPORT_DIR = path.resolve(import.meta.dirname, 'v1-migration-reports');

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof ArgsError) {
      process.stderr.write(`migrate-v1: ${err.message}\n`);
      process.stderr.write(usage());
      return 2;
    }
    throw err;
  }

  console.log(`migrate-v1: mode=${args.mode} v1-root=${args.v1Root} v2-root=${args.v2Root}`);

  // Resolve v1 DB path. In sandbox mode, snapshot it. In live mode, point
  // the migrator at the live file directly (read-only handle).
  const v1DbLive = path.join(args.v1Root, 'store', 'messages.db');
  if (!fs.existsSync(v1DbLive)) {
    process.stderr.write(`migrate-v1: v1 DB not found at ${v1DbLive}\n`);
    return 3;
  }

  // Prepare v2 root. Sandbox mode: ensure clean subdirs. Live mode: trust
  // it exists.
  if (args.mode === 'sandbox') {
    fs.mkdirSync(args.v2Root, { recursive: true });
    for (const sub of ['data', 'groups', 'logs/setup-migration', 'store/auth']) {
      fs.mkdirSync(path.join(args.v2Root, sub), { recursive: true });
    }
  }

  let snapshotV1DbPath = v1DbLive;
  if (args.mode === 'sandbox') {
    // Phase 1 — snapshot. Imported eagerly because no src/ pull.
    const { snapshotV1Db } = await import('./migrate-v1/snapshot.js');
    snapshotV1DbPath = path.join(args.v2Root, 'store', 'messages.db');
    snapshotV1Db(v1DbLive, snapshotV1DbPath);
    console.log(`migrate-v1: snapshotted v1 → ${snapshotV1DbPath}`);
  }

  // ── chdir into v2 root BEFORE the first vendored-sub-step import.
  process.chdir(args.v2Root);
  // The vendored sub-steps read NANOCLAW_V1_PATH / NANOCLAW_MIGRATE_SELECTION
  // from env. Point at the LIVE v1 root in both modes: the sub-steps need
  // v1's full directory tree (.env, groups/, channel-auth state), not just
  // messages.db. The snapshot exists only for the orchestrator's own
  // better-sqlite3 handle, used by phases 3+. Pointing the env at v2Root
  // in sandbox mode (the prior behaviour) made detect.ts skip the candidate
  // via its self-skip guard (`absolute === cwd`) and all sub-steps emit
  // STATUS:skipped REASON:no_v1_path.
  process.env.NANOCLAW_V1_PATH = args.v1Root;
  process.env.NANOCLAW_MIGRATE_SELECTION = args.selection;

  const phaseStatus: Record<string, 'ok' | 'skipped' | 'failed' | 'pending'> = {
    'phase-1-snapshot': args.mode === 'sandbox' ? 'ok' : 'skipped',
    'phase-2-upstream-tooling': 'pending',
    'phase-2.5-plugin-migrations': 'pending',
    'phase-3-extras': 'pending',
    'phase-4-pipeline': 'pending',
    'phase-5-legacy-archive': 'pending',
    'phase-6-validation': 'pending',
  };
  const errors: string[] = [];

  if (!args.validateOnly) {
    // Phase 2 — vendored upstream sub-steps in order.
    const steps = [
      'detect',
      'validate',
      'db',
      'groups',
      'env',
      'channel-auth',
      'channels',
      'tasks',
    ];
    let allOk = true;
    for (const step of steps) {
      try {
        const mod = (await import(`../setup/migrate-v1/${step}.js`)) as {
          run: (args: string[]) => Promise<void>;
        };
        await mod.run([]);
        console.log(`migrate-v1: phase-2 ${step} ok`);
      } catch (err) {
        allOk = false;
        const msg = `phase-2 ${step}: ${(err as Error).message ?? err}`;
        errors.push(msg);
        process.stderr.write(`migrate-v1: ${msg}\n`);
      }
    }
    phaseStatus['phase-2-upstream-tooling'] = allOk ? 'ok' : 'failed';
  } else {
    phaseStatus['phase-2-upstream-tooling'] = 'skipped';
  }

  const Database = (await import('better-sqlite3')).default;
  const v1Db = new Database(snapshotV1DbPath, { readonly: true, fileMustExist: true });
  const v2DbPath = path.resolve('data/v2.db');
  const v2Db = new Database(v2DbPath, { fileMustExist: false });

  let extrasResult = null;
  let pipelineResult = null;
  let legacyResult = null;
  let pluginMigrationsResult = null;
  const taskRunLogsNow = Date.now();

  if (!args.validateOnly) {
    // Phase 2.5 — apply pipeline plugin migrations (sandbox mode needs this;
    // live mode is idempotent).
    const { applyPluginMigrations } = await import('./migrate-v1/plugin-migrations.js');
    pluginMigrationsResult = await applyPluginMigrations(v2Db);
    phaseStatus['phase-2.5-plugin-migrations'] =
      pluginMigrationsResult.applied > 0 ? 'ok' : 'failed';
    if (pluginMigrationsResult.applied === 0) {
      errors.push(...pluginMigrationsResult.skipped);
    }

    const { applyExtras } = await import('./migrate-v1/extras-adapter.js');
    extrasResult = applyExtras(v1Db, v2Db, {
      ownerUserId: process.env.NANOCLAW_V1_OWNER_USER_ID,
      v2DbPath,
    });
    phaseStatus['phase-3-extras'] = 'ok';

    const { migratePipelineTables } = await import('./migrate-v1/pipeline-migrator.js');
    pipelineResult = migratePipelineTables(v1Db, v2Db, { taskRunLogsNow });
    phaseStatus['phase-4-pipeline'] = 'ok';

    const { createLegacyArchive } = await import('./migrate-v1/legacy-archive.js');
    legacyResult = createLegacyArchive(
      snapshotV1DbPath,
      path.resolve('data/legacy-v1-readonly.db'),
    );
    phaseStatus['phase-5-legacy-archive'] = legacyResult.outputPath ? 'ok' : 'failed';
  } else {
    phaseStatus['phase-2.5-plugin-migrations'] = 'skipped';
    phaseStatus['phase-3-extras'] = 'skipped';
    phaseStatus['phase-4-pipeline'] = 'skipped';
    phaseStatus['phase-5-legacy-archive'] = 'skipped';
  }

  // Phase 6 — validation (row counts always; full diff only when migrations ran).
  const { computeRowCounts, fullDiff } = await import('./migrate-v1/validator.js');
  const rowCounts = computeRowCounts(v1Db, v2Db);
  const diff = args.validateOnly ? null : fullDiff(v1Db, v2Db, { taskRunLogsNow });
  phaseStatus['phase-6-validation'] = 'ok';
  v1Db.close();
  v2Db.close();

  const finishedAt = new Date().toISOString();
  const { writeReport } = await import('./migrate-v1/report.js');
  const reportPath = writeReport(REPORT_DIR, {
    mode: args.mode,
    v1Root: args.v1Root,
    v2Root: args.v2Root,
    startedAt,
    finishedAt,
    phaseStatus,
    pluginMigrations: pluginMigrationsResult,
    extras: extrasResult,
    pipeline: pipelineResult,
    legacy: legacyResult,
    rowCounts,
    fullDiff: diff,
    errors,
  });
  console.log(`migrate-v1: report written to ${reportPath}`);

  const anyFailed = Object.values(phaseStatus).some((s) => s === 'failed');
  return anyFailed ? 1 : 0;
}

function usage(): string {
  return [
    '',
    'Usage:',
    '  pnpm migrate-v1 -- --v1-root=/path/to/v1 [--mode=sandbox|live]',
    '                     [--v2-root=/path] [--selection=wired-only|all]',
    '                     [--validate-only]',
    '',
    'Environment:',
    '  NANOCLAW_V1_PATH           same as --v1-root',
    '  NANOCLAW_MIGRATE_SELECTION same as --selection',
    '',
  ].join('\n');
}

main()
  .then((code) => process.exit(code))
  .catch((err: Error) => {
    process.stderr.write(`migrate-v1: fatal error: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
