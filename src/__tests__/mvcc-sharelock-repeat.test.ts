import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor acquireRowShareLock repeated-lock (existing map) branches', () => {
  it('reuses existing shareLocks/txnShareLocks on second share lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    // Second share lock (different row, same txn) — txnShareLocks already has xid.
    expect(e.acquireRowShareLock('a', 't', 2)).toBe(true);
    const added = (e as any).shareLocks.get('t:1');
    expect([...(e as any).txnShareLocks.get(a.xid)]).toEqual(expect.arrayContaining(['t:1', 't:2']));
  });

  it('reuses existing shareLocks key on second share lock same row (different txn)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    // Same row, different txn — shareLocks already has 't:1'.
    expect(e.acquireRowShareLock('b', 't', 1)).toBe(true);
    const holders = (e as any).shareLocks.get('t:1');
    expect(holders.size).toBe(2);
  });

  it('own write lock is compatible with own share lock (registers share lock)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    // Now acquire a share lock on the same row → own write lock compatible.
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    expect((e as any).txnShareLocks.get(a.xid).has('t:1')).toBe(true);
  });
});

describe('MVCCExecutor recordRead repeated (txnReadSets existing)', () => {
  it('reuses existing txnReadSets on second read', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    e.recordRead('a', 't', 1);
    e.recordRead('a', 't', 2); // txnReadSets already exists.
    const rs = (e as any).txnReadSets.get(a.xid);
    expect(rs.has('t:1')).toBe(true);
    expect(rs.has('t:2')).toBe(true);
  });
});

describe('MVCCExecutor recordPredicateLock repeated (predicateLocks existing)', () => {
  it('reuses existing predicateLocks set on second lock', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.set(a.xid, 'SERIALIZABLE');
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 0, maxValue: 10 });
    e.recordPredicateLock('a', 't', { column: 'age', minValue: 20, maxValue: 30 });
    expect((e as any).predicateLocks.get('a').size).toBe(2);
  });
});

describe('MVCCExecutor releaseTxnTableLocks', () => {
  it('releases table locks held by a txn (lockMap.has true)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // Seed a table lock for this xid.
    (e as any).tableLocks.set('t', new Map([[a.xid, 'ACCESS_SHARE']]));
    (e as any).releaseTxnTableLocks(a.xid);
    // lockMap becomes empty after delete → tableLocks entry removed entirely.
    expect((e as any).tableLocks.has('t')).toBe(false);
  });
});
