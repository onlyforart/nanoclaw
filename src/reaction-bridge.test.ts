import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  ackEvent,
  consumeEvents,
  getRecentEvents,
  publishEvent,
} from './db.js';
import {
  handleReaction,
  findPendingEditRequest,
  completeEditFlow,
  type Reaction,
} from './reaction-bridge.js';

beforeEach(() => {
  _initTestDatabase();
});

function publishProposedReply(teamMessageId: string): number {
  const { id } = publishEvent(
    'proposed_reply',
    'slack_main',
    'pipeline:solver',
    JSON.stringify({
      team_message_id: teamMessageId,
      source_channel: 'slack:CPASSIVE',
      proposed_text: 'Here is the proposed reply.',
      observation_ids: [1, 2],
    }),
  );
  return id;
}

// --- handleReaction ---

describe('handleReaction', () => {
  it('publishes approved_reply on thumbsup reaction to a proposal', () => {
    publishProposedReply('msg-proposal-1');

    const reaction: Reaction = {
      emoji: 'thumbsup',
      userId: 'U_HUMAN',
      messageId: 'msg-proposal-1',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    };

    handleReaction(reaction);

    const approved = getRecentEvents(['approved_reply'], 10, true);
    expect(approved).toHaveLength(1);
    const payload = JSON.parse(approved[0].payload);
    expect(payload.approved_text).toBe('Here is the proposed reply.');
    expect(payload.target_channel).toBe('slack:CPASSIVE');
  });

  it('acks proposed_reply as rejected on thumbsdown', () => {
    const eventId = publishProposedReply('msg-proposal-2');

    handleReaction({
      emoji: 'thumbsdown',
      userId: 'U_HUMAN',
      messageId: 'msg-proposal-2',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    });

    const events = getRecentEvents(['proposed_reply'], 10, true);
    expect(events[0].status).toBe('done');
    expect(events[0].result_note).toContain('rejected');
  });

  it('publishes edit_requested on speech_balloon', () => {
    publishProposedReply('msg-proposal-3');

    handleReaction({
      emoji: 'speech_balloon',
      userId: 'U_HUMAN',
      messageId: 'msg-proposal-3',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    });

    const editEvents = getRecentEvents(['edit_requested'], 10, true);
    expect(editEvents).toHaveLength(1);
    const payload = JSON.parse(editEvents[0].payload);
    expect(payload.userId).toBe('U_HUMAN');
  });

  it('ignores reactions on non-proposal messages', () => {
    handleReaction({
      emoji: 'thumbsup',
      userId: 'U_HUMAN',
      messageId: 'msg-not-a-proposal',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    });

    const approved = getRecentEvents(['approved_reply'], 10, true);
    expect(approved).toHaveLength(0);
  });

  it('is idempotent — duplicate thumbsup does not create duplicate approved_reply', () => {
    publishProposedReply('msg-proposal-4');

    const reaction: Reaction = {
      emoji: 'thumbsup',
      userId: 'U_HUMAN',
      messageId: 'msg-proposal-4',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    };

    handleReaction(reaction);
    handleReaction(reaction);

    const approved = getRecentEvents(['approved_reply'], 10, true);
    expect(approved).toHaveLength(1);
  });
});

// --- findPendingEditRequest + completeEditFlow ---

describe('edit flow', () => {
  it('findPendingEditRequest returns the edit event for the right user and channel', () => {
    publishProposedReply('msg-edit-1');

    handleReaction({
      emoji: 'speech_balloon',
      userId: 'U_EDITOR',
      messageId: 'msg-edit-1',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    });

    const editEvent = findPendingEditRequest('slack:CMAIN', 'U_EDITOR');
    expect(editEvent).not.toBeNull();
  });

  it('findPendingEditRequest returns null when no edit pending', () => {
    expect(findPendingEditRequest('slack:CMAIN', 'U_NOBODY')).toBeNull();
  });

  it('completeEditFlow publishes approved_reply with edited text and acks edit event', () => {
    publishProposedReply('msg-edit-2');

    handleReaction({
      emoji: 'speech_balloon',
      userId: 'U_EDITOR',
      messageId: 'msg-edit-2',
      chatJid: 'slack:CMAIN',
      timestamp: '2024-06-01T12:00:00.000Z',
    });

    const editEvent = findPendingEditRequest('slack:CMAIN', 'U_EDITOR');
    expect(editEvent).not.toBeNull();

    completeEditFlow(editEvent!, 'My edited reply text');

    // approved_reply should exist with the edited text
    const approved = getRecentEvents(['approved_reply'], 10, true);
    expect(approved).toHaveLength(1);
    const payload = JSON.parse(approved[0].payload);
    expect(payload.approved_text).toBe('My edited reply text');

    // edit_requested should be acked
    const editEvents = getRecentEvents(['edit_requested'], 10, true);
    expect(editEvents[0].status).toBe('done');
  });
});
