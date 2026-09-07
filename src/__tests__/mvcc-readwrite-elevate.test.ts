import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor recordRead/recordWrite readOnly & non-SERIALIZABLE skips', () => {
  it('recordWrite skips read-only txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', true); // read-only
    (e as any).recordWrite('a', 't', 1);
    const a = e.getTransaction('a')!;
    expect((e as any).txnWriteLocks.has(a.xid)).toBe(false);
  });

  it('recordWrite skips unknown session', () => {
    const e = makeExec();
    (e as any).recordWrite('ghost', 't', 1);
    expect((e as any).writeSets.size).toBe(0);
  });

  it('recordRead skips non-SERIALIZABLE txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).recordRead('a', 't', 1);
    const a = e.getTransaction('a')!;
    expect((e as any).txnReadSets.has(a.xid)).toBe(false);
  });

  it('recordRead creates txnReadSets on first SERIALIZABLE read', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    (e as any).recordRead('a', 't', 1);
    const a = e.getTransaction('a')!;
    expect((e as any).txnReadSets.get(a.xid).has('t:1')).toBe(true);
  });

  it('recordReadOperation skips read-only txn', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', true); // read-only
    (e as any).recordReadOperation('a', 't', '1');
    expect((e as any).readSets.has('a')).toBe(false);
  });

  it('recordReadOperation records to both readSets and txnReadSets', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    (e as any).recordReadOperation('a', 't', '1');
    const a = e.getTransaction('a')!;
    expect((e as any).readSets.get('a').has('t:1')).toBe(true);
    expect((e as any).txnReadSets.get(a.xid).has('t:1')).toBe(true);
  });
});

describe('MVCCExecutor elevateSession / getEffectiveIsolation', () => {
  it('elevateSession resets currentIsolation to original and clears nextElevationAt', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    (e as any).elevateSession('s');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('SERIALIZABLE');
    expect(rec.nextElevationAt).toBeNull();
  });

  it('elevateSession updates active txn isolation when present', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    (e as any).elevateSession('s');
    const txn = e.getTransaction('s')!;
    expect((e as any).txnIsolation.get(txn.xid)).toBe('SERIALIZABLE');
  });

  it('elevateSession is a no-op for unknown session', () => {
    const e = makeExec();
    expect(() => (e as any).elevateSession('ghost')).not.toThrow();
  });

  it('getEffectiveIsolation returns degraded currentIsolation', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    expect(e.getEffectiveIsolation('s')).toBe('REPEATABLE_READ');
  });

  it('getEffectiveIsolation returns active txn isolation when no degradation', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    expect(e.getEffectiveIsolation('s')).toBe('SERIALIZABLE');
  });

  it('getEffectiveIsolation returns READ_COMMITTED for unknown session', () => {
    const e = makeExec();
    expect(e.getEffectiveIsolation('ghost')).toBe('READ_COMMITTED');
  });
});
