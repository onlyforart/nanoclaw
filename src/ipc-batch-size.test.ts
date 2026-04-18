import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  publishEvent,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();
  setRegisteredGroup('slack:CMAIN', MAIN);
  deps = {
    sendMessage: async () => {},
    registeredGroups: () => ({ 'slack:CMAIN': MAIN }),
    registerGroup: () => {},
    updateGroup: () => {},
    syncGroups: async () => {},
    refreshAllGroupSnapshots: () => {},
    refreshAllTaskSnapshots: () => {},
  };
});

function seedEvents(n: number, type = 'candidate.question'): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      publishEvent(
        type,
        'slack_main',
        'test',
        JSON.stringify({ i }),
        null,
        null,
      ).id,
    );
  }
  return ids;
}

describe('consume_events batch_size cap (F2.b)', () => {
  it('F2b.1 — task with batch_size=1 caps claim to 1 event even when LLM asks for more', async () => {
    createTask({
      id: 'pipeline:solver',
      group_folder: 'slack_main',
      chat_jid: 'slack:CMAIN',
      prompt: 'solver',
      schedule_type: 'event',
      schedule_value: '',
      context_mode: 'isolated',
      subscribedEventTypes: ['candidate.*'],
      batchSize: 1,
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    seedEvents(5);

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['candidate.*'],
        claimedBy: 'pipeline:solver',
        limit: 50, // LLM asks for 50; cap should reduce to 1
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    const events = (result as any).events;
    expect(events).toHaveLength(1);
  });

  it('F2b.2 — task with no batch_size uses the LLM-requested limit', async () => {
    createTask({
      id: 'no-cap-task',
      group_folder: 'slack_main',
      chat_jid: 'slack:CMAIN',
      prompt: 'no cap',
      schedule_type: 'event',
      schedule_value: '',
      context_mode: 'isolated',
      subscribedEventTypes: ['candidate.*'],
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    seedEvents(4);

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['candidate.*'],
        claimedBy: 'no-cap-task',
        limit: 3,
      },
      'slack_main',
      true,
      deps,
    );

    const events = (result as any).events;
    expect(events).toHaveLength(3);
  });

  it('F2b.3 — unknown claimed_by (not a task row) uses the LLM-requested limit', async () => {
    seedEvents(5);

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['candidate.*'],
        claimedBy: 'ad-hoc-consumer',
        limit: 2,
      },
      'slack_main',
      true,
      deps,
    );

    const events = (result as any).events;
    expect(events).toHaveLength(2);
  });

  it('F2b.4 — batch_size honours LLM limit when LLM asks for fewer than cap', async () => {
    createTask({
      id: 'capped-task',
      group_folder: 'slack_main',
      chat_jid: 'slack:CMAIN',
      prompt: 'cap 5',
      schedule_type: 'event',
      schedule_value: '',
      context_mode: 'isolated',
      subscribedEventTypes: ['candidate.*'],
      batchSize: 5,
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    seedEvents(10);

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['candidate.*'],
        claimedBy: 'capped-task',
        limit: 2, // LLM asks for 2; cap is 5 → take LLM's smaller number
      },
      'slack_main',
      true,
      deps,
    );

    const events = (result as any).events;
    expect(events).toHaveLength(2);
  });

  it('F2b.5 — round-trip persists batch_size through createTask/getTaskById', async () => {
    createTask({
      id: 'persist-batch',
      group_folder: 'slack_main',
      chat_jid: 'slack:CMAIN',
      prompt: 'persist',
      schedule_type: 'event',
      schedule_value: '',
      context_mode: 'isolated',
      batchSize: 3,
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const { getTaskById } = await import('./db.js');
    const task = getTaskById('persist-batch');
    expect(task?.batchSize).toBe(3);
  });
});
