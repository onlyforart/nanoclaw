/**
 * MCP Policy Loader and Evaluator
 *
 * Loads YAML access policies from data/mcp-policies/ and evaluates
 * tool calls against them for the MCP authorization proxy.
 *
 * See docs/REMOTE-MCP-SERVERS.md for the policy specification.
 */
import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PolicyRule {
  tools: {
    allow?: string[];
    deny?: string[];
  };
  arguments?: Record<
    string,
    {
      allow?: string[];
      deny?: string[];
    }
  >;
}

export interface PolicySet {
  /** server name → tier name → parsed policy */
  policies: Map<string, Map<string, PolicyRule>>;
}

export interface PolicyAssignments {
  defaultTier?: string;
  groups: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a value against a pattern.
 * - "*" matches anything.
 * - "prefix*" matches if value starts with prefix.
 * - Otherwise exact match.
 * No regex support (avoids injection risks).
 */
function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => matchPattern(p, value));
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a tool call against a policy.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 *
 * Evaluation logic:
 * 1. Tool check: deny list takes precedence over allow list.
 * 2. Argument check: for each constrained argument, deny takes precedence.
 * 3. Both checks must pass. Default-deny if no allow list defined.
 */
export function evaluatePolicy(
  policy: PolicyRule,
  toolName: string,
  args: Record<string, unknown>,
): { allowed: boolean; reason?: string } {
  // --- Tool check ---
  if (policy.tools.deny && matchesAny(policy.tools.deny, toolName)) {
    return { allowed: false, reason: `Tool '${toolName}' is denied by policy` };
  }
  if (policy.tools.allow) {
    if (!matchesAny(policy.tools.allow, toolName)) {
      return {
        allowed: false,
        reason: `Tool '${toolName}' is not in the allow list`,
      };
    }
  } else {
    // No allow list = default-deny
    return { allowed: false, reason: 'No tools.allow defined (default-deny)' };
  }

  // --- Argument check ---
  if (policy.arguments) {
    for (const [argName, constraint] of Object.entries(policy.arguments)) {
      const value = args[argName];
      if (value === undefined || value === null) continue; // not present → skip

      const strValue = String(value);

      // Deny takes precedence
      if (constraint.deny && matchesAny(constraint.deny, strValue)) {
        return {
          allowed: false,
          reason: `Argument '${argName}' value '${strValue}' is denied`,
        };
      }
      if (constraint.allow && !matchesAny(constraint.allow, strValue)) {
        return {
          allowed: false,
          reason: `Argument '${argName}' value '${strValue}' is not in the allow list`,
        };
      }
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Policy loading
// ---------------------------------------------------------------------------

/**
 * Load all policies from a directory.
 * Directory structure: {policyDir}/{serverName}/{tierName}.yaml
 */
export function loadPolicies(policyDir: string): PolicySet {
  const policies = new Map<string, Map<string, PolicyRule>>();

  if (!fs.existsSync(policyDir)) {
    return { policies };
  }

  for (const serverName of fs.readdirSync(policyDir)) {
    const serverDir = path.join(policyDir, serverName);
    if (!fs.statSync(serverDir).isDirectory()) continue;

    const tierMap = new Map<string, PolicyRule>();
    for (const file of fs.readdirSync(serverDir)) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      const tierName = file.replace(/\.ya?ml$/, '');
      const filePath = path.join(serverDir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseYaml(content);
        if (!parsed || typeof parsed !== 'object') {
          logger.warn({ file: filePath }, 'Malformed policy file, skipping');
          continue;
        }

        const rule: PolicyRule = {
          tools: {
            allow: parsed.tools?.allow,
            deny: parsed.tools?.deny,
          },
          ...(parsed.arguments && { arguments: parsed.arguments }),
        };

        tierMap.set(tierName, rule);
        logger.debug(
          { server: serverName, tier: tierName },
          'Loaded MCP policy',
        );
      } catch (err) {
        logger.warn(
          {
            file: filePath,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to parse policy file',
        );
      }
    }

    if (tierMap.size > 0) {
      policies.set(serverName, tierMap);
    }
  }

  return { policies };
}

// ---------------------------------------------------------------------------
// Tier resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the policy tier for a given server + group.
 * Returns the parsed PolicyRule or null if no tier matches.
 */
export function resolveTier(
  policySet: PolicySet,
  serverName: string,
  groupFolder: string,
  assignments: PolicyAssignments,
): PolicyRule | null {
  const serverPolicies = policySet.policies.get(serverName);
  if (!serverPolicies) return null;

  // Check explicit group assignment first
  const tierName = assignments.groups[groupFolder] || assignments.defaultTier;
  if (!tierName) return null;

  return serverPolicies.get(tierName) || null;
}
