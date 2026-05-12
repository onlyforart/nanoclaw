import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { handleGetGlobalPrompts, handlePutGlobalPrompts, handleGetGroupPrompts, handlePutGroupPrompts } from './prompts.js';

let tmpDir: string;
let groupsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-prompts-test-'));
  groupsDir = path.join(tmpDir, 'groups');
  fs.mkdirSync(path.join(groupsDir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(groupsDir, 'slack_main'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// --- Global prompts ---

describe('handleGetGlobalPrompts', () => {
  it('returns both prompts when files exist', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# Global', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'global', 'OLLAMA.md'), '# Ollama', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.claude).toBe('# Global');
    expect(result.ollama).toBe('# Ollama');
  });

  it('returns null for missing OLLAMA.md', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# Global', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.claude).toBe('# Global');
    expect(result.ollama).toBeNull();
  });

  it('returns empty string for empty CLAUDE.md', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.claude).toBe('');
  });
});

describe('handlePutGlobalPrompts', () => {
  it('writes CLAUDE.md and backs up existing', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), 'old', 'utf-8');

    handlePutGlobalPrompts(groupsDir, { claude: 'new content' });

    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), 'utf-8')).toBe('new content');
    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.md.bak'), 'utf-8')).toBe('old');
  });

  it('writes OLLAMA.md', () => {
    handlePutGlobalPrompts(groupsDir, { ollama: '# Ollama prompt' });

    expect(fs.readFileSync(path.join(groupsDir, 'global', 'OLLAMA.md'), 'utf-8')).toBe('# Ollama prompt');
  });

  it('writes both files at once', () => {
    handlePutGlobalPrompts(groupsDir, { claude: 'claude', ollama: 'ollama' });

    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), 'utf-8')).toBe('claude');
    expect(fs.readFileSync(path.join(groupsDir, 'global', 'OLLAMA.md'), 'utf-8')).toBe('ollama');
  });

  it('does not create backup when file does not exist', () => {
    handlePutGlobalPrompts(groupsDir, { claude: 'first write' });

    expect(fs.existsSync(path.join(groupsDir, 'global', 'CLAUDE.md.bak'))).toBe(false);
    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), 'utf-8')).toBe('first write');
  });

  it('returns updated state', () => {
    const result = handlePutGlobalPrompts(groupsDir, { claude: 'c', ollama: 'o' });
    expect(result.claude).toBe('c');
    expect(result.ollama).toBe('o');
  });

  it('writes channel overrides', () => {
    handlePutGlobalPrompts(groupsDir, { channelOverrides: { slack: '# Slack formatting' } });

    expect(fs.readFileSync(path.join(groupsDir, 'global', 'SLACK.md'), 'utf-8')).toBe('# Slack formatting');
  });

  it('removes channel override when content is empty', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'SLACK.md'), 'old', 'utf-8');

    handlePutGlobalPrompts(groupsDir, { channelOverrides: { slack: '' } });

    expect(fs.existsSync(path.join(groupsDir, 'global', 'SLACK.md'))).toBe(false);
  });

  it('returns channel overrides in response', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'SLACK.md'), '# Slack', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'global', 'TELEGRAM.md'), '# Telegram', 'utf-8');

    const result = handlePutGlobalPrompts(groupsDir, { claude: 'c' });
    expect(result.channelOverrides).toEqual({ slack: '# Slack', telegram: '# Telegram' });
  });

  it('ignores reserved file names in channel overrides', () => {
    handlePutGlobalPrompts(groupsDir, { channelOverrides: { claude: 'hack', ollama: 'hack' } });

    // CLAUDE.md and OLLAMA.md should not be overwritten via channelOverrides
    expect(fs.existsSync(path.join(groupsDir, 'global', 'CLAUDE.md'))).toBe(false);
  });
});

// --- Global prompts: channel overrides in GET ---

describe('handleGetGlobalPrompts channel overrides', () => {
  it('returns channel overrides from global directory', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# Global', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'global', 'SLACK.md'), '# Slack', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.channelOverrides).toEqual({ slack: '# Slack' });
  });

  it('excludes CLAUDE.md and OLLAMA.md from channel overrides', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# C', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'global', 'OLLAMA.md'), '# O', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.channelOverrides).toEqual({});
  });

  it('returns empty overrides when no channel files exist', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# C', 'utf-8');

    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.channelOverrides).toEqual({});
  });
});

// --- Group prompts ---

describe('handleGetGroupPrompts', () => {
  it('returns prompts for a valid group folder', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '# Slack', 'utf-8');

    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result).not.toBeNull();
    expect(result!.claude).toBe('# Slack');
    expect(result!.ollama).toBeNull();
  });

  it('returns null for invalid folder name', () => {
    expect(handleGetGroupPrompts(groupsDir, '../../etc')).toBeNull();
  });

  it('returns null for reserved folder "global"', () => {
    expect(handleGetGroupPrompts(groupsDir, 'global')).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handleGetGroupPrompts(groupsDir, 'nonexistent')).toBeNull();
  });
});

describe('handlePutGroupPrompts', () => {
  it('writes and backs up group prompt', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), 'old', 'utf-8');

    const result = handlePutGroupPrompts(groupsDir, 'slack_main', { claude: 'new' });
    expect(result).not.toBeNull();
    expect(result!.claude).toBe('new');
    expect(fs.readFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md.bak'), 'utf-8')).toBe('old');
  });

  it('returns null for invalid folder', () => {
    expect(handlePutGroupPrompts(groupsDir, '../bad', { claude: 'x' })).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handlePutGroupPrompts(groupsDir, 'nonexistent', { claude: 'x' })).toBeNull();
  });
});

// --- CLAUDE.local.md (per-group operator memory) ---

describe('handleGetGroupPrompts — CLAUDE.local.md', () => {
  it('returns null when CLAUDE.local.md is missing', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '# Slack', 'utf-8');
    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result).not.toBeNull();
    expect(result!.claudeLocal).toBeNull();
  });

  it('returns content when CLAUDE.local.md exists', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md'), '# Operator memory\nfoo', 'utf-8');
    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeLocal).toBe('# Operator memory\nfoo');
  });

  it('returns empty string when CLAUDE.local.md is an empty file', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md'), '', 'utf-8');
    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeLocal).toBe('');
  });
});

describe('handlePutGroupPrompts — CLAUDE.local.md', () => {
  it('writes CLAUDE.local.md when provided', () => {
    handlePutGroupPrompts(groupsDir, 'slack_main', { claudeLocal: '# memory' });
    expect(fs.readFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md'), 'utf-8')).toBe('# memory');
  });

  it('backs up existing CLAUDE.local.md before overwriting', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md'), 'old', 'utf-8');
    handlePutGroupPrompts(groupsDir, 'slack_main', { claudeLocal: 'new' });
    expect(fs.readFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md'), 'utf-8')).toBe('new');
    expect(fs.readFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.local.md.bak'), 'utf-8')).toBe('old');
  });

  it('returns updated state including claudeLocal', () => {
    const result = handlePutGroupPrompts(groupsDir, 'slack_main', { claudeLocal: 'mem' });
    expect(result!.claudeLocal).toBe('mem');
  });

  it('preserves CLAUDE.md when only writing claudeLocal', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '@./.claude-shared.md', 'utf-8');
    handlePutGroupPrompts(groupsDir, 'slack_main', { claudeLocal: 'mem' });
    expect(fs.readFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), 'utf-8')).toBe('@./.claude-shared.md');
  });
});

describe('handleGetGlobalPrompts — CLAUDE.local.md', () => {
  it('returns content when global CLAUDE.local.md exists', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.local.md'), '# global memory', 'utf-8');
    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.claudeLocal).toBe('# global memory');
  });

  it('returns null when global CLAUDE.local.md missing', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.md'), '# Global', 'utf-8');
    const result = handleGetGlobalPrompts(groupsDir);
    expect(result.claudeLocal).toBeNull();
  });
});

describe('handlePutGlobalPrompts — CLAUDE.local.md', () => {
  it('writes global CLAUDE.local.md when provided', () => {
    handlePutGlobalPrompts(groupsDir, { claudeLocal: '# memory' });
    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.local.md'), 'utf-8')).toBe('# memory');
  });

  it('backs up existing global CLAUDE.local.md before overwriting', () => {
    fs.writeFileSync(path.join(groupsDir, 'global', 'CLAUDE.local.md'), 'old', 'utf-8');
    handlePutGlobalPrompts(groupsDir, { claudeLocal: 'new' });
    expect(fs.readFileSync(path.join(groupsDir, 'global', 'CLAUDE.local.md.bak'), 'utf-8')).toBe('old');
  });
});

// --- Resolved view (@ imports inlined) ---

describe('handleGetGroupPrompts — claudeResolved', () => {
  it('returns the raw CLAUDE.md content when there are no @-imports', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '# Just plain text', 'utf-8');
    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeResolved).toContain('# Just plain text');
  });

  it('inlines a relative @./ import', () => {
    fs.mkdirSync(path.join(groupsDir, 'slack_main', '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'slack_main', '.claude-fragments', 'foo.md'), 'FRAG-CONTENT', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '@./.claude-fragments/foo.md\n', 'utf-8');

    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeResolved).toContain('FRAG-CONTENT');
  });

  it('emits a placeholder for missing @-imports rather than throwing', () => {
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '@./.does-not-exist.md\n', 'utf-8');
    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeResolved).toContain('missing');
    expect(result!.claudeResolved).toContain('.does-not-exist.md');
  });

  it('resolves a symlink whose target is /app/CLAUDE.md to container/CLAUDE.md on the host', () => {
    // The host layout: project root contains both `groups/` and `container/`.
    const projectRoot = tmpDir;
    fs.mkdirSync(path.join(projectRoot, 'container'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'container', 'CLAUDE.md'), 'SHARED-BASE-CONTENT', 'utf-8');

    fs.symlinkSync('/app/CLAUDE.md', path.join(groupsDir, 'slack_main', '.claude-shared.md'));
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '@./.claude-shared.md\n', 'utf-8');

    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeResolved).toContain('SHARED-BASE-CONTENT');
  });

  it('resolves a symlink to /app/src/mcp-tools/<x>.instructions.md to container/agent-runner/src/mcp-tools/<x>.instructions.md', () => {
    const projectRoot = tmpDir;
    const mcpDir = path.join(projectRoot, 'container', 'agent-runner', 'src', 'mcp-tools');
    fs.mkdirSync(mcpDir, { recursive: true });
    fs.writeFileSync(path.join(mcpDir, 'core.instructions.md'), 'CORE-MODULE-INSTRUCTIONS', 'utf-8');

    fs.mkdirSync(path.join(groupsDir, 'slack_main', '.claude-fragments'), { recursive: true });
    fs.symlinkSync('/app/src/mcp-tools/core.instructions.md', path.join(groupsDir, 'slack_main', '.claude-fragments', 'module-core.md'));
    fs.writeFileSync(path.join(groupsDir, 'slack_main', 'CLAUDE.md'), '@./.claude-fragments/module-core.md\n', 'utf-8');

    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    expect(result!.claudeResolved).toContain('CORE-MODULE-INSTRUCTIONS');
  });

  it('handles multiple @-imports in order, preserving plain lines between them', () => {
    fs.mkdirSync(path.join(groupsDir, 'slack_main', '.claude-fragments'), { recursive: true });
    fs.writeFileSync(path.join(groupsDir, 'slack_main', '.claude-fragments', 'a.md'), 'AAA', 'utf-8');
    fs.writeFileSync(path.join(groupsDir, 'slack_main', '.claude-fragments', 'b.md'), 'BBB', 'utf-8');
    fs.writeFileSync(
      path.join(groupsDir, 'slack_main', 'CLAUDE.md'),
      '@./.claude-fragments/a.md\nplain-line\n@./.claude-fragments/b.md\n',
      'utf-8',
    );

    const result = handleGetGroupPrompts(groupsDir, 'slack_main');
    const r = result!.claudeResolved;
    expect(r.indexOf('AAA')).toBeGreaterThan(-1);
    expect(r.indexOf('plain-line')).toBeGreaterThan(r.indexOf('AAA'));
    expect(r.indexOf('BBB')).toBeGreaterThan(r.indexOf('plain-line'));
  });
});
