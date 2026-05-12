/**
 * §4.5 step 9a: host-side LLM shim.
 *
 * Spec encoded here (per `feedback_tests_encode_spec`):
 *   - `initHostLlm()` registers the host as an OneCLI agent named
 *     `nanoclaw-host-llm` and fetches its container config (proxy URL +
 *     CA cert). Idempotent across calls.
 *   - On a fresh-agent registration (`ensure.created === true`),
 *     init logs a warning telling the operator how to flip secret-mode.
 *   - When OneCLI env (`ONECLI_URL` / `ONECLI_API_KEY`) is missing,
 *     init logs but does not throw; subsequent `anthropic:*` calls
 *     throw a clear "OneCLI not configured" error. `ollama:*` calls
 *     still work — Ollama is local + unauthenticated.
 *   - When OneCLI calls throw (network down, vault unreachable),
 *     same behaviour: log + degrade.
 *   - `getHostLlm().callExtractionLLM(req)` dispatches by `model`
 *     prefix:
 *       - `ollama:<name>` → POST `${OLLAMA_HOST}/api/chat`; resolves
 *         short names against `/api/tags`; supports `tools[]` for
 *         structured output.
 *       - `anthropic:<name>` → `Anthropic SDK messages.create` with
 *         model resolved via short-name map (haiku/sonnet/opus →
 *         full IDs); request goes through OneCLI proxy + CA-cert
 *         agent.
 *       - any other prefix → throws.
 *   - Response extraction: prefer tool_use input as JSON string;
 *     fall back to text block (Anthropic) or content (Ollama).
 *   - Token counts populated from provider response.
 *   - costUSD is null at this layer (callers compute from token
 *     counts + model pricing).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the OneCLI SDK so initHostLlm can be exercised without a real
// gateway. Use a class (not vi.fn().mockImplementation(arrow)) so
// `new OneCLI(...)` constructs correctly — vitest warns when the mock
// implementation isn't a class/function declaration.
const ensureAgentMock = vi.fn();
const getContainerConfigMock = vi.fn();
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class MockOneCLI {
    ensureAgent = ensureAgentMock;
    getContainerConfig = getContainerConfigMock;
  },
}));

// Mock the Anthropic SDK default-export class.
const messagesCreateMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreateMock };
  },
}));

beforeEach(async () => {
  vi.resetModules();
  ensureAgentMock.mockReset();
  getContainerConfigMock.mockReset();
  messagesCreateMock.mockReset();
  // Default: OneCLI env present.
  process.env.ONECLI_URL = 'http://127.0.0.1:10254';
  process.env.ONECLI_API_KEY = 'onecli-test-key';
  delete process.env.OLLAMA_HOST;
  // Defaults that satisfy a happy initHostLlm().
  ensureAgentMock.mockResolvedValue({
    name: 'nanoclaw-host-llm',
    identifier: 'nanoclaw-host-llm',
    created: false,
  });
  getContainerConfigMock.mockResolvedValue({
    env: { HTTPS_PROXY: 'http://127.0.0.1:10254' },
    caCertificate: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----\n',
    caCertificateContainerPath: '/etc/ssl/onecli-ca.pem',
  });
});

describe('initHostLlm — OneCLI bootstrap', () => {
  it('registers nanoclaw-host-llm agent and fetches container config', async () => {
    const { initHostLlm } = await import('./host-llm.js');
    await initHostLlm();

    expect(ensureAgentMock).toHaveBeenCalledWith({
      name: 'nanoclaw-host-llm',
      identifier: 'nanoclaw-host-llm',
    });
    expect(getContainerConfigMock).toHaveBeenCalledWith('nanoclaw-host-llm');
  });

  it('idempotent — calling initHostLlm twice does not duplicate side effects', async () => {
    const { initHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await initHostLlm();
    // Idempotency: the agent is registered exactly once. Caching the
    // OneCLI bootstrap on the second call avoids extra round-trips.
    expect(ensureAgentMock).toHaveBeenCalledTimes(1);
    expect(getContainerConfigMock).toHaveBeenCalledTimes(1);
  });

  it('skips OneCLI bootstrap when ONECLI_URL/ONECLI_API_KEY missing', async () => {
    delete process.env.ONECLI_URL;
    delete process.env.ONECLI_API_KEY;
    const { initHostLlm } = await import('./host-llm.js');
    await expect(initHostLlm()).resolves.toBeUndefined();
    expect(ensureAgentMock).not.toHaveBeenCalled();
  });

  it('does not throw when ensureAgent rejects (degraded init, log only)', async () => {
    ensureAgentMock.mockRejectedValueOnce(new Error('network unreachable'));
    const { initHostLlm } = await import('./host-llm.js');
    await expect(initHostLlm()).resolves.toBeUndefined();
  });
});

describe('callExtractionLLM — ollama path', () => {
  beforeEach(() => {
    // Mock global fetch for the ollama backend.
    vi.stubGlobal('fetch', vi.fn());
  });

  it('resolves short model names against /api/tags and POSTs to /api/chat', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: 'llama3.2:3b' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: '{"foo":"bar"}' },
          prompt_eval_count: 12,
          eval_count: 7,
        }),
      });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    const result = await getHostLlm().callExtractionLLM({
      model: 'ollama:llama3.2',
      system: 'sys',
      user: 'usr',
    });

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0]).toBe('http://localhost:11434/api/tags');
    expect(calls[1][0]).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse((calls[1][1] as { body: string }).body);
    expect(body.model).toBe('llama3.2:3b');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
    expect(result).toEqual({
      response: '{"foo":"bar"}',
      inputTokens: 12,
      outputTokens: 7,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: null,
    });
  });

  it('extracts tool_call arguments preferentially over content', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: {
            content: 'should be ignored',
            tool_calls: [{ function: { arguments: { extracted: 'value' } } }],
          },
          prompt_eval_count: 5,
          eval_count: 3,
        }),
      });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    const result = await getHostLlm().callExtractionLLM({
      model: 'ollama:custom',
      system: 's',
      user: 'u',
      toolSchema: { function: { name: 'extract', parameters: {} } } as object,
    });
    expect(result.response).toBe('{"extracted":"value"}');
  });

  it('throws on non-2xx response from ollama', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'internal error',
      });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await expect(
      getHostLlm().callExtractionLLM({
        model: 'ollama:x',
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow(/Ollama API error 500/);
  });

  it('OLLAMA_HOST env overrides default', async () => {
    process.env.OLLAMA_HOST = 'http://other-host:1234';
    (globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { content: 'ok' },
          prompt_eval_count: 1,
          eval_count: 1,
        }),
      });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await getHostLlm().callExtractionLLM({
      model: 'ollama:x',
      system: '',
      user: '',
    });
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('http://other-host:1234/api/tags');
  });
});

describe('callExtractionLLM — anthropic path', () => {
  it('routes through SDK; resolves haiku/sonnet/opus short names', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"answer":"42"}' }],
      usage: { input_tokens: 100, output_tokens: 7 },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await getHostLlm().callExtractionLLM({
      model: 'anthropic:haiku',
      system: 'sys',
      user: 'usr',
    });

    expect(messagesCreateMock).toHaveBeenCalledTimes(1);
    const args = messagesCreateMock.mock.calls[0][0];
    expect(args.model).toBe('claude-haiku-4-5-20251001');
    expect(args.system).toBe('sys');
    expect(args.messages).toEqual([{ role: 'user', content: 'usr' }]);
  });

  it('passes through full model IDs unmapped', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await getHostLlm().callExtractionLLM({
      model: 'anthropic:claude-sonnet-4-6-20250514',
      system: 's',
      user: 'u',
    });
    expect(messagesCreateMock.mock.calls[0][0].model).toBe('claude-sonnet-4-6-20250514');
  });

  it('extracts tool_use input preferentially over text block', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'should be ignored' },
        { type: 'tool_use', input: { extracted: 'value' } },
      ],
      usage: { input_tokens: 2, output_tokens: 3 },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    const result = await getHostLlm().callExtractionLLM({
      model: 'anthropic:haiku',
      system: 's',
      user: 'u',
      toolSchema: {
        function: {
          name: 'extract',
          description: 'd',
          parameters: { type: 'object' },
        },
      } as object,
    });

    expect(result.response).toBe('{"extracted":"value"}');
    expect(result.inputTokens).toBe(2);
    expect(result.outputTokens).toBe(3);
    expect(result.costUSD).toBeNull();
  });

  it('captures cache_read + cache_creation tokens from Anthropic usage block', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 1500,
        output_tokens: 200,
        cache_read_input_tokens: 12000,
        cache_creation_input_tokens: 800,
      },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    const result = await getHostLlm().callExtractionLLM({
      model: 'anthropic:haiku',
      system: 's',
      user: 'u',
    });

    expect(result.inputTokens).toBe(1500);
    expect(result.outputTokens).toBe(200);
    expect(result.cacheReadInputTokens).toBe(12000);
    expect(result.cacheCreationInputTokens).toBe(800);
  });

  it('defaults missing cache fields to 0', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 5, output_tokens: 7 },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    const result = await getHostLlm().callExtractionLLM({
      model: 'anthropic:haiku',
      system: 's',
      user: 'u',
    });

    expect(result.cacheReadInputTokens).toBe(0);
    expect(result.cacheCreationInputTokens).toBe(0);
  });

  it('passes tool_use schema through with name + description + input_schema', async () => {
    messagesCreateMock.mockResolvedValue({
      content: [{ type: 'tool_use', input: {} }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await getHostLlm().callExtractionLLM({
      model: 'anthropic:haiku',
      system: 's',
      user: 'u',
      toolSchema: {
        function: {
          name: 'extract',
          description: 'desc',
          parameters: { type: 'object', properties: {} },
        },
      } as object,
    });

    const args = messagesCreateMock.mock.calls[0][0];
    expect(args.tools).toEqual([
      {
        name: 'extract',
        description: 'desc',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'extract' });
  });

  it('throws "OneCLI not configured" when init found no proxy/cert', async () => {
    delete process.env.ONECLI_URL;
    delete process.env.ONECLI_API_KEY;

    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await expect(
      getHostLlm().callExtractionLLM({
        model: 'anthropic:haiku',
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow(/OneCLI not configured/);
    expect(messagesCreateMock).not.toHaveBeenCalled();
  });
});

describe('callExtractionLLM — dispatch', () => {
  it('throws on unknown model prefix', async () => {
    const { initHostLlm, getHostLlm } = await import('./host-llm.js');
    await initHostLlm();
    await expect(
      getHostLlm().callExtractionLLM({
        model: 'cohere:command',
        system: 's',
        user: 'u',
      }),
    ).rejects.toThrow(/Unsupported model prefix/);
  });
});
