/**
 * Strip leaked special tokens from LLM tool-call arguments and
 * attempt to recover corrupted JSON values.
 *
 * Models sometimes leak tokenizer markers like <|, |>, <|im_start|>,
 * <|endoftext|> into tool argument strings. They also sometimes
 * produce malformed JSON in string-typed arguments. This module
 * cleans both issues so downstream consumers see sane values.
 */

// Matches: <|im_start|>, <|endoftext|>, <|", "|>, etc.
const SPECIAL_TOKEN_RE = /<\|\w+\|>|<\|"|"\|>/g;

/** Strip special-token markers from a single string value. */
export function stripSpecialTokens(value: string): string {
  if (!SPECIAL_TOKEN_RE.test(value)) return value;
  // Reset lastIndex since the regex has the global flag
  SPECIAL_TOKEN_RE.lastIndex = 0;
  return value.replace(SPECIAL_TOKEN_RE, '').trim();
}

/**
 * If a string looks like JSON (starts with { or [), validate it and
 * attempt to recover if corrupted. Returns the cleaned string regardless.
 */
export function repairJsonString(value: string): string {
  const cleaned = stripSpecialTokens(value);
  const trimmed = cleaned.trim();

  // Not JSON-shaped — return cleaned value as-is
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return cleaned;

  // Already valid JSON — return cleaned
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Fall through to recovery
  }

  // Recovery attempt 1: strip trailing garbage after last } or ]
  const closeBrace = trimmed.lastIndexOf('}');
  const closeBracket = trimmed.lastIndexOf(']');
  const lastClose = Math.max(closeBrace, closeBracket);
  if (lastClose > 0) {
    const truncated = trimmed.slice(0, lastClose + 1);
    try {
      JSON.parse(truncated);
      return truncated;
    } catch {
      // Continue
    }
  }

  // Recovery attempt 2: balance unclosed brackets/braces
  let balanced = trimmed;
  let opens = 0;
  let closesNeeded: string[] = [];
  for (const ch of balanced) {
    if (ch === '{') { opens++; closesNeeded.push('}'); }
    else if (ch === '[') { opens++; closesNeeded.push(']'); }
    else if (ch === '}' || ch === ']') { opens--; closesNeeded.pop(); }
  }
  if (opens > 0) {
    balanced += closesNeeded.reverse().join('');
    try {
      JSON.parse(balanced);
      return balanced;
    } catch {
      // Give up
    }
  }

  // Could not recover — return the cleaned (non-JSON) string
  return cleaned;
}

/**
 * Sanitize a single value: strip special tokens, repair JSON strings.
 */
function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return repairJsonString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  return value;
}

/**
 * Recursively sanitize all string values in a tool-call arguments object.
 * Returns a new object (does not mutate the input).
 */
export function sanitizeToolArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = sanitizeValue(value);
  }
  return result;
}
