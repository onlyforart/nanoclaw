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
  prompt: string;
  scheduleType: string;
  scheduleValue: string;
  contextMode: string;
  model: string | null;
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
    prompt: row.prompt,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    contextMode: row.context_mode,
    model: row.model,
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

export function handlePatchTask(
  id: string,
  body: {
    prompt?: string;
    scheduleType?: string;
    scheduleValue?: string;
    model?: string;
    timezone?: string;
    maxToolRounds?: number;
    timeoutMs?: number;
    status?: string;
  },
): TaskResponse | null {
  const existing = getTaskById(id);
  if (!existing) return null;

  // Map camelCase to snake_case, excluding contextMode (read-only)
  const updates: Record<string, unknown> = {};
  if (body.prompt !== undefined) updates.prompt = body.prompt;
  if (body.scheduleType !== undefined) updates.schedule_type = body.scheduleType;
  if (body.scheduleValue !== undefined) updates.schedule_value = body.scheduleValue;
  if (body.model !== undefined) updates.model = body.model;
  if (body.timezone !== undefined) updates.timezone = body.timezone;
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;
  if (body.status !== undefined) updates.status = body.status;

  if (Object.keys(updates).length > 0) {
    updateTask(id, updates as any);
  }

  const updated = getTaskById(id);
  return updated ? formatTask(updated) : null;
}

export function handleGetTaskRuns(taskId: string, limit: number = 20): TaskRunResponse[] {
  return getTaskRuns(taskId, limit).map(formatRun);
}
