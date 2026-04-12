import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Anthropic SDK
const mockCreate = vi.fn();
const mockModelsList = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      models = { list: mockModelsList };
      constructor(_opts?: unknown) {}
    },
  };
});

import {
  runAnthropicApiChat,
  _resetModelCacheForTests,
  type AnthropicApiOptions,
  type AnthropicApiResult,
} from './anthropic-api-engine.js';

// Helper: build a Message response object matching the Anthropic SDK shape
function makeResponse(overrides: {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content: overrides.content ?? [{ type: 'text', text: 'Hello' }],
    stop_reason: overrides.stop_reason ?? 'end_turn',
    stop_sequence: null,
    model: 'claude-haiku-4-5-20251001',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      ...overrides.usage,
    },
  };
}

function baseOptions(
  overrides?: Partial<AnthropicApiOptions>,
): AnthropicApiOptions {
  return {
    model: 'claude-haiku-4-5-20251001',
    maxIterations: 10,
    timeoutMs: 300_000,
    tools: [],
    toolNameMap: new Map(),
    executeTool: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockModelsList.mockReset();
  _resetModelCacheForTests();
  // Default: models list returns common models
  mockModelsList.mockResolvedValue({
    data: [
      { id: 'claude-haiku-4-5-20251001', context_window: 200000 },
      { id: 'claude-sonnet-4-5-20250929', context_window: 200000 },
      { id: 'claude-opus-4-0-20250514', context_window: 200000 },
    ],
  });
});

describe('runAnthropicApiChat', () => {
  it('returns a text response with no tool calls', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'The answer is 42.' }],
        stop_reason: 'end_turn',
      }),
    );

    const result = await runAnthropicApiChat('What is the answer?', baseOptions());

    expect(result.response).toBe('The answer is 42.');
    expect(result.iterations).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.maxIterationsReached).toBe(false);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('executes a tool call and feeds result back', async () => {
    const executeTool = vi.fn().mockResolvedValueOnce('Status: OK');

    // First call: model requests tool use
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'server__check_status',
            input: { venue: 'prod' },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 30 },
      }),
    );

    // Second call: model returns final text
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'The venue is operational.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
    );

    const toolNameMap = new Map([
      ['server__check_status', { mcpTool: 'mcp__server__check_status', serverName: 'server' }],
    ]);

    const result = await runAnthropicApiChat(
      'Check the venue',
      baseOptions({ executeTool, toolNameMap }),
    );

    expect(executeTool).toHaveBeenCalledWith('mcp__server__check_status', { venue: 'prod' });
    expect(result.response).toBe('The venue is operational.');
    expect(result.iterations).toBe(2);
    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(70);
  });

  it('handles multiple sequential tool calls', async () => {
    const executeTool = vi
      .fn()
      .mockResolvedValueOnce('Result A')
      .mockResolvedValueOnce('Result B');

    // Round 1: two tool calls
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'srv__tool_a', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'srv__tool_b', input: {} },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
    );

    // Round 2: final response
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Both tools ran.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 300, output_tokens: 30 },
      }),
    );

    const toolNameMap = new Map([
      ['srv__tool_a', { mcpTool: 'mcp__srv__tool_a', serverName: 'srv' }],
      ['srv__tool_b', { mcpTool: 'mcp__srv__tool_b', serverName: 'srv' }],
    ]);

    const result = await runAnthropicApiChat(
      'Run both',
      baseOptions({ executeTool, toolNameMap }),
    );

    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(result.response).toBe('Both tools ran.');
    expect(result.iterations).toBe(2);
  });

  it('returns with timedOut when timeout is exceeded', async () => {
    // Use a very short timeout and a slow mock
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                makeResponse({
                  content: [
                    { type: 'tool_use', id: 'toolu_1', name: 'slow__tool', input: {} },
                  ],
                  stop_reason: 'tool_use',
                }),
              ),
            10,
          ),
        ),
    );

    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['slow__tool', { mcpTool: 'mcp__slow__tool', serverName: 'slow' }],
    ]);

    const result = await runAnthropicApiChat(
      'Do something',
      baseOptions({ executeTool, toolNameMap, timeoutMs: 1 }),
    );

    expect(result.timedOut).toBe(true);
  });

  it('returns with maxIterationsReached when limit is hit', async () => {
    let callCount = 0;
    const executeTool = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve(`result-${callCount}`);
    });

    // Always return tool calls (with varying IDs to avoid stuck detection)
    mockCreate.mockImplementation(() => {
      return Promise.resolve(
        makeResponse({
          content: [
            { type: 'tool_use', id: `toolu_${callCount + 1}`, name: 'srv__tool', input: { n: callCount } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      );
    });

    const toolNameMap = new Map([
      ['srv__tool', { mcpTool: 'mcp__srv__tool', serverName: 'srv' }],
    ]);

    const result = await runAnthropicApiChat(
      'Loop forever',
      baseOptions({ executeTool, toolNameMap, maxIterations: 3 }),
    );

    expect(result.maxIterationsReached).toBe(true);
    expect(result.iterations).toBe(3);
  });

  it('accumulates token counts across rounds', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');

    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'srv__tool', input: {} },
          ],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Done' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 200,
            output_tokens: 30,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 5,
          },
        }),
      );

    const toolNameMap = new Map([
      ['srv__tool', { mcpTool: 'mcp__srv__tool', serverName: 'srv' }],
    ]);

    const result = await runAnthropicApiChat(
      'Count tokens',
      baseOptions({ executeTool, toolNameMap }),
    );

    expect(result.inputTokens).toBe(300);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheReadInputTokens).toBe(130);
    expect(result.cacheCreationInputTokens).toBe(15);
  });

  it('injects skill on first tool call per server (system prompt grows)', async () => {
    const executeTool = vi.fn().mockResolvedValue('tool result');

    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'myserver__my_tool', input: {} },
          ],
          stop_reason: 'tool_use',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Done with skill' }],
          stop_reason: 'end_turn',
        }),
      );

    const toolNameMap = new Map([
      ['myserver__my_tool', { mcpTool: 'mcp__myserver__my_tool', serverName: 'myserver' }],
    ]);

    const serverSkills = new Map([
      ['myserver', 'Use this tool carefully.\nAlways verify results.'],
    ]);

    await runAnthropicApiChat(
      'Use the tool',
      baseOptions({
        executeTool,
        toolNameMap,
        serverSkills,
        systemPrompt: 'You are a helper.',
      }),
    );

    // The second messages.create call should have an expanded system prompt
    // containing the injected skill
    const secondCall = mockCreate.mock.calls[1][0];
    const systemText =
      typeof secondCall.system === 'string'
        ? secondCall.system
        : Array.isArray(secondCall.system)
          ? secondCall.system.map((b: { text: string }) => b.text).join('\n')
          : '';
    expect(systemText).toContain('<tool-instructions name="myserver">');
    expect(systemText).toContain('Use this tool carefully.');
  });

  it('detects stuck loop (3 consecutive same-tool + same-result) and aborts', async () => {
    const executeTool = vi.fn().mockResolvedValue('same result every time');

    mockCreate.mockResolvedValue(
      makeResponse({
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'srv__stuck_tool', input: { x: 1 } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
    );

    const toolNameMap = new Map([
      ['srv__stuck_tool', { mcpTool: 'mcp__srv__stuck_tool', serverName: 'srv' }],
    ]);

    const result = await runAnthropicApiChat(
      'Do the thing',
      baseOptions({ executeTool, toolNameMap, maxIterations: 20 }),
    );

    // Should abort after 3 identical iterations, not run all 20
    expect(result.iterations).toBe(3);
    expect(result.response).toContain('repeated');
  });

  it('carries existingMessages and appends new user message', async () => {
    // Capture messages at call time since the array is mutated after
    let capturedMessages: unknown[] = [];
    mockCreate.mockImplementation((params: { messages: unknown[] }) => {
      capturedMessages = [...params.messages];
      return Promise.resolve(
        makeResponse({
          content: [{ type: 'text', text: 'I remember the previous context.' }],
          stop_reason: 'end_turn',
        }),
      );
    });

    const existingMessages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi there!' },
    ];

    const result = await runAnthropicApiChat(
      'Do you remember?',
      baseOptions({ existingMessages }),
    );

    // Verify the API was called with all messages (existing + new user)
    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(capturedMessages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    expect(capturedMessages[2]).toEqual({ role: 'user', content: 'Do you remember?' });

    // Result should contain updated messages array (+ assistant reply)
    expect(result.messages).toHaveLength(4);
    expect(result.messages[3].role).toBe('assistant');
    expect(result.response).toBe('I remember the previous context.');
  });

  it('returns updated messages array for session continuity', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'First response' }],
        stop_reason: 'end_turn',
      }),
    );

    const result = await runAnthropicApiChat('First message', baseOptions());

    expect(result.messages).toHaveLength(2); // user + assistant
    expect(result.messages[0]).toEqual({ role: 'user', content: 'First message' });
    expect(result.messages[1].role).toBe('assistant');
  });

  it('auto-compacts when input tokens exceed threshold', async () => {
    // First call: returns a tool use with high token count
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Normal response' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 120_000, // exceeds 75% of 150K default
            output_tokens: 500,
          },
        }),
      )
      // Compaction summary call
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Summary: we discussed topic X and decided Y.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
      );

    const result = await runAnthropicApiChat(
      'Tell me about X',
      baseOptions({
        contextWindowSize: 150_000,
        existingMessages: [
          { role: 'user' as const, content: 'Previous long conversation...' },
          { role: 'assistant' as const, content: 'Previous long response...' },
        ],
      }),
    );

    expect(result.response).toBe('Normal response');
    // Messages should be compacted: summary + ack + the latest exchange
    expect(result.messages.length).toBeLessThan(5);
    // The first message should be the compaction summary
    const firstMsg = result.messages[0];
    expect(firstMsg.role).toBe('user');
    expect(
      typeof firstMsg.content === 'string'
        ? firstMsg.content
        : '',
    ).toContain('Summary:');
  });

  it('auto-compaction replaces messages with summary + recent exchange', async () => {
    // Build a long conversation
    const longHistory = [];
    for (let i = 0; i < 10; i++) {
      longHistory.push({ role: 'user' as const, content: `Message ${i}` });
      longHistory.push({ role: 'assistant' as const, content: `Reply ${i}` });
    }

    // Main response with high tokens
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Latest reply' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 120_000, output_tokens: 100 },
        }),
      )
      // Compaction call
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Compacted summary of conversation' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 100 },
        }),
      );

    const result = await runAnthropicApiChat(
      'Latest question',
      baseOptions({ contextWindowSize: 150_000, existingMessages: longHistory }),
    );

    // Should have: [summary, ack, last user msg, last assistant msg]
    expect(result.messages.length).toBe(4);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[1].content).toBe('Understood, continuing.');
    // Last exchange preserved
    expect(result.messages[2]).toEqual({ role: 'user', content: 'Latest question' });
    expect(result.messages[3].role).toBe('assistant');
  });

  it('handles tool execution errors gracefully', async () => {
    const executeTool = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connection refused'));

    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'srv__failing_tool', input: {} },
          ],
          stop_reason: 'tool_use',
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Tool failed, sorry.' }],
          stop_reason: 'end_turn',
        }),
      );

    const toolNameMap = new Map([
      ['srv__failing_tool', { mcpTool: 'mcp__srv__failing_tool', serverName: 'srv' }],
    ]);

    const result = await runAnthropicApiChat(
      'Try the tool',
      baseOptions({ executeTool, toolNameMap }),
    );

    expect(result.response).toBe('Tool failed, sorry.');
    // The tool result message should contain the error
    const secondCallMessages = mockCreate.mock.calls[1][0].messages;
    const toolResultMsg = secondCallMessages.find(
      (m: { role: string }) => m.role === 'user',
    );
    // Tool results go in a user message with tool_result content blocks
    expect(toolResultMsg).toBeDefined();
  });

  it('passes system prompt as content block array with cache_control', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }),
    );

    await runAnthropicApiChat(
      'Hi',
      baseOptions({
        systemPrompt: 'You are a helpful bot.',
        temperature: 0.7,
      }),
    );

    const callArgs = mockCreate.mock.calls[0][0];
    // System prompt should be a content block array with cache_control on last block
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system).toHaveLength(1);
    expect(callArgs.system[0].type).toBe('text');
    expect(callArgs.system[0].text).toBe('You are a helpful bot.');
    expect(callArgs.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(callArgs.temperature).toBe(0.7);
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
    expect(callArgs.max_tokens).toBe(4096);
  });

  it('adds cache_control to the last tool definition', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Done' }],
        stop_reason: 'end_turn',
      }),
    );

    const tools = [
      { name: 'tool_a', description: 'First', input_schema: { type: 'object' } },
      { name: 'tool_b', description: 'Second', input_schema: { type: 'object' } },
    ];

    await runAnthropicApiChat('Hi', baseOptions({ tools }));

    const callArgs = mockCreate.mock.calls[0][0];
    // Only the last tool should have cache_control
    expect(callArgs.tools[0].cache_control).toBeUndefined();
    expect(callArgs.tools[1].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('resolves short model name "haiku" to full model ID via /v1/models', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }),
    );

    await runAnthropicApiChat('Hi', baseOptions({ model: 'haiku' }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  it('resolves short model name "sonnet" to full model ID', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }),
    );

    await runAnthropicApiChat('Hi', baseOptions({ model: 'sonnet' }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-5-20250929');
  });

  it('passes through full model IDs unchanged', async () => {
    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }),
    );

    await runAnthropicApiChat(
      'Hi',
      baseOptions({ model: 'claude-3-haiku-20240307' }),
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-3-haiku-20240307');
  });

  it('falls back to static mapping when /v1/models fails', async () => {
    mockModelsList.mockRejectedValueOnce(new Error('network error'));

    mockCreate.mockResolvedValueOnce(
      makeResponse({
        content: [{ type: 'text', text: 'Hello' }],
        stop_reason: 'end_turn',
      }),
    );

    await runAnthropicApiChat('Hi', baseOptions({ model: 'haiku' }));

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  it('uses contextWindowSize for auto-compaction threshold', async () => {
    // With a small context window, even moderate tokens should trigger compaction
    mockCreate
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Response' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 8000, output_tokens: 100 }, // exceeds 75% of 10000
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          content: [{ type: 'text', text: 'Compacted' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 500, output_tokens: 100 },
        }),
      );

    const result = await runAnthropicApiChat(
      'Question',
      baseOptions({
        contextWindowSize: 10_000,
        existingMessages: [
          { role: 'user' as const, content: 'Old msg' },
          { role: 'assistant' as const, content: 'Old reply' },
        ],
      }),
    );

    // Compaction should have been triggered
    expect(result.messages.length).toBe(4); // summary + ack + last exchange
  });
});
