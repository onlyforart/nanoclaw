import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockChat = vi.fn();
const mockList = vi.fn().mockResolvedValue({ models: [] });

vi.mock('ollama', () => {
  class MockOllama {
    chat = mockChat;
    list = mockList;
    constructor(_opts: unknown) {}
  }
  return { Ollama: MockOllama };
});

import { runOllamaChat } from './ollama-chat-engine.js';

beforeEach(() => {
  mockChat.mockReset();
});

/** Wrap a chat response as a single-chunk async iterable (mimics stream: true) */
function streamOf(response: { message: { role: string; content: string | null; tool_calls?: unknown[]; thinking?: string } }) {
  return {
    async *[Symbol.asyncIterator]() {
      yield response;
    },
  };
}

function baseOptions(overrides?: Partial<Parameters<typeof runOllamaChat>[1]>) {
  return {
    host: 'http://localhost:11434',
    model: 'qwen3',
    maxIterations: 10,
    timeoutMs: 300_000,
    tools: [],
    toolNameMap: new Map(),
    executeTool: vi.fn(),
    ...overrides,
  };
}

describe('runOllamaChat', () => {
  it('returns text response when model produces no tool calls', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Hello there!', tool_calls: [] },
    }));

    const result = await runOllamaChat('Hi', baseOptions());

    expect(result.response).toBe('Hello there!');
    expect(result.iterations).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.maxIterationsReached).toBe(false);
  });

  it('passes model to Ollama chat call', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'ok' },
    }));

    await runOllamaChat('test', baseOptions({ model: 'mistral' }));

    expect(mockChat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'mistral' }),
    );
  });

  it('includes system prompt in messages when provided', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'ok' },
    }));

    await runOllamaChat('test', baseOptions({
      systemPrompt: 'You are a pirate.',
    }));

    const callArgs = mockChat.mock.calls[0][0];
    expect(callArgs.messages[0]).toEqual({
      role: 'system',
      content: 'You are a pirate.',
    });
  });

  it('adds tool-usage instruction when tools are provided', async () => {
    const tools = [{
      type: 'function' as const,
      function: {
        name: 'my_tool',
        description: 'Does stuff',
        parameters: { type: 'object', properties: {} },
      },
    }];

    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'done' },
    }));

    await runOllamaChat('test', baseOptions({ tools }));

    const callArgs = mockChat.mock.calls[0][0];
    const systemMsg = callArgs.messages.find(
      (m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('my_tool'),
    );
    expect(systemMsg).toBeDefined();
    expect(callArgs.tools).toEqual(tools);
  });

  it('executes tool calls and loops back to model', async () => {
    const executeTool = vi.fn().mockResolvedValue('tool result text');

    const toolNameMap = new Map([
      ['server__my_tool', { mcpTool: 'mcp__server__my_tool', serverName: 'server' }],
    ]);

    // First call: model wants to call a tool
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'server__my_tool', arguments: { query: 'test' } } },
        ],
      },
    }));

    // Second call: model produces final response
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Here is the answer.' },
    }));

    const result = await runOllamaChat('look up test', baseOptions({
      toolNameMap,
      executeTool,
    }));

    expect(executeTool).toHaveBeenCalledWith('mcp__server__my_tool', { query: 'test' });
    expect(result.response).toBe('Here is the answer.');
    expect(result.iterations).toBe(2);
  });

  it('logs tool result to stderr', async () => {
    const executeTool = vi.fn().mockResolvedValue('the tool output data');
    const toolNameMap = new Map([
      ['server__my_tool', { mcpTool: 'mcp__server__my_tool', serverName: 'server' }],
    ]);

    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'server__my_tool', arguments: {} } },
        ],
      },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'done' },
    }));

    const stderrSpy = vi.spyOn(console, 'error');
    await runOllamaChat('test', baseOptions({ executeTool, toolNameMap }));

    const resultLog = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Tool result:'),
    );
    expect(resultLog).toBeDefined();
    expect(resultLog![0]).toContain('the tool output data');
    stderrSpy.mockRestore();
  });

  it('truncates long tool results in log', async () => {
    const longResult = 'x'.repeat(3000);
    const executeTool = vi.fn().mockResolvedValue(longResult);
    const toolNameMap = new Map([
      ['server__my_tool', { mcpTool: 'mcp__server__my_tool', serverName: 'server' }],
    ]);

    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'server__my_tool', arguments: {} } },
        ],
      },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'done' },
    }));

    const stderrSpy = vi.spyOn(console, 'error');
    await runOllamaChat('test', baseOptions({ executeTool, toolNameMap }));

    const resultLog = stderrSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('Tool result:'),
    );
    expect(resultLog).toBeDefined();
    // Should be truncated with ... indicator
    expect(resultLog![0].length).toBeLessThan(3000);
    expect(resultLog![0]).toContain('...');
    stderrSpy.mockRestore();
  });

  it('handles tool execution errors gracefully', async () => {
    const executeTool = vi.fn().mockRejectedValue(new Error('connection refused'));

    // Model calls a tool
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'broken_tool', arguments: {} } },
        ],
      },
    }));

    // Model receives error and produces a response
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Sorry, the tool failed.' },
    }));

    const result = await runOllamaChat('do something', baseOptions({ executeTool }));

    expect(result.response).toBe('Sorry, the tool failed.');
    // The error message should have been fed back as a tool message
    expect(mockChat.mock.calls[1][0].messages).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: expect.stringContaining('connection refused'),
      }),
    );
  });

  it('stops at maxIterations limit', async () => {
    // Model keeps calling tools forever (different results each time to avoid repeat detection)
    mockChat.mockResolvedValue(streamOf({
      message: {
        role: 'assistant',
        content: 'thinking...',
        tool_calls: [
          { function: { name: 'some_tool', arguments: {} } },
        ],
      },
    }));

    let callCount = 0;
    const executeTool = vi.fn().mockImplementation(async () => `result-${++callCount}`);

    const result = await runOllamaChat('loop', baseOptions({
      maxIterations: 3,
      executeTool,
    }));

    expect(result.maxIterationsReached).toBe(true);
    expect(result.iterations).toBe(3);
    expect(result.response).toBe('thinking...');
  });

  it('stops at timeout', async () => {
    // Simulate time passing by making chat take a long time
    vi.useFakeTimers();
    const realDateNow = Date.now;

    let callCount = 0;
    mockChat.mockImplementation(async () => {
      callCount++;
      // After first call, advance time past timeout
      if (callCount === 1) {
        vi.setSystemTime(realDateNow() + 400_000);
      }
      return streamOf({
        message: {
          role: 'assistant',
          content: 'partial',
          tool_calls: [{ function: { name: 'tool', arguments: {} } }],
        },
      });
    });

    const executeTool = vi.fn().mockResolvedValue('ok');

    const result = await runOllamaChat('test', baseOptions({
      timeoutMs: 300_000,
      executeTool,
    }));

    expect(result.timedOut).toBe(true);
    expect(result.response).toBe('partial');

    vi.useRealTimers();
  });

  it('returns empty string when model produces null content', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: null },
    }));

    const result = await runOllamaChat('test', baseOptions());
    expect(result.response).toBe('');
  });

  it('calls onStatus callback during execution', async () => {
    const onStatus = vi.fn();

    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'done' },
    }));

    await runOllamaChat('test', baseOptions({ onStatus }));

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('qwen3'));
  });

  describe('argument normalization', () => {
    it('passes object arguments directly to executeTool', async () => {
      const executeTool = vi.fn().mockResolvedValue('ok');
      const toolNameMap = new Map([
        ['srv__tool', { mcpTool: 'mcp__srv__tool', serverName: 'srv' }],
      ]);

      mockChat.mockResolvedValueOnce(streamOf({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'srv__tool', arguments: { cluster: 'staging', count: 3 } } },
          ],
        },
      }));
      mockChat.mockResolvedValueOnce(streamOf({
        message: { role: 'assistant', content: 'done' },
      }));

      await runOllamaChat('test', baseOptions({ executeTool, toolNameMap }));

      expect(executeTool).toHaveBeenCalledWith('mcp__srv__tool', { cluster: 'staging', count: 3 });
    });

    it('parses string arguments (double-encoded JSON from model)', async () => {
      const executeTool = vi.fn().mockResolvedValue('ok');
      const toolNameMap = new Map([
        ['srv__tool', { mcpTool: 'mcp__srv__tool', serverName: 'srv' }],
      ]);

      mockChat.mockResolvedValueOnce(streamOf({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            // Model returned arguments as a JSON string instead of an object
            { function: { name: 'srv__tool', arguments: '{"cluster":"staging","namespace":"test"}' } },
          ],
        },
      }));
      mockChat.mockResolvedValueOnce(streamOf({
        message: { role: 'assistant', content: 'done' },
      }));

      await runOllamaChat('test', baseOptions({ executeTool, toolNameMap }));

      expect(executeTool).toHaveBeenCalledWith('mcp__srv__tool', { cluster: 'staging', namespace: 'test' });
    });

    it('falls back to empty object for unparseable string arguments', async () => {
      const executeTool = vi.fn().mockResolvedValue('ok');

      mockChat.mockResolvedValueOnce(streamOf({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'some_tool', arguments: 'not valid json{' } },
          ],
        },
      }));
      mockChat.mockResolvedValueOnce(streamOf({
        message: { role: 'assistant', content: 'done' },
      }));

      await runOllamaChat('test', baseOptions({ executeTool }));

      expect(executeTool).toHaveBeenCalledWith('some_tool', {});
    });

    it('falls back to empty object for null/undefined arguments', async () => {
      const executeTool = vi.fn().mockResolvedValue('ok');

      mockChat.mockResolvedValueOnce(streamOf({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'some_tool', arguments: null } },
          ],
        },
      }));
      mockChat.mockResolvedValueOnce(streamOf({
        message: { role: 'assistant', content: 'done' },
      }));

      await runOllamaChat('test', baseOptions({ executeTool }));

      expect(executeTool).toHaveBeenCalledWith('some_tool', {});
    });
  });
});

describe('tool call nudge', () => {
  it('nudges model once when it produces text after a tool call without making further tool calls', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
      ['srv__notify', { mcpTool: 'mcp__srv__notify', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'srv__notify', description: 'Notify', parameters: { type: 'object', properties: {} } } },
    ];

    // Round 1: model calls check tool
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: model produces text without calling notify (should trigger nudge)
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: ':warning: something is wrong' },
    }));
    // Round 3 (after nudge): model calls notify
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'srv__notify', arguments: { text: 'alert' } } }],
      },
    }));
    // Round 4: final response
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: ':warning: something is wrong' },
    }));

    const result = await runOllamaChat('check and notify if bad', baseOptions({
      tools,
      toolNameMap,
      executeTool,
    }));

    // Should have called both tools
    expect(executeTool).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledWith('mcp__srv__check', {});
    expect(executeTool).toHaveBeenCalledWith('mcp__srv__notify', { text: 'alert' });
    // Nudge message should be in the messages sent to round 3
    const round3Messages = mockChat.mock.calls[2][0].messages;
    const nudgeMsg = round3Messages.find(
      (m: { role: string; content: string }) =>
        m.role === 'user' && m.content.includes('next tool'),
    );
    expect(nudgeMsg).toBeDefined();
  });

  it('does not nudge when no tools are available', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Just a text response' },
    }));

    const result = await runOllamaChat('hello', baseOptions());

    expect(result.response).toBe('Just a text response');
    expect(result.iterations).toBe(1);
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when model never made any tool calls', async () => {
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
    ];

    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'I can answer without tools' },
    }));

    const result = await runOllamaChat('hello', baseOptions({ tools }));

    expect(result.response).toBe('I can answer without tools');
    expect(mockChat).toHaveBeenCalledTimes(1);
  });

  it('does not nudge when response looks healthy (no warning indicators)', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'srv__notify', description: 'Notify', parameters: { type: 'object', properties: {} } } },
    ];

    // Round 1: tool call
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: healthy result text — should NOT nudge
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: ':white_check_mark: All systems healthy' },
    }));

    const result = await runOllamaChat('check stuff', baseOptions({
      tools,
      toolNameMap,
      executeTool,
    }));

    expect(result.response).toBe(':white_check_mark: All systems healthy');
    // 2 rounds only: tool call, then final text (no nudge)
    expect(mockChat).toHaveBeenCalledTimes(2);
  });

  it('only nudges once to prevent infinite loops', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'srv__notify', description: 'Notify', parameters: { type: 'object', properties: {} } } },
    ];

    // Round 1: tool call
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: warning text (triggers nudge)
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: ':warning: something is degraded' },
    }));
    // Round 3 (after nudge): still just text (should NOT nudge again)
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: ':warning: final report' },
    }));

    const result = await runOllamaChat('check stuff', baseOptions({
      tools,
      toolNameMap,
      executeTool,
    }));

    expect(result.response).toBe(':warning: final report');
    // 3 rounds: tool call, text+nudge, final text
    expect(mockChat).toHaveBeenCalledTimes(3);
  });
});

describe('lazy skill injection', () => {
  it('injects skill content as system message on first tool call from a server', async () => {
    const executeTool = vi.fn().mockResolvedValue('{"pods": []}');
    const toolNameMap = new Map([
      ['eks-kubectl__list_pods', { mcpTool: 'mcp__eks-kubectl__list_pods', serverName: 'eks-kubectl' }],
    ]);
    const serverSkills = new Map([
      ['eks-kubectl', '# EKS kubectl\nUse these tools for cluster ops.'],
    ]);

    // Round 1: model calls a tool
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'eks-kubectl__list_pods', arguments: { cluster: 'prod', namespace: 'default' } } },
        ],
      },
    }));
    // Round 2: model returns final text
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Here are the pods.' },
    }));

    await runOllamaChat('list pods in prod', {
      ...baseOptions({ executeTool, toolNameMap }),
      serverSkills,
    });

    // The second ollama.chat call should include a system message with the skill
    const secondCallMessages = mockChat.mock.calls[1][0].messages;
    const skillMessages = secondCallMessages.filter(
      (m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('EKS kubectl'),
    );
    expect(skillMessages).toHaveLength(1);
    expect(skillMessages[0].content).toContain('Use these tools for cluster ops');
    // Should be wrapped in XML-style delimiters
    expect(skillMessages[0].content).toContain('<tool-instructions name="eks-kubectl">');
    expect(skillMessages[0].content).toContain('</tool-instructions>');
  });

  it('does not inject skill content more than once for the same server', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['eks-kubectl__list_pods', { mcpTool: 'mcp__eks-kubectl__list_pods', serverName: 'eks-kubectl' }],
    ]);
    const serverSkills = new Map([
      ['eks-kubectl', 'EKS skill content'],
    ]);

    // Round 1: tool call
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'eks-kubectl__list_pods', arguments: { cluster: 'prod', namespace: 'default' } } },
        ],
      },
    }));
    // Round 2: another tool call from same server
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'eks-kubectl__list_pods', arguments: { cluster: 'prod', namespace: 'kube-system' } } },
        ],
      },
    }));
    // Round 3: final text
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Done.' },
    }));

    await runOllamaChat('check all pods', {
      ...baseOptions({ executeTool, toolNameMap }),
      serverSkills,
    });

    // Count skill system messages across all messages in the third call
    const thirdCallMessages = mockChat.mock.calls[2][0].messages;
    const skillMessages = thirdCallMessages.filter(
      (m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('EKS skill content'),
    );
    expect(skillMessages).toHaveLength(1);
  });

  it('does not inject any skill when serverSkills is not provided', async () => {
    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['eks-kubectl__list_pods', { mcpTool: 'mcp__eks-kubectl__list_pods', serverName: 'eks-kubectl' }],
    ]);

    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'eks-kubectl__list_pods', arguments: { cluster: 'prod', namespace: 'default' } } },
        ],
      },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Done.' },
    }));

    await runOllamaChat('list pods', baseOptions({ executeTool, toolNameMap }));

    const secondCallMessages = mockChat.mock.calls[1][0].messages;
    const skillMessages = secondCallMessages.filter(
      (m: { role: string; content: string }) =>
        m.role === 'system' && !m.content.includes('tool-calling capabilities'),
    );
    // Only the initial system messages (no extra skill injection)
    // No serverSkills passed, so no skill system messages should appear beyond the originals
    expect(skillMessages.every(
      (m: { content: string }) => !m.content.includes('EKS') && !m.content.includes('skill'),
    )).toBe(true);
  });

  it('injects skill before tool result so model has context for interpretation', async () => {
    const executeTool = vi.fn().mockResolvedValue('{"pods": []}');
    const toolNameMap = new Map([
      ['eks-kubectl__list_pods', { mcpTool: 'mcp__eks-kubectl__list_pods', serverName: 'eks-kubectl' }],
    ]);
    const serverSkills = new Map([
      ['eks-kubectl', 'SKILL: interpret pod status carefully'],
    ]);

    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'eks-kubectl__list_pods', arguments: { cluster: 'prod', namespace: 'default' } } },
        ],
      },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Pods look healthy.' },
    }));

    await runOllamaChat('check pods', {
      ...baseOptions({ executeTool, toolNameMap }),
      serverSkills,
    });

    const secondCallMessages = mockChat.mock.calls[1][0].messages;
    const skillIdx = secondCallMessages.findIndex(
      (m: { role: string; content: string }) =>
        m.role === 'system' && m.content.includes('SKILL:'),
    );
    const toolResultIdx = secondCallMessages.findIndex(
      (m: { role: string }) => m.role === 'tool',
    );

    expect(skillIdx).toBeGreaterThan(-1);
    expect(toolResultIdx).toBeGreaterThan(-1);
    expect(skillIdx).toBeLessThan(toolResultIdx);
  });
});

describe('repeated tool failure detection', () => {
  it('breaks out early when same tool returns same result 3 times in a row', async () => {
    const executeTool = vi.fn().mockResolvedValue('HTTP 404 Not Found');
    const toolNameMap = new Map([
      ['web-fetch__web_fetch', { mcpTool: 'mcp__web-fetch__web_fetch', serverName: 'web-fetch' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'web-fetch__web_fetch', description: 'Fetch a URL', parameters: { type: 'object', properties: {} } } },
    ];

    // Model calls web_fetch every round with the same result
    mockChat.mockResolvedValue(streamOf({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'web-fetch__web_fetch', arguments: { url: 'https://example.com/foo' } } }],
      },
    }));

    const result = await runOllamaChat('list your tools', baseOptions({
      tools,
      toolNameMap,
      executeTool,
      maxIterations: 10,
    }));

    // Should stop after 3 rounds, not 10
    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(result.response).toContain('repeated');
    expect(result.maxIterationsReached).toBe(false);
  });

  it('does not break when same tool returns different results each time', async () => {
    let callNum = 0;
    const executeTool = vi.fn().mockImplementation(async () => {
      callNum++;
      return `Result ${callNum}`;
    });
    const toolNameMap = new Map([
      ['srv__query', { mcpTool: 'mcp__srv__query', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__query', description: 'Query', parameters: { type: 'object', properties: {} } } },
    ];

    // 4 rounds of tool calls with different results, then final text
    for (let i = 0; i < 4; i++) {
      mockChat.mockResolvedValueOnce(streamOf({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'srv__query', arguments: {} } }],
        },
      }));
    }
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'All done.' },
    }));

    const result = await runOllamaChat('query 4 things', baseOptions({
      tools,
      toolNameMap,
      executeTool,
      maxIterations: 10,
    }));

    expect(executeTool).toHaveBeenCalledTimes(4);
    expect(result.response).toBe('All done.');
  });

  it('does not break when different tools return the same result', async () => {
    const executeTool = vi.fn().mockResolvedValue('HTTP 404 Not Found');
    const toolNameMap = new Map([
      ['srv__tool_a', { mcpTool: 'mcp__srv__tool_a', serverName: 'srv' }],
      ['srv__tool_b', { mcpTool: 'mcp__srv__tool_b', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__tool_a', description: 'Tool A', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'srv__tool_b', description: 'Tool B', parameters: { type: 'object', properties: {} } } },
    ];

    // Alternating tools with same result
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__tool_a', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__tool_b', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__tool_a', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Gave up.' },
    }));

    const result = await runOllamaChat('try stuff', baseOptions({
      tools,
      toolNameMap,
      executeTool,
      maxIterations: 10,
    }));

    expect(executeTool).toHaveBeenCalledTimes(3);
    expect(result.response).toBe('Gave up.');
  });

  it('resets streak when a different tool is called mid-streak', async () => {
    const executeTool = vi.fn().mockResolvedValue('HTTP 404 Not Found');
    const toolNameMap = new Map([
      ['srv__fetch', { mcpTool: 'mcp__srv__fetch', serverName: 'srv' }],
      ['srv__other', { mcpTool: 'mcp__srv__other', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__fetch', description: 'Fetch', parameters: { type: 'object', properties: {} } } },
      { type: 'function' as const, function: { name: 'srv__other', description: 'Other', parameters: { type: 'object', properties: {} } } },
    ];

    // fetch x2, then other, then fetch x3 (should trigger on the 3rd consecutive fetch)
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__fetch', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__fetch', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__other', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__fetch', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__fetch', arguments: {} } }] },
    }));
    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'srv__fetch', arguments: {} } }] },
    }));

    const result = await runOllamaChat('try stuff', baseOptions({
      tools,
      toolNameMap,
      executeTool,
      maxIterations: 10,
    }));

    // 2 + 1 + 3 = 6 tool calls (breaks on the 3rd consecutive fetch after reset)
    expect(executeTool).toHaveBeenCalledTimes(6);
    expect(result.response).toContain('repeated');
  });
});

describe('thinking model support', () => {
  it('uses thinking as content when model returns empty content and no tool calls', async () => {
    // Round 1: tool call with thinking (thinking should NOT become content)
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        thinking: 'Let me call the check tool first.',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: final response with thinking but empty content, no tool calls
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        thinking: 'All good. The answer is: healthy.',
      },
    }));

    const executeTool = vi.fn().mockResolvedValue('{"status":"ok"}');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
    ];

    const result = await runOllamaChat('check status', baseOptions({
      tools,
      toolNameMap,
      executeTool,
    }));

    expect(result.response).toBe('All good. The answer is: healthy.');
    expect(result.iterations).toBe(2);
  });

  it('does not inject thinking into content when tool calls are present', async () => {
    // Round 1: tool call with thinking
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        thinking: 'I should call the tool.',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: normal content response
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: 'Everything is fine.',
      },
    }));

    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
    ];

    const result = await runOllamaChat('check', baseOptions({
      tools,
      toolNameMap,
      executeTool,
    }));

    // Round 2's content should be the response, not round 1's thinking
    expect(result.response).toBe('Everything is fine.');

    // Verify thinking was NOT injected into the assistant message sent to model in round 2
    const round2Messages = mockChat.mock.calls[1][0].messages;
    const assistantMsg = round2Messages.find(
      (m: { role: string; content: string; tool_calls?: unknown[] }) =>
        m.role === 'assistant' && m.tool_calls,
    );
    // The assistant message with tool_calls should have empty content, not thinking
    expect(assistantMsg.content).toBe('');
  });

  it('calls onThinking callback each round with thinking content', async () => {
    const onThinking = vi.fn();

    // Round 1: thinking with tool call
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        thinking: 'Round 1 reasoning',
        tool_calls: [{ function: { name: 'srv__check', arguments: {} } }],
      },
    }));
    // Round 2: thinking with final answer
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: '',
        thinking: 'Round 2 reasoning with answer',
      },
    }));

    const executeTool = vi.fn().mockResolvedValue('ok');
    const toolNameMap = new Map([
      ['srv__check', { mcpTool: 'mcp__srv__check', serverName: 'srv' }],
    ]);
    const tools = [
      { type: 'function' as const, function: { name: 'srv__check', description: 'Check', parameters: { type: 'object', properties: {} } } },
    ];

    await runOllamaChat('check', baseOptions({
      tools,
      toolNameMap,
      executeTool,
      onThinking,
    }));

    expect(onThinking).toHaveBeenCalledTimes(2);
    expect(onThinking).toHaveBeenCalledWith('Round 1 reasoning');
    expect(onThinking).toHaveBeenCalledWith('Round 2 reasoning with answer');
  });

  it('does not call onThinking when model returns no thinking', async () => {
    const onThinking = vi.fn();

    mockChat.mockResolvedValueOnce(streamOf({
      message: { role: 'assistant', content: 'Just a normal response' },
    }));

    await runOllamaChat('hello', baseOptions({ onThinking }));

    expect(onThinking).not.toHaveBeenCalled();
  });

  it('prefers content over thinking when both are present and no tool calls', async () => {
    mockChat.mockResolvedValueOnce(streamOf({
      message: {
        role: 'assistant',
        content: 'The actual answer',
        thinking: 'Some internal reasoning',
      },
    }));

    const onThinking = vi.fn();
    const result = await runOllamaChat('test', baseOptions({ onThinking }));

    expect(result.response).toBe('The actual answer');
    // Thinking callback still fires
    expect(onThinking).toHaveBeenCalledWith('Some internal reasoning');
  });
});

describe('resolveOllamaModel', () => {
  it('returns exact match when model name matches', async () => {
    const { resolveOllamaModel } = await import('./ollama-chat-engine.js');

    const resolved = resolveOllamaModel('mistral-small3.2', [
      'mistral-small3.2:latest',
      'qwen3:latest',
    ]);
    expect(resolved).toBe('mistral-small3.2:latest');
  });

  it('matches prefix (e.g. "mistral" matches "mistral-small3.2:latest")', async () => {
    const { resolveOllamaModel } = await import('./ollama-chat-engine.js');

    const resolved = resolveOllamaModel('mistral', [
      'mistral-small3.2:latest',
      'qwen3:latest',
    ]);
    expect(resolved).toBe('mistral-small3.2:latest');
  });

  it('returns original name when no match found', async () => {
    const { resolveOllamaModel } = await import('./ollama-chat-engine.js');

    const resolved = resolveOllamaModel('llama3', [
      'mistral-small3.2:latest',
      'qwen3:latest',
    ]);
    expect(resolved).toBe('llama3');
  });

  it('prefers exact name match over prefix match', async () => {
    const { resolveOllamaModel } = await import('./ollama-chat-engine.js');

    const resolved = resolveOllamaModel('mistral', [
      'mistral:latest',
      'mistral-small3.2:latest',
    ]);
    expect(resolved).toBe('mistral:latest');
  });

  it('handles model names with tags', async () => {
    const { resolveOllamaModel } = await import('./ollama-chat-engine.js');

    const resolved = resolveOllamaModel('qwen3', [
      'qwen3:14b',
      'qwen3:latest',
    ]);
    // Should match the first one found
    expect(resolved).toMatch(/^qwen3:/);
  });
});
