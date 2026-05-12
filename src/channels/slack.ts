/**
 * Slack channel adapter — fork-only Socket Mode port of v1
 * src/channels/slack.ts. Uses @slack/bolt directly (not the v2
 * webhook-only Chat-SDK shim).
 */
import type { KnownBlock } from '@slack/types';

import type { ChannelAdapter, ChannelSetup, ConversationInfo, InboundMessage, OutboundMessage } from './adapter.js';
import { log } from '../log.js';
import { registerChannelAdapter } from './channel-registry.js';
import {
  createBoltShim,
  type ActionPayload,
  type BoltShim,
  type HandledMessageEvent,
  type ReactionAddedEvent,
} from './slack-bolt-shim.js';
import { markdownToBlocks, markdownToSlackPayload } from './slack-blocks.js';

/**
 * Strip the `slack:` channel-type prefix that v2 stores on platform_id
 * (e.g. `slack:C0ALE6G9FGB` → `C0ALE6G9FGB`). The bolt-shim / Slack Web API
 * expects the raw channel ID; passing the prefixed form returns
 * `channel_not_found` even when the bot is a member.
 */
function toSlackChannelId(platformId: string): string {
  return platformId.startsWith('slack:') ? platformId.slice('slack:'.length) : platformId;
}

interface QueuedMessage {
  platformId: string;
  threadId: string | null;
  text: string;
}

interface AskQuestionOption {
  value: string;
  label: string;
}

function extractText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.markdown === 'string') return c.markdown;
    if (typeof c.text === 'string') return c.text;
  }
  return undefined;
}

function asObject(content: unknown): Record<string, unknown> | undefined {
  if (content && typeof content === 'object') {
    return content as Record<string, unknown>;
  }
  return undefined;
}

function buildAskQuestionBlocks(
  questionId: string,
  title: string,
  question: string,
  options: AskQuestionOption[],
): KnownBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: title.slice(0, 150), emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: question.slice(0, 3000) },
    },
    {
      type: 'actions',
      elements: options.map((opt, idx) => ({
        type: 'button',
        action_id: `ncq:${questionId}:${idx}`,
        text: { type: 'plain_text', text: opt.label, emoji: true },
        value: String(idx),
      })),
    },
  ] as KnownBlock[];
}

/**
 * Build a Slack ChannelAdapter from a Bolt shim. The shim is the
 * test seam — production wires the real @slack/bolt App via
 * createBoltShim from './slack-bolt-shim.js'.
 */
export function createSlackAdapterWithShim(shim: BoltShim): ChannelAdapter {
  let botUserId: string | undefined;
  let connected = false;
  let config: ChannelSetup | null = null;
  const outgoingQueue: QueuedMessage[] = [];
  let flushing = false;
  const askQuestionOptions = new Map<string, AskQuestionOption[]>();

  async function handleSlackReaction(event: ReactionAddedEvent): Promise<void> {
    if (event.item.type !== 'message') return;
    const platformId = event.item.channel;
    const messageId = event.item.ts;
    if (!platformId || !messageId) return;
    if (!config?.onReaction) return;

    // Strip Slack's ::skin-tone-N modifier so handler chain matches on the
    // base emoji name (carry-across from f50dd58).
    const emoji = event.reaction.replace(/::skin-tone-\d+$/, '');

    try {
      await config.onReaction({
        channelType: 'slack',
        platformId,
        threadId: null,
        messageId,
        emoji,
        userId: event.user,
        timestamp: new Date(parseFloat(event.event_ts) * 1000).toISOString(),
      });
    } catch (err) {
      log.warn('Slack reaction_added handler threw', {
        channel: toSlackChannelId(platformId),
        messageId,
        emoji,
        err,
      });
    }
  }

  function handleAction(payload: ActionPayload): void {
    const m = /^ncq:([^:]+):(\d+)$/.exec(payload.actionId);
    if (!m) {
      log.warn('Slack onAction: malformed action_id', {
        actionId: payload.actionId,
      });
      return;
    }
    const questionId = m[1];
    const idx = parseInt(m[2], 10);
    const options = askQuestionOptions.get(questionId);
    if (!options || idx < 0 || idx >= options.length) {
      log.warn('Slack onAction: unknown questionId or out-of-range idx', {
        questionId,
        idx,
      });
      return;
    }
    config?.onAction(questionId, options[idx].value, payload.userId);
  }

  async function deliverAskQuestion(
    platformId: string,
    threadId: string | null,
    content: Record<string, unknown>,
  ): Promise<string | undefined> {
    if (!connected) {
      log.warn('Slack disconnected, dropping ask_question (not queueable)', {
        channel: toSlackChannelId(platformId),
        questionId: content.questionId,
      });
      return undefined;
    }
    const questionId = content.questionId;
    const title = content.title;
    const question = content.question;
    const rawOptions = content.options;
    if (
      typeof questionId !== 'string' ||
      typeof title !== 'string' ||
      typeof question !== 'string' ||
      !Array.isArray(rawOptions) ||
      rawOptions.length === 0
    ) {
      log.warn('Slack ask_question: missing required fields', {
        channel: toSlackChannelId(platformId),
        questionId,
      });
      return undefined;
    }
    const options: AskQuestionOption[] = rawOptions
      .map((o: unknown) => {
        const obj = asObject(o);
        if (!obj || typeof obj.value !== 'string' || typeof obj.label !== 'string') {
          return null;
        }
        return { value: obj.value, label: obj.label };
      })
      .filter((o): o is AskQuestionOption => o !== null);

    if (options.length === 0) {
      log.warn('Slack ask_question: no valid options', {
        channel: toSlackChannelId(platformId),
        questionId,
      });
      return undefined;
    }

    askQuestionOptions.set(questionId, options);

    const blocks = buildAskQuestionBlocks(questionId, title, question, options);
    const fallback = `${title}\n\n${question}\nOptions: ${options.map((o) => o.label).join(', ')}`;

    try {
      const result = await shim.postMessage({
        channel: toSlackChannelId(platformId),
        ...(threadId ? { threadTs: threadId } : {}),
        blocks,
        text: fallback.slice(0, 4000),
      });
      return result.ts;
    } catch (err) {
      log.error('Slack ask_question post failed', {
        channel: toSlackChannelId(platformId),
        questionId,
        err,
      });
      return undefined;
    }
  }

  async function deliverEdit(platformId: string, content: Record<string, unknown>): Promise<string | undefined> {
    if (!connected) {
      log.warn('Slack disconnected, dropping edit (not queueable)', {
        channel: toSlackChannelId(platformId),
        messageId: content.messageId,
      });
      return undefined;
    }
    const messageId = content.messageId;
    if (typeof messageId !== 'string') {
      log.warn('Slack edit: missing messageId', { channel: platformId });
      return undefined;
    }
    const text = extractText(content);
    if (!text) {
      log.warn('Slack edit: missing text/markdown', {
        channel: toSlackChannelId(platformId),
        messageId,
      });
      return undefined;
    }
    try {
      await shim.editMessage({
        channel: toSlackChannelId(platformId),
        ts: messageId,
        blocks: markdownToBlocks(text),
        text: text.slice(0, 4000),
      });
      return messageId;
    } catch (err) {
      log.error('Slack edit failed', { channel: toSlackChannelId(platformId), messageId, err });
      return undefined;
    }
  }

  async function deliverReaction(platformId: string, content: Record<string, unknown>): Promise<string | undefined> {
    if (!connected) {
      log.warn('Slack disconnected, dropping reaction (not queueable)', {
        channel: toSlackChannelId(platformId),
        messageId: content.messageId,
      });
      return undefined;
    }
    const messageId = content.messageId;
    const emoji = content.emoji;
    if (typeof messageId !== 'string') {
      log.warn('Slack reaction: missing messageId', { channel: platformId });
      return undefined;
    }
    if (typeof emoji !== 'string') {
      log.warn('Slack reaction: missing emoji', {
        channel: toSlackChannelId(platformId),
        messageId,
      });
      return undefined;
    }
    try {
      await shim.addReaction({
        channel: toSlackChannelId(platformId),
        timestamp: messageId,
        emoji,
      });
      return undefined;
    } catch (err) {
      log.error('Slack reaction failed', {
        channel: toSlackChannelId(platformId),
        messageId,
        emoji,
        err,
      });
      return undefined;
    }
  }

  function handleSlackMessage(event: HandledMessageEvent): void {
    const e = event as {
      text?: string;
      channel: string;
      ts: string;
      channel_type?: string;
      user?: string;
      bot_id?: string;
    };
    if (!e.text) return;

    const platformId = e.channel;
    const isGroup = e.channel_type !== 'im';

    // Always report metadata for channel discovery, even for the bot's
    // own posts (carry-across from v1 slack.ts:89). Bot self-posts then
    // skip onInbound below — v2 has no is_bot_message field, and routing
    // the bot's own outbound back through messages_in would cause the
    // agent to see and potentially respond to its own replies.
    config?.onMetadata(platformId, undefined, isGroup);

    const isBotMessage = !!e.bot_id || (!!botUserId && e.user === botUserId);
    if (isBotMessage) return;

    const timestamp = new Date(parseFloat(e.ts) * 1000).toISOString();
    const isMention = !!botUserId && e.text.includes(`<@${botUserId}>`);

    void Promise.resolve(
      config?.onInbound(platformId, null, {
        id: e.ts,
        kind: 'chat',
        content: e.text,
        timestamp,
        isMention,
        isGroup,
      }),
    ).catch((err) => {
      log.error('Slack onInbound handler threw', {
        channel: toSlackChannelId(platformId),
        ts: e.ts,
        err,
      });
    });
  }

  async function flushOutgoingQueue(): Promise<void> {
    if (flushing || outgoingQueue.length === 0) return;
    flushing = true;
    try {
      log.info('Flushing Slack outgoing queue', { count: outgoingQueue.length });
      while (outgoingQueue.length > 0) {
        const item = outgoingQueue.shift()!;
        const payload = markdownToSlackPayload(item.text);
        await shim.postMessage({
          channel: toSlackChannelId(item.platformId),
          ...(item.threadId ? { threadTs: item.threadId } : {}),
          blocks: payload.blocks,
          text: payload.text,
        });
        log.info('Queued Slack message sent', {
          channel: toSlackChannelId(item.platformId),
          length: item.text.length,
        });
      }
    } finally {
      flushing = false;
    }
  }

  return {
    name: 'slack',
    channelType: 'slack',
    supportsThreads: true,

    async setup(c: ChannelSetup): Promise<void> {
      config = c;
      shim.onMessageEvent(handleSlackMessage);
      shim.onReactionEvent(handleSlackReaction);
      shim.onAction(handleAction);
      await shim.start();
      try {
        botUserId = await shim.getBotUserId();
        log.info('Connected to Slack', { botUserId });
      } catch (err) {
        log.warn('Connected to Slack but failed to get bot user ID', { err });
      }
      connected = true;
      await flushOutgoingQueue();
    },

    async teardown(): Promise<void> {
      connected = false;
      await shim.stop();
    },

    isConnected(): boolean {
      return connected;
    },

    async setTyping(_platformId: string, _threadId: string | null): Promise<void> {
      // Slack Bot API has no typing-indicator endpoint.
    },

    async syncConversations(): Promise<ConversationInfo[]> {
      const out: ConversationInfo[] = [];
      let cursor: string | undefined;
      try {
        do {
          const page: { channels: Array<{ id?: string; name?: string; is_member?: boolean }>; nextCursor?: string } =
            await shim.listConversations({ cursor, limit: 200 });
          for (const ch of page.channels) {
            if (!ch.id || !ch.name) continue;
            if (!ch.is_member) continue;
            out.push({ platformId: ch.id, name: ch.name, isGroup: true });
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        log.error('Failed to sync Slack channel metadata', { err });
        return [];
      }
      log.info('Slack channel metadata synced', { count: out.length });
      return out;
    },

    async backfillFromCursor(platformId: string, oldestTimestamp: string): Promise<InboundMessage[] | null> {
      if (!connected) return null;
      try {
        const oldestTs = String(new Date(oldestTimestamp).getTime() / 1000);
        const msgs = await shim.fetchChannelHistory({
          channel: toSlackChannelId(platformId),
          oldestTs,
          limit: 100,
          inclusive: false,
        });
        const out: InboundMessage[] = [];
        for (const msg of msgs) {
          if (!msg.text) continue;
          if (msg.bot_id) continue;
          if (botUserId && msg.user === botUserId) continue;
          out.push({
            id: msg.ts,
            kind: 'chat',
            content: msg.text,
            timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
            isMention: !!botUserId && msg.text.includes(`<@${botUserId}>`),
          });
        }
        return out;
      } catch (err) {
        log.warn('Failed to backfill Slack channel history', {
          channel: toSlackChannelId(platformId),
          oldestTimestamp,
          err,
        });
        return null;
      }
    },

    async fetchThreadReplies(
      platformId: string,
      threadId: string,
    ): Promise<Array<{ id: string; text: string | null }> | null> {
      if (!connected) return null;
      try {
        const replies = await shim.fetchThreadReplies({
          channel: toSlackChannelId(platformId),
          threadTs: threadId,
        });
        return replies.map((r) => ({ id: r.ts, text: r.text ?? null }));
      } catch (err) {
        log.warn('Failed to fetch Slack thread replies', {
          channel: toSlackChannelId(platformId),
          threadId,
          err,
        });
        return null;
      }
    },

    async fetchMessageText(platformId: string, messageId: string): Promise<string | null> {
      if (!connected) return null;
      try {
        const msg = await shim.fetchHistoryMessage({
          channel: toSlackChannelId(platformId),
          ts: messageId,
        });
        if (!msg || msg.ts !== messageId) return null;
        return msg.text ?? null;
      } catch (err) {
        log.warn('Failed to fetch Slack message text', {
          channel: toSlackChannelId(platformId),
          messageId,
          err,
        });
        return null;
      }
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const obj = asObject(message.content);
      if (obj) {
        if (obj.type === 'ask_question') {
          return deliverAskQuestion(platformId, threadId, obj);
        }
        if (obj.operation === 'edit') {
          return deliverEdit(platformId, obj);
        }
        if (obj.operation === 'reaction') {
          return deliverReaction(platformId, obj);
        }
      }

      const text = extractText(message.content);
      if (!text) {
        log.warn('Slack deliver: unsupported content shape, skipping', {
          channel: toSlackChannelId(platformId),
          kind: message.kind,
        });
        return undefined;
      }

      if (!connected) {
        outgoingQueue.push({ platformId, threadId, text });
        log.info('Slack disconnected, message queued', {
          channel: toSlackChannelId(platformId),
          queueSize: outgoingQueue.length,
        });
        return undefined;
      }

      try {
        const payload = markdownToSlackPayload(text);
        const result = await shim.postMessage({
          channel: toSlackChannelId(platformId),
          ...(threadId ? { threadTs: threadId } : {}),
          blocks: payload.blocks,
          text: payload.text,
        });
        log.info('Slack message sent', { channel: toSlackChannelId(platformId), length: text.length });
        return result.ts;
      } catch (err) {
        outgoingQueue.push({ platformId, threadId, text });
        log.warn('Failed to send Slack message, queued', {
          channel: toSlackChannelId(platformId),
          err,
          queueSize: outgoingQueue.length,
        });
        return undefined;
      }
    },
  };
}

/**
 * Public factory: build a Slack adapter wired to a real Bolt App.
 * Reads SLACK_BOT_TOKEN and SLACK_APP_TOKEN from process.env (Q2);
 * returns null if either is missing so the channel registry can
 * skip activation cleanly.
 */
export function createSlackAdapter(): ChannelAdapter | null {
  const botToken = process.env.SLACK_BOT_TOKEN;
  const appToken = process.env.SLACK_APP_TOKEN;
  if (!botToken || !appToken) {
    log.warn('Slack adapter disabled — SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set');
    return null;
  }
  const shim = createBoltShim({ botToken, appToken });
  return createSlackAdapterWithShim(shim);
}

registerChannelAdapter('slack', { factory: createSlackAdapter });
