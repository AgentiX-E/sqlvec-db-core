import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ClogManager } from '../storage/ClogManager';
import { MvccManager } from '../storage/MvccManager';
import type { MvccSnapshot } from '../storage/MvccManager';

/**
 * MvccManager — row-level MVCC visibility.
 *
 * These tests pin down the PostgreSQL-compatible visibility rules, in
 * particular the regression where a row deleted by an in-progress transaction
 * was reported invisible (the old version should remain visible because the
 * deleter has not committed yet).
 */

function setup() {
  const db = new Database(':memory:');
  const clog = new ClogManager(db);
  clog.init();
  const mvcc = new MvccManager(clog);
  return { db, clog, mvcc };
}

describe('MvccManager — transaction lifecycle', () => {
  it('allocates a new XID on beginTransaction and tracks it', () => {
    const { mvcc } = setup();
    const xid = mvcc.beginTransaction('s1');
    expect(xid).toBeGreaterThan(0);
    expect(mvcc.getCurrentXid('s1')).toBe(xid);
    expect(mvcc.getActiveTransactionCount()).toBe(1);
  });

  it('returns 0 for a session with no active transaction', () => {
    const { mvcc } = setup();
    expect(mvcc.getCurrentXid('unknown')).toBe(0);
  });

  it('commits a transaction, clearing active state', () => {
    const { clog, mvcc } = setup();
    const xid = mvcc.beginTransaction('s1');
    mvcc.commitTransaction('s1');
    expect(mvcc.getCurrentXid('s1')).toBe(0);
    expect(clog.isCommitted(xid)).toBe(true);
    expect(mvcc.getActiveTransactionCount()).toBe(0);
  });

  it('rolls back a transaction, clearing active state and aborting', () => {
    const { clog, mvcc } = setup();
    const xid = mvcc.beginTransaction('s1');
    mvcc.rollbackTransaction('s1');
    expect(mvcc.getCurrentXid('s1')).toBe(0);
    expect(clog.isCommitted(xid)).toBe(false);
    expect(mvcc.getActiveTransactionCount()).toBe(0);
  });

  it('commitTransaction is a no-op for an inactive session', () => {
    const { mvcc } = setup();
    expect(() => mvcc.commitTransaction('nobody')).not.toThrow();
  });

  it('rollbackTransaction is a no-op for an inactive session', () => {
    const { mvcc } = setup();
    expect(() => mvcc.rollbackTransaction('nobody')).not.toThrow();
  });
});

describe('MvccManager — createSnapshot', () => {
  it('read_committed creates a fresh snapshot each call', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    const a = mvcc.createSnapshot('s1', 'read_committed');
    const b = mvcc.createSnapshot('s1', 'read_committed');
    expect(a).not.toBe(b);
  });

  it('repeatable_read reuses the cached snapshot for the same session', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    const a = mvcc.createSnapshot('s1', 'repeatable_read');
    const b = mvcc.createSnapshot('s1', 'repeatable_read');
    expect(a).toBe(b);
  });

  it('uses an empty xipList for a session with no other active transactions', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('only');
    const snap = mvcc.createSnapshot('only', 'read_committed');
    expect(snap.xipList).toEqual([]);
    expect(snap.currentXid).toBeGreaterThan(0);
  });

  it('excludes the current XID from xipList but includes other actives', () => {
    const { mvcc } = setup();
    const xidA = mvcc.beginTransaction('A');
    const xidB = mvcc.beginTransaction('B');
    const snap = mvcc.createSnapshot('A', 'read_committed');
    expect(snap.xipList).toContain(xidB);
    expect(snap.xipList).not.toContain(xidA);
  });

  it('does not cache a repeatable_read snapshot when there is no active XID', () => {
    const { mvcc } = setup();
    // No transaction started → currentXid = 0 → not cached.
    const a = mvcc.createSnapshot('s1', 'repeatable_read');
    const b = mvcc.createSnapshot('s1', 'repeatable_read');
    expect(a).not.toBe(b);
  });
});

describe('MvccManager — isVisible', () => {
  function committedInsert(mvcc: MvccManager): number {
    const xid = mvcc.beginTransaction('writer');
    mvcc.commitTransaction('writer');
    return xid;
  }

  it('system rows (xmin=0) are always visible', () => {
    const { mvcc } = setup();
    const snap = mvcc.createSnapshot('s', 'read_committed');
    expect(mvcc.isVisible(snap, 0, 0)).toBe(true);
  });

  it('a committed insert with no deleter is visible', () => {
    const { mvcc } = setup();
    const xid = committedInsert(mvcc);
    const snap = mvcc.createSnapshot('reader', 'read_committed');
    expect(mvcc.isVisible(snap, xid, 0)).toBe(true);
  });

  it('a row deleted by a committed transaction is invisible', () => {
    const { mvcc } = setup();
    const xmin = committedInsert(mvcc);
    const xmax = committedInsert(mvcc); // a separate committed deleter
    const snap = mvcc.createSnapshot('reader', 'read_committed');
    expect(mvcc.isVisible(snap, xmin, xmax)).toBe(false);
  });

  it('REGRESSION: a row deleted by an in-progress transaction stays visible', () => {
    const { mvcc } = setup();
    const xmin = committedInsert(mvcc);
    // A concurrent writer deletes the row but has NOT committed yet.
    const xmax = mvcc.beginTransaction('deleter');
    mvcc.beginTransaction('reader');
    const snap = mvcc.createSnapshot('reader', 'read_committed');
    expect(mvcc.isVisible(snap, xmin, xmax)).toBe(true);
  });

  it('an insert by an in-progress transaction (other than self) is invisible', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('other-writer'); // active, not committed
    mvcc.beginTransaction('reader');
    const snap = mvcc.createSnapshot('reader', 'read_committed');
    const otherXid = mvcc.getCurrentXid('other-writer');
    expect(mvcc.isVisible(snap, otherXid, 0)).toBe(false);
  });

  it('a self-insert is visible to the inserting session', () => {
    const { mvcc } = setup();
    const xid = mvcc.beginTransaction('s');
    const snap = mvcc.createSnapshot('s', 'read_committed');
    expect(mvcc.isVisible(snap, xid, 0)).toBe(true);
  });

  it('a self-delete (xmax = currentXid) is invisible', () => {
    const { mvcc } = setup();
    const xmin = committedInsert(mvcc);
    const self = mvcc.beginTransaction('self');
    const snap = mvcc.createSnapshot('self', 'read_committed');
    expect(mvcc.isVisible(snap, xmin, self)).toBe(false);
  });
});

describe('MvccManager — generateVisibilityWhere', () => {
  it('emits a conservative filter when there is no active transaction', () => {
    const { mvcc } = setup();
    const snap = mvcc.createSnapshot('noop', 'read_committed');
    expect(mvcc.generateVisibilityWhere(snap)).toContain('__xmin > 0');
  });

  it('emits an xip NOT IN filter when there are active transactions', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    mvcc.beginTransaction('s2');
    const snap = mvcc.createSnapshot('s1', 'read_committed');
    const clause = mvcc.generateVisibilityWhere(snap);
    expect(clause).toContain('NOT IN');
  });

  it('emits a bare filter when xipList is empty', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('only');
    const snap = mvcc.createSnapshot('only', 'read_committed');
    const clause = mvcc.generateVisibilityWhere(snap);
    expect(clause).not.toContain('NOT IN');
  });
});

describe('MvccManager — generateVisibilityWhereParam', () => {
  it('returns a conservative clause and empty params with no active txn', () => {
    const { mvcc } = setup();
    const snap = mvcc.createSnapshot('noop', 'read_committed');
    const r = mvcc.generateVisibilityWhereParam(snap);
    expect(r.clause).toContain('__xmin > 0');
    expect(r.params).toEqual([]);
  });

  it('returns clause + 3 params when xipList is populated', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    mvcc.beginTransaction('s2');
    const snap = mvcc.createSnapshot('s1', 'read_committed');
    const r = mvcc.generateVisibilityWhereParam(snap);
    expect(r.params).toHaveLength(3);
    expect(r.clause).toContain('NOT IN');
  });

  it('returns clause + 3 params when xipList is empty', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('only');
    const snap = mvcc.createSnapshot('only', 'read_committed');
    const r = mvcc.generateVisibilityWhereParam(snap);
    expect(r.params).toHaveLength(3);
    expect(r.clause).not.toContain('NOT IN');
  });

  it('param count always equals the number of ? placeholders', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    mvcc.beginTransaction('s2');
    mvcc.beginTransaction('s3');
    const snap = mvcc.createSnapshot('s1', 'read_committed');
    const r = mvcc.generateVisibilityWhereParam(snap);
    const placeholders = (r.clause.match(/\?/g) || []).length;
    expect(r.params.length).toBe(placeholders);
  });
});

describe('MvccManager — reset & counts', () => {
  it('reset clears all tracked state', () => {
    const { mvcc } = setup();
    mvcc.beginTransaction('s1');
    mvcc.beginTransaction('s2');
    mvcc.reset();
    expect(mvcc.getActiveTransactionCount()).toBe(0);
    expect(mvcc.getCurrentXid('s1')).toBe(0);
  });
});
