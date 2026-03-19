import { describe, it, expect, vi } from 'vitest';

import { parseContainerLine, extractGroupFromName } from './containers.js';

describe('extractGroupFromName', () => {
  it('extracts group folder from standard container name', () => {
    expect(extractGroupFromName('nanoclaw-slack-main-1711000000000')).toBe('slack-main');
  });

  it('extracts group with hyphens in name', () => {
    expect(extractGroupFromName('nanoclaw-whatsapp-family-chat-1711000000000')).toBe('whatsapp-family-chat');
  });

  it('returns the name as-is if pattern does not match', () => {
    expect(extractGroupFromName('other-container')).toBe('other-container');
  });

  it('handles nanoclaw prefix without epoch suffix', () => {
    expect(extractGroupFromName('nanoclaw-test')).toBe('nanoclaw-test');
  });
});

describe('parseContainerLine', () => {
  it('parses a docker ps JSON line', () => {
    const line = JSON.stringify({
      Names: 'nanoclaw-slack-main-1711000000000',
      Status: 'Up 5 minutes',
      CreatedAt: '2024-03-21 10:00:00 +0000 UTC',
      RunningFor: '5 minutes ago',
    });
    const result = parseContainerLine(line);
    expect(result).toEqual({
      name: 'nanoclaw-slack-main-1711000000000',
      group: 'slack-main',
      status: 'Up 5 minutes',
      created: '2024-03-21 10:00:00 +0000 UTC',
      runningFor: '5 minutes ago',
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseContainerLine('not json')).toBeNull();
  });

  it('returns null for empty line', () => {
    expect(parseContainerLine('')).toBeNull();
  });
});
