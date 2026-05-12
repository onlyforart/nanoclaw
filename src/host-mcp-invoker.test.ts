/**
 * Tests for src/host-mcp-invoker.ts.
 *
 * Encodes the role spec — host-side one-shot MCP tool caller for
 * host_pipeline tasks — not the impl. Three public surfaces:
 *   - `toolIsAllowed(entry, name)` — pure allowlist check (flat array
 *     OR access-level object).
 *   - `parseToolResult(result)` — extract first text content + JSON
 *     parse, with typed errors.
 *   - `invokeMcpTool(params, timeoutMs?)` — full lifecycle: load
 *     config → resolve entry → enforce allowlist → spawn → connect →
 *     callTool → parse → close.
 * Plus the `McpInvokerError` typed-error contract (six `kind` values).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock factories run BEFORE module-level vars exist (hoisted), so any
// shared state that mocks reference must come from `vi.hoisted()`.
const state = vi.hoisted(() => {
  interface TransportCtorArgs {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }
  interface CallToolReq {
    name: string;
    arguments: Record<string, unknown>;
  }
  return {
    currentDataDir: { value: '' },
    transportCtorCalls: [] as TransportCtorArgs[],
    clientInstances: [] as Array<{
      callToolCalls: Array<{ req: CallToolReq; options: { timeout?: number } }>;
      closeCalled: boolean;
    }>,
    impls: {
      connect: (() => Promise.resolve()) as () => Promise<void>,
      callTool: (() => Promise.resolve({ content: [{ type: 'text', text: '{}' }] })) as (
        req: CallToolReq,
        schema: undefined,
        options: { timeout?: number },
      ) => Promise<unknown>,
      close: (() => Promise.resolve()) as () => Promise<void>,
    },
  };
});

vi.mock('./config.js', async () => {
  const real = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...real,
    get DATA_DIR(): string {
      return state.currentDataDir.value;
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(args: { command: string; args?: string[]; cwd?: string; env?: Record<string, string> }) {
      state.transportCtorCalls.push(args);
    }
  },
  getDefaultEnvironment: () => ({ SDK_DEFAULT: 'sdk-default-value' }),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class MockClient {
    callToolCalls: Array<{
      req: { name: string; arguments: Record<string, unknown> };
      options: { timeout?: number };
    }> = [];
    closeCalled = false;
    constructor(_meta: unknown, _opts: unknown) {
      state.clientInstances.push(this);
    }
    connect(_t: unknown): Promise<void> {
      return state.impls.connect.call(this);
    }
    callTool(
      req: { name: string; arguments: Record<string, unknown> },
      schema: undefined,
      options: { timeout?: number },
    ): Promise<unknown> {
      this.callToolCalls.push({ req, options });
      return state.impls.callTool.call(this, req, schema, options);
    }
    close(): Promise<void> {
      this.closeCalled = true;
      return state.impls.close.call(this);
    }
  },
}));

import { toolIsAllowed, parseToolResult, invokeMcpTool, McpInvokerError } from './host-mcp-invoker.js';
import type { StdioMcpServerEntry } from './remote-mcp.js';

// === Per-test fixture =======================================================

function writeServersFile(servers: Record<string, unknown>): void {
  fs.mkdirSync(state.currentDataDir.value, { recursive: true });
  fs.writeFileSync(path.join(state.currentDataDir.value, 'mcp-servers.json'), JSON.stringify({ servers }, null, 2));
}

beforeEach(() => {
  state.currentDataDir.value = fs.mkdtempSync(path.join(os.tmpdir(), 'host-mcp-invoker-'));
  state.transportCtorCalls.length = 0;
  state.clientInstances.length = 0;
  state.impls.connect = () => Promise.resolve();
  state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
  state.impls.close = () => Promise.resolve();
});

afterEach(() => {
  if (state.currentDataDir.value && fs.existsSync(state.currentDataDir.value)) {
    fs.rmSync(state.currentDataDir.value, { recursive: true, force: true });
  }
});

// ============================================================================
// toolIsAllowed — flat array OR access-level object
// ============================================================================

describe('toolIsAllowed', () => {
  it('returns true when tools is a flat array containing the name', () => {
    const entry = { tools: ['a', 'b', 'c'] } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'b')).toBe(true);
  });

  it('returns false when tools is a flat array missing the name', () => {
    const entry = { tools: ['a', 'b'] } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'c')).toBe(false);
  });

  it('returns false when tools is an empty array', () => {
    const entry = { tools: [] } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'anything')).toBe(false);
  });

  it('returns true when tools is an access-level object containing the name in any group', () => {
    const entry = {
      tools: { read: ['find'], write: ['insert'] },
    } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'find')).toBe(true);
    expect(toolIsAllowed(entry, 'insert')).toBe(true);
  });

  it('returns false when tools is an access-level object not containing the name', () => {
    const entry = {
      tools: { read: ['find'], write: ['insert'] },
    } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'drop')).toBe(false);
  });

  it('returns false when tools is an empty access-level object', () => {
    const entry = { tools: {} } as Pick<StdioMcpServerEntry, 'tools'>;
    expect(toolIsAllowed(entry, 'anything')).toBe(false);
  });
});

// ============================================================================
// parseToolResult — JSON extraction + typed errors
// ============================================================================

describe('parseToolResult', () => {
  it('extracts the first text-content part and parses it as JSON', () => {
    const result = { content: [{ type: 'text', text: '{"answer":42}' }] };
    expect(parseToolResult(result)).toEqual({ answer: 42 });
  });

  it('throws McpInvokerError(kind="tool-error") when isError=true with a text body', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'tool said no' }] };
    try {
      parseToolResult(result);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpInvokerError);
      expect((err as McpInvokerError).kind).toBe('tool-error');
      expect((err as McpInvokerError).message).toContain('tool said no');
    }
  });

  it('throws kind="tool-error" with "(no text)" when isError=true and no content', () => {
    const result = { isError: true } as unknown;
    try {
      parseToolResult(result);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('tool-error');
      expect((err as McpInvokerError).message).toContain('(no text)');
    }
  });

  it('throws kind="malformed-response" when content is missing', () => {
    try {
      parseToolResult({});
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
    }
  });

  it('throws kind="malformed-response" when first content part is not text', () => {
    const result = { content: [{ type: 'image' }] };
    try {
      parseToolResult(result);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
    }
  });

  it('throws kind="malformed-response" when text is not valid JSON', () => {
    const result = { content: [{ type: 'text', text: 'not json' }] };
    try {
      parseToolResult(result);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
      expect((err as McpInvokerError).message).toContain('not json');
    }
  });

  it('handles JSON with leading/trailing whitespace', () => {
    const result = { content: [{ type: 'text', text: '  \n {"k":1}\n' }] };
    expect(parseToolResult(result)).toEqual({ k: 1 });
  });

  it('parses arrays + scalars + null at the JSON top level', () => {
    expect(parseToolResult({ content: [{ type: 'text', text: '[1,2,3]' }] })).toEqual([1, 2, 3]);
    expect(parseToolResult({ content: [{ type: 'text', text: '"hi"' }] })).toBe('hi');
    expect(parseToolResult({ content: [{ type: 'text', text: 'null' }] })).toBeNull();
  });
});

// ============================================================================
// invokeMcpTool — config resolution + allowlist + lifecycle + error mapping
// ============================================================================

describe('invokeMcpTool — config resolution', () => {
  it('throws kind="server-not-found" when the server name is missing from mcp-servers.json', async () => {
    writeServersFile({});
    await expect(invokeMcpTool({ server: 'nope', name: 't' })).rejects.toMatchObject({
      kind: 'server-not-found',
    });
  });

  it('throws kind="server-not-found" when mcp-servers.json does not exist', async () => {
    await expect(invokeMcpTool({ server: 'nope', name: 't' })).rejects.toMatchObject({
      kind: 'server-not-found',
    });
  });

  it('throws kind="server-not-stdio" when the entry is a remote (url) server', async () => {
    writeServersFile({ remote: { url: 'https://example/mcp', tools: ['t'] } });
    await expect(invokeMcpTool({ server: 'remote', name: 't' })).rejects.toMatchObject({
      kind: 'server-not-stdio',
    });
  });

  it('throws kind="server-not-stdio" when the entry has no command/hostPath', async () => {
    writeServersFile({ broken: { tools: ['t'] } });
    await expect(invokeMcpTool({ server: 'broken', name: 't' })).rejects.toMatchObject({
      kind: 'server-not-stdio',
    });
  });

  it('survives a malformed mcp-servers.json — treats it as empty (server-not-found)', async () => {
    fs.mkdirSync(state.currentDataDir.value, { recursive: true });
    fs.writeFileSync(path.join(state.currentDataDir.value, 'mcp-servers.json'), '{ not valid json');
    await expect(invokeMcpTool({ server: 'x', name: 't' })).rejects.toMatchObject({
      kind: 'server-not-found',
    });
  });
});

describe('invokeMcpTool — allowlist enforcement', () => {
  beforeEach(() => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        args: ['--mcp'],
        hostPath: '/tmp/hostpath',
        tools: ['allowed_tool'],
      },
    });
  });

  it('throws kind="tool-not-allowed" when the tool is not in the allowlist', async () => {
    await expect(invokeMcpTool({ server: 'srv', name: 'forbidden' })).rejects.toMatchObject({
      kind: 'tool-not-allowed',
    });
  });

  it('proceeds when the tool is in the allowlist', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });
    const out = await invokeMcpTool({ server: 'srv', name: 'allowed_tool' });
    expect(out).toEqual({ ok: true });
  });

  it('access-level object allowlist supports both groups', async () => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        hostPath: '/tmp/hostpath',
        tools: { read: ['get'], write: ['put'] },
      },
    });
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });

    await expect(invokeMcpTool({ server: 'srv', name: 'get' })).resolves.toEqual({});
    await expect(invokeMcpTool({ server: 'srv', name: 'put' })).resolves.toEqual({});
    await expect(invokeMcpTool({ server: 'srv', name: 'drop' })).rejects.toMatchObject({
      kind: 'tool-not-allowed',
    });
  });
});

describe('invokeMcpTool — env composition', () => {
  beforeEach(() => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        hostPath: '/tmp/hostpath',
        tools: ['t'],
        hostEnv: { CUSTOM_KEY: 'custom-value' },
      },
    });
  });

  it('forwards safe-env keys from process.env onto the spawned env', async () => {
    process.env.PATH = '/some/path:/other/path';
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });

    await invokeMcpTool({ server: 'srv', name: 't' });

    expect(state.transportCtorCalls[0].env?.PATH).toBe('/some/path:/other/path');
  });

  it('hostEnv overrides safe-env which overrides getDefaultEnvironment', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 't' });

    expect(state.transportCtorCalls[0].env?.SDK_DEFAULT).toBe('sdk-default-value');
    expect(state.transportCtorCalls[0].env?.CUSTOM_KEY).toBe('custom-value');
  });

  it('hostEnv beats SDK default with the same key', async () => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        hostPath: '/tmp/hostpath',
        tools: ['t'],
        hostEnv: { SDK_DEFAULT: 'overridden' },
      },
    });
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 't' });

    expect(state.transportCtorCalls[0].env?.SDK_DEFAULT).toBe('overridden');
  });

  it('omits hostEnv when it is missing or non-object', async () => {
    writeServersFile({
      srv: { command: '/bin/x', hostPath: '/tmp/hostpath', tools: ['t'] },
    });
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 't' });

    expect(state.transportCtorCalls[0].env?.SDK_DEFAULT).toBe('sdk-default-value');
    expect(state.transportCtorCalls[0].env?.CUSTOM_KEY).toBeUndefined();
  });

  it('drops non-string hostEnv values', async () => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        hostPath: '/tmp/hostpath',
        tools: ['t'],
        hostEnv: { GOOD: 'yes', BAD: 123 },
      },
    });
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 't' });

    expect(state.transportCtorCalls[0].env?.GOOD).toBe('yes');
    expect(state.transportCtorCalls[0].env?.BAD).toBeUndefined();
  });
});

describe('invokeMcpTool — call shape + lifecycle', () => {
  beforeEach(() => {
    writeServersFile({
      srv: {
        command: '/bin/x',
        args: ['--rpc'],
        hostPath: '/tmp/hostpath',
        tools: ['fetch'],
      },
    });
  });

  it('passes name + args=given when args provided', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 'fetch', args: { url: 'x' } });

    expect(state.clientInstances).toHaveLength(1);
    const call = state.clientInstances[0].callToolCalls[0];
    expect(call.req.name).toBe('fetch');
    expect(call.req.arguments).toEqual({ url: 'x' });
  });

  it('passes args={} when args omitted', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 'fetch' });

    const call = state.clientInstances[0].callToolCalls[0];
    expect(call.req.arguments).toEqual({});
  });

  it('forwards command + args + hostPath as the spawn command/cwd', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 'fetch' });

    const t = state.transportCtorCalls[0];
    expect(t.command).toBe('/bin/x');
    expect(t.args).toEqual(['--rpc']);
    expect(t.cwd).toBe('/tmp/hostpath');
  });

  it('returns the parsed JSON from the tool', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{"hello":"world"}' }] });
    const out = await invokeMcpTool({ server: 'srv', name: 'fetch' });
    expect(out).toEqual({ hello: 'world' });
  });

  it('always closes the client (success path)', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    await invokeMcpTool({ server: 'srv', name: 'fetch' });
    expect(state.clientInstances[0].closeCalled).toBe(true);
  });

  it('always closes the client (error path)', async () => {
    state.impls.callTool = () => Promise.reject(new Error('rpc-fail'));
    await expect(invokeMcpTool({ server: 'srv', name: 'fetch' })).rejects.toBeInstanceOf(McpInvokerError);
    expect(state.clientInstances[0].closeCalled).toBe(true);
  });

  it('swallows close() errors (caller already has the result or thrown error)', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] });
    state.impls.close = () => Promise.reject(new Error('close-fail'));

    const out = await invokeMcpTool({ server: 'srv', name: 'fetch' });
    expect(out).toEqual({});
  });
});

describe('invokeMcpTool — error mapping', () => {
  beforeEach(() => {
    writeServersFile({
      srv: { command: '/bin/x', hostPath: '/tmp/hostpath', tools: ['fetch'] },
    });
  });

  it('wraps connect failures as McpInvokerError(kind="transport-error")', async () => {
    state.impls.connect = () => Promise.reject(new Error('connect-boom'));
    try {
      await invokeMcpTool({ server: 'srv', name: 'fetch' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpInvokerError);
      expect((err as McpInvokerError).kind).toBe('transport-error');
      expect((err as McpInvokerError).message).toContain('connect-boom');
    }
  });

  it('wraps generic callTool failures as kind="transport-error"', async () => {
    state.impls.callTool = () => Promise.reject(new Error('rpc-fail'));
    try {
      await invokeMcpTool({ server: 'srv', name: 'fetch' });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('transport-error');
    }
  });

  it('does NOT wrap McpInvokerError thrown from inside (e.g. parseToolResult tool-error)', async () => {
    state.impls.callTool = () => Promise.resolve({ isError: true, content: [{ type: 'text', text: 'tool-said-no' }] });
    try {
      await invokeMcpTool({ server: 'srv', name: 'fetch' });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpInvokerError);
      expect((err as McpInvokerError).kind).toBe('tool-error'); // preserved, not transport-error
    }
  });

  it('preserves McpInvokerError(kind="malformed-response") through the catch', async () => {
    state.impls.callTool = () => Promise.resolve({ content: [{ type: 'text', text: 'not-json' }] });
    try {
      await invokeMcpTool({ server: 'srv', name: 'fetch' });
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
    }
  });

  it('throws kind="transport-error" "timed out" when the call exceeds timeoutMs', async () => {
    // Hang forever — outer Promise.race timeout fires.
    state.impls.callTool = () => new Promise(() => {});

    const start = Date.now();
    try {
      await invokeMcpTool({ server: 'srv', name: 'fetch' }, 50);
      expect.fail('expected throw');
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('transport-error');
      expect((err as McpInvokerError).message).toMatch(/timed out/);
    }
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

// ============================================================================
// McpInvokerError — typed kind contract
// ============================================================================

describe('McpInvokerError', () => {
  it('exposes the kind as a public readonly property', () => {
    const err = new McpInvokerError('msg', 'tool-not-allowed');
    expect(err.kind).toBe('tool-not-allowed');
    expect(err.name).toBe('McpInvokerError');
    expect(err).toBeInstanceOf(Error);
  });

  it('all six kinds round-trip', () => {
    const kinds = [
      'server-not-found',
      'server-not-stdio',
      'tool-not-allowed',
      'tool-error',
      'malformed-response',
      'transport-error',
    ] as const;
    for (const k of kinds) {
      expect(new McpInvokerError('m', k).kind).toBe(k);
    }
  });
});
