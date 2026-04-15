import { describe, it, expect, beforeEach, vi } from 'vitest';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import type { PipelinePlugin } from './pipeline-plugin.js';
import { RegisteredGroup } from './types.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

let groups: Record<string, RegisteredGroup>;

function makeDeps(plugin?: PipelinePlugin | null): IpcDeps {
  return {
    sendMessage: async () => {},
    registeredGroups: () => groups,
    registerGroup: () => {},
    updateGroup: () => {},
    syncGroups: async () => {},
    refreshAllGroupSnapshots: () => {},
    refreshAllTaskSnapshots: () => {},
    plugin: plugin ?? undefined,
  };
}

beforeEach(() => {
  _initTestDatabase();
  groups = { 'slack:CMAIN': MAIN_GROUP };
  setRegisteredGroup('slack:CMAIN', MAIN_GROUP);
});

describe('handleIpcTask plugin hook', () => {
  it('returns unknown type error when no plugin is installed', async () => {
    const result = await processTaskIpc(
      { type: 'some_plugin_type', data: 'test' },
      'slack_main',
      true,
      makeDeps(null),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown IPC task type');
  });

  it('delegates unknown IPC types to plugin.handleIpcTask', async () => {
    const plugin: PipelinePlugin = {
      name: 'test-plugin',
      handleIpcTask: vi.fn().mockResolvedValue({
        success: true,
        customField: 'hello',
      }),
    };

    const result = await processTaskIpc(
      { type: 'custom_plugin_type', foo: 'bar' },
      'slack_main',
      true,
      makeDeps(plugin),
    );

    expect(result.success).toBe(true);
    expect((result as any).customField).toBe('hello');
    expect(plugin.handleIpcTask).toHaveBeenCalledWith(
      'custom_plugin_type',
      expect.objectContaining({ type: 'custom_plugin_type', foo: 'bar' }),
      'slack_main',
      true,
      expect.any(Object),
    );
  });

  it('falls through to unknown type when plugin returns null', async () => {
    const plugin: PipelinePlugin = {
      name: 'test-plugin',
      handleIpcTask: vi.fn().mockResolvedValue(null),
    };

    const result = await processTaskIpc(
      { type: 'unhandled_type' },
      'slack_main',
      true,
      makeDeps(plugin),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown IPC task type');
  });

  it('does not delegate built-in IPC types to plugin', async () => {
    const plugin: PipelinePlugin = {
      name: 'test-plugin',
      handleIpcTask: vi.fn().mockResolvedValue({ success: true }),
    };

    // publish_event is a built-in type — should be handled by core, not plugin
    const result = await processTaskIpc(
      {
        type: 'publish_event',
        eventType: 'test.event',
        payload: '{"x":1}',
      },
      'slack_main',
      true,
      makeDeps(plugin),
    );

    expect(result.success).toBe(true);
    expect(plugin.handleIpcTask).not.toHaveBeenCalled();
  });
});
