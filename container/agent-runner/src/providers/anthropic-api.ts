/**
 * Anthropic API provider — wraps `runAnthropicApiChat` in the AgentProvider
 * interface.
 *
 * Selected when container.json's `provider: "anthropic-api"` or when the
 * engine-selector routes a per-message override to this provider —
 * notably the production scheduled-task path (use_agent_sdk = NULL/0
 * routes here, since the SDK preset is too heavy for utility tasks).
 *
 * Multi-turn within a query is real — the underlying engine accepts
 * `existingMessages: MessageParam[]` and returns the updated history,
 * so push() between rounds replays full conversation context. Cross-query
 * continuation is not yet persisted (the continuation token is a synthetic
 * session id; it isn't reloaded on next query). Production scheduled tasks
 * are one-shot so this matches v1's behaviour for that workload; multi-turn
 * interactive chat under this provider would lose history on container
 * restart.
 */
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

import { runAnthropicApiChat } from '../anthropic-api-engine.js';
import { McpToolExecutor, type McpServerConfig as ExecutorMcpConfig } from '../mcp-tool-executor.js';
import { maxToolRoundsOr, timeoutMsOr } from '../wiring-env.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig as SdkMcpConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_MODEL = 'haiku';
const DEFAULT_MAX_ITERATIONS = 15;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function log(msg: string): void {
  console.error(`[anthropic-api-provider] ${msg}`);
}

function sdkToExecutorConfig(sdk: SdkMcpConfig): ExecutorMcpConfig {
  if (sdk.type === 'http') {
    return { type: 'http', url: sdk.url, headers: sdk.headers };
  }
  return { command: sdk.command, args: sdk.args, env: sdk.env };
}

class EventQueue {
  private queue: ProviderEvent[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(event: ProviderEvent): void {
    this.queue.push(event);
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ProviderEvent> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

/** Strip the `anthropic:` / `claude:` prefix if present (engine-selector also does this). */
function stripModelPrefix(model: string): string {
  if (model.startsWith('anthropic:')) return model.slice('anthropic:'.length);
  if (model.startsWith('claude:')) return model.slice('claude:'.length);
  return model;
}

export class AnthropicApiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, SdkMcpConfig>;
  private env: Record<string, string | undefined>;
  private defaultModel: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.defaultModel = this.env.ANTHROPIC_API_MODEL ?? DEFAULT_MODEL;
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const events = new EventQueue();
    const sessionId = `anthropic-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const model = stripModelPrefix(input.model ?? this.defaultModel);

    let aborted = false;
    let ended = false;
    const followups: string[] = [];
    let followupReady: (() => void) | null = null;

    const waitForFollowup = (): Promise<string | null> =>
      new Promise((resolve) => {
        const check = () => {
          if (aborted || ended) return resolve(null);
          if (followups.length > 0) return resolve(followups.shift()!);
          followupReady = check;
        };
        check();
      });

    void (async () => {
      try {
        events.push({ type: 'init', continuation: sessionId });

        const executor = new McpToolExecutor();
        const executorConfig: Record<string, ExecutorMcpConfig> = {};
        for (const [name, sdkConfig] of Object.entries(this.mcpServers)) {
          executorConfig[name] = sdkToExecutorConfig(sdkConfig);
        }
        // MCP call timeout inherits from the same per-wiring NANOCLAW_TIMEOUT_MS
        // override the engine uses for LLM requests below — operator-configured
        // task budgets propagate to MCP calls within them. The MCP SDK's own
        // default (60s) is too short for browser-driven tools like pagepilot.
        await executor.initialize(executorConfig, undefined, {
          callTimeoutMs: timeoutMsOr(DEFAULT_TIMEOUT_MS),
        });
        events.push({ type: 'activity' });

        try {
          let userMessage = input.prompt;
          let history: MessageParam[] | undefined;

          while (true) {
            if (aborted) return;
            log(`Running anthropic-api chat: model=${model}`);
            const result = await runAnthropicApiChat(userMessage, {
              model,
              systemPrompt: input.systemContext?.instructions,
              // Per-wiring overrides from K.1.f step 9.0:
              // NANOCLAW_MAX_TOOL_ROUNDS / NANOCLAW_TIMEOUT_MS env vars
              // set by container-runner at spawn from messaging_group_agents
              // (with fallback to backend-defaults[agent_provider]). Env
              // unset → keep this provider's hardcoded default.
              maxIterations: maxToolRoundsOr(DEFAULT_MAX_ITERATIONS),
              timeoutMs: timeoutMsOr(DEFAULT_TIMEOUT_MS),
              tools: executor.getAnthropicTools(),
              toolNameMap: executor.getToolNameMap(),
              executeTool: (mcpName, args) => executor.callTool(mcpName, args),
              onStatus: () => events.push({ type: 'activity' }),
              existingMessages: history,
            });

            history = result.messages;
            events.push({
              type: 'usage',
              model,
              inputTokens: result.inputTokens ?? 0,
              outputTokens: result.outputTokens ?? 0,
              cacheReadInputTokens: result.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: result.cacheCreationInputTokens ?? 0,
            });
            events.push({ type: 'result', text: result.response });

            const next = await waitForFollowup();
            if (next === null) break;
            userMessage = next;
          }
        } finally {
          await executor.close();
        }
      } catch (err) {
        events.push({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
      } finally {
        events.end();
      }
    })();

    return {
      push: (msg) => {
        followups.push(msg);
        followupReady?.();
        followupReady = null;
      },
      end: () => {
        ended = true;
        followupReady?.();
        followupReady = null;
      },
      events: events[Symbol.asyncIterator](),
      abort: () => {
        aborted = true;
        followupReady?.();
        followupReady = null;
        events.end();
      },
    };
  }
}

registerProvider('anthropic-api', (opts) => new AnthropicApiProvider(opts));
