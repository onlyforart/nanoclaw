/**
 * Plugin host helper: composite agent-group bootstrap.
 *
 * Plugins (the observation pipeline in particular, §4.5 step 14 C4)
 * need to install dedicated agent groups for their internal tasks
 * (monitor, solver, responder). The bootstrap involves four DB
 * inserts plus filesystem init — bundled here behind a single host
 * API surface so plugins don't reach around `PluginHostApi` to call
 * the underlying entity creators directly.
 *
 * Idempotent: re-running with the same agentGroupId is a no-op
 * (existing rows are returned without changes). Filesystem init is
 * gated per-step by `initGroupFilesystem`'s own existence checks.
 */
import { createAgentGroup, getAgentGroup } from './db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupByPlatform,
} from './db/messaging-groups.js';
import { createSession, findSessionForAgent } from './db/sessions.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import { initSessionFolder } from './session-manager.js';
import type {
  AgentGroup,
  EngageMode,
  IgnoredMessagePolicy,
  MessagingGroup,
  SenderScope,
  Session,
  UnknownSenderPolicy,
} from './types.js';

export interface BootstrapAgentGroupInput {
  /** Stable id (e.g. `"pipeline-monitor"`). Reused across restarts. */
  agentGroupId: string;
  /** Human-readable name shown in logs / UI. */
  name: string;
  /** Filesystem folder under `groups/` (e.g. `"pipeline-monitor"`). */
  folder: string;
  /** Initial CLAUDE.local.md contents (the agent's per-group memory seed). */
  claudeLocalMd?: string;
  /** Synthetic messaging-group identifier — bootstrap creates one if missing. */
  messagingGroup: {
    id: string;
    channelType: string;
    platformId: string;
    name?: string | null;
    isGroup?: 0 | 1;
    unknownSenderPolicy?: UnknownSenderPolicy;
  };
  /** Wiring policy for messaging_group_agents. */
  wiring: {
    id: string;
    engageMode?: EngageMode;
    engagePattern?: string | null;
    senderScope?: SenderScope;
    ignoredMessagePolicy?: IgnoredMessagePolicy;
    sessionMode?: 'shared' | 'per-thread' | 'agent-shared';
    priority?: number;
  };
  /** Stable session id (e.g. `"sess-pipeline-monitor"`). */
  sessionId: string;
  /** Optional agent provider override — defaults to null (uses host default). */
  agentProvider?: string | null;
}

export interface BootstrapAgentGroupResult {
  agentGroup: AgentGroup;
  messagingGroup: MessagingGroup;
  session: Session;
}

/**
 * Compose: agent_groups + filesystem + messaging_groups +
 * messaging_group_agents + sessions in one shot. Each underlying
 * creator is idempotent (gated on existing-row lookup) so the
 * bootstrap is safe to re-run on every plugin onStartup.
 */
export function bootstrapAgentGroup(input: BootstrapAgentGroupInput): BootstrapAgentGroupResult {
  const now = new Date().toISOString();

  // 1. agent_groups row
  let agentGroup = getAgentGroup(input.agentGroupId);
  if (!agentGroup) {
    agentGroup = {
      id: input.agentGroupId,
      name: input.name,
      folder: input.folder,
      agent_provider: input.agentProvider ?? null,
      created_at: now,
    };
    createAgentGroup(agentGroup);
    log.info('plugin-bootstrap: agent_groups row created', {
      agentGroupId: input.agentGroupId,
      folder: input.folder,
    });
  }

  // 2. filesystem (idempotent on every step)
  initGroupFilesystem(agentGroup, { instructions: input.claudeLocalMd });

  // 3. messaging_groups row — idempotent via getMessagingGroup
  let messagingGroup = getMessagingGroup(input.messagingGroup.id);
  if (!messagingGroup) {
    // Belt-and-braces: also check the (channel_type, platform_id)
    // UNIQUE so a re-bootstrap with a different id but same platform
    // doesn't fail with a constraint violation.
    messagingGroup =
      getMessagingGroupByPlatform(input.messagingGroup.channelType, input.messagingGroup.platformId) ?? undefined;
  }
  if (!messagingGroup) {
    messagingGroup = {
      id: input.messagingGroup.id,
      channel_type: input.messagingGroup.channelType,
      platform_id: input.messagingGroup.platformId,
      name: input.messagingGroup.name ?? input.name,
      is_group: input.messagingGroup.isGroup ?? 0,
      unknown_sender_policy: input.messagingGroup.unknownSenderPolicy ?? 'strict',
      created_at: now,
    };
    createMessagingGroup(messagingGroup);
    log.info('plugin-bootstrap: messaging_groups row created', {
      messagingGroupId: messagingGroup.id,
      channelType: messagingGroup.channel_type,
      platformId: messagingGroup.platform_id,
    });
  }

  // 4. messaging_group_agents wiring — idempotent via session-find:
  //    if the session already exists with this agent_group + mg, the
  //    wiring already exists too. Otherwise create the wiring row.
  let session = findSessionForAgent(input.agentGroupId, messagingGroup.id, null);
  if (!session) {
    try {
      createMessagingGroupAgent({
        id: input.wiring.id,
        messaging_group_id: messagingGroup.id,
        agent_group_id: input.agentGroupId,
        engage_mode: input.wiring.engageMode ?? 'pattern',
        engage_pattern: input.wiring.engagePattern ?? '.',
        sender_scope: input.wiring.senderScope ?? 'all',
        ignored_message_policy: input.wiring.ignoredMessagePolicy ?? 'drop',
        session_mode: input.wiring.sessionMode ?? 'shared',
        priority: input.wiring.priority ?? 0,
        created_at: now,
      });
      log.info('plugin-bootstrap: messaging_group_agents wiring created', {
        wiringId: input.wiring.id,
        messagingGroupId: messagingGroup.id,
        agentGroupId: input.agentGroupId,
      });
    } catch (err) {
      // Could be a UNIQUE violation on (messaging_group_id,
      // agent_group_id) from a partial prior bootstrap. Tolerate; the
      // session creation below will reuse whatever wiring exists.
      log.debug('plugin-bootstrap: wiring insert skipped (likely already present)', {
        wiringId: input.wiring.id,
        err,
      });
    }

    // 5. sessions row
    session = {
      id: input.sessionId,
      agent_group_id: input.agentGroupId,
      messaging_group_id: messagingGroup.id,
      thread_id: null,
      agent_provider: input.agentProvider ?? null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now,
    };
    createSession(session);
    log.info('plugin-bootstrap: sessions row created', {
      sessionId: session.id,
      agentGroupId: input.agentGroupId,
      messagingGroupId: messagingGroup.id,
    });
  }

  // Initialize the on-disk session folder + inbound/outbound DBs.
  // resolveSession() does this for chat-driven sessions; plugin-bootstrap
  // needs to mirror it so plugin-created sessions (pipeline-monitor,
  // pipeline-solver, ...) are immediately usable by writeSessionMessage
  // and by subsequent container spawns. Idempotent — re-creates nothing.
  initSessionFolder(input.agentGroupId, session.id);

  return { agentGroup, messagingGroup, session };
}
