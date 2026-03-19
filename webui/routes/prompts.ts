import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../group-folder.js';

interface PromptsResponse {
  claude: string;
  ollama: string | null;
  channelOverrides?: Record<string, string>;
}

function readPrompt(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function backupAndWrite(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) {
    fs.renameSync(filePath, filePath + '.bak');
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

const RESERVED_FILES = new Set(['CLAUDE.md', 'OLLAMA.md']);
const CHANNEL_FILE_RE = /^[A-Z]+\.md$/;

function readChannelOverrides(globalDir: string): Record<string, string> {
  const overrides: Record<string, string> = {};
  try {
    for (const file of fs.readdirSync(globalDir)) {
      if (RESERVED_FILES.has(file) || !CHANNEL_FILE_RE.test(file)) continue;
      const content = readPrompt(path.join(globalDir, file));
      if (content !== null) {
        const channel = file.replace(/\.md$/, '').toLowerCase();
        overrides[channel] = content;
      }
    }
  } catch {
    // globalDir doesn't exist or can't be read
  }
  return overrides;
}

export function handleGetGlobalPrompts(groupsDir: string): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');
  return {
    claude: readPrompt(path.join(globalDir, 'CLAUDE.md')) ?? '',
    ollama: readPrompt(path.join(globalDir, 'OLLAMA.md')),
    channelOverrides: readChannelOverrides(globalDir),
  };
}

export function handlePutGlobalPrompts(
  groupsDir: string,
  body: { claude?: string; ollama?: string; channelOverrides?: Record<string, string> },
): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');

  if (body.claude !== undefined) {
    backupAndWrite(path.join(globalDir, 'CLAUDE.md'), body.claude);
  }
  if (body.ollama !== undefined) {
    backupAndWrite(path.join(globalDir, 'OLLAMA.md'), body.ollama);
  }
  if (body.channelOverrides) {
    for (const [channel, content] of Object.entries(body.channelOverrides)) {
      const fileName = channel.toUpperCase() + '.md';
      if (RESERVED_FILES.has(fileName) || !CHANNEL_FILE_RE.test(fileName)) continue;
      const filePath = path.join(globalDir, fileName);
      if (content === '') {
        // Empty content removes the override
        try { fs.unlinkSync(filePath); } catch { /* didn't exist */ }
      } else {
        backupAndWrite(filePath, content);
      }
    }
  }

  return handleGetGlobalPrompts(groupsDir);
}

export function handleGetGroupPrompts(
  groupsDir: string,
  folder: string,
): PromptsResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) return null;

  return {
    claude: readPrompt(path.join(groupDir, 'CLAUDE.md')) ?? '',
    ollama: readPrompt(path.join(groupDir, 'OLLAMA.md')),
  };
}

export function handlePutGroupPrompts(
  groupsDir: string,
  folder: string,
  body: { claude?: string; ollama?: string },
): PromptsResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) return null;

  if (body.claude !== undefined) {
    backupAndWrite(path.join(groupDir, 'CLAUDE.md'), body.claude);
  }
  if (body.ollama !== undefined) {
    backupAndWrite(path.join(groupDir, 'OLLAMA.md'), body.ollama);
  }

  return handleGetGroupPrompts(groupsDir, folder);
}
