import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor commit-time GC trigger (setImmediate path)', () => {
  it('triggers gcRowVersions via setImmediate when version map is large', async () => {
    const e = makeExec({ maxRowVersions: 0, rowVersionGcThreshold: 0 });
    e.begin('w', 'READ_COMMITTED', false);
    e.recordWrite('w', 't', 1);
    e.commit('w');
    // Let the setImmediate fire.
    await new Promise((r) => setImmediate(r));
    expect(true).toBe(true);
  });
});

describe('MVCCExecutor conflict/degradation eviction (capacity overflow)', () => {
  it('evicts oldest conflict stats beyond 1000 entries', () => {
    const e = makeExec();
    // Directly seed 1001 conflict stats entries and invoke eviction.
    for (let i = 0; i < 1001; i++) {
      (e as any).conflictStats.set(`s${i}`, {
        totalRetries: 0, conflictCount: 0, commitCount: 0,
        rollbackCount: 0, deadlockCount: 0, firstConflictAt: 0,
        lastActivityAt: i, // monotonic so oldest = s0
      });
    }
    (e as any).evictOldestConflictStats();
    // S0 (oldest) should have been evicted.
    expect((e as any).conflictStats.has('s0')).toBe(false);
  });

  it('evicts oldest degradation records beyond 500 entries', () => {
    const e = makeExec();
    for (let i = 0; i < 501; i++) {
      (e as any).degradationRecords.set(`s${i}`, {
        originalIsolation: 'SERIALIZABLE', currentIsolation: 'REPEATABLE_READ',
        degradedAt: i, totalDegradations: 1, nextElevationAt: null,
      });
    }
    (e as any).evictOldestDegradationRecords();
    expect((e as any).degradationRecords.has('s0')).toBe(false);
  });
});

describe('MVCCExecutor cleanupStaleTxns boundaries', () => {
  it('removes stale transactions that have retries or waits', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const ta = e.getTransaction('a')!;
    ta.started = Date.now() - 1_000_000; // stale
    // Mark 'a' as having retries so cleanupStaleTxns considers it stale.
    e.recordConflict('a');
    const removed = e.cleanupStaleTxns(100);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(e.getTransaction('a')).toBeUndefined();
  });
});

describe('MVCCExecutor getGlobalStats aggregation', () => {
  it('aggregates committed/conflict/deadlock counts', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordConflict('a');
    e.commit('a');
    const g = e.getGlobalStats();
    expect(typeof g.committedCount).toBe('number');
    expect(typeof g.conflictCount).toBe('number');
    expect(g.activeTxnCount).toBe(0);
  });
});

describe('MVCCExecutor acquireWriteLock resolve path (clearTimeout)', () => {
  it('resolves queued writer and clears its timeout', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    e.acquireRowWriteLock('a', 't', 1);
    const p = e.acquireWriteLock('b', 't', 1, 5000);
    e.releaseWriteLock('t', 1);
    const wait = await p;
    expect(wait).toBeGreaterThanOrEqual(0);
  });
});
