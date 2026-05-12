/**
 * Engine selector — pure decision module.
 *
 * Encodes the v1 prefix-based routing rule from `index.ts`:
 *   1. Strip `claude:` prefix (documentary only — routes to SDK like a bare model name).
 *   2. `ollama:` or `ollama-remote:` prefix → ollama direct mode.
 *   3. `anthropic:` prefix OR (isScheduledTask && !useAgentSdk) → anthropic-api mode.
 *   4. Default → Agent SDK.
 *
 * The split exists because each engine path has a different cost/behaviour profile:
 *   - Agent SDK: full Claude Code preset (~thousands of preset tokens). Best for
 *     interactive sessions where the preset's tool guidance is wanted.
 *   - anthropic-api: raw /v1/messages, no preset. Production scheduled tasks all use
 *     this (`use_agent_sdk=0`) to avoid the preset's bias and token cost.
 *   - ollama: local or remote Ollama, no Anthropic API at all. Dev workflow path
 *     for iterating on new tasks against cheap models before promotion.
 */

export type EngineKind = 'sdk' | 'ollama' | 'anthropic-api';

export interface EngineSelectionInput {
  /** The `model` field as received in the container input (may include prefix). */
  model?: string;
  /** Whether this invocation is a scheduled (non-interactive) task. */
  isScheduledTask?: boolean;
  /** Explicit override: when true, scheduled tasks route through SDK instead of anthropic-api. */
  useAgentSdk?: boolean;
}

export interface EngineSelection {
  kind: EngineKind;
  /** Prefix-stripped model. Undefined if input.model was undefined. */
  model: string | undefined;
  /** Only set when kind === 'ollama'. True for `ollama-remote:` prefix, false for `ollama:`. */
  remote?: boolean;
}

const CLAUDE_PREFIX = 'claude:';
const OLLAMA_PREFIX = 'ollama:';
const OLLAMA_REMOTE_PREFIX = 'ollama-remote:';
const ANTHROPIC_PREFIX = 'anthropic:';

export function selectEngine(input: EngineSelectionInput): EngineSelection {
  let model = input.model;

  // Strip claude: prefix (documentary — does not change routing destination)
  if (model?.startsWith(CLAUDE_PREFIX)) {
    model = model.slice(CLAUDE_PREFIX.length);
  }

  // Ollama direct (local or remote)
  if (model?.startsWith(OLLAMA_REMOTE_PREFIX)) {
    return { kind: 'ollama', model: model.slice(OLLAMA_REMOTE_PREFIX.length), remote: true };
  }
  if (model?.startsWith(OLLAMA_PREFIX)) {
    return { kind: 'ollama', model: model.slice(OLLAMA_PREFIX.length), remote: false };
  }

  // Anthropic API (explicit prefix or scheduled-task fallback)
  if (model?.startsWith(ANTHROPIC_PREFIX)) {
    return { kind: 'anthropic-api', model: model.slice(ANTHROPIC_PREFIX.length) };
  }
  if (input.isScheduledTask && !input.useAgentSdk) {
    return { kind: 'anthropic-api', model };
  }

  // Default: Agent SDK
  return { kind: 'sdk', model };
}
