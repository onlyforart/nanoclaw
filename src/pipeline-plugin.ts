import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { IpcDeps } from './ipc.js';
import { logger } from './logger.js';
import type {
  Channel,
  EventRow,
  RegisteredGroup,
  ScheduledTask,
} from './types.js';

/**
 * Hook interface for pipeline plugins.
 *
 * The observation pipeline (sanitiser → monitor → solver → responder) is
 * implemented as a plugin so that pipeline-specific code can live in a
 * separate private repository while nanoclaw core remains upstream-safe.
 *
 * Each method is optional — core code calls hooks with optional chaining
 * and falls back to default behaviour when no plugin is installed.
 */
export interface PipelinePlugin {
  name: string;

  // --- Message handling (index.ts) ---

  /** Should this group bypass the sender allowlist? (e.g. passive channels) */
  shouldBypassSenderAllowlist?(group: RegisteredGroup): boolean;

  /** Backfill missed messages on startup (e.g. Slack conversations.history) */
  onStartupBackfill?(
    channels: Channel[],
    passiveJids: string[],
    cursors: Record<string, string>,
  ): Promise<void>;

  // --- Event publishing (ipc.ts) ---

  /** Enrich event payloads before storage (e.g. inject source_message_id) */
  enrichEventPayload?(eventType: string, payload: string): string;

  /** Called after a new event is published (e.g. auto-ack escalations) */
  onEventPublished?(eventType: string, payload: string, deps: IpcDeps): void;

  // --- Event consumption (ipc.ts) ---

  /** Transform events before delivery to container (e.g. nonce wrapping) */
  transformConsumedEvents?(events: EventRow[]): EventRow[];

  // --- Cross-channel sends (ipc.ts) ---

  /** Intercept cross-channel sends from pipeline tasks.
   *  Return an IPC result to handle it, or null to fall through. */
  onCrossChannelSend?(
    data: Record<string, unknown>,
    sourceTaskId: string,
    registeredGroups: Record<string, RegisteredGroup>,
    deps: IpcDeps,
  ): Promise<{ success: boolean; error?: string } | null>;

  // --- IPC extension (ipc.ts) ---

  /** Handle plugin-specific IPC task types.
   *  Return a result to handle it, or null to fall through to "unknown type". */
  handleIpcTask?(
    type: string,
    data: Record<string, unknown>,
    sourceGroup: string,
    isMain: boolean,
    deps: IpcDeps,
  ): Promise<{
    success: boolean;
    error?: string;
    [key: string]: unknown;
  } | null>;

  // --- Startup (index.ts) ---

  /** Called once during startup. Plugin can reconcile tasks, run migrations, etc. */
  onStartup?(): void;

  // --- Task scheduling (task-scheduler.ts) ---

  /** Called for tasks with executionMode === 'host_pipeline' */
  executeHostTask?(task: ScheduledTask, startTime: number): Promise<void>;

  // --- DB migrations ---

  /** SQL statements to run on startup (CREATE TABLE IF NOT EXISTS, etc.) */
  migrations?(): string[];
}

/**
 * Increment this when making breaking changes to the PipelinePlugin interface.
 * Plugins declare the API version they were built against in plugin.json.
 * A mismatch means the plugin needs to be rebuilt.
 */
export const PLUGIN_API_VERSION = 1;

export interface PluginManifest {
  name: string;
  version: string;
  pluginApiVersion: number;
  entry: string;
  description?: string;
  nanoclaw?: {
    minVersion?: string;
  };
}

/**
 * Load the pipeline plugin, if installed.
 * Returns null when no plugin is available — all hook call sites
 * use optional chaining so this is safe.
 *
 * The plugin is installed by symlinking compiled JS into dist/pipeline/.
 * A plugin.json manifest in that directory declares API version compatibility.
 */
export async function loadPlugin(): Promise<PipelinePlugin | null> {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pluginDir = path.join(__dirname, 'pipeline');
    const manifestPath = path.join(pluginDir, 'plugin.json');

    if (!fs.existsSync(manifestPath)) return null;

    const manifest: PluginManifest = JSON.parse(
      fs.readFileSync(manifestPath, 'utf-8'),
    );

    if (manifest.pluginApiVersion !== PLUGIN_API_VERSION) {
      logger.error(
        {
          expected: PLUGIN_API_VERSION,
          got: manifest.pluginApiVersion,
          plugin: manifest.name,
        },
        'Plugin API version mismatch — rebuild the plugin',
      );
      return null;
    }

    if (manifest.nanoclaw?.minVersion) {
      try {
        const pkgPath = path.join(__dirname, '..', 'package.json');
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.version && pkg.version < manifest.nanoclaw.minVersion) {
          logger.warn(
            {
              required: manifest.nanoclaw.minVersion,
              current: pkg.version,
              plugin: manifest.name,
            },
            'Plugin requires a newer nanoclaw version',
          );
        }
      } catch {
        /* version check is best-effort */
      }
    }

    const entryPath = path.join(pluginDir, manifest.entry);
    const mod = await import(entryPath);
    const plugin = (mod.default ?? mod.plugin) as PipelinePlugin | undefined;
    if (!plugin?.name) return null;

    logger.info(
      { plugin: plugin.name, version: manifest.version },
      'Pipeline plugin loaded',
    );
    return plugin;
  } catch {
    return null; // Plugin not installed or failed to load
  }
}
