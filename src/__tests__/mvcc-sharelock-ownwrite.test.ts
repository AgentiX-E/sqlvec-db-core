import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor own-write-lock + share-lock reuse branches', () => {
  it('reuses shareLocks/txnShareLocks on second own-write-compatible share lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // Acquire write lock on row 1.
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    // First own-write-compatible share lock on row 1 (creates shareLocks/txnShareLocks).
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    // Second own-write-compatible share lock on row 1 (reuses existing maps).
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    const holders = (e as any).shareLocks.get('t:1');
    expect(holders.has(a.xid)).toBe(true);
    expect((e as any).txnShareLocks.get(a.xid).has('t:1')).toBe(true);
  });
});

describe('MVCCExecutor hasOtherShareLock holders branch', () => {
  it('returns true when another txn holds a share lock (holders non-empty)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    e.acquireRowShareLock('b', 't', 1);
    // a tries a write lock; b holds a share lock → contention via hasOtherShareLock.
    (e as any).shareLocks.set('t:1', new Set([b.xid]));
    const result = (e as any).hasOtherShareLock(a.xid, 't:1');
    expect(result).toBe(true);
  });
});
