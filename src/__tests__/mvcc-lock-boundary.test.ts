import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor acquireRowWriteLock contention & deadlock boundaries', () => {
  it('returns deadlocked immediately if txn already marked deadlocked', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const aTxn = e.getTransaction('a')!;
    (e as any).txnDeadlocked.add(aTxn.xid);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe('deadlocked');
  });

  it('own write lock is re-acquired (returns true)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true); // re-entrant
  });

  it('returns false when contended but no deadlock cycle', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
    // b attempts to acquire same row -> contention, no cycle
    expect(e.acquireRowWriteLock('b', 't', 1)).toBe(false);
  });

  it('share→write contention returns false without deadlock detection', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    expect(e.acquireRowWriteLock('b', 't', 1)).toBe(false);
  });

  it('returns true when no contention (fresh row)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.acquireRowWriteLock('a', 't', 1)).toBe(true);
  });
});

describe('MVCCExecutor releaseWriteLock queue handoff', () => {
  it('releaseWriteLockByKey hands the lock to a queued waiter', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    const p = e.acquireWriteLock('b', 't', 1, 5000);
    e.releaseWriteLock('t', 1);
    const wait = await p;
    expect(wait).toBeGreaterThanOrEqual(0);
    // After handoff, the wait-for entry is cleared.
    const bTxn = e.getTransaction('b')!;
    expect((e as any).txnWaitFor.has(bTxn.xid)).toBe(false);
  });

  it('releaseWriteLockByKey with empty queue deletes lock', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    e.releaseWriteLock('t', 1);
    expect((e as any).writeLocks.has('t:1')).toBe(false);
    expect((e as any).writeQueues.has('t:1')).toBe(false);
  });
});

describe('MVCCExecutor getTxnXid / share lock edge cases', () => {
  it('getTxnXid returns undefined for read-only or unknown session', () => {
    const e = makeExec();
    expect(e.getTxnXid('ghost')).toBeUndefined();
    e.begin('ro', 'READ_COMMITTED', true);
    expect(e.getTxnXid('ro')).toBeUndefined();
  });

  it('acquireRowShareLock returns true for read-only txn', () => {
    const e = makeExec();
    e.begin('ro', 'READ_COMMITTED', true);
    expect(e.acquireRowShareLock('ro', 't', 1)).toBe(true);
  });

  it('acquireRowShareLock registers own write lock as compatible', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    expect(e.acquireRowShareLock('a', 't', 1)).toBe(true);
    expect((e as any).shareLocks.has('t:1')).toBe(true);
  });

  it('releaseRowShareLock removes holder and deletes empty set', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.acquireRowShareLock('a', 't', 1);
    e.releaseRowShareLock('a', 't', 1);
    expect((e as any).shareLocks.has('t:1')).toBe(false);
  });

  it('releaseRowShareLock is a no-op for unknown session', () => {
    const e = makeExec();
    expect(() => e.releaseRowShareLock('ghost', 't', 1)).not.toThrow();
  });
});

describe('MVCCExecutor table lock edge cases', () => {
  it('lockTable returns true for unknown session (no txn)', () => {
    const e = makeExec();
    expect(e.lockTable('ghost', 'users')).toBe(true);
  });

  it('lockTable rejects incompatible lock with nowait', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.lockTable('a', 'users', 'ACCESS EXCLUSIVE')).toBe(true);
    expect(e.lockTable('b', 'users', 'ACCESS EXCLUSIVE', true)).toBe(false);
  });

  it('lockTable allows compatible shared locks', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.lockTable('a', 'users', 'ACCESS SHARE')).toBe(true);
    expect(e.lockTable('b', 'users', 'ACCESS SHARE')).toBe(true);
  });

  it('releaseTxnTableLocks removes all held locks on commit', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.lockTable('a', 'users', 'ACCESS EXCLUSIVE');
    e.commit('a');
    expect((e as any).tableLocks.has('USERS')).toBe(false);
  });
});
