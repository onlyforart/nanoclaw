import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildOllamaSystemPrompt, type PromptPaths } from './ollama-system-prompt.js';

describe('buildOllamaSystemPrompt', () => {
  let tmpDir: string;
  let paths: PromptPaths;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-prompt-test-'));
    paths = {
      agent: path.join(tmpDir, 'agent'),
      global: path.join(tmpDir, 'global'),
      systemMd: path.join(tmpDir, 'ollama-system.md'),
    };
    fs.mkdirSync(paths.agent, { recursive: true });
    fs.mkdirSync(paths.global, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('includes assistant name', () => {
    const prompt = buildOllamaSystemPrompt({ assistantName: 'Ziggy' }, paths);
    expect(prompt).toContain('Ziggy');
  });

  it('defaults assistant name to Andy', () => {
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('Andy');
  });

  it('includes base instructions from the systemMd path when it exists', () => {
    fs.writeFileSync(paths.systemMd, '## Base instructions\n\ntool rules here.');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('Base instructions');
    expect(prompt).toContain('tool rules here.');
  });

  it('omits base instructions section when systemMd does not exist', () => {
    // No file at paths.systemMd
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).not.toContain('Base instructions');
  });

  it('uses group OLLAMA.md when it exists', () => {
    fs.writeFileSync(path.join(paths.agent, 'OLLAMA.md'), 'ollama-specific instructions');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('ollama-specific instructions');
  });

  it('falls back to group CLAUDE.md when no group OLLAMA.md', () => {
    fs.writeFileSync(path.join(paths.agent, 'CLAUDE.md'), 'claude fallback content');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('claude fallback content');
  });

  it('prefers OLLAMA.md over CLAUDE.md when both exist in the agent folder', () => {
    fs.writeFileSync(path.join(paths.agent, 'OLLAMA.md'), 'ollama wins');
    fs.writeFileSync(path.join(paths.agent, 'CLAUDE.md'), 'claude loses');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('ollama wins');
    expect(prompt).not.toContain('claude loses');
  });

  it('uses global OLLAMA.md when it exists', () => {
    fs.writeFileSync(path.join(paths.global, 'OLLAMA.md'), 'global ollama memory');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('global ollama memory');
  });

  it('falls back to global CLAUDE.md when no global OLLAMA.md', () => {
    fs.writeFileSync(path.join(paths.global, 'CLAUDE.md'), 'global claude fallback');
    const prompt = buildOllamaSystemPrompt({}, paths);
    expect(prompt).toContain('global claude fallback');
  });

  it('always includes global memory regardless of group identity (v2 drops isMain)', () => {
    fs.writeFileSync(path.join(paths.global, 'OLLAMA.md'), 'global content');
    const prompt1 = buildOllamaSystemPrompt({ agentGroupFolder: 'main' }, paths);
    const prompt2 = buildOllamaSystemPrompt({ agentGroupFolder: 'slack_x' }, paths);
    expect(prompt1).toContain('global content');
    expect(prompt2).toContain('global content');
  });

  it('prefers CHANNEL_OLLAMA.md over CHANNEL.md for channel overrides', () => {
    fs.writeFileSync(path.join(paths.global, 'SLACK_OLLAMA.md'), 'slack ollama wins');
    fs.writeFileSync(path.join(paths.global, 'SLACK.md'), 'slack claude loses');
    const prompt = buildOllamaSystemPrompt({ agentGroupFolder: 'slack_main' }, paths);
    expect(prompt).toContain('slack ollama wins');
    expect(prompt).not.toContain('slack claude loses');
  });

  it('falls back to CHANNEL.md when CHANNEL_OLLAMA.md missing', () => {
    fs.writeFileSync(path.join(paths.global, 'SLACK.md'), 'slack formatting rules');
    const prompt = buildOllamaSystemPrompt({ agentGroupFolder: 'slack_main' }, paths);
    expect(prompt).toContain('slack formatting rules');
  });

  it('adds scheduled task note', () => {
    const prompt = buildOllamaSystemPrompt({ isScheduledTask: true }, paths);
    expect(prompt).toContain('scheduled task');
  });

  it('returns basic prompt when no memory files exist', () => {
    const prompt = buildOllamaSystemPrompt({ assistantName: 'nanopaul' }, paths);
    expect(prompt).toContain('nanopaul');
    expect(prompt).not.toContain('Group Memory');
    expect(prompt).not.toContain('Shared Memory');
    expect(prompt).not.toContain('Channel Overrides');
  });
});
