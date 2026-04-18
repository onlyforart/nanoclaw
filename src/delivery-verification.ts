/**
 * Phase F6.2 — post-write delivery verification.
 *
 * After reply_to_event successfully calls sendMessage, the host schedules
 * a best-effort re-read of the source thread N seconds later and checks
 * whether our message is present. If it isn't, a
 * pipeline_delivery_failed event is published so the operator notices
 * via the webui cluster journal (Phase F6 UI renders this event type).
 *
 * This is best-effort, not a security boundary: process restarts lose
 * the scheduled check, and the match is by text equality which can
 * miss legitimate edits. The goal is to catch the failure mode seen in
 * Phase E — sendMessage resolved but no message actually landed — not
 * to audit every delivery.
 */

import { logger } from './logger.js';

export const DEFAULT_DELIVERY_VERIFICATION_DELAY_MS = 30_000;

export interface VerifyDeliveryArgs {
  eventId: number;
  channelJid: string;
  threadTs: string;
  expectedText: string;
}

export interface VerifyDeliveryDeps {
  fetchThreadReplies: (
    channelJid: string,
    threadTs: string,
  ) => Promise<Array<{ ts: string; text: string | null }> | null>;
  publishEvent: (
    eventType: string,
    sourceGroup: string,
    sourceTaskId: string | null,
    payload: string,
    dedupeKey: string | null,
    ttlSeconds: number | null,
  ) => { id: number; isNew: boolean };
}

/**
 * Pure-function version of the verification: given thread replies and the
 * expected text, decide whether delivery succeeded. Exported for tests.
 */
export function verifyDeliveryFromReplies(
  replies: Array<{ ts: string; text: string | null }> | null,
  expectedText: string,
): { delivered: boolean; reason?: string } {
  if (replies === null) {
    return { delivered: false, reason: 'fetchThreadReplies returned null' };
  }
  if (replies.length === 0) {
    return { delivered: false, reason: 'thread is empty' };
  }
  const normalised = expectedText.trim();
  const match = replies.find(
    (r) => r.text != null && r.text.trim() === normalised,
  );
  return match
    ? { delivered: true }
    : {
        delivered: false,
        reason: `expected text not found among ${replies.length} thread replies`,
      };
}

/**
 * Run one verification pass synchronously. On mismatch, publishes
 * pipeline_delivery_failed. Used by the setTimeout scheduler in the
 * caller; also directly callable for tests.
 */
export async function runDeliveryVerification(
  args: VerifyDeliveryArgs,
  deps: VerifyDeliveryDeps,
): Promise<{ delivered: boolean; reason?: string }> {
  let replies: Array<{ ts: string; text: string | null }> | null = null;
  try {
    replies = await deps.fetchThreadReplies(args.channelJid, args.threadTs);
  } catch (err) {
    logger.warn(
      { err, ...args },
      'F6.2 delivery verification: fetchThreadReplies threw',
    );
    return {
      delivered: false,
      reason: 'fetchThreadReplies threw',
    };
  }

  const result = verifyDeliveryFromReplies(replies, args.expectedText);
  if (result.delivered) {
    logger.info(
      { eventId: args.eventId, channelJid: args.channelJid },
      'F6.2 delivery verified',
    );
    return result;
  }

  logger.warn(
    { ...args, reason: result.reason },
    'F6.2 delivery NOT verified — publishing pipeline_delivery_failed',
  );

  try {
    deps.publishEvent(
      'pipeline_delivery_failed',
      'system',
      'delivery-verification',
      JSON.stringify({
        original_event_id: args.eventId,
        source_channel: args.channelJid,
        source_message_id: args.threadTs,
        expected_text: args.expectedText.slice(0, 500),
        reason: result.reason,
        detected_at: new Date().toISOString(),
      }),
      `delivery-failed:${args.eventId}`,
      null,
    );
  } catch (err) {
    logger.error(
      { err, eventId: args.eventId },
      'F6.2 failed to publish pipeline_delivery_failed',
    );
  }

  return result;
}

/**
 * Schedule a verification to run after delayMs. Fire-and-forget — the
 * caller does not await.
 */
export function scheduleDeliveryVerification(
  args: VerifyDeliveryArgs,
  deps: VerifyDeliveryDeps,
  delayMs: number = DEFAULT_DELIVERY_VERIFICATION_DELAY_MS,
): void {
  setTimeout(() => {
    void runDeliveryVerification(args, deps);
  }, delayMs);
}
