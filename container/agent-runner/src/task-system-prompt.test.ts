import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildTaskSystemPrompt, type PromptPaths } from './task-system-prompt.js';

describe('buildTaskSystemPrompt', () => {
  let tmpDir: string;
  let paths: PromptPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-prompt-test-'));
    paths = {
      agent: path.join(tmpDir, 'agent'),
      global: path.join(tmpDir, 'global'),
    };
    fs.mkdirSync(paths.agent, { recursive: true });
    fs.mkdirSync(paths.global, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes assistant name', () => {
    const prompt = buildTaskSystemPrompt({ assistantName: 'Ziggy' }, paths);
    expect(prompt).toContain('Ziggy');
  });

  it('defaults assistant name to Andy', () => {
    const prompt = buildTaskSystemPrompt({}, paths);
    expect(prompt).toContain('Andy');
  });

  it('reads CLAUDE.md for group memory (never OLLAMA.md)', () => {
    fs.writeFileSync(path.join(paths.agent, 'CLAUDE.md'), 'group claude content');
    fs.writeFileSync(path.join(paths.agent, 'OLLAMA.md'), 'should NOT appear');
    const prompt = buildTaskSystemPrompt({}, paths);
    expect(prompt).toContain('group claude content');
    expect(prompt).not.toContain('should NOT appear');
  });

  it('reads CLAUDE.md for global shared memory (never OLLAMA.md)', () => {
    fs.writeFileSync(path.join(paths.global, 'CLAUDE.md'), 'global claude content');
    fs.writeFileSync(path.join(paths.global, 'OLLAMA.md'), 'should NOT appear');
    const prompt = buildTaskSystemPrompt({}, paths);
    expect(prompt).toContain('global claude content');
    expect(prompt).not.toContain('should NOT appear');
  });

  it('does NOT reference any /workspace/project path (v2 dropped that mount)', () => {
    // Smoke test: with no files anywhere the function should return without throwing
    // and without trying to read from a v1-style /workspace/project path.
    const prompt = buildTaskSystemPrompt({ assistantName: 'A' }, paths);
    expect(prompt).toContain('A');
  });

  it('includes channel overrides from CHANNEL.md (not CHANNEL_OLLAMA.md)', () => {
    fs.writeFileSync(path.join(paths.global, 'SLACK.md'), 'slack formatting rules');
    fs.writeFileSync(path.join(paths.global, 'SLACK_OLLAMA.md'), 'should NOT appear');
    const prompt = buildTaskSystemPrompt({ agentGroupFolder: 'slack_main' }, paths);
    expect(prompt).toContain('slack formatting rules');
    expect(prompt).not.toContain('should NOT appear');
  });

  it('always includes global memory regardless of group identity (v2 drops isMain)', () => {
    fs.writeFileSync(path.join(paths.global, 'CLAUDE.md'), 'global content');
    // v1 had `isMain: true` skip global; v2 always includes.
    const prompt1 = buildTaskSystemPrompt({ agentGroupFolder: 'main' }, paths);
    const prompt2 = buildTaskSystemPrompt({ agentGroupFolder: 'slack_x' }, paths);
    expect(prompt1).toContain('global content');
    expect(prompt2).toContain('global content');
  });

  it('adds scheduled task note', () => {
    const prompt = buildTaskSystemPrompt({ isScheduledTask: true }, paths);
    expect(prompt).toContain('scheduled task');
  });

  it('omits scheduled task note when isScheduledTask is false/unset', () => {
    const prompt = buildTaskSystemPrompt({}, paths);
    expect(prompt).not.toContain('scheduled task');
  });

  it('returns basic prompt when no memory files exist', () => {
    const prompt = buildTaskSystemPrompt({ assistantName: 'nanopaul' }, paths);
    expect(prompt).toContain('nanopaul');
    expect(prompt).not.toContain('Group Memory');
    expect(prompt).not.toContain('Shared Memory');
    expect(prompt).not.toContain('Channel Overrides');
  });
});
