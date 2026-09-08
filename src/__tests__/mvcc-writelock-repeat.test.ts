import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor acquireRowWriteLock repeated-lock branches', () => {
  it('reuses existing txnWriteLocks/writeSets on second lock acquisition', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    // Second acquisition on a different row — txnWriteLocks/writeSets already exist.
    expect(e.acquireRowWriteLock('a', 't', 2)).toBe(true);
    expect((e as any).txnWriteLocks.get(a.xid).has('t:1')).toBe(true);
    expect((e as any).txnWriteLocks.get(a.xid).has('t:2')).toBe(true);
    expect((e as any).writeSets.get('a').has('t:1')).toBe(true);
    expect((e as any).writeSets.get('a').has('t:2')).toBe(true);
  });

  it('returns true for read-only txn (no locking)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', true);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
  });

  it('returns deadlocked when txn already marked deadlocked', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnDeadlocked.add(a.xid);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe('deadlocked');
  });

  it('re-acquiring own write lock returns true', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true); // own lock re-acquire
  });
});

describe('MVCCExecutor selectVictim', () => {
  it('returns the smallest XID in the cycle', () => {
    const e = makeExec();
    const victim = (e as any).selectVictim([10, 3, 7, 5]);
    expect(victim).toBe(3);
  });

  it('returns 0 for empty cycle', () => {
    const e = makeExec();
    expect((e as any).selectVictim([])).toBe(0);
  });
});

describe('MVCCExecutor releaseWriteLockByKey / releaseTxnWriteLocks', () => {
  it('releaseTxnWriteLocks is a no-op without txnWriteLocks', () => {
    const e = makeExec();
    expect(() => (e as any).releaseTxnWriteLocks(999)).not.toThrow();
  });
});
