import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import {
  getPipelineTasks,
  getPipelineTokenUsage,
  getPassiveChannels,
  getGroupByFolder,
  type TaskRow,
  type GroupRow,
  type PipelineTokenUsageRow,
} from '../db.js';

interface PipelineTaskView extends TaskRow {
  profiles: string[];
  extra_tools: string[];
}

interface PipelineOverview {
  tasks: PipelineTaskView[];
  sourceChannels: GroupRow[];
  tokenUsage: PipelineTokenUsageRow[];
  teamGroup: { name: string; folder: string; jid: string } | null;
}

interface PipelineSpec {
  profiles?: string[];
  enabled?: string[];
  cron?: string;
  fallback_poll_ms?: number;
  subscribed_event_types?: string[];
  model?: string;
  system?: string;
  send_targets?: string[];
}

function loadYamlSpecs(): Record<string, PipelineSpec> {
  const result: Record<string, PipelineSpec> = {};
  try {
    const dir = path.join(process.cwd(), 'pipeline');
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).filter((f: string) => f.endsWith('.yaml'))) {
      try {
        const spec = parseYaml(fs.readFileSync(path.join(dir, file), 'utf-8')) as {
          name?: string;
          tools?: { profiles?: string[]; enabled?: string[] };
          cron?: string;
          fallback_poll_ms?: number;
          subscribed_event_types?: string[];
          model?: string;
          system?: string;
          send_targets?: string[];
        };
        if (spec?.name) {
          result[`pipeline:${spec.name}`] = {
            profiles: spec.tools?.profiles || [],
            enabled: spec.tools?.enabled || [],
            cron: spec.cron,
            fallback_poll_ms: spec.fallback_poll_ms,
            subscribed_event_types: spec.subscribed_event_types,
            model: spec.model,
            system: spec.system,
            send_targets: spec.send_targets,
          };
        }
      } catch { /* skip invalid */ }
    }
  } catch { /* yaml not available */ }
  return result;
}

export function handleGetPipeline(query: Record<string, string>): PipelineOverview {
  const days = query.days ? parseInt(query.days, 10) : 30;
  const tasks = getPipelineTasks();
  const specs = loadYamlSpecs();

  // Enrich tasks with YAML spec data. For container-mode pipeline agents
  // (pipeline-monitor / pipeline-responder / pipeline-solver) the synthesised
  // DB row carries only the agent_group metadata — the schedule, model,
  // prompt, and allowed-tools live in the pipeline spec YAML. Overlay the
  // YAML values whenever the synthesised/DB row is empty so the webui shows
  // the live pipeline config.
  const enrichedTasks: PipelineTaskView[] = tasks.map((t) => {
    const spec = specs[t.id];
    const merged: PipelineTaskView = {
      ...t,
      profiles: spec?.profiles || [],
      extra_tools: spec?.enabled || [],
    };
    if (spec) {
      if ((!merged.prompt || merged.prompt === '') && spec.system) {
        merged.prompt = spec.system;
      }
      if ((!merged.model || merged.model === '') && spec.model) {
        merged.model = spec.model;
      }
      if ((!merged.schedule_value || merged.schedule_value === '') && spec.cron) {
        merged.schedule_value = spec.cron;
        merged.schedule_type = 'cron';
      }
      if (merged.fallback_poll_ms == null && spec.fallback_poll_ms != null) {
        merged.fallback_poll_ms = spec.fallback_poll_ms;
      }
      if (!merged.subscribed_event_types && spec.subscribed_event_types) {
        merged.subscribed_event_types = JSON.stringify(spec.subscribed_event_types);
      }
      if (!merged.allowed_send_targets && spec.send_targets) {
        merged.allowed_send_targets = JSON.stringify(spec.send_targets);
      }
      if (!merged.allowed_tools && spec.enabled && spec.enabled.length) {
        merged.allowed_tools = JSON.stringify(spec.enabled);
      }
    }
    return merged;
  });

  // Derive team group from the first pipeline task's group_folder
  let teamGroup: PipelineOverview['teamGroup'] = null;
  if (tasks.length > 0) {
    const group = getGroupByFolder(tasks[0].group_folder);
    if (group) {
      teamGroup = { name: group.name, folder: group.folder, jid: group.jid };
    }
  }

  return {
    tasks: enrichedTasks,
    sourceChannels: getPassiveChannels(),
    tokenUsage: getPipelineTokenUsage(days),
    teamGroup,
  };
}
