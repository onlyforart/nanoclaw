/**
 * §4.5 step 14 commit 3 — pipeline mcp-tools registration shape.
 *
 * Validates the container-side bridge tool definitions match the
 * tool-metadata.ts catalogue (one row per declared pipeline tool;
 * no drift). Handler behaviour is exercised end-to-end by the
 * pipeline integration smoke (step 17) — these tests cover the
 * static surface only.
 */
import { describe, it, expect } from 'bun:test';

import {
  ackEvent,
  consumeEvents,
  getActiveClusters,
  publishEvent,
  reExtractObservation,
  replyToEvent,
  sendCrossChannelMessage,
  submitToPipeline,
  updateCluster,
} from './pipeline.js';
import { NANOCLAW_TOOL_META } from '../tool-metadata.js';

describe('pipeline.ts — tool definitions', () => {
  const all = [
    submitToPipeline,
    getActiveClusters,
    updateCluster,
    reExtractObservation,
    sendCrossChannelMessage,
    publishEvent,
    consumeEvents,
    ackEvent,
    replyToEvent,
  ];

  it('PT1 — exports 9 tools', () => {
    expect(all).toHaveLength(9);
  });

  it('PT2 — every tool name appears in NANOCLAW_TOOL_META', () => {
    for (const def of all) {
      expect(NANOCLAW_TOOL_META[def.tool.name]).toBeDefined();
    }
  });

  it('PT3 — each tool has a non-empty description and inputSchema', () => {
    for (const def of all) {
      expect(typeof def.tool.description).toBe('string');
      expect((def.tool.description ?? '').length).toBeGreaterThan(0);
      expect(def.tool.inputSchema).toBeDefined();
      expect(typeof def.handler).toBe('function');
    }
  });

  it('PT4 — covers all pipeline-related tools in tool-metadata.ts', () => {
    const pipelineToolNames = [
      'submit_to_pipeline',
      'get_active_clusters',
      'update_cluster',
      're_extract_observation',
      'send_cross_channel_message',
      'publish_event',
      'consume_events',
      'ack_event',
      'reply_to_event',
    ];
    const exportedNames = all.map((d) => d.tool.name).sort();
    expect(exportedNames).toEqual(pipelineToolNames.sort());
  });
});
