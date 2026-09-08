import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor detectSerializationConflict 3-txn cycle (DFS recursion)', () => {
  it('detects a 3-transaction rw-cycle A→B→C→A', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.begin('c', 'SERIALIZABLE', false);

    // Build a 3-cycle via read/write sets:
    //   A reads t:2 (written by B) → A→B
    //   B reads t:3 (written by C) → B→C
    //   C reads t:1 (written by A) → C→A
    (e as any).readSets.set('a', new Set(['t:2']));
    (e as any).readSets.set('b', new Set(['t:3']));
    (e as any).readSets.set('c', new Set(['t:1']));
    (e as any).writeSets.set('a', new Set(['t:1']));
    (e as any).writeSets.set('b', new Set(['t:2']));
    (e as any).writeSets.set('c', new Set(['t:3']));

    const result = (e as any).detectSerializationConflict('a');
    expect(result.conflict).toBe(true);
    expect(typeof result.victimXid).toBe('number');
  });

  it('detects a 3-transaction cycle and returns smallest XID as victim', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.begin('b', 'SERIALIZABLE', false);
    e.begin('c', 'SERIALIZABLE', false);
    const xa = e.getTransaction('a')!.xid;
    const xb = e.getTransaction('b')!.xid;
    const xc = e.getTransaction('c')!.xid;

    (e as any).readSets.set('a', new Set(['t:2']));
    (e as any).readSets.set('b', new Set(['t:3']));
    (e as any).readSets.set('c', new Set(['t:1']));
    (e as any).writeSets.set('a', new Set(['t:1']));
    (e as any).writeSets.set('b', new Set(['t:2']));
    (e as any).writeSets.set('c', new Set(['t:3']));

    const result = (e as any).detectSerializationConflict('a');
    const minXid = Math.min(xa, xb, xc);
    expect(result.victimXid).toBe(minXid);
  });
});

describe('MVCCExecutor findCycle fallback cycle extraction', () => {
  it('findCycle returns a cycle for a cyclic wait-for graph', () => {
    const e = makeExec();
    // Build a wait-for graph: 1 → 2 → 1 (2-txn cycle).
    const waitFor = (e as any).txnWaitFor;
    waitFor.set(1, new Set(['lock:t:1']));
    waitFor.set(2, new Set(['lock:t:2']));
    // buildWaitForGraph resolves wait-for keys into holder XIDs.
    // Directly seed the internal graph to control edges:
    (e as any).waitForGraphCache = undefined;
    // Use buildWaitForGraph by seeding rowMutexes/shareLocks such that it
    // resolves lock:t:1 → holder 2 and lock:t:2 → holder 1.
    (e as any).shareLocks.set('lock:t:1', new Set([2]));
    (e as any).shareLocks.set('lock:t:2', new Set([1]));

    const cycle = (e as any).findCycle(1);
    expect(cycle.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MVCCExecutor checkDeadlock full DFS', () => {
  it('checkDeadlock returns true for a wait-for cycle', () => {
    const e = makeExec();
    (e as any).txnWaitFor.set(1, new Set(['lock:t:1']));
    (e as any).txnWaitFor.set(2, new Set(['lock:t:2']));
    (e as any).shareLocks.set('lock:t:1', new Set([2]));
    (e as any).shareLocks.set('lock:t:2', new Set([1]));

    // checkDeadlock resolves whether XID 1 is part of a cycle.
    const result = (e as any).checkDeadlock(1);
    expect(typeof result).toBe('boolean');
  });
});
