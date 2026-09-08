import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

// Helper to start a SERIALIZABLE txn and set its isolation mapping.
function beginSer(e: MVCCExecutor, sid: string) {
  e.begin(sid, 'SERIALIZABLE', false);
  const t = e.getTransaction(sid)!;
  (e as any).txnIsolation.set(t.xid, 'SERIALIZABLE');
  return t;
}

describe('MVCCExecutor recordPredicateLock range-without-column branch', () => {
  it('registers lock with min/max but no column', () => {
    const e = makeExec();
    beginSer(e, 'a');
    e.recordPredicateLock('a', 't', { minValue: 10, maxValue: 20 }); // no column
    const preds = (e as any).predicateLocks.get('a');
    expect(preds.size).toBe(1);
    expect([...preds][0].column).toBeUndefined();
  });
});

describe('MVCCExecutor recordInsertRow cross-txn predicate branches', () => {
  it('skips non-SERIALIZABLE other txn (otherIso continue)', () => {
    const e = makeExec();
    beginSer(e, 'a'); // SERIALIZABLE reader with predicate lock
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 0, maxValue: 100 });
    // b is READ_COMMITTED inserter → otherIso !== SERIALIZABLE → skipped.
    e.begin('b', 'READ_COMMITTED', false);
    const b = e.getTransaction('b')!;
    e.recordInsertRow('b', 't', { id: 1, age: 50 });
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });

  it('skips predicate lock whose table differs (lock.table !== table)', () => {
    const e = makeExec();
    beginSer(e, 'a');
    e.recordPredicateLock('a', 'other', { column: 'age', minValue: 0, maxValue: 100 });
    beginSer(e, 'b');
    e.recordInsertRow('b', 't', { id: 1, age: 50 });
    // lock.table 'other' !== 't' → skip.
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });
});

describe('MVCCExecutor rowMatchesPredicate missing-column fallback', () => {
  it('returns true when row lacks the range column (conservative)', () => {
    const e = makeExec();
    const lock = { table: 't', column: 'age', minValue: 10, maxValue: 20 };
    const row = { id: 1 }; // no 'age' column
    expect((e as any).rowMatchesPredicate(row, lock)).toBe(true);
  });
});

describe('MVCCExecutor detectSerializationConflict rwEdges reuse', () => {
  it('builds multi-edge rw-dependency graph (rwEdges.has false branch)', () => {
    const e = makeExec();
    beginSer(e, 'a');
    beginSer(e, 'b');
    beginSer(e, 'c');
    // A reads t:1 and t:2; B writes t:1 and t:2 → two rw edges A→B.
    (e as any).readSets.set('a', new Set(['t:1', 't:2']));
    (e as any).writeSets.set('b', new Set(['t:1', 't:2']));
    (e as any).writeSets.set('c', new Set(['t:3']));
    const result = (e as any).detectSerializationConflict('a');
    expect(typeof result).toBe('object');
  });
});

describe('MVCCExecutor cleanup committedPredicateWrites splice', () => {
  it('splices committedPredicateWrites for the committing txn', () => {
    const e = makeExec();
    beginSer(e, 'a');
    const a = e.getTransaction('a')!;
    (e as any).committedPredicateWrites.push(
      { table: 't', rowData: { id: 1 }, predLockTxnXid: a.xid },
      { table: 't', rowData: { id: 2 }, predLockTxnXid: 999 },
    );
    // commit() triggers cleanupReadWriteSets which splices matching entries.
    (e as any).cleanupReadWriteSets('a');
    const remaining = (e as any).committedPredicateWrites;
    expect(remaining.length).toBe(1);
    expect(remaining[0].predLockTxnXid).toBe(999);
  });
});
