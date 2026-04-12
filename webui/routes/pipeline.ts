import fs from 'node:fs';
import path from 'node:path';

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

function loadYamlSpecs(): Record<string, { profiles?: string[]; enabled?: string[] }> {
  const result: Record<string, { profiles?: string[]; enabled?: string[] }> = {};
  try {
    const { parse } = require('yaml');
    const dir = path.join(process.cwd(), 'pipeline');
    if (!fs.existsSync(dir)) return result;
    for (const file of fs.readdirSync(dir).filter((f: string) => f.endsWith('.yaml'))) {
      try {
        const spec = parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (spec?.name) {
          result[`pipeline:${spec.name}`] = {
            profiles: spec.tools?.profiles || [],
            enabled: spec.tools?.enabled || [],
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

  // Enrich tasks with profile names from YAML specs
  const enrichedTasks: PipelineTaskView[] = tasks.map((t) => {
    const spec = specs[t.id];
    return {
      ...t,
      profiles: spec?.profiles || [],
      extra_tools: spec?.enabled || [],
    };
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
