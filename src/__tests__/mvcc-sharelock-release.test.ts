import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor share lock acquisition boundaries', () => {
  it('acquireRowShareLock registers own-write-lock shared lock (first-time sets)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // This txn already holds the write lock on t:1.
    (e as any).writeLocks.add('t:1');
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));

    const ok = e.acquireRowShareLock('a', 't', 1);
    expect(ok).toBe(true);
    expect((e as any).shareLocks.get('t:1').has(a.xid)).toBe(true);
    expect((e as any).txnShareLocks.get(a.xid).has('t:1')).toBe(true);
  });

  it('acquireRowShareLock returns false on other-txn write lock contention', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).writeLocks.add('t:1');
    (e as any).txnWriteLocks.set(a.xid + 1, new Set(['t:1'])); // other txn owns it
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(false);
  });

  it('acquireRowShareLock registers normal shared lock (no write lock)', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    const s = e.getTransaction('s')!;
    const ok = e.acquireRowShareLock('s', 't', 5);
    expect(ok).toBe(true);
    expect((e as any).shareLocks.get('t:5').has(s.xid)).toBe(true);
    expect((e as any).txnShareLocks.get(s.xid).has('t:5')).toBe(true);
  });

  it('acquireRowShareLock returns true for read-only txn (no locking)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', true); // read-only
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
  });
});

describe('MVCCExecutor share lock release boundaries', () => {
  it('hasOtherShareLock returns true when another holder exists', () => {
    const e = makeExec();
    (e as any).shareLocks.set('t:1', new Set([100, 200]));
    expect((e as any).hasOtherShareLock(100, 't:1')).toBe(true);
    expect((e as any).hasOtherShareLock(999, 't:1')).toBe(true);
  });

  it('hasOtherShareLock returns false when only self holds or empty', () => {
    const e = makeExec();
    (e as any).shareLocks.set('t:1', new Set([100]));
    expect((e as any).hasOtherShareLock(100, 't:1')).toBe(false);
    expect((e as any).hasOtherShareLock(100, 'missing')).toBe(false);
  });

  it('releaseTxnShareLocks deletes shareLocks entry when empty', () => {
    const e = makeExec();
    (e as any).shareLocks.set('t:1', new Set([100]));
    (e as any).txnShareLocks.set(100, new Set(['t:1']));
    (e as any).releaseTxnShareLocks(100);
    expect((e as any).shareLocks.has('t:1')).toBe(false);
    expect((e as any).txnShareLocks.has(100)).toBe(false);
  });

  it('releaseTxnShareLocks keeps shareLocks when other holders remain', () => {
    const e = makeExec();
    (e as any).shareLocks.set('t:1', new Set([100, 200]));
    (e as any).txnShareLocks.set(100, new Set(['t:1']));
    (e as any).releaseTxnShareLocks(100);
    expect((e as any).shareLocks.get('t:1').has(200)).toBe(true);
  });

  it('releaseRowShareLock deletes both maps when last holders removed', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).shareLocks.set('t:1', new Set([a.xid]));
    (e as any).txnShareLocks.set(a.xid, new Set(['t:1']));

    e.releaseRowShareLock('a', 't', 1);
    expect((e as any).shareLocks.has('t:1')).toBe(false);
    expect((e as any).txnShareLocks.has(a.xid)).toBe(false);
  });

  it('releaseRowShareLock keeps maps when other holders remain', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).shareLocks.set('t:1', new Set([a.xid, 200]));
    (e as any).txnShareLocks.set(a.xid, new Set(['t:1', 't:2']));

    e.releaseRowShareLock('a', 't', 1);
    expect((e as any).shareLocks.get('t:1').has(200)).toBe(true);
    expect((e as any).txnShareLocks.get(a.xid).has('t:2')).toBe(true);
  });

  it('releaseRowShareLock is a no-op for unknown session', () => {
    const e = makeExec();
    expect(() => e.releaseRowShareLock('ghost', 't', 1)).not.toThrow();
  });
});

describe('MVCCExecutor areLockModesCompatible unknown mode fallback', () => {
  it('unknown mode names fall back to rank 1 (ACCESS SHARE)', () => {
    // Both unknown → treated as ACCESS SHARE (rank 1), compatible.
    expect(MVCCExecutor.areLockModesCompatible('FOO', 'BAR')).toBe(true);
    // Unknown (rank 1) vs ACCESS EXCLUSIVE (rank 8) → incompatible.
    expect(MVCCExecutor.areLockModesCompatible('FOO', 'ACCESS EXCLUSIVE')).toBe(false);
  });
});
