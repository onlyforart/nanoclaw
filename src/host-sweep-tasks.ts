/**
 * Plugin-extensible periodic host tasks. Distinct from
 * `src/host-sweep.ts` (which sweeps per-session DB state every 60s
 * across all active sessions) — this registry lets fork-loaded
 * plugins (e.g. observation-pipeline) attach their own periodic
 * work to host startup. Two adjacent abstractions with intentionally
 * similar names; both run on the host process.
 *
 * Pattern: recursive setTimeout, NOT setInterval. The next tick is
 * scheduled only AFTER the current one resolves, so slow ticks
 * (>= intervalMs) cannot overlap themselves. Matches the pattern
 * already used by `host-sweep.ts`, `startActiveDeliveryPoll`, and
 * `startSweepDeliveryPoll`.
 */
import { log } from './log.js';

export type HostSweepFn = () => void | Promise<void>;

interface RegisteredTask {
  name: string;
  fn: HostSweepFn;
  intervalMs: number;
}

const registered: RegisteredTask[] = [];
const handles = new Map<string, NodeJS.Timeout>();
let running = false;

export function registerHostSweepTask(name: string, fn: HostSweepFn, intervalMs: number): void {
  if (registered.some((t) => t.name === name)) {
    throw new Error(`Host sweep task already registered: ${name}`);
  }
  registered.push({ name, fn, intervalMs });
}

export function startHostSweepTasks(): void {
  if (running) return;
  running = true;
  for (const t of registered) scheduleNext(t);
}

export function stopHostSweepTasks(): void {
  running = false;
  for (const [, h] of handles) clearTimeout(h);
  handles.clear();
}

function scheduleNext(task: RegisteredTask): void {
  if (!running) return;
  const h = setTimeout(async () => {
    try {
      await task.fn();
    } catch (err) {
      log.warn('Host sweep task threw', { name: task.name, err });
    }
    scheduleNext(task);
  }, task.intervalMs);
  handles.set(task.name, h);
}
