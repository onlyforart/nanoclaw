/**
 * Resolve remote-MCP-server fields in a container config at spawn time:
 * rewrite localhost URLs to the container host gateway, discover tool
 * schemas, inline skill content. Stdio entries pass through unchanged.
 *
 * Pure: returns a new config; the input is not mutated. The discover
 * and skill-resolver callables are injectable so tests can avoid real
 * HTTP and real filesystem reads.
 */
import type { ContainerConfig, McpServerEntry, RemoteMcpServerConfig } from './container-config.js';
import { discoverRemoteToolSchemas, resolveRemoteSkillContent, rewriteUrlForContainer } from './remote-mcp.js';

export interface ResolveMcpServersOptions {
  discover?: typeof discoverRemoteToolSchemas;
  resolveSkill?: typeof resolveRemoteSkillContent;
}

function isRemote(entry: McpServerEntry): entry is RemoteMcpServerConfig {
  return 'url' in entry;
}

export async function resolveMcpServers(
  config: ContainerConfig,
  opts: ResolveMcpServersOptions = {},
): Promise<ContainerConfig> {
  const discover = opts.discover ?? discoverRemoteToolSchemas;
  const resolveSkill = opts.resolveSkill ?? resolveRemoteSkillContent;

  const resolvedEntries = await Promise.all(
    Object.entries(config.mcpServers).map(async ([name, entry]) => {
      if (!isRemote(entry)) return [name, entry] as const;
      const rewrittenUrl = rewriteUrlForContainer(entry.url);
      const [toolSchemas, skillContent] = await Promise.all([
        discover(rewrittenUrl, entry.headers),
        Promise.resolve(entry.skill ? resolveSkill(name, entry.skill) : undefined),
      ]);
      const resolved: RemoteMcpServerConfig = {
        ...entry,
        url: rewrittenUrl,
        toolSchemas,
      };
      if (skillContent !== undefined) {
        resolved.instructions = skillContent;
      }
      return [name, resolved] as const;
    }),
  );

  return {
    ...config,
    mcpServers: Object.fromEntries(resolvedEntries),
  };
}
