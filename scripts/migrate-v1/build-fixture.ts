/**
 * Build an on-disk fixture v1 store/messages.db from
 * scripts/v1-migration-fixtures/fixture.sql.
 *
 * Used by the validator test, by the orchestrator smoke,
 * and by /migrate-v1-fixture standalone runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const FIXTURE_SQL_PATH = path.resolve(import.meta.dirname, '../v1-migration-fixtures/fixture.sql');

export function buildFixtureV1Db(targetPath: string): Database.Database {
  // Idempotent: remove existing, including WAL sidecars.
  for (const suffix of ['', '-wal', '-shm']) {
    const p = targetPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const db = new Database(targetPath);
  const sql = fs.readFileSync(FIXTURE_SQL_PATH, 'utf-8');
  db.exec(sql);
  return db;
}
