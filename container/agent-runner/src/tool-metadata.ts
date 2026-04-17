/**
 * Authoritative catalogue of tools provided by the nanoclaw in-process MCP server.
 *
 * Every tool registered via `server.tool()` in `ipc-mcp-stdio.ts` must have a
 * matching entry here. The agent-runner derives its per-task allowlist from this
 * map (see `index.ts`). `ipc-mcp-stdio.ts` performs a self-consistency check at
 * startup: any drift between registrations and this catalogue causes a loud
 * startup failure rather than a silent runtime "tool missing" skip.
 *
 * Management tools (`management: true`) are denied to scheduled tasks as a
 * defense-in-depth measure against runaway models — they cannot create or
 * modify tasks or groups even if a task spec's `allowed_tools` would otherwise
 * permit it. This is a class-level gate; the per-task `allowed_tools` filter
 * applies on top.
 */

export type ToolMetadata = { management: boolean };

export const NANOCLAW_TOOL_META: Record<string, ToolMetadata> = {
  // messaging + reads — always safe
  send_message: { management: false },
  send_cross_channel_message: { management: false },
  read_chat_messages: { management: false },
  list_tasks: { management: false },

  // event bus — needed by pipeline consumers/producers
  publish_event: { management: false },
  consume_events: { management: false },
  ack_event: { management: false },

  // pipeline tools — safe for scheduled pipeline tasks
  submit_to_pipeline: { management: false },
  re_extract_observation: { management: false },
  get_active_clusters: { management: false },
  update_cluster: { management: false },

  // task + group management — denied to scheduled tasks
  schedule_task: { management: true },
  pause_task: { management: true },
  resume_task: { management: true },
  cancel_task: { management: true },
  update_task: { management: true },
  register_group: { management: true },
  update_group: { management: true },
};

export function deriveNanoclawTools(
  meta: Record<string, ToolMetadata>,
  isScheduledTask: boolean,
): string[] {
  const names = Object.keys(meta);
  return isScheduledTask
    ? names.filter((name) => !meta[name].management)
    : names;
}
