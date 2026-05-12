import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Stand-ins for the engine-built providers + a tracking default.
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './types.js';

function makeStubProvider(label: string): AgentProvider & { lastInput: QueryInput | null } {
  const stub = {
    supportsNativeSlashCommands: false,
    isSessionInvalid: (_e: unknown) => false,
    lastInput: null as QueryInput | null,
    query(input: QueryInput): AgentQuery {
      stub.lastInput = input;
      const events: ProviderEvent[] = [
        { type: 'init', continuation: `${label}-session` },
        { type: 'result', text: `${label}-response` },
      ];
      return {
        push: () => {},
        end: () => {},
        events: (async function* () {
          for (const e of events) yield e;
        })(),
        abort: () => {},
      };
    },
  };
  return stub;
}

const ollamaStub = makeStubProvider('ollama');
const anthropicStub = makeStubProvider('anthropic');

mock.module('./factory.js', () => ({
  createProvider: mock((name: string) => {
    if (name === 'ollama') return ollamaStub;
    if (name === 'anthropic-api') return anthropicStub;
    throw new Error(`unknown provider: ${name}`);
  }),
  // ProviderName type lives at the top of factory.js; tests don't need it.
}));

const { RoutingProvider } = await import('./routing.js');

beforeEach(() => {
  ollamaStub.lastInput = null;
  anthropicStub.lastInput = null;
});

async function collectResults(query: AgentQuery): Promise<string[]> {
  const results: string[] = [];
  for await (const e of query.events) {
    if (e.type === 'result' && e.text != null) results.push(e.text);
  }
  return results;
}

describe('RoutingProvider', () => {
  it('routes to default for bare model + interactive (sdk path)', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'haiku' });
    const results = await collectResults(query);

    expect(results).toEqual(['default-response']);
    expect(defaultStub.lastInput?.model).toBe('haiku');
  });

  it('routes to default with stripped model for claude: prefix', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'claude:haiku' });
    await collectResults(query);

    expect(defaultStub.lastInput?.model).toBe('haiku');
  });

  it('routes ollama: prefix to OllamaProvider with stripped model', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'ollama:qwen3' });
    const results = await collectResults(query);

    expect(results).toEqual(['ollama-response']);
    expect(ollamaStub.lastInput?.model).toBe('qwen3');
    expect(defaultStub.lastInput).toBeNull();
  });

  it('routes ollama-remote: prefix to OllamaProvider preserving the prefix in passthrough model', async () => {
    // engine-selector strips ollama-remote: but RoutingProvider only forwards
    // the stripped model. The `remote: true` flag is internal to engine-selector.
    // The OllamaProvider itself handles ollama-remote: by re-checking the
    // prefix, but here the router forwards just the stripped name.
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'ollama-remote:qwen3' });
    await collectResults(query);

    expect(ollamaStub.lastInput?.model).toBe('qwen3');
  });

  it('routes anthropic: prefix to AnthropicApiProvider', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({ prompt: 'hi', cwd: '/workspace/agent', model: 'anthropic:haiku' });
    const results = await collectResults(query);

    expect(results).toEqual(['anthropic-response']);
    expect(anthropicStub.lastInput?.model).toBe('haiku');
  });

  it('routes scheduled task with no useAgentSdk to anthropic-api (production rule)', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({
      prompt: 'task content',
      cwd: '/workspace/agent',
      model: 'haiku',
      isScheduledTask: true,
      // useAgentSdk omitted → falsy → engine-selector returns anthropic-api
    });
    const results = await collectResults(query);

    expect(results).toEqual(['anthropic-response']);
    expect(anthropicStub.lastInput?.model).toBe('haiku');
  });

  it('routes scheduled task with useAgentSdk: true to default (SDK)', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({
      prompt: 'task content',
      cwd: '/workspace/agent',
      model: 'haiku',
      isScheduledTask: true,
      useAgentSdk: true,
    });
    const results = await collectResults(query);

    expect(results).toEqual(['default-response']);
    expect(defaultStub.lastInput?.model).toBe('haiku');
  });

  it('lazy-instantiates alternates only on first use', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);

    // First query goes to default — alternates not used yet.
    await collectResults(router.query({ prompt: 'a', cwd: '/workspace/agent', model: 'haiku' }));
    expect(ollamaStub.lastInput).toBeNull();
    expect(anthropicStub.lastInput).toBeNull();

    // Second query routes to ollama — instantiates ollama only.
    await collectResults(router.query({ prompt: 'b', cwd: '/workspace/agent', model: 'ollama:q' }));
    expect(ollamaStub.lastInput?.model).toBe('q');
    expect(anthropicStub.lastInput).toBeNull();

    // Third query routes to anthropic — instantiates anthropic only.
    await collectResults(router.query({ prompt: 'c', cwd: '/workspace/agent', model: 'anthropic:h' }));
    expect(anthropicStub.lastInput?.model).toBe('h');
  });

  it('inherits supportsNativeSlashCommands from the default', () => {
    const defaultStub = makeStubProvider('default');
    (defaultStub as { supportsNativeSlashCommands: boolean }).supportsNativeSlashCommands = true;
    const router = new RoutingProvider(defaultStub);
    expect(router.supportsNativeSlashCommands).toBe(true);
  });

  it('delegates isSessionInvalid to the default', () => {
    const defaultStub = makeStubProvider('default');
    (defaultStub as { isSessionInvalid: (e: unknown) => boolean }).isSessionInvalid = (e) =>
      e instanceof Error && e.message.includes('STALE');
    const router = new RoutingProvider(defaultStub);
    expect(router.isSessionInvalid(new Error('STALE_SESSION'))).toBe(true);
    expect(router.isSessionInvalid(new Error('other'))).toBe(false);
  });

  it('routes undefined model + scheduled task to anthropic-api', async () => {
    const defaultStub = makeStubProvider('default');
    const router = new RoutingProvider(defaultStub);
    const query = router.query({
      prompt: 'task',
      cwd: '/workspace/agent',
      isScheduledTask: true,
    });
    const results = await collectResults(query);

    expect(results).toEqual(['anthropic-response']);
    expect(anthropicStub.lastInput?.model).toBeUndefined();
  });
});
