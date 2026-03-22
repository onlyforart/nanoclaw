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
      const channelOverride = readMemoryFile(`/workspace/global`, `${channelPrefix}_OLLAMA.md`, `${channelPrefix}.md`);
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
