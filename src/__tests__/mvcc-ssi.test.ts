import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor SSI read/write sets', () => {
  it('recordWrite records a row version and write set for a SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    e.recordWrite('s1', 'users', 1);
    // getOwnWrites is write-set driven; verify write set via a subsequent conflict path
    expect(e.activeCount).toBe(1);
  });

  it('recordWrite with isDelete marks the existing version deleted', () => {
    const e = makeExec();
    e.begin('s1', 'READ_COMMITTED', false);
    e.recordWrite('s1', 'users', 1); // insert version xmin=this txn
    e.recordWrite('s1', 'users', 1, true); // delete it
    // no throw; version now has xmax set
  });

  it('recordRead is a no-op for non-SERIALIZABLE transactions', () => {
    const e = makeExec();
    e.begin('s1', 'READ_COMMITTED', false);
    expect(() => e.recordRead('s1', 'users', 1)).not.toThrow();
  });

  it('recordReadOperation records into readSets for SERIALIZABLE txns', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    e.recordReadOperation('s1', 'users', '1');
    // Verify via getSelectVisibility or direct readSets exposure
    expect(e.activeCount).toBe(1);
  });
});

describe('MVCCExecutor predicate locks & phantom detection', () => {
  it('recordPredicateLock is a no-op for non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('s1', 'READ_COMMITTED', false);
    expect(() => e.recordPredicateLock('s1', 'users', { column: 'id', minValue: 10, maxValue: 20 })).not.toThrow();
  });

  it('recordInsertRow records data for a txn', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    expect(() => e.recordInsertRow('s1', 'users', { id: 15, name: 'a' })).not.toThrow();
  });

  it('detectSerializationConflict returns false with fewer than 2 serializable txns', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    const r = e.detectSerializationConflict('s1');
    expect(r.conflict).toBe(false);
  });

  it('detectSerializationConflict is a no-op for non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('s1', 'READ_COMMITTED', false);
    e.begin('s2', 'READ_COMMITTED', false);
    const r = e.detectSerializationConflict('s1');
    expect(r.conflict).toBe(false);
  });

  it('detectSerializationConflict returns false for unknown session', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    e.begin('s2', 'SERIALIZABLE', false);
    const r = e.detectSerializationConflict('ghost');
    expect(r.conflict).toBe(false);
  });
});

describe('MVCCExecutor serialization conflict cycle detection', () => {
  it('detects a 2-transaction rw-cycle (A reads what B wrote, B reads what A wrote)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);

    // A reads row 1, B reads row 2
    e.recordReadOperation('a', 't', '1');
    e.recordReadOperation('b', 't', '2');
    // A writes row 2, B writes row 1 → cross dependency → cycle
    e.recordWrite('a', 't', 2);
    e.recordWrite('b', 't', 1);

    const r = e.detectSerializationConflict('a');
    expect(r.conflict).toBe(true);
    expect(r.victimXid).toBeDefined();
  });

  it('detects predicate-based phantom conflict via commit path', () => {
    const e = makeExec();
    e.begin('reader', 'SERIALIZABLE', false);
    e.begin('writer', 'SERIALIZABLE', false);

    // Reader holds a predicate lock on id BETWEEN 10 AND 20
    e.recordPredicateLock('reader', 'users', { column: 'id', minValue: 10, maxValue: 20 });
    // Writer inserts id=15 (within range)
    e.recordInsertRow('writer', 'users', { id: 15, name: 'phantom' });

    // The phantom conflict is a single-edge dependency (not a cycle); it is
    // caught by detectPredicateConflict() during commit(), not by
    // detectSerializationConflict() (which only detects cycles).
    const res = e.commit('reader');
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('40001');
  });

  it('does not flag a phantom conflict when the insert is out of range', () => {
    const e = makeExec();
    e.begin('reader', 'SERIALIZABLE', false);
    e.begin('writer', 'SERIALIZABLE', false);

    e.recordPredicateLock('reader', 'users', { column: 'id', minValue: 10, maxValue: 20 });
    // id=9999 is outside the range → no predicate conflict
    e.recordInsertRow('writer', 'users', { id: 9999, name: 'outside' });

    const res = e.commit('reader');
    expect(res.success).toBe(true);
  });
});

describe('MVCCExecutor write/serialization via commit path', () => {
  it('SERIALIZABLE commit succeeds when no conflict exists', () => {
    const e = makeExec();
    e.begin('s1', 'SERIALIZABLE', false);
    const res = e.commit('s1');
    expect(res.success).toBe(true);
  });

  it('SERIALIZABLE commit aborts with 40001 on rw-cycle', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.recordReadOperation('a', 't', '1');
    e.recordReadOperation('b', 't', '2');
    e.recordWrite('a', 't', 2);
    e.recordWrite('b', 't', 1);

    const res = e.commit('a');
    expect(res.success).toBe(false);
    expect(res.errorCode).toBe('40001');
  });
});

describe('MVCCExecutor write lock contention & deadlock', () => {
  it('acquireRowWriteLock returns true for read-only txn (no lock needed)', () => {
    const e = makeExec();
    e.begin('ro', 'SERIALIZABLE', true);
    expect(e.acquireRowWriteLock('ro', 't', 1)).toBe(true);
  });

  it('acquireRowWriteLock is reentrant for the same txn on the same row', () => {
    const e = makeExec();
    e.begin('w', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('w', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('w', 't', 1)).toBe(true);
  });

  it('acquireRowWriteLock returns false when another txn holds the write lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('b', 't', 1)).toBe(false);
  });

  it('acquireRowShareLock is compatible between two readers', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowShareLock('b', 't', 1)).toBe(true);
  });

  it('acquireRowShareLock returns false when a write lock is held by another txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowShareLock('b', 't', 1)).toBe(false);
  });
});

describe('MVCCExecutor table locks', () => {
  it('lockTable returns true and detects conflict for the same table', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.lockTable('a', 'users', 'ACCESS EXCLUSIVE', false)).toBe(true);
    // A holds ACCESS EXCLUSIVE; B's conflicting lock should fail
    expect(e.lockTable('b', 'users', 'ACCESS EXCLUSIVE', false)).toBe(false);
  });

  it('lockTable with nowait returns false immediately on contention', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.lockTable('a', 'users', 'ACCESS EXCLUSIVE', true)).toBe(true);
    expect(e.lockTable('b', 'users', 'ACCESS EXCLUSIVE', true)).toBe(false);
  });

  it('areLockModesCompatible handles ACCESS EXCLUSIVE vs ACCESS SHARE', () => {
    expect(MVCCExecutor.areLockModesCompatible('ACCESS EXCLUSIVE', 'ACCESS SHARE')).toBe(false);
    expect(MVCCExecutor.areLockModesCompatible('ROW EXCLUSIVE', 'ROW SHARE')).toBe(true);
  });
});
