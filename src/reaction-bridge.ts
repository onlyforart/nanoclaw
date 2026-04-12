/**
 * Reaction-to-event bridge for the approval flow.
 * Translates channel reactions on proposed_reply messages into pipeline events.
 */

import {
  ackEvent,
  getRecentEvents,
  publishEvent,
} from './db.js';
import { logger } from './logger.js';
import type { EventRow } from './types.js';

export interface Reaction {
  emoji: string;
  userId: string;
  messageId: string;
  chatJid: string;
  timestamp: string;
}

interface ProposedReplyPayload {
  team_message_id: string;
  source_channel: string;
  proposed_text: string;
  observation_ids: number[];
}

/**
 * Handle a reaction from any channel.
 * If it's on a proposed_reply message, dispatch to the appropriate handler.
 */
export function handleReaction(reaction: Reaction): void {
  const proposal = findProposedReply(reaction.messageId);
  if (!proposal) return; // Not a proposal message — ignore

  switch (reaction.emoji) {
    case 'thumbsup':
    case '+1':
    case 'thumbs_up':
      publishApprovedReply(proposal.event, proposal.payload);
      break;
    case 'thumbsdown':
    case '-1':
    case 'thumbs_down':
      publishRejection(proposal.event);
      break;
    case 'speech_balloon':
      startEditFlow(proposal.event, reaction.userId, reaction.chatJid);
      break;
    default:
      // Unknown emoji on proposal — ignore
      break;
  }
}

function findProposedReply(
  messageId: string,
): { event: EventRow; payload: ProposedReplyPayload } | null {
  // Look for pending proposed_reply events whose payload contains this message ID
  const events = getRecentEvents(['proposed_reply'], 50, false);

  for (const event of events) {
    try {
      const payload = JSON.parse(event.payload) as ProposedReplyPayload;
      if (payload.team_message_id === messageId) {
        return { event, payload };
      }
    } catch {
      continue;
    }
  }

  return null;
}

function publishApprovedReply(
  event: EventRow,
  payload: ProposedReplyPayload,
): void {
  // Idempotent: use a dedupe key derived from the proposal event ID
  const dedupeKey = `approved:${event.id}`;

  publishEvent(
    'approved_reply',
    event.source_group,
    'reaction-bridge',
    JSON.stringify({
      target_channel: payload.source_channel,
      approved_text: payload.proposed_text,
      observation_ids: payload.observation_ids,
      idempotency_key: `reply:${event.id}:${Date.now()}`,
      proposal_event_id: event.id,
    }),
    dedupeKey,
  );

  // Ack the proposal as done
  ackEvent(event.id, 'done', 'approved by human');

  logger.info(
    { proposalEventId: event.id, targetChannel: payload.source_channel },
    'Proposed reply approved',
  );
}

function publishRejection(event: EventRow): void {
  ackEvent(event.id, 'done', 'rejected by human');

  logger.info(
    { proposalEventId: event.id },
    'Proposed reply rejected',
  );
}

function startEditFlow(event: EventRow, userId: string, chatJid: string): void {
  publishEvent(
    'edit_requested',
    event.source_group,
    'reaction-bridge',
    JSON.stringify({
      userId,
      proposedReplyEventId: event.id,
      chatJid, // team channel JID where the edit message will arrive
    }),
    undefined,
    1800, // 30-minute TTL
  );

  logger.info(
    { proposalEventId: event.id, userId },
    'Edit flow started — waiting for follow-up message',
  );
}

// --- Edit flow: message interception ---

export interface PendingEditEvent {
  editEventId: number;
  proposedReplyEventId: number;
  userId: string;
}

/**
 * Check if there's a pending edit request for this user in this channel.
 * Called from onMessage before dispatching to the agent.
 */
export function findPendingEditRequest(
  chatJid: string,
  userId: string,
): PendingEditEvent | null {
  const events = getRecentEvents(['edit_requested'], 50, false);

  for (const event of events) {
    if (event.status !== 'pending') continue;
    try {
      const payload = JSON.parse(event.payload);
      if (payload.userId === userId && payload.chatJid === chatJid) {
        return {
          editEventId: event.id,
          proposedReplyEventId: payload.proposedReplyEventId,
          userId: payload.userId,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Complete the edit flow: publish approved_reply with edited text, ack edit event.
 */
export function completeEditFlow(
  editEvent: PendingEditEvent,
  editedText: string,
): void {
  // Find the original proposal to get source_channel and observation_ids
  const allEvents = getRecentEvents(['proposed_reply'], 50, true);
  const proposal = allEvents.find((e) => e.id === editEvent.proposedReplyEventId);

  if (!proposal) {
    logger.warn(
      { proposedReplyEventId: editEvent.proposedReplyEventId },
      'Original proposal not found for edit flow',
    );
    ackEvent(editEvent.editEventId, 'failed', 'original proposal not found');
    return;
  }

  const payload = JSON.parse(proposal.payload) as ProposedReplyPayload;

  publishEvent(
    'approved_reply',
    proposal.source_group,
    'reaction-bridge',
    JSON.stringify({
      target_channel: payload.source_channel,
      approved_text: editedText,
      observation_ids: payload.observation_ids,
      idempotency_key: `reply:${proposal.id}:edited:${Date.now()}`,
      proposal_event_id: proposal.id,
    }),
    `approved:edited:${proposal.id}`,
  );

  ackEvent(editEvent.editEventId, 'done', 'edit completed');

  logger.info(
    { proposalEventId: proposal.id, editEventId: editEvent.editEventId },
    'Edit flow completed — approved_reply published with edited text',
  );
}
