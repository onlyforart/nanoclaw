import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  loadPlugin,
  PLUGIN_API_VERSION,
  type PluginManifest,
} from './pipeline-plugin.js';

// Create a temporary plugin directory alongside the compiled output
// to test the manifest loading logic.
const distDir = path.dirname(new URL(import.meta.url).pathname);
const pluginDir = path.join(distDir, 'pipeline');

function writeManifest(manifest: Partial<PluginManifest>): void {
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify(manifest),
  );
}

function writePluginModule(exportName: string = 'default'): void {
  const code =
    exportName === 'default'
      ? `export default { name: 'test-pipeline' };`
      : `export const plugin = { name: 'test-pipeline' };`;
  fs.writeFileSync(path.join(pluginDir, 'plugin.js'), code);
}

beforeEach(() => {
  fs.mkdirSync(pluginDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

describe('loadPlugin', () => {
  it('returns null when plugin directory does not exist', async () => {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    const plugin = await loadPlugin();
    expect(plugin).toBeNull();
  });

  it('returns null when manifest is missing', async () => {
    // Directory exists but no plugin.json
    const plugin = await loadPlugin();
    expect(plugin).toBeNull();
  });

  it('rejects plugin with wrong API version', async () => {
    writeManifest({
      name: 'test',
      version: '1.0.0',
      pluginApiVersion: 999,
      entry: 'plugin.js',
    });
    writePluginModule();
    const plugin = await loadPlugin();
    expect(plugin).toBeNull();
  });

  it('loads plugin with matching API version', async () => {
    writeManifest({
      name: 'test',
      version: '1.0.0',
      pluginApiVersion: PLUGIN_API_VERSION,
      entry: 'plugin.js',
    });
    writePluginModule();
    const plugin = await loadPlugin();
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('test-pipeline');
  });

  it('loads plugin exported as named export', async () => {
    writeManifest({
      name: 'test',
      version: '1.0.0',
      pluginApiVersion: PLUGIN_API_VERSION,
      entry: 'plugin.js',
    });
    writePluginModule('named');
    const plugin = await loadPlugin();
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe('test-pipeline');
  });

  it('returns null when entry module has no name field', async () => {
    writeManifest({
      name: 'test',
      version: '1.0.0',
      pluginApiVersion: PLUGIN_API_VERSION,
      entry: 'empty-plugin.js',
    });
    fs.writeFileSync(
      path.join(pluginDir, 'empty-plugin.js'),
      'export default { version: "1.0.0" };', // no name field
    );
    const plugin = await loadPlugin();
    expect(plugin).toBeNull();
  });

  it('exports PLUGIN_API_VERSION as a number', () => {
    expect(typeof PLUGIN_API_VERSION).toBe('number');
    expect(PLUGIN_API_VERSION).toBeGreaterThan(0);
  });
});
