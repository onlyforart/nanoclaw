/**
 * Regression guard: the container's build step must carry every
 * non-TS asset from src/ across to dist/ alongside the compiled
 * JS. Modules that runtime-load JSON via
 * path.join(__dirname, '<name>.json') crash with ENOENT if the
 * build output is shipped without the accompanying .json files.
 *
 * This has bitten us before: a shared mcp-safe-env.json was added
 * to src/ and not to dist/, silently taking down slack_main for an
 * hour because every agent-runner container exited on module init.
 *
 * We run the real `npm run build` script so the test stays in
 * lockstep with developer + CI builds. The Dockerfile entrypoint
 * runs a one-liner that must mirror the same behaviour (tsc output
 * + json copy); if the entrypoint drifts from the npm script,
 * container runtime and local dev diverge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRunnerRoot = resolve(__dirname, '..');
const distDir = join(agentRunnerRoot, 'dist');

beforeAll(() => {
  // Clean rebuild so we verify the build step itself populates dist,
  // not a stale artefact from a previous run.
  rmSync(distDir, { recursive: true, force: true });
  execSync('npm run build', {
    cwd: agentRunnerRoot,
    stdio: 'inherit',
  });
});

afterAll(() => {
  // Leave dist/ in place — the rest of the suite and consuming
  // tools (nanoclaw host) may expect a built state.
});

describe('container build artefacts', () => {
  it('dist/ contains mcp-safe-env.json after `npm run build`', () => {
    const target = join(distDir, 'mcp-safe-env.json');
    expect(
      existsSync(target),
      `expected ${target} to exist after build — tsc alone does not copy .json files, so the build script must have an explicit copy step`,
    ).toBe(true);
  });

  it('dist/ contains every *.json from src/', () => {
    // Future-proofing: if another runtime-loaded JSON asset lands
    // in src/, this test catches the missing-in-dist case the
    // moment the next build runs.
    const srcJsons = readdirSync(join(agentRunnerRoot, 'src')).filter((f) =>
      f.endsWith('.json'),
    );
    for (const name of srcJsons) {
      const target = join(distDir, name);
      expect(
        existsSync(target),
        `src/${name} is missing from dist/ after build`,
      ).toBe(true);
    }
  });
});
