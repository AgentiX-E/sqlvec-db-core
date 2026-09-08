import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor shouldDegrade RR branch', () => {
  it('returns true for REPEATABLE_READ at threshold 5', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    (e as any).conflictStats.set('a', { conflictCount: 5 });
    expect(e.shouldDegrade('a', 'REPEATABLE_READ')).toBe(true);
  });

  it('returns false for REPEATABLE_READ below threshold', () => {
    const e = makeExec();
    e.begin('a', 'REPEATABLE_READ', false);
    (e as any).conflictStats.set('a', { conflictCount: 4 });
    expect(e.shouldDegrade('a', 'REPEATABLE_READ')).toBe(false);
  });
});

describe('MVCCExecutor recordDegradation repeated (totalDegradations + 1)', () => {
  it('increments totalDegradations on second degradation of same session', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    e.recordDegradation('a', 'SERIALIZABLE', 1);
    expect(e.getDegradation('a')!.totalDegradations).toBe(1);
    e.recordDegradation('a', 'SERIALIZABLE', 2);
    expect(e.getDegradation('a')!.totalDegradations).toBe(2);
    expect(e.getDegradation('a')!.currentIsolation).toBe('REPEATABLE_READ');
  });
});

describe('MVCCExecutor getGlobalStats oldest-active loop / cleanupStaleTxns', () => {
  it('getGlobalStats computes oldestActiveTxnMs across active txns', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    const s = e.getGlobalStats();
    expect(s.oldestActiveTxnMs).not.toBeNull();
  });

  it('cleanupStaleTxns rolls back a stale conflicted txn (timeout + retries)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).conflictStats.set('a', { totalRetries: 3 });
    const cleaned = e.cleanupStaleTxns(0); // maxAge 0 → all txns stale
    expect(cleaned).toBeGreaterThanOrEqual(1);
    expect(e.getTransaction('a') ?? null).toBeNull(); // rolled back
  });

  it('cleanupStaleTxns skips missing txn (continue)', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    const a = e.getTransaction('a')!;
    (e as any).txnDeadlocked.add(a.xid); // marked deadlocked → stale
    (e as any).activeTxns.delete('a'); // but already gone → continue in loop
    const cleaned = e.cleanupStaleTxns(0);
    expect(typeof cleaned).toBe('number');
  });
});

describe('MVCCExecutor rowMutex creation and refCount deletion', () => {
  it('creates mutex entry on first lockRow and deletes on refCount<=0', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(true);
    expect((e as any).rowMutexes.get('lock:t:1').refCount).toBe(1);
    e.unlockRow('t', 1);
    expect((e as any).rowMutexes.has('lock:t:1')).toBe(false);
  });

  it('unlockRow is a no-op without entry', () => {
    const e = makeExec();
    expect(() => e.unlockRow('t', 999)).not.toThrow();
  });
});
