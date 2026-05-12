import { describe, it, expect, vi } from 'vitest';

import type { InboundEvent } from './channels/adapter.js';
import type { MessagingGroup } from './types.js';
import { composeAccessGate, type AccessGateExtensionFn, type AccessGateFn, type AccessGateResult } from './router.js';

const event: InboundEvent = {
  channelType: 'test',
  platformId: 'plat-1',
  threadId: null,
  message: {
    id: 'm-1',
    kind: 'chat',
    content: '{}',
    timestamp: '2026-04-29T00:00:00.000Z',
  },
};

const mg: MessagingGroup = {
  id: 'mg-1',
  channel_type: 'test',
  platform_id: 'plat-1',
  name: null,
  is_group: 0,
  unknown_sender_policy: 'strict',
  created_at: '2026-04-29T00:00:00.000Z',
};

const userId = 'test:user-1';
const agentGroupId = 'ag-1';

describe('composeAccessGate', () => {
  it('returns allow when no extensions and no base gate (default-allow)', () => {
    const result = composeAccessGate([], null, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: true });
  });

  it('forwards to base gate when no extensions are registered', () => {
    const baseGate: AccessGateFn = vi.fn((): AccessGateResult => ({ allowed: false, reason: 'base-deny' }));
    const result = composeAccessGate([], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: false, reason: 'base-deny' });
    expect(baseGate).toHaveBeenCalledTimes(1);
  });

  it('extension returning {allowed:true} bypasses the base gate', () => {
    const baseGate: AccessGateFn = vi.fn();
    const ext: AccessGateExtensionFn = () => ({ allowed: true });
    const result = composeAccessGate([ext], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: true });
    expect(baseGate).not.toHaveBeenCalled();
  });

  it('extension returning {allowed:false, reason} short-circuits with deny', () => {
    const baseGate: AccessGateFn = vi.fn();
    const ext: AccessGateExtensionFn = () => ({ allowed: false, reason: 'ext-deny' });
    const result = composeAccessGate([ext], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: false, reason: 'ext-deny' });
    expect(baseGate).not.toHaveBeenCalled();
  });

  it('extension returning null falls through to the base gate', () => {
    const baseGate: AccessGateFn = vi.fn((): AccessGateResult => ({ allowed: true }));
    const ext: AccessGateExtensionFn = () => null;
    const result = composeAccessGate([ext], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: true });
    expect(baseGate).toHaveBeenCalledTimes(1);
  });

  it('with multiple extensions, the first non-null result wins', () => {
    const ext1: AccessGateExtensionFn = vi.fn((): AccessGateResult | null => null);
    const ext2: AccessGateExtensionFn = vi.fn((): AccessGateResult | null => ({ allowed: true }));
    const baseGate: AccessGateFn = vi.fn();
    const result = composeAccessGate([ext1, ext2], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: true });
    expect(ext1).toHaveBeenCalledTimes(1);
    expect(ext2).toHaveBeenCalledTimes(1);
    expect(baseGate).not.toHaveBeenCalled();
  });

  it('order is preserved — first extension to return non-null short-circuits later ones', () => {
    const ext1: AccessGateExtensionFn = vi.fn((): AccessGateResult | null => ({ allowed: true }));
    const ext2: AccessGateExtensionFn = vi.fn((): AccessGateResult | null => ({
      allowed: false,
      reason: 'never-runs',
    }));
    const baseGate: AccessGateFn = vi.fn();
    const result = composeAccessGate([ext1, ext2], baseGate, event, userId, mg, agentGroupId);
    expect(result).toEqual({ allowed: true });
    expect(ext1).toHaveBeenCalledTimes(1);
    expect(ext2).not.toHaveBeenCalled();
    expect(baseGate).not.toHaveBeenCalled();
  });

  it('extension receives the same event/userId/mg/agentGroupId arguments', () => {
    const ext: AccessGateExtensionFn = vi.fn(() => null);
    const baseGate: AccessGateFn = vi.fn((): AccessGateResult => ({ allowed: true }));
    composeAccessGate([ext], baseGate, event, userId, mg, agentGroupId);
    expect(ext).toHaveBeenCalledWith(event, userId, mg, agentGroupId);
    expect(baseGate).toHaveBeenCalledWith(event, userId, mg, agentGroupId);
  });
});
