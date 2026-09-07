import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectDeadlocks youngest-victim selection', () => {
  it('marks youngest active txn deadlocked when a cycle exists', () => {
    const e = makeExec();
    // Two transactions started in order → a older, b younger (larger xid).
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;

    // Build a 2-node wait-for cycle: a waits on k1 held by b; b waits on k2 held by a.
    (e as any).txnWaitFor.set(a.xid, 'k1');
    (e as any).txnWaitFor.set(b.xid, 'k2');
    (e as any).txnWriteLocks.set(b.xid, new Set(['k1']));
    (e as any).txnWriteLocks.set(a.xid, new Set(['k2']));

    (e as any).detectDeadlocks();
    // The younger txn (b, larger xid) is chosen as victim.
    expect((e as any).txnDeadlocked.has(b.xid)).toBe(true);
    expect((e as any).txnDeadlocked.has(a.xid)).toBe(false);
  });

  it('returns early when no wait-for relationships', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).detectDeadlocks(); // no throw, no deadlock
    expect((e as any).txnDeadlocked.size).toBe(0);
  });

  it('returns early when graph has no cycle', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    // Single-direction edge a → b (no cycle).
    (e as any).txnWaitFor.set(a.xid, 'k1');
    (e as any).txnWriteLocks.set(b.xid, new Set(['k1']));
    (e as any).detectDeadlocks();
    expect((e as any).txnDeadlocked.size).toBe(0);
  });
});

describe('MVCCExecutor releaseWriteLockByKey queue handoff', () => {
  it('hands off to next waiter when queue has entries', () => {
    const e = makeExec();
    // Prime a queue with a single waiter entry, then release.
    let resolved = false;
    (e as any).writeQueues.set('t:1', [{ xid: 99, resolve: () => { resolved = true; }, reject: () => {} }]);
    (e as any).writeLocks.add('t:1');
    (e as any).releaseWriteLockByKey('t:1');
    expect(resolved).toBe(true);
    expect((e as any).writeQueues.has('t:1')).toBe(false);
  });

  it('removes lock when queue empties to the else branch', () => {
    const e = makeExec();
    (e as any).writeLocks.add('t:1');
    (e as any).releaseWriteLockByKey('t:1'); // no queue → delete lock
    expect((e as any).writeLocks.has('t:1')).toBe(false);
  });

  it('keeps queue when more than one waiter remains', () => {
    const e = makeExec();
    const queue = [
      { xid: 1, resolve: () => {}, reject: () => {} },
      { xid: 2, resolve: () => {}, reject: () => {} },
    ];
    (e as any).writeQueues.set('t:1', queue);
    (e as any).writeLocks.add('t:1');
    (e as any).releaseWriteLockByKey('t:1');
    expect((e as any).writeQueues.has('t:1')).toBe(true);
    expect((e as any).writeQueues.get('t:1').length).toBe(1);
  });
});

describe('MVCCExecutor share lock holder teardown', () => {
  it('deletes shareLocks entry when last holder released', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).shareLocks.set('t:1', new Set([a.xid]));
    (e as any).txnShareLocks.set(a.xid, new Set(['t:1']));
    (e as any).releaseTxnShareLocks(a.xid);
    expect((e as any).shareLocks.has('t:1')).toBe(false);
  });

  it('keeps shareLocks entry when other holders remain', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    (e as any).shareLocks.set('t:1', new Set([a.xid, b.xid]));
    (e as any).txnShareLocks.set(a.xid, new Set(['t:1']));
    (e as any).releaseTxnShareLocks(a.xid);
    expect((e as any).shareLocks.get('t:1').has(b.xid)).toBe(true);
    expect((e as any).shareLocks.get('t:1').has(a.xid)).toBe(false);
  });

  it('releaseRowShareLock clears txnShareLocks when empty', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).shareLocks.set('t:1', new Set([a.xid]));
    (e as any).txnShareLocks.set(a.xid, new Set(['t:1']));
    e.releaseRowShareLock('a', 't', 1);
    expect((e as any).txnShareLocks.has(a.xid)).toBe(false);
  });
});
