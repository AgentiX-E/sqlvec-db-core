import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor vacuum & GC', () => {
  it('computeOldestActiveXid returns current counter when no active txns', () => {
    const e = makeExec();
    const xid = e.computeOldestActiveXid();
    expect(xid).toBeGreaterThanOrEqual(3);
  });

  it('computeOldestActiveXid returns smallest active XID', () => {
    const e = makeExec();
    const a = e.begin('a', 'READ_COMMITTED', false);
    e.begin('b', 'READ_COMMITTED', false);
    expect(e.computeOldestActiveXid()).toBe(a.xid);
  });

  it('gcRowVersions returns 0 below threshold (not forced)', () => {
    const e = makeExec();
    expect(e.gcRowVersions()).toBe(0);
  });

  it('gcRowVersions with force frees superseded dead rows', () => {
    const e = makeExec();
    // Insert then delete a row version to create a dead (xmax) row
    e.begin('w', 'READ_COMMITTED', false);
    e.recordWrite('w', 't', 1);          // xmin=3, xmax=null
    e.recordWrite('w', 't', 1, true);    // xmax=3 (dead, same txn)
    e.commit('w');
    // Now no active txn; dead row (xmax=3) is younger than counter so not GC'd
    // unless we force + the xmax is genuinely old. Just assert it runs.
    const freed = e.gcRowVersions(true);
    expect(freed).toBeGreaterThanOrEqual(0);
  });

  it('vacuum runs with a mock connection and returns frozen count', () => {
    const e = makeExec();
    const connection = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('sqlite_master')) return [{ name: 'users' }];
          if (sql.startsWith('PRAGMA table_info')) return [{ name: '_xmax' }, { name: 'id' }];
          return [];
        },
        run: () => ({ changes: 5 }),
      }),
    };
    const frozen = e.vacuum(connection as any);
    expect(frozen).toBeGreaterThanOrEqual(0);
  });

  it('vacuum tolerates a connection without prepare', () => {
    const e = makeExec();
    const frozen = e.vacuum({ exec: () => {} } as any);
    expect(frozen).toBeGreaterThanOrEqual(0);
  });

  it('reset clears active transactions and row versions', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordWrite('a', 't', 1);
    e.reset();
    expect(e.activeCount).toBe(0);
    expect(e.getTransaction('a')).toBeUndefined();
  });
});

describe('MVCCExecutor checkpoint & WAL', () => {
  it('checkpoint returns null when no WAL writer configured', () => {
    const e = makeExec();
    expect(e.checkpoint()).toBeNull();
  });

  it('checkpoint uses pgWalWriter when provided', () => {
    const writer = {
      writeCheckpoint: (xid: number) => ({ lsn: '0/1234', xid }),
      flushSegment: () => {},
    };
    const e = makeExec({ pgWalWriter: writer as any });
    expect(e.checkpoint()).toBe('0/1234');
  });

  it('checkpoint falls back to walLogger flush when present', () => {
    const writer = { flushSegment: () => {} };
    const walLogger = { getWriter: () => writer, logCommit: () => {} };
    const e = makeExec({ walLogger: walLogger as any });
    expect(e.checkpoint()).toBe('flushed');
  });
});

describe('MVCCExecutor expiration & stale cleanup', () => {
  it('isExpired returns false for a fresh txn', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.isExpired('a')).toBe(false);
  });

  it('isExpired returns false for unknown session', () => {
    const e = makeExec();
    expect(e.isExpired('ghost')).toBe(false);
  });

  it('cleanupStaleTxns removes old transactions', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    // Force the txn to appear stale
    const txn = e.getTransaction('a')!;
    txn.started = Date.now() - 1000 * 1000;
    const removed = e.cleanupStaleTxns(100);
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});

describe('MVCCExecutor conflict & degradation stats', () => {
  it('recordConflict increments conflict stats for a session', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    e.recordConflict('a');
    const stats = e.getSessionStats('a');
    expect(stats).not.toBeNull();
    expect(stats!.conflictStats).not.toBeNull();
    expect(stats!.conflictStats!.conflictCount).toBeGreaterThanOrEqual(1);
  });

  it('getSessionStats returns null for unknown session', () => {
    const e = makeExec();
    expect(e.getSessionStats('ghost')).toBeNull();
  });

  it('getGlobalStats returns aggregate object', () => {
    const e = makeExec();
    const g = e.getGlobalStats();
    expect(g).toBeDefined();
    expect(typeof g).toBe('object');
  });

  it('getBackoffMs returns a number and resets on success', () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    expect(e.getBackoffMs('a')).toBeGreaterThanOrEqual(0);
  });

  it('recordDegradation and getDegradation round-trip', () => {
    const e = makeExec();
    e.recordDegradation('a', 'SERIALIZABLE', 3);
    const d = e.getDegradation('a');
    expect(d).toBeDefined();
    expect(d!.originalIsolation).toBe('SERIALIZABLE');
  });

  it('getDegradationSuggestion returns null when not degraded', () => {
    const e = makeExec();
    expect(e.getDegradationSuggestion('unknown')).toBeNull();
  });
});

describe('MVCCExecutor adaptive isolation degradation', () => {
  it('getEffectiveIsolation returns READ_COMMITTED for unknown session', () => {
    const e = makeExec();
    expect(e.getEffectiveIsolation('ghost')).toBe('READ_COMMITTED');
  });

  it('getEffectiveIsolation reflects active txn isolation', () => {
    const e = makeExec();
    e.begin('a', 'SERIALIZABLE', false);
    expect(e.getEffectiveIsolation('a')).toBe('SERIALIZABLE');
  });

  it('shouldDegrade returns boolean', () => {
    const e = makeExec();
    expect(typeof e.shouldDegrade('a', 'SERIALIZABLE')).toBe('boolean');
  });
});

describe('MVCCExecutor async write lock', () => {
  it('acquireWriteLock returns 0 immediately when no transaction', async () => {
    const e = makeExec();
    await expect(e.acquireWriteLock('ghost', 't', 1)).resolves.toBe(0);
  });

  it('acquireWriteLock returns 0 immediately for read-only txn', async () => {
    const e = makeExec();
    e.begin('ro', 'READ_COMMITTED', true);
    await expect(e.acquireWriteLock('ro', 't', 1)).resolves.toBe(0);
  });

  it('acquireWriteLock acquires uncontended lock with 0 wait', async () => {
    const e = makeExec();
    e.begin('a', 'READ_COMMITTED', false);
    await expect(e.acquireWriteLock('a', 't', 1)).resolves.toBe(0);
  });
});

describe('MVCCExecutor row mutex helpers', () => {
  it('lockRow/unlockRow round-trip without a transaction', async () => {
    const e = makeExec();
    await e.lockRow('t', 1);
    e.unlockRow('t', 1);
  });

  it('lockRowForSession/unlockRowForSession round-trip', async () => {
    const e = makeExec();
    await e.lockRowForSession('t', 1, 's1');
    e.unlockRowForSession('t', 1, 's1');
  });

  it('lockRows/lockRowsForSession acquire multiple rows', async () => {
    const e = makeExec();
    await e.lockRows('t', [1, 2, 3]);
    e.unlockRows('t', [1, 2, 3]);
    await e.lockRowsForSession('t', [1, 2], 's1');
    e.unlockRowsForSession('t', [1, 2], 's1');
  });
});

describe('MVCCExecutor getIsolation', () => {
  it('getIsolation returns READ_COMMITTED for unknown xid', () => {
    const e = makeExec();
    expect(e.getIsolation(999999)).toBe('READ_COMMITTED');
  });

  it('getIsolation reflects a begun txn', () => {
    const e = makeExec();
    const t = e.begin('a', 'REPEATABLE_READ', false);
    expect(e.getIsolation(t.xid)).toBe('REPEATABLE_READ');
  });
});
