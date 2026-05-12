import type Database from 'better-sqlite3';

/**
 * Apply the full v2 central-DB schema webui queries against, in one call.
 *
 * Mirrors what production sees after these migrations have run:
 *   - src/db/migrations/001-initial.ts (agent_groups, messaging_groups,
 *     messaging_group_agents)
 *   - src/db/migrations/010-engage-modes.ts (engage_mode/engage_pattern/
 *     sender_scope/ignored_message_policy; drops trigger_rules + response_scope)
 *   - src/db/migrations/014-wiring-agent-settings.ts (is_main + 5 per-wiring
 *     setting columns; partial unique index)
 *   - nanoclaw-pipeline/src/migrations.ts (observed_messages,
 *     observation_labels, pipeline_intake_log, pipeline_clusters,
 *     pipeline_passive_subscriptions, pipeline_scheduled_tasks,
 *     pipeline_task_run_logs, pipeline_events; plus pipeline_replies_blocked
 *     column on messaging_group_agents).
 *
 * Webui owns its own SQLite connection — it does NOT import host migrations
 * at runtime. This helper exists so each webui test file can stand up a
 * fresh v2 schema without copy-pasting the table DDL.
 */
export function createV2Schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_groups (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      folder         TEXT NOT NULL UNIQUE,
      agent_provider TEXT,
      created_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messaging_groups (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      UNIQUE(channel_type, platform_id)
    );

    CREATE TABLE IF NOT EXISTS messaging_group_agents (
      id                       TEXT PRIMARY KEY,
      messaging_group_id       TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id           TEXT NOT NULL REFERENCES agent_groups(id),
      session_mode             TEXT DEFAULT 'shared',
      priority                 INTEGER DEFAULT 0,
      created_at               TEXT NOT NULL,
      engage_mode              TEXT,
      engage_pattern           TEXT,
      sender_scope             TEXT,
      ignored_message_policy   TEXT,
      is_main                  INTEGER NOT NULL DEFAULT 0,
      model                    TEXT,
      temperature              REAL,
      max_tool_rounds          INTEGER,
      timeout_ms               INTEGER,
      show_thinking            INTEGER,
      pipeline_replies_blocked INTEGER DEFAULT 0,
      UNIQUE(messaging_group_id, agent_group_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_messaging_group_agents_main
      ON messaging_group_agents (agent_group_id)
      WHERE is_main = 1;

    CREATE TABLE IF NOT EXISTS pipeline_scheduled_tasks (
      id                     TEXT PRIMARY KEY,
      group_folder           TEXT NOT NULL,
      chat_jid               TEXT NOT NULL,
      prompt                 TEXT NOT NULL,
      schedule_type          TEXT NOT NULL,
      schedule_value         TEXT NOT NULL,
      context_mode           TEXT NOT NULL DEFAULT 'isolated',
      model                  TEXT,
      temperature            REAL,
      timezone               TEXT,
      max_tool_rounds        INTEGER,
      timeout_ms             INTEGER,
      use_agent_sdk          INTEGER,
      allowed_tools          TEXT,
      allowed_send_targets   TEXT,
      execution_mode         TEXT NOT NULL DEFAULT 'container',
      subscribed_event_types TEXT,
      fallback_poll_ms       INTEGER,
      next_run               TEXT,
      last_run               TEXT,
      last_result            TEXT,
      status                 TEXT DEFAULT 'active',
      created_at             TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_task_run_logs (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id                     TEXT NOT NULL,
      run_at                      TEXT NOT NULL,
      duration_ms                 INTEGER NOT NULL,
      status                      TEXT NOT NULL,
      result                      TEXT,
      error                       TEXT,
      input_tokens                INTEGER,
      output_tokens               INTEGER,
      cache_read_input_tokens     INTEGER,
      cache_creation_input_tokens INTEGER,
      cost_usd                    REAL,
      FOREIGN KEY (task_id) REFERENCES pipeline_scheduled_tasks(id)
    );

    CREATE TABLE IF NOT EXISTS pipeline_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      type           TEXT NOT NULL,
      source_group   TEXT NOT NULL,
      source_task_id TEXT,
      payload        TEXT NOT NULL,
      dedupe_key     TEXT,
      created_at     TEXT NOT NULL,
      expires_at     TEXT,
      status         TEXT NOT NULL DEFAULT 'pending',
      claimed_by     TEXT,
      claimed_at     TEXT,
      processed_at   TEXT,
      result_note    TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_intake_log (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id          INTEGER NOT NULL,
      raw_text_hash     TEXT NOT NULL,
      source_type       TEXT NOT NULL,
      source_group      TEXT NOT NULL,
      source_task_id    TEXT,
      source_channel    TEXT,
      source_message_id TEXT,
      reason            TEXT NOT NULL,
      submitted_at      TEXT NOT NULL,
      processed_at      TEXT,
      observation_id    INTEGER
    );

    CREATE TABLE IF NOT EXISTS observed_messages (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      source_chat_jid         TEXT,
      source_message_id       TEXT,
      source_type             TEXT NOT NULL DEFAULT 'passive_channel',
      source_task_id          TEXT,
      source_group            TEXT,
      intake_reason           TEXT,
      intake_event_id         INTEGER,
      thread_id               TEXT,
      related_observation_ids TEXT,
      raw_text                TEXT NOT NULL,
      sanitised_json          TEXT,
      sanitiser_model         TEXT,
      sanitiser_version       TEXT,
      flags                   TEXT,
      created_at              TEXT NOT NULL,
      sanitised_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS observation_labels (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id        INTEGER NOT NULL REFERENCES observed_messages(id),
      labeller              TEXT NOT NULL DEFAULT 'human',
      intent                TEXT,
      form                  TEXT,
      imperative_content    TEXT,
      addressee             TEXT,
      embedded_instructions TEXT,
      adversarial_smell     INTEGER,
      notes                 TEXT,
      expected_json         TEXT,
      created_at            TEXT NOT NULL,
      updated_at            TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_clusters (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      source_channel      TEXT NOT NULL,
      cluster_key         TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'active',
      summary             TEXT NOT NULL,
      observation_ids     TEXT NOT NULL,
      observation_count   INTEGER NOT NULL DEFAULT 0,
      last_observation_at TEXT NOT NULL,
      created_at          TEXT NOT NULL,
      updated_at          TEXT NOT NULL,
      resolved_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS pipeline_passive_subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_type TEXT    NOT NULL,
      platform_id  TEXT    NOT NULL,
      cursor       TEXT,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      UNIQUE(channel_type, platform_id)
    );
  `);
}

/**
 * Insert one agent_group + one messaging_group + their wiring in one shot.
 * Convenience for route tests that need a routable folder without seeding
 * the full entity chain.
 *
 * `engagePattern` defaults to '@bot' to mirror v1's typical trigger; pass
 * '.' for an always-respond wiring. `isMain=1` is the default; the unique
 * partial index prevents two is_main=1 wirings under the same agent_group.
 */
export function seedAgentGroupWiring(
  db: Database.Database,
  opts: {
    agentGroupId: string;
    folder: string;
    name: string;
    channelType?: string;
    platformId: string;
    messagingGroupId?: string;
    wiringId?: string;
    engagePattern?: string;
    isMain?: number;
    model?: string | null;
    temperature?: number | null;
    maxToolRounds?: number | null;
    timeoutMs?: number | null;
    showThinking?: number | null;
    sessionMode?: string;
    pipelineRepliesBlocked?: number;
    createdAt?: string;
    agentProvider?: string | null;
  },
): void {
  const now = opts.createdAt ?? '2024-01-01T00:00:00.000Z';
  const channelType = opts.channelType ?? 'slack';
  const messagingGroupId = opts.messagingGroupId ?? `mg-${opts.agentGroupId}`;
  const wiringId = opts.wiringId ?? `wire-${opts.agentGroupId}`;
  const isMain = opts.isMain ?? 1;
  const sessionMode = opts.sessionMode ?? 'shared';

  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.agentGroupId, opts.name, opts.folder, opts.agentProvider ?? null, now);

  db.prepare(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(messagingGroupId, channelType, opts.platformId, opts.name, 1, now);

  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, session_mode, priority, created_at,
        engage_mode, engage_pattern, sender_scope, ignored_message_policy,
        is_main, model, temperature, max_tool_rounds, timeout_ms, show_thinking,
        pipeline_replies_blocked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    wiringId, messagingGroupId, opts.agentGroupId, sessionMode, 0, now,
    'pattern', opts.engagePattern ?? '@bot', 'all', 'drop',
    isMain,
    opts.model ?? null,
    opts.temperature ?? null,
    opts.maxToolRounds ?? null,
    opts.timeoutMs ?? null,
    opts.showThinking ?? null,
    opts.pipelineRepliesBlocked ?? 0,
  );
}
