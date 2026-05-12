import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { log } from './log.js';
import { registerHostSweepTask, startHostSweepTasks, stopHostSweepTasks } from './host-sweep-tasks.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  stopHostSweepTasks();
  vi.useRealTimers();
});

describe('registerHostSweepTask + start/stop', () => {
  it('fires a registered task after intervalMs', async () => {
    const fn = vi.fn();
    registerHostSweepTask('fires-after-interval', fn, 100);

    startHostSweepTasks();
    expect(fn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps firing on each tick (recursive reschedule)', async () => {
    const fn = vi.fn();
    registerHostSweepTask('fires-many-times', fn, 50);

    startHostSweepTasks();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    const calls = fn.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('stop prevents further ticks', async () => {
    const fn = vi.fn();
    registerHostSweepTask('stops-cleanly', fn, 100);

    startHostSweepTasks();
    await vi.advanceTimersByTimeAsync(100);
    const callsAtStop = fn.mock.calls.filter((c, i) => fn.mock.results[i]).length;

    stopHostSweepTasks();
    await vi.advanceTimersByTimeAsync(500);

    const callsAfterStop = fn.mock.calls.length;
    expect(callsAfterStop).toBe(callsAtStop);
  });

  it('throws on duplicate name registration', () => {
    const fn = vi.fn();
    registerHostSweepTask('dup-name', fn, 100);
    expect(() => registerHostSweepTask('dup-name', fn, 100)).toThrowError(/dup-name/);
  });

  it('catches sync throw in fn and keeps the loop alive', async () => {
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      throw new Error('boom-sync');
    });
    registerHostSweepTask('sync-throw', fn, 100);

    startHostSweepTasks();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    expect(log.warn).toHaveBeenCalledWith('Host sweep task threw', expect.objectContaining({ name: 'sync-throw' }));

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
  });

  it('catches async rejection in fn and logs via log.warn', async () => {
    const fn = vi.fn(() => Promise.reject(new Error('boom-async')));
    registerHostSweepTask('async-reject', fn, 100);

    startHostSweepTasks();
    await vi.advanceTimersByTimeAsync(100);

    expect(fn).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Host sweep task threw', expect.objectContaining({ name: 'async-reject' }));
  });

  it('slow task does not overlap itself — next tick waits for current to resolve', async () => {
    let resolveTask: (() => void) | null = null;
    const taskPromise = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });
    const fn = vi.fn(() => taskPromise);

    registerHostSweepTask('slow-task', fn, 50);
    startHostSweepTasks();

    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(fn).toHaveBeenCalledTimes(1);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
