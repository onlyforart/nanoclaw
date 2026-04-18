export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
  model?: string; // Model string (e.g. 'haiku', 'sonnet', 'opus', 'ollama:qwen3'). Defaults to CLI default.
  temperature?: number; // Sampling temperature (0.0–2.0). Ollama only. NULL = use model default.
  maxToolRounds?: number; // Max tool-calling rounds. NULL = use backend default.
  timeoutMs?: number; // Per-invocation timeout in ms. NULL = use backend default.
  showThinking?: boolean; // Send thinking/reasoning to channel. Ollama only. Default: false.
  mode?: 'active' | 'passive' | 'control'; // Default: 'active'
  threadingMode?: 'temporal' | 'thread_aware'; // Default: 'temporal'
  pipelineRepliesBlocked?: boolean; // Block pipeline replies to this channel (for testing). Default: false.
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once' | 'event';
  schedule_value: string;
  fallbackPollMs?: number | null;
  context_mode: 'group' | 'isolated';
  model?: string | null;
  temperature?: number | null;
  timezone?: string | null;
  maxToolRounds?: number | null;
  timeoutMs?: number | null;
  useAgentSdk?: boolean | number | null;
  allowedTools?: string[] | null;
  allowedSendTargets?: string[] | null;
  executionMode?: 'container' | 'host_pipeline';
  subscribedEventTypes?: string[] | null;
  /**
   * Maximum number of events a single invocation may claim via
   * consume_events. The IPC handler caps the LLM-requested limit to
   * this value, enforcing serial per-event processing regardless of
   * what the prompt asks for. NULL = no cap (legacy behaviour).
   */
  batchSize?: number | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cost_usd?: number | null;
}

// --- Event bus ---

export type EventStatus = 'pending' | 'claimed' | 'done' | 'expired' | 'failed';

export interface EventRow {
  id: number;
  type: string;
  source_group: string;
  source_task_id: string | null;
  payload: string; // JSON
  dedupe_key: string | null;
  created_at: string;
  expires_at: string | null;
  status: EventStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  processed_at: string | null;
  result_note: string | null;
}

// --- Observed messages ---

export interface ObservedMessageRow {
  id: number;
  source_chat_jid: string | null;
  source_message_id: string | null;
  source_type: 'passive_channel' | 'task_intake';
  source_task_id: string | null;
  source_group: string | null;
  intake_reason: string | null;
  intake_event_id: number | null;
  thread_id: string | null;
  related_observation_ids: string | null; // JSON array
  raw_text: string;
  sanitised_json: string | null;
  sanitiser_model: string | null;
  sanitiser_version: string | null;
  flags: string | null; // JSON array
  created_at: string;
  sanitised_at: string | null;
}

// --- Pipeline intake ---

export interface IntakeSourceContext {
  source_type: string;
  source_group: string;
  source_task_id?: string;
  source_channel?: string;
  source_message_id?: string;
  reason: string;
}

export interface PipelineIntakeLogRow {
  id: number;
  event_id: number;
  raw_text_hash: string;
  source_type: string;
  source_group: string;
  source_task_id: string | null;
  source_channel: string | null;
  source_message_id: string | null;
  reason: string;
  submitted_at: string;
  processed_at: string | null;
  observation_id: number | null;
}

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(
    jid: string,
    text: string,
    options?: { threadTs?: string },
  ): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: backfill missed messages for passive channels after reconnect.
  backfillPassiveChannels?(
    passiveJids: string[],
    cursors: Record<string, string>,
  ): Promise<void>;
  // Optional: fetch the text content of a specific message. Used by
  // the pipeline approval reacji handler to read draft text from a
  // team-channel message when a 👍 is reacted.
  fetchMessageText?(jid: string, messageId: string): Promise<string | null>;
  // Optional: fetch all replies in a thread. Used by the pipeline
  // post-write delivery verification to confirm our reply landed.
  // Returns null if the channel adapter can't fetch or the thread is
  // empty.
  fetchThreadReplies?(
    jid: string,
    threadTs: string,
  ): Promise<Array<{ ts: string; text: string | null }> | null>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

/**
 * Callback channels invoke when a user adds/removes a reaction. Used
 * for the pipeline approval flow (👍 on a team-channel PROPOSED REPLY
 * draft) and the legacy proposed_reply reacji bridge.
 */
export type OnReaction = (
  chatJid: string,
  reaction: {
    emoji: string;
    userId: string;
    messageId: string;
    chatJid: string;
    timestamp: string;
  },
) => void | Promise<void>;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
