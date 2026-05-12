import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = path.join(os.tmpdir(), `nanoclaw-test-ccgen-${process.pid}`);
const TEST_GROUPS_DIR = path.join(TEST_ROOT, 'groups');
const TEST_DATA_DIR = path.join(TEST_ROOT, 'data');
const TEST_HOME = path.join(TEST_ROOT, 'home');
const TEST_ALLOWLIST = path.join(TEST_HOME, '.config', 'nanoclaw', 'mount-allowlist.json');

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    GROUPS_DIR: TEST_GROUPS_DIR,
    DATA_DIR: TEST_DATA_DIR,
    MOUNT_ALLOWLIST_PATH: TEST_ALLOWLIST,
  };
});

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

function writeServersFile(servers: Record<string, unknown>): void {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'mcp-servers.json'), JSON.stringify({ servers }));
}

function writeExclusionsFile(content: Record<string, string[]>): void {
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEST_DATA_DIR, 'mcp-exclusions.json'), JSON.stringify(content));
}

function writeAllowlistFile(roots: Array<{ path: string; allowReadWrite: boolean }>): void {
  fs.mkdirSync(path.dirname(TEST_ALLOWLIST), { recursive: true });
  fs.writeFileSync(TEST_ALLOWLIST, JSON.stringify({ allowedRoots: roots, blockedPatterns: [] }));
}

function writeContainerJson(folder: string, content: Record<string, unknown>): void {
  const dir = path.join(TEST_GROUPS_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'container.json'), JSON.stringify(content, null, 2));
}

function readContainerJsonRaw(folder: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(TEST_GROUPS_DIR, folder, 'container.json'), 'utf8'));
}

function readSidecar(folder: string): Record<string, unknown> | null {
  const p = path.join(TEST_GROUPS_DIR, folder, '.container-generator.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function makeFakeStdioServerDir(name: string): string {
  const dir = path.join(TEST_ROOT, 'mcp-src', name);
  fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build', 'index.js'), '// stub');
  return dir;
}

beforeEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  fs.mkdirSync(TEST_GROUPS_DIR, { recursive: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  // Default permissive allowlist so generator-resolved paths pass mount-security.
  fs.mkdirSync(path.dirname(TEST_ALLOWLIST), { recursive: true });
  writeAllowlistFile([{ path: TEST_ROOT, allowReadWrite: false }]);
});

afterEach(() => {
  if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
});

// ---------------------------------------------------------------------------
// generateGroupContainerConfig — pure logic
// ---------------------------------------------------------------------------

describe('generateGroupContainerConfig — empty inputs', () => {
  it('returns empty section when mcpServers is null', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: null,
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toEqual({});
    expect(out.additionalMounts).toEqual([]);
    expect(out.errors).toEqual([]);
  });

  it('returns empty section when servers map is empty', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: { servers: {} },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toEqual({});
    expect(out.additionalMounts).toEqual([]);
  });
});

describe('generateGroupContainerConfig — stdio servers', () => {
  it('emits mcpServers entry + additionalMount for a stdio server with hostPath', async () => {
    const hostDir = makeFakeStdioServerDir('test-stdio-srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          'test-stdio-srv': {
            hostPath: hostDir,
            command: 'node',
            args: ['build/index.js'],
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toHaveProperty('test-stdio-srv');
    const entry = out.mcpServers['test-stdio-srv'] as { command: string; args?: string[] };
    expect(entry.command).toBe('node');
    expect(entry.args).toEqual(['/workspace/extra/test-stdio-srv/build/index.js']);
    expect(out.additionalMounts).toHaveLength(1);
    expect(out.additionalMounts[0]).toEqual({
      hostPath: hostDir,
      containerPath: 'test-stdio-srv',
      readonly: true,
    });
    expect(out.managedServerNames).toEqual(['test-stdio-srv']);
    expect(out.managedMountContainerPaths).toEqual(['test-stdio-srv']);
  });

  it('rewrites args starting with ./ to absolute container path', async () => {
    const hostDir = makeFakeStdioServerDir('pagepilot');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          pagepilot: {
            hostPath: hostDir,
            command: 'node',
            args: ['./packages/mcp-server/bin/serve.mjs'],
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['pagepilot'] as { args?: string[] };
    expect(entry.args).toEqual(['/workspace/extra/pagepilot/packages/mcp-server/bin/serve.mjs']);
  });

  it('leaves args unchanged when they do not match the rewrite patterns', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          srv: {
            hostPath: hostDir,
            command: 'node',
            args: ['/absolute/path/script.js', '--flag'],
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as { args?: string[] };
    expect(entry.args).toEqual(['/absolute/path/script.js', '--flag']);
  });

  it('skips stdio server when hostPath does not exist + records error', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          missing: {
            hostPath: '/this/does/not/exist',
            command: 'node',
            args: ['build/index.js'],
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toEqual({});
    expect(out.additionalMounts).toEqual([]);
    expect(out.errors).toEqual([{ serverName: 'missing', reason: expect.stringContaining('hostPath does not exist') }]);
  });

  it('drops v1 stdio tools array (v2 discovers from spawn)', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          srv: {
            hostPath: hostDir,
            command: 'node',
            args: ['build/index.js'],
            tools: ['list_things', 'do_thing'],
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('tools');
  });

  it('drops v1 timeout field (v2 schema has no timeout)', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          srv: { hostPath: hostDir, command: 'node', args: ['build/index.js'], timeout: 120000 },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('timeout');
  });
});

describe('generateGroupContainerConfig — remote servers', () => {
  it('emits remote entry with url + tools shape preserved, no mount', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          'eks-kubectl': {
            url: 'http://172.17.0.1:3201/mcp',
            tools: { read: ['list_pods'], write: ['restart_deployment'] },
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toHaveProperty('eks-kubectl');
    const entry = out.mcpServers['eks-kubectl'] as { url: string; tools: unknown };
    expect(entry.url).toBe('http://172.17.0.1:3201/mcp');
    expect(entry.tools).toEqual({ read: ['list_pods'], write: ['restart_deployment'] });
    expect(out.additionalMounts).toEqual([]);
  });

  it('passes through headers field on remote entries', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          api: {
            url: 'https://api.example.com/mcp',
            tools: ['call_one'],
            headers: { 'X-Auth': 'abc' },
          },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['api'] as { headers?: Record<string, string> };
    expect(entry.headers).toEqual({ 'X-Auth': 'abc' });
  });
});

describe('generateGroupContainerConfig — invalid entries', () => {
  it('errors on entry with both url and hostPath', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          mixed: { hostPath: hostDir, url: 'http://x/mcp', command: 'node', args: [] },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toEqual({});
    expect(out.errors).toEqual([{ serverName: 'mixed', reason: expect.stringContaining('both url and hostPath') }]);
  });

  it('errors on entry with neither url nor hostPath', async () => {
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: { servers: { empty: {} as never } },
      exclusions: {},
      folder: 'g',
    });
    expect(out.mcpServers).toEqual({});
    expect(out.errors).toEqual([{ serverName: 'empty', reason: expect.stringContaining('neither url nor hostPath') }]);
  });
});

describe('generateGroupContainerConfig — exclusions', () => {
  it('omits servers excluded via wildcard *', async () => {
    const hostDir = makeFakeStdioServerDir('srv-a');
    const hostDirB = makeFakeStdioServerDir('srv-b');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          'srv-a': { hostPath: hostDir, command: 'node', args: [] },
          'srv-b': { hostPath: hostDirB, command: 'node', args: [] },
        },
      },
      exclusions: { '*': ['srv-a'] },
      folder: 'anything',
    });
    expect(out.mcpServers).not.toHaveProperty('srv-a');
    expect(out.mcpServers).toHaveProperty('srv-b');
  });

  it('omits servers excluded for a specific folder only', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const outA = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: [] } } },
      exclusions: { folder_a: ['srv'] },
      folder: 'folder_a',
    });
    const outB = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: [] } } },
      exclusions: { folder_a: ['srv'] },
      folder: 'folder_b',
    });
    expect(outA.mcpServers).not.toHaveProperty('srv');
    expect(outB.mcpServers).toHaveProperty('srv');
  });

  it('does not double-process when wildcard and per-folder both exclude the same server', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: [] } } },
      exclusions: { '*': ['srv'], folder_a: ['srv'] },
      folder: 'folder_a',
    });
    expect(out.mcpServers).not.toHaveProperty('srv');
    expect(out.errors).toEqual([]);
  });

  it('takes union when wildcard and per-folder exclude different servers', async () => {
    const a = makeFakeStdioServerDir('srv-a');
    const b = makeFakeStdioServerDir('srv-b');
    const c = makeFakeStdioServerDir('srv-c');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          'srv-a': { hostPath: a, command: 'node', args: [] },
          'srv-b': { hostPath: b, command: 'node', args: [] },
          'srv-c': { hostPath: c, command: 'node', args: [] },
        },
      },
      exclusions: { '*': ['srv-a'], folder_a: ['srv-b'] },
      folder: 'folder_a',
    });
    expect(out.mcpServers).not.toHaveProperty('srv-a');
    expect(out.mcpServers).not.toHaveProperty('srv-b');
    expect(out.mcpServers).toHaveProperty('srv-c');
  });
});

describe('generateGroupContainerConfig — env handling', () => {
  it('resolves env whitelist from process.env (only present vars)', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    process.env.GENTEST_FOO = 'foo-value';
    delete process.env.GENTEST_BAR;
    try {
      const { generateGroupContainerConfig } = await import('./container-config-generator.js');
      const out = generateGroupContainerConfig({
        mcpServers: {
          servers: {
            srv: { hostPath: hostDir, command: 'node', args: [], env: ['GENTEST_FOO', 'GENTEST_BAR'] },
          },
        },
        exclusions: {},
        folder: 'g',
      });
      const entry = out.mcpServers['srv'] as { env?: Record<string, string> };
      expect(entry.env).toEqual({ GENTEST_FOO: 'foo-value' });
    } finally {
      delete process.env.GENTEST_FOO;
    }
  });

  it('injects hostEnv literal values', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          srv: { hostPath: hostDir, command: 'node', args: [], hostEnv: { LITERAL_KEY: '/abs/path' } },
        },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as { env?: Record<string, string> };
    expect(entry.env).toEqual({ LITERAL_KEY: '/abs/path' });
  });

  it('hostEnv wins over env whitelist on key collision', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    process.env.SHARED_KEY = 'from-process';
    try {
      const { generateGroupContainerConfig } = await import('./container-config-generator.js');
      const out = generateGroupContainerConfig({
        mcpServers: {
          servers: {
            srv: {
              hostPath: hostDir,
              command: 'node',
              args: [],
              env: ['SHARED_KEY'],
              hostEnv: { SHARED_KEY: 'from-hostEnv' },
            },
          },
        },
        exclusions: {},
        folder: 'g',
      });
      const entry = out.mcpServers['srv'] as { env?: Record<string, string> };
      expect(entry.env).toEqual({ SHARED_KEY: 'from-hostEnv' });
    } finally {
      delete process.env.SHARED_KEY;
    }
  });

  it('omits env field entirely when no env or hostEnv resolves', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    delete process.env.UNSET_VAR;
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: { srv: { hostPath: hostDir, command: 'node', args: [], env: ['UNSET_VAR'] } },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('env');
  });
});

describe('generateGroupContainerConfig — skill field', () => {
  it('inlines SKILL.md content into instructions for stdio servers', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    fs.writeFileSync(path.join(hostDir, 'SKILL.md'), '# Hello\n\nSkill body.\n');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: { srv: { hostPath: hostDir, command: 'node', args: [], skill: 'SKILL.md' } },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as { instructions?: string };
    expect(entry.instructions).toBe('# Hello\n\nSkill body.\n');
  });

  it('records error + omits instructions when skill file is missing', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig } = await import('./container-config-generator.js');
    const out = generateGroupContainerConfig({
      mcpServers: {
        servers: { srv: { hostPath: hostDir, command: 'node', args: [], skill: 'NOPE.md' } },
      },
      exclusions: {},
      folder: 'g',
    });
    const entry = out.mcpServers['srv'] as unknown as Record<string, unknown>;
    expect(entry).not.toHaveProperty('instructions');
    expect(out.mcpServers).toHaveProperty('srv');
    expect(out.errors).toEqual([{ serverName: 'srv', reason: expect.stringContaining('skill file not found') }]);
  });
});

// ---------------------------------------------------------------------------
// mergeIntoContainerJson — file ops + idempotency
// ---------------------------------------------------------------------------

describe('mergeIntoContainerJson — preservation + idempotency', () => {
  it('preserves operator-owned packages.apt across regenerate', async () => {
    writeContainerJson('grp', {
      packages: { apt: ['curl', 'jq'], npm: [] },
      mcpServers: {},
      additionalMounts: [],
    });
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: ['build/index.js'] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen);
    const after = readContainerJsonRaw('grp');
    expect(after.packages).toEqual({ apt: ['curl', 'jq'], npm: [] });
  });

  it('preserves operator-owned imageTag', async () => {
    writeContainerJson('grp', { imageTag: 'custom:1' });
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: ['build/index.js'] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen);
    const after = readContainerJsonRaw('grp');
    expect(after.imageTag).toBe('custom:1');
  });

  it('preserves operator additionalMounts whose containerPath is outside generator namespace', async () => {
    writeContainerJson('grp', {
      additionalMounts: [{ hostPath: '/data/foo', containerPath: 'operator-data', readonly: false }],
    });
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: [] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen);
    const after = readContainerJsonRaw('grp') as { additionalMounts: Array<{ containerPath: string }> };
    const paths = after.additionalMounts.map((m) => m.containerPath).sort();
    expect(paths).toEqual(['operator-data', 'srv']);
  });

  it('clobbers an operator-edited generator-owned mcpServers entry on next regenerate', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen1 = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: ['build/index.js'] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen1);
    // Operator hand-edits the generated entry
    const handEdited = readContainerJsonRaw('grp') as { mcpServers: Record<string, { command: string }> };
    handEdited.mcpServers.srv.command = 'hacked';
    writeContainerJson('grp', handEdited);
    // Regenerate
    mergeIntoContainerJson('grp', gen1);
    const after = readContainerJsonRaw('grp') as { mcpServers: Record<string, { command: string }> };
    expect(after.mcpServers.srv.command).toBe('node');
  });

  it('is idempotent — second merge with same inputs reports no change', async () => {
    const hostDir = makeFakeStdioServerDir('srv');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { srv: { hostPath: hostDir, command: 'node', args: ['build/index.js'] } } },
      exclusions: {},
      folder: 'grp',
    });
    const r1 = mergeIntoContainerJson('grp', gen);
    expect(r1.changed).toBe(true);
    const r2 = mergeIntoContainerJson('grp', gen);
    expect(r2.changed).toBe(false);
    expect(r2.written).toBe(false);
  });

  it('removes generator-owned entry when server is removed from inputs on regenerate', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    const dirB = makeFakeStdioServerDir('srv-b');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen1 = generateGroupContainerConfig({
      mcpServers: {
        servers: {
          'srv-a': { hostPath: dirA, command: 'node', args: [] },
          'srv-b': { hostPath: dirB, command: 'node', args: [] },
        },
      },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen1);
    const after1 = readContainerJsonRaw('grp') as {
      mcpServers: Record<string, unknown>;
      additionalMounts: Array<{ containerPath: string }>;
    };
    expect(Object.keys(after1.mcpServers).sort()).toEqual(['srv-a', 'srv-b']);

    // Now srv-b removed from inputs
    const gen2 = generateGroupContainerConfig({
      mcpServers: { servers: { 'srv-a': { hostPath: dirA, command: 'node', args: [] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen2);
    const after2 = readContainerJsonRaw('grp') as {
      mcpServers: Record<string, unknown>;
      additionalMounts: Array<{ containerPath: string }>;
    };
    expect(Object.keys(after2.mcpServers).sort()).toEqual(['srv-a']);
    expect(after2.additionalMounts.map((m) => m.containerPath).sort()).toEqual(['srv-a']);
  });

  it('writes a sidecar (.container-generator.json) listing managed names', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { 'srv-a': { hostPath: dirA, command: 'node', args: [] } } },
      exclusions: {},
      folder: 'grp',
    });
    mergeIntoContainerJson('grp', gen);
    const sidecar = readSidecar('grp');
    expect(sidecar).toEqual({
      mcpServers: ['srv-a'],
      additionalMountContainerPaths: ['srv-a'],
    });
  });

  it('handles initial run when container.json does not exist yet', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    const { generateGroupContainerConfig, mergeIntoContainerJson } = await import('./container-config-generator.js');
    const gen = generateGroupContainerConfig({
      mcpServers: { servers: { 'srv-a': { hostPath: dirA, command: 'node', args: [] } } },
      exclusions: {},
      folder: 'fresh-grp',
    });
    const r = mergeIntoContainerJson('fresh-grp', gen);
    expect(r.written).toBe(true);
    const after = readContainerJsonRaw('fresh-grp') as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers).toHaveProperty('srv-a');
  });
});

// ---------------------------------------------------------------------------
// regenerateAllAgentGroups — orchestration + allowlist
// ---------------------------------------------------------------------------

describe('regenerateAllAgentGroups — orchestration', () => {
  it('skips folders starting with "pipeline-"', async () => {
    const dirA = makeFakeStdioServerDir('srv');
    writeServersFile({ srv: { hostPath: dirA, command: 'node', args: [] } });
    writeExclusionsFile({});
    writeContainerJson('regular-grp', {});
    writeContainerJson('pipeline-monitor', {});
    writeContainerJson('pipeline-solver', {});
    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    const summary = regenerateAllAgentGroups(['regular-grp', 'pipeline-monitor', 'pipeline-solver']);
    expect(summary.groupsProcessed).toBe(1);
    expect(summary.groupsSkipped).toBe(2);
    expect(readContainerJsonRaw('regular-grp')).toHaveProperty('mcpServers.srv');
    // pipeline-* folders left untouched
    expect(readSidecar('pipeline-monitor')).toBeNull();
  });

  it('adds hostPaths to mount-allowlist on first run', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    const dirB = makeFakeStdioServerDir('srv-b');
    writeServersFile({
      'srv-a': { hostPath: dirA, command: 'node', args: [] },
      'srv-b': { hostPath: dirB, command: 'node', args: [] },
    });
    writeExclusionsFile({});
    writeContainerJson('grp', {});
    // Allowlist initially has no entries for these hostPaths
    writeAllowlistFile([]);
    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    const summary = regenerateAllAgentGroups(['grp']);
    const allowlist = JSON.parse(fs.readFileSync(TEST_ALLOWLIST, 'utf8')) as {
      allowedRoots: Array<{ path: string }>;
    };
    const roots = allowlist.allowedRoots.map((r) => r.path).sort();
    expect(roots).toEqual([dirA, dirB].sort());
    expect(summary.mountAllowlistUpdates.sort()).toEqual([dirA, dirB].sort());
  });

  it('does not double-add when allowlist already contains the hostPaths', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    writeServersFile({ 'srv-a': { hostPath: dirA, command: 'node', args: [] } });
    writeExclusionsFile({});
    writeContainerJson('grp', {});
    writeAllowlistFile([{ path: dirA, allowReadWrite: false }]);
    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    const summary = regenerateAllAgentGroups(['grp']);
    const allowlist = JSON.parse(fs.readFileSync(TEST_ALLOWLIST, 'utf8')) as {
      allowedRoots: Array<{ path: string }>;
    };
    expect(allowlist.allowedRoots).toHaveLength(1);
    expect(summary.mountAllowlistUpdates).toEqual([]);
  });

  it('reads inputs from data/mcp-servers.json + data/mcp-exclusions.json on disk', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    writeServersFile({ 'srv-a': { hostPath: dirA, command: 'node', args: ['build/index.js'] } });
    writeExclusionsFile({ '*': ['srv-a'] });
    writeContainerJson('grp', {});
    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    regenerateAllAgentGroups(['grp']);
    const after = readContainerJsonRaw('grp') as { mcpServers: Record<string, unknown> };
    expect(after.mcpServers).not.toHaveProperty('srv-a');
  });

  it('tolerates missing data/mcp-servers.json (treats as empty)', async () => {
    // Don't write servers file
    writeContainerJson('grp', { mcpServers: { 'old-srv': { command: 'old' } } });
    // Also seed sidecar so generator knows it managed old-srv
    fs.writeFileSync(
      path.join(TEST_GROUPS_DIR, 'grp', '.container-generator.json'),
      JSON.stringify({ mcpServers: ['old-srv'], additionalMountContainerPaths: ['old-srv'] }),
    );
    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    const summary = regenerateAllAgentGroups(['grp']);
    expect(summary.groupsProcessed).toBe(1);
    const after = readContainerJsonRaw('grp') as { mcpServers: Record<string, unknown> };
    // old-srv removed because it was generator-owned and is no longer in inputs
    expect(after.mcpServers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Mount-allowlist cache invalidation — generator paths usable at spawn
// ---------------------------------------------------------------------------

describe('mount-security integration after generator runs', () => {
  it('invalidates the allowlist cache so newly-added hostPaths validate', async () => {
    const dirA = makeFakeStdioServerDir('srv-a');
    writeServersFile({ 'srv-a': { hostPath: dirA, command: 'node', args: [] } });
    writeExclusionsFile({});
    writeContainerJson('grp', {});
    writeAllowlistFile([]); // empty initially

    // Force cache to populate while file is empty.
    const mountSecurity = await import('./modules/mount-security/index.js');
    mountSecurity.loadMountAllowlist();
    const beforeResult = mountSecurity.validateMount({ hostPath: dirA, containerPath: 'srv-a' });
    expect(beforeResult.allowed).toBe(false);

    const { regenerateAllAgentGroups } = await import('./container-config-generator.js');
    regenerateAllAgentGroups(['grp']);

    const afterResult = mountSecurity.validateMount({ hostPath: dirA, containerPath: 'srv-a' });
    expect(afterResult.allowed).toBe(true);
  });
});
