import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../group-folder.js';

interface PromptsResponse {
  claude: string;
  ollama: string | null;
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

export function handleGetGlobalPrompts(groupsDir: string): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');
  return {
    claude: readPrompt(path.join(globalDir, 'CLAUDE.md')) ?? '',
    ollama: readPrompt(path.join(globalDir, 'OLLAMA.md')),
  };
}

export function handlePutGlobalPrompts(
  groupsDir: string,
  body: { claude?: string; ollama?: string },
): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');

  if (body.claude !== undefined) {
    backupAndWrite(path.join(globalDir, 'CLAUDE.md'), body.claude);
  }
  if (body.ollama !== undefined) {
    backupAndWrite(path.join(globalDir, 'OLLAMA.md'), body.ollama);
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
