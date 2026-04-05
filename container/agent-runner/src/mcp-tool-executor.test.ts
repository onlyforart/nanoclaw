import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockCallTool = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  class MockClient {
    connect = mockConnect;
    callTool = mockCallTool;
    close = mockClose;
    constructor(_opts: unknown) {}
  }
  return { Client: MockClient };
});

const stdioTransportInstances: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
const httpTransportInstances: Array<{ url: URL; opts?: unknown }> = [];

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockStdioClientTransport {
    constructor(opts: { command: string; args: string[]; env?: Record<string, string> }) {
      stdioTransportInstances.push(opts);
    }
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class MockStreamableHTTPClientTransport {
    constructor(url: URL, opts?: unknown) {
      httpTransportInstances.push({ url, opts });
    }
  }
  return { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport };
});

import { McpToolExecutor, McpServerConfig } from './mcp-tool-executor.js';

// Keep backward-compat alias for existing tests
const transportInstances = stdioTransportInstances;

beforeEach(() => {
  mockConnect.mockReset();
  mockCallTool.mockReset();
  mockClose.mockReset();
  stdioTransportInstances.length = 0;
  httpTransportInstances.length = 0;
});

function sampleConfig(): Record<string, McpServerConfig> {
  return {
    nanoclaw: {
      command: 'node',
      args: ['ipc-mcp-stdio.js'],
      tools: ['send_message', 'schedule_task'],
      toolSchemas: [
        {
          name: 'send_message',
          description: 'Send a message',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        },
        {
          name: 'schedule_task',
          description: 'Schedule a task',
          inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } },
        },
      ],
    },
  };
}

describe('McpToolExecutor', () => {
  describe('initialize', () => {
    it('spawns MCP server via StdioClientTransport', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      expect(transportInstances).toHaveLength(1);
      expect(transportInstances[0]).toMatchObject({
        command: 'node',
        args: ['ipc-mcp-stdio.js'],
      });
      expect(mockConnect).toHaveBeenCalled();
    });

    it('builds Ollama tool schemas from config', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const tools = executor.getOllamaTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('nanoclaw__send_message');
      expect(tools[1].function.name).toBe('nanoclaw__schedule_task');
    });

    it('builds tool name mapping', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const map = executor.getToolNameMap();
      expect(map.get('nanoclaw__send_message')).toEqual({
        mcpTool: 'mcp__nanoclaw__send_message',
        serverName: 'nanoclaw',
      });
    });

    it('passes env vars to transport', async () => {
      const config: Record<string, McpServerConfig> = {
        myserver: {
          command: 'node',
          args: ['server.js'],
          tools: ['my_tool'],
          env: { MY_VAR: 'my_value' },
          toolSchemas: [],
        },
      };

      const executor = new McpToolExecutor();
      await executor.initialize(config);

      expect(transportInstances).toHaveLength(1);
      expect(transportInstances[0].env).toMatchObject({ MY_VAR: 'my_value' });
    });

    it('survives a server that fails to connect', async () => {
      mockConnect.mockRejectedValueOnce(new Error('spawn failed'));

      const executor = new McpToolExecutor();
      // Should not throw
      await executor.initialize(sampleConfig());

      // No tools should be available from the failed server
      // (but it shouldn't crash)
    });
  });

  describe('callTool', () => {
    it('routes call to correct MCP server', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: 'Message sent.' }],
      });

      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const result = await executor.callTool('mcp__nanoclaw__send_message', { text: 'hello' });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'send_message',
        arguments: { text: 'hello' },
      }, undefined, { timeout: undefined });
      expect(result).toBe('Message sent.');
    });

    it('throws for invalid MCP tool name format', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      await expect(executor.callTool('invalid_name', {})).rejects.toThrow(
        'Invalid MCP tool name format',
      );
    });

    it('throws for unknown server', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      await expect(
        executor.callTool('mcp__unknown__some_tool', {}),
      ).rejects.toThrow('MCP server not connected');
    });

    it('joins multiple text content blocks', async () => {
      mockCallTool.mockResolvedValue({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      });

      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const result = await executor.callTool('mcp__nanoclaw__send_message', {});
      expect(result).toBe('line 1\nline 2');
    });

    it('returns "(no output)" for empty content', async () => {
      mockCallTool.mockResolvedValue({ content: [] });

      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const result = await executor.callTool('mcp__nanoclaw__send_message', {});
      expect(result).toBe('(no output)');
    });
  });

  describe('close', () => {
    it('closes all connected servers', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      await executor.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });

  describe('getAnthropicTools', () => {
    it('returns tools in Anthropic SDK format', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(sampleConfig());

      const tools = executor.getAnthropicTools();
      expect(tools).toHaveLength(2);
      expect(tools[0]).toEqual({
        name: 'nanoclaw__send_message',
        description: 'Send a message',
        input_schema: { type: 'object', properties: { text: { type: 'string' } } },
      });
      expect(tools[1]).toEqual({
        name: 'nanoclaw__schedule_task',
        description: 'Schedule a task',
        input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
      });
    });

    it('returns empty array when no tools configured', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize({});

      expect(executor.getAnthropicTools()).toEqual([]);
    });
  });

  describe('HTTP transport (remote MCP servers)', () => {
    function httpConfig(): Record<string, McpServerConfig> {
      return {
        mongodb: {
          type: 'http',
          url: 'http://host.docker.internal:3200/mcp',
          tools: ['find', 'aggregate'],
          toolSchemas: [
            {
              name: 'find',
              description: 'Run a find query',
              inputSchema: { type: 'object', properties: { collection: { type: 'string' } } },
            },
            {
              name: 'aggregate',
              description: 'Run an aggregation pipeline',
              inputSchema: { type: 'object', properties: { pipeline: { type: 'array' } } },
            },
          ],
        },
      };
    }

    it('creates StreamableHTTPClientTransport for type:http entries', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(httpConfig());

      expect(httpTransportInstances).toHaveLength(1);
      expect(httpTransportInstances[0].url.toString()).toBe(
        'http://host.docker.internal:3200/mcp',
      );
      expect(stdioTransportInstances).toHaveLength(0);
      expect(mockConnect).toHaveBeenCalled();
    });

    it('passes headers to HTTP transport', async () => {
      const config: Record<string, McpServerConfig> = {
        mongodb: {
          type: 'http',
          url: 'http://host.docker.internal:3200/mcp',
          tools: ['find'],
          headers: { 'X-NanoClaw-Group': 'main' },
          toolSchemas: [
            { name: 'find', description: 'Find', inputSchema: {} },
          ],
        },
      };

      const executor = new McpToolExecutor();
      await executor.initialize(config);

      expect(httpTransportInstances).toHaveLength(1);
      const opts = httpTransportInstances[0].opts as { requestInit?: { headers?: Record<string, string> } };
      expect(opts?.requestInit?.headers).toEqual({ 'X-NanoClaw-Group': 'main' });
    });

    it('builds Ollama tool schemas from HTTP server config', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(httpConfig());

      const tools = executor.getOllamaTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].function.name).toBe('mongodb__find');
      expect(tools[1].function.name).toBe('mongodb__aggregate');
    });

    it('routes tool calls to HTTP-connected server', async () => {
      mockCallTool.mockResolvedValue({
        content: [{ type: 'text', text: '{"_id": "test"}' }],
      });

      const executor = new McpToolExecutor();
      await executor.initialize(httpConfig());

      const result = await executor.callTool('mcp__mongodb__find', {
        collection: 'users',
      });

      expect(mockCallTool).toHaveBeenCalledWith({
        name: 'find',
        arguments: { collection: 'users' },
      }, undefined, { timeout: undefined });
      expect(result).toBe('{"_id": "test"}');
    });

    it('handles mixed stdio and HTTP servers', async () => {
      const mixedConfig: Record<string, McpServerConfig> = {
        ...sampleConfig(),
        ...httpConfig(),
      };

      const executor = new McpToolExecutor();
      await executor.initialize(mixedConfig);

      expect(stdioTransportInstances).toHaveLength(1);
      expect(httpTransportInstances).toHaveLength(1);

      const tools = executor.getOllamaTools();
      expect(tools).toHaveLength(4); // 2 stdio + 2 http
    });

    it('skips entry with no command and no url', async () => {
      const config: Record<string, McpServerConfig> = {
        broken: {
          tools: ['something'],
          toolSchemas: [],
        } as McpServerConfig,
      };

      const executor = new McpToolExecutor();
      await executor.initialize(config);

      expect(stdioTransportInstances).toHaveLength(0);
      expect(httpTransportInstances).toHaveLength(0);
    });

    it('close works for HTTP servers', async () => {
      const executor = new McpToolExecutor();
      await executor.initialize(httpConfig());

      await executor.close();
      expect(mockClose).toHaveBeenCalled();
    });
  });
});
