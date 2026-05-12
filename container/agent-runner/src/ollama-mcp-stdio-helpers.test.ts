/**
 * Tests for ollama-mcp-stdio-helpers.ts.
 *
 * Encodes the spec for the pure helpers extracted from
 * ollama-mcp-stdio.ts. The entry-point file itself is not tested
 * directly: importing it triggers a top-level
 * `await server.connect(transport)` that attaches a stdio
 * transport, so it cannot run inside a test runner.
 *
 * Coverage:
 *   - normalizeArgs (4 tests)
 *   - generateSessionId (3 tests)
 *   - cleanUserMessage (5 tests)
 *   - extractServerNameFromMcpName (5 tests)
 *   - mapToolCallsToMcp (4 tests)
 *   - serializeToolCallsNeeded (3 tests)
 *   - pickLastAssistantContent (4 tests)
 *   - parseToolConfig (6 tests)
 *   - checkSessionLimits (5 tests)
 */
import { describe, it, expect } from 'bun:test';

import {
  normalizeArgs,
  generateSessionId,
  cleanUserMessage,
  extractServerNameFromMcpName,
  mapToolCallsToMcp,
  serializeToolCallsNeeded,
  pickLastAssistantContent,
  parseToolConfig,
  checkSessionLimits,
  type McpServerEntry,
} from './ollama-mcp-stdio-helpers.js';

// ============================================================================
// normalizeArgs
// ============================================================================

describe('normalizeArgs', () => {
  it('passes a plain object through unchanged', () => {
    expect(normalizeArgs({ foo: 'bar', n: 1 })).toEqual({ foo: 'bar', n: 1 });
  });

  it('parses a JSON-string-encoded object', () => {
    expect(normalizeArgs('{"foo":"bar","n":1}')).toEqual({ foo: 'bar', n: 1 });
  });

  it('returns {} for invalid JSON strings', () => {
    expect(normalizeArgs('not json')).toEqual({});
    expect(normalizeArgs('{ broken')).toEqual({});
  });

  it('returns {} for non-object inputs (null, arrays, scalars, JSON-encoded scalars)', () => {
    expect(normalizeArgs(null)).toEqual({});
    expect(normalizeArgs(undefined)).toEqual({});
    expect(normalizeArgs(42)).toEqual({});
    expect(normalizeArgs([1, 2])).toEqual({});
    // A JSON-encoded array or scalar is not a tool-call args object.
    expect(normalizeArgs('[1,2,3]')).toEqual({});
    expect(normalizeArgs('"hello"')).toEqual({});
  });
});

// ============================================================================
// generateSessionId
// ============================================================================

describe('generateSessionId', () => {
  it('starts with the "ollama_" prefix', () => {
    expect(generateSessionId()).toMatch(/^ollama_/);
  });

  it('returns ids unique across rapid successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(100);
  });

  it('embeds a timestamp segment that is monotonic across separated calls', async () => {
    const a = generateSessionId();
    await new Promise((r) => setTimeout(r, 5));
    const b = generateSessionId();
    const tsA = Number(a.split('_')[1]);
    const tsB = Number(b.split('_')[1]);
    expect(Number.isFinite(tsA)).toBe(true);
    expect(Number.isFinite(tsB)).toBe(true);
    expect(tsB).toBeGreaterThanOrEqual(tsA);
  });
});

// ============================================================================
// cleanUserMessage
// ============================================================================

describe('cleanUserMessage', () => {
  it('rewrites "you have access to the X" → "Use X"', () => {
    expect(cleanUserMessage('you have access to the web-fetch tool')).toBe('Use web-fetch tool');
  });

  it('rewrites "you have access to X" (no "the") → "Use X"', () => {
    expect(cleanUserMessage('You have access to web-fetch tools')).toBe('Use web-fetch tools');
  });

  it('rewrite is case-insensitive', () => {
    expect(cleanUserMessage('YOU HAVE ACCESS TO THE foo')).toBe('Use foo');
  });

  it('rewrites every occurrence', () => {
    expect(cleanUserMessage('you have access to A. you have access to B.')).toBe('Use A. Use B.');
  });

  it('trims surrounding whitespace and is a no-op on unrelated text', () => {
    expect(cleanUserMessage('  hello world  ')).toBe('hello world');
    expect(cleanUserMessage('please look up the weather')).toBe('please look up the weather');
  });
});

// ============================================================================
// extractServerNameFromMcpName
// ============================================================================

describe('extractServerNameFromMcpName', () => {
  it('extracts the server segment from `mcp__{server}__{tool}`', () => {
    expect(extractServerNameFromMcpName('mcp__nanoclaw__send_message')).toBe('nanoclaw');
  });

  it('supports hyphenated server names (production convention)', () => {
    expect(extractServerNameFromMcpName('mcp__eks-kubectl__list_pods')).toBe('eks-kubectl');
  });

  it('supports tool names containing underscores (server is non-underscore)', () => {
    expect(extractServerNameFromMcpName('mcp__srv__send_message_now')).toBe('srv');
  });

  it('returns null for non-mcp__ names', () => {
    expect(extractServerNameFromMcpName('not_an_mcp_name')).toBeNull();
    expect(extractServerNameFromMcpName('mcp_one_underscore')).toBeNull();
  });

  it('returns null when the server segment is missing', () => {
    expect(extractServerNameFromMcpName('mcp____tool')).toBeNull(); // empty server portion
  });
});

// ============================================================================
// mapToolCallsToMcp
// ============================================================================

describe('mapToolCallsToMcp', () => {
  const map = new Map<string, { mcpTool: string; serverName: string }>([
    ['srv__fetch', { mcpTool: 'mcp__srv__fetch', serverName: 'srv' }],
    ['srv__list', { mcpTool: 'mcp__srv__list', serverName: 'srv' }],
  ]);

  it('rewrites Ollama tool name to mcp__-prefixed name and normalizes args', () => {
    const input = [{ function: { name: 'srv__fetch', arguments: { url: 'x' } } }];
    expect(mapToolCallsToMcp(input, map)).toEqual([
      { mcpTool: 'mcp__srv__fetch', arguments: { url: 'x' } },
    ]);
  });

  it('parses JSON-string args via normalizeArgs', () => {
    const input = [{ function: { name: 'srv__list', arguments: '{"page":1}' } }];
    expect(mapToolCallsToMcp(input, map)).toEqual([
      { mcpTool: 'mcp__srv__list', arguments: { page: 1 } },
    ]);
  });

  it('passes the original name through unprefixed when not in the map', () => {
    const input = [{ function: { name: 'unknown_tool', arguments: {} } }];
    expect(mapToolCallsToMcp(input, map)).toEqual([
      { mcpTool: 'unknown_tool', arguments: {} },
    ]);
  });

  it('preserves order of input calls', () => {
    const input = [
      { function: { name: 'srv__fetch', arguments: { i: 1 } } },
      { function: { name: 'srv__list', arguments: { i: 2 } } },
      { function: { name: 'srv__fetch', arguments: { i: 3 } } },
    ];
    const out = mapToolCallsToMcp(input, map);
    expect(out.map((c) => (c.arguments as { i: number }).i)).toEqual([1, 2, 3]);
  });
});

// ============================================================================
// serializeToolCallsNeeded
// ============================================================================

describe('serializeToolCallsNeeded', () => {
  it('produces a JSON string with status / sessionId / toolCalls / instructions', () => {
    const json = serializeToolCallsNeeded(
      'sid-1',
      [{ mcpTool: 'mcp__srv__fetch', arguments: { x: 1 } }],
      'do the things',
    );
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.status).toBe('tool_calls_needed');
    expect(parsed.sessionId).toBe('sid-1');
    expect(parsed.toolCalls).toEqual([{ mcpTool: 'mcp__srv__fetch', arguments: { x: 1 } }]);
    expect(parsed.instructions).toBe('do the things');
  });

  it('pretty-prints with two-space indentation', () => {
    const json = serializeToolCallsNeeded('s', [], 'i');
    expect(json).toContain('\n  "status"');
  });

  it('handles empty toolCalls', () => {
    const json = serializeToolCallsNeeded('s', [], 'i');
    expect((JSON.parse(json) as { toolCalls: unknown[] }).toolCalls).toEqual([]);
  });
});

// ============================================================================
// pickLastAssistantContent
// ============================================================================

describe('pickLastAssistantContent', () => {
  it('returns the most recent assistant message content', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'first' },
      { role: 'tool', content: 'tool-out' },
      { role: 'assistant', content: 'second' },
    ];
    expect(pickLastAssistantContent(messages, 'fb')).toBe('second');
  });

  it('returns fallback when there is no assistant message', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'tool-out' },
    ];
    expect(pickLastAssistantContent(messages, 'fallback')).toBe('fallback');
  });

  it('skips assistant messages with empty content and uses the previous one', () => {
    const messages = [
      { role: 'assistant', content: 'kept' },
      { role: 'assistant', content: '' },
    ];
    expect(pickLastAssistantContent(messages, 'fb')).toBe('kept');
  });

  it('returns fallback when all assistant messages have empty content', () => {
    const messages = [
      { role: 'assistant', content: '' },
      { role: 'assistant', content: undefined },
    ];
    expect(pickLastAssistantContent(messages, 'fb')).toBe('fb');
  });
});

// ============================================================================
// parseToolConfig
// ============================================================================

describe('parseToolConfig', () => {
  it('skips entries with no toolSchemas', () => {
    const config: Record<string, McpServerEntry> = {
      noTools: { command: '/bin/x', args: [], tools: [] },
    };
    const { tools, toolNameMap } = parseToolConfig(config);
    expect(tools).toHaveLength(0);
    expect(toolNameMap.size).toBe(0);
  });

  it('skips entries with empty toolSchemas array', () => {
    const config: Record<string, McpServerEntry> = {
      empty: { command: '/bin/x', args: [], tools: [], toolSchemas: [] },
    };
    expect(parseToolConfig(config).tools).toHaveLength(0);
  });

  it('builds Ollama-format tools with type/function/name/description/parameters', () => {
    const config: Record<string, McpServerEntry> = {
      srv: {
        command: '/bin/x',
        args: [],
        tools: ['fetch'],
        toolSchemas: [{ name: 'fetch', description: 'Fetch a URL', inputSchema: { type: 'object' } }],
      },
    };
    const { tools } = parseToolConfig(config);
    expect(tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'srv__fetch',
          description: 'Fetch a URL',
          parameters: { type: 'object' },
        },
      },
    ]);
  });

  it('uses `{server}__{tool}` as Ollama name and `mcp__{server}__{tool}` in the map', () => {
    const config: Record<string, McpServerEntry> = {
      eks: {
        command: '/bin/x',
        args: [],
        tools: ['list_pods'],
        toolSchemas: [{ name: 'list_pods', inputSchema: {} }],
      },
    };
    const { tools, toolNameMap } = parseToolConfig(config);
    expect(tools[0].function.name).toBe('eks__list_pods');
    expect(toolNameMap.get('eks__list_pods')).toEqual({
      mcpTool: 'mcp__eks__list_pods',
      serverName: 'eks',
    });
  });

  it('defaults missing description to empty string', () => {
    const config: Record<string, McpServerEntry> = {
      srv: {
        command: '/bin/x',
        args: [],
        tools: ['t'],
        toolSchemas: [{ name: 't', inputSchema: {} }],
      },
    };
    expect(parseToolConfig(config).tools[0].function.description).toBe('');
  });

  it('registers multiple tools across multiple servers preserving order', () => {
    const config: Record<string, McpServerEntry> = {
      a: {
        command: '/bin/x',
        args: [],
        tools: ['one', 'two'],
        toolSchemas: [
          { name: 'one', inputSchema: {} },
          { name: 'two', inputSchema: {} },
        ],
      },
      b: {
        command: '/bin/y',
        args: [],
        tools: ['three'],
        toolSchemas: [{ name: 'three', inputSchema: {} }],
      },
    };
    const { tools, toolNameMap } = parseToolConfig(config);
    expect(tools.map((t) => t.function.name)).toEqual(['a__one', 'a__two', 'b__three']);
    expect(toolNameMap.size).toBe(3);
  });
});

// ============================================================================
// checkSessionLimits
// ============================================================================

describe('checkSessionLimits', () => {
  it('returns exceeded:false when within both limits', () => {
    const session = { iterations: 1, maxIterations: 10, startTime: 1000 };
    expect(checkSessionLimits(session, 60_000, 1500)).toEqual({ exceeded: false });
  });

  it('returns exceeded:"iterations" when iterations > maxIterations', () => {
    const session = { iterations: 11, maxIterations: 10, startTime: 1000 };
    expect(checkSessionLimits(session, 60_000, 1500)).toEqual({
      exceeded: true,
      reason: 'iterations',
    });
  });

  it('returns exceeded:"iterations" only after strict exceedance (== max is OK)', () => {
    const session = { iterations: 10, maxIterations: 10, startTime: 1000 };
    expect(checkSessionLimits(session, 60_000, 1500)).toEqual({ exceeded: false });
  });

  it('returns exceeded:"timeout" when wall-clock budget is exhausted', () => {
    const session = { iterations: 1, maxIterations: 10, startTime: 1000 };
    expect(checkSessionLimits(session, 100, 2000)).toEqual({
      exceeded: true,
      reason: 'timeout',
    });
  });

  it('iterations cap takes precedence when both limits exceeded simultaneously', () => {
    const session = { iterations: 11, maxIterations: 10, startTime: 1000 };
    expect(checkSessionLimits(session, 100, 2000)).toEqual({
      exceeded: true,
      reason: 'iterations',
    });
  });
});
