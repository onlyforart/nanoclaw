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

vi.mock('./router.js', () => ({
  routeInbound: vi.fn(),
}));

import { buildChannelSetup } from './channel-setup.js';
import type { ChannelAdapter, Reaction } from './channels/adapter.js';

function fakeAdapter(channelType = 'test'): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    supportsThreads: true,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

const reaction: Reaction = {
  channelType: 'test',
  platformId: 'plat-1',
  threadId: null,
  messageId: 'msg-1',
  emoji: '👍',
  userId: 'test:u-1',
  timestamp: '2026-04-29T00:00:00.000Z',
};

describe('buildChannelSetup', () => {
  it('exposes all five expected fields with the correct shape', () => {
    const setup = buildChannelSetup(fakeAdapter());
    expect(typeof setup.onInbound).toBe('function');
    expect(typeof setup.onInboundEvent).toBe('function');
    expect(typeof setup.onMetadata).toBe('function');
    expect(typeof setup.onAction).toBe('function');
    expect(typeof setup.onReaction).toBe('function');
  });

  it('onReaction(reaction) on a fresh registry resolves without throwing (no-op)', async () => {
    const setup = buildChannelSetup(fakeAdapter());
    await expect(setup.onReaction!(reaction)).resolves.toBeUndefined();
  });
});
