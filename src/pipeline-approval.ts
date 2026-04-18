/**
 * Phase F5b — pipeline approval reacji handler.
 *
 * Listens for 👍 / 👎 reactions on PROPOSED REPLY messages posted by
 * the solver (Phase F5a) in team channels. On 👍, fetches the draft
 * text from the team-channel message, extracts the referenced
 * source event id, and publishes the approved text to the source
 * thread via the deterministic reply_to_event path.
 *
 * This keeps the human reviewer in the loop for every source-thread
 * reply (aside from the canned ack in Phase F4) while removing the
 * LLM's ability to misroute or misanswer — the draft that goes out
 * is the literal text the human approved.
 */

import { logger } from './logger.js';
import type { Reaction } from './reaction-bridge.js';
import type { RegisteredGroup } from './types.js';

/** Parsed contents of a PROPOSED REPLY message. */
export interface ProposedReplyParsed {
  eventId: number;
  draft: string;
}

const PROPOSED_REPLY_HEADER = /PROPOSED REPLY for event (\d+)/i;
// Draft block: *Draft reply:* followed by one or more lines prefixed
// with "> ". Block ends at the next blank line or the next *section*.
const DRAFT_BLOCK_MATCHER = /\*Draft reply:\*\s*\n((?:>[^\n]*\n?)+)/i;

/**
 * Parse a team-channel message for the PROPOSED REPLY format emitted
 * by the solver in Phase F5a. Returns null if the message is not a
 * proposal.
 */
export function parseProposedReply(text: string): ProposedReplyParsed | null {
  if (!text) return null;
  const header = text.match(PROPOSED_REPLY_HEADER);
  if (!header) return null;
  const eventId = Number(header[1]);
  if (!Number.isFinite(eventId) || eventId <= 0) return null;

  const draftMatch = text.match(DRAFT_BLOCK_MATCHER);
  if (!draftMatch) return null;

  const lines = draftMatch[1]
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.replace(/^>\s?/, ''));
  if (lines.length === 0) return null;

  return {
    eventId,
    draft: lines.join('\n').trim() || null,
  } as ProposedReplyParsed;
}

const APPROVE_EMOJI = new Set(['thumbsup', '+1', 'thumbs_up']);
const REJECT_EMOJI = new Set(['thumbsdown', '-1', 'thumbs_down']);

export interface PipelineApprovalDeps {
  sendMessage: (
    jid: string,
    text: string,
    options?: { threadTs?: string },
  ) => Promise<void>;
  /**
   * Fetches the text content of a message by (channelJid, messageId).
   * Returns null if the channel adapter cannot fetch (or the message
   * is no longer available).
   */
  fetchMessageText: (
    chatJid: string,
    messageId: string,
  ) => Promise<string | null>;
  registeredGroups: Record<string, RegisteredGroup>;
  /** Looks up an event payload by id. Returns the payload JSON or undefined. */
  getEventPayloadById: (eventId: number) => string | undefined;
}

/**
 * Handle a reaction that might be an approval/rejection of a Phase F5a
 * PROPOSED REPLY. Returns true iff the reaction was a proposal reacji
 * (approve/reject on a recognised draft). Returns false for anything
 * else — the caller can fall through to other reaction paths.
 */
export async function handlePipelineApprovalReaction(
  reaction: Reaction,
  deps: PipelineApprovalDeps,
): Promise<boolean> {
  const isApprove = APPROVE_EMOJI.has(reaction.emoji);
  const isReject = REJECT_EMOJI.has(reaction.emoji);
  if (!isApprove && !isReject) return false;

  const text = await deps.fetchMessageText(
    reaction.chatJid,
    reaction.messageId,
  );
  if (!text) return false;

  const parsed = parseProposedReply(text);
  if (!parsed) return false;

  if (isReject) {
    logger.info(
      { eventId: parsed.eventId, by: reaction.userId },
      'F5b proposed reply rejected',
    );
    return true;
  }

  // Approved — resolve source channel + thread from the referenced
  // candidate event and send the draft.
  const payloadJson = deps.getEventPayloadById(parsed.eventId);
  if (!payloadJson) {
    logger.warn(
      { eventId: parsed.eventId },
      'F5b approval: source event not found; skipping',
    );
    return true;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    logger.warn(
      { eventId: parsed.eventId },
      'F5b approval: source event payload malformed; skipping',
    );
    return true;
  }

  const sourceChannel = payload.source_channel as string | undefined;
  const sourceMessageId = payload.source_message_id as string | undefined;
  if (!sourceChannel) {
    logger.warn(
      { eventId: parsed.eventId },
      'F5b approval: source event missing source_channel',
    );
    return true;
  }
  if (!deps.registeredGroups[sourceChannel]) {
    logger.warn(
      { eventId: parsed.eventId, sourceChannel },
      'F5b approval: source channel not registered',
    );
    return true;
  }

  try {
    await deps.sendMessage(
      sourceChannel,
      parsed.draft,
      sourceMessageId ? { threadTs: sourceMessageId } : undefined,
    );
    logger.info(
      {
        eventId: parsed.eventId,
        sourceChannel,
        threadTs: sourceMessageId,
        approver: reaction.userId,
      },
      'F5b approved draft delivered to source thread',
    );
  } catch (err) {
    logger.error(
      { err, eventId: parsed.eventId },
      'F5b approval: failed to deliver approved draft',
    );
  }

  return true;
}
