import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { createTask, getPassiveGroups, getTaskById, updateTask } from './db.js';
import { logger } from './logger.js';

export interface PipelineSpec {
  name: string;
  description: string;
  version: number;
  type?: 'host_pipeline';
  model: string;
  cron: string;
  system: string;
  tools: {
    default_enabled: boolean;
    profiles?: string[];
    enabled: string[];
  };
  send_targets: string[];
  subscribed_event_types?: string[];
  source_channels?: string[];
}

const REQUIRED_FIELDS = [
  'name',
  'version',
  'model',
  'cron',
  'system',
  'tools',
  'send_targets',
] as const;

export function loadPipelineSpec(filePath: string): PipelineSpec {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const spec = parseYaml(raw) as PipelineSpec;

  for (const field of REQUIRED_FIELDS) {
    if (spec[field] === undefined || spec[field] === null) {
      throw new Error(
        `Pipeline spec ${filePath} missing required field: ${field}`,
      );
    }
  }

  return spec;
}

export function reconcilePipelineTasks(
  specs: PipelineSpec[],
  teamGroupFolder: string,
  teamChatJid: string,
  toolProfiles?: Record<string, string[]>,
): void {
  // Resolve {source_channel} placeholders from passive groups
  const passiveGroups = getPassiveGroups();
  const passiveJids = passiveGroups.map((g) => g.jid);

  for (const spec of specs) {
    const taskId = `pipeline:${spec.name}`;
    const existing = getTaskById(taskId);

    // Resolve send_targets: replace {source_channel} with actual passive JIDs
    const resolvedSendTargets = spec.send_targets.flatMap((t) =>
      t === '{source_channel}' ? passiveJids : [t],
    );

    // Resolve tools: merge profile tools + explicitly enabled tools
    const resolvedTools = resolveToolList(spec.tools, toolProfiles);

    if (!existing) {
      // Create new task
      const now = new Date().toISOString();
      createTask({
        id: taskId,
        group_folder: teamGroupFolder,
        chat_jid: teamChatJid,
        prompt: spec.system,
        schedule_type: 'cron',
        schedule_value: spec.cron,
        context_mode: 'isolated',
        model: spec.model,
        allowedTools: resolvedTools,
        allowedSendTargets: resolvedSendTargets,
        executionMode:
          spec.type === 'host_pipeline' ? 'host_pipeline' : 'container',
        subscribedEventTypes: spec.subscribed_event_types ?? null,
        // Consumer tasks (with subscribed_event_types) wait for events to bump them.
        // Producer tasks (sanitiser) run on their cron schedule immediately.
        next_run: spec.subscribed_event_types?.length ? null : now,
        status: 'active',
        created_at: now,
      });
      logger.info({ taskId, version: spec.version }, 'Pipeline task created');
    } else {
      // Compare spec-derived values against DB — only update fields that
      // actually changed in the spec. DB always wins for operational
      // settings (model, prompt, schedule, send targets).
      const changes: Record<string, unknown> = {};
      const changeLog: string[] = [];

      // Tools: derived from profiles + enabled — spec-owned
      const existingTools = JSON.stringify(existing.allowedTools ?? []);
      const specTools = JSON.stringify(resolvedTools);
      if (existingTools !== specTools) {
        changes.allowedTools = resolvedTools;
        changeLog.push(`allowedTools: ${existingTools} → ${specTools}`);
      }

      // Execution mode: spec-owned
      const specExecMode = spec.type === 'host_pipeline' ? 'host_pipeline' : 'container';
      if ((existing.executionMode || 'container') !== specExecMode) {
        changes.executionMode = specExecMode;
        changeLog.push(`executionMode: ${existing.executionMode} → ${specExecMode}`);
      }

      // Subscribed event types: spec-owned
      const existingEvents = JSON.stringify(existing.subscribedEventTypes ?? null);
      const specEvents = JSON.stringify(spec.subscribed_event_types ?? null);
      if (existingEvents !== specEvents) {
        changes.subscribedEventTypes = spec.subscribed_event_types ?? null;
        changeLog.push(`subscribedEventTypes: ${existingEvents} → ${specEvents}`);
      }

      if (Object.keys(changes).length > 0) {
        updateTask(taskId, changes as any);
        logger.info(
          { taskId, changes: changeLog },
          'Pipeline task updated (spec-derived fields only)',
        );
      }
    }

    // Always store the current spec version for reference
    setTaskVersion(taskId, spec.version);
  }
}

// --- Tool profile resolution ---

function resolveToolList(
  tools: PipelineSpec['tools'],
  profiles?: Record<string, string[]>,
): string[] {
  const resolved = new Set<string>();

  // Add tools from referenced profiles
  if (tools.profiles?.length && profiles) {
    for (const profileName of tools.profiles) {
      const profileTools = profiles[profileName];
      if (profileTools) {
        for (const tool of profileTools) resolved.add(tool);
      } else {
        logger.warn({ profileName }, 'Unknown tool profile referenced');
      }
    }
  }

  // Add explicitly enabled tools
  for (const tool of tools.enabled) {
    resolved.add(tool);
  }

  return Array.from(resolved);
}

// --- Version tracking via router_state ---

import { getRouterState, setRouterState } from './db.js';

function setTaskVersion(taskId: string, version: number): void {
  setRouterState(`pipeline_version:${taskId}`, String(version));
}

function getTaskVersion(taskId: string): number {
  const stored = getRouterState(`pipeline_version:${taskId}`);
  return stored ? parseInt(stored, 10) : 0;
}

export function loadAllPipelineSpecs(
  dir: string = path.join(process.cwd(), 'pipeline'),
): PipelineSpec[] {
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  const specs: PipelineSpec[] = [];

  for (const file of files) {
    try {
      specs.push(loadPipelineSpec(path.join(dir, file)));
    } catch (err) {
      logger.error({ file, err }, 'Failed to load pipeline spec');
    }
  }

  return specs;
}
