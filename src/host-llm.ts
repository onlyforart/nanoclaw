/**
 * Host-side LLM shim (§4.5 step 9a).
 *
 * The pipeline plugin (and any future host-side caller) reaches for
 * an LLM via `host.getHostLlm().callExtractionLLM(...)`. Two backends:
 *
 *   ollama:<name>      → POST to ${OLLAMA_HOST}/api/chat (local,
 *                        unauthenticated; resolves short names against
 *                        /api/tags).
 *   anthropic:<name>   → @anthropic-ai/sdk messages.create routed
 *                        through OneCLI's HTTPS proxy (registered
 *                        agent: nanoclaw-host-llm). Real
 *                        ANTHROPIC_API_KEY lives in the OneCLI vault;
 *                        host-llm.ts never touches it directly.
 *
 * `initHostLlm()` runs once at host startup (from src/index.ts main()
 * before plugins load) so OneCLI failures surface at boot rather than
 * the first call. Re-calls are idempotent — the bootstrap caches its
 * result. If OneCLI env (`ONECLI_URL`/`ONECLI_API_KEY`) is missing or
 * a OneCLI call rejects, init logs and returns; subsequent
 * `anthropic:*` calls then throw a clear "OneCLI not configured"
 * error. There is intentionally no env-key fallback — silent
 * degradation would mask production misconfig (operator decision
 * 2026-05-07; see `feedback_credential_plane_onecli`).
 */
import https from 'https';

import Anthropic from '@anthropic-ai/sdk';
import { OneCLI } from '@onecli-sh/sdk';

import { log } from './log.js';

export interface LlmRequest {
  model: string;
  system: string;
  user: string;
  toolSchema?: object;
}

export interface LlmResponse {
  response: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number | null;
}

export interface LlmCallOptions {
  ollamaHost?: string;
}

export interface HostLlmClient {
  callExtractionLLM(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
}

/** OneCLI agent identifier the host registers itself under. */
const HOST_LLM_AGENT_ID = 'nanoclaw-host-llm';

/** Anthropic short-name resolution. */
const ANTHROPIC_MODEL_MAP: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20250514',
  opus: 'claude-opus-4-6-20250514',
};

let _initialised = false;
let _anthropicClient: Anthropic | undefined;
let _proxyUrl: string | undefined;
let _caCert: string | undefined;

/**
 * Bootstrap OneCLI once. Must be called from `main()` before plugins
 * load. Idempotent.
 */
export async function initHostLlm(): Promise<void> {
  if (_initialised) return;
  _initialised = true;

  const onecliUrl = process.env.ONECLI_URL;
  const onecliApiKey = process.env.ONECLI_API_KEY;
  if (!onecliUrl || !onecliApiKey) {
    log.warn('host-llm: ONECLI_URL/ONECLI_API_KEY missing — anthropic:* calls will fail until OneCLI is configured');
    return;
  }

  try {
    const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey });
    const ensure = await onecli.ensureAgent({
      name: HOST_LLM_AGENT_ID,
      identifier: HOST_LLM_AGENT_ID,
    });
    if (ensure.created) {
      log.warn(
        `host-llm: registered new OneCLI agent "${HOST_LLM_AGENT_ID}". ` +
          'Fresh agents start in `selective` secret mode — run ' +
          '`onecli agents set-secret-mode --id <agent-id> --mode all` ' +
          'OR explicitly assign the Anthropic secret. Until then, ' +
          'api.anthropic.com requests via this agent will 401.',
      );
    }
    const cfg = await onecli.getContainerConfig(HOST_LLM_AGENT_ID);
    _proxyUrl = cfg.env.HTTPS_PROXY;
    _caCert = cfg.caCertificate;
    log.info('host-llm: OneCLI proxy configured', { agent: HOST_LLM_AGENT_ID });
  } catch (err) {
    log.error('host-llm: OneCLI init failed — anthropic:* calls will throw', {
      err,
    });
  }
}

function getAnthropicClient(): Anthropic {
  if (_anthropicClient) return _anthropicClient;
  if (!_proxyUrl || !_caCert) {
    throw new Error(
      'host-llm: OneCLI not configured — cannot route anthropic:* calls. ' +
        'Set ONECLI_URL + ONECLI_API_KEY and ensure the gateway is reachable; ' +
        'flip the nanoclaw-host-llm agent to secret-mode=all if it was just registered.',
    );
  }
  const httpsAgent = new https.Agent({ ca: _caCert });
  _anthropicClient = new Anthropic({
    apiKey: 'onecli-proxied',
    baseURL: _proxyUrl + '/v1',
    httpAgent: httpsAgent,
  } as ConstructorParameters<typeof Anthropic>[0]);
  return _anthropicClient;
}

export function getHostLlm(): HostLlmClient {
  return {
    callExtractionLLM,
  };
}

async function callExtractionLLM(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
  if (request.model.startsWith('ollama:')) {
    return callOllama(request, options);
  }
  if (request.model.startsWith('anthropic:')) {
    return callAnthropic(request);
  }
  throw new Error(`Unsupported model prefix: ${request.model}. Use ollama:<name> or anthropic:<name>.`);
}

// --- Ollama ---

async function resolveOllamaModel(requested: string, host: string): Promise<string> {
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) return requested;
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const installed = (data.models ?? []).map((m) => m.name);
    const nameOnly = (m: string) => m.split(':')[0];
    const exactFull = installed.find((m) => m === requested);
    if (exactFull) return exactFull;
    const exactName = installed.find((m) => nameOnly(m) === requested);
    if (exactName) return exactName;
    const prefixFull = installed.find((m) => m.startsWith(requested));
    if (prefixFull) return prefixFull;
    const prefixName = installed.find((m) => nameOnly(m).startsWith(requested));
    if (prefixName) return prefixName;
  } catch {
    // Fall through to requested name.
  }
  return requested;
}

async function callOllama(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
  const host = options?.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const shortName = request.model.replace(/^ollama:/, '');
  const modelName = await resolveOllamaModel(shortName, host);

  const body: Record<string, unknown> = {
    model: modelName,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    stream: false,
    format: 'json',
  };
  if (request.toolSchema) {
    body.tools = [request.toolSchema];
    delete body.format;
  }

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ollama API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    message?: {
      content?: string;
      tool_calls?: Array<{ function: { arguments: Record<string, unknown> } }>;
    };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  let response: string;
  if (data.message?.tool_calls?.length) {
    response = JSON.stringify(data.message.tool_calls[0].function.arguments);
  } else {
    response = data.message?.content || '';
  }

  return {
    response,
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    costUSD: null,
  };
}

// --- Anthropic ---

async function callAnthropic(request: LlmRequest): Promise<LlmResponse> {
  const client = getAnthropicClient();
  const modelName = request.model.replace(/^anthropic:/, '');
  const resolvedModel = ANTHROPIC_MODEL_MAP[modelName] || modelName;

  const args: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: 1024,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
  };

  if (request.toolSchema) {
    const schema = request.toolSchema as {
      function: { name: string; description?: string; parameters: object };
    };
    args.tools = [
      {
        name: schema.function.name,
        description: schema.function.description,
        input_schema: schema.function.parameters,
      },
    ];
    args.tool_choice = { type: 'tool', name: schema.function.name };
  }

  // Cast through unknown: the SDK's create() type is strict on shape;
  // our `args` is dynamic because tool_use is conditional. Tested
  // through the mock.
  const data = (await client.messages.create(args as unknown as Parameters<typeof client.messages.create>[0])) as {
    content: Array<{
      type: string;
      text?: string;
      input?: Record<string, unknown>;
    }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };

  let response: string;
  const toolBlock = data.content.find((b) => b.type === 'tool_use');
  if (toolBlock?.input) {
    response = JSON.stringify(toolBlock.input);
  } else {
    const textBlock = data.content.find((b) => b.type === 'text');
    response = textBlock?.text || '';
  }

  return {
    response,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    costUSD: null,
  };
}

/**
 * Test-only reset hook so vitest's `vi.resetModules()` reliably clears
 * module-local state between describes. Not exported from the package
 * barrel; called only from `host-llm.test.ts` if needed.
 */
export function _resetHostLlmForTests(): void {
  _initialised = false;
  _anthropicClient = undefined;
  _proxyUrl = undefined;
  _caCert = undefined;
}
