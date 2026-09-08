import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectDeadlocks 3-node cycle (DFS recursion)', () => {
  it('detects a 3-node wait-for cycle and marks youngest victim', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.begin('c', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!; // xid smallest
    const b = e.getTransaction('b')!;
    const c = e.getTransaction('c')!; // xid largest (youngest)

    // 3-node cycle: a→b→c→a
    // a waits on kb (held by b), b waits on kc (held by c), c waits on ka (held by a).
    (e as any).txnWaitFor.set(a.xid, 'kb');
    (e as any).txnWaitFor.set(b.xid, 'kc');
    (e as any).txnWaitFor.set(c.xid, 'ka');
    (e as any).txnWriteLocks.set(b.xid, new Set(['kb']));
    (e as any).txnWriteLocks.set(c.xid, new Set(['kc']));
    (e as any).txnWriteLocks.set(a.xid, new Set(['ka']));

    (e as any).detectDeadlocks();
    expect((e as any).txnDeadlocked.has(c.xid)).toBe(true);
  });
});

describe('MVCCExecutor detectDeadlocks edges-empty and youngest-false branches', () => {
  it('returns early when txnWaitFor non-empty but graph has no edges', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    // txnWaitFor has a waiter, but no writeLocks resolve the key → empty edges.
    (e as any).txnWaitFor.set(a.xid, 'unheld-key');
    expect(() => (e as any).detectDeadlocks()).not.toThrow();
    expect((e as any).txnDeadlocked.size).toBe(0);
  });

  it('youngest selection false branch (a txn with xid not greater than youngest)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;

    // 2-node cycle so the youngest loop runs.
    (e as any).txnWaitFor.set(a.xid, 'k1');
    (e as any).txnWaitFor.set(b.xid, 'k2');
    (e as any).txnWriteLocks.set(b.xid, new Set(['k1']));
    (e as any).txnWriteLocks.set(a.xid, new Set(['k2']));

    (e as any).detectDeadlocks();
    expect((e as any).txnDeadlocked.has(b.xid)).toBe(true);
  });
});
