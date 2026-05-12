/**
 * Ollama provider — wraps `runOllamaChat` in the AgentProvider interface.
 *
 * Selected when container.json's `provider: "ollama"` or when a per-message
 * model override starts with `ollama:` / `ollama-remote:` (engine-selector
 * routes to this provider).
 *
 * Single-turn-per-call: each query() runs one engine call with the full
 * prompt. push() inside an active query starts another engine call with the
 * pushed text as the new user message. There's no in-engine conversation
 * history (the engine doesn't accept existingMessages today), so each
 * pushed message is processed as a fresh prompt — sufficient for the
 * scheduled-task workload that is the production use of this path.
 */
import { runOllamaChat } from '../ollama-chat-engine.js';
import { McpToolExecutor, type McpServerConfig as ExecutorMcpConfig } from '../mcp-tool-executor.js';
import { maxToolRoundsOr, timeoutMsOr } from '../wiring-env.js';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, McpServerConfig as SdkMcpConfig, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_OLLAMA_HOST = 'http://host.docker.internal:11434';
const DEFAULT_OLLAMA_REMOTE_HOST = 'https://ollama.com';
const DEFAULT_MODEL = 'qwen3';
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function log(msg: string): void {
  console.error(`[ollama-provider] ${msg}`);
}

/**
 * Convert SDK-shape MCP server config to executor-shape. Tools are omitted —
 * the executor's discover-all path (C7b1) lists tools from the connected
 * server itself, since v2's stdio mcpServer config carries no `tools` field.
 */
function sdkToExecutorConfig(sdk: SdkMcpConfig): ExecutorMcpConfig {
  if (sdk.type === 'http') {
    return { type: 'http', url: sdk.url, headers: sdk.headers };
  }
  return { command: sdk.command, args: sdk.args, env: sdk.env };
}

/** Push-pull async iterable for streaming provider events out of the engine call. */
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

/**
 * Strip the `ollama:` / `ollama-remote:` / `claude:` prefix if present.
 * Engine-selector already does this for per-message overrides; provider
 * does it defensively for any caller paths that bypass the selector.
 */
function stripOllamaPrefix(model: string): { model: string; remote: boolean } {
  if (model.startsWith('ollama-remote:')) return { model: model.slice('ollama-remote:'.length), remote: true };
  if (model.startsWith('ollama:')) return { model: model.slice('ollama:'.length), remote: false };
  return { model, remote: false };
}

export class OllamaProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private mcpServers: Record<string, SdkMcpConfig>;
  private env: Record<string, string | undefined>;
  private localHost: string;
  private remoteHost: string;
  private defaultModel: string;

  constructor(options: ProviderOptions = {}) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.localHost = this.env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST;
    this.remoteHost = this.env.OLLAMA_REMOTE_HOST ?? DEFAULT_OLLAMA_REMOTE_HOST;
    this.defaultModel = this.env.OLLAMA_MODEL ?? DEFAULT_MODEL;
  }

  /**
   * Engines have no persistent session, so there's no "stale session" to
   * detect. The poll-loop's session-invalid retry path is a no-op here.
   */
  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const events = new EventQueue();
    const sessionId = `ollama-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requested = input.model ?? this.defaultModel;
    const { model, remote } = stripOllamaPrefix(requested);
    const host = remote ? this.remoteHost : this.localHost;

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
          while (true) {
            if (aborted) return;
            log(`Running ollama chat: model=${model} host=${host}`);
            const result = await runOllamaChat(userMessage, {
              host,
              model,
              systemPrompt: input.systemContext?.instructions,
              // Per-wiring overrides from K.1.f step 9.0:
              // NANOCLAW_MAX_TOOL_ROUNDS / NANOCLAW_TIMEOUT_MS env vars
              // set by container-runner at spawn from messaging_group_agents
              // (with fallback to backend-defaults[agent_provider]). Env
              // unset → keep this provider's hardcoded default.
              maxIterations: maxToolRoundsOr(DEFAULT_MAX_ITERATIONS),
              timeoutMs: timeoutMsOr(DEFAULT_TIMEOUT_MS),
              tools: executor.getOllamaTools(),
              toolNameMap: executor.getToolNameMap(),
              executeTool: (mcpName, args) => executor.callTool(mcpName, args),
              onStatus: () => events.push({ type: 'activity' }),
              onThinking: (thinking) =>
                events.push({ type: 'progress', message: thinking.slice(0, 200) }),
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

registerProvider('ollama', (opts) => new OllamaProvider(opts));
