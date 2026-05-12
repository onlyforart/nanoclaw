/**
 * Phase 6 validator — row-count parity report.
 *
 * Commit-1 scope is row counts only. Full table diff (Q7=c — semantic
 * column-shape diff with v2→v1 reverse-translation) lands in Commit 3
 * alongside the pipeline-tables migrator. The row-count harness here is
 * sufficient to catch wholesale loss (a phase failing silently → empty
 * target table) and to anchor the markdown report shape.
 */
import type Database from 'better-sqlite3';

export interface RowCountReport {
  v1: Record<string, number | null>;
  v2: Record<string, number | null>;
  /** Stable order — matches v1-to-v2 mapping order for human review. */
  order: string[];
  notes: string[];
}

/** Tables we read from v1's monolithic store/messages.db. */
const V1_TABLES = [
  'chats',
  'messages',
  'registered_groups',
  'scheduled_tasks',
  'task_run_logs',
  'sessions',
  'router_state',
  'events',
  'observed_messages',
  'pipeline_clusters',
  'pipeline_intake_log',
  'observation_labels',
  'reextraction_cache',
  'cross_channel_deliveries',
] as const;

/**
 * Tables we read from v2's central data/v2.db. Some live under the
 * pipeline plugin's migration block (created at plugin-load time) —
 * the validator handles "table absent" by reporting null.
 */
const V2_TABLES = [
  // Standard entity tables (created by upstream migrate-v1/db.ts):
  'agent_groups',
  'messaging_groups',
  'messaging_group_agents',
  'sessions',
  // Pipeline-plugin tables (created when plugin migrations run; absent in
  // a freshly-migrated DB without the plugin loaded):
  'pipeline_scheduled_tasks',
  'pipeline_task_run_logs',
  'pipeline_events',
  'observed_messages',
  'pipeline_clusters',
  'pipeline_intake_log',
  'observation_labels',
  'reextraction_cache',
  'pipeline_cross_channel_deliveries',
  'pipeline_passive_subscriptions',
] as const;

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name) as { one: number } | undefined;
  return !!row;
}

function countRows(db: Database.Database, table: string): number | null {
  if (!tableExists(db, table)) return null;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function computeRowCounts(
  v1Db: Database.Database,
  v2Db: Database.Database,
): RowCountReport {
  const v1: Record<string, number | null> = {};
  const v2: Record<string, number | null> = {};
  for (const t of V1_TABLES) v1[t] = countRows(v1Db, t);
  for (const t of V2_TABLES) v2[t] = countRows(v2Db, t);

  const notes: string[] = [];
  if (v2['agent_groups'] === null) {
    notes.push('v2 has no `agent_groups` table — migrations not applied?');
  }
  if (v1['router_state'] !== null && v1['router_state']! > 0 && v2['pipeline_passive_subscriptions'] === null) {
    notes.push(
      'v1 has router_state rows but v2 has no pipeline_passive_subscriptions table — the pipeline plugin migrations have not run yet.',
    );
  }
  if (v1['task_run_logs'] !== null && v1['task_run_logs']! > 0 && v2['pipeline_task_run_logs'] === null) {
    notes.push(
      'v1 has task_run_logs rows but v2 has no pipeline_task_run_logs table — pipeline plugin migrations missing.',
    );
  }

  return {
    v1,
    v2,
    order: [...V1_TABLES],
    notes,
  };
}

export function renderRowCountReport(report: RowCountReport): string {
  const lines: string[] = [];
  lines.push('## Row count report — v1 → v2');
  lines.push('');
  lines.push('| v1 table | v1 rows | → v2 target(s) | v2 rows |');
  lines.push('|---|---:|---|---:|');
  const MAPPING: Record<string, string> = {
    chats: '_legacy archive only_',
    messages: '_legacy archive only_',
    registered_groups: '`agent_groups` + `messaging_groups` + `messaging_group_agents`',
    scheduled_tasks: '`messages_in` (container) + `pipeline_scheduled_tasks` (host_pipeline)',
    task_run_logs: '`pipeline_task_run_logs` (30-day window)',
    sessions: '_dropped — v2 sessions are ephemeral_',
    router_state: '`pipeline_passive_subscriptions` (sanitiser_cursor:* only)',
    events: '`pipeline_events`',
    observed_messages: '`observed_messages`',
    pipeline_clusters: '`pipeline_clusters`',
    pipeline_intake_log: '`pipeline_intake_log`',
    observation_labels: '`observation_labels`',
    reextraction_cache: '`reextraction_cache`',
    cross_channel_deliveries: '`pipeline_cross_channel_deliveries`',
  };
  for (const t of report.order) {
    const v1n = report.v1[t];
    const target = MAPPING[t] ?? '_unmapped_';
    let v2n: string;
    if (target.includes('_legacy archive only_') || target.includes('_dropped')) {
      v2n = '—';
    } else if (target.includes('agent_groups')) {
      v2n = formatN(report.v2['agent_groups']);
    } else if (target.includes('pipeline_scheduled_tasks') && t === 'scheduled_tasks') {
      v2n = `host=${formatN(report.v2['pipeline_scheduled_tasks'])}, container=via session DBs`;
    } else if (target.includes('pipeline_task_run_logs')) {
      v2n = formatN(report.v2['pipeline_task_run_logs']);
    } else if (target.includes('pipeline_passive_subscriptions')) {
      v2n = formatN(report.v2['pipeline_passive_subscriptions']);
    } else if (target.includes('pipeline_events')) {
      v2n = formatN(report.v2['pipeline_events']);
    } else if (target.includes('pipeline_cross_channel_deliveries')) {
      v2n = formatN(report.v2['pipeline_cross_channel_deliveries']);
    } else if (target.startsWith('`')) {
      const m = /^`([^`]+)`/.exec(target);
      v2n = m ? formatN(report.v2[m[1]] ?? null) : '?';
    } else {
      v2n = '?';
    }
    lines.push(`| \`${t}\` | ${formatN(v1n)} | ${target} | ${v2n} |`);
  }
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('### Notes');
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

function formatN(n: number | null): string {
  if (n === null) return '_n/a_';
  return n.toLocaleString('en-US');
}

// ── Q7=c — full table diff against v2-shape-translated v1 snapshot ─────

export interface DiffMismatch {
  table: string;
  id: string | number;
  column: string;
  v1Value: unknown;
  v2Value: unknown;
}

export interface TableDiff {
  v1Rows: number;
  v2Rows: number;
  rowsCompared: number;
  mismatches: DiffMismatch[];
  notes: string[];
}

export interface FullDiffReport {
  perTable: Record<string, TableDiff>;
}

const TASK_RUN_LOGS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function fullDiff(
  v1Db: Database.Database,
  v2Db: Database.Database,
  opts: { taskRunLogsNow: number },
): FullDiffReport {
  const out: FullDiffReport = { perTable: {} };
  out.perTable.events = diffTable(v1Db, v2Db, 'events', 'pipeline_events', 'id');
  out.perTable.observed_messages = diffTable(
    v1Db,
    v2Db,
    'observed_messages',
    'observed_messages',
    'id',
  );
  out.perTable.pipeline_clusters = diffTable(
    v1Db,
    v2Db,
    'pipeline_clusters',
    'pipeline_clusters',
    'id',
  );
  out.perTable.pipeline_intake_log = diffTable(
    v1Db,
    v2Db,
    'pipeline_intake_log',
    'pipeline_intake_log',
    'id',
  );
  out.perTable.observation_labels = diffTable(
    v1Db,
    v2Db,
    'observation_labels',
    'observation_labels',
    'id',
  );
  out.perTable.reextraction_cache = diffTable(
    v1Db,
    v2Db,
    'reextraction_cache',
    'reextraction_cache',
    'id',
  );
  out.perTable.cross_channel_deliveries = diffTable(
    v1Db,
    v2Db,
    'cross_channel_deliveries',
    'pipeline_cross_channel_deliveries',
    'key',
  );
  out.perTable.scheduled_tasks_host_pipeline = diffTable(
    v1Db,
    v2Db,
    'scheduled_tasks',
    'pipeline_scheduled_tasks',
    'id',
    "execution_mode = 'host_pipeline'",
    null,
    ['execution_mode'],
  );
  const cutoff = new Date(opts.taskRunLogsNow - TASK_RUN_LOGS_WINDOW_MS).toISOString();
  out.perTable.task_run_logs_30d = diffTable(
    v1Db,
    v2Db,
    'task_run_logs',
    'pipeline_task_run_logs',
    'id',
    `run_at >= '${cutoff}'`,
  );
  return out;
}

function diffTable(
  v1Db: Database.Database,
  v2Db: Database.Database,
  v1Table: string,
  v2Table: string,
  pk: string,
  v1Where: string | null = null,
  v2Where: string | null = null,
  excludeColumns: string[] = [],
): TableDiff {
  const notes: string[] = [];
  if (!hasTable(v1Db, v1Table)) {
    notes.push(`v1 ${v1Table} absent`);
    return { v1Rows: 0, v2Rows: 0, rowsCompared: 0, mismatches: [], notes };
  }
  if (!hasTable(v2Db, v2Table)) {
    notes.push(`v2 ${v2Table} absent`);
    return { v1Rows: 0, v2Rows: 0, rowsCompared: 0, mismatches: [], notes };
  }
  const v1Sql = `SELECT * FROM ${v1Table}${v1Where ? ` WHERE ${v1Where}` : ''}`;
  const v2Sql = `SELECT * FROM ${v2Table}${v2Where ? ` WHERE ${v2Where}` : ''}`;
  const v1Rows = v1Db.prepare(v1Sql).all() as Array<Record<string, unknown>>;
  const v2Rows = v2Db.prepare(v2Sql).all() as Array<Record<string, unknown>>;

  const v2ById = new Map<unknown, Record<string, unknown>>();
  for (const r of v2Rows) v2ById.set(r[pk], r);

  const mismatches: DiffMismatch[] = [];
  const sharedCols =
    v1Rows.length > 0
      ? Object.keys(v1Rows[0]).filter((c) => !excludeColumns.includes(c))
      : [];

  for (const v1r of v1Rows) {
    const id = v1r[pk] as string | number;
    const v2r = v2ById.get(id);
    if (!v2r) {
      mismatches.push({
        table: v2Table,
        id,
        column: '<row-missing>',
        v1Value: '<exists>',
        v2Value: null,
      });
      continue;
    }
    for (const col of sharedCols) {
      if (!(col in v2r)) continue;
      const v1v = norm(v1r[col]);
      const v2v = norm(v2r[col]);
      if (v1v !== v2v) {
        mismatches.push({ table: v2Table, id, column: col, v1Value: v1v, v2Value: v2v });
      }
    }
  }

  return {
    v1Rows: v1Rows.length,
    v2Rows: v2Rows.length,
    rowsCompared: v1Rows.length,
    mismatches,
    notes,
  };
}

function hasTable(db: Database.Database, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
}

function norm(v: unknown): unknown {
  if (v === undefined) return null;
  return v;
}

export function renderFullDiffReport(diff: FullDiffReport): string {
  const lines: string[] = [];
  lines.push('## Full table diff (Q7=c)');
  lines.push('');
  lines.push('| Table | v1 rows | v2 rows | Compared | Mismatches |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const [table, d] of Object.entries(diff.perTable)) {
    lines.push(
      `| \`${table}\` | ${d.v1Rows} | ${d.v2Rows} | ${d.rowsCompared} | ${d.mismatches.length} |`,
    );
  }
  // Detail blocks for each table that has mismatches.
  for (const [table, d] of Object.entries(diff.perTable)) {
    if (d.mismatches.length === 0 && d.notes.length === 0) continue;
    lines.push('');
    lines.push(`### ${table}`);
    for (const n of d.notes) lines.push(`- _${n}_`);
    if (d.mismatches.length > 0) {
      lines.push('');
      const display = d.mismatches.slice(0, 25);
      lines.push('| id | column | v1 | v2 |');
      lines.push('|---|---|---|---|');
      for (const m of display) {
        lines.push(
          `| \`${String(m.id)}\` | \`${m.column}\` | \`${truncate(String(m.v1Value), 40)}\` | \`${truncate(String(m.v2Value), 40)}\` |`,
        );
      }
      if (d.mismatches.length > 25) {
        lines.push('');
        lines.push(`_(${d.mismatches.length - 25} additional mismatches not shown)_`);
      }
    }
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
