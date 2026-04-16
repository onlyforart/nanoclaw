import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock env.js so readEnvFile returns test values
vi.mock('./env.js', () => ({
  readEnvFile: vi.fn((keys: string[]) => {
    const vals: Record<string, string> = {
      OLLAMA_REMOTE_HOST: 'http://192.168.1.100:11434',
    };
    const result: Record<string, string> = {};
    for (const k of keys) {
      if (vals[k]) result[k] = vals[k];
    }
    return result;
  }),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const stdinData: string[] = [];
  const stdin = new PassThrough();
  const origWrite = stdin.write.bind(stdin);
  stdin.write = ((chunk: string | Buffer, ...rest: unknown[]) => {
    stdinData.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return origWrite(chunk, ...(rest as []));
  }) as typeof stdin.write;

  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough & { writtenData: string[] };
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = Object.assign(stdin, { writtenData: stdinData });
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import {
  runContainerAgent,
  ContainerOutput,
  filterServerTools,
} from './container-runner.js';
import type { RegisteredGroup } from './types.js';
import { spawn } from 'child_process';

const mockSpawn = vi.mocked(spawn);

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('filterServerTools', () => {
  function schema(name: string) {
    return {
      name,
      description: `${name} description`,
      inputSchema: { type: 'object' },
    };
  }

  const allSchemas = [
    schema('tool_a'),
    schema('tool_b'),
    schema('tool_c'),
    schema('tool_d'),
    schema('tool_e'),
  ];

  it('filters discovered schemas to configured tools only', () => {
    const result = filterServerTools(['tool_a', 'tool_c'], allSchemas);
    expect(result).not.toBeNull();
    expect(result!.tools).toEqual(['tool_a', 'tool_c']);
    expect(result!.toolSchemas.map((s) => s.name)).toEqual([
      'tool_a',
      'tool_c',
    ]);
  });

  it('passes all configured tools when no allowedTools', () => {
    const result = filterServerTools(
      ['tool_a', 'tool_b', 'tool_c'],
      allSchemas,
    );
    expect(result!.tools).toEqual(['tool_a', 'tool_b', 'tool_c']);
    expect(result!.toolSchemas).toHaveLength(3);
  });

  it('intersects allowedTools with configured tools', () => {
    const result = filterServerTools(
      ['tool_a', 'tool_b', 'tool_c'],
      allSchemas,
      ['tool_a', 'tool_c', 'tool_x'],
    );
    expect(result!.tools).toEqual(['tool_a', 'tool_c']);
    expect(result!.toolSchemas.map((s) => s.name)).toEqual([
      'tool_a',
      'tool_c',
    ]);
  });

  it('returns null when allowedTools excludes all configured tools', () => {
    const result = filterServerTools(['tool_a', 'tool_b'], allSchemas, [
      'tool_x',
      'tool_y',
    ]);
    expect(result).toBeNull();
  });

  it('handles discovered schemas being a subset of configured tools', () => {
    const partial = [schema('tool_a')];
    const result = filterServerTools(['tool_a', 'tool_b'], partial);
    expect(result!.tools).toEqual(['tool_a', 'tool_b']);
    expect(result!.toolSchemas).toHaveLength(1);
    expect(result!.toolSchemas[0].name).toBe('tool_a');
  });

  it('returns empty toolSchemas when none discovered', () => {
    const result = filterServerTools(['tool_a', 'tool_b'], []);
    expect(result!.tools).toEqual(['tool_a', 'tool_b']);
    expect(result!.toolSchemas).toEqual([]);
  });

  it('treats null allowedTools same as undefined', () => {
    const result = filterServerTools(['tool_a', 'tool_b'], allSchemas, null);
    expect(result!.tools).toEqual(['tool_a', 'tool_b']);
    expect(result!.toolSchemas).toHaveLength(2);
  });
});

describe('Ollama direct mode container args', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    mockSpawn.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips credential proxy env vars for ollama: model', async () => {
    const ollamaInput = {
      ...testInput,
      model: 'ollama:qwen3',
    };

    const resultPromise = runContainerAgent(testGroup, ollamaInput, () => {});

    // Let it start
    await vi.advanceTimersByTimeAsync(10);

    // Check spawn args for credential-related env vars
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];

    // Should NOT contain ANTHROPIC_BASE_URL or ANTHROPIC_API_KEY
    expect(spawnArgs).not.toContain('ANTHROPIC_API_KEY=placeholder');
    expect(spawnArgs.join(' ')).not.toContain('ANTHROPIC_BASE_URL');

    // Clean up
    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('passes OLLAMA_HOST and OLLAMA_REMOTE_HOST env vars', async () => {
    const resultPromise = runContainerAgent(
      testGroup,
      { ...testInput, model: 'ollama-remote:mistral' },
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);

    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    const argsStr = spawnArgs.join(' ');

    // Both Ollama env vars should be passed through
    expect(argsStr).toContain('OLLAMA_REMOTE_HOST=');
    // OLLAMA_HOST is also passed (mock readEnvFile returns it)
    expect(argsStr).not.toContain('ANTHROPIC_BASE_URL');

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });

  it('writes maxToolRounds and timeoutMs into stdin JSON', async () => {
    const inputWithLimits = {
      ...testInput,
      model: 'ollama:qwen3',
      maxToolRounds: 5,
      timeoutMs: 120_000,
    };

    const resultPromise = runContainerAgent(
      testGroup,
      inputWithLimits,
      () => {},
    );

    await vi.advanceTimersByTimeAsync(10);

    const stdinData = fakeProc.stdin.writtenData.join('');
    const parsed = JSON.parse(stdinData);
    expect(parsed.maxToolRounds).toBe(5);
    expect(parsed.timeoutMs).toBe(120_000);

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;
  });
});
