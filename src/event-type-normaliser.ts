// Defends consume_events against sloppy LLM-produced event type strings.
// Small local models (gemma4) periodically wrap event types in regex-
// or quote-like delimiters: ["|observation.*|"] instead of
// ["observation.*"]. Treating those literally matches zero rows in
// consumeEvents and silently starves the consumer task. Strip the noise
// before the pattern reaches SQL.
//
// Only characters at the leading AND trailing edges are stripped —
// internal pipes or slashes could be part of a legitimate event type.

const EDGE_NOISE = new Set<string>(['|', '/', '"', "'", '`', ' ', '\t', '\n', '\r']);

export interface NormalisedEventType {
  /** Cleaned event type, or null if nothing usable remained. */
  normalised: string | null;
  /** Distinct noise characters that were stripped (for telemetry). */
  strippedChars: string;
}

export function normaliseEventType(input: string): NormalisedEventType {
  const stripped = new Set<string>();
  let s = input;

  // Strip characters from both ends as long as the ends are noise.
  // Shrinks monotonically so no unbounded loop.
  while (s.length > 0) {
    const first = s[0];
    const last = s[s.length - 1];
    if (EDGE_NOISE.has(first)) {
      stripped.add(first);
      s = s.slice(1);
      continue;
    }
    if (EDGE_NOISE.has(last)) {
      stripped.add(last);
      s = s.slice(0, -1);
      continue;
    }
    break;
  }

  return {
    normalised: s.length > 0 ? s : null,
    strippedChars: [...stripped].join(''),
  };
}

export interface NormalisedEventTypeList {
  normalised: string[];
  anyStripped: boolean;
}

export function normaliseEventTypes(inputs: string[]): NormalisedEventTypeList {
  const out: string[] = [];
  const seen = new Set<string>();
  let anyStripped = false;
  for (const raw of inputs) {
    const result = normaliseEventType(raw);
    if (result.strippedChars.length > 0) anyStripped = true;
    if (result.normalised == null) continue;
    if (seen.has(result.normalised)) continue;
    seen.add(result.normalised);
    out.push(result.normalised);
  }
  return { normalised: out, anyStripped };
}
