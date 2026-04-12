import { beforeEach, describe, expect, it } from 'vitest';

import {
  recordIpcDelivery,
  hasRecentIpcDelivery,
  _resetIpcDeliveriesForTests,
} from './ipc.js';

describe('IPC delivery dedup tracking', () => {
  beforeEach(() => {
    _resetIpcDeliveriesForTests();
  });

  it('returns false when no delivery has been recorded', () => {
    expect(hasRecentIpcDelivery('slack:C123', 'some text')).toBe(false);
  });

  it('returns true when same chatJid and text were delivered', () => {
    recordIpcDelivery('slack:C123', 'hello world');
    expect(hasRecentIpcDelivery('slack:C123', 'hello world')).toBe(true);
  });

  it('returns false for same chatJid but different text', () => {
    recordIpcDelivery('slack:C123', 'hello world');
    expect(hasRecentIpcDelivery('slack:C123', 'different text')).toBe(false);
  });

  it('returns false for different chatJid with same text', () => {
    recordIpcDelivery('slack:C123', 'hello world');
    expect(hasRecentIpcDelivery('slack:C456', 'hello world')).toBe(false);
  });

  it('returns false after the TTL has expired', () => {
    recordIpcDelivery('slack:C123', 'hello world');
    expect(hasRecentIpcDelivery('slack:C123', 'hello world', 0)).toBe(false);
  });

  it('tracks multiple deliveries to the same chatJid', () => {
    recordIpcDelivery('slack:C123', 'first message');
    recordIpcDelivery('slack:C123', 'second message');
    expect(hasRecentIpcDelivery('slack:C123', 'first message')).toBe(true);
    expect(hasRecentIpcDelivery('slack:C123', 'second message')).toBe(true);
    expect(hasRecentIpcDelivery('slack:C123', 'third message')).toBe(false);
  });

  it('clears all entries on reset', () => {
    recordIpcDelivery('slack:C123', 'hello');
    _resetIpcDeliveriesForTests();
    expect(hasRecentIpcDelivery('slack:C123', 'hello')).toBe(false);
  });
});
