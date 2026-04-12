import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { GroupQueue } from './group-queue.js';

// Mock config to control concurrency limit
vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 3,
}));

// Mock fs operations used by sendMessage/closeStdin
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

describe('GroupQueue', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Message container isolation ---

  it('only runs one message container per group at a time', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const processMessages = vi.fn(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 100));
      concurrentCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(200);

    expect(maxConcurrent).toBe(1);
  });

  // --- Task and message containers run concurrently ---

  it('runs task and message containers concurrently for same group', async () => {
    let messageRunning = false;
    let taskRunning = false;
    let bothRanConcurrently = false;
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      messageRunning = true;
      if (taskRunning) bothRanConcurrently = true;
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      messageRunning = false;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);
    expect(messageRunning).toBe(true);

    // Start task container — should run concurrently, not queue
    const taskFn = vi.fn(async () => {
      taskRunning = true;
      if (messageRunning) bothRanConcurrently = true;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      taskRunning = false;
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(bothRanConcurrently).toBe(true);
    expect(taskFn).toHaveBeenCalled();

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Tasks don't block messages ---

  it('messages are not blocked by running tasks', async () => {
    let resolveTask: () => void;
    const executionOrder: string[] = [];

    const processMessages = vi.fn(async () => {
      executionOrder.push('messages');
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start a task
    const taskFn = vi.fn(async () => {
      executionOrder.push('task-start');
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
      executionOrder.push('task-end');
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Enqueue a message while task is running — should start immediately
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Message should have processed even though task is still running
    expect(executionOrder).toContain('messages');
    // task-end hasn't happened yet — task is still blocked on resolveTask
    expect(executionOrder).not.toContain('task-end');

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Global concurrency limit ---

  it('respects global concurrency limit', async () => {
    let activeCount = 0;
    let maxActive = 0;
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async () => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      activeCount--;
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Enqueue 4 groups (limit is 3)
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    queue.enqueueMessageCheck('group4@g.us');

    await vi.advanceTimersByTimeAsync(10);

    expect(maxActive).toBe(3);
    expect(activeCount).toBe(3);

    // Complete one — fourth should start
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processMessages).toHaveBeenCalledTimes(4);
  });

  // --- Tasks queue behind tasks, not behind messages ---

  it('queues tasks behind running tasks, not behind running messages', async () => {
    let resolveTask1: () => void;
    let resolveMessage: () => void;
    const executionOrder: string[] = [];

    const processMessages = vi.fn(async () => {
      executionOrder.push('messages');
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start message container
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Start task (runs concurrently with message)
    const task1Fn = vi.fn(async () => {
      executionOrder.push('task-1');
      await new Promise<void>((resolve) => {
        resolveTask1 = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', task1Fn);
    await vi.advanceTimersByTimeAsync(10);

    // Queue another task — should wait for task-1, not for message
    const task2Fn = vi.fn(async () => {
      executionOrder.push('task-2');
    });
    queue.enqueueTask('group1@g.us', 'task-2', task2Fn);
    await vi.advanceTimersByTimeAsync(10);

    // task-2 should not have run yet (task-1 still active)
    expect(executionOrder).not.toContain('task-2');

    // Complete task-1 — task-2 should drain
    resolveTask1!();
    await vi.advanceTimersByTimeAsync(10);
    expect(executionOrder).toContain('task-2');

    resolveMessage!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- Retry with backoff on failure ---

  it('retries with exponential backoff on failure', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // failure
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    // First retry after 5000ms
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(2);

    // Second retry after 10000ms
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(3);
  });

  // --- Shutdown prevents new enqueues ---

  it('prevents new enqueues after shutdown', async () => {
    const processMessages = vi.fn(async () => true);
    queue.setProcessMessagesFn(processMessages);

    await queue.shutdown(1000);

    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(100);

    expect(processMessages).not.toHaveBeenCalled();
  });

  // --- Max retries exceeded ---

  it('stops retrying after MAX_RETRIES and resets', async () => {
    let callCount = 0;

    const processMessages = vi.fn(async () => {
      callCount++;
      return false; // always fail
    });

    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');

    await vi.advanceTimersByTimeAsync(10);
    expect(callCount).toBe(1);

    const retryDelays = [5000, 10000, 20000, 40000, 80000];
    for (let i = 0; i < retryDelays.length; i++) {
      await vi.advanceTimersByTimeAsync(retryDelays[i] + 10);
      expect(callCount).toBe(i + 2);
    }

    const countAfterMaxRetries = callCount;
    await vi.advanceTimersByTimeAsync(200000);
    expect(callCount).toBe(countAfterMaxRetries);
  });

  // --- Waiting groups get drained when slots free up ---

  it('drains waiting groups when active slots free up', async () => {
    const processed: string[] = [];
    const completionCallbacks: Array<() => void> = [];

    const processMessages = vi.fn(async (groupJid: string) => {
      processed.push(groupJid);
      await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Fill all 3 slots
    queue.enqueueMessageCheck('group1@g.us');
    queue.enqueueMessageCheck('group2@g.us');
    queue.enqueueMessageCheck('group3@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Queue a fourth
    queue.enqueueMessageCheck('group4@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toEqual(['group1@g.us', 'group2@g.us', 'group3@g.us']);

    // Free up a slot
    completionCallbacks[0]();
    await vi.advanceTimersByTimeAsync(10);

    expect(processed).toContain('group4@g.us');
  });

  // --- Running task dedup ---

  it('rejects duplicate enqueue of a currently-running task', async () => {
    let resolveTask: () => void;
    let taskCallCount = 0;

    const taskFn = vi.fn(async () => {
      taskCallCount++;
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);
    expect(taskCallCount).toBe(1);

    const dupFn = vi.fn(async () => {});
    queue.enqueueTask('group1@g.us', 'task-1', dupFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(dupFn).not.toHaveBeenCalled();

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);

    expect(taskCallCount).toBe(1);
  });

  // --- sendMessage returns false when no message container ---

  it('sendMessage returns false when no message container is active', async () => {
    let resolveTask: () => void;

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });

    // Start a task (only task slot is active, not message slot)
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // sendMessage should return false — no message container running
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(false);

    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });

  // --- registerProcess with isTask flag ---

  it('registers process in correct slot based on isTask flag', async () => {
    let resolveMessage: () => void;
    let resolveTask: () => void;

    const processMessages = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveMessage = resolve;
      });
      return true;
    });

    queue.setProcessMessagesFn(processMessages);

    // Start both containers
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    const taskFn = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveTask = resolve;
      });
    });
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    // Register message process
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'msg-container',
      'test-group',
      false,
    );
    // Register task process
    queue.registerProcess(
      'group1@g.us',
      {} as any,
      'task-container',
      'test-group',
      true,
    );

    // sendMessage should work (message container is registered)
    const fs = await import('fs');
    vi.mocked(fs.default.renameSync).mockImplementation(() => {});
    const result = queue.sendMessage('group1@g.us', 'hello');
    expect(result).toBe(true);

    resolveMessage!();
    resolveTask!();
    await vi.advanceTimersByTimeAsync(10);
  });
});
