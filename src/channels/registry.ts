import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  OnReaction,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  /**
   * Optional: channels that can surface user reactions on messages
   * invoke this to feed the pipeline approval reacji handler (F5b).
   * Channels without reaction support omit it.
   */
  onReaction?: OnReaction;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
