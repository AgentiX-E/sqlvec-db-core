import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor recordDegradation boundaries', () => {
  it('records SERIALIZABLE -> REPEATABLE_READ with original preserved', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.originalIsolation).toBe('SERIALIZABLE');
    expect(rec.currentIsolation).toBe('REPEATABLE_READ');
    expect(rec.totalDegradations).toBe(1);
    expect((e as any).conflictStats.has('s')).toBe(false); // stats cleared
  });

  it('records REPEATABLE_READ -> READ_COMMITTED', () => {
    const e = makeExec();
    e.recordDegradation('s', 'REPEATABLE_READ', 5);
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.originalIsolation).toBe('REPEATABLE_READ');
    expect(rec.currentIsolation).toBe('READ_COMMITTED');
  });

  it('increments totalDegradations on repeated recordDegradation', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.totalDegradations).toBe(2);
  });
});

describe('MVCCExecutor getEffectiveIsolation / normalizeIsolation', () => {
  it('returns degraded current isolation over the active txn level', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    expect(e.getEffectiveIsolation('s')).toBe('REPEATABLE_READ');
  });

  it('returns active txn isolation when no degradation record', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    expect(e.getEffectiveIsolation('s')).toBe('SERIALIZABLE');
  });

  it('returns READ_COMMITTED for unknown session', () => {
    const e = makeExec();
    expect(e.getEffectiveIsolation('ghost')).toBe('READ_COMMITTED');
  });

  it('normalizeIsolation maps case-insensitive variants to canonical levels', () => {
    const e = makeExec();
    expect((e as any).normalizeIsolation('serializable')).toBe('SERIALIZABLE');
    expect((e as any).normalizeIsolation('REPEATABLE READ')).toBe('REPEATABLE_READ');
    expect((e as any).normalizeIsolation('READ COMMITTED')).toBe('READ_COMMITTED');
    expect((e as any).normalizeIsolation('read uncommitted')).toBe('READ_COMMITTED');
  });
});

describe('MVCCExecutor shouldDegrade boundaries', () => {
  it('returns false when no conflict stats', () => {
    const e = makeExec();
    expect(e.shouldDegrade('ghost', 'SERIALIZABLE')).toBe(false);
  });

  it('returns false for unknown isolation level', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { conflictCount: 10 });
    expect(e.shouldDegrade('s', 'READ_COMMITTED')).toBe(false);
  });
});

describe('MVCCExecutor elevateSession / checkElevation boundaries', () => {
  it('elevateSession restores original isolation and resets stats', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    (e as any).conflictStats.set('s', { conflictCount: 5 });
    e.begin('s', 'REPEATABLE_READ', false); // active txn at degraded level
    (e as any).elevateSession('s');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('SERIALIZABLE');
    expect(rec.nextElevationAt).toBeNull();
    expect((e as any).conflictStats.get('s').conflictCount).toBe(0);
    const txn = e.getTransaction('s')!;
    expect((e as any).txnIsolation.get(txn.xid)).toBe('SERIALIZABLE');
  });

  it('elevateSession is a no-op without a degradation record', () => {
    const e = makeExec();
    (e as any).elevateSession('ghost'); // should not throw
    expect((e as any).degradationRecords.has('ghost')).toBe(false);
  });

  it('checkElevation is a no-op without a record', () => {
    const e = makeExec();
    (e as any).checkElevation('ghost'); // no throw
  });

  it('checkElevation re-elevates when cooldown passed', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    // Force nextElevationAt into the past.
    const rec = (e as any).degradationRecords.get('s');
    rec.nextElevationAt = Date.now() - 1000;
    (e as any).checkElevation('s');
    expect((e as any).degradationRecords.get('s').currentIsolation).toBe('SERIALIZABLE');
  });
});
