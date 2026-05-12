/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { DATA_DIR } from './config.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { startHostSweepTasks, stopHostSweepTasks } from './host-sweep-tasks.js';
import { buildHostApi, loadPluginsRegister, runPluginStartup } from './plugin-loader.js';
import { regenerateAllAgentGroups } from './container-config-generator.js';
import { getAllAgentGroups } from './db/agent-groups.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

import { buildChannelSetup } from './channel-setup.js';
import { initChannelAdapters, teardownChannelAdapters, getChannelAdapter } from './channels/channel-registry.js';
import { initHostLlm } from './host-llm.js';
import { preflightOneCLI } from './onecli-precheck.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. OneCLI startup gate (K.1.h A.5). Refuse to boot without the
  // credential gateway — agents must never see raw credentials. Runs
  // BEFORE any other startup work so a misconfigured install dies fast
  // and visibly rather than silently spawning containers that 401.
  await preflightOneCLI();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);

  // 1a. Bootstrap host-side LLM credential plumbing via OneCLI.
  // Runs before plugin load so any failure surfaces at boot, not the
  // first call (per `feedback_credential_plane_onecli`).
  await initHostLlm();

  // 1b. Plugin register-phase. Discovers compiled plugins under
  // dist/plugins/ and runs each plugin.register(host). Must precede
  // runMigrations(db) so plugins' registerMigration() calls land before
  // the migration runner fires.
  await loadPluginsRegister(buildHostApi(db));

  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 1c. Regenerate per-group container.json from data/mcp-servers.json +
  // data/mcp-exclusions.json. Must run before container spawns so the
  // mount-allowlist contains the hostPaths the generator just emitted.
  const ccGenSummary = regenerateAllAgentGroups(getAllAgentGroups().map((g) => g.folder));
  log.info('container-config generator complete', {
    groupsProcessed: ccGenSummary.groupsProcessed,
    groupsSkipped: ccGenSummary.groupsSkipped,
    serversInstalledTotal: ccGenSummary.serversInstalledTotal,
    mountAllowlistAdds: ccGenSummary.mountAllowlistUpdates.length,
    changed: ccGenSummary.changedGroups.length,
    errors: ccGenSummary.errors.length,
  });
  for (const e of ccGenSummary.errors) {
    log.warn('container-config generator error', e);
  }

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters(buildChannelSetup);

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start plugin-registered periodic host tasks. Fork-loaded plugins
  // (§4.6.5 plugin loader) call registerHostSweepTask during their
  // register() phase; we kick the scheduler here, last, so all the
  // surfaces a task could touch (delivery, DB, adapters) are live.
  startHostSweepTasks();
  log.info('Host sweep tasks started');

  // 8. Plugin startup-phase. Runs each loaded plugin's onStartup() in
  // registration order. Last because the typical plugin-startup pattern
  // (channel scan, backfill, queue rehydrate) wants every other host
  // surface live first.
  await runPluginStartup();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  stopHostSweepTasks();
  await teardownChannelAdapters();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
