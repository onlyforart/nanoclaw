import { describe, it, expect } from 'bun:test';

import { selectEngine } from './engine-selector.js';

describe('selectEngine', () => {
  describe('SDK path (default)', () => {
    it('routes bare model names to sdk', () => {
      expect(selectEngine({ model: 'haiku' })).toEqual({ kind: 'sdk', model: 'haiku' });
    });

    it('routes undefined model to sdk with undefined model', () => {
      expect(selectEngine({})).toEqual({ kind: 'sdk', model: undefined });
    });

    it('strips claude: prefix and routes to sdk', () => {
      expect(selectEngine({ model: 'claude:haiku' })).toEqual({ kind: 'sdk', model: 'haiku' });
    });

    it('strips claude: prefix when value contains a colon in the suffix', () => {
      // "claude:claude-haiku-4-5-20251001" — prefix only stripped once
      expect(selectEngine({ model: 'claude:claude-haiku-4-5-20251001' })).toEqual({
        kind: 'sdk',
        model: 'claude-haiku-4-5-20251001',
      });
    });

    it('routes scheduled task to sdk when useAgentSdk is explicitly true', () => {
      // useAgentSdk=true overrides the scheduled→anthropic-api rule
      expect(selectEngine({ model: 'haiku', isScheduledTask: true, useAgentSdk: true })).toEqual({
        kind: 'sdk',
        model: 'haiku',
      });
    });
  });

  describe('Ollama path', () => {
    it('routes ollama: prefix to ollama (local)', () => {
      expect(selectEngine({ model: 'ollama:qwen3' })).toEqual({
        kind: 'ollama',
        model: 'qwen3',
        remote: false,
      });
    });

    it('routes ollama-remote: prefix to ollama (remote)', () => {
      expect(selectEngine({ model: 'ollama-remote:qwen3' })).toEqual({
        kind: 'ollama',
        model: 'qwen3',
        remote: true,
      });
    });

    it('preserves model tags after prefix strip', () => {
      expect(selectEngine({ model: 'ollama:lfm2:24b-bf16' })).toEqual({
        kind: 'ollama',
        model: 'lfm2:24b-bf16',
        remote: false,
      });
    });

    it('routes ollama: scheduled task to ollama (ollama beats scheduled rule)', () => {
      expect(selectEngine({ model: 'ollama:qwen3', isScheduledTask: true })).toEqual({
        kind: 'ollama',
        model: 'qwen3',
        remote: false,
      });
    });
  });

  describe('Anthropic API path', () => {
    it('routes anthropic: prefix to anthropic-api', () => {
      expect(selectEngine({ model: 'anthropic:haiku' })).toEqual({
        kind: 'anthropic-api',
        model: 'haiku',
      });
    });

    it('routes scheduled task with bare model to anthropic-api', () => {
      // useAgentSdk undefined → falsy → anthropic-api wins
      expect(selectEngine({ model: 'haiku', isScheduledTask: true })).toEqual({
        kind: 'anthropic-api',
        model: 'haiku',
      });
    });

    it('routes scheduled task with useAgentSdk: false to anthropic-api', () => {
      expect(selectEngine({ model: 'haiku', isScheduledTask: true, useAgentSdk: false })).toEqual({
        kind: 'anthropic-api',
        model: 'haiku',
      });
    });

    it('routes scheduled task with claude: prefix to anthropic-api (prefix stripped, then scheduled rule)', () => {
      // claude: is documentary only; the scheduled+!useAgentSdk rule still applies
      expect(selectEngine({ model: 'claude:haiku', isScheduledTask: true })).toEqual({
        kind: 'anthropic-api',
        model: 'haiku',
      });
    });

    it('routes scheduled task with undefined model to anthropic-api', () => {
      expect(selectEngine({ isScheduledTask: true })).toEqual({
        kind: 'anthropic-api',
        model: undefined,
      });
    });

    it('routes anthropic: scheduled task to anthropic-api regardless of useAgentSdk', () => {
      // anthropic: prefix is explicit; useAgentSdk doesn't override
      expect(selectEngine({ model: 'anthropic:haiku', isScheduledTask: true, useAgentSdk: true })).toEqual({
        kind: 'anthropic-api',
        model: 'haiku',
      });
    });
  });

  describe('precedence', () => {
    it('ollama: prefix beats anthropic: scheduled rule', () => {
      // ollama check happens before anthropic/scheduled check in v1's routing order
      expect(selectEngine({ model: 'ollama:qwen3', isScheduledTask: true, useAgentSdk: false })).toEqual({
        kind: 'ollama',
        model: 'qwen3',
        remote: false,
      });
    });

    it('claude: prefix is stripped before any other rule applies', () => {
      // claude:ollama:foo would be stripped to "ollama:foo" then routed to ollama
      // (this is an edge case — operator wouldn't write this — but documents the spec)
      expect(selectEngine({ model: 'claude:ollama:qwen3' })).toEqual({
        kind: 'ollama',
        model: 'qwen3',
        remote: false,
      });
    });
  });
});
