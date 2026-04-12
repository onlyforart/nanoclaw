import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { RegisteredGroup } from './types.js';

// We'll test the IPC message processing logic for cross_channel_message.
// The startIpcWatcher function reads files from disk and processes them,
// so we create real files in a temp directory to test end-to-end.

// Import startIpcWatcher and the deps interface
import { IpcDeps, startIpcWatcher, _resetIpcWatcherForTests } from './ipc.js';
import { _initTestDatabase, createTask } from './db.js';

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'slack_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const DEV_GROUP: RegisteredGroup = {
  name: 'monitoring-channel',
  folder: 'slack_monitoring-channel',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

const SUPPORT_GROUP: RegisteredGroup = {
  name: 'support-channel',
  folder: 'slack_support-channel',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

// Unregistered group — bot is not in this group
const UNREGISTERED_JID = 'slack:CUNREGISTERED';

let groups: Record<string, RegisteredGroup>;
let sendMessage: IpcDeps['sendMessage'];
let tmpDir: string;

beforeEach(() => {
  _initTestDatabase();
  _resetIpcWatcherForTests();

  groups = {
    'slack:CMAIN': MAIN_GROUP,
    'slack:CDEV': DEV_GROUP,
    'slack:CSUPPORT': SUPPORT_GROUP,
  };

  sendMessage = vi.fn(async (_jid: string, _text: string) => {});

  // Create a temp IPC directory structure
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-cross-channel-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeIpcMessage(
  sourceFolder: string,
  data: Record<string, unknown>,
): void {
  const messagesDir = path.join(tmpDir, sourceFolder, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(path.join(messagesDir, filename), JSON.stringify(data));
}

// Since startIpcWatcher uses DATA_DIR from config, we need to test
// the message processing logic more directly. Let's test via processTaskIpc
// for the task-based IPC, but for messages we need to test the inline logic.
// The cleanest approach: extract the message authorization logic and test it,
// or test through the file-based watcher with a mocked DATA_DIR.

// We'll mock the config module to point DATA_DIR at our temp directory.
vi.mock('./config.js', async () => {
  const actual =
    await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return tmpDir;
    },
    IPC_POLL_INTERVAL: 999999, // Don't auto-poll; we'll trigger manually
  };
});

// We also need to stop the watcher from looping. We'll use fake timers.
// Actually, startIpcWatcher uses setTimeout for re-polling, so we control it.

describe('cross_channel_message IPC', () => {
  let deps: IpcDeps;

  beforeEach(() => {
    deps = {
      sendMessage,
      registeredGroups: () => groups,
      registerGroup: () => {},
      updateGroup: () => {},
      syncGroups: async () => {},
      refreshAllGroupSnapshots: () => {},
      refreshAllTaskSnapshots: () => {},
    };

    // Create IPC directory structure under tmpDir (which is now DATA_DIR)
    const ipcDir = path.join(tmpDir, 'ipc');
    fs.mkdirSync(ipcDir, { recursive: true });
  });

  function writeMessage(
    sourceFolder: string,
    data: Record<string, unknown>,
  ): void {
    const messagesDir = path.join(tmpDir, 'ipc', sourceFolder, 'messages');
    fs.mkdirSync(messagesDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    fs.writeFileSync(path.join(messagesDir, filename), JSON.stringify(data));
  }

  async function runOnce(): Promise<void> {
    // startIpcWatcher runs processIpcFiles once then schedules setTimeout.
    // We need to let it run once. Use fake timers.
    vi.useFakeTimers();
    startIpcWatcher(deps);
    // Let the async processIpcFiles complete
    await vi.advanceTimersByTimeAsync(10);
    vi.useRealTimers();
  }

  it('delivers cross_channel_message from any group to a registered target', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Alert: something happened',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Alert: something happened',
    );
  });

  it('blocks cross_channel_message to an unregistered group', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: UNREGISTERED_JID,
      text: 'Should be blocked',
    });

    await runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('blocks cross_channel_message with missing targetChatJid', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      text: 'No target',
    });

    await runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('blocks cross_channel_message with missing text', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
    });

    await runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('delivers cross_channel_message from main group', async () => {
    writeMessage('slack_main', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'From main',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith('slack:CSUPPORT', 'From main');
  });

  it('cleans up the IPC file after processing', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Cleanup test',
    });

    await runOnce();

    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const remaining = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  it('cleans up IPC file even when blocked', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: UNREGISTERED_JID,
      text: 'Blocked but cleaned',
    });

    await runOnce();

    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const remaining = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.json'));
    expect(remaining).toHaveLength(0);
  });

  // --- allowed_send_targets enforcement ---

  it('blocks cross_channel_message when task has restricted send targets and target is not in list', async () => {
    createTask({
      id: 'restricted-task',
      group_folder: 'slack_monitoring-channel',
      chat_jid: 'slack:CDEV',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      allowedSendTargets: ['slack:CMAIN'],
    });

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Should be blocked by allowed_send_targets',
      sourceTaskId: 'restricted-task',
    });

    await runOnce();

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('allows cross_channel_message when target is in allowed_send_targets', async () => {
    createTask({
      id: 'allowed-task',
      group_folder: 'slack_monitoring-channel',
      chat_jid: 'slack:CDEV',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      allowedSendTargets: ['slack:CSUPPORT'],
    });

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Should be allowed',
      sourceTaskId: 'allowed-task',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Should be allowed',
    );
  });

  it('allows cross_channel_message when task has no send target restrictions (null)', async () => {
    createTask({
      id: 'unrestricted-task',
      group_folder: 'slack_monitoring-channel',
      chat_jid: 'slack:CDEV',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Unrestricted',
      sourceTaskId: 'unrestricted-task',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith('slack:CSUPPORT', 'Unrestricted');
  });

  it('allows cross_channel_message when no sourceTaskId is present (backwards-compatible)', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'No task ID',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith('slack:CSUPPORT', 'No task ID');
  });
});
