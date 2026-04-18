import { describe, it, expect, vi } from 'vitest';

import {
  parseProposedReply,
  handlePipelineApprovalReaction,
} from './pipeline-approval.js';
import type { Reaction } from './reaction-bridge.js';
import type { RegisteredGroup } from './types.js';

describe('parseProposedReply — F5b draft parser', () => {
  const SAMPLE = `🟡 PROPOSED REPLY for event 42 on slack:CSUPPORT thread
> is the perps MDV up right now?

*Draft reply:*
> Perps MDV is currently OK per check_venue_status.

*Investigation:*
check_venue_status returned { status: "OK", lastUpdate: "..." }

React 👍 to approve, 👎 to discard.`;

  it('F5b.1 — extracts event_id and draft text from a well-formed PROPOSED REPLY', () => {
    const parsed = parseProposedReply(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.eventId).toBe(42);
    expect(parsed!.draft).toBe(
      'Perps MDV is currently OK per check_venue_status.',
    );
  });

  it('F5b.2 — returns null for non-proposal messages', () => {
    expect(parseProposedReply('hello world')).toBeNull();
    expect(parseProposedReply('')).toBeNull();
    expect(parseProposedReply('🟡 PROPOSED REPLY but no event id')).toBeNull();
  });

  it('F5b.3 — extracts multi-line drafts', () => {
    const text = `🟡 PROPOSED REPLY for event 7 on slack:CX
> original

*Draft reply:*
> line one
> line two
> line three

*Investigation:*
stuff`;
    const parsed = parseProposedReply(text);
    expect(parsed!.eventId).toBe(7);
    expect(parsed!.draft).toBe('line one\nline two\nline three');
  });

  it('F5b.4 — handles draft block without investigation trailer', () => {
    const text = `🟡 PROPOSED REPLY for event 99 on slack:CX
*Draft reply:*
> short draft

React 👍 to approve.`;
    const parsed = parseProposedReply(text);
    expect(parsed!.eventId).toBe(99);
    expect(parsed!.draft).toBe('short draft');
  });

  it('F5b.5 — returns null when the draft block is missing', () => {
    const text = `🟡 PROPOSED REPLY for event 42
some text but no draft block marker`;
    const parsed = parseProposedReply(text);
    expect(parsed).toBeNull();
  });
});

describe('handlePipelineApprovalReaction — F5b dispatch', () => {
  const DEV: RegisteredGroup = {
    name: 'dev',
    folder: 'slack_dev',
    trigger: '@bot',
    added_at: '2024-01-01T00:00:00.000Z',
  };

  function makeDeps(
    messageText: string | null,
    publishEvent: ReturnType<typeof vi.fn>,
  ) {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const fetchMessageText = vi.fn().mockResolvedValue(messageText);
    return {
      sendMessage,
      fetchMessageText,
      publishEvent,
      registeredGroups: { 'slack:CDEV': DEV } as Record<
        string,
        RegisteredGroup
      >,
      getEventPayloadById: vi.fn((): string | undefined =>
        JSON.stringify({
          source_channel: 'slack:CDEV',
          source_message_id: 'ts-original',
        }),
      ),
    };
  }

  function makeReaction(emoji: string): Reaction {
    return {
      emoji,
      userId: 'U123',
      messageId: 'ts-team',
      chatJid: 'slack:CDEV',
      timestamp: new Date().toISOString(),
    };
  }

  const SAMPLE = `🟡 PROPOSED REPLY for event 42 on slack:CDEV
*Draft reply:*
> approved text here

React 👍 to approve.`;

  it('F5b.6 — thumbsup on a PROPOSED REPLY calls replyToEvent via sendMessage', async () => {
    const publishEvent = vi.fn();
    const deps = makeDeps(SAMPLE, publishEvent);

    const handled = await handlePipelineApprovalReaction(
      makeReaction('thumbsup'),
      deps,
    );

    expect(handled).toBe(true);
    expect(deps.fetchMessageText).toHaveBeenCalledWith('slack:CDEV', 'ts-team');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'slack:CDEV',
      'approved text here',
      { threadTs: 'ts-original' },
    );
  });

  it('F5b.7 — thumbsdown acks rejection without calling sendMessage to source', async () => {
    const publishEvent = vi.fn();
    const deps = makeDeps(SAMPLE, publishEvent);

    const handled = await handlePipelineApprovalReaction(
      makeReaction('thumbsdown'),
      deps,
    );

    expect(handled).toBe(true);
    // Should not post to source thread
    const call = deps.sendMessage.mock.calls.find(
      (c) => c[1] === 'approved text here',
    );
    expect(call).toBeUndefined();
  });

  it('F5b.8 — non-proposal message → returns false, no side-effects', async () => {
    const publishEvent = vi.fn();
    const deps = makeDeps('just a regular chat message', publishEvent);

    const handled = await handlePipelineApprovalReaction(
      makeReaction('thumbsup'),
      deps,
    );

    expect(handled).toBe(false);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('F5b.9 — unknown emoji on proposal → returns false (no action)', async () => {
    const publishEvent = vi.fn();
    const deps = makeDeps(SAMPLE, publishEvent);

    const handled = await handlePipelineApprovalReaction(
      makeReaction('eyes'),
      deps,
    );

    expect(handled).toBe(false);
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('F5b.10 — source event missing → returns true but logs failure (reaction consumed)', async () => {
    const publishEvent = vi.fn();
    const deps = makeDeps(SAMPLE, publishEvent);
    deps.getEventPayloadById = vi.fn(() => undefined);

    const handled = await handlePipelineApprovalReaction(
      makeReaction('thumbsup'),
      deps,
    );

    expect(handled).toBe(true);
    // Did not send the approval reply
    const call = deps.sendMessage.mock.calls.find(
      (c) => c[1] === 'approved text here',
    );
    expect(call).toBeUndefined();
  });
});
