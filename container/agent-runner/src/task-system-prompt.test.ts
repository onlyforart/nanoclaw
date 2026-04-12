import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => ''),
    },
  };
});

import { buildTaskSystemPrompt } from './task-system-prompt.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
});

function baseInput(overrides?: Record<string, unknown>) {
  return {
    assistantName: 'nanopaul',
    isMain: false,
    groupFolder: 'slack_main',
    ...overrides,
  };
}

describe('buildTaskSystemPrompt', () => {
  it('includes assistant name', () => {
    const prompt = buildTaskSystemPrompt(baseInput({ assistantName: 'Ziggy' }));
    expect(prompt).toContain('Ziggy');
  });

  it('defaults assistant name to Andy', () => {
    const prompt = buildTaskSystemPrompt(baseInput({ assistantName: undefined }));
    expect(prompt).toContain('Andy');
  });

  it('reads CLAUDE.md for group memory (never OLLAMA.md)', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return String(p) === '/workspace/group/CLAUDE.md';
    });
    mockReadFileSync.mockReturnValue('group claude content');

    const prompt = buildTaskSystemPrompt(baseInput());
    expect(prompt).toContain('group claude content');

    // Must NOT check for OLLAMA.md in the group directory
    const groupPaths = checkedPaths.filter((p) => p.startsWith('/workspace/group'));
    expect(groupPaths).toEqual(['/workspace/group/CLAUDE.md']);
  });

  it('reads CLAUDE.md for global shared memory (never OLLAMA.md)', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return String(p) === '/workspace/global/CLAUDE.md';
    });
    mockReadFileSync.mockReturnValue('global claude content');

    const prompt = buildTaskSystemPrompt(baseInput({ isMain: false }));
    expect(prompt).toContain('global claude content');

    const globalMemoryPaths = checkedPaths.filter(
      (p) => p.startsWith('/workspace/global/CLAUDE') || p.startsWith('/workspace/global/OLLAMA'),
    );
    expect(globalMemoryPaths).toEqual(['/workspace/global/CLAUDE.md']);
  });

  it('does NOT load OLLAMA-SYSTEM.md base instructions', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return false;
    });

    buildTaskSystemPrompt(baseInput());

    expect(checkedPaths).not.toContain('/workspace/project/container/OLLAMA-SYSTEM.md');
    // Should not check any /workspace/project paths
    const projectPaths = checkedPaths.filter((p) => p.startsWith('/workspace/project'));
    expect(projectPaths).toHaveLength(0);
  });

  it('skips global memory for main group', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('should not appear');

    const prompt = buildTaskSystemPrompt(baseInput({ isMain: true }));
    expect(prompt).not.toContain('Shared Memory');
  });

  it('includes channel overrides from CHANNEL.md (not CHANNEL_OLLAMA.md)', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return String(p) === '/workspace/global/SLACK.md';
    });
    mockReadFileSync.mockReturnValue('slack formatting rules');

    const prompt = buildTaskSystemPrompt(baseInput({ groupFolder: 'slack_main' }));
    expect(prompt).toContain('slack formatting rules');

    // Should check SLACK.md, never SLACK_OLLAMA.md
    const channelPaths = checkedPaths.filter((p) => p.includes('SLACK'));
    expect(channelPaths).toEqual(['/workspace/global/SLACK.md']);
  });

  it('adds scheduled task note', () => {
    const prompt = buildTaskSystemPrompt(baseInput({ isScheduledTask: true }));
    expect(prompt).toContain('scheduled task');
  });

  it('returns basic prompt when no memory files exist', () => {
    const prompt = buildTaskSystemPrompt(baseInput());
    expect(prompt).toContain('nanopaul');
    expect(prompt).not.toContain('Group Memory');
    expect(prompt).not.toContain('Shared Memory');
  });
});
