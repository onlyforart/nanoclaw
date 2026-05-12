/**
 * Fork-only plugin loader (§4.6.5 of the v1→v2 migration plan).
 *
 * Discovers compiled plugins under `dist/plugins/<name>/`, validates each
 * manifest's `pluginApiVersion`, and runs a two-phase lifecycle:
 *
 *   1. `register(host)` for every plugin — populates the host registries
 *      (migrations, delivery actions, sweep tasks, access-gate extensions,
 *      reaction handlers, etc.).
 *   2. `onStartup()` for every plugin — runs after channel adapters and
 *      delivery polls are live.
 *
 * Errors in either phase are fatal. Reaction handlers are the one
 * hot-path exception (see `reaction-handlers.ts`).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { getChannelAdapter } from './channels/channel-registry.js';
import { registerMigration } from './db/migrations/index.js';
import { registerDeliveryAction } from './delivery.js';
import { registerHostSweepTask } from './host-sweep-tasks.js';
import { log } from './log.js';
import { registerApprovalHandler } from './modules/approvals/primitive.js';
import { PLUGIN_API_VERSION, type Plugin, type PluginHostApi, type PluginManifest } from './plugin-contract.js';
import { registerProviderContainerConfig } from './providers/provider-container-registry.js';
import { registerReactionHandler } from './reaction-handlers.js';
import { registerResponseHandler } from './response-registry.js';
import { registerAccessGateExtension } from './router.js';
import { getHostLlm } from './host-llm.js';
import { bootstrapAgentGroup } from './plugin-bootstrap.js';
import { writeSessionMessage, writeSystemResponse } from './session-manager.js';

const PLUGINS_DIR = path.resolve(process.cwd(), 'dist/plugins');

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  plugin: Plugin;
}

const loaded: DiscoveredPlugin[] = [];

/**
 * Pure manifest validator. Throws when the input isn't a plain object,
 * lacks a `name`, or carries a `pluginApiVersion` other than the host's
 * `PLUGIN_API_VERSION`. Version drift is a deploy bug — fail fast.
 */
export function validateManifest(raw: unknown): PluginManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Plugin manifest must be a JSON object');
  }
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || m.name.length === 0) {
    throw new Error('Plugin manifest is missing a non-empty "name"');
  }
  if (m.pluginApiVersion !== PLUGIN_API_VERSION) {
    throw new Error(
      `Plugin "${m.name}" plugin API version mismatch: ` +
        `manifest=${String(m.pluginApiVersion)}, host=${PLUGIN_API_VERSION}`,
    );
  }
  const out: PluginManifest = { name: m.name, pluginApiVersion: PLUGIN_API_VERSION };
  if (typeof m.version === 'string') out.version = m.version;
  return out;
}

/**
 * Walk `dir` looking for subdirectories with a `plugin.json` manifest +
 * `plugin.js` ESM module. Returns [] when `dir` itself is absent. Throws
 * when any discovered manifest is malformed or fails version validation.
 */
export async function discoverPlugins(dir: string): Promise<DiscoveredPlugin[]> {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const found: DiscoveredPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginRoot = path.join(dir, entry.name);
    const manifestPath = path.join(pluginRoot, 'plugin.json');
    if (!fs.existsSync(manifestPath)) continue;

    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifest = validateManifest(raw);

    const pluginModulePath = path.join(pluginRoot, 'plugin.js');
    const mod = (await import(pathToFileURL(pluginModulePath).href)) as {
      default?: Plugin;
      plugin?: Plugin;
    };
    const plugin = mod.default ?? mod.plugin;
    if (!plugin) {
      throw new Error(`Plugin "${manifest.name}" plugin.js does not export a default or named "plugin"`);
    }

    found.push({ manifest, plugin });
  }

  return found;
}

/** Pure: run `register(host)` on each plugin in order. */
export function runPluginsRegister(plugins: DiscoveredPlugin[], host: PluginHostApi): void {
  for (const { plugin } of plugins) plugin.register(host);
}

/** Pure: await `onStartup()` on each plugin in order; skip plugins without one. */
export async function runPluginsStartup(plugins: DiscoveredPlugin[]): Promise<void> {
  for (const { plugin } of plugins) {
    if (plugin.onStartup) await plugin.onStartup();
  }
}

/**
 * Public entry — register phase. Discovers plugins and runs each
 * `register(host)`. Stores the discovered list in module state so
 * `runPluginStartup()` can later iterate the same set.
 */
export async function loadPluginsRegister(host: PluginHostApi): Promise<void> {
  const plugins = await discoverPlugins(PLUGINS_DIR);
  runPluginsRegister(plugins, host);
  loaded.push(...plugins);
  log.info('Plugins registered', { count: plugins.length });
}

/** Public entry — startup phase. Awaits each registered plugin's `onStartup()`. */
export async function runPluginStartup(): Promise<void> {
  await runPluginsStartup(loaded);
  log.info('Plugins started', { count: loaded.length });
}

/** Assemble the host API object handed to each plugin's `register(host)`. */
export function buildHostApi(db: Database.Database): PluginHostApi {
  return {
    registerMigration,
    registerDeliveryAction,
    registerHostSweepTask,
    registerAccessGateExtension,
    registerResponseHandler,
    registerApprovalHandler,
    registerProviderContainerConfig,
    registerReactionHandler,
    getDb: () => db,
    getChannelAdapter,
    writeSessionMessage,
    writeSystemResponse,
    getHostLlm,
    bootstrapAgentGroup,
  };
}
