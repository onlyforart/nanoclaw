import { describe, expect, it, vi } from 'vitest';

import { applyOneCLIGateway, groupEnvAndBlockedHostsArgs, resolveProviderName } from './container-runner.js';
import type { AgentGroup } from './types.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('groupEnvAndBlockedHostsArgs', () => {
  it('returns empty array when neither env nor blockedHosts is set', () => {
    expect(groupEnvAndBlockedHostsArgs({})).toEqual([]);
  });

  it('emits -e KEY=VALUE for each env entry, preserving insertion order', () => {
    expect(
      groupEnvAndBlockedHostsArgs({
        env: { ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434', ANTHROPIC_API_KEY: 'ollama' },
      }),
    ).toEqual(['-e', 'ANTHROPIC_BASE_URL=http://host.docker.internal:11434', '-e', 'ANTHROPIC_API_KEY=ollama']);
  });

  it('emits --add-host h:0.0.0.0 for each blockedHosts entry, preserving array order', () => {
    expect(groupEnvAndBlockedHostsArgs({ blockedHosts: ['api.anthropic.com', 'example.com'] })).toEqual([
      '--add-host',
      'api.anthropic.com:0.0.0.0',
      '--add-host',
      'example.com:0.0.0.0',
    ]);
  });

  it('emits env entries before blockedHosts entries when both are set', () => {
    expect(
      groupEnvAndBlockedHostsArgs({
        env: { K: 'v' },
        blockedHosts: ['x.example'],
      }),
    ).toEqual(['-e', 'K=v', '--add-host', 'x.example:0.0.0.0']);
  });

  it('preserves env values verbatim including special chars', () => {
    expect(groupEnvAndBlockedHostsArgs({ env: { URL: 'http://h:p/path?a=b&c=d' } })).toEqual([
      '-e',
      'URL=http://h:p/path?a=b&c=d',
    ]);
  });

  it('treats empty env object as no-op', () => {
    expect(groupEnvAndBlockedHostsArgs({ env: {} })).toEqual([]);
  });

  it('treats empty blockedHosts array as no-op', () => {
    expect(groupEnvAndBlockedHostsArgs({ blockedHosts: [] })).toEqual([]);
  });
});

describe('applyOneCLIGateway — K.1.h A.5 spawn gate', () => {
  const fakeGroup: AgentGroup = {
    id: 'grp-1',
    name: 'group-name',
    folder: 'grp-folder',
    agent_provider: null,
    created_at: '2026-05-11T00:00:00Z',
  };

  it('throws when applyContainerConfig returns false', async () => {
    const onecli = {
      ensureAgent: vi.fn().mockResolvedValue({ created: false }),
      applyContainerConfig: vi.fn().mockResolvedValue(false),
    };
    await expect(applyOneCLIGateway(onecli, [], fakeGroup, 'agent-id', 'container-foo')).rejects.toThrow(
      /container-foo.*refusing to spawn/,
    );
  });

  it('propagates errors from applyContainerConfig', async () => {
    const onecli = {
      ensureAgent: vi.fn().mockResolvedValue({ created: false }),
      applyContainerConfig: vi.fn().mockRejectedValue(new Error('network down')),
    };
    await expect(applyOneCLIGateway(onecli, [], fakeGroup, 'agent-id', 'container-foo')).rejects.toThrow(
      /network down/,
    );
  });

  it('propagates errors from ensureAgent', async () => {
    const onecli = {
      ensureAgent: vi.fn().mockRejectedValue(new Error('vault unreachable')),
      applyContainerConfig: vi.fn(),
    };
    await expect(applyOneCLIGateway(onecli, [], fakeGroup, 'agent-id', 'container-foo')).rejects.toThrow(
      /vault unreachable/,
    );
    expect(onecli.applyContainerConfig).not.toHaveBeenCalled();
  });

  it('returns normally when applyContainerConfig returns true', async () => {
    const onecli = {
      ensureAgent: vi.fn().mockResolvedValue({ created: false }),
      applyContainerConfig: vi.fn().mockResolvedValue(true),
    };
    await expect(applyOneCLIGateway(onecli, [], fakeGroup, 'agent-id', 'container-foo')).resolves.toBeUndefined();
    expect(onecli.ensureAgent).toHaveBeenCalledWith({ name: 'group-name', identifier: 'agent-id' });
  });

  it('skips ensureAgent when agentIdentifier is undefined but still applies gateway', async () => {
    const onecli = {
      ensureAgent: vi.fn(),
      applyContainerConfig: vi.fn().mockResolvedValue(true),
    };
    await applyOneCLIGateway(onecli, [], fakeGroup, undefined, 'container-foo');
    expect(onecli.ensureAgent).not.toHaveBeenCalled();
    expect(onecli.applyContainerConfig).toHaveBeenCalledWith([], {
      addHostMapping: false,
      agent: undefined,
    });
  });
});
