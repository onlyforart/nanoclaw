import { describe, it, expect } from 'vitest';
import {
  McpInvokerError,
  parseToolResult,
  toolIsAllowed,
} from './host-mcp-invoker.js';

describe('toolIsAllowed', () => {
  it('returns true for a tool in a flat array', () => {
    expect(toolIsAllowed({ tools: ['check_status'] }, 'check_status')).toBe(
      true,
    );
  });

  it('returns false for an unlisted tool in a flat array', () => {
    expect(toolIsAllowed({ tools: ['check_status'] }, 'restart_service')).toBe(
      false,
    );
  });

  it('returns true for a tool in any access-level bucket', () => {
    expect(
      toolIsAllowed(
        { tools: { read: ['list_pods'], write: ['restart_service'] } },
        'restart_service',
      ),
    ).toBe(true);
    expect(
      toolIsAllowed(
        { tools: { read: ['list_pods'], write: ['restart_service'] } },
        'list_pods',
      ),
    ).toBe(true);
  });

  it('returns false for an unlisted tool across buckets', () => {
    expect(
      toolIsAllowed(
        { tools: { read: ['list_pods'], write: ['restart_service'] } },
        'send_message',
      ),
    ).toBe(false);
  });
});

describe('parseToolResult', () => {
  it('parses a valid text content part as JSON', () => {
    const result = {
      content: [{ type: 'text', text: '{"overall_status":"healthy"}' }],
    };
    expect(parseToolResult(result)).toEqual({ overall_status: 'healthy' });
  });

  it('throws McpInvokerError when isError=true', () => {
    const result = {
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    };
    expect(() => parseToolResult(result)).toThrow(McpInvokerError);
    try {
      parseToolResult(result);
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('tool-error');
    }
  });

  it('throws on missing content array', () => {
    expect(() => parseToolResult({})).toThrow(McpInvokerError);
    try {
      parseToolResult({});
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
    }
  });

  it('throws when first content part is not text', () => {
    expect(() =>
      parseToolResult({
        content: [{ type: 'image', data: 'xxx' }],
      }),
    ).toThrow(McpInvokerError);
  });

  it('throws when text content is not JSON', () => {
    expect(() =>
      parseToolResult({
        content: [{ type: 'text', text: 'not json at all' }],
      }),
    ).toThrow(McpInvokerError);
    try {
      parseToolResult({
        content: [{ type: 'text', text: 'not json' }],
      });
    } catch (err) {
      expect((err as McpInvokerError).kind).toBe('malformed-response');
    }
  });
});
