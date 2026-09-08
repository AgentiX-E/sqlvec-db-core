import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor isolation fallback (|| READ_COMMITTED without txnIsolation)', () => {
  it('getIsolationForSession falls back to READ_COMMITTED when txnIsolation missing', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.delete(a.xid); // simulate missing isolation mapping
    expect(e.getIsolationForSession('a')).toBe('READ_COMMITTED');
  });

  it('getEffectiveIsolation falls back when txn exists but no isolation', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.delete(a.xid);
    expect((e as any).getEffectiveIsolation('a')).toBe('READ_COMMITTED');
  });

  it('getSelectVisibility falls back to READ_COMMITTED without txnIsolation', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnIsolation.delete(a.xid);
    const vis = e.getSelectVisibility('a');
    expect(vis!.isolation).toBe('READ_COMMITTED');
  });

  it('hasConflict uses READ_COMMITTED fallback without txnIsolation', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnWriteLocks.set(a.xid, new Set(['t:1']));
    // Seed a row version written by an active txn newer than our snapshot,
    // so the conflict scan can actually flag it (exercising the iso fallback).
    (e as any).rowVersions.set('t:1', { xmin: a.xid + 100, xmax: null });
    (e as any).activeXidSet.add(a.xid + 100);
    (e as any).txnIsolation.delete(a.xid);
    expect((e as any).hasConflict(a)).toBe(true);
  });
});

describe('MVCCExecutor config ?? default fallback branches', () => {
  it('gcRowVersions uses maxRowVersions ?? 100_000 default when config omitted', () => {
    const e = makeExec({}); // no maxRowVersions/threshold
    // force gc with defaults; empty map → expected 0 freed.
    expect(e.gcRowVersions(true)).toBe(0);
  });

  it('getBackoffMs uses backoffBaseMs ?? 10 default', () => {
    const e = makeExec({});
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).conflictStats.set('a', { totalRetries: 3, retries: 1 });
    const backoff = (e as any).getBackoffMs('a');
    // base 10 * 2^(3-1) = 40
    expect(backoff).toBe(40);
  });
});
