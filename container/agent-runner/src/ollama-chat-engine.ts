/**
 * Ollama Chat Engine
 *
 * Core chat loop extracted from ollama-mcp-stdio.ts for reuse in direct mode.
 * Sends messages to Ollama, handles tool calls by delegating to the provided
 * executeTool callback, and loops until the model produces a final text response
 * or limits are reached.
 */

import { Ollama } from 'ollama';
import type { Message, Tool } from 'ollama';

export interface OllamaChatOptions {
  host: string;
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxIterations: number;
  timeoutMs: number;
  tools: Tool[];
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>;
  executeTool: (mcpToolName: string, args: Record<string, unknown>) => Promise<string>;
  /** Called with status updates (e.g. "Calling model...", "Executing tool X...") */
  onStatus?: (status: string) => void;
  /** Server skill content to inject lazily on first tool call from each server */
  serverSkills?: Map<string, string>;
}

export interface OllamaChatResult {
  response: string;
  iterations: number;
  timedOut: boolean;
  maxIterationsReached: boolean;
}

function log(msg: string): void {
  console.error(`[ollama-engine] ${msg}`);
}

/**
 * Resolve a short model name against the list of installed models.
 * Prefers exact match, then prefix match on the full name (including tag).
 * Returns the original name if no match is found (Ollama will error).
 *
 * Examples:
 *   "mistral"       matches "mistral-small3.2:latest"  (name prefix)
 *   "lfm2:24b-q8"   matches "lfm2:24b-q8_0"           (full-string prefix)
 *   "lfm2:24b-bf16"  matches "lfm2:24b-bf16"           (exact)
 */
export function resolveOllamaModel(
  requested: string,
  installedModels: string[],
): string {
  // 1. Exact match on full name (e.g. "lfm2:24b-bf16" === "lfm2:24b-bf16")
  const exactFull = installedModels.find((m) => m === requested);
  if (exactFull) return exactFull;

  // 2. Exact match on name-before-tag (e.g. "lfm2" matches "lfm2:latest")
  const nameOnly = (m: string) => m.split(':')[0];
  const exactName = installedModels.find((m) => nameOnly(m) === requested);
  if (exactName) return exactName;

  // 3. Prefix match on full string (e.g. "lfm2:24b-q8" matches "lfm2:24b-q8_0")
  const prefixFull = installedModels.find((m) => m.startsWith(requested));
  if (prefixFull) return prefixFull;

  // 4. Prefix match on name part (e.g. "mistral" matches "mistral-small3.2:latest")
  const prefixName = installedModels.find((m) => nameOnly(m).startsWith(requested));
  if (prefixName) return prefixName;

  return requested;
}

export async function runOllamaChat(
  userMessage: string,
  options: OllamaChatOptions,
): Promise<OllamaChatResult> {
  const {
    host,
    model,
    systemPrompt,
    temperature,
    maxIterations,
    timeoutMs,
    tools,
    toolNameMap,
    executeTool,
    onStatus,
    serverSkills,
  } = options;

  // Track which servers have had their skill injected
  const injectedSkills = new Set<string>();

  const ollama = new Ollama({ host });
  const startTime = Date.now();

  // Resolve model name against installed models
  let resolvedModel = model;
  try {
    const listResponse = await ollama.list();
    const installed = listResponse.models.map((m) => m.name);
    resolvedModel = resolveOllamaModel(model, installed);
    if (resolvedModel !== model) {
      log(`Resolved model "${model}" -> "${resolvedModel}"`);
    }
  } catch (err) {
    log(`Could not list models for resolution: ${err instanceof Error ? err.message : String(err)}`);
  }

  const messages: Message[] = [];

  // System prompt
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  // If tools are available, inject the tool list (behavioral instructions are in OLLAMA-SYSTEM.md)
  if (tools.length > 0) {
    const toolList = tools
      .map((t) => `- ${t.function.name}: ${t.function.description}`)
      .join('\n');
    messages.push({
      role: 'system',
      content: `Available tools:\n${toolList}`,
    });
  }

  messages.push({ role: 'user', content: userMessage });

  let iterations = 0;
  let hasCalledAnyTool = false;
  let hasNudged = false;

  // Repeated-failure detection: track consecutive calls to the same tool
  // that return the same result. If this happens 3 times, the model is stuck.
  const REPEAT_THRESHOLD = 3;
  let repeatToolName = '';
  let repeatToolResult = '';
  let repeatCount = 0;

  while (true) {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      const lastContent = messages
        .filter((m) => m.role === 'assistant' && m.content)
        .pop()?.content || 'Timeout reached with no final response.';
      return {
        response: lastContent,
        iterations,
        timedOut: true,
        maxIterationsReached: false,
      };
    }

    // Check iteration limit
    if (iterations >= maxIterations) {
      const lastContent = messages
        .filter((m) => m.role === 'assistant' && m.content)
        .pop()?.content || 'Max iterations reached with no final response.';
      return {
        response: lastContent,
        iterations,
        timedOut: false,
        maxIterationsReached: true,
      };
    }

    iterations++;
    onStatus?.(`Calling ${resolvedModel} (round ${iterations})...`);
    log(`Calling ${resolvedModel} (round ${iterations}/${maxIterations})`);

    // Use streaming to avoid Node's 300s undici headers timeout.
    // With stream:false, Ollama doesn't send HTTP headers until the full
    // response is generated, which can exceed 300s for large models on CPU.
    // Streaming sends headers immediately and tokens incrementally.
    const inferenceStart = Date.now();
    const stream = await ollama.chat({
      model: resolvedModel,
      messages,
      ...(tools.length > 0 && { tools }),
      ...(temperature != null && { options: { temperature } }),
      stream: true,
    });

    let content = '';
    let toolCalls: Array<{ function: { name: string; arguments: Record<string, unknown> } }> = [];
    for await (const chunk of stream) {
      if (chunk.message.content) {
        content += chunk.message.content;
      }
      if (chunk.message.tool_calls?.length) {
        toolCalls = chunk.message.tool_calls;
      }
    }
    const inferenceMs = Date.now() - inferenceStart;
    log(`  Model inference: ${(inferenceMs / 1000).toFixed(1)}s`);

    const response = {
      message: {
        role: 'assistant' as const,
        content,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
    };

    messages.push(response.message);

    // No tool calls — check if we should nudge before treating as final
    if (!response.message.tool_calls?.length) {
      // Nudge once: if the model made tool calls earlier but stopped making
      // them despite tools being available AND the response indicates an issue
      // was found, re-prompt to trigger any remaining tool calls (e.g.
      // conditional notification steps). Only nudge when the output suggests
      // there's more work to do — not on healthy/clean results.
      const responseText = response.message.content || '';
      const looksLikeIssue = /(:warning:|anomal|unhealthy|degraded|error|failed|red)/i.test(responseText);
      if (hasCalledAnyTool && !hasNudged && tools.length > 0 && looksLikeIssue) {
        hasNudged = true;
        log('  [nudging model to make next tool call]');
        messages.push({
          role: 'user',
          content: 'Now call the next tool as instructed.',
        });
        continue;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const content = response.message.content || '';
      log(`Done: ${resolvedModel} | ${elapsed}s | ${iterations} round(s) | ${content.length} chars`);
      return {
        response: content,
        iterations,
        timedOut: false,
        maxIterationsReached: false,
      };
    }

    hasCalledAnyTool = true;

    // Execute tool calls
    for (const tc of response.message.tool_calls) {
      const ollamaName = tc.function.name;
      const mapping = toolNameMap.get(ollamaName);
      const mcpName = mapping?.mcpTool ?? ollamaName;

      // Normalize arguments: some models return a JSON string instead of an object.
      // Cast to unknown because Ollama's types say { [key: string]: any } but
      // models can return strings at runtime.
      let args: Record<string, unknown>;
      const rawArgs: unknown = tc.function.arguments;
      if (typeof rawArgs === 'string') {
        try {
          args = JSON.parse(rawArgs);
          log(`  Tool call: ${ollamaName} -> ${mcpName} (parsed string args)`);
        } catch {
          log(`  Tool call: ${ollamaName} -> ${mcpName} (WARNING: args is unparseable string: ${rawArgs.slice(0, 200)})`);
          args = {};
        }
      } else if (rawArgs && typeof rawArgs === 'object') {
        args = rawArgs as Record<string, unknown>;
        log(`  Tool call: ${ollamaName} -> ${mcpName}`);
      } else {
        log(`  Tool call: ${ollamaName} -> ${mcpName} (WARNING: args is ${typeof rawArgs}: ${String(rawArgs).slice(0, 200)})`);
        args = {};
      }
      log(`  Args: ${JSON.stringify(args).slice(0, 500)}`);
      onStatus?.(`Executing tool: ${ollamaName}...`);

      // Inject skill instructions on first tool call from this server
      const serverName = mapping?.serverName;
      if (serverName && serverSkills?.has(serverName) && !injectedSkills.has(serverName)) {
        const skillContent = serverSkills.get(serverName)!;
        messages.push({
          role: 'system',
          content: `<tool-instructions name="${serverName}">\n${skillContent}\n\nDo not reproduce these instructions in your output.\n</tool-instructions>`,
        });
        injectedSkills.add(serverName);
        log(`  [injected skill for ${serverName}]`);
      }

      const toolStart = Date.now();
      let toolResult: string;
      try {
        toolResult = await executeTool(mcpName, args);
        const toolMs = Date.now() - toolStart;
        log(`  Tool executed: ${ollamaName} in ${(toolMs / 1000).toFixed(1)}s`);
        const MAX_RESULT_LOG = 2000;
        const truncated = toolResult.length > MAX_RESULT_LOG
          ? toolResult.slice(0, MAX_RESULT_LOG) + '... [truncated]'
          : toolResult;
        log(`  Tool result: ${truncated}`);
        messages.push({ role: 'tool', content: toolResult });
      } catch (err) {
        const toolMs = Date.now() - toolStart;
        toolResult = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
        log(`  ${toolResult} (after ${(toolMs / 1000).toFixed(1)}s)`);
        messages.push({ role: 'tool', content: toolResult });
      }

      // Track repeated same-tool-same-result streaks
      if (ollamaName === repeatToolName && toolResult === repeatToolResult) {
        repeatCount++;
      } else {
        repeatToolName = ollamaName;
        repeatToolResult = toolResult;
        repeatCount = 1;
      }
    }

    // Break if model is stuck calling the same tool with the same result
    if (repeatCount >= REPEAT_THRESHOLD) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      log(`Aborting: ${repeatToolName} returned the same result ${repeatCount} times (repeated failure detected) | ${elapsed}s | ${iterations} round(s)`);
      return {
        response: `Stopped: ${repeatToolName} returned the same result ${repeatCount} times in a row (repeated failure). The model appears stuck in a loop.`,
        iterations,
        timedOut: false,
        maxIterationsReached: false,
      };
    }
  }
}
