import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, IPC_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ackEvent,
  consumeEvents,
  createTask,
  deleteTask,
  getTaskById,
  insertIntakeLog,
  publishEvent,
  readChatMessages,
  updateRegisteredGroup,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { IntakeSourceContext, RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  updateGroup: (
    jid: string,
    updates: Partial<
      Pick<
        RegisteredGroup,
        'model' | 'temperature' | 'maxToolRounds' | 'timeoutMs'
      >
    >,
  ) => void;
  syncGroups: (force: boolean) => Promise<void>;
  refreshAllGroupSnapshots: () => void;
  refreshAllTaskSnapshots: () => void;
}

interface IpcResult {
  success: boolean;
  error?: string;
}

function writeIpcResult(resultPath: string, result: IpcResult): void {
  try {
    const tempPath = `${resultPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(result));
    fs.renameSync(tempPath, resultPath);
  } catch (err) {
    logger.error({ err, resultPath }, 'Failed to write IPC result file');
  }
}

let ipcWatcherRunning = false;

// --- IPC delivery dedup tracking ---
// Tracks recent IPC message deliveries per chatJid+content so the task
// scheduler can skip forwarding the container result when the agent already
// sent the same content via send_message IPC. Stores a hash of the text
// to avoid keeping full message content in memory.
import crypto from 'crypto';

const DEFAULT_DEDUP_TTL_MS = 120_000; // 2 minutes

interface DeliveryEntry {
  textHash: string;
  timestamp: number;
}

// chatJid → list of recent deliveries (multiple messages per group possible)
const recentDeliveries = new Map<string, DeliveryEntry[]>();

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Record that an IPC message was just delivered for this chatJid. */
export function recordIpcDelivery(chatJid: string, text: string): void {
  const entries = recentDeliveries.get(chatJid) ?? [];
  entries.push({ textHash: hashText(text), timestamp: Date.now() });
  recentDeliveries.set(chatJid, entries);
}

/** Check if an IPC message with this exact text was delivered for chatJid within ttlMs. */
export function hasRecentIpcDelivery(
  chatJid: string,
  text: string,
  ttlMs: number = DEFAULT_DEDUP_TTL_MS,
): boolean {
  const entries = recentDeliveries.get(chatJid);
  if (!entries) return false;
  const now = Date.now();
  const targetHash = hashText(text);
  // Prune expired entries while checking
  const valid = entries.filter((e) => now - e.timestamp < ttlMs);
  recentDeliveries.set(chatJid, valid);
  return valid.some((e) => e.textHash === targetHash);
}

/** Reset singleton guard and delivery tracking — test-only. */
export function _resetIpcWatcherForTests(): void {
  ipcWatcherRunning = false;
  recentDeliveries.clear();
}

/** Reset delivery tracking only — test-only. */
export function _resetIpcDeliveriesForTests(): void {
  recentDeliveries.clear();
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.sendMessage(data.chatJid, data.text);
                  recordIpcDelivery(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              } else if (
                data.type === 'cross_channel_message' &&
                data.targetChatJid &&
                data.text
              ) {
                // Cross-channel: any group can send to any registered group
                const targetGroup = registeredGroups[data.targetChatJid];
                if (targetGroup) {
                  await deps.sendMessage(data.targetChatJid, data.text);
                  logger.info(
                    {
                      targetChatJid: data.targetChatJid,
                      targetFolder: targetGroup.folder,
                      sourceGroup,
                    },
                    'Cross-channel IPC message sent',
                  );
                } else {
                  logger.warn(
                    { targetChatJid: data.targetChatJid, sourceGroup },
                    'Cross-channel message blocked: target group not registered',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              const result = await processTaskIpc(
                data,
                sourceGroup,
                isMain,
                deps,
              );
              fs.unlinkSync(filePath);
              // Write result file for container to poll
              writeIpcResult(path.join(tasksDir, `${file}.result`), result);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              writeIpcResult(path.join(tasksDir, `${file}.result`), {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IpcData = Record<string, any>;

/**
 * Find a task by ID and verify the caller is authorized to modify it.
 * Returns the task on success, or an IpcResult error.
 */
function findAndAuthorizeTask(
  taskId: string | undefined,
  sourceGroup: string,
  isMain: boolean,
  action: string,
): { task: ReturnType<typeof getTaskById> } | IpcResult {
  if (!taskId) return { success: false, error: 'Missing task_id' };
  const task = getTaskById(taskId);
  if (!task) {
    logger.warn({ taskId, sourceGroup }, `Task not found for ${action}`);
    return { success: false, error: `Task not found: ${taskId}` };
  }
  if (!isMain && task.group_folder !== sourceGroup) {
    logger.warn({ taskId, sourceGroup }, `Unauthorized task ${action} attempt`);
    return { success: false, error: `Not authorized to ${action} this task` };
  }
  return { task };
}

function fail(error: string): IpcResult {
  return { success: false, error };
}

function ok(): IpcResult {
  return { success: true };
}

/**
 * Compute next_run from a schedule type/value/timezone.
 * Returns the ISO string on success, or an IpcResult error.
 */
function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
  timezone: string | null,
): string | IpcResult {
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: timezone ?? TIMEZONE,
      });
      return interval.next().toISOString()!;
    } catch {
      return fail(`Invalid cron expression: ${scheduleValue}`);
    }
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) return fail(`Invalid interval: ${scheduleValue}`);
    return new Date(Date.now() + ms).toISOString();
  }
  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime()))
      return fail(`Invalid timestamp: ${scheduleValue}`);
    return date.toISOString();
  }
  return fail(`Unknown schedule type: ${scheduleType}`);
}

// --- Individual IPC handlers ---

function handleScheduleTask(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
): IpcResult {
  // Defense-in-depth: reject task creation from scheduled task runs
  if (data.fromScheduledTask) {
    logger.warn(
      { sourceGroup },
      'Blocked schedule_task from scheduled task run',
    );
    return fail('Scheduled tasks cannot create new tasks');
  }

  if (
    !data.prompt ||
    !data.schedule_type ||
    !data.schedule_value ||
    !data.targetJid
  ) {
    return fail(
      'Missing required fields: prompt, schedule_type, schedule_value, or targetJid',
    );
  }

  const targetGroupEntry = registeredGroups[data.targetJid];
  if (!targetGroupEntry) return fail('Target group not registered');

  const targetFolder = targetGroupEntry.folder;
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized schedule_task attempt blocked',
    );
    return fail('Not authorized to schedule tasks for other groups');
  }

  const taskTimezone = data.timezone || null;
  const nextRunOrError = computeNextRun(
    data.schedule_type,
    data.schedule_value,
    taskTimezone,
  );
  if (typeof nextRunOrError !== 'string') return nextRunOrError;

  const taskId =
    data.taskId ||
    `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const contextMode =
    data.context_mode === 'group' || data.context_mode === 'isolated'
      ? data.context_mode
      : 'isolated';

  // Inherit model and temperature from group if not explicitly set on the task
  const taskModel = data.model || targetGroupEntry.model || null;
  const taskTemperature =
    data.temperature ?? targetGroupEntry.temperature ?? null;

  createTask({
    id: taskId,
    group_folder: targetFolder,
    chat_jid: data.targetJid,
    prompt: data.prompt,
    schedule_type: data.schedule_type as 'cron' | 'interval' | 'once',
    schedule_value: data.schedule_value,
    context_mode: contextMode,
    model: taskModel,
    temperature: taskTemperature,
    timezone: taskTimezone,
    maxToolRounds: data.maxToolRounds ?? null,
    timeoutMs: data.timeoutMs ?? null,
    useAgentSdk: data.useAgentSdk ? true : false,
    next_run: nextRunOrError,
    status: 'active',
    created_at: new Date().toISOString(),
  });
  logger.info(
    { taskId, sourceGroup, targetFolder, contextMode, model: taskModel },
    'Task created via IPC',
  );
  return ok();
}

function handleTaskStatusChange(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
  action: 'pause' | 'resume' | 'cancel',
): IpcResult {
  const authResult = findAndAuthorizeTask(
    data.taskId,
    sourceGroup,
    isMain,
    action,
  );
  if (!('task' in authResult)) return authResult;

  if (action === 'cancel') {
    deleteTask(data.taskId);
  } else {
    updateTask(data.taskId, {
      status: action === 'pause' ? 'paused' : 'active',
    });
  }
  logger.info({ taskId: data.taskId, sourceGroup }, `Task ${action}d via IPC`);
  return ok();
}

function handleUpdateTask(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
): IpcResult {
  const authResult = findAndAuthorizeTask(
    data.taskId,
    sourceGroup,
    isMain,
    'update',
  );
  if (!('task' in authResult)) return authResult;
  const { task } = authResult;

  const updates: Parameters<typeof updateTask>[1] = {};
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.schedule_type !== undefined)
    updates.schedule_type = data.schedule_type as 'cron' | 'interval' | 'once';
  if (data.schedule_value !== undefined)
    updates.schedule_value = data.schedule_value;
  if (data.model !== undefined) updates.model = data.model || null;
  if (data.temperature !== undefined)
    updates.temperature = data.temperature ?? null;
  if (data.timezone !== undefined) updates.timezone = data.timezone || null;
  if (data.maxToolRounds !== undefined)
    updates.maxToolRounds = data.maxToolRounds ?? null;
  if (data.timeoutMs !== undefined) updates.timeoutMs = data.timeoutMs ?? null;
  if (data.useAgentSdk !== undefined)
    updates.useAgentSdk = data.useAgentSdk ? true : false;

  // Recompute next_run if schedule or timezone changed
  if (
    data.schedule_type ||
    data.schedule_value ||
    data.timezone !== undefined
  ) {
    const merged = { ...task, ...updates };
    const nextRunOrError = computeNextRun(
      merged.schedule_type!,
      merged.schedule_value!,
      merged.timezone ?? null,
    );
    if (typeof nextRunOrError !== 'string') return nextRunOrError;
    updates.next_run = nextRunOrError;
  }

  updateTask(data.taskId, updates);
  logger.info(
    { taskId: data.taskId, sourceGroup, updates },
    'Task updated via IPC',
  );
  return ok();
}

async function handleRefreshGroups(
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<IpcResult> {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized refresh_groups attempt blocked');
    return fail('Not authorized');
  }
  logger.info({ sourceGroup }, 'Group metadata refresh requested via IPC');
  await deps.syncGroups(true);
  deps.refreshAllGroupSnapshots();
  return ok();
}

function handleRegisterGroup(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): IpcResult {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
    return fail('Not authorized');
  }
  if (!data.jid || !data.name || !data.folder || !data.trigger) {
    logger.warn(
      { data },
      'Invalid register_group request - missing required fields',
    );
    return fail('Missing required fields');
  }
  if (!isValidGroupFolder(data.folder)) {
    logger.warn(
      { sourceGroup, folder: data.folder },
      'Invalid register_group request - unsafe folder name',
    );
    return fail('Invalid folder name');
  }
  deps.registerGroup(data.jid, {
    name: data.name,
    folder: data.folder,
    trigger: data.trigger,
    added_at: new Date().toISOString(),
    containerConfig: data.containerConfig,
    requiresTrigger: data.requiresTrigger,
    model: data.model || undefined,
    temperature: data.temperature,
    maxToolRounds: data.maxToolRounds,
    timeoutMs: data.timeoutMs,
  });
  return ok();
}

function handleUpdateGroup(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): IpcResult {
  if (!isMain) {
    logger.warn({ sourceGroup }, 'Unauthorized update_group attempt blocked');
    return fail('Not authorized');
  }
  if (!data.jid) return fail('Missing jid');
  const group = registeredGroups[data.jid];
  if (!group) {
    logger.warn({ jid: data.jid, sourceGroup }, 'Group not found for update');
    return fail('Group not found');
  }
  const groupUpdates: Partial<
    Pick<
      RegisteredGroup,
      'model' | 'temperature' | 'maxToolRounds' | 'timeoutMs'
    >
  > = {};
  if (data.model !== undefined) groupUpdates.model = data.model || undefined;
  if (data.temperature !== undefined)
    groupUpdates.temperature = data.temperature;
  if (data.maxToolRounds !== undefined)
    groupUpdates.maxToolRounds = data.maxToolRounds;
  if (data.timeoutMs !== undefined) groupUpdates.timeoutMs = data.timeoutMs;
  deps.updateGroup(data.jid, groupUpdates);
  logger.info(
    { jid: data.jid, sourceGroup, updates: groupUpdates },
    'Group updated via IPC',
  );
  return ok();
}

// --- Event bus IPC handlers ---

function handlePublishEvent(data: IpcData, sourceGroup: string): IpcResult {
  const eventType = data.eventType as string | undefined;
  const payload = data.payload as string | undefined;
  if (!eventType || !payload) {
    return fail('publish_event requires eventType and payload');
  }
  const sourceTaskId = (data.sourceTaskId as string) || null;
  const dedupeKey = (data.dedupeKey as string) || null;
  const ttlSeconds = (data.ttlSeconds as number) ?? null;

  const result = publishEvent(
    eventType,
    sourceGroup,
    sourceTaskId,
    payload,
    dedupeKey,
    ttlSeconds,
  );
  return { success: true, ...result };
}

function handleConsumeEvents(data: IpcData): IpcResult {
  const eventTypes = data.eventTypes as string[] | undefined;
  const claimedBy = data.claimedBy as string | undefined;
  const limit = (data.limit as number) ?? 50;

  if (!eventTypes || !Array.isArray(eventTypes) || !claimedBy) {
    return fail('consume_events requires eventTypes (array) and claimedBy');
  }

  const events = consumeEvents(eventTypes, claimedBy, limit);
  return { success: true, events } as any;
}

function handleAckEvent(data: IpcData): IpcResult {
  const eventId = data.eventId as number | undefined;
  const status = data.status as 'done' | 'failed' | undefined;

  if (eventId == null || !status) {
    return fail('ack_event requires eventId and status');
  }

  const note = (data.note as string) || undefined;
  ackEvent(eventId, status, note);
  return ok();
}

function handleSubmitToPipeline(
  data: IpcData,
  sourceGroup: string,
): IpcResult {
  const rawText = data.rawText as string | undefined;
  const sourceContext = data.sourceContext as IntakeSourceContext | undefined;

  if (!rawText) {
    return fail('submit_to_pipeline requires rawText');
  }
  if (!sourceContext?.source_group || !sourceContext?.reason) {
    return fail(
      'submit_to_pipeline requires sourceContext with source_group and reason',
    );
  }

  const dedupeKey = (data.dedupeKey as string) || null;
  const rawTextHash = crypto.createHash('sha256').update(rawText).digest('hex');

  const eventPayload = JSON.stringify({ raw_text: rawText, source_context: sourceContext });
  const eventResult = publishEvent(
    'intake.raw',
    sourceContext.source_group || sourceGroup,
    sourceContext.source_task_id || null,
    eventPayload,
    dedupeKey,
  );

  // Log to pipeline_intake_log (only on new events to avoid duplicate logs)
  if (eventResult.isNew) {
    insertIntakeLog(eventResult.id, rawTextHash, sourceContext);
  }

  // Stub: bumpConsumerTaskNextRun('intake.raw') — wired in PR 4
  return { success: true, eventId: eventResult.id, isNew: eventResult.isNew } as any;
}

function handleReadChatMessages(
  data: IpcData,
  registeredGroups: Record<string, RegisteredGroup>,
): IpcResult {
  const targetGroup = data.targetGroup as string | undefined;
  if (!targetGroup) {
    return fail('read_chat_messages requires targetGroup');
  }

  // Verify the target group is registered
  if (!registeredGroups[targetGroup]) {
    return fail(`Target group ${targetGroup} is not registered`);
  }

  const since = (data.since as string) || undefined;
  const limit = (data.limit as number) ?? 50;
  const includeBotMessages = (data.includeBotMessages as boolean) ?? false;

  const result = readChatMessages(targetGroup, since, limit, includeBotMessages);
  return { success: true, ...result } as any;
}

// --- Main dispatcher ---

export async function processTaskIpc(
  data: IpcData,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
): Promise<IpcResult> {
  const registeredGroups = deps.registeredGroups();

  let result: IpcResult;
  switch (data.type) {
    case 'schedule_task':
      result = handleScheduleTask(data, sourceGroup, isMain, registeredGroups);
      if (result.success) deps.refreshAllTaskSnapshots();
      return result;
    case 'pause_task':
      result = handleTaskStatusChange(data, sourceGroup, isMain, 'pause');
      if (result.success) deps.refreshAllTaskSnapshots();
      return result;
    case 'resume_task':
      result = handleTaskStatusChange(data, sourceGroup, isMain, 'resume');
      if (result.success) deps.refreshAllTaskSnapshots();
      return result;
    case 'cancel_task':
      result = handleTaskStatusChange(data, sourceGroup, isMain, 'cancel');
      if (result.success) deps.refreshAllTaskSnapshots();
      return result;
    case 'update_task':
      result = handleUpdateTask(data, sourceGroup, isMain);
      if (result.success) deps.refreshAllTaskSnapshots();
      return result;
    case 'refresh_groups':
      return handleRefreshGroups(sourceGroup, isMain, registeredGroups, deps);
    case 'register_group':
      return handleRegisterGroup(data, sourceGroup, isMain, deps);
    case 'update_group':
      return handleUpdateGroup(
        data,
        sourceGroup,
        isMain,
        registeredGroups,
        deps,
      );
    case 'publish_event':
      return handlePublishEvent(data, sourceGroup);
    case 'consume_events':
      return handleConsumeEvents(data);
    case 'ack_event':
      return handleAckEvent(data);
    case 'submit_to_pipeline':
      return handleSubmitToPipeline(data, sourceGroup);
    case 'read_chat_messages':
      return handleReadChatMessages(data, registeredGroups);
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
      return fail(`Unknown IPC task type: ${data.type}`);
  }
}
