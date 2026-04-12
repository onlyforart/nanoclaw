import { describe, it, expect } from 'vitest';

import {
  validateSchema,
  enforceFieldCaps,
  validateEnums,
  quarantine,
  postProcess,
  type SanitiserSchema,
} from './layer3.js';

// Minimal schema for testing
const TEST_SCHEMA: SanitiserSchema = {
  version: 1,
  fields: {
    fact_summary: { type: 'string', required: true, max_length: 200 },
    urgency: {
      type: 'enum',
      required: true,
      values: ['fyi', 'question', 'issue', 'incident', 'other'],
      open: true,
    },
    appears_to_address_bot: { type: 'boolean', required: true },
    contains_imperative: { type: 'boolean', required: true },
    action_requested: {
      type: 'string',
      required: false,
      nullable: true,
      max_length: 150,
    },
  },
};

// --- validateSchema ---

describe('validateSchema', () => {
  it('passes valid input', () => {
    const result = validateSchema(
      {
        fact_summary: 'test',
        urgency: 'issue',
        appears_to_address_bot: false,
        contains_imperative: true,
        action_requested: null,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it('fails on missing required field', () => {
    const result = validateSchema(
      {
        fact_summary: 'test',
        // urgency missing
        appears_to_address_bot: false,
        contains_imperative: true,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('urgency');
  });

  it('fails on wrong type for boolean field', () => {
    const result = validateSchema(
      {
        fact_summary: 'test',
        urgency: 'issue',
        appears_to_address_bot: 'yes',
        contains_imperative: true,
        action_requested: null,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it('fails on wrong type for string field', () => {
    const result = validateSchema(
      {
        fact_summary: 123,
        urgency: 'issue',
        appears_to_address_bot: false,
        contains_imperative: true,
        action_requested: null,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(false);
  });

  it('allows nullable fields to be null', () => {
    const result = validateSchema(
      {
        fact_summary: 'test',
        urgency: 'fyi',
        appears_to_address_bot: false,
        contains_imperative: false,
        action_requested: null,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });

  it('allows nullable fields to be absent', () => {
    const result = validateSchema(
      {
        fact_summary: 'test',
        urgency: 'fyi',
        appears_to_address_bot: false,
        contains_imperative: false,
      },
      TEST_SCHEMA,
    );
    expect(result.valid).toBe(true);
  });
});

// --- enforceFieldCaps ---

describe('enforceFieldCaps', () => {
  it('truncates strings over the cap', () => {
    const result = enforceFieldCaps(
      { fact_summary: 'x'.repeat(300), action_requested: 'y'.repeat(200) },
      { fact_summary: 200, action_requested: 150 },
    );
    expect((result.fact_summary as string).length).toBe(200);
    expect((result.action_requested as string).length).toBe(150);
  });

  it('leaves strings under the cap unchanged', () => {
    const result = enforceFieldCaps(
      { fact_summary: 'short' },
      { fact_summary: 200 },
    );
    expect(result.fact_summary).toBe('short');
  });

  it('does not touch non-string fields', () => {
    const result = enforceFieldCaps(
      { fact_summary: 'test', urgency: 'issue', appears_to_address_bot: true },
      { fact_summary: 200 },
    );
    expect(result.appears_to_address_bot).toBe(true);
    expect(result.urgency).toBe('issue');
  });

  it('handles null values', () => {
    const result = enforceFieldCaps(
      { action_requested: null },
      { action_requested: 150 },
    );
    expect(result.action_requested).toBeNull();
  });
});

// --- validateEnums ---

describe('validateEnums', () => {
  it('passes known values', () => {
    const result = validateEnums(
      { urgency: 'issue' },
      { urgency: ['fyi', 'question', 'issue', 'incident', 'other'] },
    );
    expect(result.valid).toBe(true);
    expect(result.unknownValues).toHaveLength(0);
  });

  it('passes unknown values but reports them (open enums)', () => {
    const result = validateEnums(
      { urgency: 'critical' },
      { urgency: ['fyi', 'question', 'issue', 'incident', 'other'] },
    );
    expect(result.valid).toBe(true);
    expect(result.unknownValues).toHaveLength(1);
    expect(result.unknownValues[0].field).toBe('urgency');
    expect(result.unknownValues[0].value).toBe('critical');
  });

  it('fails on non-string enum values', () => {
    const result = validateEnums(
      { urgency: 42 },
      { urgency: ['fyi', 'question', 'issue'] },
    );
    expect(result.valid).toBe(false);
  });
});

// --- quarantine ---

describe('quarantine', () => {
  it('returns quarantined output with reason', () => {
    const result = quarantine('invalid schema');
    expect(result.quarantined).toBe(true);
    expect(result.sanitised_json).toBeNull();
    expect(result.flags).toContain('schema_invalid');
    expect(result.flags).toContain('invalid schema');
  });
});

// --- postProcess ---

describe('postProcess', () => {
  const validLayer2 = JSON.stringify({
    fact_summary: 'Payment service returning 500 errors',
    urgency: 'incident',
    speech_act: 'fresh_report',
    reporter_role_hint: 'original_reporter',
    appears_to_address_bot: false,
    contains_imperative: false,
    sentiment: 'frustrated',
    action_requested: null,
    resolution_owner_hint: 'this_team',
  });

  const layer1 = {
    sender_id: 'U123',
    channel_id: 'C456',
    thread_ts: null,
    timestamp: '2024-06-01T10:00:00.000Z',
    referenced_tickets: [{ id: 'INC12345', system: 'servicenow' }],
    inc_present: true,
    code_blocks: [],
    links: [],
    mentions: [],
    is_channel_join: false,
    is_bot_message: false,
    message_length: 50,
    processed_text: 'Payment service returning 500 errors',
    filtered: false,
  };

  it('produces valid output for well-formed input', () => {
    const result = postProcess({ layer1, layer2Raw: validLayer2 }, TEST_SCHEMA);
    expect(result.quarantined).toBe(false);
    expect(result.sanitised_json).not.toBeNull();
    expect(result.flags).toHaveLength(0);
  });

  it('quarantines invalid JSON', () => {
    const result = postProcess({ layer1, layer2Raw: 'not json' }, TEST_SCHEMA);
    expect(result.quarantined).toBe(true);
    expect(result.sanitised_json).toBeNull();
  });

  it('quarantines JSON with missing required fields', () => {
    const result = postProcess(
      { layer1, layer2Raw: '{"fact_summary":"test"}' },
      TEST_SCHEMA,
    );
    expect(result.quarantined).toBe(true);
  });

  it('truncates over-length string fields', () => {
    const overLength = JSON.stringify({
      fact_summary: 'x'.repeat(300),
      urgency: 'incident',
      speech_act: 'fresh_report',
      reporter_role_hint: 'original_reporter',
      appears_to_address_bot: false,
      contains_imperative: false,
      sentiment: 'neutral',
      action_requested: null,
      resolution_owner_hint: 'this_team',
    });
    const result = postProcess({ layer1, layer2Raw: overLength }, TEST_SCHEMA);
    expect(result.quarantined).toBe(false);
    const json = result.sanitised_json as Record<string, unknown>;
    expect((json.fact_summary as string).length).toBeLessThanOrEqual(200);
  });

  it('flags unknown enum values but does not quarantine', () => {
    const unknownEnum = JSON.stringify({
      fact_summary: 'test',
      urgency: 'critical_new_value',
      speech_act: 'fresh_report',
      reporter_role_hint: 'original_reporter',
      appears_to_address_bot: false,
      contains_imperative: false,
      sentiment: 'neutral',
      action_requested: null,
      resolution_owner_hint: 'this_team',
    });
    const result = postProcess({ layer1, layer2Raw: unknownEnum }, TEST_SCHEMA);
    expect(result.quarantined).toBe(false);
    expect(result.flags).toContain('unknown_enum_value');
  });

  it('includes layer1 fields in the combined output', () => {
    const result = postProcess({ layer1, layer2Raw: validLayer2 }, TEST_SCHEMA);
    const json = result.sanitised_json as Record<string, unknown>;
    expect(json.sender_id).toBe('U123');
    expect(json.inc_present).toBe(true);
  });
});
