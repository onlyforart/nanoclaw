import { describe, it, expect, vi } from 'vitest';

import {
  runDeliveryVerification,
  verifyDeliveryFromReplies,
} from './delivery-verification.js';

describe('verifyDeliveryFromReplies', () => {
  it('V.1 — finds exact text match and returns delivered=true', () => {
    const replies = [
      { ts: '1', text: 'something else' },
      { ts: '2', text: 'approved text here' },
    ];
    const result = verifyDeliveryFromReplies(replies, 'approved text here');
    expect(result.delivered).toBe(true);
  });

  it('V.2 — trims whitespace on both sides', () => {
    const replies = [{ ts: '1', text: '  approved text here  ' }];
    const result = verifyDeliveryFromReplies(replies, 'approved text here');
    expect(result.delivered).toBe(true);
  });

  it('V.3 — null replies → undelivered with reason', () => {
    const result = verifyDeliveryFromReplies(null, 'x');
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/null/);
  });

  it('V.4 — empty thread → undelivered with reason', () => {
    const result = verifyDeliveryFromReplies([], 'x');
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/empty/);
  });

  it('V.5 — no matching text → undelivered with count', () => {
    const replies = [
      { ts: '1', text: 'foo' },
      { ts: '2', text: 'bar' },
    ];
    const result = verifyDeliveryFromReplies(replies, 'baz');
    expect(result.delivered).toBe(false);
    expect(result.reason).toMatch(/not found/);
    expect(result.reason).toMatch(/2/);
  });

  it('V.6 — null text entries are skipped (not crashed)', () => {
    const replies = [
      { ts: '1', text: null },
      { ts: '2', text: 'target' },
    ];
    const result = verifyDeliveryFromReplies(replies, 'target');
    expect(result.delivered).toBe(true);
  });
});

describe('runDeliveryVerification', () => {
  function makeDeps(
    replies: Array<{ ts: string; text: string | null }> | null | 'throw',
  ) {
    const publishEvent = vi.fn(() => ({ id: 999, isNew: true }));
    const fetchThreadReplies =
      replies === 'throw'
        ? vi.fn().mockRejectedValue(new Error('network'))
        : vi.fn().mockResolvedValue(replies);
    return { publishEvent, fetchThreadReplies };
  }

  it('V.7 — delivered path does not publish pipeline_delivery_failed', async () => {
    const deps = makeDeps([{ ts: '1', text: 'hello' }]);
    const res = await runDeliveryVerification(
      {
        eventId: 42,
        channelJid: 'slack:C1',
        threadTs: 'ts-root',
        expectedText: 'hello',
      },
      deps,
    );
    expect(res.delivered).toBe(true);
    expect(deps.publishEvent).not.toHaveBeenCalled();
  });

  it('V.8 — undelivered path publishes pipeline_delivery_failed with payload + dedup key', async () => {
    const deps = makeDeps([{ ts: '1', text: 'unrelated' }]);
    const res = await runDeliveryVerification(
      {
        eventId: 42,
        channelJid: 'slack:C1',
        threadTs: 'ts-root',
        expectedText: 'expected-reply',
      },
      deps,
    );
    expect(res.delivered).toBe(false);
    expect(deps.publishEvent).toHaveBeenCalledTimes(1);
    const call = deps.publishEvent.mock.calls[0] as unknown as [
      string,
      string,
      string | null,
      string,
      string | null,
      number | null,
    ];
    expect(call[0]).toBe('pipeline_delivery_failed');
    const parsed = JSON.parse(call[3]);
    expect(parsed.original_event_id).toBe(42);
    expect(parsed.source_channel).toBe('slack:C1');
    expect(parsed.source_message_id).toBe('ts-root');
    expect(parsed.expected_text).toBe('expected-reply');
    expect(parsed.reason).toMatch(/not found/);
    expect(call[4]).toBe('delivery-failed:42');
  });

  it('V.9 — fetch throws → undelivered + publishes', async () => {
    const deps = makeDeps('throw');
    const res = await runDeliveryVerification(
      {
        eventId: 7,
        channelJid: 'slack:C1',
        threadTs: 'ts-root',
        expectedText: 'x',
      },
      deps,
    );
    expect(res.delivered).toBe(false);
    expect(deps.publishEvent).not.toHaveBeenCalled(); // fetch-throw is logged but we don't emit a failure event for infrastructure issues
  });

  it('V.10 — fetch returns null → publishes delivery-failed (legitimate miss)', async () => {
    const deps = makeDeps(null);
    const res = await runDeliveryVerification(
      {
        eventId: 7,
        channelJid: 'slack:C1',
        threadTs: 'ts-root',
        expectedText: 'x',
      },
      deps,
    );
    expect(res.delivered).toBe(false);
    expect(deps.publishEvent).toHaveBeenCalledTimes(1);
  });
});
