import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor SSI read/write set recording (repeat & cleanup)', () => {
  it('recordReadOperation accumulates multiple rows into the same readSet', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordReadOperation('a', 't', '1');
    e.recordReadOperation('a', 't', '2');
    const readSet = (e as any).readSets.get('a') as Set<string>;
    expect(readSet.size).toBe(2);
    expect(readSet.has('t:1')).toBe(true);
    expect(readSet.has('t:2')).toBe(true);
  });

  it('recordReadOperation also populates txnReadSets', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const aTxn = e.getTransaction('a')!;
    e.recordReadOperation('a', 't', '1');
    const txnRead = (e as any).txnReadSets.get(aTxn.xid) as Set<string>;
    expect(txnRead.has('t:1')).toBe(true);
  });

  it('recordReadOperation ignores non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordReadOperation('a', 't', '1');
    expect((e as any).readSets.has('a')).toBe(false);
  });

  it('recordWrite records to writeSets for SSI', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordWrite('a', 't', 1);
    const writeSet = (e as any).writeSets.get('a') as Set<string>;
    expect(writeSet.has('t:1')).toBe(true);
  });

  it('cleanupReadWriteSets removes read/write/predicate/insert sets', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordReadOperation('a', 't', '1');
    e.recordWrite('a', 't', 1);
    e.recordPredicateLock('a', 'users', { column: 'id', eqValue: 5 });
    e.recordInsertRow('a', 'users', { id: 5 });
    e.cleanupReadWriteSets('a');
    expect((e as any).readSets.has('a')).toBe(false);
    expect((e as any).writeSets.has('a')).toBe(false);
    expect((e as any).predicateLocks.has('a')).toBe(false);
    expect((e as any).insertedRowData.has('a')).toBe(false);
  });

  it('cleanupReadWriteSets removes committedPredicateWrites for this txn', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    const aTxn = e.getTransaction('a')!;
    // a holds a predicate lock; b inserts a matching row -> committed write.
    e.recordPredicateLock('a', 'users', { column: 'id', eqValue: 5 });
    e.recordInsertRow('b', 'users', { id: 5 });
    expect((e as any).committedPredicateWrites.length).toBe(1);
    e.cleanupReadWriteSets('a');
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });
});

describe('MVCCExecutor recordInsertRow predicate matching (in-range vs out-of-range)', () => {
  it('records committedPredicateWrite only when INSERT matches predicate range', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.recordPredicateLock('a', 'users', { column: 'id', minValue: 1, maxValue: 10 });
    e.recordInsertRow('b', 'users', { id: 5 });   // in-range → recorded
    e.recordInsertRow('b', 'users', { id: 999 }); // out-of-range → not recorded
    expect((e as any).committedPredicateWrites.length).toBe(1);
  });

  it('recordInsertRow skips predicate matching for non-SERIALIZABLE inserter', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('rc', 'READ_COMMITTED', false);  // non-serializable inserter
    e.recordPredicateLock('a', 'users', { column: 'id', eqValue: 5 });
    e.recordInsertRow('rc', 'users', { id: 5 });
    // rc is not SERIALIZABLE, so its INSERT does not trigger predicate matching.
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });

  it('recordInsertRow skips predicate matching against read-only predicate holder', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', true);  // read-only holder → skipped in loop
    e.begin('c', 'SERIALIZABLE', false);
    e.recordPredicateLock('b', 'users', { column: 'id', eqValue: 5 });
    e.recordInsertRow('c', 'users', { id: 5 });
    // b is read-only, so the loop skips it; no committed write recorded for b.
    expect((e as any).committedPredicateWrites.length).toBe(0);
  });
});
