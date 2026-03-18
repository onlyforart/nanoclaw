import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// Mock readEnvFile before importing the module under test
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({}),
}));

// Mock config.js to avoid side effects
vi.mock('./config.js', () => ({
  CONTAINER_TIMEOUT: 1_800_000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  IDLE_TIMEOUT: 1_800_000,
}));

// Mock fs for backend-defaults.json
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

import { resolveProfile, isOllamaModel } from './connection-profiles.js';
import { readEnvFile } from './env.js';

const mockedReadEnvFile = vi.mocked(readEnvFile);
const mockedExistsSync = vi.mocked(fs.existsSync);
const mockedReadFileSync = vi.mocked(fs.readFileSync);

beforeEach(() => {
  mockedReadEnvFile.mockReturnValue({});
  mockedExistsSync.mockReturnValue(false);
});

describe('isOllamaModel', () => {
  it('returns false for undefined', () => {
    expect(isOllamaModel(undefined)).toBe(false);
  });

  it('returns false for Claude model aliases', () => {
    expect(isOllamaModel('haiku')).toBe(false);
    expect(isOllamaModel('sonnet')).toBe(false);
    expect(isOllamaModel('opus')).toBe(false);
  });

  it('returns true for ollama: prefix', () => {
    expect(isOllamaModel('ollama:qwen3')).toBe(true);
  });

  it('returns true for ollama-remote: prefix', () => {
    expect(isOllamaModel('ollama-remote:mistral')).toBe(true);
  });
});

describe('resolveProfile', () => {
  describe('Claude backend (default)', () => {
    it('returns claude backend for undefined model', () => {
      const profile = resolveProfile(undefined);
      expect(profile.backend).toBe('claude');
      expect(profile.ollamaHost).toBeUndefined();
      expect(profile.ollamaModel).toBeUndefined();
    });

    it('returns claude backend for named Claude models', () => {
      for (const model of ['haiku', 'sonnet', 'opus']) {
        const profile = resolveProfile(model);
        expect(profile.backend).toBe('claude');
      }
    });

    it('uses CONTAINER_TIMEOUT as default timeoutMs', () => {
      const profile = resolveProfile(undefined);
      expect(profile.timeoutMs).toBe(1_800_000);
      expect(profile.containerTimeoutMs).toBe(1_800_000);
    });

    it('uses IDLE_TIMEOUT as idleTimeoutMs', () => {
      const profile = resolveProfile(undefined);
      expect(profile.idleTimeoutMs).toBe(1_800_000);
    });

    it('sets maxToolRounds to 0 (unlimited) for Claude', () => {
      const profile = resolveProfile('sonnet');
      expect(profile.maxToolRounds).toBe(0);
    });

    it('applies per-group/task overrides over defaults', () => {
      const profile = resolveProfile('sonnet', {
        timeoutMs: 60_000,
        maxToolRounds: 5,
      });
      expect(profile.timeoutMs).toBe(60_000);
      expect(profile.containerTimeoutMs).toBe(60_000);
      expect(profile.maxToolRounds).toBe(5);
    });
  });

  describe('Ollama backend (local)', () => {
    it('returns ollama backend for ollama: prefix', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.backend).toBe('ollama');
      expect(profile.ollamaModel).toBe('qwen3');
    });

    it('reads OLLAMA_HOST from env', () => {
      mockedReadEnvFile.mockReturnValue({
        OLLAMA_HOST: 'http://myhost:11434',
      });
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.ollamaHost).toBe('http://myhost:11434');
    });

    it('falls back to host.docker.internal for local ollama', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.ollamaHost).toBe('http://host.docker.internal:11434');
    });

    it('uses hardcoded 5 min default timeout when no config file', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.timeoutMs).toBe(300_000);
    });

    it('sets containerTimeoutMs to timeout + 1 min grace', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.containerTimeoutMs).toBe(360_000);
    });

    it('uses 30s idle timeout', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.idleTimeoutMs).toBe(30_000);
    });

    it('defaults maxToolRounds to 10 when no config file', () => {
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.maxToolRounds).toBe(10);
    });

    it('applies per-group/task overrides', () => {
      const profile = resolveProfile('ollama:qwen3', {
        maxToolRounds: 20,
        timeoutMs: 600_000,
      });
      expect(profile.maxToolRounds).toBe(20);
      expect(profile.timeoutMs).toBe(600_000);
      expect(profile.containerTimeoutMs).toBe(660_000);
    });
  });

  describe('Ollama backend (remote)', () => {
    it('returns ollama backend for ollama-remote: prefix', () => {
      const profile = resolveProfile('ollama-remote:mistral');
      expect(profile.backend).toBe('ollama');
      expect(profile.ollamaModel).toBe('mistral');
    });

    it('reads OLLAMA_REMOTE_HOST from env', () => {
      mockedReadEnvFile.mockReturnValue({
        OLLAMA_REMOTE_HOST: 'http://192.168.1.100:11434',
      });
      const profile = resolveProfile('ollama-remote:mistral');
      expect(profile.ollamaHost).toBe('http://192.168.1.100:11434');
    });

    it('falls back to localhost for remote ollama', () => {
      const profile = resolveProfile('ollama-remote:mistral');
      expect(profile.ollamaHost).toBe('http://localhost:11434');
    });
  });

  describe('backend-defaults.json config file', () => {
    function mockConfigFile(config: Record<string, unknown>) {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify(config));
    }

    it('reads Claude defaults from config file', () => {
      mockConfigFile({
        claude: { maxToolRounds: 25, timeoutMs: 900_000 },
      });

      const profile = resolveProfile('sonnet');
      expect(profile.maxToolRounds).toBe(25);
      expect(profile.timeoutMs).toBe(900_000);
    });

    it('reads Ollama defaults from config file', () => {
      mockConfigFile({
        ollama: { maxToolRounds: 15, timeoutMs: 120_000 },
      });

      const profile = resolveProfile('ollama:qwen3');
      expect(profile.maxToolRounds).toBe(15);
      expect(profile.timeoutMs).toBe(120_000);
      // grace period still applies
      expect(profile.containerTimeoutMs).toBe(180_000);
    });

    it('per-group/task overrides take priority over config file', () => {
      mockConfigFile({
        ollama: { maxToolRounds: 15, timeoutMs: 120_000 },
      });

      const profile = resolveProfile('ollama:qwen3', {
        maxToolRounds: 3,
        timeoutMs: 60_000,
      });
      expect(profile.maxToolRounds).toBe(3);
      expect(profile.timeoutMs).toBe(60_000);
    });

    it('falls back to hardcoded defaults for missing config keys', () => {
      mockConfigFile({
        claude: { maxToolRounds: 25 },
        // timeoutMs missing — should fall back to CONTAINER_TIMEOUT
      });

      const profile = resolveProfile('sonnet');
      expect(profile.maxToolRounds).toBe(25);
      expect(profile.timeoutMs).toBe(1_800_000);
    });

    it('falls back to hardcoded defaults for missing backend section', () => {
      mockConfigFile({
        claude: { maxToolRounds: 25 },
        // no ollama section
      });

      const profile = resolveProfile('ollama:qwen3');
      expect(profile.maxToolRounds).toBe(10);
      expect(profile.timeoutMs).toBe(300_000);
    });

    it('handles malformed config file gracefully', () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('not json');

      // Should not throw, should fall back to hardcoded defaults
      const profile = resolveProfile('ollama:qwen3');
      expect(profile.maxToolRounds).toBe(10);
      expect(profile.timeoutMs).toBe(300_000);
    });
  });
});
