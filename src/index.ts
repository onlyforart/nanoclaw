import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  MCP_PROXY_PORT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import { startMcpAuthProxy } from './mcp-auth-proxy.js';
import { loadPolicies, type PolicyAssignments } from './mcp-policy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import { isOllamaModel, resolveProfile } from './connection-profiles.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  execMigrationSql,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getEventPayloadById,
  getMessagesSince,
  getNewMessages,
  getPassiveGroups,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  updateRegisteredGroup,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { loadPlugin } from './pipeline-plugin.js';
import {
  handleReaction,
  findPendingEditRequest,
  completeEditFlow,
  type Reaction,
} from './reaction-bridge.js';
import {
  handlePipelineApprovalReaction,
  parseApprovalTimeoutMs,
  parseApproverList,
} from './pipeline-approval.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );

  // Refresh available_groups.json for all groups so cross-channel
  // messaging can resolve the new group immediately
  refreshAllGroupSnapshots();
}

/**
 * Refresh available_groups.json for all registered groups.
 * Called on startup and whenever the group registry changes.
 */
function refreshAllGroupSnapshots(): void {
  const availableGroups = getAvailableGroups();
  const registeredJids = new Set(Object.keys(registeredGroups));
  for (const group of Object.values(registeredGroups)) {
    writeGroupsSnapshot(
      group.folder,
      group.isMain === true,
      availableGroups,
      registeredJids,
    );
  }
}

/**
 * Refresh current_tasks.json for all registered groups.
 * Called on startup and whenever tasks are created, updated, or deleted.
 */
function refreshAllTaskSnapshots(): void {
  const tasks = getAllTasks().map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    timezone: t.timezone,
    status: t.status,
    next_run: t.next_run,
    model: t.model,
  }));
  for (const group of Object.values(registeredGroups)) {
    writeTasksSnapshot(group.folder, group.isMain === true, tasks);
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));
  const seenJids = new Set<string>();

  const groups = chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => {
      seenJids.add(c.jid);
      return {
        jid: c.jid,
        name: c.name,
        lastActivity: c.last_message_time,
        isRegistered: registeredJids.has(c.jid),
      };
    });

  // Include registered groups not yet in the chats table
  // (e.g. channels the bot is in but has never received messages from)
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!seenJids.has(jid)) {
      groups.push({
        jid,
        name: group.name,
        lastActivity: group.added_at,
        isRegistered: true,
      });
    }
  }

  return groups;
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  // Passive groups capture messages but never invoke the agent
  if (group.mode === 'passive') return true;

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid, `idle-timeout: ${group.name}`);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        const prefixed =
          !outputSentToUser && !isOllamaModel(group.model)
            ? `:cloud: ${text}`
            : text;
        await channel.sendMessage(chatJid, prefixed);
        outputSentToUser = true;
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      timezone: t.timezone,
      status: t.status,
      next_run: t.next_run,
      model: t.model,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  const profile = resolveProfile(group.model, {
    maxToolRounds: group.maxToolRounds,
    timeoutMs: group.timeoutMs,
  });

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: group.model || undefined,
        temperature: group.temperature,
        maxToolRounds: profile.maxToolRounds,
        timeoutMs: profile.timeoutMs,
        showThinking: group.showThinking,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          // Passive groups capture messages but never invoke the agent
          if (group.mode === 'passive') continue;

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Always queue — never pipe into an active container.
          // The message will be processed after the current container
          // (task or message) finishes, before the next scheduled task.
          queue.enqueueMessageCheck(chatJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Load pipeline plugin (null when not installed — all hooks are no-ops)
  const plugin = await loadPlugin();

  // Run plugin migrations (idempotent CREATE TABLE IF NOT EXISTS, ALTER TABLE)
  if (plugin?.migrations) {
    for (const sql of plugin.migrations()) {
      execMigrationSql(sql);
    }
  }

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Start MCP authorization proxy if any remote servers have proxy: true
  let mcpProxyServer: import('http').Server | null = null;
  const mcpConfigPath = path.join(DATA_DIR, 'mcp-servers.json');
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const upstreams = new Map<string, string>();
      const assignments = new Map<string, PolicyAssignments>();

      for (const [name, srv] of Object.entries(mcpConfig.servers || {})) {
        const server = srv as {
          url?: string;
          proxy?: boolean;
          policies?: { default?: string; groups?: Record<string, string> };
        };
        if (server.url && server.proxy) {
          upstreams.set(name, server.url);
          if (server.policies) {
            assignments.set(name, {
              defaultTier: server.policies.default,
              groups: server.policies.groups || {},
            });
          }
        }
      }

      if (upstreams.size > 0) {
        const policies = loadPolicies(path.join(DATA_DIR, 'mcp-policies'));
        const result = await startMcpAuthProxy(
          MCP_PROXY_PORT,
          PROXY_BIND_HOST,
          {
            upstreams,
            policies,
            assignments,
          },
        );
        mcpProxyServer = result.server;
        logger.info(
          { port: result.port, servers: [...upstreams.keys()] },
          'MCP authorization proxy started for proxied servers',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to start MCP authorization proxy');
    }
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    if (mcpProxyServer) mcpProxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      // Passive channels are always exempt; plugin can bypass for additional reasons
      const groupForAllowlist = registeredGroups[chatJid];
      if (
        !msg.is_from_me &&
        !msg.is_bot_message &&
        groupForAllowlist &&
        groupForAllowlist.mode !== 'passive' &&
        !plugin?.shouldBypassSenderAllowlist?.(groupForAllowlist)
      ) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      // Edit flow intercept: if this user has a pending edit_requested event
      // in this channel, consume the message as the edited reply text.
      const editEvent = findPendingEditRequest(chatJid, msg.sender);
      if (editEvent) {
        completeEditFlow(editEvent, msg.content);
        return; // consumed — don't store or forward to agent
      }

      storeMessage(msg);
    },
    onReaction: async (chatJid: string, reaction: Reaction) => {
      // Phase F5b: try the pipeline approval path first. If the reacted
      // message is a PROPOSED REPLY draft, this handler publishes the
      // approved text to the source thread and marks the reaction
      // consumed. Falls through to the legacy proposed_reply/edit flow
      // otherwise.
      const channel = channels.find((c) => c.ownsJid(chatJid));
      if (channel?.fetchMessageText) {
        try {
          const handled = await handlePipelineApprovalReaction(reaction, {
            sendMessage: (jid, text, options) =>
              channel.sendMessage(jid, text, options),
            fetchMessageText: (jid, messageId) =>
              channel.fetchMessageText!(jid, messageId),
            registeredGroups,
            getEventPayloadById,
            approverUserIds: parseApproverList(
              process.env.PIPELINE_APPROVER_USER_IDS,
            ),
            approvalTimeoutMs: parseApprovalTimeoutMs(
              process.env.PIPELINE_APPROVAL_TIMEOUT_MS,
            ),
          });
          if (handled) return;
        } catch (err) {
          logger.warn(
            { err, chatJid, messageId: reaction.messageId },
            'Pipeline approval reaction handler threw; falling through',
          );
        }
      }
      handleReaction(reaction);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Verify sender allowlist exists — this is a critical security control
  const allowlistCheck = loadSenderAllowlist();
  if (allowlistCheck.default.allow === '*') {
    logger.fatal(
      'SECURITY: sender-allowlist.json is missing or has allow:"*" default. ' +
        'All senders will be accepted. Create ~/.config/nanoclaw/sender-allowlist.json ' +
        'with an explicit allow list. Refusing to start.',
    );
    process.exit(1);
  }

  // Write initial snapshots for all groups so containers have fresh data
  refreshAllGroupSnapshots();
  refreshAllTaskSnapshots();

  // Backfill missed messages for passive channels (plugin-managed)
  if (plugin?.onStartupBackfill) {
    const passiveGroups = getPassiveGroups();
    if (passiveGroups.length > 0) {
      const passiveJids = passiveGroups.map((g) => g.jid);
      const cursors: Record<string, string> = {};
      for (const g of passiveGroups) {
        const cursor = getRouterState(`sanitiser_cursor:${g.jid}`);
        if (cursor) cursors[g.jid] = cursor;
      }
      if (Object.keys(cursors).length > 0) {
        plugin
          .onStartupBackfill(channels, passiveJids, cursors)
          .catch((err) =>
            logger.warn({ err }, 'Plugin startup backfill failed'),
          );
      }
    }
  }

  // Periodically reload group settings from DB so changes made by the web UI
  // (a separate process that writes directly to SQLite) are picked up without
  // requiring an orchestrator restart.
  setInterval(() => {
    registeredGroups = getAllRegisteredGroups();
  }, 60_000);

  // Plugin startup hook (e.g. reconcile pipeline tasks from YAML specs)
  plugin?.onStartup?.();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder, true),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
    plugin,
  });
  startIpcWatcher({
    sendMessage: (jid, text, options) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text, options);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    updateGroup: (jid, updates) => {
      const group = registeredGroups[jid];
      if (!group) return;
      if (updates.model !== undefined) {
        group.model = updates.model;
      }
      updateRegisteredGroup(jid, updates);
      setRegisteredGroup(jid, group);
      logger.info({ jid, updates }, 'Group updated');
    },
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    refreshAllGroupSnapshots,
    refreshAllTaskSnapshots,
    plugin,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
