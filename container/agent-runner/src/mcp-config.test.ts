import { describe, it, expect } from 'vitest';
import { buildSdkMcpServers } from './mcp-config.js';

describe('buildSdkMcpServers', () => {
  const bridgePath = '/tmp/dist/mcp-http-bridge.js';

  it('rewrites HTTP entry to stdio bridge command', () => {
    const config = {
      'eks-kubectl': {
        type: 'http' as const,
        url: 'http://172.17.0.1:3201/mcp',
        tools: ['list_pods', 'get_container_logs'],
      },
    };

    const { mcpServers, mcpTools } = buildSdkMcpServers(config, bridgePath);

    expect(mcpServers['eks-kubectl']).toEqual({
      command: 'node',
      args: [bridgePath, '--url', 'http://172.17.0.1:3201/mcp'],
    });
    expect(mcpTools).toEqual([
      'mcp__eks-kubectl__list_pods',
      'mcp__eks-kubectl__get_container_logs',
    ]);
  });

  it('passes headers as --header args', () => {
    const config = {
      'eks-kubectl': {
        type: 'http' as const,
        url: 'http://172.17.0.1:3201/mcp',
        headers: {
          'X-NanoClaw-Group': 'slack_main',
          'Authorization': 'Bearer token',
        },
        tools: ['list_pods'],
      },
    };

    const { mcpServers } = buildSdkMcpServers(config, bridgePath);

    expect(mcpServers['eks-kubectl']).toEqual({
      command: 'node',
      args: [
        bridgePath,
        '--url', 'http://172.17.0.1:3201/mcp',
        '--header', 'X-NanoClaw-Group:slack_main',
        '--header', 'Authorization:Bearer token',
      ],
    });
  });

  it('leaves stdio entries unchanged', () => {
    const config = {
      'lmax-venues': {
        command: 'node',
        args: ['/workspace/mcp-servers/lmax-venues/build/index.js'],
        tools: ['check_venue_status'],
        env: { SOME_VAR: 'value' },
      },
    };

    const { mcpServers, mcpTools } = buildSdkMcpServers(config, bridgePath);

    expect(mcpServers['lmax-venues']).toEqual({
      command: 'node',
      args: ['/workspace/mcp-servers/lmax-venues/build/index.js'],
      env: { SOME_VAR: 'value' },
    });
    expect(mcpTools).toEqual(['mcp__lmax-venues__check_venue_status']);
  });

  it('handles mixed HTTP and stdio config', () => {
    const config = {
      'lmax-venues': {
        command: 'node',
        args: ['/workspace/mcp-servers/lmax-venues/build/index.js'],
        tools: ['check_venue_status'],
      },
      'eks-kubectl': {
        type: 'http' as const,
        url: 'http://172.17.0.1:3201/mcp',
        tools: ['list_pods'],
      },
    };

    const { mcpServers, mcpTools } = buildSdkMcpServers(config, bridgePath);

    // Stdio entry preserved
    expect(mcpServers['lmax-venues']).toHaveProperty('command', 'node');
    expect(mcpServers['lmax-venues']).not.toHaveProperty('type');

    // HTTP entry rewritten to bridge
    expect(mcpServers['eks-kubectl']).toHaveProperty('command', 'node');
    expect((mcpServers['eks-kubectl'] as { args: string[] }).args[0]).toBe(bridgePath);
    expect(mcpServers['eks-kubectl']).not.toHaveProperty('type');

    // Both contribute tools
    expect(mcpTools).toEqual([
      'mcp__lmax-venues__check_venue_status',
      'mcp__eks-kubectl__list_pods',
    ]);
  });

  it('skips entries with no command and no url', () => {
    const config = {
      broken: {
        tools: ['something'],
      },
    };

    const { mcpServers, mcpTools } = buildSdkMcpServers(config, bridgePath);

    expect(Object.keys(mcpServers)).toHaveLength(0);
    expect(mcpTools).toHaveLength(0);
  });

  it('tool allowlist is identical for HTTP and stdio entries', () => {
    const httpConfig = {
      server: {
        type: 'http' as const,
        url: 'http://localhost:3201/mcp',
        tools: ['tool_a', 'tool_b'],
      },
    };

    const stdioConfig = {
      server: {
        command: 'node',
        args: ['server.js'],
        tools: ['tool_a', 'tool_b'],
      },
    };

    const httpResult = buildSdkMcpServers(httpConfig, bridgePath);
    const stdioResult = buildSdkMcpServers(stdioConfig, bridgePath);

    expect(httpResult.mcpTools).toEqual(stdioResult.mcpTools);
  });

  it('HTTP entry without headers produces no --header args', () => {
    const config = {
      server: {
        type: 'http' as const,
        url: 'http://localhost:3201/mcp',
        tools: ['tool_a'],
      },
    };

    const { mcpServers } = buildSdkMcpServers(config, bridgePath);
    const args = (mcpServers['server'] as { args: string[] }).args;

    expect(args).toEqual([bridgePath, '--url', 'http://localhost:3201/mcp']);
    expect(args).not.toContain('--header');
  });
});
