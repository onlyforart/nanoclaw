import { isValidGroupFolder } from '../group-folder.js';
import { getAllGroups, getGroupByFolder, updateGroup, type GroupRow } from '../db.js';

interface GroupResponse {
  jid: string;
  name: string;
  folder: string;
  model: string | null;
  temperature: number | null;
  maxToolRounds: number | null;
  timeoutMs: number | null;
  showThinking: boolean;
  isMain: boolean;
  requiresTrigger: boolean;
  trigger: string;
}

function formatGroup(row: GroupRow): GroupResponse {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    model: row.model,
    temperature: row.temperature,
    maxToolRounds: row.max_tool_rounds,
    timeoutMs: row.timeout_ms,
    showThinking: row.show_thinking === 1,
    isMain: row.is_main === 1,
    requiresTrigger: row.requires_trigger === 1,
    trigger: row.trigger_pattern,
  };
}

export function handleGetGroups(): GroupResponse[] {
  return getAllGroups().map(formatGroup);
}

export function handleGetGroup(folder: string): GroupResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const row = getGroupByFolder(folder);
  if (!row) return null;
  return formatGroup(row);
}

export function handlePatchGroup(
  folder: string,
  body: { model?: string; temperature?: number; maxToolRounds?: number; timeoutMs?: number; showThinking?: boolean },
): GroupResponse | null {
  if (!isValidGroupFolder(folder)) return null;

  const updates: { model?: string; temperature?: number | null; max_tool_rounds?: number; timeout_ms?: number; show_thinking?: number | null } = {};
  if (body.model !== undefined) updates.model = body.model;
  if (body.temperature !== undefined) updates.temperature = body.temperature != null && String(body.temperature) !== '' ? Number(body.temperature) : null;
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;
  if (body.showThinking !== undefined) updates.show_thinking = body.showThinking ? 1 : null;

  updateGroup(folder, updates);

  const row = getGroupByFolder(folder);
  if (!row) return null;
  return formatGroup(row);
}
