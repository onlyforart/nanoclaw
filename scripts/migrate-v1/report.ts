/**
 * Writes a single end-of-run markdown report to
 * `scripts/v1-migration-reports/<timestamp>.md`. Captures: phase
 * outcomes, row counts, and any skipped/warning notes.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { ExtrasAdapterResult } from './extras-adapter.js';
import type { LegacyArchiveResult } from './legacy-archive.js';
import type { PipelineMigratorResult } from './pipeline-migrator.js';
import type { PluginMigrationsResult } from './plugin-migrations.js';
import type { FullDiffReport, RowCountReport } from './validator.js';
import { renderFullDiffReport, renderRowCountReport } from './validator.js';

export interface RunReport {
  mode: 'sandbox' | 'live';
  v1Root: string;
  v2Root: string;
  startedAt: string;
  finishedAt: string;
  phaseStatus: Record<string, 'ok' | 'skipped' | 'failed' | 'pending'>;
  pluginMigrations: PluginMigrationsResult | null;
  extras: ExtrasAdapterResult | null;
  pipeline: PipelineMigratorResult | null;
  legacy: LegacyArchiveResult | null;
  rowCounts: RowCountReport | null;
  fullDiff: FullDiffReport | null;
  errors: string[];
}

export function writeReport(reportDir: string, run: RunReport): string {
  fs.mkdirSync(reportDir, { recursive: true });
  const fname = run.finishedAt.replace(/[:.]/g, '-') + '.md';
  const outPath = path.join(reportDir, fname);
  const md = render(run);
  fs.writeFileSync(outPath, md, 'utf-8');
  return outPath;
}

function render(run: RunReport): string {
  const lines: string[] = [];
  lines.push(`# v1 → v2 migration report`);
  lines.push('');
  lines.push(`- Mode: \`${run.mode}\``);
  lines.push(`- v1 root: \`${run.v1Root}\``);
  lines.push(`- v2 root: \`${run.v2Root}\``);
  lines.push(`- Started: \`${run.startedAt}\``);
  lines.push(`- Finished: \`${run.finishedAt}\``);
  lines.push('');
  lines.push('## Phase status');
  lines.push('');
  lines.push('| Phase | Status |');
  lines.push('|---|---|');
  for (const [phase, status] of Object.entries(run.phaseStatus)) {
    lines.push(`| ${phase} | ${status} |`);
  }
  if (run.extras) {
    lines.push('');
    lines.push('## Extras adapter');
    lines.push('');
    lines.push(`- registered_groups extras backfilled: ${run.extras.registeredGroupsBackfilled}`);
    lines.push(`- scheduled_tasks extras backfilled: ${run.extras.scheduledTasksBackfilled}`);
    lines.push(`- owner seeded (user_roles): ${run.extras.ownerSeeded ? 'yes' : 'no'}`);
    if (run.extras.skipped.length > 0) {
      lines.push(`- skipped notes:`);
      for (const s of run.extras.skipped) lines.push(`  - ${s}`);
    }
  }
  if (run.pipeline) {
    lines.push('');
    lines.push('## Pipeline migrator');
    lines.push('');
    for (const [t, n] of Object.entries(run.pipeline.perTable)) {
      lines.push(`- ${t}: ${n}`);
    }
    if (run.pipeline.skipped.length > 0) {
      lines.push(`- skipped notes:`);
      for (const s of run.pipeline.skipped) lines.push(`  - ${s}`);
    }
  }
  if (run.legacy) {
    lines.push('');
    lines.push('## Legacy archive (chats + messages, read-only)');
    lines.push('');
    if (run.legacy.outputPath) {
      lines.push(`- Path: \`${run.legacy.outputPath}\``);
      lines.push(`- Size: ${run.legacy.bytesWritten} bytes`);
    } else if (run.legacy.skipped.length > 0) {
      lines.push(`- _skipped_:`);
      for (const s of run.legacy.skipped) lines.push(`  - ${s}`);
    }
  }
  if (run.pluginMigrations) {
    lines.push('');
    lines.push('## Plugin migrations (Phase 2.5)');
    lines.push('');
    lines.push(`- applied: ${run.pluginMigrations.applied}`);
    lines.push(`- source: \`${run.pluginMigrations.source}\``);
    if (run.pluginMigrations.skipped.length > 0) {
      for (const s of run.pluginMigrations.skipped) lines.push(`- ${s}`);
    }
  }
  if (run.rowCounts) {
    lines.push('');
    lines.push(renderRowCountReport(run.rowCounts));
  }
  if (run.fullDiff) {
    lines.push('');
    lines.push(renderFullDiffReport(run.fullDiff));
  }
  if (run.errors.length > 0) {
    lines.push('');
    lines.push('## Errors');
    lines.push('');
    for (const e of run.errors) lines.push(`- ${e}`);
  }
  return lines.join('\n');
}
