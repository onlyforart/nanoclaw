import fs from 'node:fs';
import path from 'node:path';

import { isValidGroupFolder } from '../group-folder.js';

interface PromptsResponse {
  claude: string;
  claudeLocal: string | null;
  claudeResolved: string;
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

const RESERVED_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'OLLAMA.md']);
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

// Container paths that appear in symlink targets (created by claude-md-compose
// for container-time path resolution) and their host-side equivalents under
// `<projectRoot>/container/...`. The webui's "resolved" view needs these
// remappings to read the actual file content from the host filesystem.
const APP_PATH_REMAPS: Array<{ prefix: string; toRel: string }> = [
  { prefix: '/app/CLAUDE.md', toRel: 'container/CLAUDE.md' },
  { prefix: '/app/src/mcp-tools/', toRel: 'container/agent-runner/src/mcp-tools/' },
  { prefix: '/app/skills/', toRel: 'container/skills/' },
];

function remapContainerPath(linkTarget: string, projectRoot: string): string | null {
  for (const { prefix, toRel } of APP_PATH_REMAPS) {
    if (linkTarget === prefix) {
      return path.join(projectRoot, toRel);
    }
    if (prefix.endsWith('/') && linkTarget.startsWith(prefix)) {
      return path.join(projectRoot, toRel, linkTarget.slice(prefix.length));
    }
  }
  return null;
}

/**
 * Resolve a CLAUDE.md file by inlining its `@./relative/path` imports —
 * matching the Claude Code SDK's at-import behaviour, but on the host so the
 * webui can show what the agent actually reads.
 *
 * Symlinks whose target points into `/app/...` (the container mount layout
 * created by `claude-md-compose`) are remapped to their host-side equivalent
 * under `<projectRoot>/container/...`. Missing files become a placeholder
 * comment rather than throwing.
 *
 * No nested at-import resolution today — current data shape (.claude-shared.md,
 * .claude-fragments/*.md, container.json-derived per-MCP instructions) is
 * single-level. Depth cap kept as a defensive bound.
 */
export function resolveClaudePrompt(
  claudeFilePath: string,
  groupDir: string,
  projectRoot: string,
): string {
  let raw: string;
  try {
    raw = fs.readFileSync(claudeFilePath, 'utf-8');
  } catch {
    return '';
  }
  const lines = raw.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^@(\S+)\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const importPath = m[1];
    out.push(`<!-- @${importPath} -->`);
    if (!importPath.startsWith('./')) {
      out.push(`<!-- (only ./ imports supported in resolver) -->`);
      continue;
    }
    const rel = importPath.slice(2);
    let target = path.join(groupDir, rel);
    try {
      const linkTarget = fs.readlinkSync(target);
      if (path.isAbsolute(linkTarget)) {
        const remapped = remapContainerPath(linkTarget, projectRoot);
        target = remapped ?? linkTarget;
      } else {
        target = path.resolve(path.dirname(target), linkTarget);
      }
    } catch {
      // Not a symlink; use target as-is.
    }
    try {
      out.push(fs.readFileSync(target, 'utf-8'));
    } catch {
      out.push(`<!-- missing: ${importPath} -->`);
    }
  }
  return out.join('\n');
}

function buildGlobalResponse(groupsDir: string): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');
  const projectRoot = path.dirname(groupsDir);
  return {
    claude: readPrompt(path.join(globalDir, 'CLAUDE.md')) ?? '',
    claudeLocal: readPrompt(path.join(globalDir, 'CLAUDE.local.md')),
    claudeResolved: resolveClaudePrompt(path.join(globalDir, 'CLAUDE.md'), globalDir, projectRoot),
    ollama: readPrompt(path.join(globalDir, 'OLLAMA.md')),
    channelOverrides: readChannelOverrides(globalDir),
  };
}

function buildGroupResponse(groupsDir: string, folder: string): PromptsResponse {
  const groupDir = path.join(groupsDir, folder);
  const projectRoot = path.dirname(groupsDir);
  return {
    claude: readPrompt(path.join(groupDir, 'CLAUDE.md')) ?? '',
    claudeLocal: readPrompt(path.join(groupDir, 'CLAUDE.local.md')),
    claudeResolved: resolveClaudePrompt(path.join(groupDir, 'CLAUDE.md'), groupDir, projectRoot),
    ollama: readPrompt(path.join(groupDir, 'OLLAMA.md')),
  };
}

export function handleGetGlobalPrompts(groupsDir: string): PromptsResponse {
  return buildGlobalResponse(groupsDir);
}

export function handlePutGlobalPrompts(
  groupsDir: string,
  body: { claude?: string; claudeLocal?: string; ollama?: string; channelOverrides?: Record<string, string> },
): PromptsResponse {
  const globalDir = path.join(groupsDir, 'global');

  if (body.claude !== undefined) {
    backupAndWrite(path.join(globalDir, 'CLAUDE.md'), body.claude);
  }
  if (body.claudeLocal !== undefined) {
    backupAndWrite(path.join(globalDir, 'CLAUDE.local.md'), body.claudeLocal);
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

  return buildGlobalResponse(groupsDir);
}

export function handleGetGroupPrompts(
  groupsDir: string,
  folder: string,
): PromptsResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) return null;

  return buildGroupResponse(groupsDir, folder);
}

export function handlePutGroupPrompts(
  groupsDir: string,
  folder: string,
  body: { claude?: string; claudeLocal?: string; ollama?: string },
): PromptsResponse | null {
  if (!isValidGroupFolder(folder)) return null;
  const groupDir = path.join(groupsDir, folder);
  if (!fs.existsSync(groupDir)) return null;

  if (body.claude !== undefined) {
    backupAndWrite(path.join(groupDir, 'CLAUDE.md'), body.claude);
  }
  if (body.claudeLocal !== undefined) {
    backupAndWrite(path.join(groupDir, 'CLAUDE.local.md'), body.claudeLocal);
  }
  if (body.ollama !== undefined) {
    backupAndWrite(path.join(groupDir, 'OLLAMA.md'), body.ollama);
  }

  return buildGroupResponse(groupsDir, folder);
}
