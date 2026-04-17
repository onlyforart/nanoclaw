import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  _initTestDatabase,
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

const SOURCE_GROUP: RegisteredGroup = {
  name: 'support-channel',
  folder: 'slack_support-channel',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: IpcDeps['sendMessage'] & ReturnType<typeof vi.fn>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'slack:CMAIN': MAIN_GROUP,
    'slack:CSUPPORT': SOURCE_GROUP,
  };

  setRegisteredGroup('slack:CMAIN', MAIN_GROUP);
  setRegisteredGroup('slack:CSUPPORT', SOURCE_GROUP);

  sendMessage = vi.fn(async () => {}) as IpcDeps['sendMessage'] &
    ReturnType<typeof vi.fn>;

  deps = {
    sendMessage,
    registeredGroups: () => groups,
    registerGroup: () => {},
    updateGroup: () => {},
    syncGroups: async () => {},
    refreshAllGroupSnapshots: () => {},
    refreshAllTaskSnapshots: () => {},
  };
});

/**
 * Helper: publish a candidate.* event directly to the DB so we have an
 * event_id to look up. Returns the event id.
 */
function seedEvent(payload: Record<string, unknown>): number {
  const result = publishEvent(
    'candidate.question',
    'slack_monitoring',
    'pipeline:monitor',
    JSON.stringify(payload),
    null,
    null,
  );
  return result.id;
}

describe('reply_to_event IPC — F3 deterministic thread routing', () => {
  it('F3.1 — happy path: looks up event, posts to source thread', async () => {
    const eventId = seedEvent({
      source_channel: 'slack:CSUPPORT',
      source_message_id: '1730000000.000100',
      cluster_summary: 'user asked about widget',
    });

    const result = await processTaskIpc(
      {
        type: 'reply_to_event',
        eventId,
        text: 'Looking into this — will get back to you shortly.',
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).delivered_to).toEqual({
      channel: 'slack:CSUPPORT',
      thread_ts: '1730000000.000100',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Looking into this — will get back to you shortly.',
      { threadTs: '1730000000.000100' },
    );
  });

  it('F3.2 — event not found: returns error, does not send', async () => {
    const result = await processTaskIpc(
      {
        type: 'reply_to_event',
        eventId: 999999,
        text: 'orphan reply',
      },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('F3.3 — payload missing source_channel: returns error, does not send', async () => {
    const eventId = seedEvent({
      // no source_channel
      source_message_id: '1730000000.000200',
      cluster_summary: 'malformed payload',
    });

    const result = await processTaskIpc(
      { type: 'reply_to_event', eventId, text: 'test' },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source_channel/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('F3.4 — payload missing source_message_id: posts without thread_ts, flags no-thread', async () => {
    const eventId = seedEvent({
      source_channel: 'slack:CSUPPORT',
      // no source_message_id — still a valid channel-level reply
      cluster_summary: 'no message id',
    });

    const result = await processTaskIpc(
      { type: 'reply_to_event', eventId, text: 'channel-level reply' },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(true);
    expect((result as any).delivered_to).toEqual({
      channel: 'slack:CSUPPORT',
      thread_ts: null,
    });
    expect((result as any).flags).toContain('no-thread');
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'channel-level reply',
      undefined,
    );
  });

  it('F3.5 — text > 2000 chars: returns error, does not send', async () => {
    const eventId = seedEvent({
      source_channel: 'slack:CSUPPORT',
      source_message_id: '1730000000.000300',
    });

    const longText = 'x'.repeat(2001);

    const result = await processTaskIpc(
      { type: 'reply_to_event', eventId, text: longText },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too long/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('F3.6 — source channel not registered: returns error, does not send', async () => {
    const eventId = seedEvent({
      source_channel: 'slack:CUNKNOWN',
      source_message_id: '1730000000.000400',
    });

    const result = await processTaskIpc(
      { type: 'reply_to_event', eventId, text: 'unknown target' },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not registered|no adapter/i);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('rejects missing event_id', async () => {
    const result = await processTaskIpc(
      { type: 'reply_to_event', text: 'no id' },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/event_?id/i);
  });

  it('rejects missing text', async () => {
    const eventId = seedEvent({
      source_channel: 'slack:CSUPPORT',
      source_message_id: '1730000000.000500',
    });

    const result = await processTaskIpc(
      { type: 'reply_to_event', eventId },
      'slack_main',
      true,
      deps,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/text/i);
  });
});
