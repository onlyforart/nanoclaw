import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadEvalSet } from './harness.js';
import {
  scoreLayer1,
  scoreLayer2,
  aggregateScores,
} from './scoring.js';

// --- loadEvalSet ---

describe('loadEvalSet', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-set-'));
  });

  it('loads all JSON files from a directory', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'case1.json'),
      JSON.stringify({
        id: 'case-1',
        description: 'test case 1',
        tags: ['basic'],
        input: { raw_text: 'hello' },
        expected_layer1: {},
        expected_layer2: {},
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'case2.json'),
      JSON.stringify({
        id: 'case-2',
        description: 'test case 2',
        tags: ['basic'],
        input: { raw_text: 'world' },
        expected_layer1: {},
        expected_layer2: {},
      }),
    );

    const cases = loadEvalSet(tmpDir);
    expect(cases).toHaveLength(2);
  });

  it('ignores non-JSON files', () => {
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# notes');
    fs.writeFileSync(
      path.join(tmpDir, 'case.json'),
      JSON.stringify({
        id: 'c1',
        description: 'x',
        tags: [],
        input: { raw_text: 'x' },
        expected_layer1: {},
        expected_layer2: {},
      }),
    );

    const cases = loadEvalSet(tmpDir);
    expect(cases).toHaveLength(1);
  });

  it('returns empty array for empty directory', () => {
    expect(loadEvalSet(tmpDir)).toEqual([]);
  });
});

// --- scoreLayer1 ---

describe('scoreLayer1', () => {
  it('scores boolean fields by exact match', () => {
    const result = scoreLayer1(
      { inc_present: true, is_channel_join: false },
      { inc_present: true, is_channel_join: false },
    );
    expect(result.inc_present).toBe(true);
    expect(result.is_channel_join).toBe(true);
  });

  it('marks boolean mismatch as false', () => {
    const result = scoreLayer1(
      { inc_present: false },
      { inc_present: true },
    );
    expect(result.inc_present).toBe(false);
  });

  it('scores array fields by set equality', () => {
    const result = scoreLayer1(
      { referenced_tickets: ['INC123', 'CHG456'] },
      { referenced_tickets: ['CHG456', 'INC123'] },
    );
    expect(result.referenced_tickets).toBe(true);
  });

  it('marks array mismatch as false', () => {
    const result = scoreLayer1(
      { referenced_tickets: ['INC123'] },
      { referenced_tickets: ['INC123', 'INC456'] },
    );
    expect(result.referenced_tickets).toBe(false);
  });

  it('skips fields not present in expected (don\'t care)', () => {
    const result = scoreLayer1(
      { inc_present: true, is_channel_join: false, is_bot_message: true },
      { inc_present: true },
    );
    // Only inc_present should be scored
    expect(result.inc_present).toBe(true);
    expect(result.is_channel_join).toBeUndefined();
  });
});

// --- scoreLayer2 ---

describe('scoreLayer2', () => {
  it('scores boolean fields by exact match', () => {
    const result = scoreLayer2(
      { appears_to_address_bot: true, contains_imperative: false },
      { appears_to_address_bot: true, contains_imperative: false },
    );
    expect(result.appears_to_address_bot).toBe(true);
    expect(result.contains_imperative).toBe(true);
  });

  it('scores enum fields by exact match', () => {
    const result = scoreLayer2(
      { urgency: 'incident', speech_act: 'fresh_report' },
      { urgency: 'incident', speech_act: 'fresh_report' },
    );
    expect(result.urgency).toBe(true);
    expect(result.speech_act).toBe(true);
  });

  it('marks enum mismatch as false', () => {
    const result = scoreLayer2(
      { urgency: 'other' },
      { urgency: 'incident' },
    );
    expect(result.urgency).toBe(false);
  });

  it('scores string fields by substring containment', () => {
    const result = scoreLayer2(
      { fact_summary: 'The production database is experiencing high latency' },
      { fact_summary: 'database' },
    );
    expect(result.fact_summary).toBe(true);
  });

  it('marks string field as false when substring not found', () => {
    const result = scoreLayer2(
      { fact_summary: 'Server is down' },
      { fact_summary: 'database' },
    );
    expect(result.fact_summary).toBe(false);
  });

  it('scores null action_requested correctly', () => {
    const result = scoreLayer2(
      { action_requested: null },
      { action_requested: null },
    );
    expect(result.action_requested).toBe(true);
  });

  it('marks action_requested mismatch when expected null but got value', () => {
    const result = scoreLayer2(
      { action_requested: 'Please restart the server' },
      { action_requested: null },
    );
    expect(result.action_requested).toBe(false);
  });

  it('skips fields not present in expected (don\'t care)', () => {
    const result = scoreLayer2(
      { urgency: 'incident', sentiment: 'frustrated' },
      { urgency: 'incident' },
    );
    expect(result.urgency).toBe(true);
    expect(result.sentiment).toBeUndefined();
  });
});

// --- aggregateScores ---

describe('aggregateScores', () => {
  it('computes per-field accuracy across cases', () => {
    const results = [
      { caseId: 'c1', scores: { urgency: true, sentiment: true } },
      { caseId: 'c2', scores: { urgency: false, sentiment: true } },
    ];

    const agg = aggregateScores(results);
    expect(agg.fieldAccuracy.urgency).toBe(0.5);
    expect(agg.fieldAccuracy.sentiment).toBe(1.0);
  });

  it('computes overall pass rate', () => {
    const results = [
      { caseId: 'c1', scores: { urgency: true, sentiment: true } },
      { caseId: 'c2', scores: { urgency: false, sentiment: true } },
      { caseId: 'c3', scores: { urgency: true, sentiment: true } },
    ];

    const agg = aggregateScores(results);
    // c1 all pass, c2 has a fail, c3 all pass → 2/3
    expect(agg.casePassRate).toBeCloseTo(2 / 3);
  });

  it('handles empty results', () => {
    const agg = aggregateScores([]);
    expect(agg.casePassRate).toBe(1); // vacuously true
    expect(agg.fieldAccuracy).toEqual({});
  });
});
