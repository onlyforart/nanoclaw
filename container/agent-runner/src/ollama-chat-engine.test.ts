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
function streamOf(response: { message: { role: string; content: string | null; tool_calls?: unknown[] } }) {
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
    // Model keeps calling tools forever
    mockChat.mockResolvedValue(streamOf({
      message: {
        role: 'assistant',
        content: 'thinking...',
        tool_calls: [
          { function: { name: 'some_tool', arguments: {} } },
        ],
      },
    }));

    const executeTool = vi.fn().mockResolvedValue('ok');

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
