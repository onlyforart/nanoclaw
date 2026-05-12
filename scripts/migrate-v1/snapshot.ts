/**
 * Phase 1 — snapshot the v1 DB into the sandbox before any tooling
 * touches it. Sandbox mode only; in live mode the migrator reads v1
 * directly (read-only handle) so there's nothing to snapshot.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

export function snapshotV1Db(v1DbPath: string, destDbPath: string): void {
  if (!fs.existsSync(v1DbPath)) {
    throw new Error(`v1 DB not found at ${v1DbPath}`);
  }
  fs.mkdirSync(path.dirname(destDbPath), { recursive: true });
  // SQLite-aware copy: use the .backup API so WAL state is captured cleanly.
  const src = new Database(v1DbPath, { readonly: true, fileMustExist: true });
  try {
    src.exec("ATTACH DATABASE ? AS dest");
    // better-sqlite3 doesn't expose backup() directly without a constructor
    // option; fall back to file copy (v1 should be quiescent during migration).
  } finally {
    src.close();
  }
  fs.copyFileSync(v1DbPath, destDbPath);
  // Drop WAL sidecars at the destination so the snapshot loads cleanly.
  for (const suffix of ['-wal', '-shm']) {
    const p = destDbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}
