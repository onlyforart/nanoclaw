/**
 * Fork-only plugin contract for nanoclaw v2.
 *
 * Plugins live as compiled directories under `dist/plugins/<name>/` with
 * a `plugin.json` manifest and a `plugin.js` ESM module exporting a
 * `Plugin` (default-export or named `plugin`). The host loader
 * (`plugin-loader.ts`) discovers them at startup and runs a two-phase
 * lifecycle: `register(host)` for all plugins, then `onStartup()` for
 * all plugins. See §4.6.5 of the v1→v2 migration plan.
 */
import type Database from 'better-sqlite3';

import type { ChannelAdapter } from './channels/adapter.js';
import type { Migration } from './db/migrations/index.js';
import type { DeliveryActionHandler } from './delivery.js';
import type { HostLlmClient } from './host-llm.js';
import type { HostSweepFn } from './host-sweep-tasks.js';
import type { ApprovalHandler } from './modules/approvals/primitive.js';
import type { ProviderContainerConfigFn } from './providers/provider-container-registry.js';
import type { ReactionHandler } from './reaction-handlers.js';
import type { ResponseHandler } from './response-registry.js';
import type { bootstrapAgentGroup } from './plugin-bootstrap.js';
import type { AccessGateExtensionFn } from './router.js';
import type { writeSessionMessage, writeSystemResponse } from './session-manager.js';

export const PLUGIN_API_VERSION = 2;

export interface PluginHostApi {
  // Registries
  registerMigration: (m: Migration) => void;
  registerDeliveryAction: (action: string, handler: DeliveryActionHandler) => void;
  registerHostSweepTask: (name: string, fn: HostSweepFn, intervalMs: number) => void;
  registerAccessGateExtension: (fn: AccessGateExtensionFn) => void;
  registerResponseHandler: (handler: ResponseHandler) => void;
  registerApprovalHandler: (action: string, handler: ApprovalHandler) => void;
  registerProviderContainerConfig: (name: string, fn: ProviderContainerConfigFn) => void;
  registerReactionHandler: (handler: ReactionHandler) => void;
  // Capability accessors. `getDb` is safe to call from either phase
  // because the loader is invoked after `initDb()` in `main()`.
  // `getHostLlm` is similarly safe — `initHostLlm()` runs before
  // plugins load.
  getDb: () => Database.Database;
  getChannelAdapter: (channelType: string) => ChannelAdapter | undefined;
  writeSessionMessage: typeof writeSessionMessage;
  writeSystemResponse: typeof writeSystemResponse;
  getHostLlm: () => HostLlmClient;
  /**
   * Composite bootstrap for plugin-internal agent groups (e.g.
   * pipeline monitor / solver / responder). Creates agent_groups +
   * filesystem + messaging_groups + messaging_group_agents wiring +
   * sessions in one shot. Idempotent — safe to call on every plugin
   * onStartup. See `plugin-bootstrap.ts`.
   */
  bootstrapAgentGroup: typeof bootstrapAgentGroup;
}

export interface PluginManifest {
  name: string;
  pluginApiVersion: 2;
  version?: string;
}

export interface Plugin {
  name: string;
  pluginApiVersion: 2;
  register(host: PluginHostApi): void;
  onStartup?(): Promise<void>;
}
