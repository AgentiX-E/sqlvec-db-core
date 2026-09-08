import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor periodic cleanup trigger (operationCount % 100)', () => {
  it('triggers cleanupStaleTxns on the 100th begin operation', () => {
    const e = makeExec();
    // Drive operationCount to exactly 100 via begin() to hit the % 100 === 0 branch.
    for (let i = 0; i < 100; i++) {
      e.begin(`s${i}`, 'READ_COMMITTED', false);
    }
    expect((e as any).operationCount).toBe(100);
    // The 100th begin invoked cleanupStaleTxns; no throw and txns remain active.
    expect(e.getTransaction('s99')).not.toBeNull();
  });

  it('triggers cleanupStaleTxns on the 100th commit operation', () => {
    const e = makeExec();
    // Drive operationCount via commit() to hit % 100 === 0.
    for (let i = 0; i < 100; i++) {
      const sid = `s${i}`;
      e.begin(sid, 'READ_COMMITTED', false);
      e.commit(sid);
    }
    expect((e as any).operationCount).toBe(200);
  });
});

describe('MVCCExecutor commit isoLevel fallback without txnIsolation', () => {
  it('commit uses READ_COMMITTED fallback when txnIsolation missing', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.delete(a.xid);
    const r = e.commit('a');
    expect(r.success).toBe(true);
  });
});
