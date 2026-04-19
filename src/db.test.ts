import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  ackEvent,
  consumeEvents,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getDueTasks,
  getMessagesSince,
  getNewMessages,
  getRecentEvents,
  getRegisteredGroup,
  getTaskById,
  readChatMessages,
  publishEvent,
  releaseClaimsByTaskId,
  releaseEvent,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateRegisteredGroup,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- LIMIT behavior ---

describe('message query LIMIT', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    for (let i = 1; i <= 10; i++) {
      store({
        id: `lim-${i}`,
        chat_jid: 'group@g.us',
        sender: 'user@s.whatsapp.net',
        sender_name: 'User',
        content: `message ${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      });
    }
  });

  it('getNewMessages caps to limit and returns most recent in chronological order', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    // Chronological order preserved
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
    // newTimestamp reflects latest returned row
    expect(newTimestamp).toBe('2024-01-01T00:00:10.000Z');
  });

  it('getMessagesSince caps to limit and returns most recent in chronological order', () => {
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
      3,
    );
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe('message 8');
    expect(messages[2].content).toBe('message 10');
    expect(messages[1].timestamp > messages[0].timestamp).toBe(true);
  });

  it('returns all messages when count is under the limit', () => {
    const { messages } = getNewMessages(
      ['group@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
      50,
    );
    expect(messages).toHaveLength(10);
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

// --- Per-group/task configurable limits (maxToolRounds, timeoutMs) ---

describe('registered group maxToolRounds and timeoutMs', () => {
  it('stores and retrieves maxToolRounds and timeoutMs', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      maxToolRounds: 5,
      timeoutMs: 60_000,
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group).toBeDefined();
    expect(group!.maxToolRounds).toBe(5);
    expect(group!.timeoutMs).toBe(60_000);
  });

  it('returns undefined for NULL maxToolRounds and timeoutMs', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group).toBeDefined();
    expect(group!.maxToolRounds).toBeUndefined();
    expect(group!.timeoutMs).toBeUndefined();
  });

  it('round-trips through getAllRegisteredGroups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      maxToolRounds: 10,
      timeoutMs: 120_000,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group.maxToolRounds).toBe(10);
    expect(group.timeoutMs).toBe(120_000);
  });

  it('updates maxToolRounds and timeoutMs via updateRegisteredGroup', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test Group',
      folder: 'whatsapp_test',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    updateRegisteredGroup('group@g.us', {
      maxToolRounds: 15,
      timeoutMs: 90_000,
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group!.maxToolRounds).toBe(15);
    expect(group!.timeoutMs).toBe(90_000);
  });
});

describe('task maxToolRounds and timeoutMs', () => {
  it('stores and retrieves maxToolRounds and timeoutMs on tasks', () => {
    createTask({
      id: 'task-limits-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test limits',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      maxToolRounds: 20,
      timeoutMs: 600_000,
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-limits-1');
    expect(task).toBeDefined();
    expect(task!.maxToolRounds).toBe(20);
    expect(task!.timeoutMs).toBe(600_000);
  });

  it('defaults maxToolRounds and timeoutMs to null', () => {
    createTask({
      id: 'task-limits-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'no limits',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-limits-2');
    expect(task).toBeDefined();
    expect(task!.maxToolRounds).toBeNull();
    expect(task!.timeoutMs).toBeNull();
  });

  it('updates maxToolRounds and timeoutMs via updateTask', () => {
    createTask({
      id: 'task-limits-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'update me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-limits-3', { maxToolRounds: 8, timeoutMs: 120_000 });

    const task = getTaskById('task-limits-3');
    expect(task!.maxToolRounds).toBe(8);
    expect(task!.timeoutMs).toBe(120_000);
  });
});

// --- Events table ---

describe('publishEvent', () => {
  it('inserts a new event and returns its id', () => {
    const result = publishEvent(
      'observation.support',
      'slack_main',
      null,
      JSON.stringify({ summary: 'test' }),
    );
    expect(result.id).toBeGreaterThan(0);
    expect(result.isNew).toBe(true);
  });

  it('deduplicates on (type, dedupe_key)', () => {
    const first = publishEvent(
      'observation.support',
      'slack_main',
      null,
      JSON.stringify({ summary: 'first' }),
      'dedup-1',
    );
    const second = publishEvent(
      'observation.support',
      'slack_main',
      null,
      JSON.stringify({ summary: 'second' }),
      'dedup-1',
    );
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('allows same dedupe_key for different types', () => {
    const a = publishEvent('type.a', 'g', null, '{}', 'key');
    const b = publishEvent('type.b', 'g', null, '{}', 'key');
    expect(a.id).not.toBe(b.id);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  it('sets expires_at when ttlSeconds is provided', () => {
    const result = publishEvent('test.ttl', 'g', null, '{}', null, 3600);
    const events = getRecentEvents(['test.ttl'], 10, true);
    expect(events).toHaveLength(1);
    expect(events[0].expires_at).not.toBeNull();
  });

  it('stores source_task_id when provided', () => {
    publishEvent('test.task', 'g', 'pipeline:sanitiser', '{}');
    const events = getRecentEvents(['test.task'], 10, true);
    expect(events[0].source_task_id).toBe('pipeline:sanitiser');
  });
});

describe('consumeEvents', () => {
  it('atomically claims pending events', () => {
    publishEvent('obs.a', 'g', null, '{"n":1}');
    publishEvent('obs.a', 'g', null, '{"n":2}');
    publishEvent('obs.b', 'g', null, '{"n":3}');

    const claimed = consumeEvents(['obs.a'], 'pipeline:monitor', 10);
    expect(claimed).toHaveLength(2);
    expect(claimed[0].status).toBe('claimed');
    expect(claimed[0].claimed_by).toBe('pipeline:monitor');
  });

  it('does not return already-claimed events', () => {
    publishEvent('obs.x', 'g', null, '{}');
    const first = consumeEvents(['obs.x'], 'consumer-1', 10);
    const second = consumeEvents(['obs.x'], 'consumer-2', 10);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      publishEvent('obs.lim', 'g', null, `{"i":${i}}`);
    }
    const claimed = consumeEvents(['obs.lim'], 'c', 2);
    expect(claimed).toHaveLength(2);
  });

  it('skips expired events', () => {
    // Publish with TTL of 0 seconds (already expired)
    publishEvent('obs.exp', 'g', null, '{}', null, -1);
    const claimed = consumeEvents(['obs.exp'], 'c', 10);
    expect(claimed).toHaveLength(0);
  });

  it('claims events matching multiple types', () => {
    publishEvent('obs.a', 'g', null, '{}');
    publishEvent('obs.b', 'g', null, '{}');
    publishEvent('obs.c', 'g', null, '{}');

    const claimed = consumeEvents(['obs.a', 'obs.b'], 'c', 10);
    expect(claimed).toHaveLength(2);
  });
});

describe('ackEvent', () => {
  it('transitions a claimed event to done', () => {
    publishEvent('ack.test', 'g', null, '{}');
    const [event] = consumeEvents(['ack.test'], 'c', 1);

    ackEvent(event.id, 'done', 'processed successfully');
    const events = getRecentEvents(['ack.test'], 10, true);
    expect(events[0].status).toBe('done');
    expect(events[0].result_note).toBe('processed successfully');
    expect(events[0].processed_at).not.toBeNull();
  });

  it('transitions a claimed event to failed', () => {
    publishEvent('ack.fail', 'g', null, '{}');
    const [event] = consumeEvents(['ack.fail'], 'c', 1);

    ackEvent(event.id, 'failed', 'LLM returned invalid JSON');
    const events = getRecentEvents(['ack.fail'], 10, true);
    expect(events[0].status).toBe('failed');
  });
});

describe('releaseEvent', () => {
  it('releases a claimed event back to pending so another consumer can claim it', () => {
    publishEvent('rel.test', 'g', null, '{"n":1}');
    const [event] = consumeEvents(['rel.test'], 'first', 1);
    expect(event.status).toBe('claimed');
    expect(event.claimed_by).toBe('first');

    const released = releaseEvent(event.id, 'first');
    expect(released).toBe(true);

    const [reclaimed] = consumeEvents(['rel.test'], 'second', 1);
    expect(reclaimed).toBeDefined();
    expect(reclaimed.id).toBe(event.id);
    expect(reclaimed.claimed_by).toBe('second');
  });

  it('refuses to release an event claimed by someone else', () => {
    publishEvent('rel.other', 'g', null, '{}');
    const [event] = consumeEvents(['rel.other'], 'first', 1);
    const released = releaseEvent(event.id, 'different-consumer');
    expect(released).toBe(false);

    // still claimed by 'first'
    const rows = getRecentEvents(['rel.other'], 10, true);
    expect(rows[0].claimed_by).toBe('first');
    expect(rows[0].status).toBe('claimed');
  });

  it('refuses to release an already-acked event', () => {
    publishEvent('rel.acked', 'g', null, '{}');
    const [event] = consumeEvents(['rel.acked'], 'c', 1);
    ackEvent(event.id, 'done');

    const released = releaseEvent(event.id, 'c');
    expect(released).toBe(false);

    const rows = getRecentEvents(['rel.acked'], 10, true);
    expect(rows[0].status).toBe('done');
  });

  it('is a no-op on a pending (unclaimed) event', () => {
    publishEvent('rel.pending', 'g', null, '{}');
    const rows = getRecentEvents(['rel.pending'], 10, true);
    const released = releaseEvent(rows[0].id, 'anyone');
    expect(released).toBe(false);
    const after = getRecentEvents(['rel.pending'], 10, true);
    expect(after[0].status).toBe('pending');
  });

  it('is a no-op on a non-existent event id', () => {
    const released = releaseEvent(999_999, 'c');
    expect(released).toBe(false);
  });
});

describe('F9 phase 9 — bounded retry via attempted_by_trivial', () => {
  it('release without failureReason leaves attempted_by_trivial unchanged (still 0)', () => {
    publishEvent('retry.noflag', 'g', null, '{}');
    const [event] = consumeEvents(['retry.noflag'], 'solver:foo', 1);
    releaseEvent(event.id, 'solver:foo');
    const rows = getRecentEvents(['retry.noflag'], 10, true);
    expect(rows[0].attempted_by_trivial).toBe(0);
    expect(rows[0].trivial_failure_reason).toBeNull();
  });

  it('release with failureReason sets attempted_by_trivial=1 and records reason', () => {
    publishEvent('retry.flagged', 'g', null, '{}');
    const [event] = consumeEvents(['retry.flagged'], 'trivial-answerer', 1);
    releaseEvent(event.id, 'trivial-answerer', 'tool-error:ECONNREFUSED');
    const rows = getRecentEvents(['retry.flagged'], 10, true);
    expect(rows[0].attempted_by_trivial).toBe(1);
    expect(rows[0].trivial_failure_reason).toBe('tool-error:ECONNREFUSED');
    expect(rows[0].status).toBe('pending');
  });

  it('truncates failure reasons longer than 500 chars', () => {
    publishEvent('retry.long', 'g', null, '{}');
    const [event] = consumeEvents(['retry.long'], 'trivial-answerer', 1);
    const long = 'x'.repeat(600);
    releaseEvent(event.id, 'trivial-answerer', long);
    const rows = getRecentEvents(['retry.long'], 10, true);
    expect(rows[0].trivial_failure_reason?.length).toBe(500);
  });

  it('consumeEvents with skipAttemptedByTrivial=true ignores flagged events', () => {
    publishEvent('retry.skip', 'g', null, '{"n":1}');
    publishEvent('retry.skip', 'g', null, '{"n":2}');
    const allFirst = consumeEvents(['retry.skip'], 'trivial-answerer', 10);
    expect(allFirst).toHaveLength(2);

    // Release the first with failure reason, second clean
    releaseEvent(allFirst[0].id, 'trivial-answerer', 'state-miss');
    releaseEvent(allFirst[1].id, 'trivial-answerer');

    // Next trivial tick with the filter should only see the clean one.
    const trivialSecond = consumeEvents(['retry.skip'], 'trivial-answerer', 10, {
      skipAttemptedByTrivial: true,
    });
    expect(trivialSecond).toHaveLength(1);
    expect(trivialSecond[0].id).toBe(allFirst[1].id);
  });

  it('solver consumeEvents (default) still sees flagged events', () => {
    publishEvent('retry.solver', 'g', null, '{}');
    const [event] = consumeEvents(['retry.solver'], 'trivial-answerer', 1);
    releaseEvent(event.id, 'trivial-answerer', 'tool-error:timeout');

    // Solver doesn't pass the option — should see the row.
    const claimed = consumeEvents(['retry.solver'], 'solver', 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe(event.id);
    expect(claimed[0].attempted_by_trivial).toBe(1);
  });

  it('migration is idempotent (re-running CREATE/ALTER at boot does not throw)', () => {
    // Applying the column twice should be a no-op — the ALTER ADD COLUMN
    // is wrapped in try/catch at boot. Confirm columns exist + typed.
    const rowBefore = publishEvent('retry.idem', 'g', null, '{}');
    const rows = getRecentEvents(['retry.idem'], 10, true);
    expect(rows[0].attempted_by_trivial).toBe(0);
    expect(rows[0]).toHaveProperty('trivial_failure_reason');
    expect(rowBefore.isNew).toBe(true);
  });
});

describe('getDueTasks ordering', () => {
  function make(
    id: string,
    executionMode: 'host_pipeline' | 'container',
    nextRun: string,
  ) {
    createTask({
      id,
      group_folder: 'g',
      chat_jid: 'jid',
      prompt: 'p',
      schedule_type: 'cron',
      schedule_value: '* * * * *',
      context_mode: 'isolated',
      executionMode,
      next_run: nextRun,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });
  }

  it('returns host_pipeline tasks before container tasks on tied next_run', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Insert container task first so insertion order wouldn't help it.
    make('task:solver', 'container', past);
    make('task:trivial', 'host_pipeline', past);
    make('task:monitor', 'container', past);

    const due = getDueTasks();
    expect(due.map((t) => t.id)).toEqual([
      'task:trivial', // host_pipeline beats container on tie
      'task:monitor', // then container tasks, ordered by id
      'task:solver',
    ]);
  });

  it('still orders by next_run first (earlier next_run wins)', () => {
    const older = new Date(Date.now() - 120_000).toISOString();
    const newer = new Date(Date.now() - 60_000).toISOString();
    make('task:late-host', 'host_pipeline', newer);
    make('task:early-container', 'container', older);

    const due = getDueTasks();
    expect(due[0].id).toBe('task:early-container');
    expect(due[1].id).toBe('task:late-host');
  });

  it('filters out tasks whose next_run is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    make('task:future', 'host_pipeline', future);
    make('task:due', 'container', past);

    const due = getDueTasks();
    expect(due.map((t) => t.id)).toEqual(['task:due']);
  });
});

describe('releaseClaimsByTaskId', () => {
  it('releases all events claimed by a task at or after the given timestamp', () => {
    publishEvent('claim.a', 'g', null, '{"n":1}');
    publishEvent('claim.a', 'g', null, '{"n":2}');
    publishEvent('claim.a', 'g', null, '{"n":3}');

    const before = new Date(Date.now() - 1000).toISOString();
    consumeEvents(['claim.a'], 'pipeline:solver', 10);

    const released = releaseClaimsByTaskId('pipeline:solver', before);
    expect(released).toBe(3);

    const rows = getRecentEvents(['claim.a'], 10, true);
    expect(rows.map((r) => r.status).sort()).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    expect(rows.every((r) => r.claimed_by === null)).toBe(true);
  });

  it('does not release events claimed by a different task', () => {
    publishEvent('claim.b', 'g', null, '{}');
    publishEvent('claim.b', 'g', null, '{}');
    const before = new Date(Date.now() - 1000).toISOString();

    consumeEvents(['claim.b'], 'pipeline:monitor', 1);
    consumeEvents(['claim.b'], 'pipeline:solver', 1);

    const released = releaseClaimsByTaskId('pipeline:solver', before);
    expect(released).toBe(1);

    const rows = getRecentEvents(['claim.b'], 10, true);
    const monitorRow = rows.find((r) => r.claimed_by === 'pipeline:monitor');
    const releasedRow = rows.find((r) => r.claimed_by === null);
    expect(monitorRow?.status).toBe('claimed');
    expect(releasedRow?.status).toBe('pending');
  });

  it('honours the claimedSince filter — claims older than since are preserved', () => {
    publishEvent('claim.old', 'g', null, '{}');
    consumeEvents(['claim.old'], 'pipeline:solver', 1);

    // Passing a `since` in the future means the just-claimed row is
    // "older than" `since` and must not be released. This is the
    // guard that prevents releasing claims from an earlier, completed
    // run of the same task.
    const futureSince = new Date(Date.now() + 60_000).toISOString();
    expect(releaseClaimsByTaskId('pipeline:solver', futureSince)).toBe(0);

    const rows = getRecentEvents(['claim.old'], 10, true);
    expect(rows[0].status).toBe('claimed');
  });

  it('returns 0 when there are no claimed events to release', () => {
    const released = releaseClaimsByTaskId(
      'pipeline:solver',
      new Date(0).toISOString(),
    );
    expect(released).toBe(0);
  });

  it('does not re-release already-acked events', () => {
    publishEvent('claim.acked', 'g', null, '{}');
    const before = new Date(Date.now() - 1000).toISOString();
    const [event] = consumeEvents(['claim.acked'], 'pipeline:solver', 1);
    ackEvent(event.id, 'done');

    const released = releaseClaimsByTaskId('pipeline:solver', before);
    expect(released).toBe(0);

    const rows = getRecentEvents(['claim.acked'], 10, true);
    expect(rows[0].status).toBe('done');
  });
});

describe('getRecentEvents', () => {
  it('returns events filtered by type', () => {
    publishEvent('type.a', 'g', null, '{}');
    publishEvent('type.b', 'g', null, '{}');

    const events = getRecentEvents(['type.a'], 10, true);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('type.a');
  });

  it('returns all types when types is undefined', () => {
    publishEvent('type.a', 'g', null, '{}');
    publishEvent('type.b', 'g', null, '{}');

    const events = getRecentEvents(undefined, 10, true);
    expect(events).toHaveLength(2);
  });

  it('excludes processed events by default', () => {
    publishEvent('rce.test', 'g', null, '{}');
    const [event] = consumeEvents(['rce.test'], 'c', 1);
    ackEvent(event.id, 'done');

    const pending = getRecentEvents(['rce.test'], 10, false);
    expect(pending).toHaveLength(0);

    const all = getRecentEvents(['rce.test'], 10, true);
    expect(all).toHaveLength(1);
  });
});

// --- registered group mode + threading_mode ---

describe('registered group mode', () => {
  it('defaults mode to active when not specified', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test',
      folder: 'test_group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const group = getRegisteredGroup('group@g.us');
    expect(group).toBeDefined();
    // Should not be undefined — default is 'active'
    expect(group!.mode).toBe('active');
  });

  it('persists mode=passive through set/get round-trip', () => {
    setRegisteredGroup('passive@g.us', {
      name: 'Passive Channel',
      folder: 'slack_passive',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      mode: 'passive',
    });

    const group = getRegisteredGroup('passive@g.us');
    expect(group!.mode).toBe('passive');
  });

  it('persists threadingMode through set/get round-trip', () => {
    setRegisteredGroup('threaded@g.us', {
      name: 'Threaded Channel',
      folder: 'slack_threaded',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      threadingMode: 'thread_aware',
    });

    const group = getRegisteredGroup('threaded@g.us');
    expect(group!.threadingMode).toBe('thread_aware');
  });

  it('round-trips mode through getAllRegisteredGroups', () => {
    setRegisteredGroup('passive@g.us', {
      name: 'Passive',
      folder: 'slack_passive',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      mode: 'passive',
    });

    const groups = getAllRegisteredGroups();
    expect(groups['passive@g.us'].mode).toBe('passive');
  });

  it('updates mode via updateRegisteredGroup', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test',
      folder: 'test_group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    updateRegisteredGroup('group@g.us', { mode: 'passive' });

    const group = getRegisteredGroup('group@g.us');
    expect(group!.mode).toBe('passive');
  });

  it('updates threadingMode via updateRegisteredGroup', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Test',
      folder: 'test_group',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    updateRegisteredGroup('group@g.us', { threadingMode: 'thread_aware' });

    const group = getRegisteredGroup('group@g.us');
    expect(group!.threadingMode).toBe('thread_aware');
  });
});

// --- readChatMessages ---

describe('readChatMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'r1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first message',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'r2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second message',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'r3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'r4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third message',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages in chronological order', () => {
    const { messages } = readChatMessages('group@g.us');
    expect(messages.length).toBeGreaterThanOrEqual(3);
    // Chronological: first before second
    const firstIdx = messages.findIndex((m) => m.content === 'first message');
    const secondIdx = messages.findIndex((m) => m.content === 'second message');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('excludes bot messages by default', () => {
    const { messages } = readChatMessages('group@g.us');
    const botMsgs = messages.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('includes bot messages when requested', () => {
    const { messages } = readChatMessages('group@g.us', undefined, 50, true);
    const botMsgs = messages.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(1);
  });

  it('filters by since timestamp', () => {
    const { messages } = readChatMessages(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
    );
    // Only messages after the timestamp (excludes first and second)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('third message');
  });

  it('returns a cursor pointing to the last message timestamp', () => {
    const { cursor } = readChatMessages('group@g.us');
    expect(cursor).toBe('2024-01-01T00:00:04.000Z');
  });

  it('returns empty since as cursor when no messages match', () => {
    const { messages, cursor } = readChatMessages(
      'group@g.us',
      '2099-01-01T00:00:00.000Z',
    );
    expect(messages).toHaveLength(0);
    expect(cursor).toBe('2099-01-01T00:00:00.000Z');
  });

  it('respects limit', () => {
    const { messages } = readChatMessages('group@g.us', undefined, 2);
    expect(messages).toHaveLength(2);
  });
});

// --- Task allowed_tools and allowed_send_targets ---

describe('task allowed_tools and allowed_send_targets', () => {
  it('stores and retrieves allowed_tools as a string array', () => {
    createTask({
      id: 'task-allow-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      allowedTools: ['consume_events', 'publish_event'],
    });

    const task = getTaskById('task-allow-1');
    expect(task).toBeDefined();
    expect(task!.allowedTools).toEqual(['consume_events', 'publish_event']);
  });

  it('stores and retrieves allowed_send_targets as a string array', () => {
    createTask({
      id: 'task-allow-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      allowedSendTargets: ['slack_main'],
    });

    const task = getTaskById('task-allow-2');
    expect(task!.allowedSendTargets).toEqual(['slack_main']);
  });

  it('defaults both to null when not specified', () => {
    createTask({
      id: 'task-allow-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-allow-3');
    expect(task!.allowedTools).toBeNull();
    expect(task!.allowedSendTargets).toBeNull();
  });

  it('updates allowed_tools via updateTask', () => {
    createTask({
      id: 'task-allow-4',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-allow-4', {
      allowedTools: ['send_message', 'ack_event'],
    });

    const task = getTaskById('task-allow-4');
    expect(task!.allowedTools).toEqual(['send_message', 'ack_event']);
  });

  it('updates allowed_send_targets via updateTask', () => {
    createTask({
      id: 'task-allow-5',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-allow-5', {
      allowedSendTargets: ['slack_support'],
    });

    const task = getTaskById('task-allow-5');
    expect(task!.allowedSendTargets).toEqual(['slack_support']);
  });

  it('clears allowed_tools by setting to null', () => {
    createTask({
      id: 'task-allow-6',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
      allowedTools: ['send_message'],
    });

    updateTask('task-allow-6', { allowedTools: null });

    const task = getTaskById('task-allow-6');
    expect(task!.allowedTools).toBeNull();
  });
});
