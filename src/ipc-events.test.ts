import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  consumeEvents,
  getRecentEvents,
  publishEvent,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
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

  // Enrichment tests moved to pipeline plugin (enrichment.test.ts)
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

  it('tolerates sloppy LLM event-type noise (pipe delimiters)', async () => {
    // Real regression seen from gemma4 monitor: "|observation.*|" instead
    // of "observation.*". Without normalisation this matches zero rows
    // and silently starves the consumer task.
    publishEvent('observation.passive', 'g', null, '{"obs":1}');
    publishEvent('observation.passive', 'g', null, '{"obs":2}');

    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['|observation.*|'],
        claimedBy: 'pipeline:monitor',
        limit: 10,
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(true);
    expect((result as any).events).toHaveLength(2);
  });

  it('also tolerates regex-slash and quote delimiters', async () => {
    publishEvent('candidate.question', 'g', null, '{"q":1}');
    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: [' "/candidate.question/" '],
        claimedBy: 'pipeline:solver',
        limit: 5,
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(true);
    expect((result as any).events).toHaveLength(1);
  });

  it('rejects when every event type normalises to empty', async () => {
    const result = await processTaskIpc(
      {
        type: 'consume_events',
        eventTypes: ['|||', '   '],
        claimedBy: 'c',
        limit: 5,
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });

  // Nonce wrapping tests moved to pipeline plugin (nonce-transform.test.ts)
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

// submit_to_pipeline and reextract_observation tests moved to pipeline plugin

// --- read_chat_messages IPC ---

describe('read_chat_messages IPC', () => {
  beforeEach(() => {
    // Set up a target group with messages
    setRegisteredGroup('slack:CTARGET', {
      name: 'Target',
      folder: 'slack_target',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      mode: 'passive',
    });
    groups['slack:CTARGET'] = {
      name: 'Target',
      folder: 'slack_target',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      mode: 'passive',
    };

    storeChatMetadata('slack:CTARGET', '2024-01-01T00:00:00.000Z');
    storeMessage({
      id: 'msg-1',
      chat_jid: 'slack:CTARGET',
      sender: 'user1',
      sender_name: 'Alice',
      content: 'INC12345 is down',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    storeMessage({
      id: 'msg-2',
      chat_jid: 'slack:CTARGET',
      sender: 'user2',
      sender_name: 'Bob',
      content: 'looking into it',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
  });

  it('returns messages from the target group', async () => {
    const result = await processTaskIpc(
      {
        type: 'read_chat_messages',
        targetGroup: 'slack:CTARGET',
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).messages).toHaveLength(2);
    expect((result as any).cursor).toBe('2024-01-01T00:00:02.000Z');
  });

  it('filters by since timestamp', async () => {
    const result = await processTaskIpc(
      {
        type: 'read_chat_messages',
        targetGroup: 'slack:CTARGET',
        since: '2024-01-01T00:00:01.000Z',
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).messages).toHaveLength(1);
    expect((result as any).messages[0].content).toBe('looking into it');
  });

  it('rejects missing targetGroup', async () => {
    const result = await processTaskIpc(
      { type: 'read_chat_messages' },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });

  it('rejects unregistered target group', async () => {
    const result = await processTaskIpc(
      {
        type: 'read_chat_messages',
        targetGroup: 'slack:CUNKNOWN',
      },
      'slack_main',
      true,
      deps,
    );
    expect(result.success).toBe(false);
  });
});

// reextract_observation tests moved to pipeline plugin (ipc-handlers.test.ts)
