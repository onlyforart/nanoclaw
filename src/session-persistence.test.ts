import { describe, it, expect } from 'vitest';

import { shouldPersistSession } from './session-persistence.js';
import type { ContainerOutput } from './container-runner.js';

describe('shouldPersistSession', () => {
  it('persists a newSessionId from a successful output', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      newSessionId: 'new-session-123',
    };
    expect(shouldPersistSession(output)).toBe(true);
  });

  it('does NOT persist a newSessionId from an error output', () => {
    const output: ContainerOutput = {
      status: 'error',
      result: null,
      newSessionId: 'stale-session-abc',
      error: 'No conversation found with session ID: stale-session-abc',
    };
    expect(shouldPersistSession(output)).toBe(false);
  });

  it('does not persist when newSessionId is absent', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
    };
    expect(shouldPersistSession(output)).toBe(false);
  });

  it('does not persist when newSessionId is empty string', () => {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      newSessionId: '',
    };
    expect(shouldPersistSession(output)).toBe(false);
  });
});
