/**
 * Thin wrapper around @slack/bolt's App. Exists as the test seam
 * for the Slack adapter — adapter code depends on the BoltShim
 * interface, not on @slack/bolt directly, so unit tests can
 * substitute a fake shim without touching Socket Mode.
 */
import { App, LogLevel } from '@slack/bolt';
import type { BotMessageEvent, GenericMessageEvent, KnownBlock } from '@slack/types';

export interface PostMessageOpts {
  channel: string;
  threadTs?: string;
  blocks: KnownBlock[];
  text: string;
}

/**
 * Subset of Bolt's full `MessageEvent` (17+ subtypes) that the
 * adapter cares about. Bolt's `app.event('message')` delivers all
 * subtypes; the shim filters to GenericMessageEvent (regular user
 * messages, no subtype) and BotMessageEvent (bot's own posts).
 */
export type HandledMessageEvent = GenericMessageEvent | BotMessageEvent;

export type MessageHandler = (event: HandledMessageEvent) => Promise<void> | void;

export interface ReactionAddedEvent {
  item: {
    type: 'message' | 'file' | 'file_comment';
    channel?: string;
    ts?: string;
  };
  reaction: string;
  user: string;
  event_ts: string;
}

export type ReactionHandler = (event: ReactionAddedEvent) => Promise<void> | void;

export interface ActionPayload {
  actionId: string;
  value: string;
  userId: string;
}

export type ActionHandler = (payload: ActionPayload) => Promise<void> | void;

export interface BoltShim {
  start(): Promise<void>;
  stop(): Promise<void>;
  getBotUserId(): Promise<string | undefined>;
  postMessage(opts: PostMessageOpts): Promise<{ ts: string }>;
  editMessage(opts: { channel: string; ts: string; blocks: KnownBlock[]; text: string }): Promise<void>;
  addReaction(opts: { channel: string; timestamp: string; emoji: string }): Promise<void>;
  onMessageEvent(handler: MessageHandler): void;
  onReactionEvent(handler: ReactionHandler): void;
  onAction(handler: ActionHandler): void;
  fetchHistoryMessage(opts: { channel: string; ts: string }): Promise<{ ts: string; text?: string } | null>;
  fetchThreadReplies(opts: { channel: string; threadTs: string }): Promise<Array<{ ts: string; text?: string }>>;
  fetchChannelHistory(opts: {
    channel: string;
    oldestTs: string;
    limit?: number;
    inclusive?: boolean;
  }): Promise<Array<{ ts: string; text?: string; user?: string; bot_id?: string }>>;
  listConversations(opts: { cursor?: string; limit?: number }): Promise<{
    channels: Array<{ id?: string; name?: string; is_member?: boolean }>;
    nextCursor?: string;
  }>;
}

export interface BoltShimOpts {
  botToken: string;
  appToken: string;
}

export function createBoltShim(opts: BoltShimOpts): BoltShim {
  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
    logLevel: LogLevel.ERROR,
  });

  return {
    async start() {
      await app.start();
    },
    async stop() {
      await app.stop();
    },
    async getBotUserId() {
      const auth = await app.client.auth.test();
      return auth.user_id as string | undefined;
    },
    async postMessage(o) {
      const result = await app.client.chat.postMessage({
        channel: o.channel,
        blocks: o.blocks,
        text: o.text,
        ...(o.threadTs && { thread_ts: o.threadTs }),
      });
      return { ts: result.ts as string };
    },
    onMessageEvent(handler) {
      app.event('message', async ({ event }) => {
        const subtype = (event as { subtype?: string }).subtype;
        if (subtype && subtype !== 'bot_message') return;
        await handler(event as HandledMessageEvent);
      });
    },
    onReactionEvent(handler) {
      app.event('reaction_added', async ({ event }) => {
        await handler(event as unknown as ReactionAddedEvent);
      });
    },
    async editMessage(o) {
      await app.client.chat.update({
        channel: o.channel,
        ts: o.ts,
        blocks: o.blocks,
        text: o.text,
      });
    },
    async addReaction(o) {
      await app.client.reactions.add({
        channel: o.channel,
        timestamp: o.timestamp,
        name: o.emoji,
      });
    },
    onAction(handler) {
      app.action(/^ncq:.*$/, async ({ body, ack, action }) => {
        await ack();
        const a = action as { action_id?: string; value?: string };
        const b = body as { user?: { id?: string } };
        await handler({
          actionId: a.action_id ?? '',
          value: a.value ?? '',
          userId: b.user?.id ?? '',
        });
      });
    },
    async fetchHistoryMessage(o) {
      const res = await app.client.conversations.history({
        channel: o.channel,
        latest: o.ts,
        oldest: o.ts,
        inclusive: true,
        limit: 1,
      });
      const msg = res.messages?.[0];
      if (!msg || typeof msg.ts !== 'string') return null;
      return { ts: msg.ts, text: msg.text };
    },
    async fetchThreadReplies(o) {
      const res = await app.client.conversations.replies({
        channel: o.channel,
        ts: o.threadTs,
        limit: 100,
      });
      const msgs = res.messages ?? [];
      return msgs
        .filter((m): m is { ts: string; text?: string } => typeof m.ts === 'string')
        .map((m) => ({ ts: m.ts, text: m.text }));
    },
    async fetchChannelHistory(o) {
      const res = await app.client.conversations.history({
        channel: o.channel,
        oldest: o.oldestTs,
        limit: o.limit ?? 100,
        inclusive: o.inclusive ?? false,
      });
      const msgs = res.messages ?? [];
      return msgs
        .filter((m): m is typeof m & { ts: string } => typeof m.ts === 'string')
        .map((m) => ({
          ts: m.ts,
          text: m.text,
          user: m.user,
          bot_id: m.bot_id,
        }));
    },
    async listConversations(o) {
      const res = await app.client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: o.limit ?? 200,
        ...(o.cursor && { cursor: o.cursor }),
      });
      return {
        channels: (res.channels ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          is_member: c.is_member,
        })),
        nextCursor: res.response_metadata?.next_cursor || undefined,
      };
    },
  };
}
