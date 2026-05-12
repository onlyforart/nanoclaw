import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../group-folder.js';
import {
  getAllAgentGroups,
  getAgentGroupByFolder,
  getWiringsForAgentGroup,
  getMessagingGroupById,
  getTasksByGroup,
  getGroupDailyTokensByModel,
  updateGroup,
  type AgentGroupRow,
  type WiringRow,
  type MessagingGroupRow,
  type DailyTokenUsageRow,
} from '../db.js';

/**
 * Agent-group-primary surface (Q7=β). Replaces v1's flat `routes/groups.ts`.
 *
 * Detail responses bundle three things the UI surfaces together:
 *   - the agent_group itself
 *   - every wiring (messaging_group_agents row) with its messaging_group
 *     joined inline — this is the "Wired Channels" table on the detail page
 *   - the scheduled tasks scoped to this agent_group's folder
 *
 * Per-wiring agent settings (model, temperature, max_tool_rounds, timeout_ms,
 * show_thinking, pipeline_replies_blocked, is_main) live on
 * messaging_group_agents per K.1.f step 8.6. PATCH /api/v1/agent-groups/:folder
 * targets the is_main wiring via updateGroup() (v1-compat shim that writes to
 * messaging_group_agents under the hood).
 */

interface WiringResponse {
  id: string;
  messagingGroupId: string;
  messagingGroupName: string | null;
  channelType: string;
  platformId: string;
  isMain: boolean;
  engageMode: string | null;
  engagePattern: string | null;
  senderScope: string | null;
  ignoredMessagePolicy: string | null;
  sessionMode: string;
  priority: number;
  model: string | null;
  temperature: number | null;
  maxToolRounds: number | null;
  timeoutMs: number | null;
  showThinking: boolean;
  pipelineRepliesBlocked: boolean;
  createdAt: string;
}

interface AgentGroupListResponse {
  id: string;
  name: string;
  folder: string;
  agentProvider: string | null;
  mainPlatformId: string | null;
  mainChannelType: string | null;
  wiringCount: number;
  createdAt: string;
  // v1-compat flat aliases (sourced from the is_main wiring). The UI still
  // renders the v1-style summary card; the new entity model lives on the
  // detail page's Wired Channels table.
  jid: string;
  model: string | null;
  temperature: number | null;
  maxToolRounds: number | null;
  timeoutMs: number | null;
  showThinking: boolean;
  isMain: boolean;
  requiresTrigger: boolean;
  trigger: string;
  mode: string;
  threadingMode: string;
  pipelineRepliesBlocked: boolean;
}

interface AgentGroupDetailResponse extends AgentGroupListResponse {
  wirings: WiringResponse[];
  taskCount: number;
}

function formatWiring(wiring: WiringRow, mg: MessagingGroupRow | undefined): WiringResponse {
  return {
    id: wiring.id,
    messagingGroupId: wiring.messaging_group_id,
    messagingGroupName: mg?.name ?? null,
    channelType: mg?.channel_type ?? '',
    platformId: mg?.platform_id ?? '',
    isMain: wiring.is_main === 1,
    engageMode: wiring.engage_mode,
    engagePattern: wiring.engage_pattern,
    senderScope: wiring.sender_scope,
    ignoredMessagePolicy: wiring.ignored_message_policy,
    sessionMode: wiring.session_mode,
    priority: wiring.priority,
    model: wiring.model,
    temperature: wiring.temperature,
    maxToolRounds: wiring.max_tool_rounds,
    timeoutMs: wiring.timeout_ms,
    showThinking: wiring.show_thinking === 1,
    pipelineRepliesBlocked: wiring.pipeline_replies_blocked === 1,
    createdAt: wiring.created_at,
  };
}

function summarise(ag: AgentGroupRow): AgentGroupListResponse {
  const wirings = getWiringsForAgentGroup(ag.id);
  const main = wirings.find((w) => w.is_main === 1) ?? wirings[0];
  const mainMg = main ? getMessagingGroupById(main.messaging_group_id) : undefined;
  return {
    id: ag.id,
    name: ag.name,
    folder: ag.folder,
    agentProvider: ag.agent_provider,
    mainPlatformId: mainMg?.platform_id ?? null,
    mainChannelType: mainMg?.channel_type ?? null,
    wiringCount: wirings.length,
    createdAt: ag.created_at,
    // v1-compat flat aliases (sourced from is_main wiring)
    jid: mainMg?.platform_id ?? '',
    model: main?.model ?? null,
    temperature: main?.temperature ?? null,
    maxToolRounds: main?.max_tool_rounds ?? null,
    timeoutMs: main?.timeout_ms ?? null,
    showThinking: main?.show_thinking === 1,
    isMain: main?.is_main === 1,
    requiresTrigger: !(main?.engage_mode === 'pattern' && main?.engage_pattern === '.'),
    trigger: main?.engage_pattern ?? '',
    mode: 'active',
    threadingMode: main?.session_mode ?? 'shared',
    pipelineRepliesBlocked: main?.pipeline_replies_blocked === 1,
  };
}

export function handleGetAgentGroups(): AgentGroupListResponse[] {
  return getAllAgentGroups().map(summarise);
}

export function handleGetAgentGroup(folder: string): AgentGroupDetailResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const ag = getAgentGroupByFolder(folder);
  if (!ag) return null;

  const wirings = getWiringsForAgentGroup(ag.id);
  const wiringResponses = wirings.map((w) => formatWiring(w, getMessagingGroupById(w.messaging_group_id)));
  const main = wirings.find((w) => w.is_main === 1) ?? wirings[0];
  const mainMg = main ? getMessagingGroupById(main.messaging_group_id) : undefined;

  return {
    ...summarise(ag),
    wirings: wiringResponses,
    taskCount: getTasksByGroup(folder).length,
  };
}

export function handlePatchAgentGroup(
  folder: string,
  body: {
    model?: string | null;
    temperature?: number;
    maxToolRounds?: number;
    timeoutMs?: number;
    showThinking?: boolean;
    threadingMode?: string;
    pipelineRepliesBlocked?: boolean;
  },
): AgentGroupDetailResponse | null {
  if (!isValidGroupFolder(folder)) return null;

  const updates: {
    model?: string | null;
    temperature?: number | null;
    max_tool_rounds?: number;
    timeout_ms?: number;
    show_thinking?: number | null;
    threading_mode?: string;
    pipeline_replies_blocked?: number;
  } = {};
  if (body.model !== undefined) updates.model = body.model;
  if (body.temperature !== undefined) {
    updates.temperature = body.temperature != null && String(body.temperature) !== '' ? Number(body.temperature) : null;
  }
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;
  if (body.showThinking !== undefined) updates.show_thinking = body.showThinking ? 1 : null;
  if (body.threadingMode !== undefined) updates.threading_mode = body.threadingMode;
  if (body.pipelineRepliesBlocked !== undefined) updates.pipeline_replies_blocked = body.pipelineRepliesBlocked ? 1 : 0;

  updateGroup(folder, updates);

  return handleGetAgentGroup(folder);
}

// Per-million-token pricing. Same logic as v1's routes/groups.ts; preserved
// verbatim so the token-usage endpoint behaves identically.

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  haiku:  { input: 0.80, output: 4,  cacheRead: 0.08,  cacheWrite: 1 },
  sonnet: { input: 3,    output: 15, cacheRead: 0.30,  cacheWrite: 3.75 },
  opus:   { input: 15,   output: 75, cacheRead: 1.50,  cacheWrite: 18.75 },
};

function loadPricing(): Record<string, ModelPricing> {
  const configPath = path.join(process.cwd(), 'data', 'backend-defaults.json');
  try {
    if (!fs.existsSync(configPath)) return DEFAULT_PRICING;
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.pricing && typeof config.pricing === 'object') {
      return { ...DEFAULT_PRICING, ...config.pricing };
    }
  } catch { /* ignore */ }
  return DEFAULT_PRICING;
}

function findPricing(model: string | null, table: Record<string, ModelPricing>): ModelPricing | null {
  if (!model) return null;
  if (table[model]) return table[model];
  for (const [pattern, pricing] of Object.entries(table)) {
    if (model.includes(pattern) || pattern.includes(model)) return pricing;
  }
  return null;
}

function computeCost(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheCreation: number,
): number {
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreation);
  return (
    uncachedInput * pricing.input +
    outputTokens * pricing.output +
    cacheRead * pricing.cacheRead +
    cacheCreation * pricing.cacheWrite
  ) / 1_000_000;
}

export function handleGetAgentGroupTokenUsage(folder: string, days: number = 30): DailyTokenUsageRow[] | null {
  if (!isValidGroupFolder(folder)) return null;
  const rows = getGroupDailyTokensByModel(folder, days);
  const pricingTable = loadPricing();

  const byDate = new Map<string, DailyTokenUsageRow>();
  for (const row of rows) {
    let entry = byDate.get(row.date);
    if (!entry) {
      entry = { date: row.date, uncached: 0, cached: 0, cost: null };
      byDate.set(row.date, entry);
    }
    entry.cached += row.cache_read + row.cache_creation;
    entry.uncached += row.input_tokens + row.output_tokens - row.cache_read - row.cache_creation;

    let rowCost: number | null = null;
    if (row.actual_cost != null && row.rows_with_cost === row.total_rows) {
      rowCost = row.actual_cost;
    } else if ((row.cache_read > 0 || row.cache_creation > 0) && (row.input_tokens > 0 || row.output_tokens > 0)) {
      const pricing = findPricing(row.model, pricingTable);
      if (pricing) {
        rowCost = computeCost(pricing, row.input_tokens, row.output_tokens, row.cache_read, row.cache_creation);
      }
    }
    if (rowCost != null) {
      entry.cost = Math.round(((entry.cost ?? 0) + rowCost) * 10000) / 10000;
    }
  }

  return Array.from(byDate.values());
}
