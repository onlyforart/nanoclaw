/**
 * Host-side pipeline executor for the sanitiser.
 * Orchestrates Layer 1 → Layer 2 → Layer 3 for each message.
 * No container spawned — runs directly in the host process.
 */

import {
  ackEvent,
  bumpConsumerTaskNextRun,
  consumeEvents,
  getPassiveGroups,
  getRouterState,
  insertIntakeObservation,
  insertObservedMessage,
  publishEvent,
  readChatMessages,
  setRouterState,
  updateIntakeLogProcessed,
  updateObservationSanitised,
} from './db.js';
import { logger } from './logger.js';
import { preprocessMessage, type Layer1Input } from './sanitiser/layer1.js';
import {
  buildExtractionPrompt,
  LAYER2_TOOL_SCHEMA,
  parseAndValidateResponse,
} from './sanitiser/layer2.js';
import { postProcess, type SanitiserSchema } from './sanitiser/layer3.js';
import type { LlmResponse } from './sanitiser/llm-client.js';
import type { NewMessage } from './types.js';

export interface PipelineDeps {
  callLLM: (request: {
    model: string;
    system: string;
    user: string;
    toolSchema?: object;
  }) => Promise<LlmResponse>;
  model: string;
  sanitiserVersion: string;
  sourceChannels: string[];
  schema?: SanitiserSchema;
}

export interface PipelineResult {
  messagesProcessed: number;
  intakeProcessed: number;
  quarantined: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
}

// Default schema used when none provided via deps
const DEFAULT_SCHEMA: SanitiserSchema = {
  version: 1,
  fields: {
    fact_summary: { type: 'string', required: true, max_length: 200 },
    urgency: {
      type: 'enum',
      required: true,
      values: ['fyi', 'question', 'issue', 'incident', 'other'],
      open: true,
    },
    speech_act: {
      type: 'enum',
      required: true,
      values: [
        'fresh_report',
        'status_update',
        'still_broken',
        'fix_announcement',
        'self_resolution',
        'diagnosis',
        'downstream_notification',
        'change_attribution_question',
        'architectural_request',
        'data_request',
        'banter',
        'other',
      ],
      open: true,
    },
    reporter_role_hint: {
      type: 'enum',
      required: true,
      values: [
        'original_reporter',
        'forwarder',
        'diagnostician',
        'responder',
        'fix_committer',
        'access_broker',
        'other',
      ],
      open: true,
    },
    appears_to_address_bot: { type: 'boolean', required: true },
    contains_imperative: { type: 'boolean', required: true },
    sentiment: {
      type: 'enum',
      required: true,
      values: ['neutral', 'frustrated', 'urgent', 'confused', 'other'],
      open: true,
    },
    action_requested: {
      type: 'string',
      required: false,
      nullable: true,
      max_length: 150,
    },
    resolution_owner_hint: {
      type: 'enum',
      required: true,
      values: [
        'this_team',
        'other_internal_team',
        'external_vendor',
        'customer',
        'unclear',
      ],
      open: true,
    },
  },
};

const CURSOR_PREFIX = 'sanitiser_cursor:';

export async function executeHostPipeline(
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const schema = deps.schema ?? DEFAULT_SCHEMA;
  const result: PipelineResult = {
    messagesProcessed: 0,
    intakeProcessed: 0,
    quarantined: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: null,
  };

  // --- Process passive channel messages ---
  for (const chatJid of deps.sourceChannels) {
    const cursorKey = `${CURSOR_PREFIX}${chatJid}`;
    const cursor = getRouterState(cursorKey) || '';

    const { messages } = readChatMessages(chatJid, cursor, 50, true);
    if (messages.length === 0) continue;

    for (const msg of messages) {
      const obsId = insertObservedMessage({
        source_chat_jid: chatJid,
        source_message_id: msg.id,
        source_type: 'passive_channel',
        raw_text: msg.content,
      });

      await processObservation(
        obsId,
        msg.content,
        {
          sender_id: msg.sender,
          channel_id: chatJid,
          timestamp: msg.timestamp,
          is_bot_message: !!msg.is_bot_message,
          source_message_id: msg.id,
        },
        deps,
        schema,
        result,
      );

      // Advance cursor per-message
      setRouterState(cursorKey, msg.timestamp);
      result.messagesProcessed++;
    }
  }

  // --- Process intake events ---
  const intakeEvents = consumeEvents(['intake.raw'], 'pipeline:sanitiser', 50);
  for (const event of intakeEvents) {
    let payload: { raw_text: string; source_context: Record<string, string> };
    try {
      payload = JSON.parse(event.payload);
    } catch {
      ackEvent(event.id, 'failed', 'Invalid intake event payload');
      continue;
    }

    const obsId = insertIntakeObservation({
      raw_text: payload.raw_text,
      source_task_id: payload.source_context.source_task_id || '',
      source_group: payload.source_context.source_group || '',
      intake_reason: payload.source_context.reason || '',
      intake_event_id: event.id,
      source_chat_jid: payload.source_context.source_channel || null,
      source_message_id: payload.source_context.source_message_id || null,
    });

    await processObservation(
      obsId,
      payload.raw_text,
      {
        sender_id: 'unknown',
        channel_id: payload.source_context.source_channel || 'unknown',
        timestamp: event.created_at,
        is_bot_message: false,
      },
      deps,
      schema,
      result,
    );

    ackEvent(event.id, 'done', `observation_id=${obsId}`);
    updateIntakeLogProcessed(event.id, obsId);
    result.intakeProcessed++;
  }

  return result;
}

async function processObservation(
  obsId: number,
  rawText: string,
  meta: {
    sender_id: string;
    channel_id: string;
    timestamp: string;
    is_bot_message: boolean;
    source_message_id?: string;
  },
  deps: PipelineDeps,
  schema: SanitiserSchema,
  result: PipelineResult,
): Promise<void> {
  // Layer 1
  const layer1Input: Layer1Input = {
    raw_text: rawText,
    sender_id: meta.sender_id,
    channel_id: meta.channel_id,
    timestamp: meta.timestamp,
    is_bot_message: meta.is_bot_message,
  };
  const layer1 = preprocessMessage(layer1Input);

  // Skip filtered messages
  if (layer1.filtered) {
    updateObservationSanitised(obsId, {
      sanitised_json: null,
      sanitiser_model: deps.model,
      sanitiser_version: deps.sanitiserVersion,
      flags: JSON.stringify(['filtered', layer1.filter_reason]),
    });
    return;
  }

  // Layer 2 — call LLM
  const { system, user } = buildExtractionPrompt({
    processed_text: layer1.processed_text,
    deterministic_fields: layer1,
  });

  const llmResponse = await deps.callLLM({
    model: deps.model,
    system,
    user,
    toolSchema: LAYER2_TOOL_SCHEMA,
  });

  logger.debug(
    {
      obsId,
      model: deps.model,
      responseLength: llmResponse.response.length,
      response: llmResponse.response.slice(0, 500),
    },
    'Layer 2 LLM response',
  );

  result.inputTokens += llmResponse.inputTokens;
  result.outputTokens += llmResponse.outputTokens;
  if (llmResponse.costUSD != null) {
    result.costUSD = (result.costUSD ?? 0) + llmResponse.costUSD;
  }

  // Layer 3 — post-process
  const layer3 = postProcess(
    { layer1, layer2Raw: llmResponse.response },
    schema,
  );

  // Update observation
  updateObservationSanitised(obsId, {
    sanitised_json: layer3.sanitised_json
      ? JSON.stringify(layer3.sanitised_json)
      : null,
    sanitiser_model: deps.model,
    sanitiser_version: deps.sanitiserVersion,
    flags: layer3.flags.length > 0 ? JSON.stringify(layer3.flags) : null,
  });

  // Publish events
  if (layer3.quarantined) {
    publishEvent(
      'human_review_required',
      meta.channel_id,
      'pipeline:sanitiser',
      JSON.stringify({ observation_id: obsId, reason: layer3.flags }),
      `review:${obsId}`,
    );
    bumpConsumerTaskNextRun('human_review_required');
    result.quarantined++;
  } else {
    publishEvent(
      'observation.passive',
      meta.channel_id,
      'pipeline:sanitiser',
      JSON.stringify({
        observation_id: obsId,
        source_message_id: meta.source_message_id || null,
        source_channel: meta.channel_id,
        sanitised: layer3.sanitised_json,
      }),
      `obs:${obsId}`,
    );
    bumpConsumerTaskNextRun('observation.');
  }
}
