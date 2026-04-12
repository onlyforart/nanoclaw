import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../group-folder.js';
import { getAllGroups, getGroupByFolder, updateGroup, getGroupDailyTokensByModel, type GroupRow, type DailyTokenUsageRow } from '../db.js';

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
  mode: string;
  threadingMode: string;
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
    mode: row.mode || 'active',
    threadingMode: row.threading_mode || 'temporal',
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
  body: { model?: string; temperature?: number; maxToolRounds?: number; timeoutMs?: number; showThinking?: boolean; mode?: string; threadingMode?: string },
): GroupResponse | null {
  if (!isValidGroupFolder(folder)) return null;

  const updates: { model?: string; temperature?: number | null; max_tool_rounds?: number; timeout_ms?: number; show_thinking?: number | null; mode?: string; threading_mode?: string } = {};
  if (body.model !== undefined) updates.model = body.model;
  if (body.temperature !== undefined) updates.temperature = body.temperature != null && String(body.temperature) !== '' ? Number(body.temperature) : null;
  if (body.maxToolRounds !== undefined) updates.max_tool_rounds = body.maxToolRounds;
  if (body.timeoutMs !== undefined) updates.timeout_ms = body.timeoutMs;
  if (body.showThinking !== undefined) updates.show_thinking = body.showThinking ? 1 : null;
  if (body.mode !== undefined) updates.mode = body.mode;
  if (body.threadingMode !== undefined) updates.threading_mode = body.threadingMode;

  updateGroup(folder, updates);

  const row = getGroupByFolder(folder);
  if (!row) return null;
  return formatGroup(row);
}

// Per-million-token pricing by model family.
// Defaults based on https://docs.anthropic.com/en/docs/about-claude/models
// Overridable via data/backend-defaults.json { "pricing": { "model-pattern": { ... } } }
interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'haiku':  { input: 0.80, output: 4,  cacheRead: 0.08,  cacheWrite: 1 },
  'sonnet': { input: 3,    output: 15, cacheRead: 0.30,  cacheWrite: 3.75 },
  'opus':   { input: 15,   output: 75, cacheRead: 1.50,  cacheWrite: 18.75 },
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
  // Exact match first
  if (table[model]) return table[model];
  // Bidirectional substring: model contains key, or key contains model
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
  // Clamp to 0: input_tokens may be base-only (Anthropic API) or total (SDK).
  // If base-only and cache columns are also populated, subtraction could go negative.
  const uncachedInput = Math.max(0, inputTokens - cacheRead - cacheCreation);
  return (
    uncachedInput * pricing.input +
    outputTokens * pricing.output +
    cacheRead * pricing.cacheRead +
    cacheCreation * pricing.cacheWrite
  ) / 1_000_000;
}

export function handleGetGroupTokenUsage(folder: string, days: number = 30): DailyTokenUsageRow[] | null {
  if (!isValidGroupFolder(folder)) return null;
  const rows = getGroupDailyTokensByModel(folder, days);
  const pricingTable = loadPricing();

  // Aggregate per-model rows into per-day totals, computing cost where missing
  const byDate = new Map<string, DailyTokenUsageRow>();
  for (const row of rows) {
    let entry = byDate.get(row.date);
    if (!entry) {
      entry = { date: row.date, uncached: 0, cached: 0, cost: null };
      byDate.set(row.date, entry);
    }
    entry.cached += row.cache_read + row.cache_creation;
    entry.uncached += row.input_tokens + row.output_tokens - row.cache_read - row.cache_creation;

    // Cost: use actual_cost when it covers all rows for this model+day (backfilled
    // historical data). When coverage is partial (e.g. a few SDK runs mixed with
    // many lightweight-engine runs that don't record cost), estimate from tokens
    // instead — partial actual_cost would massively undercount.
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
