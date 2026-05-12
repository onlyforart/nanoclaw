import {
  getMessagingGroups,
  getMessagingGroupById,
  getAgentGroupsForMessagingGroup,
  type MessagingGroupRow,
  type AgentGroupRow,
} from '../db.js';

/**
 * Secondary navigation page (Q7=β). Lists every chat channel known to v2.
 * Each detail response includes a "wired agent groups" reverse-list so the
 * operator can see what an inbound message into a channel will trigger.
 */

interface MessagingGroupResponse {
  id: string;
  channelType: string;
  platformId: string;
  name: string | null;
  isGroup: boolean;
  unknownSenderPolicy: string;
  createdAt: string;
}

interface AgentGroupSummary {
  id: string;
  name: string;
  folder: string;
  agentProvider: string | null;
}

interface MessagingGroupDetailResponse extends MessagingGroupResponse {
  wiredAgentGroups: AgentGroupSummary[];
}

function formatMessagingGroup(row: MessagingGroupRow): MessagingGroupResponse {
  return {
    id: row.id,
    channelType: row.channel_type,
    platformId: row.platform_id,
    name: row.name,
    isGroup: row.is_group === 1,
    unknownSenderPolicy: row.unknown_sender_policy,
    createdAt: row.created_at,
  };
}

function formatAgentSummary(row: AgentGroupRow): AgentGroupSummary {
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    agentProvider: row.agent_provider,
  };
}

export function handleGetMessagingGroups(): MessagingGroupResponse[] {
  return getMessagingGroups().map(formatMessagingGroup);
}

export function handleGetMessagingGroup(id: string): MessagingGroupDetailResponse | null {
  const row = getMessagingGroupById(id);
  if (!row) return null;
  const wired = getAgentGroupsForMessagingGroup(id).map(formatAgentSummary);
  return {
    ...formatMessagingGroup(row),
    wiredAgentGroups: wired,
  };
}
