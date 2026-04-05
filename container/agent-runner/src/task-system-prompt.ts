/**
 * System prompt builder for the Anthropic API engine.
 *
 * Always reads CLAUDE.md (never OLLAMA.md) — this is the Claude backend,
 * just without the full Agent SDK bloat. Does NOT load OLLAMA-SYSTEM.md
 * base instructions (those contain Ollama-specific tool-calling syntax).
 */

import fs from 'fs';

interface PromptInput {
  assistantName?: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  groupFolder?: string;
}

/**
 * Read a memory file by exact filename from a directory.
 * Returns the file content, or undefined if it doesn't exist.
 */
function readMemoryFile(dir: string, filename: string): string | undefined {
  const filePath = `${dir}/${filename}`;
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return undefined;
}

export function buildTaskSystemPrompt(input: PromptInput): string {
  const parts: string[] = [];

  parts.push(`You are ${input.assistantName || 'Andy'}, a helpful assistant.`);

  // No base instructions — unlike Ollama, we don't load OLLAMA-SYSTEM.md

  // Group memory (CLAUDE.md only)
  const groupMemory = readMemoryFile('/workspace/group', 'CLAUDE.md');
  if (groupMemory) {
    parts.push('## Group Memory\n' + groupMemory);
  }

  // Global shared memory (non-main groups only, CLAUDE.md only)
  if (!input.isMain) {
    const globalMemory = readMemoryFile('/workspace/global', 'CLAUDE.md');
    if (globalMemory) {
      parts.push('## Shared Memory\n' + globalMemory);
    }
  }

  // Channel-specific overrides (CHANNEL.md only, no CHANNEL_OLLAMA.md)
  if (input.groupFolder) {
    const channelPrefix = input.groupFolder.split('_')[0]?.toUpperCase();
    if (channelPrefix) {
      const channelOverride = readMemoryFile(
        '/workspace/global',
        `${channelPrefix}.md`,
      );
      if (channelOverride) {
        parts.push('## Channel Overrides\n' + channelOverride);
      }
    }
  }

  if (input.isScheduledTask) {
    parts.push(
      'This is a scheduled task running automatically, not a direct user message.',
    );
  }

  return parts.join('\n\n');
}
