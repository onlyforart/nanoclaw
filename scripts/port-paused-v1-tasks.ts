#!/usr/bin/env node
/**
 * One-shot: port v1 paused tasks into v2 messages_in.
 *
 * The v1→v2 migrator (scripts/migrate-v1/extras-adapter.ts) only ported
 * `status='active'` tasks into v2's per-session messages_in. Paused tasks
 * stayed behind in store/messages.db and disappeared from the v2 webui.
 *
 * This script picks them up:
 *
 *   1. SELECT scheduled_tasks FROM store/messages.db
 *      WHERE status != 'active' AND id NOT LIKE 'pipeline:%'
 *   2. For each row, resolve v2 agent_group_id via group_folder.
 *   3. Locate the agent_group's session inbound.db.
 *   4. INSERT messages_in (kind='task', status from v1) with the same
 *      shape extras-adapter wrote (content JSON carrying migrated_from_v1).
 *   5. Skip if a row with the same id already exists in the session.
 *
 * Idempotent — re-running is safe.
 *
 * Usage:
 *   pnpm tsx scripts/port-paused-v1-tasks.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const V2_DB = path.resolve(process.cwd(), 'data', 'v2.db');
const V1_STORE = path.resolve(process.cwd(), 'store', 'messages.db');
const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'v2-sessions');

const DRY_RUN = process.argv.includes('--dry-run');

function nextEvenSeq(db: Database.Database): number {
  const inSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  // Host writes even seq numbers; container writes odd.
  return inSeq % 2 === 0 ? inSeq + 2 : inSeq + 1;
}

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  context_mode: string | null;
  model: string | null;
  temperature: number | null;
  max_tool_rounds: number | null;
  timeout_ms: number | null;
  use_agent_sdk: number | null;
  allowed_tools: string | null;
  allowed_send_targets: string | null;
  subscribed_event_types: string | null;
  fallback_poll_ms: number | null;
  next_run: string | null;
  status: string;
  created_at: string;
}

if (!fs.existsSync(V1_STORE)) {
  console.error(`No v1 store at ${V1_STORE} — nothing to port.`);
  process.exit(0);
}
if (!fs.existsSync(V2_DB)) {
  console.error(`No v2 DB at ${V2_DB}.`);
  process.exit(1);
}

const v1 = new Database(V1_STORE, { readonly: true });
const v2 = new Database(V2_DB);

const v1tasks = v1
  .prepare(
    `SELECT id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
            context_mode, model, temperature, max_tool_rounds, timeout_ms,
            use_agent_sdk, allowed_tools, allowed_send_targets,
            subscribed_event_types, fallback_poll_ms, next_run, status, created_at
     FROM scheduled_tasks
     WHERE status != 'active' AND id NOT LIKE 'pipeline:%'`,
  )
  .all() as V1Task[];

console.log(`Found ${v1tasks.length} non-active v1 task(s) to consider.`);

interface PortResult {
  task_id: string;
  group_folder: string;
  action: 'inserted' | 'already-present' | 'skipped';
  reason?: string;
}
const results: PortResult[] = [];

for (const t of v1tasks) {
  const ag = v2
    .prepare('SELECT id FROM agent_groups WHERE folder = ?')
    .get(t.group_folder) as { id: string } | undefined;
  if (!ag) {
    results.push({
      task_id: t.id,
      group_folder: t.group_folder,
      action: 'skipped',
      reason: `no agent_group for folder=${t.group_folder}`,
    });
    continue;
  }

  // Resolve the (single) session for this agent group.
  const sessions = v2
    .prepare('SELECT id FROM sessions WHERE agent_group_id = ?')
    .all(ag.id) as Array<{ id: string }>;
  if (sessions.length === 0) {
    results.push({
      task_id: t.id,
      group_folder: t.group_folder,
      action: 'skipped',
      reason: 'no v2 session for agent_group',
    });
    continue;
  }
  // If multiple sessions exist, prefer one with an existing inbound.db.
  let sessionId: string | undefined;
  let inboundPath: string | undefined;
  for (const s of sessions) {
    const p = path.join(SESSIONS_DIR, ag.id, s.id, 'inbound.db');
    if (fs.existsSync(p)) {
      sessionId = s.id;
      inboundPath = p;
      break;
    }
  }
  if (!inboundPath || !sessionId) {
    results.push({
      task_id: t.id,
      group_folder: t.group_folder,
      action: 'skipped',
      reason: 'no on-disk inbound.db for any session',
    });
    continue;
  }

  // Resolve channel routing from the agent_group's main wiring.
  const mainChat = v2
    .prepare(
      `SELECT mg.channel_type, mg.platform_id
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
       WHERE mga.agent_group_id = ? AND mga.is_main = 1
       LIMIT 1`,
    )
    .get(ag.id) as { channel_type?: string; platform_id?: string } | undefined;
  // Fallback: any wiring at all.
  const anyChat = mainChat
    ? mainChat
    : (v2
        .prepare(
          `SELECT mg.channel_type, mg.platform_id
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
           WHERE mga.agent_group_id = ?
           LIMIT 1`,
        )
        .get(ag.id) as { channel_type?: string; platform_id?: string } | undefined);

  const inbound = new Database(inboundPath);
  try {
    const exists = inbound
      .prepare(`SELECT 1 FROM messages_in WHERE id = ? AND kind = 'task'`)
      .get(t.id);
    if (exists) {
      results.push({ task_id: t.id, group_folder: t.group_folder, action: 'already-present' });
      continue;
    }

    // Build content JSON in the same shape extras-adapter wrote for active
    // tasks (so the webui's existing parser doesn't need to know about the
    // paused source).
    const content = {
      prompt: t.prompt,
      script: null as string | null,
      migrated_from_v1: {
        original_id: t.id,
        context_mode: t.context_mode ?? 'isolated',
        v1_extras: {
          ...(t.model && String(t.model).trim() ? { model: t.model } : {}),
          ...(t.use_agent_sdk != null && t.use_agent_sdk !== 0
            ? { use_agent_sdk: t.use_agent_sdk }
            : { use_agent_sdk: t.use_agent_sdk ?? 0 }),
          ...(t.temperature != null ? { temperature: t.temperature } : {}),
          ...(t.max_tool_rounds != null ? { max_tool_rounds: t.max_tool_rounds } : {}),
          ...(t.timeout_ms != null && String(t.timeout_ms).trim() !== ''
            ? { timeout_ms: t.timeout_ms }
            : {}),
          ...(t.allowed_tools && String(t.allowed_tools).trim()
            ? { allowed_tools: t.allowed_tools }
            : {}),
          ...(t.allowed_send_targets && String(t.allowed_send_targets).trim()
            ? { allowed_send_targets: t.allowed_send_targets }
            : {}),
          ...(t.subscribed_event_types && String(t.subscribed_event_types).trim()
            ? { subscribed_event_types: t.subscribed_event_types }
            : {}),
          ...(t.fallback_poll_ms != null ? { fallback_poll_ms: t.fallback_poll_ms } : {}),
          // Carry status so a future activation step knows the origin.
          v1_status: t.status,
        },
      },
    };

    const recurrence =
      t.schedule_type === 'cron' || t.schedule_type === 'every' ? t.schedule_value : null;
    const processAfter = t.next_run ?? new Date().toISOString();

    if (DRY_RUN) {
      results.push({
        task_id: t.id,
        group_folder: t.group_folder,
        action: 'inserted',
        reason: 'dry-run',
      });
      continue;
    }

    const seq = nextEvenSeq(inbound);
    const modelStr =
      typeof t.model === 'string' && t.model.trim() ? t.model.trim() : null;
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, timestamp, status, tries, process_after, recurrence, kind,
            platform_id, channel_type, thread_id, content, series_id, model, use_agent_sdk, trigger)
         VALUES (@id, @seq, @ts, @status, 0, @processAfter, @recurrence, 'task',
                 @platformId, @channelType, NULL, @content, @id, @model, @useAgentSdk, 1)`,
      )
      .run({
        id: t.id,
        seq,
        ts: t.created_at,
        status: t.status, // preserve paused/disabled
        processAfter,
        recurrence,
        platformId: anyChat?.platform_id ?? t.chat_jid,
        channelType: anyChat?.channel_type ?? 'slack',
        content: JSON.stringify(content),
        model: modelStr,
        useAgentSdk: t.use_agent_sdk ?? 0,
      });
    results.push({ task_id: t.id, group_folder: t.group_folder, action: 'inserted' });
  } finally {
    inbound.close();
  }
}

v1.close();
v2.close();

const summary = results.reduce(
  (acc, r) => {
    acc[r.action] = (acc[r.action] ?? 0) + 1;
    return acc;
  },
  {} as Record<string, number>,
);
console.log(`\nSummary: ${JSON.stringify(summary)}`);
for (const r of results) {
  const tag = r.action.padEnd(15);
  console.log(`  ${tag} ${r.task_id}  (${r.group_folder})${r.reason ? '  — ' + r.reason : ''}`);
}
if (DRY_RUN) console.log('\n(dry-run — no rows written)');
