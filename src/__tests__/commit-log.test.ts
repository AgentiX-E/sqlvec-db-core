import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { CommitLog } from '../commitlog/CommitLog';

/**
 * CommitLog — transaction commit/abort tracking backed by SQLite.
 *
 * These tests exercise the real better-sqlite3 database (not a mock) so that
 * the upsert semantics (INSERT OR REPLACE), cleanup threshold, and status
 * mapping are verified against actual SQLite behavior.
 */

let db: Database.Database;
let clog: CommitLog;

beforeEach(() => {
  db = new Database(':memory:');
  clog = new CommitLog(db);
});

describe('commit / abort marking', () => {
  it('marks an XID as committed', () => {
    clog.commit(42, 1000);
    expect(clog.getStatus(42)).toBe('committed');
    expect(clog.isCommitted(42)).toBe(true);
    expect(clog.isAborted(42)).toBe(false);
  });

  it('marks an XID as aborted', () => {
    clog.abort(99);
    expect(clog.getStatus(99)).toBe('aborted');
    expect(clog.isAborted(99)).toBe(true);
    expect(clog.isCommitted(99)).toBe(false);
  });

  it('defaults commitTime to Date.now()', () => {
    const before = Date.now();
    clog.commit(1);
    const row = db.prepare('SELECT commit_time FROM __pg_clog WHERE xid = 1').get() as { commit_time: number };
    expect(row.commit_time).toBeGreaterThanOrEqual(before);
  });

  it('stores an explicit commitTime', () => {
    clog.commit(1, 12345);
    const row = db.prepare('SELECT commit_time FROM __pg_clog WHERE xid = 1').get() as { commit_time: number };
    expect(row.commit_time).toBe(12345);
  });

  it('treats abort commit_time as NULL', () => {
    clog.abort(1);
    const row = db.prepare('SELECT commit_time FROM __pg_clog WHERE xid = 1').get() as { commit_time: number | null };
    expect(row.commit_time).toBeNull();
  });
});

describe('xid validation guards', () => {
  it('commit ignores XIDs <= 0', () => {
    clog.commit(0);
    clog.commit(-1);
    expect(clog.size).toBe(0);
  });

  it('abort ignores XIDs <= 0', () => {
    clog.abort(0);
    clog.abort(-5);
    expect(clog.size).toBe(0);
  });

  it('getStatus returns unknown for XIDs <= 0', () => {
    expect(clog.getStatus(0)).toBe('unknown');
    expect(clog.getStatus(-10)).toBe('unknown');
  });
});

describe('status lookup', () => {
  it('returns unknown for an unknown XID', () => {
    expect(clog.getStatus(999)).toBe('unknown');
  });

  it('returns unknown for a row with an unexpected status value (defensive fallback)', () => {
    // The database is injected, so another writer could theoretically insert a
    // non-standard status. getStatus must not throw and must map it to 'unknown'.
    db.prepare('INSERT INTO __pg_clog (xid, status, commit_time) VALUES (?, ?, NULL)').run(55, 'weird-status');
    expect(clog.getStatus(55)).toBe('unknown');
  });
});

describe('upsert semantics (overwrite)', () => {
  it('commit overwrites a previous abort (INSERT OR REPLACE)', () => {
    clog.abort(7);
    clog.commit(7, 500);
    expect(clog.getStatus(7)).toBe('committed');
  });

  it('abort overwrites a previous commit', () => {
    clog.commit(7, 500);
    clog.abort(7);
    expect(clog.getStatus(7)).toBe('aborted');
  });
});

describe('cleanup', () => {
  it('removes entries below the threshold', () => {
    clog.commit(10);
    clog.commit(20);
    clog.commit(30);
    const removed = clog.cleanup(20);
    expect(removed).toBe(1); // xid 10 removed
    expect(clog.getStatus(10)).toBe('unknown');
    expect(clog.isCommitted(20)).toBe(true);
  });

  it('returns 0 when threshold is <= 0', () => {
    clog.commit(10);
    expect(clog.cleanup(0)).toBe(0);
    expect(clog.cleanup(-1)).toBe(0);
  });

  it('returns 0 when nothing matches', () => {
    clog.commit(10);
    expect(clog.cleanup(10)).toBe(0); // xid < 10, but 10 is not < 10
  });
});

describe('size / clear', () => {
  it('reports the number of entries', () => {
    expect(clog.size).toBe(0);
    clog.commit(1);
    clog.abort(2);
    expect(clog.size).toBe(2);
  });

  it('clear deletes all entries', () => {
    clog.commit(1);
    clog.abort(2);
    clog.clear();
    expect(clog.size).toBe(0);
  });
});

describe('committed / aborted XID enumeration', () => {
  it('returns committed XIDs in ascending order', () => {
    clog.commit(30);
    clog.commit(10);
    clog.commit(20);
    clog.abort(5);
    expect(clog.getCommittedXids()).toEqual([10, 20, 30]);
  });

  it('returns aborted XIDs in ascending order', () => {
    clog.abort(30);
    clog.abort(10);
    clog.commit(5);
    expect(clog.getAbortedXids()).toEqual([10, 30]);
  });

  it('returns empty arrays when there are no entries', () => {
    expect(clog.getCommittedXids()).toEqual([]);
    expect(clog.getAbortedXids()).toEqual([]);
  });
});

describe('table creation', () => {
  it('creates the __pg_clog table idempotently', () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__pg_clog'").get() as { name: string } | undefined;
    expect(row).toBeDefined();
    // constructing a second CommitLog on the same DB must not throw
    expect(() => new CommitLog(db)).not.toThrow();
  });
});
