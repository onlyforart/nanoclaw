import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { RegisteredGroup } from './types.js';

// We'll test the IPC message processing logic for cross_channel_message.
// The startIpcWatcher function reads files from disk and processes them,
// so we create real files in a temp directory to test end-to-end.

// Import startIpcWatcher and the deps interface
import {
  IpcDeps,
  startIpcWatcher,
  _resetIpcWatcherForTests,
  _resetIpcWatcherGuardForTests,
} from './ipc.js';
import { _initTestDatabase, createTask, publishEvent } from './db.js';

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
      undefined,
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

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'From main',
      undefined,
    );
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
      undefined,
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

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Unrestricted',
      undefined,
    );
  });

  it('allows cross_channel_message when no sourceTaskId is present (backwards-compatible)', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'No task ID',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'No task ID',
      undefined,
    );
  });

  // --- idempotency ---

  it('deduplicates cross_channel_message with same idempotency_key', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'First send',
      idempotencyKey: 'idem-1',
    });

    await runOnce();

    _resetIpcWatcherGuardForTests();

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Duplicate send',
      idempotencyKey: 'idem-1',
    });

    await runOnce();

    // Should only have been called once (first send)
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'First send',
      undefined,
    );
  });

  it('allows different idempotency_keys for same target', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Message A',
      idempotencyKey: 'key-a',
    });

    await runOnce();

    _resetIpcWatcherGuardForTests();

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Message B',
      idempotencyKey: 'key-b',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  // --- .result file confirmation ---

  it('writes .result file after cross-channel delivery', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Confirm delivery',
    });

    await runOnce();

    // The message .json is deleted, and a .result should exist
    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const resultFiles = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.result'));
    expect(resultFiles).toHaveLength(1);

    const result = JSON.parse(
      fs.readFileSync(path.join(messagesDir, resultFiles[0]), 'utf-8'),
    );
    expect(result.success).toBe(true);
  });

  // --- outbound retry ---

  it('retries cross_channel_message on transient send failure', async () => {
    let calls = 0;
    deps.sendMessage = vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('transient 429');
    });

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Retry me',
    });

    // sendWithRetry uses setTimeout for backoff — advance enough to cover retries
    vi.useFakeTimers();
    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(deps.sendMessage).toHaveBeenCalledTimes(2);
    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const resultFiles = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.result'));
    expect(resultFiles).toHaveLength(1);
    const result = JSON.parse(
      fs.readFileSync(path.join(messagesDir, resultFiles[0]), 'utf-8'),
    );
    expect(result.success).toBe(true);
  });

  it('returns failure after all retries exhausted', async () => {
    deps.sendMessage = vi.fn(async () => {
      throw new Error('permanent failure');
    });

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Will fail',
    });

    // sendWithRetry retries 3x with backoff (1s + 2s) — advance enough
    vi.useFakeTimers();
    startIpcWatcher(deps);
    await vi.advanceTimersByTimeAsync(10000);
    vi.useRealTimers();

    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const resultFiles = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.result'));
    expect(resultFiles).toHaveLength(1);
    const result = JSON.parse(
      fs.readFileSync(path.join(messagesDir, resultFiles[0]), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('permanent failure');
  });

  // --- pipeline auto-routing ---

  it('auto-routes pipeline reply to source channel thread via contextEventId', async () => {
    // Create an event with known context — container passes its ID
    const { id: eventId } = publishEvent(
      'candidate.escalation',
      'slack_main',
      'pipeline:monitor',
      JSON.stringify({
        source_channel: 'slack:CSUPPORT',
        source_message_id: 'ts-999.111',
        cluster_summary: 'Widget not loading',
      }),
    );

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CDEV',
      text: 'Investigation complete',
      sourceTaskId: 'pipeline:solver',
      contextEventId: eventId,
    });

    await runOnce();

    // Primary: sent to source channel, threaded
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Investigation complete',
      { threadTs: 'ts-999.111' },
    );
    // Secondary: also sent to model's target with context header
    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CDEV',
      expect.stringContaining('Investigated report in #support-channel'),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('sends only once when pipeline model targets the source channel', async () => {
    const { id: eventId } = publishEvent(
      'candidate.escalation',
      'slack_main',
      'pipeline:monitor',
      JSON.stringify({
        source_channel: 'slack:CSUPPORT',
        source_message_id: 'ts-123.456',
        cluster_summary: 'System down',
      }),
    );

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'All clear',
      sourceTaskId: 'pipeline:solver',
      contextEventId: eventId,
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith('slack:CSUPPORT', 'All clear', {
      threadTs: 'ts-123.456',
    });
  });

  it('returns error when pipeline task sends without consuming first', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'No context',
      sourceTaskId: 'pipeline:solver',
    });

    await runOnce();

    // Pipeline send without contextEventId is rejected — model must consume first
    expect(sendMessage).not.toHaveBeenCalled();
    const messagesDir = path.join(
      tmpDir,
      'ipc',
      'slack_monitoring-channel',
      'messages',
    );
    const resultFiles = fs
      .readdirSync(messagesDir)
      .filter((f) => f.endsWith('.result'));
    expect(resultFiles).toHaveLength(1);
    const result = JSON.parse(
      fs.readFileSync(path.join(messagesDir, resultFiles[0]), 'utf-8'),
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('consume events before sending');
  });

  it('does not auto-route for non-pipeline tasks', async () => {
    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Regular send',
    });

    await runOnce();

    expect(sendMessage).toHaveBeenCalledWith(
      'slack:CSUPPORT',
      'Regular send',
      undefined,
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated pipeline sends to same source channel', async () => {
    const { id: eventId } = publishEvent(
      'candidate.escalation',
      'slack_main',
      'pipeline:monitor',
      JSON.stringify({
        source_channel: 'slack:CSUPPORT',
        source_message_id: 'ts-dedup',
      }),
    );

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'First attempt',
      sourceTaskId: 'pipeline:solver',
      contextEventId: eventId,
    });

    await runOnce();

    _resetIpcWatcherGuardForTests();

    writeMessage('slack_monitoring-channel', {
      type: 'cross_channel_message',
      targetChatJid: 'slack:CSUPPORT',
      text: 'Retry attempt',
      sourceTaskId: 'pipeline:solver',
      contextEventId: eventId,
    });

    await runOnce();

    // Only sent once — second was deduplicated
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
