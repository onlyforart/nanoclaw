import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock platform
vi.mock('./platform.js', () => ({
  commandExists: vi.fn(() => true),
}));

// Mock status
vi.mock('./status.js', () => ({
  emitStatus: vi.fn(),
}));

// Capture execSync calls
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import { run } from './container.js';
import { emitStatus } from './status.js';

describe('setup/container proxy forwarding', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const proxyVars = [
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    // Save and clear proxy env vars
    for (const v of proxyVars) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
    // Make build succeed by default
    mockExecSync.mockReturnValue('Container OK');
  });

  afterEach(() => {
    // Restore env
    for (const v of proxyVars) {
      if (savedEnv[v] !== undefined) {
        process.env[v] = savedEnv[v];
      } else {
        delete process.env[v];
      }
    }
  });

  it('forwards proxy env vars as --build-arg when set', async () => {
    process.env.https_proxy = 'http://proxy.corp:8080';
    process.env.no_proxy = 'localhost';

    await run(['--runtime', 'docker']);

    // The build command (first execSync after docker info) should include proxy args
    const buildCall = mockExecSync.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('docker build'),
    );
    expect(buildCall).toBeDefined();
    const buildCmd = buildCall![0] as string;
    expect(buildCmd).toContain('--build-arg https_proxy=http://proxy.corp:8080');
    expect(buildCmd).toContain('--build-arg no_proxy=localhost');
  });

  it('adds npm_config_strict_ssl=false when proxy vars are present', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:8080';

    await run(['--runtime', 'docker']);

    const buildCall = mockExecSync.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('docker build'),
    );
    expect(buildCall).toBeDefined();
    const buildCmd = buildCall![0] as string;
    expect(buildCmd).toContain('--build-arg npm_config_strict_ssl=false');
  });

  it('does not add proxy args when no proxy env vars are set', async () => {
    await run(['--runtime', 'docker']);

    const buildCall = mockExecSync.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === 'string' && call[0].includes('docker build'),
    );
    expect(buildCall).toBeDefined();
    const buildCmd = buildCall![0] as string;
    expect(buildCmd).not.toContain('--build-arg');
  });
});
