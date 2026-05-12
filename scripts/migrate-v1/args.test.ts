import { describe, expect, it } from 'vitest';

import { ArgsError, parseArgs } from './args.js';

describe('migrate-v1 CLI args', () => {
  it('defaults mode=sandbox and selection=wired-only when only --v1-root is given', () => {
    const r = parseArgs(['--v1-root=/some/v1'], {});
    expect(r.mode).toBe('sandbox');
    expect(r.selection).toBe('wired-only');
    expect(r.v1Root).toBe('/some/v1');
    expect(r.validateOnly).toBe(false);
    expect(r.v2Root).toMatch(/^\/tmp\/nanoclaw-v1-migration-\d+$/);
  });

  it('honours --mode=live and uses cwd for v2Root by default', () => {
    const r = parseArgs(['--v1-root=/v1', '--mode=live'], {});
    expect(r.mode).toBe('live');
    expect(r.v2Root).toBe(process.cwd());
  });

  it('reads NANOCLAW_V1_PATH from env if --v1-root is omitted', () => {
    const r = parseArgs([], { NANOCLAW_V1_PATH: '/from/env' });
    expect(r.v1Root).toBe('/from/env');
  });

  it('reads NANOCLAW_MIGRATE_SELECTION from env if --selection is omitted', () => {
    const r = parseArgs(['--v1-root=/v1'], { NANOCLAW_MIGRATE_SELECTION: 'all' });
    expect(r.selection).toBe('all');
  });

  it('--selection on CLI overrides env', () => {
    const r = parseArgs(['--v1-root=/v1', '--selection=all'], {
      NANOCLAW_MIGRATE_SELECTION: 'wired-only',
    });
    expect(r.selection).toBe('all');
  });

  it('--validate-only is a boolean flag', () => {
    const r = parseArgs(['--v1-root=/v1', '--validate-only'], {});
    expect(r.validateOnly).toBe(true);
  });

  it('--v2-root explicit override beats both defaults', () => {
    const r = parseArgs(['--v1-root=/v1', '--v2-root=/some/v2'], {});
    expect(r.v2Root).toBe('/some/v2');
  });

  it('rejects invalid --mode', () => {
    expect(() => parseArgs(['--v1-root=/v1', '--mode=junk'], {})).toThrow(ArgsError);
  });

  it('rejects invalid --selection', () => {
    expect(() => parseArgs(['--v1-root=/v1', '--selection=junk'], {})).toThrow(ArgsError);
  });

  it('rejects missing --v1-root with no env fallback', () => {
    expect(() => parseArgs([], {})).toThrow(ArgsError);
  });
});
