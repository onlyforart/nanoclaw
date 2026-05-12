import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  validateManifest,
  discoverPlugins,
  runPluginsRegister,
  runPluginsStartup,
  buildHostApi,
  type DiscoveredPlugin,
} from './plugin-loader.js';
import type { Plugin, PluginHostApi } from './plugin-contract.js';

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const m = validateManifest({ name: 'x', pluginApiVersion: 2, version: '1.0.0' });
    expect(m).toEqual({ name: 'x', pluginApiVersion: 2, version: '1.0.0' });
  });

  it('accepts a manifest without optional version', () => {
    const m = validateManifest({ name: 'x', pluginApiVersion: 2 });
    expect(m.name).toBe('x');
    expect(m.pluginApiVersion).toBe(2);
  });

  it('throws when name is missing', () => {
    expect(() => validateManifest({ pluginApiVersion: 2 })).toThrow(/name/);
  });

  it('throws when pluginApiVersion mismatches', () => {
    expect(() => validateManifest({ name: 'x', pluginApiVersion: 1 })).toThrow(/api/i);
  });

  it('throws when input is not an object', () => {
    expect(() => validateManifest(null)).toThrow();
    expect(() => validateManifest('not-an-object')).toThrow();
  });
});

describe('discoverPlugins', () => {
  const TEST_ROOT = path.join(os.tmpdir(), `nanoclaw-plugin-loader-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(TEST_ROOT)) fs.rmSync(TEST_ROOT, { recursive: true });
  });

  it('returns [] when the dir does not exist', async () => {
    const result = await discoverPlugins('/tmp/definitely-does-not-exist-xyz-12345');
    expect(result).toEqual([]);
  });

  it('returns [] when the dir exists but is empty', async () => {
    const dir = path.join(TEST_ROOT, 'empty-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(dir);
    const result = await discoverPlugins(dir);
    expect(result).toEqual([]);
  });

  it('skips subdirectories without plugin.json', async () => {
    const dir = path.join(TEST_ROOT, 'no-manifest-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'subdir-without-manifest'));
    const result = await discoverPlugins(dir);
    expect(result).toEqual([]);
  });

  it('discovers a valid plugin (manifest + plugin.js)', async () => {
    const dir = path.join(TEST_ROOT, 'valid-' + Math.random().toString(36).slice(2, 8));
    const pluginRoot = path.join(dir, 'fixture-a');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({ name: 'fixture-a', pluginApiVersion: 2, version: '0.1.0' }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.js'),
      `export default { name: 'fixture-a', pluginApiVersion: 2, register() {} };\n`,
    );
    const result = await discoverPlugins(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.manifest.name).toBe('fixture-a');
    expect(typeof result[0]!.plugin.register).toBe('function');
  });

  it('throws when a plugin manifest has a wrong pluginApiVersion', async () => {
    const dir = path.join(TEST_ROOT, 'bad-version-' + Math.random().toString(36).slice(2, 8));
    const pluginRoot = path.join(dir, 'fixture-bad');
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.json'),
      JSON.stringify({ name: 'fixture-bad', pluginApiVersion: 1 }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'plugin.js'),
      `export default { name: 'fixture-bad', pluginApiVersion: 1, register() {} };\n`,
    );
    await expect(discoverPlugins(dir)).rejects.toThrow(/api/i);
  });
});

describe('runPluginsRegister', () => {
  it('calls register(host) once on each plugin in order', () => {
    const calls: string[] = [];
    const p1: Plugin = {
      name: 'p1',
      pluginApiVersion: 2,
      register: vi.fn(() => {
        calls.push('p1.register');
      }),
    };
    const p2: Plugin = {
      name: 'p2',
      pluginApiVersion: 2,
      register: vi.fn(() => {
        calls.push('p2.register');
      }),
    };
    const fakeHost = {} as PluginHostApi;
    runPluginsRegister(
      [
        { manifest: { name: 'p1', pluginApiVersion: 2 }, plugin: p1 },
        { manifest: { name: 'p2', pluginApiVersion: 2 }, plugin: p2 },
      ],
      fakeHost,
    );
    expect(p1.register).toHaveBeenCalledWith(fakeHost);
    expect(p2.register).toHaveBeenCalledWith(fakeHost);
    expect(calls).toEqual(['p1.register', 'p2.register']);
  });
});

describe('runPluginsStartup', () => {
  it('awaits onStartup() in order', async () => {
    const calls: string[] = [];
    const p1: Plugin = {
      name: 'p1',
      pluginApiVersion: 2,
      register: () => {},
      onStartup: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        calls.push('p1.startup');
      }),
    };
    const p2: Plugin = {
      name: 'p2',
      pluginApiVersion: 2,
      register: () => {},
      onStartup: vi.fn(async () => {
        calls.push('p2.startup');
      }),
    };
    await runPluginsStartup([
      { manifest: { name: 'p1', pluginApiVersion: 2 }, plugin: p1 },
      { manifest: { name: 'p2', pluginApiVersion: 2 }, plugin: p2 },
    ]);
    expect(calls).toEqual(['p1.startup', 'p2.startup']);
  });

  it('skips plugins without an onStartup method', async () => {
    const p: Plugin = { name: 'p', pluginApiVersion: 2, register: () => {} };
    await expect(
      runPluginsStartup([{ manifest: { name: 'p', pluginApiVersion: 2 }, plugin: p }]),
    ).resolves.toBeUndefined();
  });

  it('register-all order: every register fires before any onStartup', async () => {
    const calls: string[] = [];
    const make = (name: string): Plugin => ({
      name,
      pluginApiVersion: 2,
      register: () => calls.push(`${name}.register`),
      onStartup: async () => {
        calls.push(`${name}.startup`);
      },
    });
    const p1 = make('p1');
    const p2 = make('p2');
    const fakeHost = {} as PluginHostApi;
    const list: DiscoveredPlugin[] = [
      { manifest: { name: 'p1', pluginApiVersion: 2 }, plugin: p1 },
      { manifest: { name: 'p2', pluginApiVersion: 2 }, plugin: p2 },
    ];
    runPluginsRegister(list, fakeHost);
    await runPluginsStartup(list);
    expect(calls).toEqual(['p1.register', 'p2.register', 'p1.startup', 'p2.startup']);
  });
});

describe('buildHostApi', () => {
  it('returns an object with all expected registry callables and getDb that returns the passed db', () => {
    const db = new Database(':memory:');
    const host = buildHostApi(db);
    expect(typeof host.registerMigration).toBe('function');
    expect(typeof host.registerDeliveryAction).toBe('function');
    expect(typeof host.registerHostSweepTask).toBe('function');
    expect(typeof host.registerAccessGateExtension).toBe('function');
    expect(typeof host.registerResponseHandler).toBe('function');
    expect(typeof host.registerApprovalHandler).toBe('function');
    expect(typeof host.registerProviderContainerConfig).toBe('function');
    expect(typeof host.registerReactionHandler).toBe('function');
    expect(typeof host.getChannelAdapter).toBe('function');
    expect(typeof host.writeSessionMessage).toBe('function');
    expect(typeof host.writeSystemResponse).toBe('function');
    expect(typeof host.getHostLlm).toBe('function');
    expect(host.getDb()).toBe(db);
    db.close();
  });

  it('host.getHostLlm() returns a callExtractionLLM-shaped client', () => {
    const db = new Database(':memory:');
    const host = buildHostApi(db);
    const client = host.getHostLlm();
    expect(typeof client.callExtractionLLM).toBe('function');
    db.close();
  });
});
