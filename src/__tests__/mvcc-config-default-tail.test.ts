import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor commit path config ?? default branches (no config)', () => {
  it('commit uses maxRowVersions ?? 100_000 and threshold ?? 0.8 defaults', () => {
    const e = makeExec({}); // no maxRowVersions / rowVersionGcThreshold
    e.begin('a', 'READ_COMMITTED', false);
    const r = e.commit('a');
    expect(r.success).toBe(true);
  });
});

describe('MVCCExecutor getSelectVisibility / getSelectVisibilityForSession isolation fallback', () => {
  it('falls back to READ_COMMITTED when txnIsolation missing', () => {
    const e = makeExec({});
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.delete(a.xid);
    const vis = e.getSelectVisibility('a');
    expect(vis!.isolation).toBe('READ_COMMITTED');
  });
});

describe('MVCCExecutor backoffBaseMs ?? 10 default', () => {
  it('uses backoffBaseMs default 10 when config omits it', () => {
    const e = makeExec({});
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).conflictStats.set('a', { totalRetries: 2 });
    expect((e as any).getBackoffMs('a')).toBe(20); // 10 * 2^(2-1)
  });
});
