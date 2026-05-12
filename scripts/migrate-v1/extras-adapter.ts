/**
 * Phase 3 — backfill columns the upstream `setup/migrate-v1/` tooling
 * doesn't know about: per-wiring engine settings on
 * `messaging_group_agents` (model / max_tool_rounds / timeout_ms /
 * temperature / show_thinking; plus pipeline_replies_blocked when the
 * plugin migrations have run); the 11 extras on per-task content blobs
 * in session inbound DBs; and the owner seed in `user_roles` derived
 * from v1's `is_main` flag (Option β per operator).
 *
 * Inputs:
 *   - v1Db: read-only handle on v1 store/messages.db (post-snapshot).
 *   - v2Db: writeable handle on central data/v2.db. Upstream tooling
 *     must have populated agent_groups + messaging_groups +
 *     messaging_group_agents + sessions + per-session inbound.db rows
 *     before this adapter runs.
 *   - opts.ownerUserId: bot operator user id (format "<channel>:<handle>",
 *     e.g. "slack:U001"). Required to seed `user_roles(role='owner')`
 *     from v1's is_main rows; if absent, owner seeding is skipped
 *     and an actionable note is added.
 *   - opts.v2DbPath: absolute path to v2.db. Used to derive per-session
 *     inbound.db paths (`<dirname>/v2-sessions/<ag>/<session>/inbound.db`).
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { inferChannelType, v2PlatformId } from '../../setup/migrate-v1/shared.js';

export interface ExtrasAdapterOpts {
  /**
   * Bot operator user id for owner role seeding. Format: "<channel>:<handle>"
   * (e.g. "slack:U001"). Sourced from NANOCLAW_V1_OWNER_USER_ID env var in
   * the orchestrator. If undefined, owner seeding is skipped + an
   * actionable note is added to the run report.
   */
  ownerUserId?: string;
  /**
   * Absolute path to central v2.db. The per-session inbound DBs live at
   * `<dirname(v2DbPath)>/v2-sessions/<agent_group_id>/<session_id>/inbound.db`.
   */
  v2DbPath: string;
}

export interface ExtrasAdapterResult {
  registeredGroupsBackfilled: number;
  scheduledTasksBackfilled: number;
  ownerSeeded: boolean;
  skipped: string[];
}

interface V1RegisteredGroup {
  jid: string;
  name: string;
  folder: string;
  is_main: number;
  model: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  temperature: number | null;
  show_thinking: number | null;
  mode: string;
  threading_mode: string;
  pipeline_replies_blocked: number;
}

interface V1ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  status: string;
  context_mode: string | null;
  execution_mode: string;
  model: string | null;
  timezone: string | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  temperature: number | null;
  use_agent_sdk: number;
  allowed_tools: string | null;
  allowed_send_targets: string | null;
  subscribed_event_types: string | null;
  fallback_poll_ms: number | null;
  batch_size: number | null;
}

const RG_EXTRA_COLS = [
  'model',
  'max_tool_rounds',
  'timeout_ms',
  'temperature',
  'show_thinking',
] as const satisfies ReadonlyArray<keyof V1RegisteredGroup>;

const ST_EXTRA_COLS = [
  'model',
  'timezone',
  'max_tool_rounds',
  'timeout_ms',
  'temperature',
  'use_agent_sdk',
  'allowed_tools',
  'allowed_send_targets',
  'subscribed_event_types',
  'fallback_poll_ms',
  'batch_size',
] as const satisfies ReadonlyArray<keyof V1ScheduledTask>;

export function applyExtras(
  v1Db: Database.Database,
  v2Db: Database.Database,
  opts: ExtrasAdapterOpts,
): ExtrasAdapterResult {
  const skipped: string[] = [];
  const registeredGroupsBackfilled = applyRegisteredGroupsExtras(v1Db, v2Db, skipped);
  const scheduledTasksBackfilled = applyScheduledTasksExtras(v1Db, v2Db, opts.v2DbPath, skipped);
  const ownerSeeded = seedOwnerFromIsMain(v1Db, v2Db, opts.ownerUserId, skipped);
  return {
    registeredGroupsBackfilled,
    scheduledTasksBackfilled,
    ownerSeeded,
    skipped,
  };
}

function applyRegisteredGroupsExtras(
  v1Db: Database.Database,
  v2Db: Database.Database,
  skipped: string[],
): number {
  const rows = v1Db.prepare(`SELECT * FROM registered_groups`).all() as V1RegisteredGroup[];
  const chatChannelByJid = new Map<string, string | null>();
  const chats = v1Db
    .prepare(`SELECT jid, channel FROM chats`)
    .all() as Array<{ jid: string; channel: string | null }>;
  for (const c of chats) chatChannelByJid.set(c.jid, c.channel);

  const mgaCols = listColumns(v2Db, 'messaging_group_agents');

  let backfilled = 0;
  for (const g of rows) {
    const channelType = inferChannelType(g.jid, chatChannelByJid.get(g.jid) ?? null);
    if (!channelType) {
      skipped.push(
        `registered_groups: cannot infer channel_type for ${g.jid} (folder=${g.folder})`,
      );
      continue;
    }
    const platformId = v2PlatformId(channelType, g.jid);

    const ag = v2Db.prepare(`SELECT id FROM agent_groups WHERE folder = ?`).get(g.folder) as
      | { id: string }
      | undefined;
    const mg = v2Db
      .prepare(`SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`)
      .get(channelType, platformId) as { id: string } | undefined;
    if (!ag || !mg) {
      skipped.push(
        `registered_groups: no v2 ag+mg for folder=${g.folder} jid=${g.jid} — upstream tooling did not seed this row`,
      );
      continue;
    }
    const mga = v2Db
      .prepare(
        `SELECT id FROM messaging_group_agents
          WHERE messaging_group_id = ? AND agent_group_id = ?`,
      )
      .get(mg.id, ag.id) as { id: string } | undefined;
    if (!mga) {
      skipped.push(
        `registered_groups: no v2 messaging_group_agent for folder=${g.folder} jid=${g.jid}`,
      );
      continue;
    }

    const updates: Record<string, unknown> = {};
    for (const col of RG_EXTRA_COLS) {
      const val = g[col];
      if (val !== null && val !== undefined) updates[col] = val;
    }
    if (g.pipeline_replies_blocked) {
      if (mgaCols.has('pipeline_replies_blocked')) {
        updates['pipeline_replies_blocked'] = g.pipeline_replies_blocked;
      } else {
        skipped.push(
          `registered_groups: skipped pipeline_replies_blocked for folder=${g.folder} — column not present in v2 (pipeline plugin migrations not yet applied)`,
        );
      }
    }

    if (Object.keys(updates).length > 0) {
      const cols = Object.keys(updates);
      const sets = cols.map((c) => `${c} = ?`).join(', ');
      const vals = cols.map((c) => updates[c]);
      v2Db
        .prepare(`UPDATE messaging_group_agents SET ${sets} WHERE id = ?`)
        .run(...vals, mga.id);
      backfilled += 1;
    }
  }
  return backfilled;
}

function applyScheduledTasksExtras(
  v1Db: Database.Database,
  v2Db: Database.Database,
  v2DbPath: string,
  skipped: string[],
): number {
  const tasks = v1Db
    .prepare(`SELECT * FROM scheduled_tasks WHERE status = 'active'`)
    .all() as V1ScheduledTask[];

  let backfilled = 0;
  for (const t of tasks) {
    if (t.execution_mode === 'host_pipeline') {
      skipped.push(
        `scheduled_tasks: ${t.id} is host_pipeline — skipped (handled by pipeline-tables migrator)`,
      );
      continue;
    }
    if (t.execution_mode !== 'container') {
      skipped.push(`scheduled_tasks: ${t.id} has unknown execution_mode='${t.execution_mode}'`);
      continue;
    }

    const v1Extras: Record<string, unknown> = {};
    for (const col of ST_EXTRA_COLS) {
      const val = t[col];
      if (val !== null && val !== undefined && val !== '') v1Extras[col] = val;
    }
    if (Object.keys(v1Extras).length === 0) continue;

    const ag = v2Db
      .prepare(`SELECT id FROM agent_groups WHERE folder = ?`)
      .get(t.group_folder) as { id: string } | undefined;
    if (!ag) {
      skipped.push(
        `scheduled_tasks: ${t.id} folder=${t.group_folder} has no v2 agent_group — upstream tooling did not seed`,
      );
      continue;
    }

    const sessions = v2Db
      .prepare(`SELECT id FROM sessions WHERE agent_group_id = ?`)
      .all(ag.id) as Array<{ id: string }>;

    let updated = false;
    for (const s of sessions) {
      const inboundPath = path.join(
        path.dirname(v2DbPath),
        'v2-sessions',
        ag.id,
        s.id,
        'inbound.db',
      );
      if (!fs.existsSync(inboundPath)) continue;
      const inbound = new Database(inboundPath);
      try {
        const row = inbound
          .prepare(`SELECT content FROM messages_in WHERE id = ? AND kind = 'task'`)
          .get(t.id) as { content: string } | undefined;
        if (!row) continue;
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        const blob = (parsed.migrated_from_v1 ?? {}) as Record<string, unknown>;
        blob.v1_extras = v1Extras;
        parsed.migrated_from_v1 = blob;
        inbound
          .prepare(`UPDATE messages_in SET content = ? WHERE id = ? AND kind = 'task'`)
          .run(JSON.stringify(parsed), t.id);
        backfilled += 1;
        updated = true;
      } finally {
        inbound.close();
      }
    }
    if (!updated) {
      skipped.push(
        `scheduled_tasks: ${t.id} — no matching messages_in row found in any session for agent_group ${ag.id}`,
      );
    }
  }
  return backfilled;
}

function seedOwnerFromIsMain(
  v1Db: Database.Database,
  v2Db: Database.Database,
  ownerUserId: string | undefined,
  skipped: string[],
): boolean {
  const isMainRows = v1Db
    .prepare(`SELECT jid FROM registered_groups WHERE is_main = 1`)
    .all() as Array<{ jid: string }>;
  if (isMainRows.length === 0) return false;

  if (!ownerUserId) {
    skipped.push(
      `is_main: v1 has ${isMainRows.length} is_main=1 row(s) but NANOCLAW_V1_OWNER_USER_ID env var not set — owner not seeded. Set via env var (format: "<channel>:<handle>", e.g. "slack:U001") or run /init-first-agent post-cutover.`,
    );
    return false;
  }

  const m = /^([^:]+):(.+)$/.exec(ownerUserId);
  if (!m) {
    skipped.push(
      `is_main: ownerUserId="${ownerUserId}" must be "<channel>:<handle>" (e.g. "slack:U001")`,
    );
    return false;
  }
  const [, channel] = m;
  const now = new Date().toISOString();

  v2Db
    .prepare(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
       VALUES (?, ?, NULL, ?)`,
    )
    .run(ownerUserId, channel, now);
  // SQLite treats NULL ≠ NULL in primary keys, so INSERT OR IGNORE doesn't
  // dedupe owner rows where agent_group_id IS NULL. Use an explicit
  // existence check instead.
  const existing = v2Db
    .prepare(
      `SELECT 1 AS one FROM user_roles
        WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL`,
    )
    .get(ownerUserId);
  if (!existing) {
    v2Db
      .prepare(
        `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
         VALUES (?, 'owner', NULL, NULL, ?)`,
      )
      .run(ownerUserId, now);
  }

  return true;
}

function listColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}
