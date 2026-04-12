import {
  getPipelineTasks,
  getPipelineTokenUsage,
  getPassiveChannels,
  getGroupByFolder,
  type TaskRow,
  type GroupRow,
  type PipelineTokenUsageRow,
} from '../db.js';

interface PipelineOverview {
  tasks: TaskRow[];
  sourceChannels: GroupRow[];
  tokenUsage: PipelineTokenUsageRow[];
  teamGroup: { name: string; folder: string; jid: string } | null;
}

export function handleGetPipeline(query: Record<string, string>): PipelineOverview {
  const days = query.days ? parseInt(query.days, 10) : 30;
  const tasks = getPipelineTasks();

  // Derive team group from the first pipeline task's group_folder
  let teamGroup: PipelineOverview['teamGroup'] = null;
  if (tasks.length > 0) {
    const group = getGroupByFolder(tasks[0].group_folder);
    if (group) {
      teamGroup = { name: group.name, folder: group.folder, jid: group.jid };
    }
  }

  return {
    tasks,
    sourceChannels: getPassiveChannels(),
    tokenUsage: getPipelineTokenUsage(days),
    teamGroup,
  };
}
