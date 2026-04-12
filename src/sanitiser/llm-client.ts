/**
 * Host-side LLM client for the sanitiser.
 * Routes ollama:* models to Ollama API, anthropic:* to credential proxy.
 */

import { logger } from '../logger.js';

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

export interface LlmClientOptions {
  ollamaHost?: string;
  credentialProxyPort?: number;
}

/**
 * Call an LLM for structured extraction.
 * Model string determines the backend:
 *   ollama:modelname → Ollama API at ollamaHost
 *   anthropic:modelname → Anthropic Messages API via credential proxy
 */
export async function callExtractionLLM(
  request: LlmRequest,
  options?: LlmClientOptions,
): Promise<LlmResponse> {
  const { model } = request;

  if (model.startsWith('ollama:')) {
    return callOllama(request, options);
  } else if (model.startsWith('anthropic:')) {
    return callAnthropic(request, options);
  } else {
    throw new Error(`Unsupported model prefix: ${model}. Use ollama:name or anthropic:name`);
  }
}

// --- Ollama ---

async function callOllama(
  request: LlmRequest,
  options?: LlmClientOptions,
): Promise<LlmResponse> {
  const host = options?.ollamaHost || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const modelName = request.model.replace(/^ollama:/, '');

  const body: Record<string, unknown> = {
    model: modelName,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.user },
    ],
    stream: false,
    format: 'json',
  };

  // Use tool_use for structured output if schema provided
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
    message?: { content?: string; tool_calls?: Array<{ function: { arguments: Record<string, unknown> } }> };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  // Extract response: prefer tool_call arguments, fall back to content
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
    costUSD: null, // Ollama is free
  };
}

// --- Anthropic (via credential proxy) ---

async function callAnthropic(
  request: LlmRequest,
  options?: LlmClientOptions,
): Promise<LlmResponse> {
  const port = options?.credentialProxyPort || parseInt(process.env.CREDENTIAL_PROXY_PORT || '0', 10);
  if (!port) {
    throw new Error('CREDENTIAL_PROXY_PORT not set — cannot call Anthropic API');
  }

  const modelName = request.model.replace(/^anthropic:/, '');
  // Resolve short names to full model IDs
  const MODEL_MAP: Record<string, string> = {
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6-20250514',
    opus: 'claude-opus-4-6-20250514',
  };
  const resolvedModel = MODEL_MAP[modelName] || modelName;

  const body: Record<string, unknown> = {
    model: resolvedModel,
    max_tokens: 1024,
    system: request.system,
    messages: [{ role: 'user', content: request.user }],
  };

  // Use tool_use for structured output
  if (request.toolSchema) {
    const schema = request.toolSchema as { function: { name: string; description: string; parameters: object } };
    body.tools = [
      {
        name: schema.function.name,
        description: schema.function.description,
        input_schema: schema.function.parameters,
      },
    ];
    body.tool_choice = { type: 'tool', name: schema.function.name };
  }

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'proxy-placeholder',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string; input?: Record<string, unknown> }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };

  // Extract response: prefer tool_use input, fall back to text
  let response: string;
  const toolBlock = data.content.find((b) => b.type === 'tool_use');
  if (toolBlock?.input) {
    response = JSON.stringify(toolBlock.input);
  } else {
    const textBlock = data.content.find((b) => b.type === 'text');
    response = textBlock?.text || '';
  }

  // Estimate cost (haiku pricing)
  const inputTokens = data.usage.input_tokens;
  const outputTokens = data.usage.output_tokens;

  return {
    response,
    inputTokens,
    outputTokens,
    costUSD: null, // Cost calculated by the host-pipeline executor from token counts
  };
}
