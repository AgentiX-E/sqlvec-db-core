/**
 * for-update-executor.test.ts — Coverage tests for ForUpdateExecutor.
 *
 * ForUpdateExecutor applies PostgreSQL row-level lock semantics (FOR UPDATE /
 * FOR SHARE) to SELECT results, delegating lock acquisition to either an
 * MVCCExecutor or a RowLockManager. This suite drives every lock-strength,
 * NOWAIT/SKIP LOCKED, OF-table, deadlock, and contention branch using mock
 * lock providers.
 */

import { describe, it, expect, vi } from 'vitest';
import { ForUpdateExecutor } from '../query/ForUpdateExecutor';
import type { ForUpdateClause } from '../query/ForUpdateShim';
import type { LockMode } from '../consensus/RowLockManager';

function makeClause(overrides: Partial<ForUpdateClause> = {}): ForUpdateClause {
  return {
    hasForUpdate: false,
    hasForShare: false,
    hasForNoKeyUpdate: false,
    hasForKeyShare: false,
    lockStrength: 'UPDATE',
    nowait: false,
    skipLocked: false,
    ...overrides,
  };
}

// A minimal MVCCExecutor stand-in exposing the two lock methods.
function makeMvcc(overrides: Partial<{ write: any; share: any }> = {}) {
  return {
    acquireRowWriteLock: vi.fn(overrides.write ?? (() => true)),
    acquireRowShareLock: vi.fn(overrides.share ?? (() => true)),
  } as any;
}

// A minimal RowLockManager stand-in.
function makeRowLockManager(grant: any) {
  return { acquireLocks: vi.fn(async () => grant) } as any;
}

describe('ForUpdateExecutor', () => {
  it('returns rows unchanged when there are no rows', async () => {
    const ex = new ForUpdateExecutor(null);
    const r = await ex.applyForUpdate({
      sessionId: 's',
      sql: 'SELECT 1',
      rows: [],
      tableName: 'users',
      forUpdate: makeClause(),
    });
    expect(r.rows).toEqual([]);
    expect(r.error).toBeUndefined();
  });

  it('skips locking when OF tables do not include the table', async () => {
    const ex = new ForUpdateExecutor(null);
    const rows = [{ id: 1 }];
    const r = await ex.applyForUpdate({
      sessionId: 's',
      sql: 'SELECT 1',
      rows,
      tableName: 'users',
      forUpdate: makeClause({ tables: ['orders'] }),
    });
    expect(r.rows).toEqual(rows);
    expect(r.error).toBeUndefined();
  });

  it('skips locking when no lock manager is available', async () => {
    const ex = new ForUpdateExecutor(null);
    const rows = [{ id: 1 }];
    const r = await ex.applyForUpdate({
      sessionId: 's',
      sql: 'SELECT 1',
      rows,
      tableName: 'users',
      forUpdate: makeClause(),
    });
    expect(r.rows).toEqual(rows);
    expect(r.error).toBeUndefined();
  });

  describe('via MVCCExecutor', () => {
    it('acquires write locks for FOR UPDATE', async () => {
      const mvcc = makeMvcc();
      const ex = new ForUpdateExecutor(mvcc);
      const rows = [{ id: 1 }, { id: 2 }];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't', forUpdate: makeClause({ lockStrength: 'UPDATE' }),
      });
      expect(r.rows).toEqual(rows);
      expect(mvcc.acquireRowWriteLock).toHaveBeenCalledTimes(2);
      expect(mvcc.acquireRowShareLock).not.toHaveBeenCalled();
    });

    it('extracts row ids by ctid, first numeric column, index, and null', async () => {
      const mvcc = makeMvcc();
      const ex = new ForUpdateExecutor(mvcc);
      const rows = [
        { ctid: 100 },              // ctid
        { other: 200 },             // first numeric column
        { name: 'not-a-number' },   // first column non-numeric → index
        null,                        // null → index
        'primitive',                 // non-object → index
      ];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't', forUpdate: makeClause({ lockStrength: 'UPDATE' }),
      });
      expect(r.rows).toEqual(rows);
      expect(mvcc.acquireRowWriteLock).toHaveBeenCalledTimes(5);
      // Verify the resolved numeric row ids in call order
      const calledRowIds = mvcc.acquireRowWriteLock.mock.calls.map((c: any[]) => c[2]);
      expect(calledRowIds).toEqual([100, 200, 2, 3, 4]);
    });

    it('uses fallback index when row is an empty object or bad value', async () => {
      const mvcc = makeMvcc();
      const ex = new ForUpdateExecutor(mvcc);
      const rows = [{}, { x: null }];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't', forUpdate: makeClause({ lockStrength: 'UPDATE' }),
      });
      expect(r.rows).toEqual(rows);
    });

    it('acquires share locks for FOR SHARE', async () => {
      const mvcc = makeMvcc();
      const ex = new ForUpdateExecutor(mvcc);
      const rows = [{ id: 1 }];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't', forUpdate: makeClause({ lockStrength: 'SHARE' }),
      });
      expect(r.rows).toEqual(rows);
      expect(mvcc.acquireRowShareLock).toHaveBeenCalledTimes(1);
    });

    it('returns deadlock error when write lock reports deadlocked', async () => {
      const mvcc = makeMvcc({ write: () => 'deadlocked' });
      const ex = new ForUpdateExecutor(mvcc);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.rows).toEqual([]);
      expect(r.error?.code).toBe('40P01');
    });

    it('returns NOWAIT error on contention with NOWAIT', async () => {
      const mvcc = makeMvcc({ write: () => false });
      const ex = new ForUpdateExecutor(mvcc);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't',
        forUpdate: makeClause({ nowait: true }),
      });
      expect(r.rows).toEqual([]);
      expect(r.error?.code).toBe('55P03');
    });

    it('filters rows with SKIP LOCKED', async () => {
      const mvcc = makeMvcc({ write: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) });
      const ex = new ForUpdateExecutor(mvcc);
      const rows = [{ id: 1 }, { id: 2 }];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't',
        forUpdate: makeClause({ skipLocked: true }),
      });
      expect(r.rows).toEqual([{ id: 1 }]);
    });

    it('returns lock error on contention without SKIP LOCKED/NOWAIT', async () => {
      const mvcc = makeMvcc({ write: () => false });
      const ex = new ForUpdateExecutor(mvcc);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.rows).toEqual([]);
      expect(r.error?.code).toBe('55P03');
    });
  });

  describe('via RowLockManager', () => {
    it('detects a single RowLockManager argument (lack of acquireRowWriteLock)', async () => {
      const rm = makeRowLockManager({ granted: true, rowIds: [1n], skipped: [] });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.rows).toEqual([{ id: 1 }]);
    });

    it('maps lock strengths to RowLockManager modes', async () => {
      const cases: Array<[string, string]> = [
        ['UPDATE', 'FOR_UPDATE'],
        ['NO_KEY_UPDATE', 'FOR_NO_KEY_UPDATE'],
        ['SHARE', 'FOR_SHARE'],
        ['KEY_SHARE', 'FOR_KEY_SHARE'],
      ];
      for (const [strength, expectedMode] of cases) {
        const rm = makeRowLockManager({ granted: true, rowIds: [1n], skipped: [] });
        const ex = new ForUpdateExecutor(rm, null);
        await ex.applyForUpdate({
          sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't',
          forUpdate: makeClause({ lockStrength: strength as any }),
        });
        expect(rm.acquireLocks.mock.calls[0][0].mode).toBe(expectedMode);
      }

      // Unknown strength falls back to FOR_UPDATE (switch default)
      const rm2 = makeRowLockManager({ granted: true, rowIds: [1n], skipped: [] });
      const ex2 = new ForUpdateExecutor(rm2, null);
      await ex2.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't',
        forUpdate: makeClause({ lockStrength: 'UNKNOWN' as any }),
      });
      expect(rm2.acquireLocks.mock.calls[0][0].mode).toBe('FOR_UPDATE');
    });

    it('filters rows with SKIP LOCKED and skipped rows', async () => {
      const rm = makeRowLockManager({ granted: true, rowIds: [1n], skipped: [2n] });
      const ex = new ForUpdateExecutor(rm, null);
      const rows = [{ id: 1 }, { id: 2 }];
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows, tableName: 't',
        forUpdate: makeClause({ skipLocked: true }),
      });
      expect(r.rows).toEqual([{ id: 1 }]);
    });

    it('returns NOWAIT error when skipped and NOWAIT', async () => {
      const rm = makeRowLockManager({ granted: false, rowIds: [], skipped: [1n] });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't',
        forUpdate: makeClause({ nowait: true }),
      });
      expect(r.rows).toEqual([]);
      expect(r.error?.code).toBe('55P03');
    });

    it('returns rows when not granted (no nowait, no skip)', async () => {
      const rm = makeRowLockManager({ granted: false, rowIds: [], skipped: [] });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.rows).toEqual([{ id: 1 }]);
      expect(r.error).toBeUndefined();
    });

    it('returns deadlock error when acquireLocks throws DeadlockDetected', async () => {
      const rm = makeRowLockManager(null);
      rm.acquireLocks = vi.fn(async () => { throw { code: 'DeadlockDetected', message: 'deadlock' }; });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.error?.code).toBe('40P01');
    });

    it('returns deadlock error when message contains Deadlock', async () => {
      const rm = makeRowLockManager(null);
      rm.acquireLocks = vi.fn(async () => { throw new Error('Deadlock detected in lock'); });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.error?.code).toBe('40P01');
    });

    it('returns rows on unexpected error', async () => {
      const rm = makeRowLockManager(null);
      rm.acquireLocks = vi.fn(async () => { throw new Error('boom'); });
      const ex = new ForUpdateExecutor(rm, null);
      const r = await ex.applyForUpdate({
        sessionId: 's', sql: 'S', rows: [{ id: 1 }], tableName: 't', forUpdate: makeClause(),
      });
      expect(r.rows).toEqual([{ id: 1 }]);
      expect(r.error).toBeUndefined();
    });
  });
});
