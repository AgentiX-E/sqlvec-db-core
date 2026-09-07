import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor findCycle fallback (full DFS cycle detection)', () => {
  it('detects a 3-node cycle via fallback when startXid is not in the cycle', () => {
    const e = makeExec();
    // Build wait-for graph edges: 3→4→5→3 (a cycle).
    // waiter 3 waits on key k1 held by 4; 4 waits on k2 held by 5; 5 waits on k3 held by 3.
    (e as any).txnWaitFor.set(3, 'k1');
    (e as any).txnWaitFor.set(4, 'k2');
    (e as any).txnWaitFor.set(5, 'k3');
    (e as any).txnWriteLocks.set(4, new Set(['k1']));
    (e as any).txnWriteLocks.set(5, new Set(['k2']));
    (e as any).txnWriteLocks.set(3, new Set(['k3']));

    // startXid not part of the cycle → main path breaks, fallback DFS runs.
    const cycle = (e as any).findCycle(999);
    expect(Array.isArray(cycle)).toBe(true);
    expect(cycle.length).toBeGreaterThanOrEqual(3);
    // The cycle contains the three XIDs in some order.
    expect(new Set(cycle)).toEqual(new Set([3, 4, 5]));
  });

  it('detects a 2-node cycle via main path directly', () => {
    const e = makeExec();
    (e as any).txnWaitFor.set(3, 'k1');
    (e as any).txnWaitFor.set(4, 'k2');
    (e as any).txnWriteLocks.set(4, new Set(['k1']));
    (e as any).txnWriteLocks.set(3, new Set(['k2']));

    const cycle = (e as any).findCycle(3);
    expect(cycle.length).toBe(2);
    expect(new Set(cycle)).toEqual(new Set([3, 4]));
  });

  it('returns [startXid] when no cycle exists', () => {
    const e = makeExec();
    // Single-direction edge 3→4 (no cycle).
    (e as any).txnWaitFor.set(3, 'k1');
    (e as any).txnWriteLocks.set(4, new Set(['k1']));
    const cycle = (e as any).findCycle(3);
    expect(cycle).toEqual([3]);
  });
});

describe('MVCCExecutor selectVictim', () => {
  it('selects the smallest XID from a cycle', () => {
    const e = makeExec();
    const victim = (e as any).selectVictim([5, 3, 7]);
    expect(victim).toBe(3);
  });

  it('returns first element for empty/single-element cycle', () => {
    const e = makeExec();
    expect((e as any).selectVictim([9])).toBe(9);
  });
});

describe('MVCCExecutor checkDeadlock / buildWaitForGraph edges', () => {
  it('checkDeadlock returns false when no edges', () => {
    const e = makeExec();
    expect((e as any).checkDeadlock()).toBe(false);
  });

  it('checkDeadlock returns true when a 2-cycle exists', () => {
    const e = makeExec();
    (e as any).txnWaitFor.set(3, 'k1');
    (e as any).txnWaitFor.set(4, 'k2');
    (e as any).txnWriteLocks.set(4, new Set(['k1']));
    (e as any).txnWriteLocks.set(3, new Set(['k2']));
    expect((e as any).checkDeadlock()).toBe(true);
  });

  it('buildWaitForGraph skips deadlocked waiters', () => {
    const e = makeExec();
    (e as any).txnDeadlocked.add(3);
    (e as any).txnWaitFor.set(3, 'k1');
    (e as any).txnWriteLocks.set(4, new Set(['k1']));
    const edges = (e as any).buildWaitForGraph();
    expect(edges.has(3)).toBe(false);
  });
});
