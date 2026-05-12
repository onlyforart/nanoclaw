/**
 * K.1.f step 11 — Smoke test for committed config-schema examples.
 *
 * Verifies that the committed `.example` templates under `data/` are
 * syntactically valid JSON. Catches accidental syntax breakage on the
 * narrow `!data/*.json.example` gitignore exception lines. Keeps the
 * step-11 deliverables honest — the resolver readers already test
 * runtime parse-resilience against synthesised content, so this only
 * guards the committed templates' shape.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const COMMITTED_EXAMPLES = ['data/backend-defaults.json.example', 'data/mcp-servers.json.example'];

describe('committed config-schema examples', () => {
  for (const rel of COMMITTED_EXAMPLES) {
    it(`${rel} parses as JSON`, () => {
      const abs = path.join(REPO_ROOT, rel);
      const raw = fs.readFileSync(abs, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  }

  it('backend-defaults.json.example has the resolver-recognised key set per provider', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'data/backend-defaults.json.example'), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const provider of ['claude', 'ollama', 'anthropic-api']) {
      expect(parsed).toHaveProperty(provider);
      const entry = parsed[provider] as Record<string, unknown>;
      // Resolver reads model/temperature/maxToolRounds/timeoutMs;
      // each provider entry should include at least timeoutMs +
      // maxToolRounds (model + temperature optional per provider).
      expect(entry).toHaveProperty('maxToolRounds');
      expect(entry).toHaveProperty('timeoutMs');
    }
    // Pricing block consumed by webui agent-groups token-usage route.
    expect(parsed).toHaveProperty('pricing');
  });

  it('mcp-servers.json.example has servers object with stdio + remote variants', () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'data/mcp-servers.json.example'), 'utf-8');
    const parsed = JSON.parse(raw) as { servers?: Record<string, unknown> };
    expect(parsed.servers).toBeDefined();
    const entries = Object.entries(parsed.servers!).filter(([key]) => !key.startsWith('_comment'));
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // At least one stdio (has command) and one remote (has url).
    const hasStdio = entries.some(([, v]) => (v as Record<string, unknown>).command);
    const hasRemote = entries.some(([, v]) => (v as Record<string, unknown>).url);
    expect(hasStdio).toBe(true);
    expect(hasRemote).toBe(true);
  });
});
