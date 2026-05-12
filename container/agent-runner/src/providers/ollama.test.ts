import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockRunOllamaChat = mock();

mock.module('../ollama-chat-engine.js', () => ({
  runOllamaChat: mockRunOllamaChat,
}));

const mockExecutorInitialize = mock();
const mockExecutorClose = mock();
const mockExecutorGetTools = mock();
const mockExecutorGetMap = mock();

mock.module('../mcp-tool-executor.js', () => ({
  McpToolExecutor: class {
    initialize = mockExecutorInitialize;
    close = mockExecutorClose;
    getOllamaTools = mockExecutorGetTools;
    getToolNameMap = mockExecutorGetMap;
    getAnthropicTools = mock().mockReturnValue([]);
    callTool = mock().mockResolvedValue('tool result');
  },
}));

// Dynamic import — static `import` would be hoisted above the mock.module
// calls, capturing the real McpToolExecutor before the mock takes effect.
const { OllamaProvider } = await import('./ollama.js');
import type { ProviderEvent } from './types.js';

beforeEach(() => {
  mockRunOllamaChat.mockReset();
  mockExecutorInitialize.mockReset().mockResolvedValue(undefined);
  mockExecutorClose.mockReset().mockResolvedValue(undefined);
  mockExecutorGetTools.mockReset().mockReturnValue([]);
  mockExecutorGetMap.mockReset().mockReturnValue(new Map());
});

async function collectEvents(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const e of events) {
    collected.push(e);
  }
  return collected;
}

describe('OllamaProvider', () => {
  it('runs a single-turn query and emits init → result', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'hello back',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 10,
      outputTokens: 5,
    });

    const provider = new OllamaProvider({ mcpServers: {}, env: {} });
    const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
    query.end();

    const events = await collectEvents(query.events);
    const init = events.find((e) => e.type === 'init');
    const result = events.find((e) => e.type === 'result');
    expect(init).toBeDefined();
    expect((init as { continuation: string }).continuation).toMatch(/^ollama-/);
    expect((result as { text: string | null }).text).toBe('hello back');
  });

  it('uses input.model override when provided', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
    });

    const provider = new OllamaProvider({ env: { OLLAMA_MODEL: 'default-model' } });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'ollama:override-model' });
    query.end();
    await collectEvents(query.events);

    expect(mockRunOllamaChat).toHaveBeenCalled();
    const opts = mockRunOllamaChat.mock.calls[0][1];
    expect(opts.model).toBe('override-model');
  });

  it('strips ollama-remote: prefix and routes to remote host', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
    });

    const provider = new OllamaProvider({
      env: { OLLAMA_HOST: 'http://local', OLLAMA_REMOTE_HOST: 'https://remote' },
    });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'ollama-remote:qwen3' });
    query.end();
    await collectEvents(query.events);

    const opts = mockRunOllamaChat.mock.calls[0][1];
    expect(opts.model).toBe('qwen3');
    expect(opts.host).toBe('https://remote');
  });

  it('falls back to local host for ollama: prefix', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
    });

    const provider = new OllamaProvider({ env: { OLLAMA_HOST: 'http://local' } });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'ollama:qwen3' });
    query.end();
    await collectEvents(query.events);

    const opts = mockRunOllamaChat.mock.calls[0][1];
    expect(opts.host).toBe('http://local');
  });

  it('processes a follow-up via push() with a fresh engine call', async () => {
    mockRunOllamaChat
      .mockResolvedValueOnce({
        response: 'first response',
        iterations: 1,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: 0,
        outputTokens: 0,
      })
      .mockResolvedValueOnce({
        response: 'second response',
        iterations: 1,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: 0,
        outputTokens: 0,
      });

    const provider = new OllamaProvider({ env: {} });
    const query = provider.query({ prompt: 'first', cwd: '/workspace/agent' });

    // Drain init + first result, then push, then drain second result
    const collected: ProviderEvent[] = [];
    let pushed = false;
    for await (const event of query.events) {
      collected.push(event);
      if (event.type === 'result' && !pushed) {
        pushed = true;
        query.push('second');
        query.end();
      }
    }

    const results = collected.filter((e) => e.type === 'result') as Array<{ type: 'result'; text: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('first response');
    expect(results[1].text).toBe('second response');
    expect(mockRunOllamaChat).toHaveBeenCalledTimes(2);
    // Second call should receive the pushed text as user message
    expect(mockRunOllamaChat.mock.calls[1][0]).toBe('second');
  });

  it('passes systemContext.instructions through to the engine', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
    });

    const provider = new OllamaProvider({});
    const query = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'You are nanopaul.' },
    });
    query.end();
    await collectEvents(query.events);

    const opts = mockRunOllamaChat.mock.calls[0][1];
    expect(opts.systemPrompt).toBe('You are nanopaul.');
  });

  it('emits an error event when the engine throws', async () => {
    mockRunOllamaChat.mockRejectedValueOnce(new Error('connection refused'));

    const provider = new OllamaProvider({});
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    query.end();

    const events = await collectEvents(query.events);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toContain('connection refused');
  });

  it('initializes McpToolExecutor with provided mcpServers and closes it on completion', async () => {
    mockRunOllamaChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
    });

    const provider = new OllamaProvider({
      mcpServers: {
        srv: { type: 'stdio', command: 'bun', args: ['run', 'mcp.ts'], env: {} },
      },
    });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const collected: ProviderEvent[] = [];
    for await (const event of query.events) {
      collected.push(event);
      if (event.type === 'result') query.end();
    }

    expect(mockExecutorInitialize.mock.calls.length).toBe(1);
    expect(mockExecutorClose.mock.calls.length).toBe(1);
    const initArgs = mockExecutorInitialize.mock.calls[0][0];
    expect(initArgs.srv.command).toBe('bun');
    expect(initArgs.srv.tools).toBeUndefined();
  });

  it('isSessionInvalid always returns false (engines have no persistent session)', () => {
    const provider = new OllamaProvider({});
    expect(provider.isSessionInvalid(new Error('whatever'))).toBe(false);
  });

  it('supportsNativeSlashCommands is false', () => {
    const provider = new OllamaProvider({});
    expect(provider.supportsNativeSlashCommands).toBe(false);
  });
});
