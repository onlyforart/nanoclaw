/**
 * Tests for the per-wiring agent-settings env helpers — K.1.f step 9.0
 * Commit 3.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { envIntOr, maxToolRoundsOr, timeoutMsOr } from './wiring-env.js';

afterEach(() => {
  delete process.env.NANOCLAW_TEST;
  delete process.env.NANOCLAW_MAX_TOOL_ROUNDS;
  delete process.env.NANOCLAW_TIMEOUT_MS;
});

describe('envIntOr', () => {
  it('WE-INT-1 — returns fallback when env var is unset', () => {
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(42);
  });

  it('WE-INT-2 — returns fallback when env var is empty string', () => {
    process.env.NANOCLAW_TEST = '';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(42);
  });

  it('WE-INT-3 — returns parsed value when env var is a positive integer', () => {
    process.env.NANOCLAW_TEST = '99';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(99);
  });

  it('WE-INT-4 — preserves zero (semantic value, not "no override")', () => {
    process.env.NANOCLAW_TEST = '0';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(0);
  });

  it('WE-INT-5 — falls back when value is non-numeric (operator typo)', () => {
    process.env.NANOCLAW_TEST = 'abc';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(42);
  });

  it('WE-INT-6 — falls back when value is negative', () => {
    process.env.NANOCLAW_TEST = '-5';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(42);
  });

  it('WE-INT-7 — falls back when value is a float (no silent truncation)', () => {
    process.env.NANOCLAW_TEST = '1.5';
    expect(envIntOr('NANOCLAW_TEST', 42)).toBe(42);
  });
});

describe('maxToolRoundsOr / timeoutMsOr', () => {
  it('reads NANOCLAW_MAX_TOOL_ROUNDS env var', () => {
    process.env.NANOCLAW_MAX_TOOL_ROUNDS = '50';
    expect(maxToolRoundsOr(15)).toBe(50);
  });

  it('reads NANOCLAW_TIMEOUT_MS env var', () => {
    process.env.NANOCLAW_TIMEOUT_MS = '300000';
    expect(timeoutMsOr(60_000)).toBe(300_000);
  });

  it('falls back when env unset', () => {
    expect(maxToolRoundsOr(15)).toBe(15);
    expect(timeoutMsOr(60_000)).toBe(60_000);
  });
});
