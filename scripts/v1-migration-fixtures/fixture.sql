-- Fixture v1 store/messages.db — committed, deterministic, no installation-specific identifiers.
-- Schema is verbatim from a real v1 install (post our customisations: is_main columns,
-- pipeline_replies_blocked, threading_mode, mode on registered_groups; the 13 added scheduled_tasks
-- columns; the 5 added task_run_logs columns).
--
-- Sample data covers every v1 table the migrator might touch, plus
-- intentional edge cases:
--   - 1 registered_group with mode='passive' (router_state will carry its sanitiser_cursor).
--   - 2 scheduled_tasks with execution_mode='host_pipeline' (route to pipeline_scheduled_tasks).
--   - task_run_logs rows split across the 30-day Q2=b retention boundary.
--   - 1 chat with channel inferred only from channel_name (jid prefix ambiguous).
--   - Pipeline state: observations, clusters, intake_log, reextraction, cross-channel.
--
-- Used by:
--   - scripts/migrate-v1/build-fixture.ts (test helper — builds an in-memory DB)
--   - scripts/migrate-from-v1.ts dry-run smoke (loads as on-disk fixture)

PRAGMA foreign_keys = OFF;

-- ── Standard v1 tables ─────────────────────────────────────────────────

CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0
);

INSERT INTO chats VALUES
  ('slack:C000ALPHA', 'Alpha', '2025-12-01T00:00:00Z', 'slack', 1),
  ('telegram:-1001', 'Beta',  '2025-12-02T00:00:00Z', 'telegram', 1),
  ('whatsapp:111-222@g.us', 'Gamma', '2025-12-03T00:00:00Z', 'whatsapp', 1);

CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  is_bot_message INTEGER DEFAULT 0,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

INSERT INTO messages VALUES
  ('m1', 'slack:C000ALPHA', 'U001', 'Operator', 'hello',     '2025-12-01T10:00:00Z', 0, 0),
  ('m2', 'slack:C000ALPHA', 'BOT',  'Bot',      'hi back',   '2025-12-01T10:00:05Z', 1, 1),
  ('m3', 'telegram:-1001',  'U002', 'OtherUser','status?',   '2025-12-02T11:00:00Z', 0, 0),
  ('m4', 'whatsapp:111-222@g.us', 'U003', 'Operator', 'gm',  '2025-12-03T12:00:00Z', 0, 0),
  ('m5', 'whatsapp:111-222@g.us', 'BOT',  'Bot',      'gm!',  '2025-12-03T12:00:01Z', 1, 1);

CREATE TABLE registered_groups (
  jid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder TEXT NOT NULL UNIQUE,
  trigger_pattern TEXT NOT NULL,
  added_at TEXT NOT NULL,
  container_config TEXT,
  requires_trigger INTEGER DEFAULT 1
, is_main INTEGER DEFAULT 0
, model TEXT DEFAULT NULL
, max_tool_rounds INTEGER DEFAULT NULL
, timeout_ms INTEGER DEFAULT NULL
, temperature REAL DEFAULT NULL
, show_thinking INTEGER DEFAULT NULL
, mode TEXT NOT NULL DEFAULT 'active'
, threading_mode TEXT NOT NULL DEFAULT 'temporal'
, pipeline_replies_blocked INTEGER DEFAULT 0);

INSERT INTO registered_groups VALUES
  ('slack:C000ALPHA', 'Alpha', 'alpha-folder', '!claw', '2025-11-01T00:00:00Z',
   '{"image":"nanoclaw-agent:latest"}', 1, 1, 'claude-sonnet-4-5', 30, 600000, 0.4, 1,
   'active', 'temporal', 0),
  ('telegram:-1001', 'Beta',  'beta-folder',  '@bot',  '2025-11-02T00:00:00Z',
   NULL, 0, 0, NULL, NULL, NULL, NULL, NULL,
   'active', 'thread', 1),
  ('whatsapp:111-222@g.us', 'Gamma', 'gamma-folder', '',     '2025-11-03T00:00:00Z',
   NULL, 0, 0, NULL, NULL, NULL, NULL, NULL,
   'passive', 'temporal', 0);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
, context_mode TEXT DEFAULT 'isolated'
, model TEXT DEFAULT NULL
, timezone TEXT DEFAULT NULL
, max_tool_rounds INTEGER DEFAULT NULL
, timeout_ms INTEGER DEFAULT NULL
, temperature REAL DEFAULT NULL
, use_agent_sdk INTEGER DEFAULT 0
, allowed_tools TEXT
, allowed_send_targets TEXT
, execution_mode TEXT NOT NULL DEFAULT 'container'
, subscribed_event_types TEXT
, fallback_poll_ms INTEGER DEFAULT NULL
, batch_size INTEGER DEFAULT NULL);

INSERT INTO scheduled_tasks VALUES
  ('task-alpha-daily', 'alpha-folder', 'slack:C000ALPHA', 'daily summary',
   'cron', '0 9 * * *', '2025-12-04T09:00:00Z', '2025-12-03T09:00:00Z',
   'ok', 'active', '2025-11-01T00:00:00Z',
   'isolated', NULL, 'UTC', 50, NULL, NULL, 0, NULL, NULL,
   'container', NULL, NULL, NULL),
  ('task-beta-interval', 'beta-folder', 'telegram:-1001', 'check status',
   'interval', '5m', '2025-12-04T00:05:00Z', '2025-12-04T00:00:00Z',
   'ok', 'active', '2025-11-02T00:00:00Z',
   'isolated', NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL,
   'container', NULL, NULL, NULL),
  ('pipeline:sanitiser', 'gamma-folder', 'whatsapp:111-222@g.us', 'sanitise',
   'interval', '30s', '2025-12-04T00:00:30Z', '2025-12-04T00:00:00Z',
   'ok', 'active', '2025-11-03T00:00:00Z',
   'isolated', NULL, NULL, 100, 600000, NULL, 0, NULL, NULL,
   'host_pipeline', NULL, 30000, 50),
  ('pipeline:trivial-answerer', 'gamma-folder', 'whatsapp:111-222@g.us', 'answer trivial',
   'interval', '15s', '2025-12-04T00:00:15Z', '2025-12-04T00:00:00Z',
   'ok', 'active', '2025-11-03T00:00:00Z',
   'isolated', NULL, NULL, 100, 600000, NULL, 0, NULL, '["candidate.question"]',
   'host_pipeline', '["candidate.question"]', 15000, 10);

CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT
, input_tokens INTEGER
, output_tokens INTEGER
, cost_usd REAL
, cache_read_input_tokens INTEGER
, cache_creation_input_tokens INTEGER,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);

-- Mix of recent (within 30 days) + old (older than 30 days).
-- The cutoff for `pipeline_task_run_logs` import is Q2=b: last 30 days.
-- Insert with absolute dates so tests can drive `now` to a fixed value
-- and assert the split point deterministically.
INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error,
  input_tokens, output_tokens, cost_usd, cache_read_input_tokens, cache_creation_input_tokens) VALUES
  ('task-alpha-daily', '2025-12-03T09:00:00Z', 1200, 'ok',  'done', NULL, 1500, 200, 0.015, 1000, 500),
  ('task-alpha-daily', '2025-12-02T09:00:00Z',  900, 'ok',  'done', NULL, 1400, 180, 0.013, 1000, 400),
  ('task-alpha-daily', '2025-11-15T09:00:00Z',  800, 'ok',  'done', NULL, 1300, 170, 0.012, 1000, 300),
  ('task-alpha-daily', '2025-09-01T09:00:00Z',  700, 'ok',  'done', NULL, 1200, 150, 0.011,  900, 300),
  ('task-beta-interval','2025-12-04T00:00:00Z', 100, 'ok',  'noop', NULL,  100,  10, 0.001,  100, 200),
  ('task-beta-interval','2025-06-01T00:00:00Z', 100, 'err', NULL,   'timeout', 100, 10, 0.001, 100, 200),
  ('pipeline:sanitiser','2025-12-03T00:00:00Z',  500, 'ok',  'done', NULL,  800,  50, 0.005,  500, 200),
  ('pipeline:sanitiser','2025-08-01T00:00:00Z',  500, 'ok',  'done', NULL,  800,  50, 0.005,  500, 200);

CREATE TABLE sessions (
  group_folder TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

INSERT INTO sessions VALUES ('alpha-folder', 'session-uuid-alpha');

CREATE TABLE router_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO router_state VALUES
  ('sanitiser_cursor:whatsapp:111-222@g.us', '2025-12-03T00:00:00Z'),
  ('legacy:misc-key', 'some-value-we-drop'),
  ('legacy:another', 'also-dropped');

-- ── Pipeline tables ────────────────────────────────────────────────────

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  source_group TEXT NOT NULL,
  source_task_id TEXT,
  payload TEXT NOT NULL,
  dedupe_key TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by TEXT,
  claimed_at TEXT,
  processed_at TEXT,
  result_note TEXT
, attempted_by_trivial INTEGER DEFAULT 0
, trivial_failure_reason TEXT
, replied_at TEXT);

INSERT INTO events (type, source_group, source_task_id, payload, dedupe_key, created_at,
  expires_at, status, claimed_by, claimed_at, processed_at, result_note,
  attempted_by_trivial, trivial_failure_reason, replied_at) VALUES
  ('candidate.question', 'gamma-folder', 'pipeline:sanitiser', '{"text":"q1"}', 'd1',
   '2025-12-01T00:00:00Z', NULL, 'processed', 'host', '2025-12-01T00:00:01Z',
   '2025-12-01T00:00:02Z', 'ok', 1, NULL, '2025-12-01T00:00:03Z'),
  ('candidate.question', 'gamma-folder', 'pipeline:sanitiser', '{"text":"q2"}', 'd2',
   '2025-12-02T00:00:00Z', NULL, 'pending', NULL, NULL, NULL, NULL, 0, NULL, NULL),
  ('candidate.observation', 'gamma-folder', 'pipeline:sanitiser', '{"text":"obs"}', 'd3',
   '2025-12-03T00:00:00Z', NULL, 'expired', NULL, NULL, NULL, NULL, 0, 'no-handler', NULL);

CREATE TABLE observed_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_chat_jid TEXT,
  source_message_id TEXT,
  source_type TEXT NOT NULL DEFAULT 'passive_channel',
  source_task_id TEXT,
  source_group TEXT,
  intake_reason TEXT,
  intake_event_id INTEGER,
  thread_id TEXT,
  related_observation_ids TEXT,
  raw_text TEXT NOT NULL,
  sanitised_json TEXT,
  sanitiser_model TEXT,
  sanitiser_version TEXT,
  flags TEXT,
  created_at TEXT NOT NULL,
  sanitised_at TEXT
);

INSERT INTO observed_messages (source_chat_jid, source_message_id, source_type, raw_text,
  sanitised_json, sanitiser_model, sanitiser_version, created_at, sanitised_at) VALUES
  ('whatsapp:111-222@g.us', 'm-100', 'passive_channel', 'observation 1',
   '{"intent":"info"}', 'claude', 'v1', '2025-12-01T00:00:00Z', '2025-12-01T00:00:05Z'),
  ('whatsapp:111-222@g.us', 'm-101', 'passive_channel', 'observation 2',
   '{"intent":"question"}', 'claude', 'v1', '2025-12-02T00:00:00Z', '2025-12-02T00:00:05Z');

CREATE TABLE pipeline_clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_channel TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  summary TEXT NOT NULL,
  observation_ids TEXT NOT NULL,
  observation_count INTEGER NOT NULL DEFAULT 0,
  last_observation_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

INSERT INTO pipeline_clusters (source_channel, cluster_key, status, summary,
  observation_ids, observation_count, last_observation_at, created_at, updated_at) VALUES
  ('whatsapp:111-222@g.us', 'cluster-a', 'active', 'two observations', '[1,2]', 2,
   '2025-12-02T00:00:00Z', '2025-12-01T00:00:00Z', '2025-12-02T00:00:00Z');

CREATE TABLE pipeline_intake_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  raw_text_hash TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_group TEXT NOT NULL,
  source_task_id TEXT,
  source_channel TEXT,
  source_message_id TEXT,
  reason TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  processed_at TEXT,
  observation_id INTEGER
);

CREATE TABLE observation_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observed_messages(id),
  labeller TEXT NOT NULL DEFAULT 'human',
  intent TEXT,
  form TEXT,
  imperative_content TEXT,
  addressee TEXT,
  embedded_instructions TEXT,
  adversarial_smell INTEGER,
  notes TEXT,
  expected_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE reextraction_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  sanitiser_version TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(observation_id, field_name, sanitiser_version)
);

INSERT INTO reextraction_cache (observation_id, field_name, sanitiser_version, result_json, created_at) VALUES
  (1, 'intent', 'v2', '"info"', '2025-12-04T00:00:00Z');

CREATE TABLE cross_channel_deliveries (
  key TEXT PRIMARY KEY,
  delivered_at TEXT NOT NULL
);

INSERT INTO cross_channel_deliveries VALUES
  ('clusterA->slack:C000ALPHA', '2025-12-01T00:00:00Z'),
  ('clusterA->telegram:-1001',  '2025-12-02T00:00:00Z');
