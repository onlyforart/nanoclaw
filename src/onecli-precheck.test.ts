import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const ensureAgentMock = vi.fn();

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class MockOneCLI {
    ensureAgent = ensureAgentMock;
  },
}));

vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

let exitSpy: ReturnType<typeof vi.spyOn> | undefined;

beforeEach(() => {
  vi.resetModules();
  ensureAgentMock.mockReset();
  // process.exit is fatal — replace with a throw so we can assert the path
  // without killing the test runner.
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${String(code)}) called`);
  }) as unknown as ReturnType<typeof vi.spyOn>;
  process.env.ONECLI_URL = 'http://127.0.0.1:10254';
  process.env.ONECLI_API_KEY = 'precheck-test-key';
});

afterEach(() => {
  exitSpy?.mockRestore();
  delete process.env.ONECLI_URL;
  delete process.env.ONECLI_API_KEY;
});

describe('preflightOneCLI — env check', () => {
  it('exits(1) when ONECLI_URL is missing', async () => {
    delete process.env.ONECLI_URL;
    const { preflightOneCLI } = await import('./onecli-precheck.js');
    await expect(preflightOneCLI()).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits(1) when ONECLI_API_KEY is missing', async () => {
    delete process.env.ONECLI_API_KEY;
    const { preflightOneCLI } = await import('./onecli-precheck.js');
    await expect(preflightOneCLI()).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('preflightOneCLI — connectivity check', () => {
  it('exits(1) when ensureAgent rejects', async () => {
    ensureAgentMock.mockRejectedValueOnce(new Error('network unreachable'));
    const { preflightOneCLI } = await import('./onecli-precheck.js');
    await expect(preflightOneCLI()).rejects.toThrow(/process\.exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('returns normally when ensureAgent succeeds', async () => {
    ensureAgentMock.mockResolvedValueOnce({ created: false });
    const { preflightOneCLI } = await import('./onecli-precheck.js');
    await expect(preflightOneCLI()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('uses ensureAgent as the probe (no health() method exists in SDK 0.3.1)', async () => {
    ensureAgentMock.mockResolvedValueOnce({ created: true });
    const { preflightOneCLI } = await import('./onecli-precheck.js');
    await preflightOneCLI();
    expect(ensureAgentMock).toHaveBeenCalledTimes(1);
    expect(ensureAgentMock).toHaveBeenCalledWith({
      name: expect.stringMatching(/nanoclaw-host/),
      identifier: expect.stringMatching(/nanoclaw-host/),
    });
  });
});
