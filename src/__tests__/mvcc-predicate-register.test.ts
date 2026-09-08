import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor recordPredicateLock registration branches', () => {
  it('registers predicate lock with column + range', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 10, maxValue: 20 });
    const preds = (e as any).predicateLocks.get('a');
    expect(preds.size).toBe(1);
    const lock = [...preds][0];
    expect(lock.table).toBe('t');
    expect(lock.column).toBe('age');
    expect(lock.minValue).toBe(10);
    expect(lock.maxValue).toBe(20);
  });

  it('skips predicate lock for non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordPredicateLock('a', 't', { column: 'age' });
    expect((e as any).predicateLocks.has('a')).toBe(false);
  });

  it('skips predicate lock for read-only txn', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', true);
    e.recordPredicateLock('a', 't', { column: 'age' });
    expect((e as any).predicateLocks.has('a')).toBe(false);
  });
});

describe('MVCCExecutor recordInsertRow predicate matching branches', () => {
  it('returns early when txn unknown', () => {
    const e = makeExec();
    expect(() => e.recordInsertRow('ghost', 't', { id: 1 })).not.toThrow();
  });

  it('does not match predicate when inserter non-SERIALIZABLE', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordInsertRow('a', 't', { id: 1, age: 15 });
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });

  it('matches predicate lock and records committedPredicateWrites', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false); // reader holds predicate lock
    e.begin('b', 'SERIALIZABLE', false); // inserter
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    (e as any).txnIsolation.set(b.xid, 'SERIALIZABLE');
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 10, maxValue: 20 });
    e.recordInsertRow('b', 't', { id: 1, age: 15 });
    const writes = (e as any).committedPredicateWrites;
    expect(writes.length).toBe(1);
    expect(writes[0].predLockTxnXid).toBe(a.xid);
  });
});

describe('MVCCExecutor detectPredicateConflict skip branches', () => {
  it('returns false for non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('returns false when no predicate locks', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('detects conflict on committed predicate write via Check 2', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 10, maxValue: 20 });
    // Seed a committed predicate write whose predLockTxnXid == a.xid.
    (e as any).committedPredicateWrites.push({
      table: 't',
      rowData: { id: 1, age: 15 },
      predLockTxnXid: a.xid,
    });
    expect((e as any).detectPredicateConflict('a')).toBe(true);
  });

  it('ignores committed predicate write for different table', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 10, maxValue: 20 });
    // Different table → should not match (lock.table !== entry.table).
    (e as any).committedPredicateWrites.push({
      table: 'other',
      rowData: { id: 1, age: 15 },
      predLockTxnXid: a.xid,
    });
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });
});
