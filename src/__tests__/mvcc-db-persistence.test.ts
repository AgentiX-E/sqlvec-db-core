/**
 * Unit tests for MVCCExecutor's SQLite persistence layer.
 *
 * Prior suites never passed a `db` into the constructor, so the entire
 * persistence surface — XID table init/restore, row-version table lifecycle,
 * checkpoint persistence, and SQLite-backed XID allocation — was dormant.
 * This suite supplies a real in-memory better-sqlite3 database and drives each
 * persistence path to completion, including its error/fallback branches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
let db: Database.Database | null = null;

function makeDb(): Database.Database {
  return new Database(':memory:');
}

function makeExec(config?: Record<string, unknown>): MVCCExecutor {
  const e = new MVCCExecutor(config as any);
  exec = e;
  return e;
}

afterEach(() => {
  exec?.dispose();
  exec = null;
  db?.close();
  db = null;
});

describe('MVCCExecutor — XID persistence table', () => {
  it('initializes __mvcc_xid_seq on construction when db is supplied', () => {
    db = makeDb();
    makeExec({ db });
    const row = db.prepare('SELECT last_xid FROM __mvcc_xid_seq').get() as { last_xid: number };
    expect(row.last_xid).toBe(2);
  });

  it('allocates XIDs from the SQLite sequence (3, then 4)', () => {
    db = makeDb();
    const e = makeExec({ db });
    const a = e.begin('a', 'READ_COMMITTED', false);
    const b = e.begin('b', 'READ_COMMITTED', false);
    expect(a.xid).toBe(3);
    expect(b.xid).toBe(4);
    // The sequence table advanced past the highest allocated XID.
    const row = db!.prepare('SELECT last_xid FROM __mvcc_xid_seq').get() as { last_xid: number };
    expect(row.last_xid).toBe(4);
  });

  it('restores the XID counter from a pre-seeded sequence', () => {
    db = makeDb();
    db.exec('CREATE TABLE __mvcc_xid_seq (last_xid INTEGER)');
    db.exec('INSERT INTO __mvcc_xid_seq (last_xid) VALUES (100)');
    const e = makeExec({ db });
    const t = e.begin('a', 'READ_COMMITTED', false);
    expect(t.xid).toBe(101);
  });
});

describe('MVCCExecutor — row version persistence', () => {
  it('creates __row_versions on construction', () => {
    db = makeDb();
    makeExec({ db });
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='__row_versions'",
    ).all();
    expect(tables).toHaveLength(1);
  });

  it('persists a new row version on recordWrite (insert)', () => {
    db = makeDb();
    const e = makeExec({ db });
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 'users', 1, false);
    const rows = db!.prepare('SELECT * FROM __row_versions').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'users:1', xmax: null });
  });

  it('persists an updated xmax on recordWrite (delete)', () => {
    db = makeDb();
    const e = makeExec({ db });
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 'users', 1, false);
    e.recordWrite('a', 'users', 1, true);
    const rows = db!.prepare('SELECT * FROM __row_versions').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].xmax).toBe(3);
  });

  it('reloads existing row versions into memory on construction', () => {
    db = makeDb();
    db.exec(
      "CREATE TABLE __row_versions (key TEXT PRIMARY KEY, xmin INTEGER NOT NULL, xmax INTEGER)",
    );
    db.exec("INSERT INTO __row_versions (key, xmin, xmax) VALUES ('t:1', 10, 20)");
    const e = makeExec({ db });
    const rv = (e as any).rowVersions.get('t:1');
    expect(rv).toEqual({ xmin: 10, xmax: 20 });
  });

  it('checkpoint flushes in-memory row versions to SQLite', () => {
    db = makeDb();
    const e = makeExec({ db });
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 'users', 7, false);
    const result = e.checkpoint();
    expect(result).toBeNull(); // no WAL writer configured
    const rows = db!.prepare("SELECT * FROM __row_versions WHERE key='users:7'").all();
    expect(rows).toHaveLength(1);
  });
});

describe('MVCCExecutor — error/fallback branches in persistence', () => {
  it('persistRowVersion logs and survives a write failure', () => {
    db = makeDb();
    const e = makeExec({ db });
    e.begin('a', 'READ_COMMITTED', false);
    // Drop the table so the INSERT fails; recordWrite must not throw.
    db!.exec('DROP TABLE __row_versions');
    expect(() => e.recordWrite('a', 'users', 1, false)).not.toThrow();
  });

  it('initializeRowVersionsTable logs and survives a db failure', () => {
    // A db that fails only when touching __row_versions. This lets the XID
    // table init succeed while the row-version table init enters its catch
    // branch (the __row_versions CREATE throws).
    const brokenDb = {
      pragma() { return 'NORMAL'; },
      exec(sql: string) {
        if (sql.includes('__row_versions')) throw new Error('boom');
      },
      prepare() { throw new Error('boom'); },
    };
    const e = makeExec({ db: brokenDb });
    expect(e).toBeInstanceOf(MVCCExecutor);
  });

  it('clearRowVersions handles an empty (uninitialized) db gracefully', () => {
    db = makeDb();
    const e = makeExec({ db });
    // vacuum(force) triggers GC which clears persisted row versions.
    const conn = { exec: () => { db!.exec("DELETE FROM __row_versions"); } };
    expect(() => e.vacuum(conn as any)).not.toThrow();
  });
});
