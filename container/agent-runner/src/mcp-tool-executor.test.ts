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

const transportInstances: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class MockStdioClientTransport {
    constructor(opts: { command: string; args: string[]; env?: Record<string, string> }) {
      transportInstances.push(opts);
    }
  }
  return { StdioClientTransport: MockStdioClientTransport };
});

import { McpToolExecutor, McpServerConfig } from './mcp-tool-executor.js';

beforeEach(() => {
  mockConnect.mockReset();
  mockCallTool.mockReset();
  mockClose.mockReset();
  transportInstances.length = 0;
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
      });
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
});
