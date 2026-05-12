import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_GROUPS_DIR = '/tmp/nanoclaw-test-container-config';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, GROUPS_DIR: TEST_GROUPS_DIR };
});

function writeConfig(folder: string, json: unknown): void {
  const dir = path.join(TEST_GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(json));
}

beforeEach(() => {
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
});

afterEach(() => {
  if (fs.existsSync(TEST_GROUPS_DIR)) fs.rmSync(TEST_GROUPS_DIR, { recursive: true });
});

describe('readContainerConfig — env passthrough', () => {
  it('returns env verbatim when set in JSON', async () => {
    writeConfig('grp', {
      env: {
        ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
        ANTHROPIC_API_KEY: 'ollama',
        NO_PROXY: 'host.docker.internal',
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    expect(cfg.env).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_API_KEY: 'ollama',
      NO_PROXY: 'host.docker.internal',
    });
  });

  it('returns env undefined when JSON omits the field', async () => {
    writeConfig('grp', { provider: 'claude' });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    expect(cfg.env).toBeUndefined();
  });

  it('returns env undefined when no container.json exists', async () => {
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('missing-group');
    expect(cfg.env).toBeUndefined();
  });
});

describe('readContainerConfig — blockedHosts passthrough', () => {
  it('returns blockedHosts verbatim when set in JSON', async () => {
    writeConfig('grp', { blockedHosts: ['api.anthropic.com', 'example.com'] });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    expect(cfg.blockedHosts).toEqual(['api.anthropic.com', 'example.com']);
  });

  it('returns blockedHosts undefined when JSON omits the field', async () => {
    writeConfig('grp', { provider: 'claude' });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    expect(cfg.blockedHosts).toBeUndefined();
  });

  it('returns blockedHosts undefined when no container.json exists', async () => {
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('missing-group');
    expect(cfg.blockedHosts).toBeUndefined();
  });
});

describe('writeContainerConfig — env + blockedHosts round-trip', () => {
  it('persists env and blockedHosts so a later read returns them verbatim', async () => {
    const { readContainerConfig, writeContainerConfig } = await import('./container-config.js');
    writeContainerConfig('grp', {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
      env: { K: 'v' },
      blockedHosts: ['x.example'],
    });
    const cfg = readContainerConfig('grp');
    expect(cfg.env).toEqual({ K: 'v' });
    expect(cfg.blockedHosts).toEqual(['x.example']);
  });
});

describe('readContainerConfig — remote MCP server entries', () => {
  it('preserves a remote-server entry with all v1 source fields', async () => {
    writeConfig('grp', {
      mcpServers: {
        'eks-kubectl': {
          url: 'http://172.17.0.1:3201/mcp',
          tools: { read: ['list_pods'], write: ['restart_deployment'] },
          readOnly: false,
          proxy: false,
          headers: { 'X-Auth': 'token' },
          skill: 'SKILL.md',
        },
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    const entry = cfg.mcpServers['eks-kubectl'];
    expect(entry).toBeDefined();
    // Type narrowing: this access compiles only if RemoteMcpServerConfig is part of the union.
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.url).toBe('http://172.17.0.1:3201/mcp');
    expect(entry.tools).toEqual({ read: ['list_pods'], write: ['restart_deployment'] });
    expect(entry.readOnly).toBe(false);
    expect(entry.proxy).toBe(false);
    expect(entry.headers).toEqual({ 'X-Auth': 'token' });
    expect(entry.skill).toBe('SKILL.md');
  });

  it('preserves remote-server policies field (dormant per Q2 deferral, but kept verbatim)', async () => {
    writeConfig('grp', {
      mcpServers: {
        secured: {
          url: 'https://mcp.example/api',
          tools: ['op1'],
          policies: { default: 'baseline', groups: { 'grp-a': 'tier-a' } },
        },
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    const entry = cfg.mcpServers.secured;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.policies).toEqual({ default: 'baseline', groups: { 'grp-a': 'tier-a' } });
  });

  it('preserves a tools field given as a flat array (backward-compat shape)', async () => {
    writeConfig('grp', {
      mcpServers: { rs: { url: 'http://h/mcp', tools: ['a', 'b', 'c'] } },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    const entry = cfg.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.tools).toEqual(['a', 'b', 'c']);
  });

  it('preserves stdio entries when remote and stdio entries are mixed in mcpServers', async () => {
    writeConfig('grp', {
      mcpServers: {
        local: { command: 'node', args: ['srv.js'] },
        remote: { url: 'http://h/mcp', tools: ['op1'] },
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    const local = cfg.mcpServers.local;
    const remote = cfg.mcpServers.remote;
    if ('url' in local) throw new Error('local should be stdio');
    if (!('url' in remote)) throw new Error('remote should be remote');
    expect(local.command).toBe('node');
    expect(local.args).toEqual(['srv.js']);
    expect(remote.url).toBe('http://h/mcp');
    expect(remote.tools).toEqual(['op1']);
  });

  it('preserves toolSchemas when set (host-populated derived field)', async () => {
    writeConfig('grp', {
      mcpServers: {
        rs: {
          url: 'http://h/mcp',
          tools: ['op1'],
          toolSchemas: [{ name: 'op1', description: 'do thing', inputSchema: { type: 'object' } }],
        },
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    const entry = cfg.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.toolSchemas).toEqual([{ name: 'op1', description: 'do thing', inputSchema: { type: 'object' } }]);
  });

  it('round-trips a remote-server entry through writeContainerConfig', async () => {
    const { readContainerConfig, writeContainerConfig } = await import('./container-config.js');
    writeContainerConfig('grp', {
      mcpServers: {
        rs: {
          url: 'https://mcp.example/api',
          tools: ['op1', 'op2'],
          readOnly: true,
          headers: { 'X-Tenant': 't1' },
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    });
    const cfg = readContainerConfig('grp');
    const entry = cfg.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.url).toBe('https://mcp.example/api');
    expect(entry.tools).toEqual(['op1', 'op2']);
    expect(entry.readOnly).toBe(true);
    expect(entry.headers).toEqual({ 'X-Tenant': 't1' });
  });

  it('claude-md-compose can read .instructions on either stdio or remote entries (shared field)', async () => {
    writeConfig('grp', {
      mcpServers: {
        local: { command: 'node', args: ['s.js'], instructions: 'Use this stdio server for X.' },
        remote: { url: 'http://h/mcp', tools: ['op1'], instructions: 'Use this remote server for Y.' },
      },
    });
    const { readContainerConfig } = await import('./container-config.js');
    const cfg = readContainerConfig('grp');
    // No narrowing needed — `.instructions` exists on both shapes.
    expect(cfg.mcpServers.local.instructions).toBe('Use this stdio server for X.');
    expect(cfg.mcpServers.remote.instructions).toBe('Use this remote server for Y.');
  });
});
