import { describe, it, expect, vi } from 'vitest';

import { sendWithRetry } from './outbound-retry.js';

describe('sendWithRetry', () => {
  it('succeeds on first try', async () => {
    const sendFn = vi.fn(async () => {});
    const result = await sendWithRetry(sendFn, 'jid', 'hello');
    expect(result.success).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds', async () => {
    let calls = 0;
    const sendFn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });

    const result = await sendWithRetry(sendFn, 'jid', 'hello', 3);
    expect(result.success).toBe(true);
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it('gives up after max retries and returns failure', async () => {
    const sendFn = vi.fn(async () => {
      throw new Error('permanent');
    });

    const result = await sendWithRetry(sendFn, 'jid', 'hello', 3);
    expect(result.success).toBe(false);
    expect(result.error).toContain('permanent');
    expect(sendFn).toHaveBeenCalledTimes(3);
  });

  it('passes jid and text to the send function', async () => {
    const sendFn = vi.fn(async () => {});
    await sendWithRetry(sendFn, 'target@g.us', 'the message');
    expect(sendFn).toHaveBeenCalledWith('target@g.us', 'the message');
  });
});
