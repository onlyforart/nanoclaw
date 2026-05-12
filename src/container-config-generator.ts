/**
 * Container-config generator. Ports v1's spawn-time MCP server provisioning
 * (`dist/container-runner.js:296-454`) into v2 as a host-side init step that
 * writes `groups/<folder>/container.json`. v2's container-runner stays
 * unchanged — it reads container.json as designed; this module is what gets
 * the right values into that file.
 *
 * Inputs:
 *   - `data/mcp-servers.json` (`{ servers: { name: V1ServerEntry } }`)
 *   - `data/mcp-exclusions.json` (`{ "*"|folder: serverName[] }`) — optional.
 *
 * Per-group output:
 *   - `groups/<folder>/container.json` — generator-owned fields (mcpServers
 *     + the additionalMounts entries this generator created) replaced;
 *     everything else (packages, imageTag, env, blockedHosts, operator
 *     additionalMounts, …) preserved.
 *   - `groups/<folder>/.container-generator.json` — sidecar listing the
 *     names this generator currently owns. Reading the sidecar on the next
 *     run lets us cleanly remove entries for servers that have since been
 *     removed from `data/mcp-servers.json`, without clobbering operator
 *     entries that happen to share a key.
 *
 * Side effect: every `hostPath` from `data/mcp-servers.json` is added to
 * `~/.config/nanoclaw/mount-allowlist.json` so v2's `validateAdditionalMounts`
 * accepts the generated mounts at spawn time. The allowlist cache is
 * invalidated after each write.
 *
 * Folders named `pipeline-*` are skipped — the pipeline plugin owns those
 * synthetic groups via `reconcileContainerPipelineTasks` and writes its
 * own container-config there.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type {
  AdditionalMountConfig,
  McpServerEntry,
  McpServerConfig,
  RemoteMcpServerConfig,
} from './container-config.js';
import { log } from './log.js';
import { addAllowlistEntry } from './modules/mount-security/index.js';
import type { ToolsDef } from './remote-mcp.js';

const SIDECAR_FILE = '.container-generator.json';

export interface V1ServerEntry {
  // stdio fields
  hostPath?: string;
  command?: string;
  args?: string[];
  env?: string[];
  hostEnv?: Record<string, string>;
  skill?: string;
  timeout?: number;
  // remote fields
  url?: string;
  tools?: unknown;
  headers?: Record<string, string>;
  readOnly?: boolean;
  proxy?: boolean;
  policies?: { default?: string; groups?: Record<string, string> };
}

export interface McpServersFile {
  servers: Record<string, V1ServerEntry>;
}

export interface McpExclusionsFile {
  [folderOrWildcard: string]: string[];
}

export interface GeneratorInputs {
  mcpServers: McpServersFile | null;
  exclusions: McpExclusionsFile;
  folder: string;
}

export interface GeneratorError {
  serverName: string;
  reason: string;
}

export interface GeneratedSection {
  /** Generator-owned subset of `container.json#mcpServers`. */
  mcpServers: Record<string, McpServerEntry>;
  /** Generator-owned subset of `container.json#additionalMounts`. */
  additionalMounts: AdditionalMountConfig[];
  /** Names this run wants to own in `mcpServers` (for sidecar bookkeeping). */
  managedServerNames: string[];
  /** containerPaths this run wants to own in `additionalMounts`. */
  managedMountContainerPaths: string[];
  errors: GeneratorError[];
}

interface Sidecar {
  mcpServers: string[];
  additionalMountContainerPaths: string[];
}

export interface RegenerateSummary {
  groupsProcessed: number;
  groupsSkipped: number;
  serversInstalledTotal: number;
  mountsCreatedTotal: number;
  mountAllowlistUpdates: string[];
  changedGroups: string[];
  errors: Array<{ folder: string; serverName: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Pure generation
// ---------------------------------------------------------------------------

function resolveExcluded(exclusions: McpExclusionsFile, folder: string): Set<string> {
  const set = new Set<string>();
  for (const name of exclusions['*'] ?? []) set.add(name);
  for (const name of exclusions[folder] ?? []) set.add(name);
  return set;
}

function classifyEntry(entry: V1ServerEntry): 'stdio' | 'remote' | 'invalid-both' | 'invalid-neither' {
  const hasHost = typeof entry.hostPath === 'string' && entry.hostPath.length > 0;
  const hasUrl = typeof entry.url === 'string' && entry.url.length > 0;
  if (hasHost && hasUrl) return 'invalid-both';
  if (!hasHost && !hasUrl) return 'invalid-neither';
  return hasHost ? 'stdio' : 'remote';
}

/**
 * v1 args path-rewrite — verbatim from `dist/container-runner.js:439-441`.
 * `containerPath` is where the stdio MCP server's hostPath will mount inside
 * the container (`/workspace/extra/<name>` post-validateAdditionalMounts).
 */
function rewriteArgs(args: string[] | undefined, containerPath: string): string[] {
  if (!args) return [];
  return args.map((a) => a.replace(/^\.\//, `${containerPath}/`).replace(/^build\//, `${containerPath}/build/`));
}

function resolveStdioEnv(entry: V1ServerEntry): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (Array.isArray(entry.env)) {
    for (const key of entry.env) {
      const v = process.env[key];
      if (typeof v === 'string') out[key] = v;
    }
  }
  if (entry.hostEnv && typeof entry.hostEnv === 'object') {
    for (const [k, v] of Object.entries(entry.hostEnv)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readSkillContent(serverHostPath: string, skill: string): string | null {
  const p = path.isAbsolute(skill) ? skill : path.join(serverHostPath, skill);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function generateGroupContainerConfig(inputs: GeneratorInputs): GeneratedSection {
  const out: GeneratedSection = {
    mcpServers: {},
    additionalMounts: [],
    managedServerNames: [],
    managedMountContainerPaths: [],
    errors: [],
  };

  if (!inputs.mcpServers || !inputs.mcpServers.servers) return out;
  const excluded = resolveExcluded(inputs.exclusions, inputs.folder);

  for (const [name, entry] of Object.entries(inputs.mcpServers.servers)) {
    if (excluded.has(name)) continue;
    const cls = classifyEntry(entry);

    if (cls === 'invalid-both') {
      out.errors.push({ serverName: name, reason: 'entry has both url and hostPath' });
      continue;
    }
    if (cls === 'invalid-neither') {
      out.errors.push({ serverName: name, reason: 'entry has neither url nor hostPath' });
      continue;
    }

    if (cls === 'stdio') {
      const resolvedHostPath = path.resolve(entry.hostPath!);
      if (!fs.existsSync(resolvedHostPath)) {
        out.errors.push({ serverName: name, reason: `hostPath does not exist: ${resolvedHostPath}` });
        continue;
      }
      // v2 mount-security rewrites `containerPath` to `/workspace/extra/<basename>`.
      // The args path-rewrite uses that effective path so the agent finds the script.
      const effectiveContainerPath = `/workspace/extra/${name}`;

      const built: McpServerConfig = {
        command: entry.command ?? 'node',
        args: rewriteArgs(entry.args, effectiveContainerPath),
      };
      const env = resolveStdioEnv(entry);
      if (env) built.env = env;

      if (entry.skill) {
        const content = readSkillContent(resolvedHostPath, entry.skill);
        if (content === null) {
          out.errors.push({
            serverName: name,
            reason: `skill file not found: ${entry.skill} (under ${resolvedHostPath})`,
          });
        } else {
          built.instructions = content;
        }
      }

      out.mcpServers[name] = built;
      out.additionalMounts.push({ hostPath: resolvedHostPath, containerPath: name, readonly: true });
      out.managedServerNames.push(name);
      out.managedMountContainerPaths.push(name);
      continue;
    }

    // remote
    const built: RemoteMcpServerConfig = {
      url: entry.url!,
      tools: (entry.tools ?? []) as ToolsDef,
    };
    if (entry.readOnly !== undefined) built.readOnly = entry.readOnly;
    if (entry.proxy !== undefined) built.proxy = entry.proxy;
    if (entry.policies) built.policies = entry.policies;
    if (entry.headers) built.headers = entry.headers;
    if (entry.skill) built.skill = entry.skill;

    out.mcpServers[name] = built;
    out.managedServerNames.push(name);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Merge into per-group container.json + sidecar bookkeeping
// ---------------------------------------------------------------------------

function configPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'container.json');
}

function sidecarPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, SIDECAR_FILE);
}

function readSidecar(folder: string): Sidecar {
  const p = sidecarPath(folder);
  if (!fs.existsSync(p)) {
    return { mcpServers: [], additionalMountContainerPaths: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<Sidecar>;
    return {
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      additionalMountContainerPaths: Array.isArray(parsed.additionalMountContainerPaths)
        ? parsed.additionalMountContainerPaths
        : [],
    };
  } catch (err) {
    log.warn('container-generator sidecar failed to parse; treating as empty', {
      path: p,
      err: err instanceof Error ? err.message : String(err),
    });
    return { mcpServers: [], additionalMountContainerPaths: [] };
  }
}

function writeSidecar(folder: string, sidecar: Sidecar): void {
  fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  fs.writeFileSync(sidecarPath(folder), JSON.stringify(sidecar, null, 2) + '\n');
}

function readContainerJsonRaw(folder: string): Record<string, unknown> {
  const p = configPath(folder);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    log.warn('container.json failed to parse during generator merge; treating as empty', {
      path: p,
      err: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

export function mergeIntoContainerJson(
  folder: string,
  generated: GeneratedSection,
): { changed: boolean; written: boolean } {
  const raw = readContainerJsonRaw(folder);
  const previousJson = JSON.stringify(raw);
  const prevSidecar = readSidecar(folder);

  const existingMcp: Record<string, unknown> = (raw.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingMounts: AdditionalMountConfig[] = Array.isArray(raw.additionalMounts)
    ? (raw.additionalMounts as AdditionalMountConfig[])
    : [];

  // Strip previously-managed entries before merging in the fresh set.
  const prunedMcp: Record<string, unknown> = { ...existingMcp };
  for (const name of prevSidecar.mcpServers) delete prunedMcp[name];

  const managedMountPaths = new Set(prevSidecar.additionalMountContainerPaths);
  const prunedMounts = existingMounts.filter((m) => !managedMountPaths.has(m.containerPath));

  // Merge in new generator output.
  const finalMcp: Record<string, unknown> = { ...prunedMcp, ...generated.mcpServers };
  const finalMounts: AdditionalMountConfig[] = [...prunedMounts, ...generated.additionalMounts];

  const next: Record<string, unknown> = { ...raw, mcpServers: finalMcp, additionalMounts: finalMounts };
  const nextJson = JSON.stringify(next, null, 2) + '\n';

  const nextSidecar: Sidecar = {
    mcpServers: [...generated.managedServerNames].sort(),
    additionalMountContainerPaths: [...generated.managedMountContainerPaths].sort(),
  };
  const sidecarChanged = JSON.stringify(prevSidecar) !== JSON.stringify(nextSidecar);

  const containerChanged = previousJson !== JSON.stringify(next);
  if (!containerChanged && !sidecarChanged) {
    return { changed: false, written: false };
  }

  fs.mkdirSync(path.join(GROUPS_DIR, folder), { recursive: true });
  if (containerChanged) {
    fs.writeFileSync(configPath(folder), nextJson);
  }
  writeSidecar(folder, nextSidecar);
  return { changed: true, written: containerChanged };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function readInputs(): { mcpServers: McpServersFile | null; exclusions: McpExclusionsFile } {
  const serversPath = path.join(DATA_DIR, 'mcp-servers.json');
  const exclusionsPath = path.join(DATA_DIR, 'mcp-exclusions.json');

  let mcpServers: McpServersFile | null = null;
  if (fs.existsSync(serversPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(serversPath, 'utf8')) as Partial<McpServersFile>;
      if (parsed && typeof parsed === 'object' && parsed.servers && typeof parsed.servers === 'object') {
        mcpServers = { servers: parsed.servers as Record<string, V1ServerEntry> };
      } else {
        mcpServers = { servers: {} };
      }
    } catch (err) {
      log.warn('data/mcp-servers.json failed to parse; treating as empty', {
        path: serversPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let exclusions: McpExclusionsFile = {};
  if (fs.existsSync(exclusionsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(exclusionsPath, 'utf8')) as McpExclusionsFile;
      if (parsed && typeof parsed === 'object') exclusions = parsed;
    } catch (err) {
      log.warn('data/mcp-exclusions.json failed to parse; treating as empty', {
        path: exclusionsPath,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { mcpServers, exclusions };
}

/**
 * Refresh `mount-allowlist.json` so every stdio `hostPath` referenced by
 * `data/mcp-servers.json` is registered. Must run BEFORE any container
 * spawn so the cached allowlist sees the new entries.
 */
function refreshMountAllowlist(mcpServers: McpServersFile | null): string[] {
  if (!mcpServers) return [];
  const added: string[] = [];
  for (const [name, entry] of Object.entries(mcpServers.servers)) {
    if (!entry.hostPath) continue;
    const resolved = path.resolve(entry.hostPath);
    const result = addAllowlistEntry({
      path: resolved,
      allowReadWrite: false,
      description: `nanoclaw mcp server: ${name}`,
    });
    if (result.added) added.push(resolved);
  }
  return added;
}

export function regenerateAllAgentGroups(folders: string[]): RegenerateSummary {
  const inputs = readInputs();
  const mountAllowlistUpdates = refreshMountAllowlist(inputs.mcpServers);

  const summary: RegenerateSummary = {
    groupsProcessed: 0,
    groupsSkipped: 0,
    serversInstalledTotal: 0,
    mountsCreatedTotal: 0,
    mountAllowlistUpdates,
    changedGroups: [],
    errors: [],
  };

  for (const folder of folders) {
    if (folder.startsWith('pipeline-')) {
      summary.groupsSkipped++;
      continue;
    }
    const gen = generateGroupContainerConfig({
      mcpServers: inputs.mcpServers,
      exclusions: inputs.exclusions,
      folder,
    });
    const r = mergeIntoContainerJson(folder, gen);
    summary.groupsProcessed++;
    summary.serversInstalledTotal += Object.keys(gen.mcpServers).length;
    summary.mountsCreatedTotal += gen.additionalMounts.length;
    if (r.changed) summary.changedGroups.push(folder);
    for (const e of gen.errors) summary.errors.push({ folder, ...e });
  }

  return summary;
}

/**
 * Convenience wrapper for `group-init.ts` — regenerate a single group's
 * container.json after the group's folder + initial container.json exist.
 */
export function regenerateForGroup(folder: string): GeneratedSection {
  if (folder.startsWith('pipeline-')) {
    return {
      mcpServers: {},
      additionalMounts: [],
      managedServerNames: [],
      managedMountContainerPaths: [],
      errors: [],
    };
  }
  const inputs = readInputs();
  refreshMountAllowlist(inputs.mcpServers);
  const gen = generateGroupContainerConfig({
    mcpServers: inputs.mcpServers,
    exclusions: inputs.exclusions,
    folder,
  });
  mergeIntoContainerJson(folder, gen);
  return gen;
}
