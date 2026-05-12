import { describe, it, expect, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { log } from './log.js';
import { dispatchToHandlers, type ReactionHandler } from './reaction-handlers.js';
import type { Reaction } from './channels/adapter.js';

const reaction: Reaction = {
  channelType: 'test',
  platformId: 'plat-1',
  threadId: null,
  messageId: 'msg-1',
  emoji: '👍',
  userId: 'test:user-1',
  timestamp: '2026-04-29T00:00:00.000Z',
};

describe('dispatchToHandlers', () => {
  it('resolves no-op when the handlers list is empty', async () => {
    await expect(dispatchToHandlers([], reaction)).resolves.toBeUndefined();
  });

  it('invokes a single handler returning true', async () => {
    const h: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h], reaction);
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith(reaction);
  });

  it('first handler returning true short-circuits — second handler not called', async () => {
    const h1: ReactionHandler = vi.fn(() => true);
    const h2: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h1, h2], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).not.toHaveBeenCalled();
  });

  it('first handler returning false — second handler is called', async () => {
    const h1: ReactionHandler = vi.fn(() => false);
    const h2: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h1, h2], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('all handlers returning false — every handler is called, no short-circuit', async () => {
    const h1: ReactionHandler = vi.fn(() => false);
    const h2: ReactionHandler = vi.fn(() => false);
    const h3: ReactionHandler = vi.fn(() => false);
    await dispatchToHandlers([h1, h2, h3], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('sync throw in a handler is caught + logged; chain continues to next handler', async () => {
    const h1: ReactionHandler = vi.fn(() => {
      throw new Error('boom-sync');
    });
    const h2: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h1, h2], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Reaction handler threw', expect.objectContaining({ emoji: '👍' }));
  });

  it('async rejection in a handler is caught + logged; chain continues', async () => {
    const h1: ReactionHandler = vi.fn(() => Promise.reject(new Error('boom-async')));
    const h2: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h1, h2], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('Reaction handler threw', expect.objectContaining({ emoji: '👍' }));
  });

  it('awaits async handlers — a handler returning Promise<true> short-circuits', async () => {
    const h1: ReactionHandler = vi.fn(() => Promise.resolve(true));
    const h2: ReactionHandler = vi.fn(() => true);
    await dispatchToHandlers([h1, h2], reaction);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).not.toHaveBeenCalled();
  });
});
