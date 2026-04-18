import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  ackEvent,
  consumeEvents,
  createTask,
  getTaskById,
  hasPendingEventsOfTypes,
  publishEvent,
} from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

// Mock the LLM client so host_pipeline tests don't hit a real Ollama
vi.mock('./sanitiser/llm-client.js', () => ({
  callExtractionLLM: vi.fn(async () => ({
    response: JSON.stringify({
      fact_summary: 'Test observation from scheduler',
      urgency: 'issue',
      speech_act: 'fresh_report',
      reporter_role_hint: 'original_reporter',
      appears_to_address_bot: false,
      contains_imperative: false,
      sentiment: 'neutral',
      action_requested: null,
      resolution_owner_hint: 'this_team',
    }),
    inputTokens: 100,
    outputTokens: 50,
    costUSD: null,
  })),
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('persists and reads useAgentSdk from the database', () => {
    createTask({
      id: 'task-sdk-true',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run with sdk',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
      useAgentSdk: true,
    });

    const task = getTaskById('task-sdk-true');
    expect(task).toBeDefined();
    expect(task!.useAgentSdk).toBe(1); // SQLite stores booleans as integers

    // Default (not specified) should be falsy
    createTask({
      id: 'task-sdk-default',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run without sdk',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const task2 = getTaskById('task-sdk-default');
    expect(task2).toBeDefined();
    expect(task2!.useAgentSdk).toBeFalsy();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  // host_pipeline execution tests moved to pipeline plugin

  it('computeNextRun returns null for event-type tasks without fallback', () => {
    const task = {
      id: 'event-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'event' as const,
      schedule_value: '',
      context_mode: 'isolated' as const,
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun returns fallback time for event-type tasks with fallbackPollMs', () => {
    const task = {
      id: 'event-fallback-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'event' as const,
      schedule_value: '',
      context_mode: 'isolated' as const,
      fallbackPollMs: 3600000, // 1 hour
      next_run: null,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Should be approximately 1 hour from now
    const delta = new Date(nextRun!).getTime() - Date.now();
    expect(delta).toBeGreaterThan(3500000);
    expect(delta).toBeLessThanOrEqual(3600000);
  });

  it('hasPendingEventsOfTypes excludes claimed events (orphan claims do not count as pending)', () => {
    // Publish one observation event (starts as 'pending')
    publishEvent(
      'observation.passive',
      'slack_main',
      'producer',
      '{}',
      null,
      null,
    );
    expect(hasPendingEventsOfTypes(['observation.*'])).toBe(true);

    // Claim it — simulates mid-processing state
    const claimed = consumeEvents(['observation.*'], 'pipeline:monitor', 10);
    expect(claimed).toHaveLength(1);
    // Orphan claim: consumeEvents ran but ackEvent never did (crash mid-run).
    // The event is now status='claimed' and will never be returned again by
    // consumeEvents. Pre-flight must NOT count it as work to do, otherwise
    // the scheduler fires the LLM every fallback tick for nothing.
    expect(hasPendingEventsOfTypes(['observation.*'])).toBe(false);

    // Ack releases the slot; a fresh publish should be visible again.
    ackEvent(claimed[0].id, 'done');
    publishEvent(
      'observation.passive',
      'slack_main',
      'producer',
      '{}',
      null,
      null,
    );
    expect(hasPendingEventsOfTypes(['observation.*'])).toBe(true);
  });

  it('event-type task stays active after run with null nextRun', async () => {
    createTask({
      id: 'event-active-test',
      group_folder: 'slack_main',
      chat_jid: 'slack:CMAIN',
      prompt: 'monitor prompt',
      schedule_type: 'event',
      schedule_value: '',
      context_mode: 'isolated',
      subscribedEventTypes: ['observation.*'],
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'slack:CMAIN': {
          name: 'Main',
          folder: 'slack_main',
          trigger: 'always',
          added_at: '2024-01-01T00:00:00.000Z',
          isMain: true,
        },
      }),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    // Task should stay active, not completed
    const task = getTaskById('event-active-test');
    expect(task!.status).toBe('active');
    // next_run should be null (no fallback)
    expect(task!.next_run).toBeNull();
  });
});
