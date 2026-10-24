/**
 * Unit tests for MVCCExecutor deep deadlock/cycle branches — the victim-is-self
 * return, and the DFS early-return paths reached only by traversing a
 * multi-node wait-for / rw-dependency cycle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor — acquireRowWriteLock returns deadlocked for self-victim', () => {
  it('returns "deadlocked" when the calling txn is the cycle victim (smallest XID)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false); // xid=3 (smallest)
    e.begin('b', 'READ_COMMITTED', false); // xid=4

    // A holds t:1, B holds t:2.
    e.acquireRowWriteLock('a', 't', 1);
    e.acquireRowWriteLock('b', 't', 2);

    // B wants t:1 (held by A) → records a wait-for edge B→A.
    e.acquireRowWriteLock('b', 't', 1);

    // A wants t:2 (held by B) → closes the A↔B cycle. The victim is the
    // smallest XID in the cycle, which is A itself.
    const result = e.acquireRowWriteLock('a', 't', 2);
    expect(result).toBe('deadlocked');
  });

  it('returns false (not deadlocked) when the caller is not the victim', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false); // xid=3
    e.begin('b', 'READ_COMMITTED', false); // xid=4

    e.acquireRowWriteLock('a', 't', 1);
    e.acquireRowWriteLock('b', 't', 2);
    e.acquireRowWriteLock('a', 't', 2); // A waits on t:2 (held by B)
    // B closes the cycle; victim is A (smallest), caller is B → false.
    const result = e.acquireRowWriteLock('b', 't', 1);
    expect(result).toBe(false);
  });
});

describe('MVCCExecutor — detectDeadlocks DFS early-return on long cycle', () => {
  it('hits the post-recursion hasCycle return during a 3-node cycle', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.begin('c', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    const c = e.getTransaction('c')!;

    // 3-node cycle a→b→c→a.
    (e as any).txnWaitFor.set(a.xid, 'kb');
    (e as any).txnWaitFor.set(b.xid, 'kc');
    (e as any).txnWaitFor.set(c.xid, 'ka');
    (e as any).txnWriteLocks.set(b.xid, new Set(['kb']));
    (e as any).txnWriteLocks.set(c.xid, new Set(['kc']));
    (e as any).txnWriteLocks.set(a.xid, new Set(['ka']));

    expect(() => (e as any).detectDeadlocks()).not.toThrow();
    expect((e as any).txnDeadlocked.has(c.xid)).toBe(true);
  });
});
