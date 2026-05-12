/**
 * Phase 5 — Q1 a-1: build a read-only archive at `data/legacy-v1-readonly.db`
 * containing ONLY v1's `chats` + `messages` tables. v2 has no destination
 * for chat/message history (upstream tooling intentionally drops it);
 * the archive preserves the data for ad-hoc operator queries
 * (`sqlite3 data/legacy-v1-readonly.db ...`). Nothing in v2 code reads it.
 *
 * Strategy: open v1 DB read-only, open archive DB writable, copy schema
 * + rows for the two tables, close. Idempotent — overwrites existing
 * archive each run.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export interface LegacyArchiveResult {
  outputPath: string | null;
  bytesWritten: number;
  skipped: string[];
}

export function createLegacyArchive(
  v1DbPath: string,
  outputPath: string,
): LegacyArchiveResult {
  if (!fs.existsSync(v1DbPath)) {
    return {
      outputPath: null,
      bytesWritten: 0,
      skipped: [`legacy-archive: v1 db not found at ${v1DbPath}`],
    };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  // Remove existing for idempotency (drop WAL sidecars too).
  for (const suffix of ['', '-wal', '-shm']) {
    const p = outputPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const src = new Database(v1DbPath, { readonly: true, fileMustExist: true });
  const dst = new Database(outputPath);
  // Disable FK enforcement on the archive: v1 prod DBs frequently have
  // orphan messages (chat_jid pointing at a chats row that was deleted or
  // never recorded). The archive's purpose is operator-grep, not
  // referential integrity, so preserve every row verbatim.
  dst.pragma('foreign_keys = OFF');
  try {
    // Copy chats + messages schemas verbatim from v1 (with our added columns).
    for (const table of ['chats', 'messages']) {
      const schemaRow = src
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`)
        .get(table) as { sql: string } | undefined;
      if (!schemaRow) {
        continue;
      }
      dst.exec(schemaRow.sql);
    }
    // Copy rows.
    const chatsRows = src.prepare(`SELECT * FROM chats`).all() as Array<Record<string, unknown>>;
    if (chatsRows.length > 0) {
      const cols = Object.keys(chatsRows[0]);
      const stmt = dst.prepare(
        `INSERT INTO chats (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
      );
      const tx = dst.transaction((rs: Array<Record<string, unknown>>) => {
        for (const r of rs) stmt.run(r);
      });
      tx(chatsRows);
    }
    const messagesRows = src
      .prepare(`SELECT * FROM messages`)
      .all() as Array<Record<string, unknown>>;
    if (messagesRows.length > 0) {
      const cols = Object.keys(messagesRows[0]);
      const stmt = dst.prepare(
        `INSERT INTO messages (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
      );
      const tx = dst.transaction((rs: Array<Record<string, unknown>>) => {
        for (const r of rs) stmt.run(r);
      });
      tx(messagesRows);
    }
  } finally {
    src.close();
    dst.close();
  }

  const bytesWritten = fs.statSync(outputPath).size;
  return { outputPath, bytesWritten, skipped: [] };
}
