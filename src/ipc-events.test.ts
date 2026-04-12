import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  consumeEvents,
  getRecentEvents,
  getRecentIntakeLogs,
  publishEvent,
  setRegisteredGroup,
} from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'slack:CMAIN': MAIN_GROUP,
  };

  setRegisteredGroup('slack:CMAIN', MAIN_GROUP);

  deps = {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    updateGroup: () => {},
    syncGroups: async () => {},
    refreshAllGroupSnapshots: () => {},
    refreshAllTaskSnapshots: () => {},
  };
});

// --- publish_event IPC ---

describe('publish_event IPC', () => {
  it('publishes an event and returns the event id', async () => {
    const result = await processTaskIpc(
      {
        type: 'publish_event',
        eventType: 'observation.support',
        payload: JSON.stringify({ summary: 'test' }),
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).id).toBeGreaterThan(0);
    expect((result as any).isNew).toBe(true);
  });

  it('deduplicates with dedupe_key', async () => {
    const r1 = await processTaskIpc(
      {
        type: 'publish_event',
        eventType: 'obs.test',
        payload: '{}',
        dedupeKey: 'dup-1',
      },
      'slack_main',
      true,
      deps,
    );
    const r2 = await processTaskIpc(
      {
        type: 'publish_event',
        eventType: 'obs.test',
        payload: '{}',
        dedupeKey: 'dup-1',
      },
      'slack_main',
      true,
      deps,
    );

    expect((r1 as any).isNew).toBe(true);
    expect((r2 as any).isNew).toBe(false);
    expect((r1 as any).id).toBe((r2 as any).id);
  });

  it('rejects missing eventType', async () => {
    const result = await processTaskIpc(
      { type: 'publish_event', payload: '{}' },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });
});

// --- consume_events IPC ---

describe('consume_events IPC', () => {
  it('claims pending events and returns them', async () => {
    publishEvent('obs.a', 'g', null, '{"n":1}');
    publishEvent('obs.a', 'g', null, '{"n":2}');

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['obs.a'],
        claimedBy: 'pipeline:monitor',
        limit: 10,
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).events).toHaveLength(2);
    expect((result as any).events[0].status).toBe('claimed');
  });

  it('returns empty array when no events match', async () => {
    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['nonexistent'],
        claimedBy: 'c',
        limit: 10,
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).events).toHaveLength(0);
  });

  it('rejects missing eventTypes', async () => {
    const result = await processTaskIpc(
      { type: 'consume_events', claimedBy: 'c', limit: 10 },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });
});

// --- ack_event IPC ---

describe('ack_event IPC', () => {
  it('acknowledges a claimed event as done', async () => {
    publishEvent('ack.test', 'g', null, '{}');
    const [event] = consumeEvents(['ack.test'], 'c', 1);

    const result = await processTaskIpc(
      {
        type: 'ack_event',
        eventId: event.id,
        status: 'done',
        note: 'all good',
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    const events = getRecentEvents(['ack.test'], 10, true);
    expect(events[0].status).toBe('done');
    expect(events[0].result_note).toBe('all good');
  });

  it('rejects missing eventId', async () => {
    const result = await processTaskIpc(
      { type: 'ack_event', status: 'done' },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });
});

// --- submit_to_pipeline IPC ---

describe('submit_to_pipeline IPC', () => {
  it('publishes intake.raw event and logs to pipeline_intake_log', async () => {
    const result = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        rawText: 'some raw content to sanitise',
        sourceContext: {
          source_type: 'task',
          source_group: 'slack_main',
          source_task_id: 'pipeline:monitor',
          reason: 'found during investigation',
        },
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).eventId).toBeGreaterThan(0);

    // Verify event was published
    const events = getRecentEvents(['intake.raw'], 10, true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('intake.raw');

    // Verify intake log was created
    const logs = getRecentIntakeLogs(10, true);
    expect(logs).toHaveLength(1);
    expect(logs[0].source_group).toBe('slack_main');
    expect(logs[0].reason).toBe('found during investigation');
  });

  it('deduplicates via dedupe_key', async () => {
    const r1 = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        rawText: 'content',
        sourceContext: {
          source_type: 'task',
          source_group: 'g1',
          reason: 'test',
        },
        dedupeKey: 'dedup-intake-1',
      },
      'slack_main',
      true,
      deps,
    );
    const r2 = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        rawText: 'content',
        sourceContext: {
          source_type: 'task',
          source_group: 'g1',
          reason: 'test',
        },
        dedupeKey: 'dedup-intake-1',
      },
      'slack_main',
      true,
      deps,
    );

    expect((r1 as any).isNew).toBe(true);
    expect((r2 as any).isNew).toBe(false);
  });

  it('rejects missing rawText', async () => {
    const result = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        sourceContext: {
          source_type: 'task',
          source_group: 'g1',
          reason: 'test',
        },
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });

  it('rejects missing source_group in sourceContext', async () => {
    const result = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        rawText: 'content',
        sourceContext: {
          source_type: 'task',
          reason: 'test',
        },
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });

  it('rejects missing reason in sourceContext', async () => {
    const result = await processTaskIpc(
      {
        type: 'submit_to_pipeline',
        rawText: 'content',
        sourceContext: {
          source_type: 'task',
          source_group: 'g1',
        },
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });
});
