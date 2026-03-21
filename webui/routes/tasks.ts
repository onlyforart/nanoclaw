import { CronExpressionParser } from 'cron-parser';

import {
  getTasksByGroup,
  getTaskById,
  updateTask,
  getTaskRuns,
  type TaskRow,
  type TaskRunRow,
} from '../db.js';

interface TaskResponse {
  id: string;
  groupFolder: string;
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  contextMode: string;
  model: string | null;
  temperature: number | null;
  timezone: string | null;
  maxToolRounds: number | null;
  timeoutMs: number | null;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  status: string;
  createdAt: string;
}

interface TaskRunResponse {
  runAt: string;
  durationMs: number;
  status: string;
  result: string | null;
  error: string | null;
}

function formatTask(row: TaskRow): TaskResponse {
  return {
    id: row.id,
    groupFolder: row.group_folder,
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    contextMode: row.context_mode,
    model: row.model,
    temperature: row.temperature,
    timezone: row.timezone,
    maxToolRounds: row.max_tool_rounds,
    timeoutMs: row.timeout_ms,
    nextRun: row.next_run,
    lastRun: row.last_run,
    lastResult: row.last_result,
    status: row.status,
    createdAt: row.created_at,
  };
}

function formatRun(row: TaskRunRow): TaskRunResponse {
  return {
    runAt: row.run_at,
    durationMs: row.duration_ms,
    status: row.status,
    result: row.result,
    error: row.error,
  };
}

export function handleGetGroupTasks(groupFolder: string): TaskResponse[] {
  return getTasksByGroup(groupFolder).map(formatTask);
}

export function handleGetTask(id: string): TaskResponse | null {
  const row = getTaskById(id);
  return row ? formatTask(row) : null;
}

/**
 * Validate and compute the next run time for a schedule.
 * Returns the ISO string on success, or throws with a descriptive message.
 */
function computeNextRun(
  scheduleType: string,
  scheduleValue: string,
  timezone: string | null,
): string | null {
  const tz = timezone || undefined;
  if (scheduleType === 'cron') {
    // Throws on invalid expression — caller should catch
    const interval = CronExpressionParser.parse(scheduleValue, { tz });
    return interval.next().toISOString()!;
  }
  if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) throw new Error(`Invalid interval: ${scheduleValue}`);
    return new Date(Date.now() + ms).toISOString();
  }
  if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${scheduleValue}`);
    return date.toISOString();
  }
  return null;
}

export function handlePatchTask(
  id: string,
  body: {
    prompt?: string;
    scheduleType?: string;
    scheduleValue?: string;
    contextMode?: string;
    model?: string;
    temperature?: number;
    timezone?: string;
    maxToolRounds?: number;
    timeoutMs?: number;
    status?: string;
  },
): { task: TaskResponse } | { error: string } {
  const existing = getTaskById(id);
  if (!existing) return { error: 'Task not found' };

  const updates: Record<string, unknown> = {};
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.scheduleType !== undefined) updates.schedule_type = body.scheduleType;
  if (body.scheduleValue !== undefined) updates.schedule_value = body.scheduleValue;
  if (body.contextMode !== undefined) updates.context_mode = body.contextMode;
  if (body.model !== undefined) updates.model = body.model;
  if (body.temperature !== undefined) updates.temperature = body.temperature;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;
  if (body.status !== undefined) updates.status = body.status;

  // Recompute next_run when schedule or timezone changes
  if (body.scheduleType !== undefined || body.scheduleValue !== undefined || body.timezone !== undefined) {
    const merged = {
      schedule_type: body.scheduleType ?? existing.schedule_type,
      schedule_value: body.scheduleValue ?? existing.schedule_value,
      timezone: body.timezone !== undefined ? body.timezone : existing.timezone,
    };
    try {
      updates.next_run = computeNextRun(merged.schedule_type, merged.schedule_value, merged.timezone);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  if (Object.keys(updates).length > 0) {
    updateTask(id, updates as any);
  }

  const updated = getTaskById(id);
  return updated ? { task: formatTask(updated) } : { error: 'Task not found after update' };
}

export function handleGetTaskRuns(taskId: string, limit: number = 20): TaskRunResponse[] {
  return getTaskRuns(taskId, limit).map(formatRun);
}
