/**
 * Tests for MCP policy loader and evaluator (Step 10).
 *
 * Tests derived from the specification (docs/REMOTE-MCP-SERVERS.md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  loadPolicies,
  resolveTier,
  evaluatePolicy,
  type PolicyRule,
} from './mcp-policy.js';

// ---------------------------------------------------------------------------
// evaluatePolicy — pure logic, no filesystem
// ---------------------------------------------------------------------------
describe('evaluatePolicy', () => {
  it('allows tool in allow list', () => {
    const policy: PolicyRule = { tools: { allow: ['find'] } };
    expect(evaluatePolicy(policy, 'find', {})).toEqual({ allowed: true });
  });

  it('denies tool not in allow list', () => {
    const policy: PolicyRule = { tools: { allow: ['find'] } };
    const result = evaluatePolicy(policy, 'delete-many', {});
    expect(result.allowed).toBe(false);
  });

  it('denies tool in deny list even if in allow via wildcard', () => {
    const policy: PolicyRule = {
      tools: { allow: ['*'], deny: ['delete-many'] },
    };
    const result = evaluatePolicy(policy, 'delete-many', {});
    expect(result.allowed).toBe(false);
  });

  it('allows tool with matching database argument', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: { database: { allow: ['analytics'] } },
    };
    expect(evaluatePolicy(policy, 'find', { database: 'analytics' })).toEqual({
      allowed: true,
    });
  });

  it('denies tool with non-matching database argument', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: { database: { allow: ['analytics'] } },
    };
    const result = evaluatePolicy(policy, 'find', { database: 'secrets' });
    expect(result.allowed).toBe(false);
  });

  it('allows when constrained argument is not present in args', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: { database: { allow: ['analytics'] } },
    };
    expect(evaluatePolicy(policy, 'find', {})).toEqual({ allowed: true });
  });

  it('denies with argument deny match', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: { collection: { deny: ['users'] } },
    };
    const result = evaluatePolicy(policy, 'find', { collection: 'users' });
    expect(result.allowed).toBe(false);
  });

  it('allows with prefix glob pattern', () => {
    const policy: PolicyRule = {
      tools: { allow: ['get_object'] },
      arguments: { bucket: { allow: ['reports*'] } },
    };
    expect(
      evaluatePolicy(policy, 'get_object', { bucket: 'reports-prod' }),
    ).toEqual({
      allowed: true,
    });
  });

  it('denies with non-matching prefix glob', () => {
    const policy: PolicyRule = {
      tools: { allow: ['get_object'] },
      arguments: { bucket: { allow: ['reports*'] } },
    };
    const result = evaluatePolicy(policy, 'get_object', {
      bucket: 'logs-prod',
    });
    expect(result.allowed).toBe(false);
  });

  it('allows with wildcard allow (all tools)', () => {
    const policy: PolicyRule = { tools: { allow: ['*'] } };
    expect(evaluatePolicy(policy, 'anything', {})).toEqual({ allowed: true });
  });

  it('allows with wildcard argument allow', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: { collection: { allow: ['*'] } },
    };
    expect(evaluatePolicy(policy, 'find', { collection: 'anything' })).toEqual({
      allowed: true,
    });
  });

  it('denies with empty policy (default-deny)', () => {
    const policy: PolicyRule = { tools: {} };
    const result = evaluatePolicy(policy, 'find', {});
    expect(result.allowed).toBe(false);
  });

  it('deny takes precedence over wildcard allow', () => {
    const policy: PolicyRule = {
      tools: { allow: ['*'], deny: ['drop-database'] },
    };
    expect(evaluatePolicy(policy, 'find', {}).allowed).toBe(true);
    expect(evaluatePolicy(policy, 'drop-database', {}).allowed).toBe(false);
  });

  it('argument deny takes precedence over argument allow', () => {
    const policy: PolicyRule = {
      tools: { allow: ['find'] },
      arguments: {
        database: { allow: ['*'], deny: ['admin'] },
      },
    };
    expect(
      evaluatePolicy(policy, 'find', { database: 'analytics' }).allowed,
    ).toBe(true);
    expect(evaluatePolicy(policy, 'find', { database: 'admin' }).allowed).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// loadPolicies / resolveTier — filesystem tests
// ---------------------------------------------------------------------------
describe('loadPolicies + resolveTier', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-policy-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writePolicy(serverName: string, tierName: string, content: string) {
    const dir = path.join(tmpDir, serverName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${tierName}.yaml`), content);
  }

  it('loads YAML policy from file', () => {
    writePolicy(
      'mongodb',
      'readonly',
      `
tools:
  allow:
    - find
    - aggregate
arguments:
  database:
    allow:
      - analytics
`,
    );
    const ps = loadPolicies(tmpDir);
    expect(ps.policies.has('mongodb')).toBe(true);
    const tier = ps.policies.get('mongodb')!.get('readonly')!;
    expect(tier.tools.allow).toEqual(['find', 'aggregate']);
    expect(tier.arguments!.database.allow).toEqual(['analytics']);
  });

  it('returns null for missing policy file', () => {
    const ps = loadPolicies(tmpDir);
    const tier = resolveTier(ps, 'nonexistent', 'main', { groups: {} });
    expect(tier).toBeNull();
  });

  it('handles malformed YAML gracefully', () => {
    writePolicy('mongodb', 'bad', '{{{{not yaml');
    const ps = loadPolicies(tmpDir);
    // Should load but the policy may be empty or malformed
    // The important thing is no crash
    expect(ps).toBeDefined();
  });

  it('resolves explicit group tier', () => {
    writePolicy(
      'mongodb',
      'admin',
      `
tools:
  allow: ["*"]
`,
    );
    writePolicy(
      'mongodb',
      'readonly',
      `
tools:
  allow:
    - find
`,
    );
    const ps = loadPolicies(tmpDir);
    const assignments = { defaultTier: 'readonly', groups: { main: 'admin' } };
    const tier = resolveTier(ps, 'mongodb', 'main', assignments);
    expect(tier).not.toBeNull();
    expect(tier!.tools.allow).toEqual(['*']);
  });

  it('falls back to default tier when group not listed', () => {
    writePolicy(
      'mongodb',
      'readonly',
      `
tools:
  allow:
    - find
`,
    );
    const ps = loadPolicies(tmpDir);
    const assignments = { defaultTier: 'readonly', groups: {} };
    const tier = resolveTier(ps, 'mongodb', 'slack_ops', assignments);
    expect(tier).not.toBeNull();
    expect(tier!.tools.allow).toEqual(['find']);
  });

  it('returns null when no default and no match (fail-closed)', () => {
    writePolicy(
      'mongodb',
      'admin',
      `
tools:
  allow: ["*"]
`,
    );
    const ps = loadPolicies(tmpDir);
    const assignments = { groups: { main: 'admin' } };
    const tier = resolveTier(ps, 'mongodb', 'unknown_group', assignments);
    expect(tier).toBeNull();
  });
});
