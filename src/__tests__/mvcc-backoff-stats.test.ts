import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor constructor readPersistedXid (backward-compat restore)', () => {
  it('restores XID from readPersistedXid callback', () => {
    const e = makeExec({ readPersistedXid: () => 10 });
    const counter = (e as any).xidCounter;
    expect(counter).toBeGreaterThanOrEqual(11); // lastXid + 1
  });

  it('ignores null return from readPersistedXid', () => {
    const e = makeExec({ readPersistedXid: () => null });
    expect((e as any).xidCounter).toBeGreaterThan(0);
  });

  it('ignores non-positive return from readPersistedXid', () => {
    const e = makeExec({ readPersistedXid: () => 0 });
    expect((e as any).xidCounter).toBeGreaterThan(0);
  });
});

describe('MVCCExecutor getBackoffMs exponential backoff', () => {
  it('returns 0 when no conflict stats', () => {
    const e = makeExec();
    expect(e.getBackoffMs('ghost')).toBe(0);
  });

  it('returns 0 when totalRetries is 0', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { totalRetries: 0, conflictCount: 0 });
    expect(e.getBackoffMs('s')).toBe(0);
  });

  it('computes exponential backoff with default base', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { totalRetries: 3, conflictCount: 0 });
    expect(e.getBackoffMs('s')).toBe(40); // 10 * 2^2
  });

  it('caps backoff at 1000ms', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { totalRetries: 20, conflictCount: 0 });
    expect(e.getBackoffMs('s')).toBe(1000);
  });

  it('uses custom backoffBaseMs', () => {
    const e = makeExec({ backoffBaseMs: 50 });
    (e as any).conflictStats.set('s', { totalRetries: 2, conflictCount: 0 });
    expect(e.getBackoffMs('s')).toBe(100); // 50 * 2^1
  });
});

describe('MVCCExecutor resetConflictStats', () => {
  it('resets retries and conflict count', () => {
    const e = makeExec();
    (e as any).conflictStats.set('s', { totalRetries: 5, conflictCount: 9 });
    e.resetConflictStats('s');
    expect((e as any).conflictStats.get('s').totalRetries).toBe(0);
    expect((e as any).conflictStats.get('s').conflictCount).toBe(0);
  });

  it('is a no-op for unknown session', () => {
    const e = makeExec();
    expect(() => e.resetConflictStats('ghost')).not.toThrow();
  });
});

describe('MVCCExecutor getGlobalStats', () => {
  it('reports oldestActiveTxnMs null when no active txns', () => {
    const e = makeExec();
    const stats = e.getGlobalStats();
    expect(stats.oldestActiveTxnMs).toBeNull();
    expect(stats.activeTxnCount).toBe(0);
  });

  it('reports oldestActiveTxnMs as elapsed since oldest txn start', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const stats = e.getGlobalStats();
    expect(stats.activeTxnCount).toBe(1);
    expect(stats.oldestActiveTxnMs).toBeGreaterThanOrEqual(0);
  });

  it('reports degraded sessions count', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    const stats = e.getGlobalStats();
    expect(stats.degradedSessions).toBe(1);
  });
});

describe('MVCCExecutor checkDegradation re-elevation boundary', () => {
  it('re-elevates when nextElevationAt is in the past', () => {
    const e = makeExec();
    e.recordDegradation('s', 'SERIALIZABLE', 3);
    const rec = (e as any).degradationRecords.get('s');
    rec.nextElevationAt = Date.now() - 1000; // in the past
    (e as any).conflictStats.set('s', { conflictCount: 0, totalRetries: 0 });
    (e as any).checkDegradation('s', 'REPEATABLE_READ');
    expect((e as any).degradationRecords.get('s').currentIsolation).toBe('SERIALIZABLE');
  });

  it('returns early when no conflict stats', () => {
    const e = makeExec();
    (e as any).checkDegradation('ghost', 'SERIALIZABLE'); // no throw
  });
});
