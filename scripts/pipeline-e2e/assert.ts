/**
 * Polling-based assertor: waits up to timeout_ms for scenarios' expected
 * outcomes to appear in pipeline_clusters and events, then compares.
 *
 * Matching rules:
 * - cluster_key: exact string, or /regex-pattern/ delimited by slashes.
 *   The LLM monitor sometimes picks equivalent slugs (topic:banter vs
 *   topic:general-banter); regex tolerates that.
 * - event type: string or array of strings. For borderline content, the
 *   LLM may reasonably pick either candidate.question or
 *   candidate.escalation — scenarios can accept either.
 */

import {
  getClustersByObservations,
  getDownstreamEvents,
  type ClusterSnapshot,
  type DownstreamEventRow,
} from './db.js';
import type {
  ExpectedCluster,
  ExpectedEvent,
  ExpectedEventType,
  Scenario,
} from './types.js';
import type { InjectionResult } from './inject.js';

export interface AssertResult {
  pass: boolean;
  clusters: ClusterSnapshot[];
  events: DownstreamEventRow[];
  failures: string[];
  waited_ms: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;
const POLL_MS = 3_000;

export async function assertOutcome(
  scenario: Scenario,
  injection: InjectionResult,
): Promise<AssertResult> {
  const timeoutMs = scenario.expected.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let clusters: ClusterSnapshot[] = [];
  let events: DownstreamEventRow[] = [];
  const testObsIds = new Set(injection.observation_ids);

  while (Date.now() < deadline) {
    clusters = getClustersByObservations(injection.observation_ids);
    events = getDownstreamEvents(
      injection.observation_ids,
      injection.started_at,
    );
    const quick = quickCheck(
      scenario.expected.clusters,
      clusters,
      scenario.expected.events,
      events,
      testObsIds,
    );
    if (quick) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  const failures = diagnose(
    scenario.expected.clusters,
    clusters,
    scenario.expected.events,
    events,
    testObsIds,
  );

  return {
    pass: failures.length === 0,
    clusters,
    events,
    failures,
    waited_ms: Date.now() - new Date(injection.started_at).getTime(),
  };
}

/**
 * True if `key` matches `pattern`. Pattern can be:
 *  - exact string: 'topic:foo' → equality
 *  - slash-delimited regex like /foo/i → RegExp (body between slashes,
 *    flags after the final slash).
 */
function clusterKeyMatches(key: string, pattern: string): boolean {
  if (pattern.length > 2 && pattern.startsWith('/')) {
    const lastSlash = pattern.lastIndexOf('/');
    if (lastSlash > 0) {
      const body = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      try {
        return new RegExp(body, flags).test(key);
      } catch {
        /* fall through to equality */
      }
    }
  }
  return key === pattern;
}

function acceptedTypes(t: ExpectedEvent['type']): Set<ExpectedEventType> {
  return new Set(Array.isArray(t) ? t : [t]);
}

function quickCheck(
  expClusters: ExpectedCluster[],
  gotClusters: ClusterSnapshot[],
  expEvents: ExpectedEvent[],
  gotEvents: DownstreamEventRow[],
  testObsIds: Set<number>,
): boolean {
  for (const exp of expClusters) {
    const match = gotClusters.find((c) => clusterKeyMatches(c.cluster_key, exp.key));
    if (!match) return false;
    const testObsInCluster = match.observation_ids.filter((id) =>
      testObsIds.has(id),
    ).length;
    if (testObsInCluster < exp.observation_count) return false;
    if (exp.status && match.status !== exp.status) return false;
  }
  for (const exp of expEvents) {
    const types = acceptedTypes(exp.type);
    const count = gotEvents.filter((e) =>
      types.has(e.type as ExpectedEventType),
    ).length;
    if (count < exp.count) return false;
  }
  return true;
}

function diagnose(
  expClusters: ExpectedCluster[],
  gotClusters: ClusterSnapshot[],
  expEvents: ExpectedEvent[],
  gotEvents: DownstreamEventRow[],
  testObsIds: Set<number>,
): string[] {
  const failures: string[] = [];
  const matchedClusterIds = new Set<number>();

  for (const exp of expClusters) {
    const match = gotClusters.find(
      (c) =>
        clusterKeyMatches(c.cluster_key, exp.key) &&
        !matchedClusterIds.has(c.id),
    );
    if (!match) {
      failures.push(
        `Expected cluster with key="${exp.key}" not found. Got: [${gotClusters
          .map((c) => c.cluster_key)
          .join(', ')}]`,
      );
      continue;
    }
    matchedClusterIds.add(match.id);
    const testObsInCluster = match.observation_ids.filter((id) =>
      testObsIds.has(id),
    ).length;
    if (testObsInCluster !== exp.observation_count) {
      failures.push(
        `Cluster "${match.cluster_key}" (matched expected "${exp.key}") contains ${testObsInCluster} of this test's observations, expected ${exp.observation_count}`,
      );
    }
    if (exp.status && match.status !== exp.status) {
      failures.push(
        `Cluster "${match.cluster_key}" status="${match.status}", expected "${exp.status}"`,
      );
    }
  }

  for (const got of gotClusters) {
    if (!matchedClusterIds.has(got.id)) {
      failures.push(
        `Unexpected cluster formed: key="${got.cluster_key}", observations=${got.observation_count}`,
      );
    }
  }

  const matchedEventIds = new Set<number>();

  for (const exp of expEvents) {
    const types = acceptedTypes(exp.type);
    const matches = gotEvents.filter(
      (e) =>
        types.has(e.type as ExpectedEventType) && !matchedEventIds.has(e.id),
    );
    const taken = matches.slice(0, exp.count);
    taken.forEach((m) => matchedEventIds.add(m.id));

    if (matches.length !== exp.count) {
      const label = Array.isArray(exp.type) ? exp.type.join('|') : exp.type;
      failures.push(
        `Expected ${exp.count} events of type "${label}", got ${matches.length}`,
      );
    }
    if (exp.payload_contains && taken.length > 0) {
      for (const m of taken) {
        try {
          const parsed = JSON.parse(m.payload);
          for (const [k, v] of Object.entries(exp.payload_contains)) {
            if (JSON.stringify(parsed[k]) !== JSON.stringify(v)) {
              failures.push(
                `Event ${m.id} (${m.type}): payload.${k}=${JSON.stringify(
                  parsed[k],
                )}, expected ${JSON.stringify(v)}`,
              );
            }
          }
        } catch {
          failures.push(`Event ${m.id} (${m.type}): malformed JSON payload`);
        }
      }
    }
  }

  for (const got of gotEvents) {
    if (!matchedEventIds.has(got.id)) {
      failures.push(
        `Unexpected downstream event: id=${got.id} type="${got.type}"`,
      );
    }
  }

  return failures;
}
