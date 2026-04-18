/**
 * Scenario injection: read a Scenario, write synthetic observations
 * and observation.passive events, and bump the monitor so it picks
 * up the batch immediately.
 */

import crypto from 'node:crypto';

import {
  bumpConsumerNextRun,
  insertTestObservation,
  publishObservationEvent,
} from './db.js';
import type { Scenario } from './types.js';

export interface InjectionResult {
  observation_ids: number[];
  started_at: string;
  source_channel: string;
}

export async function injectScenario(
  scenario: Scenario,
): Promise<InjectionResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const observationIds: number[] = [];

  for (const msg of scenario.messages) {
    // Wait the relative offset from scenario start before injecting this
    // message. Keeps temporal ordering realistic so the monitor sees
    // distinct observation.passive events at different ticks when
    // dt_ms spans > 60s.
    const targetMs = startedAtMs + msg.dt_ms;
    const waitMs = Math.max(0, targetMs - Date.now());
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

    const ts = new Date().toISOString();
    const tsSlack = (Date.now() / 1000).toFixed(6);
    const sourceMessageId = tsSlack; // Slack-shaped ts string

    const sanitised = {
      ...msg.sanitised,
      sender_id: msg.sender_id,
      sender_name: `${msg.sender_name || msg.sender_id} (e2e-test)`,
      channel_id: scenario.source_channel,
      timestamp: ts,
      message_length: msg.text.length,
      is_bot_message: false,
    };

    const obsId = insertTestObservation({
      source_chat_jid: scenario.source_channel,
      source_message_id: sourceMessageId,
      raw_text: msg.text,
      sanitised_json: JSON.stringify(sanitised),
      sanitiser_version: scenario.sanitiser_version || '1',
      created_at: ts,
    });
    observationIds.push(obsId);

    publishObservationEvent({
      observation_id: obsId,
      source_channel: scenario.source_channel,
      source_message_id: sourceMessageId,
      sanitised,
      created_at: ts,
    });
  }

  // Kick the monitor immediately rather than waiting for its fallback.
  bumpConsumerNextRun('pipeline:monitor');

  return {
    observation_ids: observationIds,
    started_at: startedAt,
    source_channel: scenario.source_channel,
  };
}

/**
 * Generate a unique suffix so repeated runs of the same scenario don't
 * collide on sender ids (the monitor's participant-overlap heuristic
 * could otherwise fold distinct test runs into the same cluster).
 */
export function uniqueSuffix(): string {
  return crypto.randomBytes(3).toString('hex');
}
