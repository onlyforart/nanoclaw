/**
 * Per-adapter ChannelSetup factory.
 *
 * Extracted from `src/index.ts main()` so the wiring is unit-testable
 * in isolation (importing `src/index.ts` from a test file otherwise
 * triggers the modules barrel and pulls in the whole startup chain).
 *
 * Mirrors §4.6.5's `buildHostApi(db)` factory pattern. The §4.6.6 patch
 * adds the `onReaction: dispatchReaction` wiring here.
 */
import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import { log } from './log.js';
import { dispatchReaction } from './reaction-handlers.js';
import { getResponseHandlers, type ResponsePayload } from './response-registry.js';
import { routeInbound } from './router.js';

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

export function buildChannelSetup(adapter: ChannelAdapter): ChannelSetup {
  return {
    onInbound(platformId, threadId, message) {
      routeInbound({
        channelType: adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
        },
      }).catch((err) => {
        log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
      });
    },
    onInboundEvent(event) {
      routeInbound(event).catch((err) => {
        log.error('Failed to route inbound event', {
          sourceAdapter: adapter.channelType,
          targetChannelType: event.channelType,
          err,
        });
      });
    },
    onMetadata(platformId, name, isGroup) {
      log.info('Channel metadata discovered', {
        channelType: adapter.channelType,
        platformId,
        name,
        isGroup,
      });
    },
    onAction(questionId, selectedOption, userId) {
      dispatchResponse({
        questionId,
        value: selectedOption,
        userId,
        channelType: adapter.channelType,
        // platformId/threadId aren't surfaced by the current onAction
        // signature — registered handlers look them up from the
        // pending_question / pending_approval row.
        platformId: '',
        threadId: null,
      }).catch((err) => {
        log.error('Failed to handle question response', { questionId, err });
      });
    },
    onReaction: dispatchReaction,
  };
}
