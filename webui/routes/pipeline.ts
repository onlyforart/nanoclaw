import {
  getPipelineTasks,
  getPipelineTokenUsage,
  getPassiveChannels,
  type TaskRow,
  type GroupRow,
  type PipelineTokenUsageRow,
} from '../db.js';

interface PipelineOverview {
  tasks: TaskRow[];
  sourceChannels: GroupRow[];
  tokenUsage: PipelineTokenUsageRow[];
}

export function handleGetPipeline(query: Record<string, string>): PipelineOverview {
  const days = query.days ? parseInt(query.days, 10) : 30;
  return {
    tasks: getPipelineTasks(),
    sourceChannels: getPassiveChannels(),
    tokenUsage: getPipelineTokenUsage(days),
  };
}
