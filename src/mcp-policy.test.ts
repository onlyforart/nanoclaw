/**
 * Tests for src/mcp-policy.ts.
 *
 * Encodes the role spec — YAML-driven access policies for the MCP
 * authorization proxy — as documented in docs/REMOTE-MCP-SERVERS.md.
 *
 * Three exported surfaces:
 *   - `evaluatePolicy(rule, toolName, args)` — pure decision: deny
 *     beats allow at both tool and argument level; missing allow
 *     list is default-deny; missing arg values skip the constraint.
 *   - `loadPolicies(dir)` — directory walk: `{dir}/{server}/{tier}.yaml`,
 *     skips malformed files, only adds servers with ≥1 valid tier.
 *   - `resolveTier(policySet, server, groupFolder, assignments)` —
 *     group-specific tier name beats default tier; missing server
 *     or unknown tier name returns null.
 *
 * Pattern matching (private but covered through evaluatePolicy):
 *   "*" matches anything; "prefix*" is a prefix match; otherwise
 *   exact. No regex.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { evaluatePolicy, loadPolicies, resolveTier, type PolicyRule, type PolicySet } from './mcp-policy.js';

// ============================================================================
// evaluatePolicy — tool-level checks
// ============================================================================

describe('evaluatePolicy — tool-level', () => {
  it('allows a tool that is in the allow list', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch'] } };
    expect(evaluatePolicy(rule, 'fetch', {})).toEqual({ allowed: true });
  });

  it('denies a tool not in the allow list (with reason)', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch'] } };
    const result = evaluatePolicy(rule, 'write', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('write');
    expect(result.reason).toContain('not in the allow list');
  });

  it('denies a tool when no allow list is defined (default-deny)', () => {
    const rule: PolicyRule = { tools: {} };
    const result = evaluatePolicy(rule, 'fetch', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/default-deny/i);
  });

  it('deny list takes precedence over allow list (for the same tool)', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch'], deny: ['fetch'] } };
    const result = evaluatePolicy(rule, 'fetch', {});
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  it('"*" in allow matches every tool', () => {
    const rule: PolicyRule = { tools: { allow: ['*'] } };
    expect(evaluatePolicy(rule, 'fetch', {})).toEqual({ allowed: true });
    expect(evaluatePolicy(rule, 'write', {})).toEqual({ allowed: true });
  });

  it('"*" in deny denies everything (overrides allow:["*"])', () => {
    const rule: PolicyRule = { tools: { allow: ['*'], deny: ['*'] } };
    expect(evaluatePolicy(rule, 'anything', {}).allowed).toBe(false);
  });

  it('prefix wildcard "fetch*" matches tools starting with the prefix', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch*'] } };
    expect(evaluatePolicy(rule, 'fetch_url', {}).allowed).toBe(true);
    expect(evaluatePolicy(rule, 'fetcher', {}).allowed).toBe(true);
    expect(evaluatePolicy(rule, 'do_fetch', {}).allowed).toBe(false);
  });

  it('a non-wildcard pattern requires exact match (no implicit prefix)', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch'] } };
    expect(evaluatePolicy(rule, 'fetcher', {}).allowed).toBe(false);
    expect(evaluatePolicy(rule, 'fet', {}).allowed).toBe(false);
  });

  it('does not allow regex special chars to be treated as regex (no injection)', () => {
    const rule: PolicyRule = { tools: { allow: ['fetch.*'] } };
    expect(evaluatePolicy(rule, 'fetchXanything', {}).allowed).toBe(false);
    // Only the literal string "fetch.*" matches:
    expect(evaluatePolicy(rule, 'fetch.*', {}).allowed).toBe(true);
  });
});

// ============================================================================
// evaluatePolicy — argument-level checks
// ============================================================================

describe('evaluatePolicy — argument-level', () => {
  const baseRule: PolicyRule = { tools: { allow: ['fetch'] } };

  it('skips constrained args when the value is undefined or null', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: { url: { allow: ['https://*'] } },
    };
    expect(evaluatePolicy(rule, 'fetch', {}).allowed).toBe(true);
    expect(evaluatePolicy(rule, 'fetch', { url: null }).allowed).toBe(true);
  });

  it('allows when arg value matches the allow list', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: { url: { allow: ['https://*'] } },
    };
    expect(evaluatePolicy(rule, 'fetch', { url: 'https://api.example.com' }).allowed).toBe(true);
  });

  it('denies when arg value is missing from the allow list', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: { url: { allow: ['https://*'] } },
    };
    const result = evaluatePolicy(rule, 'fetch', { url: 'http://insecure.example.com' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('url');
    expect(result.reason).toContain('http://insecure.example.com');
  });

  it('argument deny list takes precedence over allow list', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: {
        url: { allow: ['https://*'], deny: ['https://internal.*'] },
      },
    };
    const result = evaluatePolicy(rule, 'fetch', { url: 'https://internal.bad' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('denied');
  });

  it('coerces non-string arg values to string before pattern match', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: { count: { allow: ['42'] } },
    };
    expect(evaluatePolicy(rule, 'fetch', { count: 42 }).allowed).toBe(true);
    expect(evaluatePolicy(rule, 'fetch', { count: 99 }).allowed).toBe(false);
  });

  it('checks every argument constraint independently (any failure denies)', () => {
    const rule: PolicyRule = {
      ...baseRule,
      arguments: {
        url: { allow: ['https://*'] },
        method: { allow: ['GET', 'POST'] },
      },
    };
    expect(evaluatePolicy(rule, 'fetch', { url: 'https://x', method: 'GET' }).allowed).toBe(true);
    expect(evaluatePolicy(rule, 'fetch', { url: 'https://x', method: 'DELETE' }).allowed).toBe(false);
    expect(evaluatePolicy(rule, 'fetch', { url: 'http://x', method: 'GET' }).allowed).toBe(false);
  });

  it('allows when no argument constraints are defined', () => {
    expect(evaluatePolicy(baseRule, 'fetch', { anything: 'goes' }).allowed).toBe(true);
  });
});

// ============================================================================
// loadPolicies — directory walk
// ============================================================================

let tmpDir = '';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-policy-'));
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function writePolicyFile(server: string, tier: string, content: string, ext: 'yaml' | 'yml' = 'yaml'): void {
  const dir = path.join(tmpDir, server);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${tier}.${ext}`), content);
}

describe('loadPolicies', () => {
  it('returns an empty PolicySet when the directory does not exist', () => {
    const set = loadPolicies(path.join(tmpDir, 'does-not-exist'));
    expect(set.policies.size).toBe(0);
  });

  it('returns an empty PolicySet for an empty directory', () => {
    const set = loadPolicies(tmpDir);
    expect(set.policies.size).toBe(0);
  });

  it('loads {server}/{tier}.yaml files into nested maps', () => {
    writePolicyFile('jira', 'readonly', 'tools:\n  allow:\n    - search\n');
    writePolicyFile('jira', 'admin', 'tools:\n  allow:\n    - "*"\n');

    const set = loadPolicies(tmpDir);
    expect(set.policies.size).toBe(1);
    const jira = set.policies.get('jira');
    expect(jira?.size).toBe(2);
    expect(jira?.get('readonly')?.tools.allow).toEqual(['search']);
    expect(jira?.get('admin')?.tools.allow).toEqual(['*']);
  });

  it('accepts both .yaml and .yml extensions', () => {
    writePolicyFile('srv', 'tierA', 'tools:\n  allow: [a]\n', 'yaml');
    writePolicyFile('srv', 'tierB', 'tools:\n  allow: [b]\n', 'yml');

    const set = loadPolicies(tmpDir);
    expect(set.policies.get('srv')?.size).toBe(2);
  });

  it('ignores non-YAML files within a server directory', () => {
    writePolicyFile('srv', 'tier', 'tools:\n  allow: [a]\n');
    fs.writeFileSync(path.join(tmpDir, 'srv', 'README.md'), '# notes');
    fs.writeFileSync(path.join(tmpDir, 'srv', 'extras.txt'), 'irrelevant');

    const set = loadPolicies(tmpDir);
    expect(set.policies.get('srv')?.size).toBe(1);
  });

  it('skips directories where every YAML file is malformed (no entry created)', () => {
    writePolicyFile('broken', 'bad', 'this is not: : valid\nyaml: : :');
    writePolicyFile('good', 'tier', 'tools:\n  allow: [a]\n');

    const set = loadPolicies(tmpDir);
    expect(set.policies.has('broken')).toBe(false);
    expect(set.policies.has('good')).toBe(true);
  });

  it("skips a single malformed file but keeps the rest of the server's tiers", () => {
    writePolicyFile('mixed', 'good', 'tools:\n  allow: [a]\n');
    fs.writeFileSync(path.join(tmpDir, 'mixed', 'bad.yaml'), '[ : : :');

    const set = loadPolicies(tmpDir);
    const mixed = set.policies.get('mixed');
    expect(mixed?.size).toBe(1);
    expect(mixed?.get('good')?.tools.allow).toEqual(['a']);
  });

  it('preserves tools.allow / tools.deny / arguments structure from YAML', () => {
    const yaml = `
tools:
  allow: [fetch]
  deny: [fetch_internal]
arguments:
  url:
    allow: ['https://*']
    deny: ['https://secret.*']
`;
    writePolicyFile('jira', 'tier', yaml);
    const rule = loadPolicies(tmpDir).policies.get('jira')?.get('tier');
    expect(rule?.tools.allow).toEqual(['fetch']);
    expect(rule?.tools.deny).toEqual(['fetch_internal']);
    expect(rule?.arguments?.url?.allow).toEqual(['https://*']);
    expect(rule?.arguments?.url?.deny).toEqual(['https://secret.*']);
  });

  it('ignores files at the top level of policyDir (only walks server dirs)', () => {
    fs.writeFileSync(path.join(tmpDir, 'top-level.yaml'), 'tools:\n  allow: [x]\n');
    writePolicyFile('srv', 'tier', 'tools:\n  allow: [a]\n');

    // The top-level YAML is not under a server dir, so it should not appear
    // in the PolicySet. Implementation detail: top-level non-dir entries
    // throw in fs.statSync(path).isDirectory() === false; they're filtered.
    const set = loadPolicies(tmpDir);
    expect(set.policies.has('top-level.yaml')).toBe(false);
    expect(set.policies.has('srv')).toBe(true);
  });
});

// ============================================================================
// resolveTier — group → tier mapping
// ============================================================================

function buildPolicySet(server: string, tiers: Record<string, PolicyRule>): PolicySet {
  const tierMap = new Map<string, PolicyRule>();
  for (const [name, rule] of Object.entries(tiers)) tierMap.set(name, rule);
  const policies = new Map<string, Map<string, PolicyRule>>();
  policies.set(server, tierMap);
  return { policies };
}

describe('resolveTier', () => {
  const ruleReadonly: PolicyRule = { tools: { allow: ['get'] } };
  const ruleAdmin: PolicyRule = { tools: { allow: ['*'] } };
  const set = buildPolicySet('jira', { readonly: ruleReadonly, admin: ruleAdmin });

  it('returns the explicit per-group tier when present', () => {
    expect(
      resolveTier(set, 'jira', 'support-team', { defaultTier: 'readonly', groups: { 'support-team': 'admin' } }),
    ).toBe(ruleAdmin);
  });

  it('falls back to defaultTier when the group has no explicit assignment', () => {
    expect(resolveTier(set, 'jira', 'unknown-team', { defaultTier: 'readonly', groups: {} })).toBe(ruleReadonly);
  });

  it('returns null when no defaultTier and no group match', () => {
    expect(resolveTier(set, 'jira', 'unknown-team', { groups: {} })).toBeNull();
  });

  it('returns null when the server has no policies registered', () => {
    expect(resolveTier(set, 'unknown-server', 'g', { defaultTier: 'readonly', groups: {} })).toBeNull();
  });

  it('returns null when the resolved tier name is not registered for the server', () => {
    expect(resolveTier(set, 'jira', 'g', { defaultTier: 'nonexistent-tier', groups: {} })).toBeNull();
  });
});
