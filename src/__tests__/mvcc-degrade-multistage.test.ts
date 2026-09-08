import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

// Helper to set conflictStats for degradation decisions.
function setConflicts(e: MVCCExecutor, sid: string, count: number) {
  const st = (e as any).conflictStats.get(sid) || { conflictCount: 0, totalRetries: 0 };
  st.conflictCount = count;
  (e as any).conflictStats.set(sid, st);
}

describe('MVCCExecutor checkDegradation multi-stage branches', () => {
  it('first degradation SERIALIZABLE→REPEATABLE_READ (existingRec absent)', () => {
    const e = makeExec();
    setConflicts(e, 's', 3); // >= CONFLICTS_BEFORE_DEGRADE_SERIALIZABLE
    (e as any).checkDegradation('s', 'SERIALIZABLE');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('REPEATABLE_READ');
    expect(rec.originalIsolation).toBe('SERIALIZABLE');
    expect(rec.totalDegradations).toBe(1);
  });

  it('second degradation REPEATABLE_READ→READ_COMMITTED preserves originalIsolation', () => {
    const e = makeExec();
    // Stage 1: degrade SERIALIZABLE → REPEATABLE READ
    setConflicts(e, 's', 3);
    (e as any).checkDegradation('s', 'SERIALIZABLE');
    // Stage 2: degrade REPEATABLE READ → READ COMMITTED (existingRec present)
    setConflicts(e, 's', 5); // >= CONFLICTS_BEFORE_DEGRADE_RR
    (e as any).checkDegradation('s', 'REPEATABLE_READ');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('READ_COMMITTED');
    expect(rec.originalIsolation).toBe('SERIALIZABLE'); // preserved
    expect(rec.totalDegradations).toBe(2); // incremented
  });

  it('re-elevates when cool-off passed (existingRec with elapsed nextElevationAt)', () => {
    const e = makeExec();
    // Manually plant an existing degradation record whose cool-off elapsed.
    (e as any).degradationRecords.set('s', {
      originalIsolation: 'SERIALIZABLE',
      currentIsolation: 'REPEATABLE_READ',
      degradedAt: Date.now() - 100000,
      totalDegradations: 1,
      nextElevationAt: Date.now() - 1000, // elapsed
    });
    setConflicts(e, 's', 3);
    (e as any).checkDegradation('s', 'REPEATABLE_READ');
    // Should have been re-elevated back to original.
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('SERIALIZABLE');
    expect(rec.nextElevationAt).toBeNull();
  });

  it('does not re-elevate before cool-off passed', () => {
    const e = makeExec();
    (e as any).degradationRecords.set('s', {
      originalIsolation: 'SERIALIZABLE',
      currentIsolation: 'REPEATABLE_READ',
      degradedAt: Date.now() - 1000,
      totalDegradations: 1,
      nextElevationAt: Date.now() + 30000, // future
    });
    setConflicts(e, 's', 3);
    (e as any).checkDegradation('s', 'REPEATABLE_READ');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('REPEATABLE_READ'); // not re-elevated
  });
});

describe('MVCCExecutor checkElevation and getEffectiveIsolation boundaries', () => {
  it('checkElevation re-elevates when cool-off elapsed', () => {
    const e = makeExec();
    (e as any).degradationRecords.set('s', {
      originalIsolation: 'SERIALIZABLE',
      currentIsolation: 'REPEATABLE_READ',
      degradedAt: Date.now() - 100000,
      totalDegradations: 1,
      nextElevationAt: Date.now() - 1000,
    });
    (e as any).checkElevation('s');
    const rec = (e as any).degradationRecords.get('s');
    expect(rec.currentIsolation).toBe('SERIALIZABLE');
  });

  it('checkElevation is a no-op without degradation record', () => {
    const e = makeExec();
    expect(() => (e as any).checkElevation('ghost')).not.toThrow();
  });

  it('getBackoffMs caps at 1000ms', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { totalRetries: 20, conflictCount: 0 });
    expect(e.getBackoffMs('s')).toBe(1000); // capped
  });

  it('getBackoffMs returns 0 without retries', () => {
    const e = makeExec();
    expect(e.getBackoffMs('ghost')).toBe(0);
  });
});
