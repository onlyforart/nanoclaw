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
