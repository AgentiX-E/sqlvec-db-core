import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MVCCExecutor,
  XID_WRAP_LIMIT,
  XID_FROZEN,
  extractWhereRange,
  type IsolationLevel,
} from '../query/MVCCExecutor';

// Each test constructs its own executor and disposes it to stop the deadlock timer.
let exec: MVCCExecutor | null = null;

function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}

afterEach(() => {
  exec?.dispose();
  exec = null;
});

describe('MVCCExecutor lifecycle', () => {
  it('begins a transaction with a monotonically increasing XID', () => {
    const e = makeExec();
    const t1 = e.begin('s1', 'READ_COMMITTED', false);
    const t2 = e.begin('s2', 'READ_COMMITTED', false);
    expect(t1.xid).toBeGreaterThanOrEqual(3);
    expect(t2.xid).toBeGreaterThan(t1.xid);
    expect(t1.snapshot).toBeLessThan(t2.xid);
  });

  it('normalizes isolation and reflects it via getIsolationForSession', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    expect(e.getIsolationForSession('s1')).toBe('SERIALIZABLE');
    // No active transaction falls back to READ_COMMITTED.
    expect(e.getIsolationForSession('nope')).toBe('READ_COMMITTED');
  });

  it('commits a read-only transaction without conflict checks', () => {
    const e = makeExec();
    e.begin('ro', 'SERIALIZABLE', true);
    const res = e.commit('ro');
    expect(res).toEqual({ success: true });
    expect(e.getTransaction('ro')).toBeUndefined();
  });

  it('commits a read-write transaction successfully', () => {
    const e = makeExec();
    e.begin('rw', 'READ_COMMITTED', false);
    const res = e.commit('rw');
    expect(res.success).toBe(true);
    expect(e.getActiveSessions()).not.toContain('rw');
  });

  it('throws when committing a session without an active transaction', () => {
    const e = makeExec();
    expect(() => e.commit('ghost')).toThrow(/no active transaction/);
  });

  it('rollback is a no-op for unknown session (warn, no throw)', () => {
    const e = makeExec();
    expect(() => e.rollback('ghost')).not.toThrow();
  });

  it('rollback removes the active transaction and its XID', () => {
    const e = makeExec();
    e.begin('s1', 'READ_COMMITTED', false);
    const xid = e.getTxnXid('s1');
    e.rollback('s1');
    expect(e.getTransaction('s1')).toBeUndefined();
    expect(e.getActiveXidSet()).not.toContain(xid);
  });
});

describe('MVCCExecutor XID allocation & freeze', () => {
  it('starts XID counter at 3 and wraps below limit', () => {
    const e = makeExec();
    const cur = e.getCurrentXid();
    expect(cur).toBeGreaterThanOrEqual(3);
    expect(cur).toBeLessThan(XID_WRAP_LIMIT);
  });

  it('isFrozen only true for XID_FROZEN', () => {
    const e = makeExec();
    expect(e.isFrozen(XID_FROZEN)).toBe(true);
    expect(e.isFrozen(3)).toBe(false);
  });

  it('freezeTransaction returns XID_FROZEN', () => {
    const e = makeExec();
    expect(e.freezeTransaction()).toBe(XID_FROZEN);
  });

  it('exposes XID_WRAP_LIMIT and XID_FROZEN constants', () => {
    expect(XID_WRAP_LIMIT).toBe(2147483648);
    expect(XID_FROZEN).toBe(2);
  });
});

describe('MVCCExecutor visibility helpers', () => {
  it('buildVisibilityClause emits expected SQL predicate', () => {
    const e = makeExec();
    expect(e.buildVisibilityClause(42)).toBe('(_xmax IS NULL OR _xmax <= 42)');
  });

  it('isRowVisible uses snapshot semantics for committed rows', () => {
    const e = makeExec();
    // Signature: (xmin, xmax, snapshot, activeXids, isolation)
    // A committed row (xmax null, xmin <= snapshot) is visible.
    expect(e.isRowVisible(3, null, 5, new Set(), 'READ_COMMITTED')).toBe(true);
    // Frozen row is always visible.
    expect(e.isRowVisible(XID_FROZEN, null, 5, new Set(), 'SERIALIZABLE')).toBe(true);
    // Row created by an active txn is not visible.
    expect(e.isRowVisible(7, null, 5, new Set([7]), 'READ_COMMITTED')).toBe(false);
    // Row created after snapshot is not visible for SERIALIZABLE.
    expect(e.isRowVisible(9, null, 5, new Set(), 'SERIALIZABLE')).toBe(false);
  });

  it('isVisible alias delegates to the same logic', () => {
    const e = makeExec();
    const txn = { xid: 5, started: Date.now(), snapshot: 5, readOnly: false, timeoutMs: 0 } as any;
    expect(e.isVisible(txn, { xmin: 5, xmax: null } as any)).toBe(true);
  });
});

describe('MVCCExecutor lock mode compatibility', () => {
  it('field static is callable and symmetric for shared locks', () => {
    const e = makeExec();
    // ACCESS SHARE vs ACCESS SHARE should be compatible.
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'ACCESS SHARE')).toBe(true);
    // ACCESS EXCLUSIVE conflicts with everything.
    expect(MVCCExecutor.areLockModesCompatible('ACCESS EXCLUSIVE', 'ACCESS SHARE')).toBe(false);
    expect(MVCCExecutor.areLockModesCompatible('ACCESS SHARE', 'ACCESS EXCLUSIVE')).toBe(false);
  });
});

describe('extractWhereRange (pure function)', () => {
  it('extracts a BETWEEN range', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE id BETWEEN 10 AND 20')).toEqual({
      column: 'id',
      minValue: 10,
      maxValue: 20,
    });
  });

  it('extracts an equality predicate', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE id = 42')).toEqual({
      column: 'id',
      eqValue: 42,
    });
  });

  it('returns undefined for a query without a WHERE range', () => {
    expect(extractWhereRange('SELECT * FROM t')).toBeUndefined();
  });

  it('extracts an inequality range', () => {
    expect(extractWhereRange('SELECT * FROM t WHERE val >= 5')).toEqual({
      column: 'val',
      minValue: 5,
    });
  });
});

describe('MVCCExecutor row locking', () => {
  it('acquires and releases a row write lock', () => {
    const e = makeExec();
    e.begin('w', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('w', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('w', 't', 1)).toBe(true); // reentrant / already-held
    e.releaseWriteLock('t', 1);
  });

  it('acquireRowShareLock is boolean and release is void', () => {
    const e = makeExec();
    e.begin('w', 'READ_COMMITTED', false);
    expect(typeof e.acquireRowShareLock('w', 't', 1)).toBe('boolean');
    e.releaseRowShareLock('w', 't', 1);
  });

  it('lockTable acquires a table lock and detectConflict is boolean', () => {
    const e = makeExec();
    e.begin('w', 'READ_COMMITTED', false);
    expect(e.lockTable('w', 'users', 'ACCESS EXCLUSIVE', false)).toBe(true);
    expect(typeof e.detectConflict('w', 'users', 1)).toBe('boolean');
  });
});

describe('MVCCExecutor stats & introspection', () => {
  it('getGlobalStats returns a stats object', () => {
    const e = makeExec();
    const s = e.getGlobalStats();
    expect(s).toBeDefined();
    expect(typeof s).toBe('object');
  });

  it('getSessionStats returns null for unknown session', () => {
    const e = makeExec();
    expect(e.getSessionStats('ghost')).toBeNull();
  });

  it('getActiveSessions returns empty initially', () => {
    const e = makeExec();
    expect(e.getActiveSessions()).toEqual([]);
  });

  it('getBackoffMs returns a non-negative number', () => {
    const e = makeExec();
    expect(e.getBackoffMs('s1')).toBeGreaterThanOrEqual(0);
  });
});
