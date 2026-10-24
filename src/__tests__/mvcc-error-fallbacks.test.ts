/**
 * Unit tests for MVCCExecutor error-handling fallbacks — WAL log failures,
 * VACUUM/TOAST/checkpoint catch branches, XID_FROZEN skip, and the
 * clear-row-versions failure path.
 *
 * These branches require a specific dependency (walLogger/pgWalWriter/db) to
 * throw at a precise point, which the happy-path feature suites never trigger.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
let db: Database.Database | null = null;
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

describe('MVCCExecutor — WAL log failure', () => {
  it('logs and survives a WAL logInsert throwing', () => {
    const e = makeExec({
      walLogger: { logInsert() { throw new Error('wal boom'); } },
    });
    e.begin('a', 'READ_COMMITTED', false);
    expect(() => e.addOwnWriteRow('a', 'users', 1, 'INSERT', { rowId: 1 })).not.toThrow();
  });
});

describe('MVCCExecutor — vacuum error fallbacks', () => {
  it('catches a VACUUM FREEZE failure when the connection throws', () => {
    const e = makeExec();
    // prepare() exists but .all() throws inside the VACUUM FREEZE phase.
    const conn = {
      prepare() {
        return { all() { throw new Error('freeze boom'); } };
      },
    };
    expect(() => e.vacuum(conn as any)).not.toThrow();
  });

  it('catches a TOAST GC callback failure', () => {
    const e = makeExec();
    const conn = { exec() { throw new Error('x'); } };
    // onVacuum throws → TOAST GC catch branch.
    const e2 = makeExec({ onVacuum() { throw new Error('toast boom'); } });
    expect(() => e2.vacuum({ exec() {} } as any)).not.toThrow();
    void conn;
  });
});

describe('MVCCExecutor — checkpoint flush failure', () => {
  it('returns null when the WAL writer flush fails', () => {
    const e = makeExec({
      walLogger: {
        getWriter() {
          return { flushSegment() { throw new Error('flush boom'); } };
        },
      },
    });
    const result = e.checkpoint();
    expect(result).toBeNull();
  });

  it('returns null when pgWalWriter.writeCheckpoint fails', () => {
    const e = makeExec({
      pgWalWriter: { writeCheckpoint() { throw new Error('checkpoint boom'); } },
    });
    const result = e.checkpoint();
    expect(result).toBeNull();
  });
});

describe('MVCCExecutor — clear row versions failure', () => {
  it('survives a clearRowVersions exec failure', () => {
    db = new Database(':memory:');
    const e = makeExec({ db });
    // Drop the table so the later DELETE inside reset() fails.
    db!.exec('DROP TABLE __row_versions');
    expect(() => e.reset()).not.toThrow();
  });
});

describe('MVCCExecutor — XID_FROZEN skip during allocation', () => {
  it('skips XID_FROZEN (2) and allocates 3 when the sequence lands on 2', () => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE __mvcc_xid_seq (last_xid INTEGER)');
    // Seed last_xid = 1 so the first UPDATE (+1) lands on XID_FROZEN (2),
    // forcing the allocator to skip and retry, returning 3.
    db.exec('INSERT INTO __mvcc_xid_seq (last_xid) VALUES (1)');
    const e = makeExec({ db });
    const t = e.begin('a', 'READ_COMMITTED', false);
    expect(t.xid).toBe(3);
  });
});
