import fs from 'fs';
import path from 'path';

import { CONTAINER_TIMEOUT, DATA_DIR, IDLE_TIMEOUT } from './config.js';
import { readEnvFile } from './env.js';

export interface ConnectionProfile {
  backend: 'claude' | 'ollama' | 'anthropic-api';
  ollamaHost?: string;
  ollamaModel?: string;
  maxToolRounds: number;
  timeoutMs: number;
  containerTimeoutMs: number;
  idleTimeoutMs: number;
}

interface BackendDefaults {
  maxToolRounds?: number;
  timeoutMs?: number;
}

interface BackendDefaultsConfig {
  claude?: BackendDefaults;
  ollama?: BackendDefaults;
  'anthropic-api'?: BackendDefaults;
}

// Hardcoded fallbacks when no config file exists
const HARDCODED_CLAUDE: Required<BackendDefaults> = {
  maxToolRounds: 0, // 0 = unlimited (SDK manages)
  timeoutMs: CONTAINER_TIMEOUT,
};

const HARDCODED_OLLAMA: Required<BackendDefaults> = {
  maxToolRounds: 10,
  timeoutMs: 300_000, // 5 min
};

const HARDCODED_ANTHROPIC_API: Required<BackendDefaults> = {
  maxToolRounds: 15,
  timeoutMs: 300_000, // 5 min
};

/**
 * Read backend defaults from data/backend-defaults.json.
 * Returns empty config on missing/malformed file (falls back to hardcoded).
 */
function loadBackendDefaults(): BackendDefaultsConfig {
  const configPath = path.join(DATA_DIR, 'backend-defaults.json');
  try {
    if (!fs.existsSync(configPath)) return {};
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

/**
 * Parse a model string and return a ConnectionProfile with resolved timeouts.
 *
 * Priority (most specific wins):
 *   1. Per-group/task overrides
 *   2. data/backend-defaults.json
 *   3. Hardcoded defaults
 */
export function resolveProfile(
  model: string | undefined,
  overrides?: { maxToolRounds?: number; timeoutMs?: number },
): ConnectionProfile {
  const config = loadBackendDefaults();

  if (model?.startsWith('ollama:') || model?.startsWith('ollama-remote:')) {
    const colonIdx = model.indexOf(':');
    const prefix = model.slice(0, colonIdx);
    const ollamaModel = model.slice(colonIdx + 1);

    const host =
      prefix === 'ollama-remote'
        ? readEnvFile(['OLLAMA_REMOTE_HOST']).OLLAMA_REMOTE_HOST ||
          'http://localhost:11434'
        : readEnvFile(['OLLAMA_HOST']).OLLAMA_HOST ||
          'http://host.docker.internal:11434';

    const defaults = config.ollama ?? {};
    const maxToolRounds =
      overrides?.maxToolRounds ??
      defaults.maxToolRounds ??
      HARDCODED_OLLAMA.maxToolRounds;
    const timeoutMs =
      overrides?.timeoutMs ?? defaults.timeoutMs ?? HARDCODED_OLLAMA.timeoutMs;

    return {
      backend: 'ollama',
      ollamaHost: host,
      ollamaModel,
      maxToolRounds,
      timeoutMs,
      containerTimeoutMs: timeoutMs + 60_000, // timeout + 1 min grace
      idleTimeoutMs: 30_000, // 30s idle for Ollama (no persistent session)
    };
  }

  // anthropic: prefix → lightweight Anthropic API engine
  if (model?.startsWith('anthropic:')) {
    const defaults = config['anthropic-api'] ?? {};
    const maxToolRounds =
      overrides?.maxToolRounds ??
      defaults.maxToolRounds ??
      HARDCODED_ANTHROPIC_API.maxToolRounds;
    const timeoutMs =
      overrides?.timeoutMs ??
      defaults.timeoutMs ??
      HARDCODED_ANTHROPIC_API.timeoutMs;

    return {
      backend: 'anthropic-api',
      maxToolRounds,
      timeoutMs,
      containerTimeoutMs: timeoutMs + 60_000, // timeout + 1 min grace
      idleTimeoutMs: IDLE_TIMEOUT,
    };
  }

  // claude: prefix → strip prefix, route to Agent SDK (same as bare model name)
  // No need to strip here — the prefix is stripped in the agent-runner routing.

  const defaults = config.claude ?? {};
  const maxToolRounds =
    overrides?.maxToolRounds ??
    defaults.maxToolRounds ??
    HARDCODED_CLAUDE.maxToolRounds;
  const timeoutMs =
    overrides?.timeoutMs ?? defaults.timeoutMs ?? HARDCODED_CLAUDE.timeoutMs;

  return {
    backend: 'claude',
    maxToolRounds,
    timeoutMs,
    containerTimeoutMs: timeoutMs,
    idleTimeoutMs: IDLE_TIMEOUT,
  };
}

/** Returns true if the model string selects an Ollama backend. */
export function isOllamaModel(model: string | undefined): boolean {
  return (
    model?.startsWith('ollama:') === true ||
    model?.startsWith('ollama-remote:') === true
  );
}

/** Returns true if the model string selects the lightweight Anthropic API backend. */
export function isAnthropicApiModel(model: string | undefined): boolean {
  return model?.startsWith('anthropic:') === true;
}
