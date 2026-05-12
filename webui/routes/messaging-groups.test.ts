import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDb, closeDb } from '../db.js';
import { createV2Schema, seedAgentGroupWiring } from '../test-helpers.js';
import { handleGetMessagingGroups, handleGetMessagingGroup } from './messaging-groups.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-mg-routes-test-'));
  const dbPath = path.join(tmpDir, 'v2.db');

  const db = new Database(dbPath);
  createV2Schema(db);
  seedAgentGroupWiring(db, {
    agentGroupId: 'ag-main',
    folder: 'whatsapp_main',
    name: 'Main Chat',
    channelType: 'whatsapp',
    platformId: 'main@s.whatsapp.net',
    messagingGroupId: 'mg-shared',
    wiringId: 'wire-main',
    engagePattern: '@Andy',
    isMain: 1,
  });
  // Wire a second agent_group into the SAME messaging_group (reverse-list
  // covers the multi-agent case).
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('ag-shadow', 'Shadow', 'whatsapp_shadow', 'ollama', '2024-01-02T00:00:00.000Z');
  db.prepare(
    `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, session_mode, priority, created_at,
        engage_mode, engage_pattern, sender_scope, ignored_message_policy, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'wire-shadow', 'mg-shared', 'ag-shadow', 'shared', 0, '2024-01-02T00:00:00.000Z',
    'mention', null, 'all', 'drop', 1,
  );
  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetMessagingGroups', () => {
  it('returns every messaging_group with camelCase shape', () => {
    const result = handleGetMessagingGroups();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mg-shared');
    expect(result[0].channelType).toBe('whatsapp');
    expect(result[0].platformId).toBe('main@s.whatsapp.net');
    expect(result[0].isGroup).toBe(true);
    // snake_case must not leak
    expect((result[0] as { platform_id?: unknown }).platform_id).toBeUndefined();
    expect((result[0] as { channel_type?: unknown }).channel_type).toBeUndefined();
  });
});

describe('handleGetMessagingGroup', () => {
  it('returns detail with reverse-wired agent groups', () => {
    const result = handleGetMessagingGroup('mg-shared');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('mg-shared');
    expect(result!.platformId).toBe('main@s.whatsapp.net');
    expect(result!.wiredAgentGroups).toHaveLength(2);
    const folders = result!.wiredAgentGroups.map((a) => a.folder).sort();
    expect(folders).toEqual(['whatsapp_main', 'whatsapp_shadow']);
  });

  it('returns null for non-existent id', () => {
    expect(handleGetMessagingGroup('nope')).toBeNull();
  });
});
