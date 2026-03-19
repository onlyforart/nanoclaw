import { describe, it, expect } from 'vitest';

import { compilePath, matchPath, parseQuery, parseJsonBody } from './router.js';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

// --- compilePath + matchPath ---

describe('compilePath', () => {
  it('compiles a static path', () => {
    const route = compilePath('/api/v1/groups');
    expect(route.pattern).toBeInstanceOf(RegExp);
    expect(route.keys).toEqual([]);
  });

  it('compiles a path with a named parameter', () => {
    const route = compilePath('/api/v1/groups/:folder');
    expect(route.keys).toEqual(['folder']);
  });

  it('compiles a path with multiple named parameters', () => {
    const route = compilePath('/api/v1/groups/:folder/tasks/:id');
    expect(route.keys).toEqual(['folder', 'id']);
  });
});

describe('matchPath', () => {
  it('matches a static path', () => {
    const route = compilePath('/api/v1/groups');
    const result = matchPath(route, '/api/v1/groups');
    expect(result).toEqual({});
  });

  it('returns null for non-matching path', () => {
    const route = compilePath('/api/v1/groups');
    expect(matchPath(route, '/api/v1/tasks')).toBeNull();
  });

  it('extracts a single parameter', () => {
    const route = compilePath('/api/v1/groups/:folder');
    const result = matchPath(route, '/api/v1/groups/slack_main');
    expect(result).toEqual({ folder: 'slack_main' });
  });

  it('extracts multiple parameters', () => {
    const route = compilePath('/api/v1/groups/:folder/tasks/:id');
    const result = matchPath(route, '/api/v1/groups/slack_main/tasks/abc123');
    expect(result).toEqual({ folder: 'slack_main', id: 'abc123' });
  });

  it('does not match partial paths', () => {
    const route = compilePath('/api/v1/groups');
    expect(matchPath(route, '/api/v1/groups/extra')).toBeNull();
  });

  it('does not match prefix-only paths', () => {
    const route = compilePath('/api/v1/groups/:folder');
    expect(matchPath(route, '/api/v1/groups/')).toBeNull();
  });

  it('decodes URI components in parameters', () => {
    const route = compilePath('/api/v1/groups/:folder');
    const result = matchPath(route, '/api/v1/groups/my%20group');
    expect(result).toEqual({ folder: 'my group' });
  });
});

// --- parseQuery ---

describe('parseQuery', () => {
  it('returns empty object for no query string', () => {
    expect(parseQuery('/api/v1/tasks')).toEqual({});
  });

  it('parses a single parameter', () => {
    expect(parseQuery('/api/v1/tasks?limit=20')).toEqual({ limit: '20' });
  });

  it('parses multiple parameters', () => {
    expect(parseQuery('/api/v1/tasks?limit=20&offset=5')).toEqual({
      limit: '20',
      offset: '5',
    });
  });

  it('handles empty value', () => {
    expect(parseQuery('/api/v1/tasks?key=')).toEqual({ key: '' });
  });
});

// --- parseJsonBody ---

function mockRequest(body: string, contentType?: string): IncomingMessage {
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  });
  (stream as any).headers = {
    'content-type': contentType ?? 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  return stream as unknown as IncomingMessage;
}

describe('parseJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const req = mockRequest('{"name":"test"}');
    const result = await parseJsonBody(req);
    expect(result).toEqual({ name: 'test' });
  });

  it('rejects non-JSON content type', async () => {
    const req = mockRequest('hello', 'text/plain');
    await expect(parseJsonBody(req)).rejects.toThrow(/content-type/i);
  });

  it('rejects malformed JSON', async () => {
    const req = mockRequest('{bad json');
    await expect(parseJsonBody(req)).rejects.toThrow();
  });

  it('rejects bodies over the size limit', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const req = mockRequest(big);
    await expect(parseJsonBody(req)).rejects.toThrow(/too large|413/i);
  });

  it('handles empty body as empty object', async () => {
    const req = mockRequest('');
    // Empty body should reject since it's not valid JSON
    await expect(parseJsonBody(req)).rejects.toThrow();
  });
});
