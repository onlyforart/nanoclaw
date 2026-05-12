/**
 * Pipeline MCP tools (§4.5 step 14 commit 3).
 *
 * Container-side bridge for the 9 pipeline tools declared in
 * tool-metadata.ts. Each tool writes a `kind='system'` row to
 * outbound.db with an `action: 'pipeline_*'` field; the host's
 * delivery loop dispatches to the matching delivery action
 * registered by the pipeline plugin (see the plugin's
 * `src/ipc-handlers.ts`; plugin sources live external to this repo).
 *
 * Three tools (`get_active_clusters`, `re_extract_observation`,
 * `publish_event`, `consume_events`) need a response back from the
 * pipeline. They use the existing question/response round-trip:
 * write `system` with a questionId, poll messages_in for a row
 * tagged with the same questionId, parse + return.
 *
 * The fire-and-forget tools (`submit_to_pipeline`, `update_cluster`,
 * `send_cross_channel_message`, `ack_event`, `reply_to_event`) write
 * the system message and return immediately.
 */
import { findQuestionResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${text}` }],
    isError: true,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fire-and-forget shim: write a `kind='system'` outbound message
 * carrying { action, ...payload } in content. The host dispatches to
 * the matching delivery-action handler.
 */
function fireAction(action: string, payload: Record<string, unknown>): number {
  const id = generateId('pipe');
  const r = getSessionRouting();
  return writeMessageOut({
    id,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, ...payload }),
  });
}

/**
 * Request/response shim: write a `kind='system'` outbound message
 * with a questionId, poll messages_in for the matching response,
 * return the response result. Used for tools that need data back
 * from the host (consume_events, get_active_clusters, etc.).
 *
 * Default timeout 30s; pipeline round-trips are typically sub-second
 * (host responds inside the delivery loop's same tick), so 30s is a
 * generous safety net.
 */
async function callAction(
  action: string,
  payload: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  const questionId = generateId('pipe-q');
  const r = getSessionRouting();
  writeMessageOut({
    id: questionId,
    kind: 'system',
    platform_id: r.platform_id,
    channel_type: r.channel_type,
    thread_id: r.thread_id,
    content: JSON.stringify({ action, questionId, ...payload }),
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findQuestionResponse(questionId);
    if (response) {
      let parsed: { status?: string; result?: Record<string, unknown>; error?: string };
      try {
        parsed = JSON.parse(response.content);
      } catch {
        markCompleted([response.id]);
        return { ok: false, error: `pipeline ${action}: invalid response payload` };
      }
      markCompleted([response.id]);
      if (parsed.status === 'ok') {
        return { ok: true, result: parsed.result ?? {} };
      }
      const errMsg =
        typeof parsed.error === 'string'
          ? parsed.error
          : (parsed.result?.error as string) || `pipeline ${action}: error`;
      return { ok: false, error: errMsg };
    }
    await sleep(200);
  }
  return { ok: false, error: `pipeline ${action}: response timed out after ${timeoutMs}ms` };
}

// --- intake & cluster surface (step 8 actions) ---

export const submitToPipeline: McpToolDefinition = {
  tool: {
    name: 'submit_to_pipeline',
    description:
      'Submit a raw text observation to the pipeline for sanitiser processing. Fire-and-forget: returns once the intake event is queued, not when sanitisation completes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rawText: { type: 'string', description: 'Verbatim text from the source channel' },
        sourceContext: {
          type: 'object',
          description:
            'IntakeSourceContext — at minimum source_group + reason (see @core/types.ts).',
        },
        dedupeKey: {
          type: 'string',
          description: 'Optional dedupe key to suppress repeat submissions',
        },
      },
      required: ['rawText', 'sourceContext'],
    },
  },
  async handler(args) {
    const rawText = args.rawText as string;
    const sourceContext = args.sourceContext as Record<string, unknown> | undefined;
    if (!rawText || !sourceContext) return err('rawText and sourceContext are required');
    const seq = fireAction('pipeline_submit', {
      rawText,
      sourceContext,
      dedupeKey: (args.dedupeKey as string) || null,
    });
    log(`submit_to_pipeline: #${seq}`);
    return ok('Pipeline intake queued');
  },
};

export const getActiveClusters: McpToolDefinition = {
  tool: {
    name: 'get_active_clusters',
    description:
      'Fetch the active clusters and their summaries for the given source channels. Returns the host pipeline\'s view of what each cluster is currently about — used by the monitor task to relate new observations to ongoing activity.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourceChannels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Platform IDs of channels to query (e.g. "slack:CTEAM").',
        },
      },
      required: ['sourceChannels'],
    },
  },
  async handler(args) {
    const sourceChannels = args.sourceChannels as string[] | undefined;
    if (!Array.isArray(sourceChannels)) return err('sourceChannels must be an array of strings');
    const result = await callAction('pipeline_clusters_active', { sourceChannels });
    if (!result.ok) return err(result.error);
    return ok(JSON.stringify(result.result));
  },
};

export const updateCluster: McpToolDefinition = {
  tool: {
    name: 'update_cluster',
    description:
      'Upsert a cluster + optionally publish a routed candidate.* event from monitor classification facts. Fire-and-forget; the routed event lands in pipeline_events asynchronously.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourceChannel: { type: 'string' },
        clusterKey: { type: 'string' },
        summary: { type: 'string' },
        observationIds: { type: 'array', items: { type: 'integer' } },
        status: { type: 'string', description: 'active|resolved (optional)' },
        routing: {
          type: 'object',
          description: 'ClusterRoutingFacts — escalation_triggers, addressed_to, etc.',
        },
        sourceMessageId: { type: 'string', description: 'Optional source message id for thread routing.' },
      },
      required: ['sourceChannel', 'clusterKey', 'summary', 'observationIds'],
    },
  },
  async handler(args) {
    if (typeof args.sourceChannel !== 'string') return err('sourceChannel required');
    if (typeof args.clusterKey !== 'string') return err('clusterKey required');
    if (typeof args.summary !== 'string') return err('summary required');
    if (!Array.isArray(args.observationIds)) return err('observationIds must be an array');
    fireAction('pipeline_cluster_update', { ...args });
    return ok('Cluster update queued');
  },
};

export const reExtractObservation: McpToolDefinition = {
  tool: {
    name: 're_extract_observation',
    description:
      'Re-run sanitiser extraction for a given observation against a list of fields, returning the extracted values. Used by the solver / monitor when deeper detail is needed than the original sanitiser output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        observationId: { type: 'integer', description: 'observed_messages.id' },
        requestFields: { type: 'array', items: { type: 'string' } },
        model: { type: 'string', description: 'LLM model id (defaults to anthropic:haiku)' },
        sanitiserVersion: { type: 'string', description: 'Schema version (defaults to "1")' },
      },
      required: ['observationId', 'requestFields'],
    },
  },
  async handler(args) {
    if (typeof args.observationId !== 'number') return err('observationId required');
    if (!Array.isArray(args.requestFields)) return err('requestFields must be an array');
    const result = await callAction('pipeline_reextract', { ...args });
    if (!result.ok) return err(result.error);
    return ok(JSON.stringify(result.result));
  },
};

// --- cross-channel send (step 12) ---

export const sendCrossChannelMessage: McpToolDefinition = {
  tool: {
    name: 'send_cross_channel_message',
    description:
      'Send a reply that auto-routes to the source channel thread (always) and optionally to a target channel with a context header. Used by the responder/solver to deliver investigation conclusions across channels.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Message body' },
        targetChatJid: { type: 'string', description: 'Agent-chosen target channel platform_id' },
        contextEventId: {
          type: 'integer',
          description:
            'Pipeline event id this reply is responding to. The pipeline reads source_channel + source_message_id from the event payload.',
        },
      },
      required: ['text', 'targetChatJid', 'contextEventId'],
    },
  },
  async handler(args) {
    if (typeof args.text !== 'string' || !args.text) return err('text required');
    if (typeof args.targetChatJid !== 'string' || !args.targetChatJid) {
      return err('targetChatJid required');
    }
    if (typeof args.contextEventId !== 'number') return err('contextEventId required');
    fireAction('pipeline_send_cross_channel', { ...args });
    return ok('Cross-channel send queued');
  },
};

// --- events lifecycle (step 14 C2 actions) ---

export const publishEvent: McpToolDefinition = {
  tool: {
    name: 'publish_event',
    description:
      'Publish a pipeline event (observation.*, candidate.*, approved_reply.*, etc.). Returns the new event id and isNew flag (false on dedupe collision).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', description: 'Event type, e.g. "candidate.escalation"' },
        source_group: { type: 'string', description: 'Originating pipeline component name' },
        source_task_id: { type: 'string', description: 'Optional originating task id' },
        payload: { type: 'string', description: 'JSON-encoded event payload' },
        dedupe_key: { type: 'string', description: 'Optional dedupe key' },
        ttl_seconds: {
          type: 'integer',
          description: 'Optional TTL in seconds — auto-expires the event after this window',
        },
      },
      required: ['type', 'source_group', 'payload'],
    },
  },
  async handler(args) {
    if (typeof args.type !== 'string' || !args.type) return err('type required');
    if (typeof args.source_group !== 'string') return err('source_group required');
    if (typeof args.payload !== 'string') return err('payload (JSON string) required');
    const result = await callAction('pipeline_publish_event', { ...args });
    if (!result.ok) return err(result.error);
    return ok(JSON.stringify(result.result));
  },
};

export const consumeEvents: McpToolDefinition = {
  tool: {
    name: 'consume_events',
    description:
      'Atomically claim pending pipeline events of the given types for the named consumer. Returns the claimed events array; ack each via ack_event when processing completes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Event types or globs (e.g. ["observation.*"])',
        },
        claimed_by: { type: 'string', description: 'Consumer task id (e.g. "pipeline:monitor")' },
        limit: { type: 'integer', description: 'Max events to claim (default 10)' },
        skip_attempted_by_trivial: {
          type: 'boolean',
          description:
            'Trivial-answerer flag — when true, skips events the trivial-answerer already failed on once.',
        },
      },
      required: ['types', 'claimed_by'],
    },
  },
  async handler(args) {
    if (!Array.isArray(args.types)) return err('types must be an array of strings');
    if (typeof args.claimed_by !== 'string' || !args.claimed_by) {
      return err('claimed_by required');
    }
    const result = await callAction('pipeline_consume_events', { ...args });
    if (!result.ok) return err(result.error);
    return ok(JSON.stringify(result.result));
  },
};

export const ackEvent: McpToolDefinition = {
  tool: {
    name: 'ack_event',
    description:
      'Mark a pipeline event as processed. Status must be "done" or "failed". Optional note records the path taken (e.g. "auto-answered", "escalated to team channel").',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'integer' },
        status: { type: 'string', enum: ['done', 'failed'] },
        note: { type: 'string' },
      },
      required: ['event_id', 'status'],
    },
  },
  async handler(args) {
    if (typeof args.event_id !== 'number') return err('event_id required');
    if (args.status !== 'done' && args.status !== 'failed') {
      return err('status must be done|failed');
    }
    fireAction('pipeline_ack_event', { ...args });
    return ok(`Event ${args.event_id} acked as ${args.status}`);
  },
};

export const replyToEvent: McpToolDefinition = {
  tool: {
    name: 'reply_to_event',
    description:
      'Post a reply to the source thread of a pipeline event. The pipeline resolves source_channel + source_message_id from the event payload and delivers via the channel adapter; also marks replied_at so the silent-fail detector knows the user got an answer.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'integer' },
        text: { type: 'string', description: 'Reply text — verbatim, no formatting changes' },
      },
      required: ['event_id', 'text'],
    },
  },
  async handler(args) {
    if (typeof args.event_id !== 'number') return err('event_id required');
    if (typeof args.text !== 'string' || !args.text) return err('text required');
    fireAction('pipeline_reply_to_event', { ...args });
    return ok('Reply queued');
  },
};

registerTools([
  submitToPipeline,
  getActiveClusters,
  updateCluster,
  reExtractObservation,
  sendCrossChannelMessage,
  publishEvent,
  consumeEvents,
  ackEvent,
  replyToEvent,
]);
