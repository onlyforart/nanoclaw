/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const isScheduledTask = process.env.NANOCLAW_IS_SCHEDULED_TASK === '1';
const isOllama = process.env.NANOCLAW_IS_OLLAMA === '1';

// Model description varies: Ollama models should not see Claude aliases
const modelDescription = isOllama
  ? 'Model to use (e.g., "ollama:modelname" or "ollama-remote:modelname"). Omit to use the group default.'
  : 'Model to use. Aliases: "haiku" (default), "sonnet", "opus". Ollama: "ollama:modelname" or "ollama-remote:modelname". Defaults to haiku if omitted.';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/**
 * Write an IPC file and wait for a result file from the host.
 * The host writes {filename}.result after processing.
 * Returns the parsed result or a timeout error.
 */
async function writeIpcFileAndWaitForResult(
  dir: string,
  data: object,
  timeoutMs = 10_000,
): Promise<{ success: boolean; error?: string }> {
  const filename = writeIpcFile(dir, data);
  const resultPath = path.join(dir, `${filename}.result`);

  const pollMs = 200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      try {
        const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
        fs.unlinkSync(resultPath);
        return result;
      } catch {
        // Result file may be partially written; retry
      }
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return { success: false, error: 'Timed out waiting for host confirmation' };
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Default is "isolated". Only use "group" if the user explicitly asks for conversation context or subagents.
\u2022 "isolated" (default): Task runs in a fresh session with no conversation history. Include all necessary context in the prompt itself. This is faster and avoids unnecessary subagent orchestration.
\u2022 "group": Task runs in the group's conversation context, with access to chat history and subagents. Only use when the user specifically requests it.

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

TIMEZONE - Optional IANA timezone for this task (e.g., "Europe/London", "America/New_York", "Asia/Tokyo"). If omitted, uses the system default. Use this when the user specifies times in a particular timezone.

SCHEDULE VALUE FORMAT (times are interpreted in the task's timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('isolated').describe('isolated=fresh session (default, faster), group=runs with chat history and subagents (only if user explicitly requests it)'),
    model: z.string().optional().describe(modelDescription),
    timezone: z.string().optional().describe('IANA timezone for this task (e.g., "Europe/London", "America/New_York"). Cron and once times are interpreted in this timezone. Defaults to system timezone if omitted.'),
    max_tool_rounds: z.number().int().positive().optional().describe('Maximum tool-calling rounds per invocation. Defaults to backend default.'),
    timeout_ms: z.number().int().positive().optional().describe('Per-invocation timeout in milliseconds. Defaults to backend default.'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Defense-in-depth: scheduled tasks must not create new tasks
    if (isScheduledTask) {
      return {
        content: [{ type: 'text' as const, text: 'Scheduled tasks cannot create new tasks.' }],
        isError: true,
      };
    }

    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data: Record<string, string | number | boolean | undefined> = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'isolated',
      model: args.model || undefined,
      timezone: args.timezone || undefined,
      maxToolRounds: args.max_tool_rounds,
      timeoutMs: args.timeout_ms,
      targetJid,
      createdBy: groupFolder,
      fromScheduledTask: isScheduledTask,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; timezone?: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}${t.timezone ? ` [${t.timezone}]` : ''}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    const result = await writeIpcFileAndWaitForResult(TASKS_DIR, data);
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Failed to pause task ${args.task_id}: ${result.error}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} paused.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    const result = await writeIpcFileAndWaitForResult(TASKS_DIR, data);
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Failed to resume task ${args.task_id}: ${result.error}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resumed.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    const result = await writeIpcFileAndWaitForResult(TASKS_DIR, data);
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Failed to cancel task ${args.task_id}: ${result.error}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancelled.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
    model: z.string().optional().describe(modelDescription),
    timezone: z.string().optional().describe('IANA timezone for this task (e.g., "Europe/London", "America/New_York"). Set to empty string to clear and use system default.'),
    max_tool_rounds: z.number().int().positive().optional().describe('Maximum tool-calling rounds. Omit to keep current value.'),
    timeout_ms: z.number().int().positive().optional().describe('Per-invocation timeout in milliseconds. Omit to keep current value.'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | number | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.model !== undefined) data.model = args.model || undefined;
    if (args.timezone !== undefined) data.timezone = args.timezone || undefined;
    if (args.max_tool_rounds !== undefined) data.maxToolRounds = args.max_tool_rounds;
    if (args.timeout_ms !== undefined) data.timeoutMs = args.timeout_ms;

    const result = await writeIpcFileAndWaitForResult(TASKS_DIR, data);
    if (!result.success) {
      return {
        content: [{ type: 'text' as const, text: `Failed to update task ${args.task_id}: ${result.error}` }],
        isError: true,
      };
    }

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} updated.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    model: z.string().optional().describe(modelDescription),
    max_tool_rounds: z.number().int().positive().optional().describe('Maximum tool-calling rounds per invocation. Defaults to backend default.'),
    timeout_ms: z.number().int().positive().optional().describe('Per-invocation timeout in milliseconds. Defaults to backend default.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data: Record<string, string | number | undefined> = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      model: args.model || undefined,
      maxToolRounds: args.max_tool_rounds,
      timeoutMs: args.timeout_ms,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

server.tool(
  'update_group',
  'Update settings for a registered group. Main group only. Supports model, max_tool_rounds, and timeout_ms.',
  {
    jid: z.string().describe('The chat JID of the group to update'),
    model: z.string().optional().describe(modelDescription),
    max_tool_rounds: z.number().int().positive().optional().describe('Maximum tool-calling rounds per invocation. Omit to keep current value.'),
    timeout_ms: z.number().int().positive().optional().describe('Per-invocation timeout in milliseconds. Omit to keep current value.'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can update groups.' }],
        isError: true,
      };
    }

    const data: Record<string, string | number | undefined> = {
      type: 'update_group',
      jid: args.jid,
      model: args.model || undefined,
      maxToolRounds: args.max_tool_rounds,
      timeoutMs: args.timeout_ms,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group ${args.jid} update requested.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
