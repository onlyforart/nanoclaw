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

import { buildOllamaSystemPrompt } from './ollama-system-prompt.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('');
});

function baseInput(overrides?: Record<string, unknown>) {
  return {
    prompt: 'test',
    groupFolder: 'test-group',
    chatJid: 'test@g.us',
    isMain: false,
    assistantName: 'Andy',
    ...overrides,
  };
}

describe('buildOllamaSystemPrompt', () => {
  it('includes assistant name', () => {
    const prompt = buildOllamaSystemPrompt(baseInput({ assistantName: 'Ziggy' }));
    expect(prompt).toContain('Ziggy');
  });

  it('defaults assistant name to Andy', () => {
    const prompt = buildOllamaSystemPrompt(baseInput({ assistantName: undefined }));
    expect(prompt).toContain('Andy');
  });

  it('uses group OLLAMA.md when it exists', () => {
    mockExistsSync.mockImplementation((p) =>
      String(p) === '/workspace/group/OLLAMA.md',
    );
    mockReadFileSync.mockReturnValue('ollama-specific instructions');

    const prompt = buildOllamaSystemPrompt(baseInput());
    expect(prompt).toContain('ollama-specific instructions');
  });

  it('falls back to group CLAUDE.md when no OLLAMA.md', () => {
    mockExistsSync.mockImplementation((p) =>
      String(p) === '/workspace/group/CLAUDE.md',
    );
    mockReadFileSync.mockReturnValue('claude fallback content');

    const prompt = buildOllamaSystemPrompt(baseInput());
    expect(prompt).toContain('claude fallback content');
  });

  it('prefers OLLAMA.md over CLAUDE.md when both exist', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('OLLAMA.md')) return 'ollama wins';
      return 'claude loses';
    });

    const prompt = buildOllamaSystemPrompt(baseInput());
    expect(prompt).toContain('ollama wins');
    expect(prompt).not.toContain('claude loses');
  });

  it('uses global OLLAMA.md when it exists (non-main)', () => {
    mockExistsSync.mockImplementation((p) =>
      String(p) === '/workspace/global/OLLAMA.md',
    );
    mockReadFileSync.mockReturnValue('global ollama memory');

    const prompt = buildOllamaSystemPrompt(baseInput({ isMain: false }));
    expect(prompt).toContain('global ollama memory');
  });

  it('falls back to global CLAUDE.md when no global OLLAMA.md', () => {
    mockExistsSync.mockImplementation((p) =>
      String(p) === '/workspace/global/CLAUDE.md',
    );
    mockReadFileSync.mockReturnValue('global claude fallback');

    const prompt = buildOllamaSystemPrompt(baseInput({ isMain: false }));
    expect(prompt).toContain('global claude fallback');
  });

  it('skips global memory for main group', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('should not appear');

    const prompt = buildOllamaSystemPrompt(baseInput({ isMain: true }));
    expect(prompt).not.toContain('Shared Memory');
  });

  it('adds scheduled task note', () => {
    const prompt = buildOllamaSystemPrompt(baseInput({ isScheduledTask: true }));
    expect(prompt).toContain('scheduled task');
  });

  it('returns basic prompt when no memory files exist', () => {
    const prompt = buildOllamaSystemPrompt(baseInput());
    expect(prompt).toContain('Andy');
    expect(prompt).not.toContain('Group Memory');
    expect(prompt).not.toContain('Shared Memory');
  });

  it('never reads from /workspace/project (root CLAUDE.md is for Claude Code, not agents)', () => {
    const checkedPaths: string[] = [];
    mockExistsSync.mockImplementation((p) => {
      checkedPaths.push(String(p));
      return false;
    });

    buildOllamaSystemPrompt(baseInput());

    const projectPaths = checkedPaths.filter((p) => p.startsWith('/workspace/project'));
    expect(projectPaths).toHaveLength(0);
  });

});
