import { describe, expect, it, vi } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { resolveMcpServers } from './mcp-server-resolver.js';

function baseConfig(): ContainerConfig {
  return {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all',
  };
}

describe('resolveMcpServers', () => {
  it('returns an empty config unchanged', async () => {
    const out = await resolveMcpServers(baseConfig());
    expect(out.mcpServers).toEqual({});
  });

  it('passes a stdio-only config through unchanged', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { local: { command: 'node', args: ['srv.js'] } },
    };
    const out = await resolveMcpServers(cfg);
    expect(out.mcpServers.local).toEqual({ command: 'node', args: ['srv.js'] });
  });

  it('rewrites a localhost URL on a remote entry to host.docker.internal', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://localhost:3201/mcp', tools: ['op1'] } },
    };
    const out = await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue([]) });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.url).toBe('http://host.docker.internal:3201/mcp');
  });

  it('rewrites a 127.0.0.1 URL to host.docker.internal', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://127.0.0.1:8080/mcp', tools: ['op1'] } },
    };
    const out = await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue([]) });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.url).toBe('http://host.docker.internal:8080/mcp');
  });

  it('leaves an external URL untouched', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'https://mcp.example/api', tools: ['op1'] } },
    };
    const out = await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue([]) });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.url).toBe('https://mcp.example/api');
  });

  it('invokes the discoverer with the rewritten URL and the entry headers', async () => {
    const discover = vi.fn().mockResolvedValue([]);
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        rs: { url: 'http://localhost:3201/mcp', tools: ['op1'], headers: { 'X-Auth': 't' } },
      },
    };
    await resolveMcpServers(cfg, { discover });
    expect(discover).toHaveBeenCalledWith('http://host.docker.internal:3201/mcp', { 'X-Auth': 't' });
  });

  it('populates toolSchemas on a remote entry from the discoverer result', async () => {
    const schemas = [{ name: 'op1', description: 'do thing', inputSchema: { type: 'object' } }];
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://h/mcp', tools: ['op1'] } },
    };
    const out = await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue(schemas) });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.toolSchemas).toEqual(schemas);
  });

  it('inlines skill content into instructions when a skill field is set', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://h/mcp', tools: ['op1'], skill: 'SKILL.md' } },
    };
    const resolveSkill = vi.fn().mockReturnValue('# Use this server for X.');
    const out = await resolveMcpServers(cfg, {
      discover: vi.fn().mockResolvedValue([]),
      resolveSkill,
    });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(resolveSkill).toHaveBeenCalledWith('rs', 'SKILL.md');
    expect(entry.instructions).toBe('# Use this server for X.');
  });

  it('leaves instructions undefined when no skill is set and resolveSkill returns nothing', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://h/mcp', tools: ['op1'] } },
    };
    const out = await resolveMcpServers(cfg, {
      discover: vi.fn().mockResolvedValue([]),
      resolveSkill: vi.fn().mockReturnValue(undefined),
    });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.instructions).toBeUndefined();
  });

  it('preserves an existing instructions value when skill resolver returns nothing', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        rs: { url: 'http://h/mcp', tools: ['op1'], instructions: 'Pre-set inline guidance.' },
      },
    };
    const out = await resolveMcpServers(cfg, {
      discover: vi.fn().mockResolvedValue([]),
      resolveSkill: vi.fn().mockReturnValue(undefined),
    });
    const entry = out.mcpServers.rs;
    if (!('url' in entry)) throw new Error('expected remote entry');
    expect(entry.instructions).toBe('Pre-set inline guidance.');
  });

  it('handles a mixed stdio + remote config — stdio passes through, remote resolves', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        local: { command: 'node', args: ['srv.js'] },
        remote: { url: 'http://localhost:3201/mcp', tools: ['op1'] },
      },
    };
    const schemas = [{ name: 'op1', inputSchema: {} }];
    const out = await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue(schemas) });
    const local = out.mcpServers.local;
    const remote = out.mcpServers.remote;
    if ('url' in local) throw new Error('local should remain stdio');
    if (!('url' in remote)) throw new Error('remote should remain remote');
    expect(local.command).toBe('node');
    expect(remote.url).toBe('http://host.docker.internal:3201/mcp');
    expect(remote.toolSchemas).toEqual(schemas);
  });

  it('does not mutate the input config', async () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: { rs: { url: 'http://localhost:3201/mcp', tools: ['op1'] } },
    };
    const before = JSON.stringify(cfg);
    await resolveMcpServers(cfg, { discover: vi.fn().mockResolvedValue([]) });
    expect(JSON.stringify(cfg)).toBe(before);
  });
});
