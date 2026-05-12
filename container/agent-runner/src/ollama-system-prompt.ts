/**
 * System prompt builder for Ollama direct mode.
 *
 * Uses OLLAMA.md files for group/global memory, falling back to CLAUDE.md
 * when no OLLAMA.md exists. This allows groups to have different
 * instructions for Ollama vs. Claude backends.
 *
 * Adapted from v1's `ollama-system-prompt.ts` for v2:
 *   - mount paths: `/workspace/group` → `/workspace/agent` (renamed mount)
 *   - dropped `isMain` gate: v2 includes global memory for all groups
 *   - signature: `groupFolder` → `agentGroupFolder`
 *   - base instructions (`OLLAMA-SYSTEM.md`): moved from
 *     `/workspace/project/container/OLLAMA-SYSTEM.md` (v1; no project mount
 *     in v2) to a sibling file `ollama-system.md` in this directory,
 *     resolved via `__dirname`. v2 mounts the agent-runner source RO at
 *     `/app/src` so the file is reachable in-container.
 *   - paths-as-parameter for testability without fs mocking
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface PromptInput {
  assistantName?: string;
  isScheduledTask?: boolean;
  agentGroupFolder?: string;
}

export interface PromptPaths {
  agent: string;
  global: string;
  /** Absolute path to the base instructions markdown. */
  systemMd: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_PROMPT_PATHS: PromptPaths = {
  agent: '/workspace/agent',
  global: '/workspace/global',
  systemMd: path.join(HERE, 'ollama-system.md'),
};

/**
 * Read a memory file, preferring the first filename that exists.
 * Defaults to OLLAMA.md → CLAUDE.md when no filenames are specified.
 * Returns the file content, or undefined if none exists.
 */
function readMemoryFile(dir: string, ...filenames: string[]): string | undefined {
  const names = filenames.length > 0 ? filenames : ['OLLAMA.md', 'CLAUDE.md'];
  for (const name of names) {
    const filePath = `${dir}/${name}`;
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  }
  return undefined;
}

export function buildOllamaSystemPrompt(input: PromptInput, paths: PromptPaths = DEFAULT_PROMPT_PATHS): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful assistant.`);

  // Base system instructions (tool usage rules, output formatting)
  if (fs.existsSync(paths.systemMd)) {
    parts.push(fs.readFileSync(paths.systemMd, 'utf-8'));
  }

  // Group memory (OLLAMA.md preferred, CLAUDE.md fallback)
  const groupMemory = readMemoryFile(paths.agent);
  if (groupMemory) {
    parts.push('## Group Memory\n' + groupMemory);
  }

  // Global shared memory — v2 includes this unconditionally for all groups.
  const globalMemory = readMemoryFile(paths.global);
  if (globalMemory) {
    parts.push('## Shared Memory\n' + globalMemory);
  }

  // Channel-specific overrides from `${global}/{CHANNEL}_OLLAMA.md` or fallback `{CHANNEL}.md`.
  // e.g. agentGroupFolder slack_main → SLACK_OLLAMA.md (preferred) → SLACK.md (fallback)
  if (input.agentGroupFolder) {
    const channelPrefix = input.agentGroupFolder.split('_')[0]?.toUpperCase();
    if (channelPrefix) {
      const channelOverride = readMemoryFile(paths.global, `${channelPrefix}_OLLAMA.md`, `${channelPrefix}.md`);
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
