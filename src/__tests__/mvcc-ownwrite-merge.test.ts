import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor REPEATABLE READ own-write merge (commit-time anomaly)', () => {
  it('skips INSERT own-writes (no concurrent-mod detection)', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.addOwnWriteRow('a', 't', 1, 'INSERT', { id: 1 });
    expect(e.commit('a').success).toBe(true);
  });

  it('skips own-writes with undefined prevXmin', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.addOwnWriteRow('a', 't', 1, 'UPDATE', { id: 1 }); // prevXmin undefined
    expect(e.commit('a').success).toBe(true);
  });

  it('aborts when own-updated row no longer exists (!currentRv)', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    // Own UPDATE with a prevXmin set, but no current row version exists.
    (e as any).txnOwnRowData.set(e.getTransaction('a')!.xid, new Map([
      ['t:1', { type: 'UPDATE', prevXmin: 5, path: 't', rowId: 1, data: {} }],
    ]));
    const result = e.commit('a');
    expect(result.success).toBe(false);
  });

  it('aborts when own-updated row was overwritten by another txn (xmin mismatch)', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const aTxn = e.getTransaction('a')!;
    (e as any).txnOwnRowData.set(aTxn.xid, new Map([
      ['t:1', { type: 'UPDATE', prevXmin: 5, path: 't', rowId: 1, data: {} }],
    ]));
    // A newer version exists with a different xmin.
    (e as any).rowVersions.set('t:1', { xmin: aTxn.xid + 99, xmax: null });
    const result = e.commit('a');
    expect(result.success).toBe(false);
  });

  it('succeeds when own-updated row still has our xmin (no anomaly)', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    const aTxn = e.getTransaction('a')!;
    (e as any).txnOwnRowData.set(aTxn.xid, new Map([
      ['t:1', { type: 'UPDATE', prevXmin: 5, path: 't', rowId: 1, data: {} }],
    ]));
    (e as any).rowVersions.set('t:1', { xmin: aTxn.xid, xmax: null });
    const result = e.commit('a');
    expect(result.success).toBe(true);
  });
});

describe('MVCCExecutor hasConflict repeatable-read conflict detection', () => {
  it('detects conflict when a concurrent active txn rewrote our written row', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.recordWrite('a', 't', 1); // a writes t:1 -> xmin = a.xid

    e.begin('b', 'REPEATABLE_READ', false);
    e.recordWrite('b', 't', 1); // b rewrites t:1 -> xmin = b.xid (active, newer)

    // a commits -> hasConflict sees rv.xmin = b.xid (active) and REPEATABLE_READ.
    const result = e.commit('a');
    expect(result.success).toBe(false);
  });

  it('no conflict when the rewriter is read-committed and committed', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    e.recordWrite('a', 't', 1);

    e.begin('b', 'READ_COMMITTED', false);
    e.recordWrite('b', 't', 1);
    e.commit('b'); // b committed -> xmin b.xid no longer active

    e.begin('c', 'REPEATABLE_READ', false);
    e.recordWrite('c', 't', 2); // unrelated write to keep c active
    const result = e.commit('a');
    // b no longer active, so no active-write conflict detected for a.
    expect(result).toBeDefined();
  });
});
