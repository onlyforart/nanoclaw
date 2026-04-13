import { describe, it, expect } from 'vitest';

import {
  stripSpecialTokens,
  repairJsonString,
  sanitizeToolArgs,
} from './sanitize-tool-args.js';

describe('stripSpecialTokens', () => {
  it('returns clean strings unchanged', () => {
    expect(stripSpecialTokens('candidate.escalation')).toBe(
      'candidate.escalation',
    );
  });

  it('strips <|" prefix and suffix', () => {
    expect(stripSpecialTokens('<|"candidate.escalation<|"')).toBe(
      'candidate.escalation',
    );
  });

  it('strips <|im_start|> and <|im_end|> markers', () => {
    expect(stripSpecialTokens('<|im_start|>hello<|im_end|>')).toBe('hello');
  });

  it('strips <|endoftext|>', () => {
    expect(stripSpecialTokens('some text<|endoftext|>')).toBe('some text');
  });

  it('strips multiple markers in one string', () => {
    expect(
      stripSpecialTokens('<|"obs.*<|"<|im_end|>'),
    ).toBe('obs.*');
  });

  it('handles empty string', () => {
    expect(stripSpecialTokens('')).toBe('');
  });
});

describe('repairJsonString', () => {
  it('returns non-JSON strings after stripping tokens', () => {
    expect(repairJsonString('<|"candidate.escalation<|"')).toBe(
      'candidate.escalation',
    );
  });

  it('returns valid JSON unchanged', () => {
    const json = '{"summary":"test","ids":[1,2]}';
    expect(repairJsonString(json)).toBe(json);
  });

  it('strips special tokens from JSON and validates', () => {
    const garbled = '{"summary":"<|im_start|>test<|im_end|>"}';
    expect(repairJsonString(garbled)).toBe('{"summary":"test"}');
  });

  it('strips trailing garbage after JSON', () => {
    const garbled = '{"summary":"test"}<|endoftext|>extra';
    expect(repairJsonString(garbled)).toBe('{"summary":"test"}');
  });

  it('balances unclosed braces', () => {
    const unclosed = '{"summary":"test"';
    expect(repairJsonString(unclosed)).toBe('{"summary":"test"}');
  });

  it('balances unclosed brackets', () => {
    const unclosed = '["a","b"';
    expect(repairJsonString(unclosed)).toBe('["a","b"]');
  });

  it('balances nested unclosed structures', () => {
    const unclosed = '{"data":["a","b"';
    expect(repairJsonString(unclosed)).toBe('{"data":["a","b"]}');
  });

  it('returns cleaned string when recovery fails', () => {
    const hopeless = '{totally broken json :::';
    expect(repairJsonString(hopeless)).toBe(hopeless);
  });
});

describe('sanitizeToolArgs', () => {
  it('cleans string values', () => {
    const result = sanitizeToolArgs({
      event_types: ['<|"candidate.escalation<|"'],
      claimed_by: 'pipeline:solver',
    });
    expect(result.event_types).toEqual(['candidate.escalation']);
    expect(result.claimed_by).toBe('pipeline:solver');
  });

  it('cleans JSON string values', () => {
    const result = sanitizeToolArgs({
      payload: '{"summary":"test"}<|endoftext|>',
    });
    expect(result.payload).toBe('{"summary":"test"}');
  });

  it('preserves non-string values', () => {
    const result = sanitizeToolArgs({
      limit: 10,
      verbose: true,
      data: null,
    });
    expect(result).toEqual({ limit: 10, verbose: true, data: null });
  });

  it('does not mutate the input', () => {
    const input = { text: '<|"hello<|"' };
    const result = sanitizeToolArgs(input);
    expect(input.text).toBe('<|"hello<|"');
    expect(result.text).toBe('hello');
  });
});
