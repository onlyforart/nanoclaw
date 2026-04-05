import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

const REPEAT_THRESHOLD = 3;
const DEFAULT_CONTEXT_WINDOW = 150_000;
const COMPACTION_RATIO = 0.75;

export interface AnthropicApiOptions {
  model: string;
  systemPrompt?: string;
  temperature?: number;
  maxIterations: number;
  timeoutMs: number;
  tools: AnthropicTool[];
  toolNameMap: Map<string, { mcpTool: string; serverName: string }>;
  executeTool: (
    mcpToolName: string,
    args: Record<string, unknown>,
  ) => Promise<string>;
  onStatus?: (status: string) => void;
  serverSkills?: Map<string, string>;
  /** Existing conversation history for session continuity (interactive mode). */
  existingMessages?: MessageParam[];
  /** Context window size for auto-compaction threshold. Defaults to 150K. */
  contextWindowSize?: number;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicApiResult {
  response: string;
  iterations: number;
  timedOut: boolean;
  maxIterationsReached: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** Updated conversation history — pass back as existingMessages for the next call. */
  messages: MessageParam[];
}

export async function runAnthropicApiChat(
  userMessage: string,
  options: AnthropicApiOptions,
): Promise<AnthropicApiResult> {
  const client = new Anthropic({
    // Credential proxy at ANTHROPIC_BASE_URL handles auth
    apiKey: process.env.ANTHROPIC_API_KEY || 'placeholder',
  });

  const {
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
    existingMessages,
    contextWindowSize = DEFAULT_CONTEXT_WINDOW,
  } = options;

  const startTime = Date.now();
  let iterations = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  // Build messages array: carry forward existing history, append new user message
  const messages: MessageParam[] = existingMessages
    ? [...existingMessages]
    : [];
  messages.push({ role: 'user', content: userMessage });

  // System prompt grows lazily as skills are injected
  let currentSystemPrompt = systemPrompt || '';
  const injectedSkills = new Set<string>();

  // Stuck loop detection
  let repeatToolName = '';
  let repeatToolResult = '';
  let repeatCount = 0;

  let lastResponse = '';

  while (true) {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      return {
        response: lastResponse || 'Timed out waiting for response.',
        iterations,
        timedOut: true,
        maxIterationsReached: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        messages,
      };
    }

    // Check iteration limit
    if (iterations >= maxIterations) {
      return {
        response:
          lastResponse || 'Reached maximum number of tool-calling rounds.',
        iterations,
        timedOut: false,
        maxIterationsReached: true,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        messages,
      };
    }

    iterations++;
    onStatus?.(`Iteration ${iterations}`);

    // Build API request
    const createParams: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      messages,
      max_tokens: 4096,
      ...(currentSystemPrompt ? { system: currentSystemPrompt } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(tools.length > 0 ? { tools: tools as Anthropic.Tool[] } : {}),
    };

    const response = await client.messages.create(createParams);

    // Accumulate token usage
    const usage = response.usage;
    totalInputTokens += usage.input_tokens;
    totalOutputTokens += usage.output_tokens;
    totalCacheReadTokens += usage.cache_read_input_tokens ?? 0;
    totalCacheCreationTokens += usage.cache_creation_input_tokens ?? 0;

    // Extract text and tool use blocks
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (textBlocks.length > 0) {
      lastResponse = textBlocks.map((b) => b.text).join('\n');
    }

    // No tool calls → final response
    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // Append assistant message to history
      messages.push({
        role: 'assistant',
        content: response.content.map((b) => {
          if (b.type === 'text') {
            return { type: 'text' as const, text: b.text };
          }
          return b as unknown as Anthropic.ContentBlockParam;
        }),
      });

      // Auto-compaction check
      const threshold = contextWindowSize * COMPACTION_RATIO;
      if (usage.input_tokens > threshold && messages.length > 2) {
        await compactMessages(client, model, messages, currentSystemPrompt);
      }

      return {
        response: lastResponse,
        iterations,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        messages,
      };
    }

    // Process tool calls
    // Append assistant message with tool_use blocks to history
    messages.push({
      role: 'assistant',
      content: response.content.map((b) => {
        if (b.type === 'tool_use') {
          return {
            type: 'tool_use' as const,
            id: b.id,
            name: b.name,
            input: b.input as Record<string, unknown>,
          };
        }
        if (b.type === 'text') {
          return { type: 'text' as const, text: b.text };
        }
        return b as unknown as Anthropic.ContentBlockParam;
      }),
    });

    // Execute each tool and collect results
    const toolResults: Array<{
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }> = [];

    for (const toolUse of toolUseBlocks) {
      const mapping = toolNameMap.get(toolUse.name);
      if (!mapping) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Unknown tool: ${toolUse.name}`,
          is_error: true,
        });
        continue;
      }

      // Inject skill on first tool call from this server
      if (
        serverSkills?.has(mapping.serverName) &&
        !injectedSkills.has(mapping.serverName)
      ) {
        currentSystemPrompt += `\n\n<tool-instructions name="${mapping.serverName}">\n${serverSkills.get(mapping.serverName)!}\n</tool-instructions>`;
        injectedSkills.add(mapping.serverName);
      }

      const args = (toolUse.input as Record<string, unknown>) ?? {};
      let result: string;
      let isError = false;

      try {
        result = await executeTool(mapping.mcpTool, args);
      } catch (err) {
        result = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result,
        is_error: isError,
      });

      // Stuck loop detection (track last tool in the round)
      if (toolUse.name === repeatToolName && result === repeatToolResult) {
        repeatCount++;
      } else {
        repeatToolName = toolUse.name;
        repeatToolResult = result;
        repeatCount = 1;
      }
    }

    // Check stuck loop after processing all tools in this round
    if (repeatCount >= REPEAT_THRESHOLD) {
      const stuckMsg = `Aborting: tool "${repeatToolName}" returned the same result ${REPEAT_THRESHOLD} times in a row (repeated failure detected).`;
      messages.push({ role: 'user', content: toolResults });
      return {
        response: stuckMsg,
        iterations,
        timedOut: false,
        maxIterationsReached: false,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheReadInputTokens: totalCacheReadTokens,
        cacheCreationInputTokens: totalCacheCreationTokens,
        messages,
      };
    }

    // Append tool results as a user message
    messages.push({ role: 'user', content: toolResults });
  }
}

/**
 * Compact the messages array by asking the model to summarize the conversation,
 * then replacing messages with [summary, ack, last exchange].
 */
async function compactMessages(
  client: Anthropic,
  model: string,
  messages: MessageParam[],
  systemPrompt: string,
): Promise<void> {
  // Keep the last exchange (user + assistant)
  const lastAssistantIdx = messages.length - 1;
  const lastUserIdx = lastAssistantIdx - 1;

  if (lastUserIdx < 0) return; // nothing to compact

  // Ask the model to summarize everything before the last exchange
  const toSummarize = messages.slice(0, lastUserIdx);
  if (toSummarize.length === 0) return;

  const summaryResponse = await client.messages.create({
    model,
    system: systemPrompt || undefined,
    messages: [
      ...toSummarize,
      {
        role: 'user',
        content:
          'Summarize the key points, decisions, and context from this conversation so far.\nBe concise but preserve all information needed to continue the conversation coherently.\nInclude any pending tasks, open questions, or commitments made.',
      },
    ],
    max_tokens: 2048,
  } as Anthropic.MessageCreateParamsNonStreaming);

  const summaryText = summaryResponse.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  if (!summaryText) return;

  // Replace messages: [summary, ack, last user, last assistant]
  const lastUser = messages[lastUserIdx];
  const lastAssistant = messages[lastAssistantIdx];
  messages.length = 0;
  messages.push(
    { role: 'user', content: summaryText },
    { role: 'assistant', content: 'Understood, continuing.' },
    lastUser,
    lastAssistant,
  );
}
