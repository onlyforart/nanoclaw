/**
 * Plugin-extensible reaction handler chain.
 *
 * Plugins (loaded via the plugin loader, §4.6.5) register handlers via
 * `registerReactionHandler`. On each adapter reaction event, the host's
 * setup wiring (added in §4.6.6) calls `dispatchReaction(reaction)`,
 * which walks the chain in registration order. The first handler to
 * return `true` wins; subsequent handlers are skipped.
 *
 * Errors are logged + the chain continues to the next handler — one
 * misbehaving plugin must not starve others on the message hot path.
 */
import { log } from './log.js';
import type { Reaction } from './channels/adapter.js';

export type ReactionHandler = (reaction: Reaction) => Promise<boolean> | boolean;

const handlers: ReactionHandler[] = [];

export function registerReactionHandler(handler: ReactionHandler): void {
  handlers.push(handler);
}

/**
 * Pure dispatch over an explicit handler list. Exported for unit testing —
 * production callers use `dispatchReaction(reaction)` which delegates here
 * with the module-level registry.
 */
export async function dispatchToHandlers(list: ReactionHandler[], reaction: Reaction): Promise<void> {
  for (const h of list) {
    try {
      const claimed = await h(reaction);
      if (claimed) return;
    } catch (err) {
      log.warn('Reaction handler threw', {
        channelType: reaction.channelType,
        emoji: reaction.emoji,
        err,
      });
    }
  }
}

export async function dispatchReaction(reaction: Reaction): Promise<void> {
  await dispatchToHandlers(handlers, reaction);
}
