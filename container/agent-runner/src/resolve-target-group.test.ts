import { describe, it, expect } from 'vitest';

import { resolveTargetGroup } from './resolve-target-group.js';

const groups = [
  { jid: 'slack:CAAAA', name: 'alpha-room', isRegistered: true },
  { jid: 'slack:CBBBB', name: 'beta-room', isRegistered: true },
  { jid: 'slack:CCCCC', name: 'gamma-room', isRegistered: true },
  { jid: 'slack:CNOREG', name: 'unregistered-room', isRegistered: false },
];

describe('resolveTargetGroup', () => {
  it('matches by registered name (case-insensitive)', () => {
    const r = resolveTargetGroup('alpha-room', groups);
    expect(r.match?.jid).toBe('slack:CAAAA');
    expect(r.error).toBeUndefined();
  });

  it('matches by name regardless of case', () => {
    const r = resolveTargetGroup('Alpha-Room', groups);
    expect(r.match?.jid).toBe('slack:CAAAA');
  });

  it('matches by JID when the model passes the channel id', () => {
    const r = resolveTargetGroup('slack:CAAAA', groups);
    expect(r.match?.name).toBe('alpha-room');
    expect(r.error).toBeUndefined();
  });

  it('returns an error listing registered groups when nothing matches', () => {
    const r = resolveTargetGroup('does-not-exist', groups);
    expect(r.match).toBeUndefined();
    expect(r.error).toContain('does-not-exist');
    expect(r.error).toContain('alpha-room');
    expect(r.error).toContain('beta-room');
    // Unregistered group name must not be offered
    expect(r.error).not.toContain('unregistered-room');
  });

  it('rejects an existing but unregistered group with a specific error', () => {
    const r = resolveTargetGroup('unregistered-room', groups);
    expect(r.match).toBeUndefined();
    expect(r.error).toContain('not registered');
  });

  it('rejects an unregistered group even when addressed by JID', () => {
    const r = resolveTargetGroup('slack:CNOREG', groups);
    expect(r.match).toBeUndefined();
    expect(r.error).toContain('not registered');
  });
});
