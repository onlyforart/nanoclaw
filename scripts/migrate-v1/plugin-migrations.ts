/**
 * Phase 2.5 — apply pipeline plugin migrations to v2.db before Phase 3 +
 * Phase 4 (which read/write the plugin-owned tables).
 *
 * In live mode the plugin migrations have already been applied by a prior
 * nanoclaw service start (the host loads the plugin via plugin-loader →
 * `registerMigration(m)` for each → `runMigrations(v2Db)` at startup).
 * Calling this phase in live mode is a no-op (re-registers + idempotent
 * runMigrations skips already-applied migrations).
 *
 * In sandbox mode v2.db is freshly migrated with core migrations only;
 * the plugin tables don't exist yet. This phase loads the plugin's
 * `pipelineMigrations` array via the pluggable seam below, registers
 * them, then runs the migration sweep — exactly what production does.
 *
 * Pluggable seam: nanoclaw is the public-facing fork and does not ship
 * the concrete plugin migrations. The migrator dynamically imports a
 * module path supplied by `$NANOCLAW_PIPELINE_MIGRATIONS_PATH`; that
 * module must export `pipelineMigrations: Migration[]`. Operators
 * installing a pipeline plugin set the env var to point at their
 * plugin's loader file (e.g. an `install/migrate-v1-plugin-loader.ts`
 * shipped by the plugin repo). If the env var is unset the phase is
 * skipped with an actionable note.
 */
import type Database from 'better-sqlite3';

import { registerMigration, runMigrations } from '../../src/db/migrations/index.js';

export interface PluginMigrationsResult {
  applied: number;
  source: string;
  skipped: string[];
}

export async function applyPluginMigrations(
  v2Db: Database.Database,
): Promise<PluginMigrationsResult> {
  const source = process.env.NANOCLAW_PIPELINE_MIGRATIONS_PATH;
  if (!source) {
    return {
      applied: 0,
      source: 'none',
      skipped: [
        'plugin-migrations: NANOCLAW_PIPELINE_MIGRATIONS_PATH not set — skipping. ' +
          'If you are running migrate-v1 with a pipeline plugin installed, point this env var at the plugin repo\'s migrations loader module.',
      ],
    };
  }

  try {
    const mod = (await import(source)) as {
      pipelineMigrations?: Array<{ name: string; version: number; up: (db: Database.Database) => void }>;
    };
    const migrations = mod.pipelineMigrations;
    if (!Array.isArray(migrations) || migrations.length === 0) {
      return {
        applied: 0,
        source,
        skipped: [`plugin-migrations: ${source} did not export a non-empty pipelineMigrations array`],
      };
    }
    for (const m of migrations) registerMigration(m);
    runMigrations(v2Db);
    return { applied: migrations.length, source, skipped: [] };
  } catch (err) {
    return {
      applied: 0,
      source,
      skipped: [
        `plugin-migrations: failed to import ${source}: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
