/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { Ollama } from 'ollama';
import { runOllamaChat } from './ollama-chat-engine.js';
import { runAnthropicApiChat } from './anthropic-api-engine.js';
import { McpToolExecutor, McpServerConfig } from './mcp-tool-executor.js';
import { buildOllamaSystemPrompt } from './ollama-system-prompt.js';
import { buildTaskSystemPrompt } from './task-system-prompt.js';
import { buildSdkMcpServers } from './mcp-config.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.js';

const MAX_TOOL_CALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min absolute cap

/** Cap tool call timeout to leave headroom for the agent to process errors. */
function toolCallTimeout(chatTimeoutMs: number | undefined): number {
  if (!chatTimeoutMs) return MAX_TOOL_CALL_TIMEOUT_MS;
  // 80% of chat timeout, but never more than the absolute cap
  return Math.min(Math.floor(chatTimeoutMs * 0.8), MAX_TOOL_CALL_TIMEOUT_MS);
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  temperature?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  showThinking?: boolean;
  useAgentSdk?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  };
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Load channel-specific overrides from /workspace/global/{CHANNEL}.md
  // e.g. slack_main → SLACK.md, telegram_dev → TELEGRAM.md
  const channelPrefix = containerInput.groupFolder.split('_')[0]?.toUpperCase();
  if (channelPrefix) {
    const channelMdPath = `/workspace/global/${channelPrefix}.md`;
    if (fs.existsSync(channelMdPath)) {
      const channelMd = fs.readFileSync(channelMdPath, 'utf-8');
      globalClaudeMd = globalClaudeMd ? `${globalClaudeMd}\n\n${channelMd}` : channelMd;
    }
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  // Discover additional MCP servers from host-mounted config.
  // HTTP entries are rewritten to spawn mcp-http-bridge.js as a stdio child
  // process, so the Claude SDK uses the same StreamableHTTPClientTransport as
  // the Ollama direct mode path (see docs/REMOTE-MCP-SERVERS.md).
  let additionalMcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  let additionalMcpTools: string[] = [];
  const mcpConfigPath = '/workspace/mcp-servers-config/config.json';
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const bridgePath = path.join(path.dirname(mcpServerPath), 'mcp-http-bridge.js');
      const result = buildSdkMcpServers(mcpConfig, bridgePath);
      additionalMcpServers = result.mcpServers;
      additionalMcpTools = result.mcpTools;
    } catch (err) {
      log(`Failed to load MCP servers config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for await (const message of query({
    prompt: stream,
    options: {
      cwd: '/workspace/group',
      model: containerInput.model || undefined,
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: globalClaudeMd
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: globalClaudeMd }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__ollama__*',
        ...additionalMcpTools,
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ollama: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')],
        },
        ...additionalMcpServers,
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const msg = message as Record<string, unknown>;
      log(`Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);
      const output: ContainerOutput = {
        status: 'success',
        result: textResult || null,
        newSessionId,
      };
      if (msg.usage) {
        const usage = msg.usage as Record<string, unknown>;
        const baseInput = (usage.input_tokens as number) || 0;
        const cacheRead = (usage.cache_read_input_tokens as number) || 0;
        const cacheCreation = (usage.cache_creation_input_tokens as number) || 0;
        output.usage = {
          inputTokens: baseInput + cacheRead + cacheCreation,
          outputTokens: (usage.output_tokens as number) || 0,
          cacheReadInputTokens: cacheRead,
          cacheCreationInputTokens: cacheCreation,
          costUSD: msg.total_cost_usd as number | undefined,
        };
        log(`  Usage: ${output.usage.inputTokens} in (${cacheRead} cached), ${output.usage.outputTokens} out, $${output.usage.costUSD?.toFixed(4) ?? 'n/a'}`);
      }
      writeOutput(output);
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

const IPC_MESSAGES_DIR = '/workspace/ipc/messages';

/**
 * Write an IPC message file directly (outside MCP) so the host can deliver it
 * to the group's channel. Same format as ipc-mcp-stdio.ts send_message.
 */
function writeIpcNotification(chatJid: string, groupFolder: string, text: string): void {
  fs.mkdirSync(IPC_MESSAGES_DIR, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(IPC_MESSAGES_DIR, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    type: 'message',
    chatJid,
    text,
    groupFolder,
    timestamp: new Date().toISOString(),
  }, null, 2));
  fs.renameSync(tempPath, filepath);
}

/**
 * Check if an Ollama host is reachable by calling its list models endpoint.
 * Returns true if reachable, false otherwise.
 */
async function isOllamaReachable(host: string, retries = 3, delayMs = 2000): Promise<boolean> {
  const ollama = new Ollama({ host });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await ollama.list();
      return true;
    } catch {
      if (attempt < retries) {
        log(`Ollama at ${host} not reachable (attempt ${attempt}/${retries}), retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  return false;
}

/**
 * Run Ollama direct mode — bypass Claude SDK entirely.
 * Spawns MCP server processes directly and drives Ollama with tool calling.
 *
 * Fallback logic for ollama-remote:
 *   1. If remote host is unreachable, notify the group and fall back to local Ollama.
 *   2. If local Ollama is also unreachable, notify the group and exit with error.
 * For ollama (local only):
 *   1. If local host is unreachable, notify the group and exit with error.
 */
async function runOllamaDirectMode(containerInput: ContainerInput): Promise<void> {
  const model = containerInput.model!;
  const colonIdx = model.indexOf(':');
  const prefix = model.slice(0, colonIdx);
  const ollamaModel = model.slice(colonIdx + 1);

  const remoteHost = process.env.OLLAMA_REMOTE_HOST || 'http://localhost:11434';
  const localHost = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

  let host: string;
  if (prefix === 'ollama-remote') {
    host = remoteHost;
    log(`Ollama direct mode: model=${ollamaModel} host=${host} (remote)`);

    if (!await isOllamaReachable(host)) {
      log(`Remote Ollama at ${host} is not reachable, falling back to local`);
      writeIpcNotification(
        containerInput.chatJid,
        containerInput.groupFolder,
        `⚠️ Remote Ollama is not available. Falling back to local Ollama.`,
      );
      host = localHost;

      if (!await isOllamaReachable(host)) {
        const msg = `Local Ollama is also not available. ${containerInput.isScheduledTask ? 'Scheduled task' : 'Command'} failed.`;
        log(`Local Ollama at ${host} is not reachable either`);
        writeIpcNotification(containerInput.chatJid, containerInput.groupFolder, `❌ ${msg}`);
        writeOutput({ status: 'error', result: null, error: msg });
        return;
      }
      log(`Fell back to local Ollama at ${host}`);
    }
  } else {
    host = localHost;
    log(`Ollama direct mode: model=${ollamaModel} host=${host} (local)`);

    if (!await isOllamaReachable(host)) {
      const msg = `Local Ollama is not available. ${containerInput.isScheduledTask ? 'Scheduled task' : 'Command'} failed.`;
      log(`Local Ollama at ${host} is not reachable`);
      writeIpcNotification(containerInput.chatJid, containerInput.groupFolder, `❌ ${msg}`);
      writeOutput({ status: 'error', result: null, error: msg });
      return;
    }
  }

  // Load MCP server config
  const mcpConfigPath = '/workspace/mcp-servers-config/config.json';
  let mcpConfig: Record<string, McpServerConfig> = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    } catch (err) {
      log(`Failed to load MCP config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Add the nanoclaw IPC server
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ipcServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
  const isOllama = containerInput.model?.startsWith('ollama:') || containerInput.model?.startsWith('ollama-remote:');

  // Scheduled tasks only get send_message, send_cross_channel_message, and
  // list_tasks — they must not create/modify tasks or groups (defense-in-depth
  // against runaway models).
  let nanoclawTools = containerInput.isScheduledTask
    ? ['send_message', 'send_cross_channel_message', 'list_tasks', 'publish_event', 'consume_events', 'ack_event', 'submit_to_pipeline', 'read_chat_messages', 're_extract_observation']
    : ['send_message', 'send_cross_channel_message', 'schedule_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task', 'update_task', 'register_group', 'update_group', 'list_groups', 'publish_event', 'consume_events', 'ack_event', 'submit_to_pipeline', 'read_chat_messages', 're_extract_observation'];

  // Pipeline allow-list: if set, intersect with the base tool set.
  // This restricts the task to only the tools explicitly granted.
  const allowedToolsSet = containerInput.allowedTools
    ? new Set(containerInput.allowedTools)
    : null;
  if (allowedToolsSet) {
    nanoclawTools = nanoclawTools.filter((t) => allowedToolsSet.has(t));
  }

  mcpConfig['nanoclaw'] = {
    command: 'node',
    args: [ipcServerPath],
    tools: nanoclawTools,
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      NANOCLAW_IS_SCHEDULED_TASK: containerInput.isScheduledTask ? '1' : '0',
      NANOCLAW_IS_OLLAMA: isOllama ? '1' : '0',
    },
  };

  // Initialize MCP tool executor
  const executor = new McpToolExecutor();
  try {
    await executor.initialize(mcpConfig, undefined, {
      callTimeoutMs: toolCallTimeout(containerInput.timeoutMs),
    });
  } catch (err) {
    log(`MCP executor init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load skill files for lazy injection — skill content is injected into
  // the conversation only when a tool from that server is first called,
  // keeping the initial context small.
  const serverSkills = new Map<string, string>();
  for (const [name, config] of Object.entries(mcpConfig)) {
    const cfg = config as { skill?: string; skillContent?: string };

    // Remote servers: use pre-assembled skillContent from container config
    if (cfg.skillContent) {
      serverSkills.set(name, cfg.skillContent);
      log(`Loaded inline skill for ${name} (${cfg.skillContent.length} chars)`);
      continue;
    }

    // Stdio servers: existing file-based resolution
    if (!cfg.skill) continue;
    const candidates = [
      `/workspace/mcp-servers/${name}/${cfg.skill}`,
      `/home/node/.claude/skills/${name}/SKILL.md`,
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, 'utf-8');
          // Strip YAML frontmatter
          let content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

          // Inline referenced markdown files — the model can't read files,
          // so resolve relative links like [Title](skill/foo.md) and append
          // their content. This gives the model the full operational context.
          const skillDir = path.dirname(candidate);
          const refPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
          const inlined: string[] = [];
          let match;
          while ((match = refPattern.exec(content)) !== null) {
            const [, title, relPath] = match;
            const refFile = path.resolve(skillDir, relPath);
            if (fs.existsSync(refFile)) {
              try {
                const refContent = fs.readFileSync(refFile, 'utf-8').trim();
                if (refContent) {
                  inlined.push(`### ${title}\n\n${refContent}`);
                }
              } catch { /* skip */ }
            }
          }
          if (inlined.length > 0) {
            content += '\n\n' + inlined.join('\n\n');
          }

          if (content) {
            serverSkills.set(name, content);
            log(`Loaded skill for ${name} from ${candidate} (${inlined.length} referenced docs inlined)`);
          }
        } catch { /* skip */ }
        break;
      }
    }
  }

  const systemPrompt = buildOllamaSystemPrompt(containerInput);

  // Build prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Drain any pending IPC messages
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run chat → wait for IPC → repeat
  try {
    while (true) {
      log(`Starting Ollama chat (model: ${ollamaModel})...`);

      const result = await runOllamaChat(prompt, {
        host,
        model: ollamaModel,
        systemPrompt,
        temperature: containerInput.temperature,
        maxIterations: containerInput.maxToolRounds || 10,
        timeoutMs: containerInput.timeoutMs || 300_000,
        tools: executor.getOllamaTools(),
        toolNameMap: executor.getToolNameMap(),
        executeTool: (name, args) => executor.callTool(name, args),
        onThinking: containerInput.showThinking ? (thinking) => {
          const quoted = thinking.split('\n').map((l) => `> ${l}`).join('\n');
          writeIpcNotification(containerInput.chatJid, containerInput.groupFolder, quoted);
        } : undefined,
        serverSkills,
      });

      const meta = result.timedOut ? ' [timeout]'
        : result.maxIterationsReached ? ' [max iterations]'
        : '';

      writeOutput({
        status: 'success',
        result: result.response || null,
        usage: {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
      });
      log(`  Usage: ${result.inputTokens} in, ${result.outputTokens} out`);

      if (meta) {
        log(`Chat ended${meta} after ${result.iterations} round(s)`);
      }

      // Check for _close sentinel
      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      // Wait for next IPC message or close
      log('Ollama chat done, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new chat`);
      prompt = nextMessage;
    }
  } finally {
    await executor.close();
  }
}

/**
 * Run Anthropic API direct mode — bypass Claude SDK, use raw Messages API.
 * Used for: scheduled tasks (default) and interactive groups with anthropic: prefix.
 * Mirrors runOllamaDirectMode() but uses the Anthropic API engine.
 */
async function runAnthropicApiMode(containerInput: ContainerInput): Promise<void> {
  let model = containerInput.model || 'haiku';
  if (model.startsWith('anthropic:')) {
    model = model.slice('anthropic:'.length);
  }

  log(`Anthropic API mode: model=${model} (scheduled=${containerInput.isScheduledTask || false})`);

  // Load MCP server config
  const mcpConfigPath = '/workspace/mcp-servers-config/config.json';
  let mcpConfig: Record<string, McpServerConfig> = {};
  if (fs.existsSync(mcpConfigPath)) {
    try {
      mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
    } catch (err) {
      log(`Failed to load MCP config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Add the nanoclaw IPC server
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const ipcServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  // Scheduled tasks get restricted tool access (same as Ollama path)
  let nanoclawTools = containerInput.isScheduledTask
    ? ['send_message', 'send_cross_channel_message', 'list_tasks', 'publish_event', 'consume_events', 'ack_event', 'submit_to_pipeline', 'read_chat_messages', 're_extract_observation']
    : ['send_message', 'send_cross_channel_message', 'schedule_task', 'list_tasks', 'pause_task', 'resume_task', 'cancel_task', 'update_task', 'register_group', 'update_group', 'list_groups', 'publish_event', 'consume_events', 'ack_event', 'submit_to_pipeline', 'read_chat_messages', 're_extract_observation'];

  // Pipeline allow-list: same filtering as Ollama path
  if (allowedToolsSet) {
    nanoclawTools = nanoclawTools.filter((t) => allowedToolsSet.has(t));
  }

  mcpConfig['nanoclaw'] = {
    command: 'node',
    args: [ipcServerPath],
    tools: nanoclawTools,
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      NANOCLAW_IS_SCHEDULED_TASK: containerInput.isScheduledTask ? '1' : '0',
      NANOCLAW_IS_OLLAMA: '0',
    },
  };

  // Initialize MCP tool executor
  const executor = new McpToolExecutor();
  try {
    await executor.initialize(mcpConfig, undefined, {
      callTimeoutMs: toolCallTimeout(containerInput.timeoutMs),
    });
  } catch (err) {
    log(`MCP executor init failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Load skill files for lazy injection (same logic as Ollama path)
  const serverSkills = new Map<string, string>();
  for (const [name, config] of Object.entries(mcpConfig)) {
    const cfg = config as { skill?: string; skillContent?: string };

    if (cfg.skillContent) {
      serverSkills.set(name, cfg.skillContent);
      log(`Loaded inline skill for ${name} (${cfg.skillContent.length} chars)`);
      continue;
    }

    if (!cfg.skill) continue;
    const candidates = [
      `/workspace/mcp-servers/${name}/${cfg.skill}`,
      `/home/node/.claude/skills/${name}/SKILL.md`,
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const raw = fs.readFileSync(candidate, 'utf-8');
          let content = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

          const skillDir = path.dirname(candidate);
          const refPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
          const inlined: string[] = [];
          let match;
          while ((match = refPattern.exec(content)) !== null) {
            const [, title, relPath] = match;
            const refFile = path.resolve(skillDir, relPath);
            if (fs.existsSync(refFile)) {
              try {
                const refContent = fs.readFileSync(refFile, 'utf-8').trim();
                if (refContent) {
                  inlined.push(`### ${title}\n\n${refContent}`);
                }
              } catch { /* skip */ }
            }
          }
          if (inlined.length > 0) {
            content += '\n\n' + inlined.join('\n\n');
          }

          if (content) {
            serverSkills.set(name, content);
            log(`Loaded skill for ${name} from ${candidate} (${inlined.length} referenced docs inlined)`);
          }
        } catch { /* skip */ }
        break;
      }
    }
  }

  const systemPrompt = buildTaskSystemPrompt(containerInput);

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }

  // Drain any pending IPC messages
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    prompt += '\n' + pending.join('\n');
  }

  // Session continuity: carry conversation history across IPC iterations
  let existingMessages: MessageParam[] | undefined;

  // Query loop: run chat → wait for IPC → repeat
  try {
    while (true) {
      log(`Starting Anthropic API chat (model: ${model})...`);

      const result = await runAnthropicApiChat(prompt, {
        model,
        systemPrompt,
        temperature: containerInput.temperature,
        maxIterations: containerInput.maxToolRounds || 15,
        timeoutMs: containerInput.timeoutMs || 300_000,
        tools: executor.getAnthropicTools(),
        toolNameMap: executor.getToolNameMap(),
        executeTool: (name, args) => executor.callTool(name, args),
        serverSkills,
        existingMessages,
      });

      // Preserve conversation history for next iteration
      existingMessages = result.messages;

      const meta = result.timedOut ? ' [timeout]'
        : result.maxIterationsReached ? ' [max iterations]'
        : '';

      // Anthropic API returns input_tokens as base only (excluding cache).
      // Aggregate to total (base + cache_read + cache_creation) to match the SDK convention.
      const totalIn = result.inputTokens + result.cacheReadInputTokens + result.cacheCreationInputTokens;
      writeOutput({
        status: 'success',
        result: result.response || null,
        usage: {
          inputTokens: totalIn,
          outputTokens: result.outputTokens,
          cacheReadInputTokens: result.cacheReadInputTokens,
          cacheCreationInputTokens: result.cacheCreationInputTokens,
        },
      });
      log(`  Usage: ${totalIn} in (${result.cacheReadInputTokens} cache read, ${result.cacheCreationInputTokens} cache write), ${result.outputTokens} out`);

      if (meta) {
        log(`Chat ended${meta} after ${result.iterations} round(s)`);
      }

      // Check for _close sentinel
      if (shouldClose()) {
        log('Close sentinel received, exiting');
        break;
      }

      // Wait for next IPC message or close
      log('Anthropic API chat done, waiting for next IPC message...');
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      // Handle /compact command
      if (nextMessage.trim() === '/compact') {
        log('Compact requested via /compact command');
        if (existingMessages && existingMessages.length > 2) {
          const beforeCount = existingMessages.length;
          // Use the engine's compaction by sending a compaction prompt
          const compactResult = await runAnthropicApiChat(
            'Summarize the key points, decisions, and context from this conversation so far.\nBe concise but preserve all information needed to continue the conversation coherently.\nInclude any pending tasks, open questions, or commitments made.',
            {
              model,
              systemPrompt,
              maxIterations: 1,
              timeoutMs: containerInput.timeoutMs || 300_000,
              tools: [],
              toolNameMap: new Map(),
              executeTool: async () => '',
              existingMessages,
            },
          );
          // Replace messages with compacted form
          const summaryText = compactResult.response;
          existingMessages = [
            { role: 'user', content: summaryText },
            { role: 'assistant', content: 'Understood, continuing.' },
          ];
          writeOutput({
            status: 'success',
            result: `Conversation compacted — ${beforeCount} messages → ${existingMessages.length} messages`,
          });
        } else {
          writeOutput({
            status: 'success',
            result: 'Nothing to compact — conversation is already minimal.',
          });
        }
        // Continue waiting for next message
        if (shouldClose()) {
          log('Close sentinel received after compact, exiting');
          break;
        }
        log('Compact done, waiting for next IPC message...');
        const afterCompact = await waitForIpcMessage();
        if (afterCompact === null) {
          log('Close sentinel received, exiting');
          break;
        }
        prompt = afterCompact;
        continue;
      }

      log(`Got new message (${nextMessage.length} chars), starting new chat`);
      prompt = nextMessage;
    }
  } finally {
    await executor.close();
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder} (model: ${containerInput.model || 'default'}, scheduled: ${containerInput.isScheduledTask || false})`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Strip claude: prefix (documentary only — routes to Agent SDK like bare model names)
  if (containerInput.model?.startsWith('claude:')) {
    containerInput.model = containerInput.model.slice('claude:'.length);
  }

  // Ollama direct mode: bypass Claude SDK entirely
  if (containerInput.model?.startsWith('ollama:') || containerInput.model?.startsWith('ollama-remote:')) {
    await runOllamaDirectMode(containerInput);
    return;
  }

  // Anthropic API mode: lightweight direct API calls (for anthropic: prefix or scheduled tasks)
  if (containerInput.model?.startsWith('anthropic:') || (containerInput.isScheduledTask && !containerInput.useAgentSdk)) {
    await runAnthropicApiMode(containerInput);
    return;
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
