import type { IpcDeps } from './ipc.js';
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
 * Load the pipeline plugin, if installed.
 * Returns null when no plugin is available — all hook call sites
 * use optional chaining so this is safe.
 *
 * The plugin is loaded via dynamic import from src/pipeline/plugin.js,
 * which is a gitignored symlink to the private plugin repository.
 */
export async function loadPlugin(): Promise<PipelinePlugin | null> {
  try {
    // Dynamic path prevents TypeScript from resolving at compile time.
    // The module exists only when the plugin is installed (symlinked).
    const pluginPath = './pipeline/plugin.js';
    const mod = await (Function('p', 'return import(p)')(pluginPath) as Promise<
      Record<string, unknown>
    >);
    const plugin = (mod.default ?? mod.plugin) as PipelinePlugin | undefined;
    if (plugin?.name) return plugin;
    return null;
  } catch {
    return null; // Plugin not installed — all hooks are no-ops
  }
}
