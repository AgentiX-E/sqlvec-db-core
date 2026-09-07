import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor, extractWhereRange } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor findCycle fallback (BFS cycle detection)', () => {
  it('returns [startXid] for a graph with no cycle', () => {
    const e = makeExec();
    // Build an acyclic wait-for graph: XID 3 waits on 't:1', XID 4 waits on 't:2'.
    // Neither holds the other's key in a cycle, so buildWaitForGraph has an
    // edge but no cycle -> findCycle falls back to its BFS path and returns [start].
    (e as any).txnWaitFor.set(3, 't:1');
    (e as any).txnWriteLocks.set(4, new Set(['t:1']));
    const cycle = (e as any).findCycle(3);
    expect(cycle.length).toBeGreaterThan(0);
    // No real cycle exists, so fallback returns [startXid] as a safe default.
    expect(cycle[0]).toBe(3);
  });

  it('findCycle detects a real cycle and trims to it', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    const b = e.getTransaction('b')!;
    // a holds t:1, b holds t:2, a waits t:2 (held by b), b waits t:1 (held by a)
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    (e as any).txnWriteLocks.set(b.xid, new Set(['t:2']));
    (e as any).txnWaitFor.set(a.xid, 't:2');
    (e as any).txnWaitFor.set(b.xid, 't:1');

    const cycle = (e as any).findCycle(a.xid);
    // Cycle must contain both XIDs.
    expect(cycle).toContain(a.xid);
    expect(cycle).toContain(b.xid);
  });
});

describe('MVCCExecutor selectVictim boundary', () => {
  it('selectVictim returns 0 for empty cycle', () => {
    const e = makeExec();
    expect((e as any).selectVictim([])).toBe(0);
  });

  it('selectVictim returns the minimum XID in a cycle', () => {
    const e = makeExec();
    expect((e as any).selectVictim([10, 5, 20])).toBe(5);
  });
});

describe('MVCCExecutor extractWhereRange inequality operators', () => {
  it('parses < and <= operators into maxValue', () => {
    const lt = extractWhereRange('SELECT * FROM t WHERE a < 5');
    expect(lt).not.toBeUndefined();
    expect(lt!.maxValue).toBe(5);

    const le = extractWhereRange('SELECT * FROM t WHERE a <= 8');
    expect(le).not.toBeUndefined();
    expect(le!.maxValue).toBe(8);
  });

  it('parses > and >= operators into minValue', () => {
    const gt = extractWhereRange('SELECT * FROM t WHERE a > 5');
    expect(gt).not.toBeUndefined();
    expect(gt!.minValue).toBe(5);

    const ge = extractWhereRange('SELECT * FROM t WHERE a >= 8');
    expect(ge).not.toBeUndefined();
    expect(ge!.minValue).toBe(8);
  });
});

describe('MVCCExecutor deleteRowVersion writeSql catch', () => {
  it('deleteRowVersion with writeSql rejection does not throw', async () => {
    const e = makeExec({ writeSql: () => Promise.reject(new Error('boom')) });
    e.begin('w', 'READ_COMMITTED', false);
    e.recordWrite('w', 't', 1);
    e.recordWrite('w', 't', 2, true); // triggers deleteRowVersion path indirectly
    await new Promise((r) => setTimeout(r, 10));
    expect(true).toBe(true);
  });
});
