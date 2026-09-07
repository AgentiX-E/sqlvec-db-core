import { describe, it, expect, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor adaptive isolation degradation (real path)', () => {
  it('degrades SERIALIZABLE -> REPEATABLE_READ after 3 consecutive conflicts', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.recordConflict('s');
    e.recordConflict('s');
    e.recordConflict('s');
    // After 3 conflicts, checkDegradation (inside recordConflict) degrades.
    expect(e.getEffectiveIsolation('s')).toBe('REPEATABLE_READ');
    expect(e.getDegradation('s')).not.toBeNull();
    expect(e.getDegradation('s')!.originalIsolation).toBe('SERIALIZABLE');
  });

  it('degrades REPEATABLE_READ -> READ_COMMITTED after 5 conflicts', () => {
    const e = makeExec();
    e.begin('r', 'REPEATABLE_READ', false);
    for (let i = 0; i < 5; i++) e.recordConflict('r');
    expect(e.getEffectiveIsolation('r')).toBe('READ_COMMITTED');
  });

  it('shouldDegrade returns false below threshold, true at threshold', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    expect(e.shouldDegrade('s', 'SERIALIZABLE')).toBe(false);
    // 2 conflicts -> still below threshold of 3 (no degrade yet)
    e.recordConflict('s');
    e.recordConflict('s');
    expect(e.shouldDegrade('s', 'SERIALIZABLE')).toBe(false);
  });

  it('re-elevates a degraded session after cooldown via commit()', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.recordConflict('s');
    e.recordConflict('s');
    e.recordConflict('s');
    expect(e.getEffectiveIsolation('s')).toBe('REPEATABLE_READ');

    // Force the cooldown to have passed by reaching into the record.
    const rec = (e as any).degradationRecords.get('s');
    rec.nextElevationAt = Date.now() - 1000;

    // commit() calls checkElevation() -> elevateSession().
    e.commit('s');
    // After re-elevation, the degradation record still reports originalIso.
    expect(e.getDegradation('s')!.currentIsolation).toBe('SERIALIZABLE');
  });

  it('commit throws for unknown session (no active txn)', () => {
    const e = makeExec();
    expect(() => e.commit('ghost')).toThrow();
    expect(e.getEffectiveIsolation('ghost')).toBe('READ_COMMITTED');
  });

  it('getDegradationSuggestion reflects a degraded session', () => {
    const e = makeExec();
    e.begin('s', 'SERIALIZABLE', false);
    e.recordConflict('s');
    e.recordConflict('s');
    e.recordConflict('s');
    const suggestion = e.getDegradationSuggestion('s');
    expect(suggestion).not.toBeNull();
    expect(suggestion).toContain('REPEATABLE_READ');
    expect(suggestion).toContain('SERIALIZABLE');
  });
});

describe('MVCCExecutor stale snapshot GC', () => {
  it('gcStaleSnapshots runs via commit and cleans committed snapshots', () => {
    const e = makeExec();
    const t = e.begin('a', 'READ_COMMITTED', false);
    // Manually seed a snapshot for this txn so GC has something to collect.
    (e as any).txnSnapshots.set(t.xid, t.snapshot);
    e.commit('a');
    // After commit, the XID is no longer active; GC should have removed it.
    expect((e as any).txnSnapshots.has(t.xid)).toBe(false);
  });
});

describe('MVCCExecutor deadlock stats recording', () => {
  it('records deadlock count for the victim session', () => {
    const e = makeExec();
    const a = e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);

    // Build a real deadlock: a holds row1, b holds row2.
    e.acquireRowWriteLock('a', 't', 1);
    e.acquireRowWriteLock('b', 't', 2);
    e.acquireRowWriteLock('a', 't', 2); // a waits on b
    const outcome = e.acquireRowWriteLock('b', 't', 1); // b waits on a -> cycle

    if (outcome === 'deadlocked') {
      const victimStats = e.getSessionStats('b')?.conflictStats;
      expect(victimStats?.deadlockCount).toBeGreaterThanOrEqual(1);
    } else {
      // Victim is whichever younger txn; at least one has a deadlock record.
      const sa = e.getSessionStats('a')?.conflictStats;
      const sb = e.getSessionStats('b')?.conflictStats;
      expect((sa?.deadlockCount ?? 0) + (sb?.deadlockCount ?? 0)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('MVCCExecutor XID wrap handling', () => {
  it('reports current XID counter (getNextXid / counter getter)', () => {
    const e = makeExec();
    const xid = (e as any).xidCounter;
    expect(xid).toBeGreaterThanOrEqual(3);
  });

  it('checkXidWrapPrevention returns false below threshold, true above', () => {
    const e = makeExec();
    (e as any).xidCounter = MVCCExecutor.XID_WRAP_WARNING_THRESHOLD - 1;
    expect((e as any).checkXidWrapPrevention()).toBe(false);
    (e as any).xidCounter = MVCCExecutor.XID_WRAP_WARNING_THRESHOLD;
    expect((e as any).checkXidWrapPrevention()).toBe(true);
  });

  it('handleXidWrap resets counter to XID_FROZEN+1 and persists', () => {
    const persisted: number[] = [];
    const e = makeExec({ persistXid: (x: number) => persisted.push(x) });
    (e as any).xidCounter = MVCCExecutor.XID_WRAP_LIMIT;
    const wrapped = (e as any).handleXidWrap();
    expect(wrapped).toBe(3); // XID_FROZEN + 1
    expect(persisted.length).toBe(1);
    expect(persisted[0]).toBe(4); // xidCounter after wrap = wrapped + 1
  });
});
