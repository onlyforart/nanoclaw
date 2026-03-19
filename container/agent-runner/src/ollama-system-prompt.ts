/**
 * System prompt builder for Ollama direct mode.
 *
 * Uses OLLAMA.md files for group/global memory, falling back to CLAUDE.md
 * when no OLLAMA.md exists. This allows groups to have different instructions
 * for Ollama vs Claude backends.
 */

import fs from 'fs';

interface PromptInput {
  assistantName?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  groupFolder?: string;
}

/**
 * Read a memory file, preferring OLLAMA.md over CLAUDE.md.
 * Returns the file content, or undefined if neither exists.
 */
function readMemoryFile(dir: string): string | undefined {
  const ollamaPath = `${dir}/OLLAMA.md`;
  if (fs.existsSync(ollamaPath)) {
    return fs.readFileSync(ollamaPath, 'utf-8');
  }

  const claudePath = `${dir}/CLAUDE.md`;
  if (fs.existsSync(claudePath)) {
    return fs.readFileSync(claudePath, 'utf-8');
  }

  return undefined;
}

export function buildOllamaSystemPrompt(input: PromptInput): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful assistant.`);

  // Group memory
  const groupMemory = readMemoryFile('/workspace/group');
  if (groupMemory) {
    parts.push('## Group Memory\n' + groupMemory);
  }

  // Global shared memory (non-main groups only)
  if (!input.isMain) {
    const globalMemory = readMemoryFile('/workspace/global');
    if (globalMemory) {
      parts.push('## Shared Memory\n' + globalMemory);
    }
  }

  // Channel-specific overrides from /workspace/global/{CHANNEL}.md
  // e.g. slack_main → SLACK.md, telegram_dev → TELEGRAM.md
  if (input.groupFolder) {
    const channelPrefix = input.groupFolder.split('_')[0]?.toUpperCase();
    if (channelPrefix) {
      const channelMdPath = `/workspace/global/${channelPrefix}.md`;
      if (fs.existsSync(channelMdPath)) {
        parts.push('## Channel Overrides\n' + fs.readFileSync(channelMdPath, 'utf-8'));
      }
    }
  }

  if (input.isScheduledTask) {
    parts.push('This is a scheduled task running automatically, not a direct user message.');
  }

  return parts.join('\n\n');
}
