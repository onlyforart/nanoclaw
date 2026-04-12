/**
 * Eval scoring — per-field comparison for Layer 1 and Layer 2.
 */

const LAYER2_BOOLEAN_FIELDS = new Set([
  'appears_to_address_bot',
  'contains_imperative',
]);

const LAYER2_STRING_FIELDS = new Set(['fact_summary', 'action_requested']);

// Everything else in Layer 2 expected is an enum field.

/**
 * Score Layer 1 deterministic fields. Only scores fields present in `expected`.
 * Returns a map of field name → pass/fail.
 */
export function scoreLayer1(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, boolean> {
  const scores: Record<string, boolean> = {};

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    const actualValue = actual[field];

    if (Array.isArray(expectedValue)) {
      // Set equality for arrays
      const expSet = new Set(expectedValue as string[]);
      const actSet = new Set((actualValue as string[]) ?? []);
      scores[field] =
        expSet.size === actSet.size &&
        [...expSet].every((v) => actSet.has(v));
    } else {
      // Exact match for booleans and other scalars
      scores[field] = actualValue === expectedValue;
    }
  }

  return scores;
}

/**
 * Score Layer 2 LLM-extracted fields. Only scores fields present in `expected`.
 * - Boolean fields: exact match
 * - String fields: substring containment (expected is a substring of actual), or both null
 * - Enum fields: exact match
 */
export function scoreLayer2(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): Record<string, boolean> {
  const scores: Record<string, boolean> = {};

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue === undefined) continue;
    const actualValue = actual[field];

    if (LAYER2_STRING_FIELDS.has(field)) {
      // Nullable string comparison
      if (expectedValue === null) {
        scores[field] = actualValue === null || actualValue === undefined;
      } else if (actualValue === null || actualValue === undefined) {
        scores[field] = false;
      } else {
        // Substring containment: expected substring must appear in actual
        scores[field] = String(actualValue)
          .toLowerCase()
          .includes(String(expectedValue).toLowerCase());
      }
    } else if (LAYER2_BOOLEAN_FIELDS.has(field)) {
      scores[field] = actualValue === expectedValue;
    } else {
      // Enum: exact match
      scores[field] = actualValue === expectedValue;
    }
  }

  return scores;
}

export interface CaseResult {
  caseId: string;
  scores: Record<string, boolean>;
}

export interface AggregateResult {
  casePassRate: number;
  fieldAccuracy: Record<string, number>;
}

/**
 * Aggregate per-case scores into overall metrics.
 */
export function aggregateScores(results: CaseResult[]): AggregateResult {
  if (results.length === 0) {
    return { casePassRate: 1, fieldAccuracy: {} };
  }

  // Per-field: count passes and total
  const fieldPasses: Record<string, number> = {};
  const fieldTotals: Record<string, number> = {};

  let casePasses = 0;

  for (const r of results) {
    let allPass = true;
    for (const [field, passed] of Object.entries(r.scores)) {
      fieldTotals[field] = (fieldTotals[field] ?? 0) + 1;
      if (passed) {
        fieldPasses[field] = (fieldPasses[field] ?? 0) + 1;
      } else {
        allPass = false;
      }
    }
    if (allPass) casePasses++;
  }

  const fieldAccuracy: Record<string, number> = {};
  for (const field of Object.keys(fieldTotals)) {
    fieldAccuracy[field] = (fieldPasses[field] ?? 0) / fieldTotals[field];
  }

  return {
    casePassRate: casePasses / results.length,
    fieldAccuracy,
  };
}
