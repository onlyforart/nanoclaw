import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { log } from '../../log.js';
import { registerMigration, runMigrations, type Migration } from './index.js';

describe('registerMigration', () => {
  it('runs a registered fork migration and records it in schema_version', () => {
    const db = new Database(':memory:');
    const m: Migration = {
      version: 999,
      name: 'fork-test-create-foo',
      up: (d) => {
        d.exec('CREATE TABLE fork_test_foo (id INTEGER PRIMARY KEY)');
      },
    };
    registerMigration(m);

    runMigrations(db);

    const tableRow = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fork_test_foo'").get();
    expect(tableRow).toBeDefined();

    const sv = db.prepare('SELECT name FROM schema_version WHERE name = ?').get(m.name) as { name: string } | undefined;
    expect(sv?.name).toBe(m.name);
    db.close();
  });

  it('is idempotent on a second run — no duplicate inserts, no errors', () => {
    const db = new Database(':memory:');
    const m: Migration = {
      version: 999,
      name: 'fork-test-create-bar',
      up: (d) => {
        d.exec('CREATE TABLE fork_test_bar (id INTEGER PRIMARY KEY)');
      },
    };
    registerMigration(m);

    runMigrations(db);
    const countAfterFirst = (db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;

    expect(() => runMigrations(db)).not.toThrow();
    const countAfterSecond = (db.prepare('SELECT COUNT(*) AS c FROM schema_version').get() as { c: number }).c;

    expect(countAfterSecond).toBe(countAfterFirst);
    db.close();
  });

  it('warns and skips when a duplicate name is registered', () => {
    const warnMock = vi.mocked(log.warn);
    warnMock.mockClear();

    const first: Migration = {
      version: 999,
      name: 'fork-test-dup',
      up: (d) => {
        d.exec('CREATE TABLE fork_test_dup_first (id INTEGER PRIMARY KEY)');
      },
    };
    const second: Migration = {
      version: 999,
      name: 'fork-test-dup',
      up: (d) => {
        d.exec('CREATE TABLE fork_test_dup_second (id INTEGER PRIMARY KEY)');
      },
    };

    registerMigration(first);
    registerMigration(second);

    expect(warnMock).toHaveBeenCalledWith('Migration already registered, skipping duplicate', {
      name: 'fork-test-dup',
    });

    const db = new Database(':memory:');
    runMigrations(db);

    const firstTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fork_test_dup_first'")
      .get();
    const secondTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fork_test_dup_second'")
      .get();
    expect(firstTable).toBeDefined();
    expect(secondTable).toBeUndefined();
    db.close();
  });
});
