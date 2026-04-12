import { describe, it, expect, vi, beforeEach } from 'vitest';

// Track transport instances for assertions
const httpTransportInstances: Array<{ url: URL; opts?: unknown }> = [];
const stdioTransportInstances: Array<unknown> = [];
const mockClientConnect = vi.fn();
const mockClientClose = vi.fn();
const mockClientListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockClientCallTool = vi.fn();

// Mock the MCP SDK modules
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class MockStreamableHTTPClientTransport {
    url: URL;
    constructor(url: URL, opts?: unknown) {
      this.url = url;
      httpTransportInstances.push({ url, opts });
    }
  }
  return { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  class MockStdioServerTransport {
    constructor() {
      stdioTransportInstances.push({});
    }
  }
  return { StdioServerTransport: MockStdioServerTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = mockClientConnect;
    close = mockClientClose;
    listTools = mockClientListTools;
    callTool = mockClientCallTool;
    constructor(_opts: unknown) {}
  }
  return { Client: MockClient };
});

// Mock the low-level Server
const mockServerConnect = vi.fn();
const mockSetRequestHandler = vi.fn();
vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class MockServer {
    connect = mockServerConnect;
    setRequestHandler = mockSetRequestHandler;
    constructor(_info: unknown, _opts: unknown) {}
  }
  return { Server: MockServer };
});

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: Symbol('ListToolsRequestSchema'),
  CallToolRequestSchema: Symbol('CallToolRequestSchema'),
}));

beforeEach(() => {
  httpTransportInstances.length = 0;
  stdioTransportInstances.length = 0;
  mockClientConnect.mockReset();
  mockClientClose.mockReset();
  mockClientListTools.mockReset().mockResolvedValue({ tools: [] });
  mockClientCallTool.mockReset();
  mockServerConnect.mockReset();
  mockSetRequestHandler.mockReset();
});

// Import the functions we'll test
import { parseArgs, createBridge } from './mcp-http-bridge.js';

describe('mcp-http-bridge', () => {
  describe('parseArgs', () => {
    it('parses --url correctly', () => {
      const result = parseArgs(['--url', 'http://localhost:3201/mcp']);
      expect(result.url).toBe('http://localhost:3201/mcp');
      expect(result.headers).toEqual({});
    });

    it('parses multiple --header flags', () => {
      const result = parseArgs([
        '--url', 'http://localhost:3201/mcp',
        '--header', 'X-NanoClaw-Group:slack_main',
        '--header', 'Authorization:Bearer token123',
      ]);
      expect(result.url).toBe('http://localhost:3201/mcp');
      expect(result.headers).toEqual({
        'X-NanoClaw-Group': 'slack_main',
        'Authorization': 'Bearer token123',
      });
    });

    it('throws when --url is missing', () => {
      expect(() => parseArgs([])).toThrow('--url is required');
    });

    it('throws when --url has no value', () => {
      expect(() => parseArgs(['--url'])).toThrow('--url is required');
    });

    it('handles header value containing colons', () => {
      const result = parseArgs([
        '--url', 'http://localhost:3201/mcp',
        '--header', 'Authorization:Bearer abc:def:ghi',
      ]);
      expect(result.headers).toEqual({
        'Authorization': 'Bearer abc:def:ghi',
      });
    });
  });

  describe('createBridge', () => {
    it('creates StreamableHTTPClientTransport with correct URL', async () => {
      await createBridge('http://host.docker.internal:3201/mcp', {});

      expect(httpTransportInstances).toHaveLength(1);
      expect(httpTransportInstances[0].url.toString()).toBe(
        'http://host.docker.internal:3201/mcp',
      );
    });

    it('passes headers to HTTP transport', async () => {
      const headers = { 'X-NanoClaw-Group': 'main', 'X-Custom': 'value' };
      await createBridge('http://host.docker.internal:3201/mcp', headers);

      expect(httpTransportInstances).toHaveLength(1);
      const opts = httpTransportInstances[0].opts as {
        requestInit?: { headers?: Record<string, string> };
      };
      expect(opts?.requestInit?.headers).toEqual(headers);
    });

    it('creates empty headers object when no headers provided', async () => {
      await createBridge('http://host.docker.internal:3201/mcp', {});

      const opts = httpTransportInstances[0].opts as {
        requestInit?: { headers?: Record<string, string> };
      };
      expect(opts?.requestInit?.headers).toEqual({});
    });

    it('connects the MCP client to the HTTP transport', async () => {
      await createBridge('http://host.docker.internal:3201/mcp', {});
      expect(mockClientConnect).toHaveBeenCalled();
    });

    it('registers tools/list and tools/call handlers on the stdio server', async () => {
      await createBridge('http://host.docker.internal:3201/mcp', {});
      // tools/list and tools/call handlers
      expect(mockSetRequestHandler).toHaveBeenCalledTimes(2);
    });

    it('creates StdioServerTransport and connects server', async () => {
      await createBridge('http://host.docker.internal:3201/mcp', {});

      expect(stdioTransportInstances).toHaveLength(1);
      expect(mockServerConnect).toHaveBeenCalled();
    });
  });
});
