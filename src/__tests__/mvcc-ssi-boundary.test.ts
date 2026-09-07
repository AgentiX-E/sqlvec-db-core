import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectSerializationConflict boundaries', () => {
  it('returns no conflict with fewer than 2 serializable txns', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(false);
  });

  it('returns no conflict when no rw-edges exist (disjoint read/write sets)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // a reads t:1, b writes t:2 (disjoint)
    e.recordRead('a', 't', 1);
    e.recordWrite('b', 't', 2);
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(false);
  });

  it('detects a 2-txn rw-cycle (A reads what B wrote, B reads what A wrote)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // A reads t:2 (which B will write), B reads t:1 (which A writes)
    e.recordReadOperation('a', 't', '2');
    e.recordReadOperation('b', 't', '1');
    e.recordWrite('a', 't', 1);
    e.recordWrite('b', 't', 2);
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(true);
  });

  it('single-direction predicate dependency is not a cycle (no conflict)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // A holds a predicate lock on 'users'; B inserts into 'users'.
    // This is a one-way A→B dependency (phantom risk), NOT a cycle.
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 100 });
    e.recordInsertRow('b', 'users', { id: 50 });
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(false); // no cycle — handled by detectPredicateConflict elsewhere
  });

  it('predicate phantom is detected by detectPredicateConflict (active insert)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 100 });
    e.recordInsertRow('b', 'users', { id: 50 });
    // The one-way phantom is caught by predicate-conflict detection, not cycle detection.
    expect((e as any).detectPredicateConflict('a')).toBe(true);
  });

  it('detects a 3-txn cycle (A→B→C→A)', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.begin('c', 'SERIALIZABLE', false);
    // A reads what B wrote, B reads what C wrote, C reads what A wrote.
    e.recordReadOperation('a', 't', '2');
    e.recordReadOperation('b', 't', '3');
    e.recordReadOperation('c', 't', '1');
    e.recordWrite('a', 't', 1);
    e.recordWrite('b', 't', 2);
    e.recordWrite('c', 't', 3);
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(true);
    expect(typeof r.victimXid).toBe('number');
  });
});

describe('MVCCExecutor detectPredicateConflict committed-write check', () => {
  it('detects committed predicate write via committedPredicateWrites', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', eqValue: 42 });
    // Inject a committed predicate write that matches a's lock.
    const aTxn = e.getTransaction('a')!;
    (e as any).committedPredicateWrites.push({
      predLockTxnXid: aTxn.xid,
      table: 'users',
      rowData: { id: 42 },
    });
    const conflict = (e as any).detectPredicateConflict('a');
    expect(conflict).toBe(true);
  });

  it('returns false when committed write predLockTxnXid does not match', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', eqValue: 42 });
    (e as any).committedPredicateWrites.push({
      predLockTxnXid: 999999, // another txn
      table: 'users',
      rowData: { id: 42 },
    });
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });

  it('returns false for non-serializable or read-only txn', () => {
    const e = makeExec();
    e.begin('rc', 'READ_COMMITTED', false);
    expect((e as any).detectPredicateConflict('rc')).toBe(false);
    e.begin('ro', 'SERIALIZABLE', true);
    expect((e as any).detectPredicateConflict('ro')).toBe(false);
  });
});

describe('MVCCExecutor recordPredicateLock range parsing', () => {
  it('records eqValue / minValue / maxValue from an explicit range', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 't', { column: 'id', eqValue: 5, minValue: 1, maxValue: 10 });
    const preds = (e as any).predicateLocks.get('a') as Set<any>;
    expect(preds).toBeDefined();
    expect(preds.size).toBe(1);
    const lock = [...preds][0];
    expect(lock.column).toBe('id');
    expect(lock.eqValue).toBe(5);
    expect(lock.minValue).toBe(1);
    expect(lock.maxValue).toBe(10);
  });

  it('recordPredicateLock without range records a table-level lock', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 't');
    const preds = (e as any).predicateLocks.get('a') as Set<any>;
    expect(preds).toBeDefined();
    expect([...preds][0].table).toBe('t');
  });
});

describe('MVCCExecutor recordInsertRow boundaries', () => {
  it('records inserted rows per table', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordInsertRow('a', 'users', { id: 1 });
    e.recordInsertRow('a', 'users', { id: 2 });
    const tableMap = (e as any).insertedRowData.get('a');
    expect(tableMap.get('users').length).toBe(2);
  });
});

describe('MVCCExecutor detectSerializationConflict predicate range precision (P0 fix)', () => {
  it('out-of-range INSERT does NOT create a phantom rw-dependency', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    // A has a predicate lock on users.id BETWEEN 1 AND 10.
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 10 });
    // B inserts id=999 (out of range) — must NOT trigger a phantom edge.
    e.recordInsertRow('b', 'users', { id: 999 });
    const r = (e as any).detectSerializationConflict('a');
    expect(r.conflict).toBe(false);
  });

  it('in-range INSERT DOES create a phantom rw-dependency', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 10 });
    e.recordInsertRow('b', 'users', { id: 5 });
    // In-range insert → A→B edge. One-way (no cycle) → detectSerializationConflict
    // is false, but the phantom is caught by detectPredicateConflict.
    expect((e as any).detectPredicateConflict('a')).toBe(true);
  });

  it('out-of-range INSERT does NOT trigger detectPredicateConflict', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 10 });
    e.recordInsertRow('b', 'users', { id: 999 });
    expect((e as any).detectPredicateConflict('a')).toBe(false);
  });
});
