/**
 * tx-coord.test.ts — Coverage tests for TxCoord transaction coordinator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TxCoord,
  type TxCoordHooks,
} from '../query/TxCoord';

// ── Helpers ───────────────────────────────────────────────

function makeHooks(overrides: Partial<TxCoordHooks> = {}): TxCoordHooks & {
  begin: ReturnType<typeof vi.fn>;
  beforeCommit: ReturnType<typeof vi.fn>;
  commitCleanup: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  timeout: ReturnType<typeof vi.fn>;
} {
  const begin = vi.fn();
  const beforeCommit = vi.fn();
  const commitCleanup = vi.fn();
  const rollback = vi.fn();
  const timeout = vi.fn();
  return {
    onBegin: begin,
    onBeforeCommit: beforeCommit,
    onCommitCleanup: commitCleanup,
    onRollback: rollback,
    onTimeout: timeout,
    begin,
    beforeCommit,
    commitCleanup,
    rollback,
    timeout,
    ...overrides,
  };
}

describe('TxCoord — query methods', () => {
  it('hasTransaction / getTransaction reflect begin state', () => {
    const c = new TxCoord();
    expect(c.hasTransaction('s1')).toBe(false);
    expect(c.getTransaction('s1')).toBeUndefined();

    c._begin('s1');
    expect(c.hasTransaction('s1')).toBe(true);
    const txn = c.getTransaction('s1')!;
    expect(txn.sessionId).toBe('s1');
    expect(txn.pendingChanges).toEqual([]);
    expect(txn.savepointStack).toEqual([]);
    expect(txn.startedAt).toBeTypeOf('number');
  });

  it('getPendingChanges returns undefined when no txn', () => {
    const c = new TxCoord();
    expect(c.getPendingChanges('nope')).toBeUndefined();
  });

  it('getPendingChanges returns array when txn exists', () => {
    const c = new TxCoord();
    c._begin('s1');
    expect(c.getPendingChanges('s1')).toEqual([]);
  });

  it('pendingChangeCount returns 0 when no txn', () => {
    const c = new TxCoord();
    expect(c.pendingChangeCount('nope')).toBe(0);
  });

  it('pendingChangeCount counts buffered changes', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT 1');
    c.addPendingChange('s1', 'INSERT 2');
    expect(c.pendingChangeCount('s1')).toBe(2);
  });

  it('transactionCount reports active txn count', () => {
    const c = new TxCoord();
    expect(c.transactionCount).toBe(0);
    c._begin('a');
    c._begin('b');
    expect(c.transactionCount).toBe(2);
  });

  it('activeSessionIds lists active sessions', () => {
    const c = new TxCoord();
    expect(c.activeSessionIds).toEqual([]);
    c._begin('a');
    c._begin('b');
    expect(c.activeSessionIds.sort()).toEqual(['a', 'b']);
  });
});

describe('TxCoord — _begin', () => {
  it('returns alreadyInTxn when begin nested (same session)', () => {
    const c = new TxCoord();
    c._begin('s1');
    const r = c._begin('s1');
    expect(r).toEqual({ message: 'BEGIN (already in transaction)', alreadyInTxn: true });
  });

  it('uses default session id when empty string given', () => {
    const c = new TxCoord();
    c._begin('');
    expect(c.hasTransaction('default')).toBe(true);
  });

  it('invokes onBegin hook with isolation level', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    // Pass a fake statement carrying isolationLevel
    c._begin('s1', { isolationLevel: 'SERIALIZABLE' } as never);
    expect(hooks.begin).toHaveBeenCalledWith('s1', 'SERIALIZABLE');
  });

  it('creates a fresh savepointIndexMap per transaction', () => {
    const c = new TxCoord();
    c._begin('s1');
    const txn = c.getTransaction('s1')!;
    expect(txn.savepointIndexMap).toBeInstanceOf(Map);
    txn.savepointIndexMap.set('x', 0);
    expect(txn.savepointIndexMap.size).toBe(1);
  });
});

describe('TxCoord — savepoints', () => {
  it('_savepoint no-op when no txn', () => {
    const c = new TxCoord();
    expect(() => c._savepoint('nope', 'sp')).not.toThrow();
  });

  it('_savepoint pushes name and records index', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT a');
    c._savepoint('s1', 'sp1');
    const txn = c.getTransaction('s1')!;
    expect(txn.savepointStack).toEqual(['sp1']);
    expect(txn.savepointIndexMap.get('sp1')).toBe(1);
  });

  it('_rollbackToSavepoint returns 0 when no txn', () => {
    const c = new TxCoord();
    expect(c._rollbackToSavepoint('nope', 'sp')).toBe(0);
  });

  it('_rollbackToSavepoint warns and returns 0 when savepoint missing', () => {
    const c = new TxCoord();
    c._begin('s1');
    expect(c._rollbackToSavepoint('s1', 'ghost')).toBe(0);
  });

  it('_rollbackToSavepoint truncates changes and prunes later savepoints', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'c0'); // idx 0
    c._savepoint('s1', 'sp1');       // idx 1
    c.addPendingChange('s1', 'c1'); // idx 1
    c.addPendingChange('s1', 'c2'); // idx 2
    c._savepoint('s1', 'sp2');       // idx 3

    const discarded = c._rollbackToSavepoint('s1', 'sp1');
    expect(discarded).toBe(2); // c1 + c2 discarded (length 3 -> idx 1)
    expect(c.getPendingChanges('s1')).toHaveLength(1); // only c0

    const txn = c.getTransaction('s1')!;
    // sp1 and sp2 both pruned (sp1 is the rollback target)
    expect(txn.savepointStack).toEqual([]);
  });

  it('_releaseSavepoint returns false when no txn or missing', () => {
    const c = new TxCoord();
    expect(c._releaseSavepoint('nope', 'sp')).toBe(false);

    c._begin('s1');
    expect(c._releaseSavepoint('s1', 'ghost')).toBe(false);
  });

  it('_releaseSavepoint removes savepoint without discarding changes', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'c0');
    c._savepoint('s1', 'sp1');
    c.addPendingChange('s1', 'c1');

    const existed = c._releaseSavepoint('s1', 'sp1');
    expect(existed).toBe(true);
    // Changes preserved
    expect(c.getPendingChanges('s1')).toHaveLength(2);
    // Stack pruned
    expect(c.getTransaction('s1')!.savepointStack).toEqual([]);
  });

  it('_pruneSavepointsAfter no-op when savepoint not on stack', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'c0');
    c._savepoint('s1', 'sp1');
    // Release a non-existent savepoint: idx === -1, no-op.
    c._releaseSavepoint('s1', 'nope');
    expect(c.getTransaction('s1')!.savepointStack).toEqual(['sp1']);
  });
});

describe('TxCoord — pending change / commit / rollback', () => {
  it('addPendingChange no-op when no txn', () => {
    const c = new TxCoord();
    expect(() => c.addPendingChange('nope', 'INSERT x')).not.toThrow();
  });

  it('addPendingChange buffers sql + params', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT ?', [1]);
    expect(c.getPendingChanges('s1')).toEqual([{ sql: 'INSERT ?', params: [1] }]);
  });

  it('prepareCommit returns null when no txn', () => {
    const c = new TxCoord();
    expect(c.prepareCommit('nope')).toBeNull();
  });

  it('prepareCommit invokes onBeforeCommit and returns pending changes', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT a');
    const prep = c.prepareCommit('s1')!;
    expect(prep.pendingChanges).toHaveLength(1);
    expect(prep.startedAt).toBeTypeOf('number');
    expect(hooks.beforeCommit).toHaveBeenCalledWith('s1', 1);
  });

  it('cleanupCommit returns 0 when no txn', () => {
    const c = new TxCoord();
    expect(c.cleanupCommit('nope')).toBe(0);
  });

  it('cleanupCommit removes txn, cancels timer, invokes hook', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT a');
    const count = c.cleanupCommit('s1');
    expect(count).toBe(1);
    expect(c.hasTransaction('s1')).toBe(false);
    expect(hooks.commitCleanup).toHaveBeenCalledWith('s1');
  });

  it('_rollback returns 0 when no txn', () => {
    const c = new TxCoord();
    expect(c._rollback('nope')).toBe(0);
  });

  it('_rollback discards changes, removes txn, invokes hook', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c._begin('s1');
    c.addPendingChange('s1', 'INSERT a');
    c.addPendingChange('s1', 'INSERT b');
    const discarded = c._rollback('s1');
    expect(discarded).toBe(2);
    expect(c.hasTransaction('s1')).toBe(false);
    expect(hooks.rollback).toHaveBeenCalledWith('s1');
  });

  it('cleanupSession rolls back only for active session', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c._begin('s1');
    c.cleanupSession('s1');
    expect(c.hasTransaction('s1')).toBe(false);

    // No-op for inactive session
    c.cleanupSession('inactive');
    expect(hooks.rollback).toHaveBeenCalledTimes(1);
  });

  it('clearAll rolls back and clears all txns', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c._begin('a');
    c._begin('b');
    c.clearAll();
    expect(c.transactionCount).toBe(0);
    expect(hooks.rollback).toHaveBeenCalledTimes(2);
  });

  it('shutdown clears all txns', () => {
    const c = new TxCoord();
    c._begin('a');
    c._begin('b');
    c.shutdown();
    expect(c.transactionCount).toBe(0);
  });
});

describe('TxCoord — TransactionCoordinator interface', () => {
  it('getStatus returns idle / in_transaction', () => {
    const c = new TxCoord();
    expect(c.getStatus('nope')).toBe('idle');
    c._begin('s1');
    expect(c.getStatus('s1')).toBe('in_transaction');
  });

  it('begin / commit / rollback async wrappers', async () => {
    const c = new TxCoord();
    await c.begin('s1');
    expect(c.hasTransaction('s1')).toBe(true);

    c.addPendingChange('s1', 'INSERT a');
    await c.commit('s1');
    expect(c.hasTransaction('s1')).toBe(false);

    await c.rollback('s1'); // no-op
  });

  it('commit no-op when no active txn', async () => {
    const c = new TxCoord();
    await expect(c.commit('nope')).resolves.toBeUndefined();
  });

  it('savepoint / rollbackToSavepoint / releaseSavepoint wrappers', async () => {
    const c = new TxCoord();
    await c.begin('s1');
    await c.savepoint('sp1', 's1');
    await c.rollbackToSavepoint('sp1', 's1');
    await c.releaseSavepoint('sp1', 's1');
  });
});

describe('TxCoord — idle timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('initIdleTimeout re-inits and cancels prior timers', () => {
    const c = new TxCoord();
    c._begin('s1');
    c.initIdleTimeout(100);
    // Re-init while a txn is active: cancels old timer map entries.
    c.initIdleTimeout(200);
    expect(c.transactionCount).toBe(1);
  });

  it('timeout fires hook, deletes txn, and logs', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c.initIdleTimeout(100);
    c._begin('s1');

    vi.advanceTimersByTime(100);
    expect(hooks.timeout).toHaveBeenCalledWith('s1');
    expect(c.hasTransaction('s1')).toBe(false);
  });

  it('cancelTimer is invoked on commit/rollback to disarm timeout', () => {
    const hooks = makeHooks();
    const c = new TxCoord(hooks);
    c.initIdleTimeout(100);
    c._begin('s1');
    // Commit before timer fires: no timeout hook.
    c.cleanupCommit('s1');
    vi.advanceTimersByTime(200);
    expect(hooks.timeout).not.toHaveBeenCalled();
  });
});
