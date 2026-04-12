/**
 * Nonce wrapping for observation payloads.
 * Applied at delivery time (consume_events), not at storage time.
 */

import crypto from 'crypto';

const NONCE_PATTERN = /===(?:END-)?OBSERVATION-[a-zA-Z0-9]+===/g;

/**
 * Strip any occurrence of observation nonce delimiters from text.
 * Prevents spoofing by removing attacker-injected delimiters.
 */
export function stripNoncePatterns(text: string): string {
  return text.replace(NONCE_PATTERN, '').replace(/\n{3,}/g, '\n\n');
}

/**
 * Wrap a payload with random nonce delimiters.
 * Strips existing nonce patterns from the payload first.
 */
export function wrapWithNonce(payload: string): {
  wrapped: string;
  nonce: string;
} {
  const nonce = crypto.randomBytes(8).toString('hex');
  const clean = stripNoncePatterns(payload);
  const wrapped = `===OBSERVATION-${nonce}===\n${clean}\n===END-OBSERVATION-${nonce}===`;
  return { wrapped, nonce };
}
