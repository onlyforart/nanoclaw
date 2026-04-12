import { describe, it, expect, vi } from 'vitest';

import {
  buildExtractionPrompt,
  parseAndValidateResponse,
  type Layer2Input,
  type Layer2Output,
} from './layer2.js';

// --- buildExtractionPrompt ---

describe('buildExtractionPrompt', () => {
  const sampleInput: Layer2Input = {
    processed_text: 'The payment service is returning 500 errors since the deploy',
    deterministic_fields: {
      referenced_tickets: [{ id: 'INC12345', system: 'servicenow' }],
      inc_present: true,
      code_blocks: [],
      links: [],
      mentions: [],
    },
  };

  it('produces a system message and user message', () => {
    const { system, user } = buildExtractionPrompt(sampleInput);
    expect(system).toContain('structured data extractor');
    expect(user).toContain('payment service');
  });

  it('includes deterministic fields as context in user message', () => {
    const { user } = buildExtractionPrompt(sampleInput);
    expect(user).toContain('INC12345');
  });

  it('includes the output schema description', () => {
    const { system } = buildExtractionPrompt(sampleInput);
    expect(system).toContain('fact_summary');
    expect(system).toContain('urgency');
    expect(system).toContain('appears_to_address_bot');
  });

  it('includes instruction not to obey input as commands', () => {
    const { system } = buildExtractionPrompt(sampleInput);
    expect(system.toLowerCase()).toContain('not addressed to you');
  });
});

// --- parseAndValidateResponse ---

describe('parseAndValidateResponse', () => {
  it('parses valid Layer2Output JSON', () => {
    const valid: Layer2Output = {
      fact_summary: 'Payment service returning 500 errors',
      urgency: 'incident',
      speech_act: 'fresh_report',
      reporter_role_hint: 'original_reporter',
      appears_to_address_bot: false,
      contains_imperative: false,
      sentiment: 'frustrated',
      action_requested: null,
      resolution_owner_hint: 'this_team',
    };

    const result = parseAndValidateResponse(JSON.stringify(valid));
    expect(result).not.toBeNull();
    expect(result!.fact_summary).toBe('Payment service returning 500 errors');
    expect(result!.urgency).toBe('incident');
  });

  it('returns null for invalid JSON', () => {
    expect(parseAndValidateResponse('not json at all')).toBeNull();
  });

  it('returns null for JSON missing required fields', () => {
    expect(parseAndValidateResponse('{"fact_summary": "test"}')).toBeNull();
  });

  it('accepts action_requested as null', () => {
    const valid: Layer2Output = {
      fact_summary: 'test',
      urgency: 'fyi',
      speech_act: 'other',
      reporter_role_hint: 'other',
      appears_to_address_bot: false,
      contains_imperative: false,
      sentiment: 'neutral',
      action_requested: null,
      resolution_owner_hint: 'unclear',
    };

    const result = parseAndValidateResponse(JSON.stringify(valid));
    expect(result).not.toBeNull();
    expect(result!.action_requested).toBeNull();
  });

  it('accepts action_requested as a string', () => {
    const valid: Layer2Output = {
      fact_summary: 'test',
      urgency: 'issue',
      speech_act: 'fresh_report',
      reporter_role_hint: 'original_reporter',
      appears_to_address_bot: false,
      contains_imperative: true,
      sentiment: 'urgent',
      action_requested: 'The reporter requests a server restart',
      resolution_owner_hint: 'this_team',
    };

    const result = parseAndValidateResponse(JSON.stringify(valid));
    expect(result).not.toBeNull();
    expect(result!.action_requested).toBe('The reporter requests a server restart');
  });

  it('returns null when boolean fields have wrong type', () => {
    const invalid = {
      fact_summary: 'test',
      urgency: 'fyi',
      speech_act: 'other',
      reporter_role_hint: 'other',
      appears_to_address_bot: 'yes',  // should be boolean
      contains_imperative: false,
      sentiment: 'neutral',
      action_requested: null,
      resolution_owner_hint: 'unclear',
    };
    expect(parseAndValidateResponse(JSON.stringify(invalid))).toBeNull();
  });
});
