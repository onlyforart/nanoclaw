import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockRunAnthropicApiChat = mock();

mock.module('../anthropic-api-engine.js', () => ({
  runAnthropicApiChat: mockRunAnthropicApiChat,
}));

const mockExecutorInitialize = mock();
const mockExecutorClose = mock();
const mockExecutorGetTools = mock();
const mockExecutorGetMap = mock();

mock.module('../mcp-tool-executor.js', () => ({
  McpToolExecutor: class {
    initialize = mockExecutorInitialize;
    close = mockExecutorClose;
    getAnthropicTools = mockExecutorGetTools;
    getOllamaTools = mock().mockReturnValue([]);
    getToolNameMap = mockExecutorGetMap;
    callTool = mock().mockResolvedValue('tool result');
  },
}));

// Dynamic import — same pattern as ollama.test.ts: static import would be
// hoisted above the mock.module calls and capture the real executor.
const { AnthropicApiProvider } = await import('./anthropic-api.js');
import type { ProviderEvent } from './types.js';

beforeEach(() => {
  mockRunAnthropicApiChat.mockReset();
  mockExecutorInitialize.mockReset().mockResolvedValue(undefined);
  mockExecutorClose.mockReset().mockResolvedValue(undefined);
  mockExecutorGetTools.mockReset().mockReturnValue([]);
  mockExecutorGetMap.mockReset().mockReturnValue(new Map());
});

async function drainUntilResult(query: { events: AsyncIterable<ProviderEvent>; end: () => void }): Promise<ProviderEvent[]> {
  const collected: ProviderEvent[] = [];
  for await (const event of query.events) {
    collected.push(event);
    if (event.type === 'result') query.end();
  }
  return collected;
}

describe('AnthropicApiProvider', () => {
  it('runs a single-turn query and emits init → result', async () => {
    mockRunAnthropicApiChat.mockResolvedValueOnce({
      response: 'the answer is 42',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messages: [
        { role: 'user' as const, content: 'q' },
        { role: 'assistant' as const, content: 'the answer is 42' },
      ],
    });

    const provider = new AnthropicApiProvider({});
    const query = provider.query({ prompt: 'q', cwd: '/workspace/agent' });
    const events = await drainUntilResult(query);

    const init = events.find((e) => e.type === 'init');
    const result = events.find((e) => e.type === 'result');
    expect(init).toBeDefined();
    expect((init as { continuation: string }).continuation).toMatch(/^anthropic-api-/);
    expect((result as { text: string | null }).text).toBe('the answer is 42');
  });

  it('uses input.model override when provided', async () => {
    mockRunAnthropicApiChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messages: [],
    });

    const provider = new AnthropicApiProvider({ env: { ANTHROPIC_API_MODEL: 'default-model' } });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'anthropic:override-model' });
    await drainUntilResult(query);

    const opts = mockRunAnthropicApiChat.mock.calls[0][1];
    expect(opts.model).toBe('override-model');
  });

  it('strips claude: prefix from input.model', async () => {
    mockRunAnthropicApiChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messages: [],
    });

    const provider = new AnthropicApiProvider({});
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'claude:haiku' });
    await drainUntilResult(query);

    const opts = mockRunAnthropicApiChat.mock.calls[0][1];
    expect(opts.model).toBe('haiku');
  });

  it('threads existingMessages through follow-up turns', async () => {
    const messagesAfterTurn1 = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'first response' },
    ];
    const messagesAfterTurn2 = [
      ...messagesAfterTurn1,
      { role: 'user' as const, content: 'second' },
      { role: 'assistant' as const, content: 'second response' },
    ];

    mockRunAnthropicApiChat
      .mockResolvedValueOnce({
        response: 'first response',
        iterations: 1,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        messages: messagesAfterTurn1,
      })
      .mockResolvedValueOnce({
        response: 'second response',
        iterations: 1,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        messages: messagesAfterTurn2,
      });

    const provider = new AnthropicApiProvider({});
    const query = provider.query({ prompt: 'first', cwd: '/workspace/agent' });

    const collected: ProviderEvent[] = [];
    let pushed = false;
    for await (const event of query.events) {
      collected.push(event);
      if (event.type === 'result' && !pushed) {
        pushed = true;
        query.push('second');
      } else if (event.type === 'result' && pushed) {
        query.end();
      }
    }

    const results = collected.filter((e) => e.type === 'result') as Array<{ type: 'result'; text: string }>;
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('first response');
    expect(results[1].text).toBe('second response');

    // Second engine call must include the prior turn's messages as existingMessages
    const secondCallOpts = mockRunAnthropicApiChat.mock.calls[1][1];
    expect(secondCallOpts.existingMessages).toEqual(messagesAfterTurn1);
  });

  it('passes systemContext.instructions through to the engine', async () => {
    mockRunAnthropicApiChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messages: [],
    });

    const provider = new AnthropicApiProvider({});
    const query = provider.query({
      prompt: 'hi',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'You are nanopaul.' },
    });
    await drainUntilResult(query);

    const opts = mockRunAnthropicApiChat.mock.calls[0][1];
    expect(opts.systemPrompt).toBe('You are nanopaul.');
  });

  it('emits an error event when the engine throws', async () => {
    mockRunAnthropicApiChat.mockRejectedValueOnce(new Error('upstream 500'));

    const provider = new AnthropicApiProvider({});
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const events = await drainUntilResult(query);

    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toContain('upstream 500');
  });

  it('initializes McpToolExecutor with provided mcpServers (tools omitted → discover-all)', async () => {
    mockRunAnthropicApiChat.mockResolvedValueOnce({
      response: 'ok',
      iterations: 1,
      timedOut: false,
      maxIterationsReached: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      messages: [],
    });

    const provider = new AnthropicApiProvider({
      mcpServers: {
        srv: { type: 'http', url: 'https://example.com/mcp' },
      },
    });
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    await drainUntilResult(query);

    expect(mockExecutorInitialize.mock.calls.length).toBe(1);
    expect(mockExecutorClose.mock.calls.length).toBe(1);
    const initArgs = mockExecutorInitialize.mock.calls[0][0];
    expect(initArgs.srv.type).toBe('http');
    expect(initArgs.srv.url).toBe('https://example.com/mcp');
    expect(initArgs.srv.tools).toBeUndefined();
  });

  it('isSessionInvalid always returns false', () => {
    const provider = new AnthropicApiProvider({});
    expect(provider.isSessionInvalid(new Error('whatever'))).toBe(false);
  });

  it('supportsNativeSlashCommands is false', () => {
    const provider = new AnthropicApiProvider({});
    expect(provider.supportsNativeSlashCommands).toBe(false);
  });
});
