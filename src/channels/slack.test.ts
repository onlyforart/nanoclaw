import { afterEach, describe, it, expect, vi } from 'vitest';

import type { ChannelSetup } from './adapter.js';
import { getRegisteredChannelNames } from './channel-registry.js';
import { createSlackAdapter, createSlackAdapterWithShim } from './slack.js';
import type {
  ActionHandler,
  BoltShim,
  HandledMessageEvent,
  MessageHandler,
  ReactionAddedEvent,
  ReactionHandler,
} from './slack-bolt-shim.js';

vi.mock('../log.js', () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

function makeMockShim(overrides: Partial<BoltShim> = {}): BoltShim {
  return {
    start: vi.fn<BoltShim['start']>(async () => {}),
    stop: vi.fn<BoltShim['stop']>(async () => {}),
    getBotUserId: vi.fn<BoltShim['getBotUserId']>(async () => 'U_BOT_123'),
    postMessage: vi.fn<BoltShim['postMessage']>(async () => ({
      ts: '1234.5678',
    })),
    editMessage: vi.fn<BoltShim['editMessage']>(async () => {}),
    addReaction: vi.fn<BoltShim['addReaction']>(async () => {}),
    onMessageEvent: vi.fn<BoltShim['onMessageEvent']>(),
    onReactionEvent: vi.fn<BoltShim['onReactionEvent']>(),
    onAction: vi.fn<BoltShim['onAction']>(),
    fetchHistoryMessage: vi.fn<BoltShim['fetchHistoryMessage']>(async () => null),
    fetchThreadReplies: vi.fn<BoltShim['fetchThreadReplies']>(async () => []),
    fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>(async () => []),
    listConversations: vi.fn<BoltShim['listConversations']>(async () => ({
      channels: [],
    })),
    ...overrides,
  };
}

const noopSetup = {} as ChannelSetup;

function makeChannelSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

function makeMessageEvent(overrides: Record<string, unknown> = {}): HandledMessageEvent {
  return {
    type: 'message',
    channel: 'C_DEFAULT',
    channel_type: 'channel',
    ts: '1701000000.000000',
    event_ts: '1701000000.000000',
    team: 'T_TEAM',
    user: 'U_USER',
    text: 'Hello',
    ...overrides,
  } as unknown as HandledMessageEvent;
}

async function setupAdapterWithMessageHandler(shim: BoltShim, config: ChannelSetup): Promise<MessageHandler> {
  const adapter = createSlackAdapterWithShim(shim);
  await adapter.setup(config);
  const calls = (shim.onMessageEvent as ReturnType<typeof vi.fn>).mock.calls;
  return calls[0][0] as MessageHandler;
}

describe('createSlackAdapterWithShim', () => {
  it('exposes channel adapter metadata', () => {
    const adapter = createSlackAdapterWithShim(makeMockShim());
    expect(adapter.name).toBe('slack');
    expect(adapter.channelType).toBe('slack');
    expect(adapter.supportsThreads).toBe(true);
  });

  it('starts disconnected', () => {
    const adapter = createSlackAdapterWithShim(makeMockShim());
    expect(adapter.isConnected()).toBe(false);
  });

  it('setup() starts the shim, fetches botUserId, and marks connected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    await adapter.setup(noopSetup);

    expect(shim.start).toHaveBeenCalledOnce();
    expect(shim.getBotUserId).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(true);
  });

  it('setup() tolerates getBotUserId rejection', async () => {
    const shim = makeMockShim({
      getBotUserId: vi.fn<BoltShim['getBotUserId']>().mockRejectedValue(new Error('auth.test failed')),
    });
    const adapter = createSlackAdapterWithShim(shim);

    await expect(adapter.setup(noopSetup)).resolves.toBeUndefined();
    expect(adapter.isConnected()).toBe(true);
  });

  it('teardown() stops the shim and marks disconnected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    await adapter.setup(noopSetup);
    expect(adapter.isConnected()).toBe(true);

    await adapter.teardown();

    expect(shim.stop).toHaveBeenCalledOnce();
    expect(adapter.isConnected()).toBe(false);
  });
});

describe('createSlackAdapterWithShim — deliver', () => {
  it('returns undefined and queues when not connected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    const result = await adapter.deliver('C123', null, {
      kind: 'chat',
      content: 'Hello world',
    });

    expect(result).toBeUndefined();
    expect(shim.postMessage).not.toHaveBeenCalled();
  });

  it('posts and returns ts when connected (string content)', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    const result = await adapter.deliver('C123', null, {
      kind: 'chat',
      content: 'Hello world',
    });

    expect(result).toBe('1234.5678');
    expect(shim.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }));
  });

  it('extracts text from {markdown} content', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    await adapter.deliver('C123', null, {
      kind: 'chat',
      content: { markdown: '**Bold** msg' },
    });

    expect(shim.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123' }));
  });

  it('extracts text from {text} content', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    await adapter.deliver('C123', null, {
      kind: 'chat',
      content: { text: 'plain' },
    });

    expect(shim.postMessage).toHaveBeenCalledOnce();
  });

  it('passes thread_ts when threadId provided', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    await adapter.deliver('C123', 'T999', {
      kind: 'chat',
      content: 'Hello',
    });

    expect(shim.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C123', threadTs: 'T999' }));
  });

  it('queues and returns undefined on postMessage failure', async () => {
    const shim = makeMockShim({
      postMessage: vi.fn<BoltShim['postMessage']>().mockRejectedValue(new Error('rate limited')),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    const result = await adapter.deliver('C123', null, {
      kind: 'chat',
      content: 'Hello',
    });

    expect(result).toBeUndefined();
  });

  it('skips when content has no text/markdown and no recognised operation', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(noopSetup);

    const result = await adapter.deliver('C123', null, {
      kind: 'chat',
      content: { someOtherField: 'no recognised text' },
    });

    expect(result).toBeUndefined();
    expect(shim.postMessage).not.toHaveBeenCalled();
  });

  it('flushes queued messages on setup', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    await adapter.deliver('C1', null, { kind: 'chat', content: 'first' });
    await adapter.deliver('C2', 'T2', { kind: 'chat', content: 'second' });

    expect(shim.postMessage).not.toHaveBeenCalled();

    await adapter.setup(noopSetup);

    expect(shim.postMessage).toHaveBeenCalledTimes(2);
    expect(shim.postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ channel: 'C1' }));
    expect(shim.postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ channel: 'C2', threadTs: 'T2' }));
  });
});

describe('createSlackAdapterWithShim — onInbound (message events)', () => {
  it('forwards a regular message to onInbound and onMetadata', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(makeMessageEvent({ channel: 'C123', user: 'U1', text: 'hi' }));

    expect(setup.onMetadata).toHaveBeenCalledWith('C123', undefined, true);
    expect(setup.onInbound).toHaveBeenCalledWith(
      'C123',
      null,
      expect.objectContaining({
        id: '1701000000.000000',
        kind: 'chat',
        content: 'hi',
        isMention: false,
        isGroup: true,
      }),
    );
  });

  it('marks isMention=true when bot user id appears in text', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(makeMessageEvent({ text: 'hey <@U_BOT_123> can you help?' }));

    expect(setup.onInbound).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.objectContaining({ isMention: true }),
    );
  });

  it('marks isGroup=false for direct messages (channel_type=im)', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(makeMessageEvent({ channel_type: 'im' }));

    expect(setup.onInbound).toHaveBeenCalledWith(expect.any(String), null, expect.objectContaining({ isGroup: false }));
    expect(setup.onMetadata).toHaveBeenCalledWith(expect.any(String), undefined, false);
  });

  it('skips bot messages from onInbound but still reports onMetadata', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(
      makeMessageEvent({
        channel: 'C_BOT',
        channel_type: 'channel',
        user: undefined,
        bot_id: 'B1',
      }),
    );

    expect(setup.onInbound).not.toHaveBeenCalled();
    expect(setup.onMetadata).toHaveBeenCalledWith('C_BOT', undefined, true);
  });

  it('skips messages from the bot itself but still reports onMetadata', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(
      makeMessageEvent({
        channel: 'C_SELF',
        channel_type: 'im',
        user: 'U_BOT_123',
      }),
    );

    expect(setup.onInbound).not.toHaveBeenCalled();
    expect(setup.onMetadata).toHaveBeenCalledWith('C_SELF', undefined, false);
  });

  it('skips messages with no text (skips both onInbound and onMetadata per v1:79 early return)', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup();
    const handler = await setupAdapterWithMessageHandler(shim, setup);

    handler(makeMessageEvent({ text: undefined }));

    expect(setup.onInbound).not.toHaveBeenCalled();
    expect(setup.onMetadata).not.toHaveBeenCalled();
  });

  it('registers the message handler before starting the shim', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    let onMessageRegistered = false;
    let started = false;
    (shim.onMessageEvent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      onMessageRegistered = true;
      if (started) {
        throw new Error('handler registered after shim.start()');
      }
    });
    (shim.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      started = true;
      if (!onMessageRegistered) {
        throw new Error('shim.start() ran before handler was registered');
      }
    });

    await expect(adapter.setup(makeChannelSetup())).resolves.toBeUndefined();
  });
});

describe('createSlackAdapterWithShim — v2-extension delivery (commit 3a)', () => {
  describe('ask_question', () => {
    it('renders Block Kit card (header + question + action buttons)', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 'Pick one',
          question: 'Which option?',
          options: [
            { value: 'a', label: 'Option A' },
            { value: 'b', label: 'Option B' },
          ],
        },
      });

      expect(shim.postMessage).toHaveBeenCalledTimes(1);
      const callArgs = (shim.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.channel).toBe('C1');

      // Spec: header + section + actions blocks, in that order
      const blocks = callArgs.blocks as Array<{
        type: string;
        text?: { text?: string };
        elements?: Array<{ action_id?: string; text?: { text?: string }; value?: string }>;
      }>;
      expect(blocks[0].type).toBe('header');
      expect(blocks[0].text?.text).toBe('Pick one');
      expect(blocks[1].type).toBe('section');
      expect(blocks[1].text?.text).toBe('Which option?');
      expect(blocks[2].type).toBe('actions');

      const buttons = blocks[2].elements!;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].action_id).toBe('ncq:q1:0');
      expect(buttons[0].text?.text).toBe('Option A');
      expect(buttons[0].value).toBe('0');
      expect(buttons[1].action_id).toBe('ncq:q1:1');
      expect(buttons[1].text?.text).toBe('Option B');
      expect(buttons[1].value).toBe('1');
    });

    it('passes thread_ts when threadId provided', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      await adapter.deliver('C1', 'T_PARENT', {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 't',
          question: 'q',
          options: [{ value: 'a', label: 'A' }],
        },
      });

      expect(shim.postMessage).toHaveBeenCalledWith(expect.objectContaining({ threadTs: 'T_PARENT' }));
    });

    it('returns the platform message ts', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 't',
          question: 'q',
          options: [{ value: 'a', label: 'A' }],
        },
      });

      expect(result).toBe('1234.5678');
    });

    it('button click resolves idx → option value and calls config.onAction', async () => {
      const shim = makeMockShim();
      const setup = makeChannelSetup();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(setup);

      await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 't',
          question: 'q',
          options: [
            { value: 'yes', label: 'Yes' },
            { value: 'no', label: 'No' },
          ],
        },
      });

      // Pull the registered action handler and fire a click on the second button
      const actionCalls = (shim.onAction as ReturnType<typeof vi.fn>).mock.calls;
      expect(actionCalls.length).toBe(1);
      const fireAction = actionCalls[0][0] as ActionHandler;

      await fireAction({ actionId: 'ncq:q1:1', value: '1', userId: 'U_USER' });

      expect(setup.onAction).toHaveBeenCalledWith('q1', 'no', 'U_USER');
    });

    it('button click for unknown questionId is ignored (logged, no onAction)', async () => {
      const shim = makeMockShim();
      const setup = makeChannelSetup();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(setup);
      // Note: no ask_question delivered — questionId 'unknown' is not in the map
      void adapter;

      const fireAction = (shim.onAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as ActionHandler;

      await fireAction({
        actionId: 'ncq:unknown:0',
        value: '0',
        userId: 'U_USER',
      });

      expect(setup.onAction).not.toHaveBeenCalled();
    });

    it('button click with malformed action_id is ignored', async () => {
      const shim = makeMockShim();
      const setup = makeChannelSetup();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(setup);
      void adapter;

      const fireAction = (shim.onAction as ReturnType<typeof vi.fn>).mock.calls[0][0] as ActionHandler;

      await fireAction({
        actionId: 'malformed_id',
        value: '0',
        userId: 'U_USER',
      });

      expect(setup.onAction).not.toHaveBeenCalled();
    });

    it('skips when ask_question content is missing required fields', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: { type: 'ask_question', questionId: 'q1' },
      });

      expect(result).toBeUndefined();
      expect(shim.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('edit operation', () => {
    it('calls shim.editMessage with rendered blocks', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: '1700000000.000100',
          markdown: '**Updated** content',
        },
      });

      expect(shim.editMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C1',
          ts: '1700000000.000100',
        }),
      );
      expect(shim.postMessage).not.toHaveBeenCalled();
    });

    it('skips edit with missing messageId', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: { operation: 'edit', markdown: 'no id' },
      });

      expect(result).toBeUndefined();
      expect(shim.editMessage).not.toHaveBeenCalled();
    });

    it('skips edit with no text/markdown', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: '1700000000.000100',
        },
      });

      expect(result).toBeUndefined();
      expect(shim.editMessage).not.toHaveBeenCalled();
    });
  });

  describe('reaction operation', () => {
    it('calls shim.addReaction with channel/timestamp/emoji', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'reaction',
          messageId: '1700000000.000100',
          emoji: 'thumbsup',
        },
      });

      expect(shim.addReaction).toHaveBeenCalledWith({
        channel: 'C1',
        timestamp: '1700000000.000100',
        emoji: 'thumbsup',
      });
      expect(shim.postMessage).not.toHaveBeenCalled();
    });

    it('skips reaction with missing messageId', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: { operation: 'reaction', emoji: 'thumbsup' },
      });

      expect(result).toBeUndefined();
      expect(shim.addReaction).not.toHaveBeenCalled();
    });

    it('skips reaction with missing emoji', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      await adapter.setup(makeChannelSetup());

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'reaction',
          messageId: '1700000000.000100',
        },
      });

      expect(result).toBeUndefined();
      expect(shim.addReaction).not.toHaveBeenCalled();
    });
  });

  it('action handler is registered during setup', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    expect(shim.onAction).not.toHaveBeenCalled();
    await adapter.setup(makeChannelSetup());
    expect(shim.onAction).toHaveBeenCalledTimes(1);
  });

  describe('not-connected gating', () => {
    it('drops ask_question when not connected', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);
      // Note: setup() not called — adapter is disconnected

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 't',
          question: 'q',
          options: [{ value: 'a', label: 'A' }],
        },
      });

      expect(result).toBeUndefined();
      expect(shim.postMessage).not.toHaveBeenCalled();
    });

    it('drops edit when not connected', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: '1.0',
          markdown: 'edited',
        },
      });

      expect(result).toBeUndefined();
      expect(shim.editMessage).not.toHaveBeenCalled();
    });

    it('drops reaction when not connected', async () => {
      const shim = makeMockShim();
      const adapter = createSlackAdapterWithShim(shim);

      const result = await adapter.deliver('C1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'reaction',
          messageId: '1.0',
          emoji: 'thumbsup',
        },
      });

      expect(result).toBeUndefined();
      expect(shim.addReaction).not.toHaveBeenCalled();
    });
  });
});

describe('createSlackAdapterWithShim — onReaction (D1)', () => {
  function makeReactionEvent(overrides: Partial<ReactionAddedEvent> = {}): ReactionAddedEvent {
    return {
      item: { type: 'message', channel: 'C_DEFAULT', ts: '1700000000.000100' },
      reaction: 'thumbsup',
      user: 'U_USER',
      event_ts: '1700000050.000200',
      ...overrides,
    };
  }

  async function setupAdapterWithReactionHandler(shim: BoltShim, config: ChannelSetup): Promise<ReactionHandler> {
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(config);
    const calls = (shim.onReactionEvent as ReturnType<typeof vi.fn>).mock.calls;
    return calls[0][0] as ReactionHandler;
  }

  it('forwards a message reaction with all Reaction fields populated', async () => {
    const shim = makeMockShim();
    const onReaction = vi.fn();
    const setup = makeChannelSetup({ onReaction });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await handler(
      makeReactionEvent({
        item: { type: 'message', channel: 'C_X', ts: '1700000001.000100' },
        reaction: 'eyes',
        user: 'U_REACTOR',
        event_ts: '1700000002.000200',
      }),
    );

    expect(onReaction).toHaveBeenCalledWith({
      channelType: 'slack',
      platformId: 'C_X',
      threadId: null,
      messageId: '1700000001.000100',
      emoji: 'eyes',
      userId: 'U_REACTOR',
      timestamp: new Date(1700000002 * 1000 + 0).toISOString(),
    });
  });

  it('strips ::skin-tone-N modifier from emoji name (f50dd58 carry-across)', async () => {
    const shim = makeMockShim();
    const onReaction = vi.fn();
    const setup = makeChannelSetup({ onReaction });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await handler(makeReactionEvent({ reaction: '+1::skin-tone-3' }));

    expect(onReaction).toHaveBeenCalledWith(expect.objectContaining({ emoji: '+1' }));
  });

  it('skips reactions on file items (item.type !== "message")', async () => {
    const shim = makeMockShim();
    const onReaction = vi.fn();
    const setup = makeChannelSetup({ onReaction });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await handler(makeReactionEvent({ item: { type: 'file' } }));

    expect(onReaction).not.toHaveBeenCalled();
  });

  it('skips reactions on file_comment items', async () => {
    const shim = makeMockShim();
    const onReaction = vi.fn();
    const setup = makeChannelSetup({ onReaction });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await handler(makeReactionEvent({ item: { type: 'file_comment' } }));

    expect(onReaction).not.toHaveBeenCalled();
  });

  it('does nothing when config has no onReaction (optional field)', async () => {
    const shim = makeMockShim();
    const setup = makeChannelSetup({ onReaction: undefined });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await expect(handler(makeReactionEvent())).resolves.toBeUndefined();
  });

  it('catches errors thrown by onReaction (does not propagate)', async () => {
    const shim = makeMockShim();
    const onReaction = vi.fn().mockRejectedValue(new Error('handler boom'));
    const setup = makeChannelSetup({ onReaction });
    const handler = await setupAdapterWithReactionHandler(shim, setup);

    await expect(handler(makeReactionEvent())).resolves.toBeUndefined();
    expect(onReaction).toHaveBeenCalledOnce();
  });

  it('reaction handler is registered during setup', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    expect(shim.onReactionEvent).not.toHaveBeenCalled();
    await adapter.setup(makeChannelSetup());
    expect(shim.onReactionEvent).toHaveBeenCalledTimes(1);
  });
});

describe('createSlackAdapterWithShim — fetchMessageText (D2)', () => {
  it('returns the message text when found', async () => {
    const shim = makeMockShim({
      fetchHistoryMessage: vi
        .fn<BoltShim['fetchHistoryMessage']>()
        .mockResolvedValue({ ts: '1700000000.000100', text: 'hello there' }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchMessageText!('C_X', '1700000000.000100');

    expect(result).toBe('hello there');
    expect(shim.fetchHistoryMessage).toHaveBeenCalledWith({
      channel: 'C_X',
      ts: '1700000000.000100',
    });
  });

  it('returns null when not connected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    const result = await adapter.fetchMessageText!('C_X', '1700000000.000100');

    expect(result).toBeNull();
    expect(shim.fetchHistoryMessage).not.toHaveBeenCalled();
  });

  it('returns null when shim returns no message', async () => {
    const shim = makeMockShim({
      fetchHistoryMessage: vi.fn<BoltShim['fetchHistoryMessage']>().mockResolvedValue(null),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchMessageText!('C_X', '1.0');
    expect(result).toBeNull();
  });

  it('returns null when shim returns a different ts', async () => {
    const shim = makeMockShim({
      fetchHistoryMessage: vi
        .fn<BoltShim['fetchHistoryMessage']>()
        .mockResolvedValue({ ts: 'OTHER_TS', text: 'wrong message' }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchMessageText!('C_X', '1.0');
    expect(result).toBeNull();
  });

  it('returns null when message has no text field', async () => {
    const shim = makeMockShim({
      fetchHistoryMessage: vi.fn<BoltShim['fetchHistoryMessage']>().mockResolvedValue({ ts: '1.0' }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchMessageText!('C_X', '1.0');
    expect(result).toBeNull();
  });

  it('returns null when shim throws (error logged, not propagated)', async () => {
    const shim = makeMockShim({
      fetchHistoryMessage: vi.fn<BoltShim['fetchHistoryMessage']>().mockRejectedValue(new Error('not_in_channel')),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchMessageText!('C_X', '1.0');
    expect(result).toBeNull();
  });
});

describe('createSlackAdapterWithShim — fetchThreadReplies (D2, Q4)', () => {
  it('returns the thread replies mapped to {id, text} shape', async () => {
    const shim = makeMockShim({
      fetchThreadReplies: vi.fn<BoltShim['fetchThreadReplies']>().mockResolvedValue([
        { ts: '1700000000.000100', text: 'parent' },
        { ts: '1700000010.000200', text: 'first reply' },
        { ts: '1700000020.000300', text: undefined },
      ]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchThreadReplies!('C_X', '1700000000.000100');

    expect(result).toEqual([
      { id: '1700000000.000100', text: 'parent' },
      { id: '1700000010.000200', text: 'first reply' },
      { id: '1700000020.000300', text: null },
    ]);
    expect(shim.fetchThreadReplies).toHaveBeenCalledWith({
      channel: 'C_X',
      threadTs: '1700000000.000100',
    });
  });

  it('returns empty array when thread has no replies', async () => {
    const shim = makeMockShim({
      fetchThreadReplies: vi.fn<BoltShim['fetchThreadReplies']>().mockResolvedValue([]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchThreadReplies!('C_X', '1.0');
    expect(result).toEqual([]);
  });

  it('returns null when not connected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    const result = await adapter.fetchThreadReplies!('C_X', '1.0');

    expect(result).toBeNull();
    expect(shim.fetchThreadReplies).not.toHaveBeenCalled();
  });

  it('returns null when shim throws', async () => {
    const shim = makeMockShim({
      fetchThreadReplies: vi.fn<BoltShim['fetchThreadReplies']>().mockRejectedValue(new Error('thread_not_found')),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.fetchThreadReplies!('C_X', '1.0');
    expect(result).toBeNull();
  });
});

describe('createSlackAdapterWithShim — backfillFromCursor (D3)', () => {
  it('converts ISO oldestTimestamp to Slack ts and calls shim', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    // 2024-01-01T00:00:00.000Z = 1704067200 unix epoch seconds
    expect(shim.fetchChannelHistory).toHaveBeenCalledWith({
      channel: 'C_X',
      oldestTs: '1704067200',
      limit: 100,
      inclusive: false,
    });
  });

  it('maps history messages to InboundMessage[]', async () => {
    const shim = makeMockShim({
      fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>().mockResolvedValue([
        { ts: '1704067201.500', text: 'hi', user: 'U1' },
        {
          ts: '1704067205.250',
          text: 'mentioning <@U_BOT_123>',
          user: 'U2',
        },
      ]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    expect(result).toEqual([
      {
        id: '1704067201.500',
        kind: 'chat',
        content: 'hi',
        timestamp: new Date(parseFloat('1704067201.500') * 1000).toISOString(),
        isMention: false,
      },
      {
        id: '1704067205.250',
        kind: 'chat',
        content: 'mentioning <@U_BOT_123>',
        timestamp: new Date(parseFloat('1704067205.250') * 1000).toISOString(),
        isMention: true,
      },
    ]);
  });

  it('filters out bot messages (bot_id present)', async () => {
    const shim = makeMockShim({
      fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>().mockResolvedValue([
        { ts: '1.0', text: 'human', user: 'U1' },
        { ts: '2.0', text: 'bot', bot_id: 'B1' },
      ]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('human');
  });

  it('filters out the bot self (user matches botUserId)', async () => {
    const shim = makeMockShim({
      fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>().mockResolvedValue([
        { ts: '1.0', text: 'human', user: 'U1' },
        { ts: '2.0', text: 'self post', user: 'U_BOT_123' },
      ]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('human');
  });

  it('filters out messages with no text', async () => {
    const shim = makeMockShim({
      fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>().mockResolvedValue([
        { ts: '1.0', text: 'first', user: 'U1' },
        { ts: '2.0', text: undefined, user: 'U2' },
      ]),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('first');
  });

  it('returns empty array when shim returns no messages', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');
    expect(result).toEqual([]);
  });

  it('returns null when not connected', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');

    expect(result).toBeNull();
    expect(shim.fetchChannelHistory).not.toHaveBeenCalled();
  });

  it('returns null when shim throws', async () => {
    const shim = makeMockShim({
      fetchChannelHistory: vi.fn<BoltShim['fetchChannelHistory']>().mockRejectedValue(new Error('not_in_channel')),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.backfillFromCursor!('C_X', '2024-01-01T00:00:00.000Z');
    expect(result).toBeNull();
  });
});

describe('createSlackAdapterWithShim — syncConversations', () => {
  it('returns ConversationInfo[] for member channels', async () => {
    const shim = makeMockShim({
      listConversations: vi.fn<BoltShim['listConversations']>().mockResolvedValue({
        channels: [
          { id: 'C1', name: 'general', is_member: true },
          { id: 'C2', name: 'random', is_member: true },
        ],
      }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.syncConversations!();

    expect(result).toEqual([
      { platformId: 'C1', name: 'general', isGroup: true },
      { platformId: 'C2', name: 'random', isGroup: true },
    ]);
  });

  it('paginates through cursor', async () => {
    const shim = makeMockShim();
    let callCount = 0;
    (shim.listConversations as ReturnType<typeof vi.fn>).mockImplementation(async (opts) => {
      callCount++;
      if (callCount === 1) {
        return {
          channels: [{ id: 'C1', name: 'first', is_member: true }],
          nextCursor: 'CURSOR_2',
        };
      }
      if (callCount === 2 && opts.cursor === 'CURSOR_2') {
        return {
          channels: [{ id: 'C2', name: 'second', is_member: true }],
        };
      }
      throw new Error('unexpected call');
    });

    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.syncConversations!();

    expect(callCount).toBe(2);
    expect(result).toHaveLength(2);
    expect(result[0].platformId).toBe('C1');
    expect(result[1].platformId).toBe('C2');
  });

  it('skips channels where bot is not a member', async () => {
    const shim = makeMockShim({
      listConversations: vi.fn<BoltShim['listConversations']>().mockResolvedValue({
        channels: [
          { id: 'C1', name: 'general', is_member: true },
          { id: 'C2', name: 'private-other', is_member: false },
        ],
      }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.syncConversations!();
    expect(result).toEqual([{ platformId: 'C1', name: 'general', isGroup: true }]);
  });

  it('skips channels missing id or name', async () => {
    const shim = makeMockShim({
      listConversations: vi.fn<BoltShim['listConversations']>().mockResolvedValue({
        channels: [
          { id: 'C1', name: 'good', is_member: true },
          { id: undefined, name: 'no-id', is_member: true },
          { id: 'C3', name: undefined, is_member: true },
        ],
      }),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.syncConversations!();
    expect(result).toEqual([{ platformId: 'C1', name: 'good', isGroup: true }]);
  });

  it('returns empty array on shim error', async () => {
    const shim = makeMockShim({
      listConversations: vi.fn<BoltShim['listConversations']>().mockRejectedValue(new Error('rate_limited')),
    });
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    const result = await adapter.syncConversations!();
    expect(result).toEqual([]);
  });
});

describe('createSlackAdapterWithShim — setTyping', () => {
  it('is a no-op (Slack has no typing-indicator API)', async () => {
    const shim = makeMockShim();
    const adapter = createSlackAdapterWithShim(shim);
    await adapter.setup(makeChannelSetup());

    await expect(adapter.setTyping!('C1', null)).resolves.toBeUndefined();
  });
});

describe('createSlackAdapter (factory + registry)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null when SLACK_BOT_TOKEN is missing', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', '');
    vi.stubEnv('SLACK_APP_TOKEN', 'xapp-something');

    expect(createSlackAdapter()).toBeNull();
  });

  it('returns null when SLACK_APP_TOKEN is missing', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-something');
    vi.stubEnv('SLACK_APP_TOKEN', '');

    expect(createSlackAdapter()).toBeNull();
  });

  it('returns a ChannelAdapter when both tokens are present', () => {
    vi.stubEnv('SLACK_BOT_TOKEN', 'xoxb-something');
    vi.stubEnv('SLACK_APP_TOKEN', 'xapp-something');

    const adapter = createSlackAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter!.channelType).toBe('slack');
    expect(adapter!.supportsThreads).toBe(true);
  });

  it('module import registers "slack" with the channel registry', () => {
    expect(getRegisteredChannelNames()).toContain('slack');
  });
});
