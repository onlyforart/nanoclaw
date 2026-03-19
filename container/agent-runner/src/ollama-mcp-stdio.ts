/**
 * Ollama MCP Server for NanoClaw
 *
 * Exposes local Ollama models as tools for the container agent.
 * The `ollama_chat` tool supports full MCP tool calling — it reads
 * pre-discovered tool schemas from the config, passes them to Ollama,
 * and when Ollama calls tools, returns the requests to Claude for
 * execution via the shared MCP server instances.
 *
 * This avoids spawning duplicate MCP server processes — Claude's
 * existing MCP connections handle all tool execution.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Ollama } from 'ollama';
import type { Message, Tool } from 'ollama';

import fs from 'fs';
import path from 'path';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';
const MCP_CONFIG_PATH = '/workspace/mcp-servers-config/config.json';

const DEFAULT_MAX_ITERATIONS = 10;
const TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: unknown;
}

interface McpServerEntry {
  command: string;
  args: string[];
  tools: string[];
  env?: Record<string, string>;
  skill?: string;
  toolSchemas?: ToolSchema[];
}

interface OllamaSession {
  messages: Message[];
  model: string;
  tools: Tool[];
  skills: Map<string, { content: string; injected: boolean }>;
  startTime: number;
  maxIterations: number;
  iterations: number;
}

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

/** Normalize tool call arguments — some models return a JSON string instead of an object */
function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch { /* best-effort */ }
}

async function ollamaFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  const url = `${OLLAMA_HOST}${urlPath}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (OLLAMA_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

// --- Tool Schema Loading ---

// Maps Ollama tool name -> { mcpTool: Claude's MCP tool name, serverName }
const toolNameMap = new Map<string, { mcpTool: string; serverName: string }>();
let allTools: Tool[] = [];
const serverSkills = new Map<string, string>(); // serverName -> skill content

function loadToolSchemas(): void {
  if (!fs.existsSync(MCP_CONFIG_PATH)) {
    log('No MCP servers config found — ollama_chat will work in text-only mode');
    return;
  }

  try {
    const raw = fs.readFileSync(MCP_CONFIG_PATH, 'utf-8');
    const config: Record<string, McpServerEntry> = JSON.parse(raw);

    for (const [name, entry] of Object.entries(config)) {
      if (!entry.toolSchemas || entry.toolSchemas.length === 0) continue;

      // Load skill if present
      if (entry.skill) {
        const serverPath = `/workspace/mcp-servers/${name}`;
        const candidates = [
          path.resolve(serverPath, entry.skill),
          `/home/node/.claude/skills/${name}/SKILL.md`,
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            try {
              const skillRaw = fs.readFileSync(candidate, 'utf-8');
              serverSkills.set(name, skillRaw.replace(/^---\n[\s\S]*?\n---\n/, '').trim());
              break;
            } catch { /* continue */ }
          }
        }
      }

      for (const schema of entry.toolSchemas) {
        const ollamaToolName = `${name}__${schema.name}`;
        const mcpToolName = `mcp__${name}__${schema.name}`;

        toolNameMap.set(ollamaToolName, { mcpTool: mcpToolName, serverName: name });

        allTools.push({
          type: 'function',
          function: {
            name: ollamaToolName,
            description: schema.description ?? '',
            parameters: schema.inputSchema as Tool['function']['parameters'],
          },
        });
      }
    }

    log(`Loaded ${allTools.length} tool schema(s) from config`);
    for (const tool of allTools) {
      log(`  - ${tool.function.name}`);
    }
  } catch (err) {
    log(`Error loading tool schemas: ${err instanceof Error ? err.message : String(err)}`);
  }
}

loadToolSchemas();

// --- Session Management ---

const sessions = new Map<string, OllamaSession>();

function generateSessionId(): string {
  return `ollama_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// --- Ollama Client ---

const ollama = new Ollama({ host: OLLAMA_HOST });

// --- MCP Server Definition ---

const server = new McpServer({
  name: 'ollama',
  version: '2.0.0',
});

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Use this to see which models are available before calling ollama_chat.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await ollamaFetch('/api/tags');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      const models = data.models || [];

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models installed. Run `ollama pull <model>` on the host to install one.' }] };
      }

      const list = models
        .map(m => `- ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`)
        .join('\n');

      log(`Found ${models.length} models`);
      return { content: [{ type: 'text' as const, text: `Installed models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_chat',
  'Send a message to a local Ollama model with full tool access. The model can call any MCP tools available to you. If Ollama needs to call tools, this will return a JSON response with the tool calls needed — execute each one and pass results to ollama_chat_continue. Use ollama_list_models first to see available models.',
  {
    model: z.string().describe('The model name (e.g., "qwen3", "mistral-small3.2")'),
    message: z.string().describe('The user message to send'),
    system: z.string().optional().describe('Optional system prompt'),
    maxIterations: z.number().optional().describe('Max tool-calling rounds (default: 10)'),
  },
  async (args) => {
    const maxIterations = args.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const startTime = Date.now();

    log(`>>> Chat with ${args.model} (${args.message.length} chars, ${allTools.length} tools available)`);
    if (allTools.length > 0) {
      log(`  Tools: ${allTools.map(t => t.function.name).join(', ')}`);
    }
    writeStatus('chatting', `Chat with ${args.model}`);

    try {
      const messages: Message[] = [];

      // Inject a system prompt so Ollama uses tools instead of refusing
      if (allTools.length > 0) {
        const toolList = allTools.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n');
        messages.push({
          role: 'system',
          content: `You are a helpful assistant. You have tool-calling capabilities. When the user asks you to check, query, or look up anything, you MUST call the appropriate tool. Never say you don't have access to tools — you do. Use them.\n\nAvailable tools:\n${toolList}`,
        });
      }

      if (args.system) {
        messages.push({ role: 'system', content: args.system });
      }

      // Rewrite "You have access to X tools" → "Use X tools" so the model
      // treats it as an instruction rather than a capability question
      const cleanedMessage = args.message
        .replace(/you have access to (the )?/gi, 'Use ')
        .trim();

      messages.push({ role: 'user', content: cleanedMessage });

      log(`  Calling ollama.chat with ${allTools.length} tools`);

      const response = await ollama.chat({
        model: args.model,
        messages,
        ...(allTools.length > 0 && { tools: allTools }),
        stream: false,
      });

      messages.push(response.message);

      // If Ollama wants to call tools, return them to Claude for execution
      if (response.message.tool_calls?.length) {
        const sessionId = generateSessionId();
        const skillsState = new Map<string, { content: string; injected: boolean }>();
        for (const [name, content] of serverSkills) {
          skillsState.set(name, { content, injected: false });
        }

        sessions.set(sessionId, {
          messages,
          model: args.model,
          tools: allTools,
          skills: skillsState,
          startTime,
          maxIterations,
          iterations: 1,
        });

        const toolCalls = response.message.tool_calls.map((tc) => {
          const ollamaName = tc.function.name;
          const mapping = toolNameMap.get(ollamaName);
          return {
            mcpTool: mapping?.mcpTool ?? ollamaName,
            arguments: normalizeArgs(tc.function.arguments),
          };
        });

        log(`  Ollama wants ${toolCalls.length} tool call(s), returning to Claude (session: ${sessionId})`);

        const result = JSON.stringify({
          status: 'tool_calls_needed',
          sessionId,
          toolCalls,
          instructions: 'Execute each tool call using the mcpTool name and arguments, then call mcp__ollama__ollama_chat_continue with the sessionId and toolResults array. Each toolResult should have { toolName (the mcpTool name), result (the text result) }.',
        }, null, 2);

        return { content: [{ type: 'text' as const, text: result }] };
      }

      // No tool calls — return the response directly
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const meta = `\n\n[${args.model} | ${elapsed}s]`;

      log(`<<< Done: ${args.model} | ${elapsed}s | ${(response.message.content || '').length} chars`);
      writeStatus('done', `${args.model} | ${elapsed}s`);

      return { content: [{ type: 'text' as const, text: (response.message.content || '') + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_chat_continue',
  'Continue an Ollama chat session after executing tool calls. Pass the sessionId from the previous ollama_chat response and the results of each tool call.',
  {
    sessionId: z.string().describe('The session ID from the ollama_chat response'),
    toolResults: z.array(z.object({
      toolName: z.string().describe('The mcpTool name that was called'),
      result: z.string().describe('The text result from the tool call'),
    })).describe('Results from each tool call'),
  },
  async (args) => {
    const session = sessions.get(args.sessionId);
    if (!session) {
      return {
        content: [{ type: 'text' as const, text: `Unknown session: ${args.sessionId}. Session may have expired.` }],
        isError: true,
      };
    }

    log(`>>> Continue session ${args.sessionId} with ${args.toolResults.length} tool result(s) (iteration ${session.iterations + 1})`);
    writeStatus('chatting', `Continue ${session.model} (round ${session.iterations + 1})`);

    try {
      // Inject skill instructions for servers being called for the first time
      for (const tr of args.toolResults) {
        // Find the server name from the tool name (mcp__{server}__{tool})
        const parts = tr.toolName.match(/^mcp__([^_]+)__/);
        if (parts) {
          const serverName = parts[1];
          const skill = session.skills.get(serverName);
          if (skill && !skill.injected) {
            session.messages.push({ role: 'system', content: skill.content });
            skill.injected = true;
            log(`  [injected skill for ${serverName}]`);
          }
        }

        session.messages.push({ role: 'tool', content: tr.result });
      }

      session.iterations++;

      // Check safety limits
      if (session.iterations > session.maxIterations) {
        const lastContent = session.messages
          .filter((m) => m.role === 'assistant' && m.content)
          .pop()?.content || 'Max iterations reached with no final response.';
        sessions.delete(args.sessionId);
        const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(1);
        return {
          content: [{ type: 'text' as const, text: `${lastContent}\n\n[${session.model} | ${elapsed}s | ${session.iterations} rounds | max iterations reached]` }],
        };
      }

      if (Date.now() - session.startTime > TOTAL_TIMEOUT_MS) {
        const lastContent = session.messages
          .filter((m) => m.role === 'assistant' && m.content)
          .pop()?.content || 'Timeout reached with no final response.';
        sessions.delete(args.sessionId);
        const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(1);
        return {
          content: [{ type: 'text' as const, text: `${lastContent}\n\n[${session.model} | ${elapsed}s | ${session.iterations} rounds | timeout]` }],
        };
      }

      // Continue the conversation
      const response = await ollama.chat({
        model: session.model,
        messages: session.messages,
        ...(session.tools.length > 0 && { tools: session.tools }),
        stream: false,
      });

      session.messages.push(response.message);

      // If Ollama wants more tool calls, return them
      if (response.message.tool_calls?.length) {
        const toolCalls = response.message.tool_calls.map((tc) => {
          const ollamaName = tc.function.name;
          const mapping = toolNameMap.get(ollamaName);
          return {
            mcpTool: mapping?.mcpTool ?? ollamaName,
            arguments: normalizeArgs(tc.function.arguments),
          };
        });

        log(`  Ollama wants ${toolCalls.length} more tool call(s) (round ${session.iterations})`);

        const result = JSON.stringify({
          status: 'tool_calls_needed',
          sessionId: args.sessionId,
          toolCalls,
          instructions: 'Execute each tool call, then call mcp__ollama__ollama_chat_continue again with the sessionId and toolResults.',
        }, null, 2);

        return { content: [{ type: 'text' as const, text: result }] };
      }

      // Final response — clean up session
      const elapsed = ((Date.now() - session.startTime) / 1000).toFixed(1);
      const meta = `\n\n[${session.model} | ${elapsed}s | ${session.iterations} tool round(s)]`;
      sessions.delete(args.sessionId);

      log(`<<< Done: ${session.model} | ${elapsed}s | ${session.iterations} round(s) | ${(response.message.content || '').length} chars`);
      writeStatus('done', `${session.model} | ${elapsed}s | ${session.iterations} round(s)`);

      return { content: [{ type: 'text' as const, text: (response.message.content || '') + meta }] };
    } catch (err) {
      sessions.delete(args.sessionId);
      return {
        content: [{ type: 'text' as const, text: `Failed to continue Ollama chat: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Start MCP Server ---

const transport = new StdioServerTransport();
await server.connect(transport);
