import { describe, it, expect, mock, beforeEach } from 'bun:test';

// === SDK transport mocks ===
//
// `@modelcontextprotocol/sdk/client/{index,stdio,streamableHttp}.js` are
// external packages, so static `import` after `mock.module` works for them
// (the hoisting issue only bites for relative paths to the file under test).
// We capture every constructor call so transport-selection tests can assert
// shape without spawning processes or opening sockets.

interface StdioCtorArgs {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}
interface HttpCtorArgs {
  url: URL;
  init?: { requestInit?: { headers?: Record<string, string> } };
}

const stdioCtorCalls: StdioCtorArgs[] = [];
const httpCtorCalls: HttpCtorArgs[] = [];

mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(args: StdioCtorArgs) {
      stdioCtorCalls.push(args);
    }
  },
}));

mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: URL, init?: HttpCtorArgs['init']) {
      httpCtorCalls.push({ url, init });
    }
  },
}));

// === SDK Client mock ===
//
// One Client instance per server connection. We expose hooks so each test
// can wire connect/listTools/callTool/close behaviour per server.

interface ClientCtorArgs {
  name: string;
  version: string;
}

const clientInstances: MockClient[] = [];

// Module-level swap points. Tests mutate these via `setConnect()`,
// `setListTools()` etc. so behaviour can be wired BEFORE `initialize()`
// constructs new MockClient instances. (Class-field instance properties
// shadow prototype mutations — module vars don't.)
type ConnectFn = (this: MockClient) => Promise<void>;
type ListToolsFn = (
  this: MockClient,
) => Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
type CallToolFn = (
  this: MockClient,
  req: { name: string; arguments: Record<string, unknown> },
  schema: undefined,
  options: { timeout?: number },
) => Promise<{ content: Array<{ type: string; text?: string }> }>;
type CloseFn = (this: MockClient) => Promise<void>;

let connectImpl: ConnectFn = () => Promise.resolve();
let listToolsImpl: ListToolsFn = () => Promise.resolve({ tools: [] });
let callToolImpl: CallToolFn = () =>
  Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
let closeImpl: CloseFn = () => Promise.resolve();

class MockClient {
  ctor: ClientCtorArgs;
  callToolCalls: Array<{
    req: { name: string; arguments: Record<string, unknown> };
    options: { timeout?: number };
  }> = [];
  closeCalled = false;

  constructor(args: ClientCtorArgs) {
    this.ctor = args;
    clientInstances.push(this);
  }
  connect(_transport: unknown): Promise<void> {
    return connectImpl.call(this);
  }
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }> {
    return listToolsImpl.call(this);
  }
  callTool(
    req: { name: string; arguments: Record<string, unknown> },
    schema: undefined,
    options: { timeout?: number },
  ): Promise<{ content: Array<{ type: string; text?: string }> }> {
    this.callToolCalls.push({ req, options });
    return callToolImpl.call(this, req, schema, options);
  }
  close(): Promise<void> {
    this.closeCalled = true;
    return closeImpl.call(this);
  }
}

mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClient,
}));

// Dynamic import — file under test depends on the mocked SDK modules.
const { McpToolExecutor } = await import('./mcp-tool-executor.js');

beforeEach(() => {
  stdioCtorCalls.length = 0;
  httpCtorCalls.length = 0;
  clientInstances.length = 0;
  // Reset the module-level swap points to safe defaults.
  connectImpl = () => Promise.resolve();
  listToolsImpl = () => Promise.resolve({ tools: [] });
  callToolImpl = () => Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  closeImpl = () => Promise.resolve();
  // Each test starts with a clean process.env shape for the safe-env keys
  // we touch. PATH always exists, but we want HOME absent unless a test
  // sets it.
  delete process.env.HOME;
  delete process.env.TZ;
});

// =====================================================================
// 1. Transport selection — stdio vs http vs empty
// =====================================================================

describe('McpToolExecutor — transport selection', () => {
  it('spawns stdio transport when config has `command`', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({
      srv: { command: '/usr/bin/node', args: ['server.js'] },
    });

    expect(stdioCtorCalls.length).toBe(1);
    expect(stdioCtorCalls[0].command).toBe('/usr/bin/node');
    expect(stdioCtorCalls[0].args).toEqual(['server.js']);
    expect(httpCtorCalls.length).toBe(0);
  });

  it('uses http transport when config.type === "http" and url is set', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({
      remote: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    });

    expect(httpCtorCalls.length).toBe(1);
    expect(httpCtorCalls[0].url.toString()).toBe('https://example.test/mcp');
    expect(httpCtorCalls[0].init?.requestInit?.headers).toEqual({ Authorization: 'Bearer x' });
    expect(stdioCtorCalls.length).toBe(0);
  });

  it('skips a server that has neither command nor url — no error, no registration', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ broken: {} });

    expect(stdioCtorCalls.length).toBe(0);
    expect(httpCtorCalls.length).toBe(0);
    expect(exec.getOllamaTools()).toEqual([]);
  });

  it('passes args=[] when config omits args', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/echo' } });

    expect(stdioCtorCalls[0].args).toEqual([]);
  });
});

// =====================================================================
// 2. Stdio environment composition
// =====================================================================

describe('McpToolExecutor — stdio env composition', () => {
  it('forwards safe-env keys from process.env', async () => {
    process.env.HOME = '/home/test';
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    expect(stdioCtorCalls[0].env?.HOME).toBe('/home/test');
  });

  it('per-server env overrides safe-env defaults', async () => {
    process.env.TZ = 'UTC';
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x', env: { TZ: 'Europe/London' } } });

    expect(stdioCtorCalls[0].env?.TZ).toBe('Europe/London');
  });

  it('extraEnv beats per-server env beats safe-env', async () => {
    process.env.TZ = 'UTC';
    const exec = new McpToolExecutor();
    await exec.initialize(
      { srv: { command: '/bin/x', env: { TZ: 'Europe/London' } } },
      { TZ: 'Asia/Tokyo' },
    );

    expect(stdioCtorCalls[0].env?.TZ).toBe('Asia/Tokyo');
  });

  it('omits absent safe-env keys (does not set them to undefined)', async () => {
    delete process.env.HOME;
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    expect('HOME' in (stdioCtorCalls[0].env ?? {})).toBe(false);
  });
});

// =====================================================================
// 3. Tool discovery — discover-all vs allowlist vs pre-supplied schemas
// =====================================================================

describe('McpToolExecutor — tool discovery modes', () => {
  beforeEach(() => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [
          { name: 'alpha', description: 'A', inputSchema: { type: 'object' } },
          { name: 'beta', description: 'B', inputSchema: { type: 'object' } },
          { name: 'gamma', inputSchema: { type: 'object' } }, // no description
        ],
      });
  });

  it('tools=undefined registers ALL discovered tools', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const names = exec.getOllamaTools().map((t) => t.function.name).sort();
    expect(names).toEqual(['srv__alpha', 'srv__beta', 'srv__gamma']);
  });

  it('tools=[] registers ALL (treated same as undefined — discover-all)', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x', tools: [] } });

    const names = exec.getOllamaTools().map((t) => t.function.name).sort();
    expect(names).toEqual(['srv__alpha', 'srv__beta', 'srv__gamma']);
  });

  it('tools=["alpha","beta"] filters discovery to allowlist', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x', tools: ['alpha', 'beta'] } });

    const names = exec.getOllamaTools().map((t) => t.function.name).sort();
    expect(names).toEqual(['srv__alpha', 'srv__beta']);
  });

  it('pre-supplied toolSchemas skip listTools and use the provided shapes', async () => {
    const listToolsSpy = mock();
    listToolsImpl = () => {
      listToolsSpy();
      return Promise.resolve({ tools: [] });
    };

    const exec = new McpToolExecutor();
    await exec.initialize({
      srv: {
        type: 'http',
        url: 'https://example/mcp',
        toolSchemas: [{ name: 'preset', description: 'P', inputSchema: { type: 'object' } }],
      },
    });

    expect(listToolsSpy).not.toHaveBeenCalled();
    const names = exec.getOllamaTools().map((t) => t.function.name);
    expect(names).toEqual(['srv__preset']);
  });

  it('missing description defaults to empty string in registered schemas', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const gamma = exec.getOllamaTools().find((t) => t.function.name === 'srv__gamma');
    expect(gamma?.function.description).toBe('');
    const gammaA = exec.getAnthropicTools().find((t) => t.name === 'srv__gamma');
    expect(gammaA?.description).toBe('');
  });
});

// =====================================================================
// 4. Failure isolation — connect / listTools failures don't bubble
// =====================================================================

describe('McpToolExecutor — failure isolation', () => {
  it('connect failure leaves server unregistered and does not throw', async () => {
    connectImpl = function (this: MockClient) {
      // First instance fails; subsequent ones succeed.
      if (clientInstances.indexOf(this) === 0) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve();
    };

    const exec = new McpToolExecutor();
    await expect(
      exec.initialize({
        bad: { command: '/bin/x' },
        good: { command: '/bin/y' },
      }),
    ).resolves.toBeUndefined();

    // Calling a tool against the bad server should now report not-connected.
    await expect(exec.callTool('mcp__bad__tool', {})).rejects.toThrow(/not connected/);
    // Reset for next test.
    connectImpl = () => Promise.resolve();
  });

  it('listTools failure leaves the server connected but with zero tools', async () => {
    listToolsImpl = () => Promise.reject(new Error('list-fail'));

    const exec = new McpToolExecutor();
    await expect(exec.initialize({ srv: { command: '/bin/x' } })).resolves.toBeUndefined();

    expect(exec.getOllamaTools()).toEqual([]);
    // Server connection still exists — callTool routing finds it but the
    // server reports no tools. Spec: the executor doesn't pre-validate
    // tool names against the discovered set; calls are forwarded to the
    // server, which is the authoritative reject.
    callToolImpl = () =>
      Promise.reject(new Error('unknown tool'));
    await expect(exec.callTool('mcp__srv__anything', {})).rejects.toThrow(/unknown tool/);
    callToolImpl = () =>
      Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
    listToolsImpl = () => Promise.resolve({ tools: [] });
  });
});

// =====================================================================
// 5. Tool name + schema shape (engine-facing contract)
// =====================================================================

describe('McpToolExecutor — engine-facing tool name shape', () => {
  beforeEach(() => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [{ name: 'send_message', description: 'd', inputSchema: { type: 'object' } }],
      });
  });

  it('engine-facing name is `{server}__{tool}` for both Ollama and Anthropic formats (no mcp__ prefix)', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ nanoclaw: { command: '/bin/x' } });

    const ollama = exec.getOllamaTools();
    const anthropic = exec.getAnthropicTools();

    expect(ollama[0].function.name).toBe('nanoclaw__send_message');
    expect(anthropic[0].name).toBe('nanoclaw__send_message');
  });

  it('toolNameMap resolves engine-facing name to mcp__-prefixed callTool address', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ nanoclaw: { command: '/bin/x' } });

    const map = exec.getToolNameMap();
    const entry = map.get('nanoclaw__send_message');
    expect(entry).toEqual({ mcpTool: 'mcp__nanoclaw__send_message', serverName: 'nanoclaw' });
  });

  it('Ollama tool format has type="function" with name/description/parameters', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const t = exec.getOllamaTools()[0];
    expect(t.type).toBe('function');
    expect(t.function.name).toBe('srv__send_message');
    expect(t.function.description).toBe('d');
    expect(t.function.parameters).toEqual({ type: 'object' });
  });

  it('Anthropic tool format has name/description/input_schema', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const t = exec.getAnthropicTools()[0];
    expect(t.name).toBe('srv__send_message');
    expect(t.description).toBe('d');
    expect(t.input_schema).toEqual({ type: 'object' });
  });
});

// =====================================================================
// 6. callTool — name parsing, routing, output shaping
// =====================================================================

describe('McpToolExecutor — callTool routing', () => {
  beforeEach(() => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [{ name: 'fetch', description: '', inputSchema: { type: 'object' } }],
      });
  });

  it('forwards to client.callTool with the unprefixed tool name + args', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    await exec.callTool('mcp__srv__fetch', { url: 'x' });

    const client = clientInstances[0];
    expect(client.callToolCalls).toHaveLength(1);
    expect(client.callToolCalls[0].req).toEqual({ name: 'fetch', arguments: { url: 'x' } });
  });

  it('joins text content parts with newline and ignores non-text parts', async () => {
    callToolImpl = () =>
      Promise.resolve({
        content: [
          { type: 'text', text: 'line1' },
          { type: 'image' },
          { type: 'text', text: 'line2' },
        ],
      });

    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const out = await exec.callTool('mcp__srv__fetch', {});
    expect(out).toBe('line1\nline2');
    callToolImpl = () =>
      Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('returns "(no output)" when there are no text parts', async () => {
    callToolImpl = () =>
      Promise.resolve({ content: [{ type: 'image' }] });

    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    const out = await exec.callTool('mcp__srv__fetch', {});
    expect(out).toBe('(no output)');
    callToolImpl = () =>
      Promise.resolve({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('throws on malformed tool name (no mcp__ prefix or wrong separator count)', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    await expect(exec.callTool('not_an_mcp_name', {})).rejects.toThrow(/Invalid MCP tool name/);
    await expect(exec.callTool('mcp__only-one-part', {})).rejects.toThrow(/Invalid MCP tool name/);
  });

  it('throws when server prefix references an unknown server', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    await expect(exec.callTool('mcp__nope__tool', {})).rejects.toThrow(/not connected: nope/);
  });

  it('supports tool names containing underscores (server portion is non-underscore)', async () => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [{ name: 'send_message_now', description: '', inputSchema: { type: 'object' } }],
      });
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    await exec.callTool('mcp__srv__send_message_now', { x: 1 });
    const client = clientInstances[0];
    expect(client.callToolCalls[0].req.name).toBe('send_message_now');
  });

  it('supports server names containing hyphens (production convention)', async () => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [{ name: 'list_pods', description: '', inputSchema: { type: 'object' } }],
      });
    const exec = new McpToolExecutor();
    await exec.initialize({ 'eks-kubectl': { command: '/bin/x' } });

    await exec.callTool('mcp__eks-kubectl__list_pods', {});
    const client = clientInstances[0];
    expect(client.callToolCalls[0].req.name).toBe('list_pods');
  });
});

// =====================================================================
// 7. Lifecycle — timeout propagation + close
// =====================================================================

describe('McpToolExecutor — lifecycle', () => {
  beforeEach(() => {
    listToolsImpl = () =>
      Promise.resolve({
        tools: [{ name: 'fetch', description: '', inputSchema: { type: 'object' } }],
      });
  });

  it('propagates callTimeoutMs from initialize options to client.callTool', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } }, undefined, { callTimeoutMs: 12345 });

    await exec.callTool('mcp__srv__fetch', {});

    const client = clientInstances[0];
    expect(client.callToolCalls[0].options).toEqual({ timeout: 12345 });
  });

  it('passes timeout=undefined when no callTimeoutMs was given', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });

    await exec.callTool('mcp__srv__fetch', {});

    const client = clientInstances[0];
    expect(client.callToolCalls[0].options).toEqual({ timeout: undefined });
  });

  it('close() invokes client.close() on every registered server', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ a: { command: '/bin/x' }, b: { command: '/bin/y' } });

    expect(clientInstances).toHaveLength(2);
    await exec.close();
    expect(clientInstances[0].closeCalled).toBe(true);
    expect(clientInstances[1].closeCalled).toBe(true);
  });

  it('close() continues past one server\'s close() error', async () => {
    let calls = 0;
    closeImpl = function (this: MockClient) {
      calls += 1;
      if (clientInstances.indexOf(this) === 0) return Promise.reject(new Error('close-fail'));
      return Promise.resolve();
    };

    const exec = new McpToolExecutor();
    await exec.initialize({ a: { command: '/bin/x' }, b: { command: '/bin/y' } });
    await expect(exec.close()).resolves.toBeUndefined();
    expect(calls).toBe(2);

    closeImpl = () => Promise.resolve();
  });

  it('after close(), callTool reports the server is no longer connected', async () => {
    const exec = new McpToolExecutor();
    await exec.initialize({ srv: { command: '/bin/x' } });
    await exec.close();

    await expect(exec.callTool('mcp__srv__fetch', {})).rejects.toThrow(/not connected/);
  });

  it('close() on a never-initialized executor is a no-op', async () => {
    const exec = new McpToolExecutor();
    await expect(exec.close()).resolves.toBeUndefined();
  });
});

