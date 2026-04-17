import { describe, it, expect } from 'vitest';

import {
  NANOCLAW_TOOL_META,
  deriveNanoclawTools,
  type ToolMetadata,
} from './tool-metadata.js';

describe('deriveNanoclawTools (pure helper)', () => {
  const sampleMeta: Record<string, ToolMetadata> = {
    send_message: { management: false },
    schedule_task: { management: true },
    list_tasks: { management: false },
    register_group: { management: true },
  };

  it('9.1 — isScheduledTask=true excludes management tools', () => {
    const result = deriveNanoclawTools(sampleMeta, true).sort();
    expect(result).toEqual(['list_tasks', 'send_message']);
  });

  it('9.2 — isScheduledTask=false includes all tools', () => {
    const result = deriveNanoclawTools(sampleMeta, false).sort();
    expect(result).toEqual([
      'list_tasks',
      'register_group',
      'schedule_task',
      'send_message',
    ]);
  });

  it('9.3 — empty map returns empty list regardless of flag', () => {
    expect(deriveNanoclawTools({}, true)).toEqual([]);
    expect(deriveNanoclawTools({}, false)).toEqual([]);
  });
});

describe('NANOCLAW_TOOL_META regression guards', () => {
  // These tests lock in today's effective policy. Changing them requires
  // conscious acknowledgement that the defense-in-depth subset is changing.

  const EXPECTED_SCHEDULED_SUBSET = [
    'ack_event',
    'consume_events',
    'get_active_clusters',
    'list_tasks',
    'publish_event',
    're_extract_observation',
    'read_chat_messages',
    'send_cross_channel_message',
    'send_message',
    'submit_to_pipeline',
    'update_cluster',
  ].sort();

  const EXPECTED_MANAGEMENT_ONLY = [
    'cancel_task',
    'pause_task',
    'register_group',
    'resume_task',
    'schedule_task',
    'update_group',
    'update_task',
  ].sort();

  it('9.4 — scheduled-task allowlist derived from NANOCLAW_TOOL_META matches expected subset', () => {
    const derived = deriveNanoclawTools(NANOCLAW_TOOL_META, true).sort();
    expect(derived).toEqual(EXPECTED_SCHEDULED_SUBSET);
  });

  it('9.5 — non-scheduled allowlist derived from NANOCLAW_TOOL_META is the union of scheduled + management', () => {
    const derived = deriveNanoclawTools(NANOCLAW_TOOL_META, false).sort();
    const expected = [
      ...EXPECTED_SCHEDULED_SUBSET,
      ...EXPECTED_MANAGEMENT_ONLY,
    ].sort();
    expect(derived).toEqual(expected);
  });

  it('9.6 — every entry in NANOCLAW_TOOL_META has the expected shape', () => {
    for (const [name, meta] of Object.entries(NANOCLAW_TOOL_META)) {
      expect(typeof name).toBe('string');
      expect(typeof meta.management).toBe('boolean');
    }
  });
});
