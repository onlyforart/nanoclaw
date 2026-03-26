/**
 * Remote MCP server support — types and utility functions.
 *
 * Extracted from the container-runner MCP server loop to enable isolated testing.
 * See docs/REMOTE-MCP-SERVERS.md for the full specification.
 */
import fs from 'fs';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { CONTAINER_HOST_GATEWAY } from './container-runtime.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Tools field: flat array (backward compat) or access-level object */
export type ToolsDef = string[] | Record<string, string[]>;

/** Stdio MCP server entry (existing pattern) */
export interface StdioMcpServerEntry {
  hostPath: string;
  command: string;
  args: string[];
  tools: ToolsDef;
  env?: string[];
  awsAuth?: boolean;
  skill?: string;
}

/** Remote MCP server entry (new pattern) */
export interface RemoteMcpServerEntry {
  url: string;
  tools: ToolsDef;
  readOnly?: boolean;
  proxy?: boolean;
  policies?: { default?: string; groups?: Record<string, string> };
  headers?: Record<string, string>;
  skill?: string;
}

export type McpServerEntry = StdioMcpServerEntry | RemoteMcpServerEntry;

/** Container-side config entry for a remote MCP server */
export interface RemoteContainerServerEntry {
  type: 'http';
  url: string;
  tools: string[];
  headers?: Record<string, string>;
  skillContent?: string;
  toolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}

/** Container-side config entry for a stdio MCP server (existing) */
export interface StdioContainerServerEntry {
  command: string;
  args: string[];
  tools: string[];
  env?: Record<string, string>;
  skill?: string;
  toolSchemas?: Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
}

export type ContainerServerEntry =
  | StdioContainerServerEntry
  | RemoteContainerServerEntry;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRemoteEntry(
  entry: Record<string, unknown>,
): boolean {
  return 'url' in entry && !('hostPath' in entry);
}

/**
 * Classify a raw server entry from mcp-servers.json.
 * Returns 'remote', 'stdio', 'invalid-both', or 'invalid-neither'.
 */
export function classifyServerEntry(
  entry: Record<string, unknown>,
): 'remote' | 'stdio' | 'invalid-both' | 'invalid-neither' {
  const hasUrl = 'url' in entry;
  const hasHostPath = 'hostPath' in entry;
  if (hasUrl && hasHostPath) return 'invalid-both';
  if (hasUrl) return 'remote';
  if (hasHostPath) return 'stdio';
  return 'invalid-neither';
}

// ---------------------------------------------------------------------------
// Tool resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a ToolsDef to a flat array of tool names, optionally filtered by readOnly.
 *
 * - Flat array: returned as-is (readOnly flag ignored for backward compat).
 * - Access-level object + readOnly=true: only 'read' level tools.
 * - Access-level object + readOnly=false/undefined: all levels flattened.
 */
export function resolveTools(
  tools: ToolsDef,
  readOnly?: boolean,
): string[] {
  if (Array.isArray(tools)) return tools;
  if (readOnly) return tools['read'] || [];
  return Object.values(tools).flat();
}

// ---------------------------------------------------------------------------
// URL rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a localhost URL so it's reachable from inside a container.
 * 127.0.0.1 and localhost → host.docker.internal (the container host gateway).
 */
export function rewriteUrlForContainer(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      parsed.hostname = CONTAINER_HOST_GATEWAY;
    }
    return parsed.toString().replace(/\/$/, ''); // strip trailing slash added by URL
  } catch {
    return url; // pass through malformed URLs
  }
}

// ---------------------------------------------------------------------------
// Skill content resolution
// ---------------------------------------------------------------------------

/**
 * Read a skill file, strip frontmatter, inline referenced .md files.
 * Returns the assembled content or undefined if the file is empty.
 */
export function assembleSkillContent(skillPath: string): string | undefined {
  let content = fs.readFileSync(skillPath, 'utf-8');
  content = content.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

  const skillDir = path.dirname(skillPath);
  const refPattern = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  const inlined: string[] = [];
  let match;
  while ((match = refPattern.exec(content)) !== null) {
    const [, title, relPath] = match;
    const refFile = path.resolve(skillDir, relPath);
    if (fs.existsSync(refFile)) {
      try {
        const refContent = fs.readFileSync(refFile, 'utf-8').trim();
        if (refContent) inlined.push(`### ${title}\n\n${refContent}`);
      } catch {
        /* skip */
      }
    }
  }
  if (inlined.length > 0) content += '\n\n' + inlined.join('\n\n');
  return content || undefined;
}

/**
 * Resolve skill content for a remote MCP server.
 * Checks convention paths (container/skills/{serverName}/SKILL.md),
 * then explicit paths, then bare filenames.
 *
 * Returns the fully assembled markdown content or undefined.
 */
export function resolveRemoteSkillContent(
  serverName: string,
  skill?: string,
): string | undefined {
  // Priority 1: Local skill directory (convention)
  const conventionPath = path.join(
    'container',
    'skills',
    serverName,
    'SKILL.md',
  );
  if (fs.existsSync(conventionPath)) {
    return assembleSkillContent(conventionPath);
  }

  // Priority 2: Local file (explicit path)
  if (skill && !skill.startsWith('http') && skill.includes('/')) {
    if (fs.existsSync(skill)) {
      return assembleSkillContent(skill);
    }
  }

  // Priority 3: Local file (bare filename in container/skills/)
  if (skill && !skill.startsWith('http') && !skill.includes('/')) {
    const barePath = path.join('container', 'skills', skill);
    if (fs.existsSync(barePath)) {
      return assembleSkillContent(barePath);
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Remote tool schema discovery
// ---------------------------------------------------------------------------

/**
 * Connect to a remote MCP server over HTTP and discover its tool schemas.
 * Returns an empty array on any failure (logged as warning, not fatal).
 */
export async function discoverRemoteToolSchemas(
  url: string,
  headers?: Record<string, string>,
): Promise<Array<{ name: string; description?: string; inputSchema: unknown }>> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5_000);

  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: headers || {},
        signal: abortController.signal,
      },
    });

    const client = new Client({
      name: 'nanoclaw-schema-discovery',
      version: '1.0.0',
    });

    await client.connect(transport);

    const result = await client.listTools();
    const tools = (result.tools || []).map((t) => ({
      name: t.name,
      ...(t.description && { description: t.description }),
      inputSchema: t.inputSchema,
    }));

    await client.close();
    return tools;
  } catch (err) {
    logger.warn(
      { url, err: err instanceof Error ? err.message : String(err) },
      'Failed to discover remote MCP tool schemas',
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
