/**
 * TDD tests for Phase 5 — Q1 a-1 legacy archive (chats + messages only).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildFixtureV1Db } from './build-fixture.js';
import { createLegacyArchive } from './legacy-archive.js';

interface Ctx {
  tmpDir: string;
  v1DbPath: string;
  outputPath: string;
}

describe('legacy archive — Q1 a-1', () => {
  let ctx: Ctx;
  beforeEach(() => {
    const tmpDir = path.join(
      os.tmpdir(),
      `legacy-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    const v1DbPath = path.join(tmpDir, 'v1.db');
    const db = buildFixtureV1Db(v1DbPath);
    db.close();
    ctx = { tmpDir, v1DbPath, outputPath: path.join(tmpDir, 'legacy-v1-readonly.db') };
  });
  afterEach(() => {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  it('produces an archive containing only chats + messages', () => {
    const r = createLegacyArchive(ctx.v1DbPath, ctx.outputPath);
    expect(r.outputPath).toBe(ctx.outputPath);
    expect(r.bytesWritten).toBeGreaterThan(0);

    const archived = new Database(ctx.outputPath, { readonly: true });
    const tables = archived
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(['chats', 'messages']);

    expect(
      (archived.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number }).n,
    ).toBe(3);
    expect(
      (archived.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }).n,
    ).toBe(5);
    archived.close();
  });

  it('is much smaller than the full v1 DB (drops 12 of 14 tables)', () => {
    const r = createLegacyArchive(ctx.v1DbPath, ctx.outputPath);
    const fullSize = fs.statSync(ctx.v1DbPath).size;
    expect(r.bytesWritten).toBeLessThanOrEqual(fullSize);
  });

  it('is idempotent — re-running overwrites the output cleanly', () => {
    createLegacyArchive(ctx.v1DbPath, ctx.outputPath);
    const r = createLegacyArchive(ctx.v1DbPath, ctx.outputPath);
    expect(r.outputPath).toBe(ctx.outputPath);
    expect(r.bytesWritten).toBeGreaterThan(0);
  });

  it('preserves messages content + chat_jid linkage', () => {
    createLegacyArchive(ctx.v1DbPath, ctx.outputPath);
    const archived = new Database(ctx.outputPath, { readonly: true });
    const msg = archived
      .prepare(`SELECT content, chat_jid FROM messages WHERE id = 'm1'`)
      .get() as { content: string; chat_jid: string };
    expect(msg.content).toBe('hello');
    expect(msg.chat_jid).toBe('slack:C000ALPHA');
    archived.close();
  });

  it('archives orphan messages (chat_jid not in chats) without FK failure', () => {
    // Production v1 DBs often have orphan messages — rows whose chat_jid
    // points at a chat row that was deleted or never recorded. The archive
    // must preserve these for operator post-cutover grep, not crash.
    const orphanDbPath = path.join(ctx.tmpDir, 'orphan.db');
    const orphanOutput = path.join(ctx.tmpDir, 'orphan-archive.db');
    const orphan = buildFixtureV1Db(orphanDbPath);
    orphan.pragma('foreign_keys = OFF');
    // Insert a message referencing a non-existent chat_jid.
    orphan
      .prepare(
        `INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('m-orphan', 'slack:C999GONE', 'U999', 'Ghost', 'orphan body', '2025-12-04T00:00:00Z', 0, 0);
    orphan.close();

    const r = createLegacyArchive(orphanDbPath, orphanOutput);
    expect(r.outputPath).toBe(orphanOutput);
    expect(r.bytesWritten).toBeGreaterThan(0);

    const archived = new Database(orphanOutput, { readonly: true });
    const msg = archived
      .prepare(`SELECT content, chat_jid FROM messages WHERE id = 'm-orphan'`)
      .get() as { content: string; chat_jid: string };
    expect(msg.content).toBe('orphan body');
    expect(msg.chat_jid).toBe('slack:C999GONE');
    archived.close();
  });
});
