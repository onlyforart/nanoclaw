import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { initDb, closeDb } from '../db.js';
import { handleGetGroups, handleGetGroup, handlePatchGroup } from './groups.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webui-groups-test-'));
  const dbPath = path.join(tmpDir, 'messages.db');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL, added_at TEXT NOT NULL,
      container_config TEXT, requires_trigger INTEGER DEFAULT 1,
      is_main INTEGER DEFAULT 0, model TEXT DEFAULT NULL,
      temperature REAL DEFAULT NULL,
      max_tool_rounds INTEGER DEFAULT NULL, timeout_ms INTEGER DEFAULT NULL
    );
  `);
  db.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, NULL, 1, 1, NULL, NULL, NULL, NULL)`).run(
    'main@s.whatsapp.net', 'Main Chat', 'whatsapp_main', '@Andy', '2024-01-01T00:00:00.000Z',
  );
  db.prepare(`INSERT INTO registered_groups VALUES (?, ?, ?, ?, ?, NULL, 1, 0, ?, NULL, ?, ?)`).run(
    'family@g.us', 'Family Chat', 'whatsapp_family', '@Andy', '2024-01-02T00:00:00.000Z', 'ollama:qwen3', 10, 300000,
  );
  db.close();
  initDb(dbPath);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('handleGetGroups', () => {
  it('returns all groups in camelCase format', () => {
    const result = handleGetGroups();
    expect(result).toHaveLength(2);
    const family = result.find((g: any) => g.folder === 'whatsapp_family')!;
    expect(family.jid).toBe('family@g.us');
    expect(family.name).toBe('Family Chat');
    expect(family.model).toBe('ollama:qwen3');
    expect(family.maxToolRounds).toBe(10);
    expect(family.timeoutMs).toBe(300000);
    expect(family.isMain).toBe(false);
    expect(family.requiresTrigger).toBe(true);
    expect(family.trigger).toBe('@Andy');
    // snake_case fields should not be present
    expect((family as any).max_tool_rounds).toBeUndefined();
    expect((family as any).timeout_ms).toBeUndefined();
    expect((family as any).trigger_pattern).toBeUndefined();
    expect((family as any).is_main).toBeUndefined();
    expect((family as any).requires_trigger).toBeUndefined();
  });
});

describe('handleGetGroup', () => {
  it('returns a single group in camelCase', () => {
    const result = handleGetGroup('whatsapp_main');
    expect(result).not.toBeNull();
    expect(result!.isMain).toBe(true);
    expect(result!.folder).toBe('whatsapp_main');
  });

  it('returns null for invalid folder name', () => {
    expect(handleGetGroup('../../etc')).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handleGetGroup('nonexistent')).toBeNull();
  });
});

describe('handlePatchGroup', () => {
  it('updates model and returns updated group', () => {
    const result = handlePatchGroup('whatsapp_family', { model: 'haiku' });
    expect(result).not.toBeNull();
    expect(result!.model).toBe('haiku');
    // Other fields unchanged
    expect(result!.maxToolRounds).toBe(10);
  });

  it('updates maxToolRounds and timeoutMs', () => {
    const result = handlePatchGroup('whatsapp_family', {
      maxToolRounds: 20,
      timeoutMs: 600000,
    });
    expect(result).not.toBeNull();
    expect(result!.maxToolRounds).toBe(20);
    expect(result!.timeoutMs).toBe(600000);
  });

  it('returns null for invalid folder', () => {
    expect(handlePatchGroup('../bad', { model: 'haiku' })).toBeNull();
  });

  it('returns null for non-existent folder', () => {
    expect(handlePatchGroup('nonexistent', { model: 'haiku' })).toBeNull();
  });
});
