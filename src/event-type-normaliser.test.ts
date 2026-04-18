import { describe, it, expect } from 'vitest';
import { normaliseEventType, normaliseEventTypes } from './event-type-normaliser.js';

describe('normaliseEventType', () => {
  it('passes through a clean glob unchanged', () => {
    expect(normaliseEventType('observation.*')).toEqual({
      normalised: 'observation.*',
      strippedChars: '',
    });
  });

  it('passes through a clean literal event type unchanged', () => {
    expect(normaliseEventType('candidate.question')).toEqual({
      normalised: 'candidate.question',
      strippedChars: '',
    });
  });

  it('strips surrounding pipe delimiters (gemma4 hallucination)', () => {
    // Real observed bug: model produces ["|observation.*|"] instead of
    // ["observation.*"]. consumeEvents treats the literal pipes as part
    // of the pattern and matches zero rows.
    expect(normaliseEventType('|observation.*|')).toEqual({
      normalised: 'observation.*',
      strippedChars: '|',
    });
  });

  it('strips surrounding forward-slash delimiters (regex syntax)', () => {
    expect(normaliseEventType('/observation.*/')).toEqual({
      normalised: 'observation.*',
      strippedChars: '/',
    });
  });

  it('strips surrounding double quotes', () => {
    expect(normaliseEventType('"observation.*"')).toEqual({
      normalised: 'observation.*',
      strippedChars: '"',
    });
  });

  it('strips surrounding backticks', () => {
    expect(normaliseEventType('`observation.*`')).toEqual({
      normalised: 'observation.*',
      strippedChars: '`',
    });
  });

  it('trims leading and trailing whitespace', () => {
    expect(normaliseEventType('  observation.*  ')).toEqual({
      normalised: 'observation.*',
      strippedChars: ' ',
    });
  });

  it('strips nested noise (trim + pipes + quotes)', () => {
    expect(normaliseEventType(' "|observation.*|" ')).toEqual({
      normalised: 'observation.*',
      strippedChars: ' "|',
    });
  });

  it('does NOT strip internal pipes (they are part of the type)', () => {
    // Hypothetical — event type with a pipe mid-string should survive.
    expect(normaliseEventType('obs|weird')).toEqual({
      normalised: 'obs|weird',
      strippedChars: '',
    });
  });

  it('does NOT strip trailing punctuation that is part of the glob', () => {
    expect(normaliseEventType('observation.*')).toEqual({
      normalised: 'observation.*',
      strippedChars: '',
    });
  });

  it('returns null for inputs that normalise to empty', () => {
    expect(normaliseEventType('')).toEqual({
      normalised: null,
      strippedChars: '',
    });
    expect(normaliseEventType('|||')).toEqual({
      normalised: null,
      strippedChars: '|',
    });
    expect(normaliseEventType('   ')).toEqual({
      normalised: null,
      strippedChars: ' ',
    });
  });

  it('is stable under repeated application (idempotent)', () => {
    const once = normaliseEventType('|observation.*|').normalised!;
    const twice = normaliseEventType(once).normalised!;
    expect(twice).toBe(once);
  });
});

describe('normaliseEventTypes', () => {
  it('maps over an array and drops empty results', () => {
    const result = normaliseEventTypes([
      '|observation.*|',
      '"candidate.question"',
      '',
      '  candidate.escalation  ',
      '|||',
    ]);
    expect(result.normalised).toEqual([
      'observation.*',
      'candidate.question',
      'candidate.escalation',
    ]);
    expect(result.anyStripped).toBe(true);
  });

  it('reports anyStripped=false when no changes needed', () => {
    const result = normaliseEventTypes(['observation.*', 'candidate.question']);
    expect(result.normalised).toEqual(['observation.*', 'candidate.question']);
    expect(result.anyStripped).toBe(false);
  });

  it('deduplicates after normalisation', () => {
    // If two entries normalise to the same type, keep one (prevents
    // duplicate matches in the downstream SQL IN/OR clause).
    const result = normaliseEventTypes(['observation.*', '|observation.*|']);
    expect(result.normalised).toEqual(['observation.*']);
  });

  it('preserves original order when no duplicates', () => {
    const result = normaliseEventTypes(['a.b', 'c.d', 'e.f']);
    expect(result.normalised).toEqual(['a.b', 'c.d', 'e.f']);
  });

  it('returns empty array when every element normalises to null', () => {
    const result = normaliseEventTypes(['', '|||', '   ']);
    expect(result.normalised).toEqual([]);
    expect(result.anyStripped).toBe(true);
  });
});
