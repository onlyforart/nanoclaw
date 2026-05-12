/**
 * Per-message engine routing provider.
 *
 * Wraps a "default" child provider (whatever container.json's `provider`
 * field selects) plus on-demand alternates for ollama and anthropic-api.
 * On each query(), inspects the routing inputs (model / isScheduledTask /
 * useAgentSdk) the poll-loop pulls from the primary message's row and
 * uses engine-selector to pick the right child:
 *   - kind 'sdk'           → default child (whatever container.json said)
 *   - kind 'ollama'        → on-demand OllamaProvider
 *   - kind 'anthropic-api' → on-demand AnthropicApiProvider
 *
 * Alternates are lazy-constructed on first use to avoid spawning Ollama /
 * Anthropic-API connections in groups that never use them.
 *
 * Not registered in the provider registry — main() instantiates this
 * directly, wrapping the default provider with it. From the poll-loop's
 * point of view, RoutingProvider is just an AgentProvider.
 */
import { selectEngine, type EngineKind } from '../engine-selector.js';
import { createProvider, type ProviderName } from './factory.js';
import type { AgentProvider, AgentQuery, ProviderOptions, QueryInput } from './types.js';

const ENGINE_TO_PROVIDER_NAME: Record<EngineKind, ProviderName | null> = {
  sdk: null, // null sentinel — use the default child
  ollama: 'ollama',
  'anthropic-api': 'anthropic-api',
};

export class RoutingProvider implements AgentProvider {
  /** Surface flag from the default — slash command handling is the default's concern. */
  readonly supportsNativeSlashCommands: boolean;

  private defaultProvider: AgentProvider;
  private options: ProviderOptions;
  private alternates = new Map<ProviderName, AgentProvider>();

  constructor(defaultProvider: AgentProvider, options: ProviderOptions = {}) {
    this.defaultProvider = defaultProvider;
    this.options = options;
    this.supportsNativeSlashCommands = defaultProvider.supportsNativeSlashCommands;
  }

  /** Default's session-invalid logic only — alternates have no persistent session. */
  isSessionInvalid(err: unknown): boolean {
    return this.defaultProvider.isSessionInvalid(err);
  }

  query(input: QueryInput): AgentQuery {
    const decision = selectEngine({
      model: input.model,
      isScheduledTask: input.isScheduledTask,
      useAgentSdk: input.useAgentSdk,
    });

    const altName = ENGINE_TO_PROVIDER_NAME[decision.kind];
    if (altName === null) {
      // Default child path — pass through with stripped model.
      return this.defaultProvider.query({ ...input, model: decision.model });
    }

    let provider = this.alternates.get(altName);
    if (!provider) {
      provider = createProvider(altName, this.options);
      this.alternates.set(altName, provider);
    }

    return provider.query({ ...input, model: decision.model });
  }
}
