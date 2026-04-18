/**
 * Polling-based assertor: waits up to timeout_ms for scenarios' expected
 * outcomes to appear in pipeline_clusters and events, then compares.
 */

import {
  getClustersByObservations,
  getDownstreamEvents,
  type ClusterSnapshot,
  type DownstreamEventRow,
} from './db.js';
import type { ExpectedCluster, ExpectedEvent, Scenario } from './types.js';
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

function quickCheck(
  expClusters: ExpectedCluster[],
  gotClusters: ClusterSnapshot[],
  expEvents: ExpectedEvent[],
  gotEvents: DownstreamEventRow[],
  testObsIds: Set<number>,
): boolean {
  // Quick check: all expected cluster keys appear with enough of THIS
  // test's observations in them (not total cluster size — the cluster
  // can legitimately contain live traffic too), and all expected event
  // types reach at least their target count.
  for (const exp of expClusters) {
    const match = gotClusters.find((c) => c.cluster_key === exp.key);
    if (!match) return false;
    const testObsInCluster = match.observation_ids.filter((id) =>
      testObsIds.has(id),
    ).length;
    if (testObsInCluster < exp.observation_count) return false;
    if (exp.status && match.status !== exp.status) return false;
  }
  for (const exp of expEvents) {
    const count = gotEvents.filter((e) => e.type === exp.type).length;
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

  for (const exp of expClusters) {
    const match = gotClusters.find((c) => c.cluster_key === exp.key);
    if (!match) {
      failures.push(
        `Expected cluster with key="${exp.key}" not found. Got: [${gotClusters
          .map((c) => c.cluster_key)
          .join(', ')}]`,
      );
      continue;
    }
    const testObsInCluster = match.observation_ids.filter((id) =>
      testObsIds.has(id),
    ).length;
    if (testObsInCluster !== exp.observation_count) {
      failures.push(
        `Cluster "${exp.key}" contains ${testObsInCluster} of this test's observations, expected ${exp.observation_count}`,
      );
    }
    if (exp.status && match.status !== exp.status) {
      failures.push(
        `Cluster "${exp.key}" status="${match.status}", expected "${exp.status}"`,
      );
    }
  }

  // Extra clusters that weren't expected (cluster-key routing loose)
  for (const got of gotClusters) {
    if (!expClusters.some((e) => e.key === got.cluster_key)) {
      failures.push(
        `Unexpected cluster formed: key="${got.cluster_key}", observations=${got.observation_count}`,
      );
    }
  }

  for (const exp of expEvents) {
    const matches = gotEvents.filter((e) => e.type === exp.type);
    if (matches.length !== exp.count) {
      failures.push(
        `Expected ${exp.count} events of type "${exp.type}", got ${matches.length}`,
      );
    }
    if (exp.payload_contains && matches.length > 0) {
      for (const m of matches) {
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

  // Extra event types not expected (mutex violation, duplicate emit)
  const expectedTypes = new Set(expEvents.map((e) => e.type));
  for (const got of gotEvents) {
    if (!expectedTypes.has(got.type as ExpectedEvent['type'])) {
      failures.push(
        `Unexpected downstream event: id=${got.id} type="${got.type}"`,
      );
    }
  }

  return failures;
}
