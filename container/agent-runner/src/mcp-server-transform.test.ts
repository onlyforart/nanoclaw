import { describe, expect, it } from 'bun:test';

import type { McpServerEntry } from './config.js';
import { toSdkMcpServer } from './mcp-server-transform.js';

describe('toSdkMcpServer', () => {
  it('maps a stdio entry to the SDK stdio shape with explicit type', () => {
    const entry: McpServerEntry = {
      command: 'node',
      args: ['srv.js'],
      env: { PATH: '/usr/bin' },
    };
    const out = toSdkMcpServer(entry);
    expect(out).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['srv.js'],
      env: { PATH: '/usr/bin' },
    });
  });

  it('maps a remote entry with headers to the SDK http shape', () => {
    const entry: McpServerEntry = {
      url: 'http://host.docker.internal:3201/mcp',
      tools: ['list_pods'],
      headers: { 'X-Auth': 'token' },
    };
    const out = toSdkMcpServer(entry);
    expect(out).toEqual({
      type: 'http',
      url: 'http://host.docker.internal:3201/mcp',
      headers: { 'X-Auth': 'token' },
    });
  });

  it('maps a remote entry without headers to the SDK http shape (headers omitted)', () => {
    const entry: McpServerEntry = {
      url: 'https://mcp.example/api',
      tools: ['op1'],
    };
    const out = toSdkMcpServer(entry);
    expect(out).toEqual({
      type: 'http',
      url: 'https://mcp.example/api',
    });
  });

  it('drops fork-internal fields (tools, readOnly, proxy, policies, skill, instructions, toolSchemas) from the SDK view', () => {
    const entry: McpServerEntry = {
      url: 'http://h/mcp',
      tools: { read: ['op1'], write: ['op2'] },
      readOnly: true,
      proxy: false,
      policies: { default: 'baseline' },
      headers: { H: 'v' },
      skill: 'SKILL.md',
      instructions: '# guide',
      toolSchemas: [{ name: 'op1', inputSchema: {} }],
    };
    const out = toSdkMcpServer(entry);
    expect(out).toEqual({
      type: 'http',
      url: 'http://h/mcp',
      headers: { H: 'v' },
    });
    // No fork fields leaked into the SDK view.
    expect(out).not.toHaveProperty('tools');
    expect(out).not.toHaveProperty('readOnly');
    expect(out).not.toHaveProperty('proxy');
    expect(out).not.toHaveProperty('policies');
    expect(out).not.toHaveProperty('skill');
    expect(out).not.toHaveProperty('instructions');
    expect(out).not.toHaveProperty('toolSchemas');
  });

  it('drops stdio-side fork-internal `instructions` from the SDK view', () => {
    const entry: McpServerEntry = {
      command: 'node',
      args: [],
      env: {},
      instructions: '# guide for stdio',
    };
    const out = toSdkMcpServer(entry);
    expect(out).toEqual({ type: 'stdio', command: 'node', args: [], env: {} });
    expect(out).not.toHaveProperty('instructions');
  });
});
