/**
 * System prompt builder for the Anthropic API engine.
 *
 * Always reads CLAUDE.md (never OLLAMA.md) — this is the Claude backend,
 * just without the full Agent SDK bloat. Does NOT load any base instructions
 * file (the SDK preset would override per-task system prompts).
 *
 * Adapted from v1's `task-system-prompt.ts` for v2:
 *   - mount paths: `/workspace/group` → `/workspace/agent` (renamed mount)
 *   - dropped `isMain` gate: v2 includes global memory for all groups
 *     (matches `composeGroupClaudeMd` and step 6 Q4 architectural decision)
 *   - signature: `groupFolder` → `agentGroupFolder`; `isScheduledTask`
 *     stays as an optional input field
 *   - paths-as-parameter for testability without fs mocking
 */
import fs from 'fs';

export interface PromptInput {
  assistantName?: string;
  isScheduledTask?: boolean;
  agentGroupFolder?: string;
}

export interface PromptPaths {
  agent: string;
  global: string;
}

export const DEFAULT_PROMPT_PATHS: PromptPaths = {
  agent: '/workspace/agent',
  global: '/workspace/global',
};

function readMemoryFile(dir: string, filename: string): string | undefined {
  const filePath = `${dir}/${filename}`;
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

export function buildTaskSystemPrompt(input: PromptInput, paths: PromptPaths = DEFAULT_PROMPT_PATHS): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful assistant.`);

  // Group memory (CLAUDE.md only — task engine never reads OLLAMA.md)
  const groupMemory = readMemoryFile(paths.agent, 'CLAUDE.md');
  if (groupMemory) {
    parts.push('## Group Memory\n' + groupMemory);
  }

  // Global shared memory — v2 includes this unconditionally for all groups.
  const globalMemory = readMemoryFile(paths.global, 'CLAUDE.md');
  if (globalMemory) {
    parts.push('## Shared Memory\n' + globalMemory);
  }

  // Channel-specific overrides (CHANNEL.md only, no CHANNEL_OLLAMA.md)
  if (input.agentGroupFolder) {
    const channelPrefix = input.agentGroupFolder.split('_')[0]?.toUpperCase();
    if (channelPrefix) {
      const channelOverride = readMemoryFile(paths.global, `${channelPrefix}.md`);
      if (channelOverride) {
        parts.push('## Channel Overrides\n' + channelOverride);
      }
    }
  }

  if (input.isScheduledTask) {
    parts.push('This is a scheduled task running automatically, not a direct user message.');
  }

  return parts.join('\n\n');
}
