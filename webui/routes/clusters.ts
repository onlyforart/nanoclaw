import {
  getClusters,
  getClusterById,
  getClusterObservations,
  type ClusterStatus,
} from '../db.js';
import { HttpError } from '../router.js';

export interface ClusterListResponse {
  id: number;
  sourceChannel: string;
  clusterKey: string;
  status: ClusterStatus;
  summary: string;
  observationCount: number;
  lastObservationAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface ClusterObservationResponse {
  id: number;
  sourceChatJid: string | null;
  rawText: string;
  createdAt: string;
}

export interface ClusterDetailResponse extends ClusterListResponse {
  observationIds: number[];
  observations: ClusterObservationResponse[];
}

function parseStatus(raw: string | undefined): ClusterStatus | undefined {
  if (raw === 'active' || raw === 'resolved' || raw === 'expired') return raw;
  return undefined;
}

function formatListRow(row: {
  id: number;
  source_channel: string;
  cluster_key: string;
  status: ClusterStatus;
  summary: string;
  observation_count: number;
  last_observation_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}): ClusterListResponse {
  return {
    id: row.id,
    sourceChannel: row.source_channel,
    clusterKey: row.cluster_key,
    status: row.status,
    summary: row.summary,
    observationCount: row.observation_count,
    lastObservationAt: row.last_observation_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export function handleGetClusters(
  query: Record<string, string>,
): ClusterListResponse[] {
  const rows = getClusters({
    status: parseStatus(query.status),
    sourceChannel: query.sourceChannel || undefined,
    limit: query.limit ? parseInt(query.limit, 10) : undefined,
    offset: query.offset ? parseInt(query.offset, 10) : undefined,
  });
  return rows.map(formatListRow);
}

export function handleGetCluster(id: number): ClusterDetailResponse {
  const row = getClusterById(id);
  if (!row) throw new HttpError(404, `Cluster ${id} not found`);

  let observationIds: number[] = [];
  try {
    const parsed = JSON.parse(row.observation_ids);
    if (Array.isArray(parsed)) {
      observationIds = parsed.filter((x): x is number => typeof x === 'number');
    }
  } catch {
    /* malformed JSON — treat as empty */
  }

  const observations = getClusterObservations(observationIds).map((o) => ({
    id: o.id,
    sourceChatJid: o.source_chat_jid,
    rawText: o.raw_text,
    createdAt: o.created_at,
  }));

  return {
    ...formatListRow(row),
    observationIds,
    observations,
  };
}
