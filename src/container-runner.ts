/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MCP_PROXY_PORT,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { isOllamaModel } from './connection-profiles.js';
import { readEnvFile } from './env.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  evaluatePolicy,
  loadPolicies,
  resolveTier,
  type PolicyAssignments,
} from './mcp-policy.js';
import {
  classifyServerEntry,
  ContainerServerEntry,
  discoverRemoteToolSchemas,
  resolveRemoteSkillContent,
  resolveTools,
  rewriteUrlForContainer,
  type ToolsDef,
} from './remote-mcp.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  taskId?: string;
  assistantName?: string;
  model?: string;
  temperature?: number;
  maxToolRounds?: number;
  timeoutMs?: number;
  showThinking?: boolean;
  useAgentSdk?: boolean;
  allowedTools?: string[] | null;
  allowedSendTargets?: string[] | null;
}

export interface ContainerOutput {
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

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Filter discovered tool schemas to only those in the configured tools list,
 * optionally further restricted by a per-task allowedTools allowlist.
 * Returns null if no tools survive filtering (caller should skip the server).
 */
export function filterServerTools(
  configuredTools: string[],
  discoveredSchemas: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>,
  allowedTools?: string[] | null,
): {
  tools: string[];
  toolSchemas: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
} | null {
  let effectiveTools = configuredTools;

  if (allowedTools) {
    const allowed = new Set(allowedTools);
    effectiveTools = effectiveTools.filter((t) => allowed.has(t));
    if (effectiveTools.length === 0) return null;
  }

  const toolSet = new Set(effectiveTools);
  const filteredSchemas = discoveredSchemas.filter((s) => toolSet.has(s.name));

  return { tools: effectiveTools, toolSchemas: filteredSchemas };
}

/**
 * Briefly spawn an MCP server to discover its tool schemas via JSON-RPC.
 * Uses newline-delimited JSON-RPC over stdio to avoid adding SDK dependency.
 */
function discoverToolSchemas(
  command: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<
  Array<{ name: string; description?: string; inputSchema: unknown }>
> {
  return new Promise((resolve) => {
    // Resolve 'node' to the current process executable to handle nvm/non-standard PATH
    const resolvedCommand = command === 'node' ? process.execPath : command;
    const proc = spawn(resolvedCommand, args, {
      cwd,
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = '';
    let initialized = false;
    const timeout = setTimeout(() => {
      proc.kill();
      resolve([]);
    }, 10_000);

    function sendJsonRpc(msg: unknown): void {
      proc.stdin!.write(JSON.stringify(msg) + '\n');
    }

    proc.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      // Parse newline-delimited JSON messages
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete last line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: { id?: number; result?: { tools?: unknown[] } };
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!initialized && msg.id === 1) {
          initialized = true;
          sendJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
          sendJsonRpc({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          });
        } else if (msg.id === 2) {
          clearTimeout(timeout);
          proc.kill();
          resolve(
            (msg.result?.tools || []) as Array<{
              name: string;
              description?: string;
              inputSchema: unknown;
            }>,
          );
        }
      }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      logger.debug(
        { stderr: chunk.toString().trim() },
        'MCP server stderr during schema discovery',
      );
    });

    proc.on('error', (err) => {
      logger.warn(
        { err: err.message },
        'MCP server process error during schema discovery',
      );
      clearTimeout(timeout);
      resolve([]);
    });
    proc.on('exit', (code) => {
      if (!initialized) {
        logger.warn(
          { code },
          'MCP server exited before schema discovery completed',
        );
        clearTimeout(timeout);
        resolve([]);
      }
    });

    // Send initialize request
    sendJsonRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'nanoclaw-schema-discovery', version: '1.0.0' },
      },
    });
  });
}

async function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  input?: ContainerInput,
): Promise<VolumeMount[]> {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Shadow .env so the agent cannot read secrets from the mounted project root.
    // Credentials are injected by the credential proxy, never exposed to containers.
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Shared pagepilot script library — read-only fallback layer that any
  // group can pull scripts from. Mounted at the same path for every group
  // so PAGEPILOT_STORE_SHARED can be a single fixed value. The host may
  // back this directory with a symlink to a private archive so the scripts
  // themselves can be version-controlled outside this tree. Mount is
  // skipped silently if the source doesn't exist.
  const sharedPagepilotDir = path.join(GROUPS_DIR, '.pagepilot');
  if (fs.existsSync(sharedPagepilotDir)) {
    mounts.push({
      hostPath: sharedPagepilotDir,
      containerPath: '/workspace/shared-pagepilot',
      readonly: true,
    });
  }

  // Session directory isolation:
  // - Messages use the group-level .claude/ (supports session resumption)
  // - Isolated tasks use .claude-task/ (wiped before each run to prevent
  //   stale session file accumulation that caused SDK startup hangs)
  const isIsolatedTask = input?.isScheduledTask && !input?.sessionId;
  const groupSessionsBase = path.join(DATA_DIR, 'sessions', group.folder);
  // Isolated tasks get a separate base directory for all per-run state,
  // preventing races with concurrent message containers and other tasks.
  const sessionSubdir = isIsolatedTask ? 'task-run' : 'message-run';
  const runBase = path.join(groupSessionsBase, sessionSubdir);
  const groupSessionsDir = path.join(runBase, '.claude');

  if (isIsolatedTask) {
    // Clean entire task-run directory before each isolated run
    fs.rmSync(runBase, { recursive: true, force: true });
  }
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Agent swarms (subagent orchestration) — disabled to avoid unnecessary token usage
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            // CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-run writable location so agents
  // can customize it without affecting other groups or concurrent containers.
  // Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(runBase, 'agent-runner-src');
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  // Mount external MCP servers defined in data/mcp-servers.json (gitignored).
  // Each server's build directory is mounted read-only into the container.
  // A container-side config is written so the agent-runner can discover them.
  // Tool schemas are discovered at setup time so the Ollama MCP server can
  // pass them to Ollama without spawning duplicate MCP server processes.
  const mcpConfigPath = path.join(DATA_DIR, 'mcp-servers.json');
  if (fs.existsSync(mcpConfigPath)) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      const containerMcpDir = path.join(runBase, 'mcp-servers');
      fs.mkdirSync(containerMcpDir, { recursive: true });

      const containerServers: Record<string, ContainerServerEntry> = {};
      for (const [name, srv] of Object.entries(mcpConfig.servers || {})) {
        const entry = srv as Record<string, unknown>;
        const entryType = classifyServerEntry(entry);

        if (entryType === 'invalid-both') {
          logger.error(
            { server: name },
            'MCP server entry has both url and hostPath, skipping',
          );
          continue;
        }
        if (entryType === 'invalid-neither') {
          logger.error(
            { server: name },
            'MCP server entry has neither url nor hostPath, skipping',
          );
          continue;
        }

        // Discover tool schemas (shared across both types)
        let toolSchemas: Array<{
          name: string;
          description?: string;
          inputSchema: unknown;
        }> = [];

        if (entryType === 'remote') {
          // --- Remote MCP server ---
          const server = entry as {
            url: string;
            tools: ToolsDef;
            readOnly?: boolean;
            proxy?: boolean;
            policies?: { default?: string; groups?: Record<string, string> };
            headers?: Record<string, string>;
            skill?: string;
          };

          // Discover schemas over HTTP
          try {
            toolSchemas = await discoverRemoteToolSchemas(
              server.url,
              server.headers,
            );
            if (toolSchemas.length > 0) {
              logger.info(
                { server: name, tools: toolSchemas.map((t) => t.name) },
                'Discovered remote MCP tool schemas',
              );
            }
          } catch (err) {
            logger.warn(
              { server: name, err },
              'Failed to discover remote tool schemas',
            );
          }

          let resolvedTools = resolveTools(server.tools, server.readOnly);

          // Pipeline allow-list: filter external MCP tools too
          if (input?.allowedTools) {
            const allowed = new Set(input.allowedTools);
            resolvedTools = resolvedTools.filter((t: string) => allowed.has(t));
            if (resolvedTools.length === 0) continue; // skip server entirely
          }

          // Determine URL and headers
          let containerUrl: string;
          const containerHeaders: Record<string, string> = {
            ...(server.headers || {}),
          };

          if (server.proxy) {
            // Proxied: point to the MCP auth proxy, inject group header
            containerUrl = `http://${CONTAINER_HOST_GATEWAY}:${MCP_PROXY_PORT}/${name}`;
            containerHeaders['X-NanoClaw-Group'] = group.folder;

            // Per-group tool filtering: reduce tool list to what the policy allows
            if (server.policies) {
              const policyDir = path.join(DATA_DIR, 'mcp-policies');
              const policySet = loadPolicies(policyDir);
              const assignments: PolicyAssignments = {
                defaultTier: server.policies.default,
                groups: server.policies.groups || {},
              };
              const tier = resolveTier(
                policySet,
                name,
                group.folder,
                assignments,
              );
              if (tier) {
                resolvedTools = resolvedTools.filter(
                  (t) => evaluatePolicy(tier, t, {}).allowed,
                );
              } else {
                // No tier = no access (fail-closed)
                logger.warn(
                  { server: name, group: group.folder },
                  'No policy tier found for group, no tools will be available',
                );
                resolvedTools = [];
              }
            }
          } else {
            // Direct: rewrite URL for container access
            containerUrl = rewriteUrlForContainer(server.url);
          }

          // Filter discovered schemas to only allowed tools
          const filteredSchemas = toolSchemas.filter((s) =>
            resolvedTools.includes(s.name),
          );

          // Resolve skill content (inlined, not file path)
          const skillContent = resolveRemoteSkillContent(name, server.skill);

          containerServers[name] = {
            type: 'http',
            url: containerUrl,
            tools: resolvedTools,
            ...(Object.keys(containerHeaders).length > 0 && {
              headers: containerHeaders,
            }),
            ...(skillContent && { skillContent }),
            ...(filteredSchemas.length > 0 && {
              toolSchemas: filteredSchemas,
            }),
          };
        } else {
          // --- Stdio MCP server (existing behavior) ---
          const server = entry as {
            hostPath: string;
            command: string;
            args: string[];
            tools: string[];
            env?: string[];
            skill?: string;
          };
          const resolvedHostPath = path.resolve(server.hostPath);
          if (!fs.existsSync(resolvedHostPath)) {
            logger.warn(
              { server: name, path: resolvedHostPath },
              'MCP server path not found, skipping',
            );
            continue;
          }
          const containerPath = `/workspace/mcp-servers/${name}`;
          mounts.push({
            hostPath: resolvedHostPath,
            containerPath,
            readonly: true,
          });
          // Resolve whitelisted env vars from .env file
          const resolvedEnv: Record<string, string> = {};
          if (server.env) {
            const envValues = readEnvFile(server.env);
            for (const varName of server.env) {
              if (envValues[varName]) {
                resolvedEnv[varName] = envValues[varName];
              } else {
                logger.warn(
                  { server: name, envVar: varName },
                  'Whitelisted env var not found in .env, skipping',
                );
              }
            }
          }

          // Discover tool schemas by briefly spawning the server on the host
          try {
            toolSchemas = await discoverToolSchemas(
              server.command,
              server.args,
              resolvedHostPath,
              resolvedEnv,
            );
            if (toolSchemas.length > 0) {
              logger.info(
                { server: name, tools: toolSchemas.map((t) => t.name) },
                'Discovered MCP tool schemas',
              );
            }
          } catch (err) {
            logger.warn(
              { server: name, err },
              'Failed to discover tool schemas',
            );
          }

          // Filter schemas to configured tools, apply per-task allowedTools
          const filtered = filterServerTools(
            server.tools || [],
            toolSchemas,
            input?.allowedTools,
          );
          if (!filtered) continue; // all tools excluded by allowedTools

          containerServers[name] = {
            command: server.command,
            args: server.args.map((a) =>
              a
                .replace(/^\.\//, `${containerPath}/`)
                .replace(/^build\//, `${containerPath}/build/`),
            ),
            tools: filtered.tools,
            ...(Object.keys(resolvedEnv).length > 0 && { env: resolvedEnv }),
            ...(server.skill && { skill: server.skill }),
            ...(filtered.toolSchemas.length > 0 && {
              toolSchemas: filtered.toolSchemas,
            }),
          };
        }
      }

      if (Object.keys(containerServers).length > 0) {
        fs.writeFileSync(
          path.join(containerMcpDir, 'config.json'),
          JSON.stringify(containerServers, null, 2),
        );
        mounts.push({
          hostPath: containerMcpDir,
          containerPath: '/workspace/mcp-servers-config',
          readonly: true,
        });
        logger.info(
          { servers: Object.keys(containerServers) },
          'Mounting external MCP servers',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load MCP servers config');
    }
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  model?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Pass Ollama env vars (used by both delegated and direct mode)
  const ollamaEnvKeys = ['OLLAMA_HOST', 'OLLAMA_REMOTE_HOST'];
  const ollamaEnv = readEnvFile(ollamaEnvKeys);
  for (const key of ollamaEnvKeys) {
    if (ollamaEnv[key]) {
      args.push('-e', `${key}=${ollamaEnv[key]}`);
    }
  }

  if (isOllamaModel(model)) {
    // Ollama direct mode: no Anthropic credentials needed.
  } else {
    // Claude mode: route API traffic through the credential proxy
    args.push(
      '-e',
      `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
    );

    // Mirror the host's auth method with a placeholder value.
    const authMode = detectAuthMode();
    if (authMode === 'api-key') {
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    } else {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = await buildVolumeMounts(group, input.isMain, input);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, input.model);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        if (line.includes('[OLLAMA]')) {
          logger.info({ container: group.folder }, line);
        } else {
          logger.debug({ container: group.folder }, line);
        }
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout =
      input.timeoutMs || group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        const errorSummary =
          (stdout || stderr).split('\n').find((l) => l.trim()) ?? '';
        logger.error(
          {
            group: group.name,
            code,
            duration,
            errorSummary: errorSummary.slice(0, 200),
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${errorSummary.slice(0, 200) || stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    timezone?: string | null;
    status: string;
    next_run: string | null;
    model?: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see only registered groups
  // (needed for cross-channel messaging via send_cross_channel_message)
  const visibleGroups = isMain
    ? groups
    : groups.filter((g) => registeredJids.has(g.jid));

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
