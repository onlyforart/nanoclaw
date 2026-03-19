import { isValidGroupFolder } from '../group-folder.js';
import { getAllGroups, getGroupByFolder, updateGroup, type GroupRow } from '../db.js';

interface GroupResponse {
  jid: string;
  name: string;
  folder: string;
  model: string | null;
  maxToolRounds: number | null;
  timeoutMs: number | null;
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
    maxToolRounds: row.max_tool_rounds,
    timeoutMs: row.timeout_ms,
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
  body: { model?: string; maxToolRounds?: number; timeoutMs?: number },
): GroupResponse | null {
  if (!isValidGroupFolder(folder)) return null;

  const updates: { model?: string; max_tool_rounds?: number; timeout_ms?: number } = {};
  if (body.model !== undefined) updates.model = body.model;
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;

  updateGroup(folder, updates);

  const row = getGroupByFolder(folder);
  if (!row) return null;
  return formatGroup(row);
}
