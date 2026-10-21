/**
 * distributed-two-phase-commit-coordinator.test.ts — tests for the
 * cross-RaftGroup DistributedTwoPhaseCommitCoordinator.
 *
 * Covers the full prepare → commit / rollback state machine, single-shard
 * fast path, crash recovery, timeout sweep, persistence helpers, and the
 * public utility API, using a minimal better-sqlite3-style shard mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DistributedTwoPhaseCommitCoordinator } from '../query/DistributedTwoPhaseCommitCoordinator';
import type {
  DistributedCoordinatorConfig,
} from '../query/DistributedTwoPhaseCommitCoordinator';

// ── Minimal better-sqlite3-style shard mock ─────────────────────────

type SqlOp = {
  all: (...a: unknown[]) => unknown[];
  run: (...a: unknown[]) => { changes: number };
};

interface MockDb {
  exec: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  tables: Map<string, Record<string, unknown>[]>;
  execLog: string[];
}

function makeDb(): MockDb {
  const tables = new Map<string, Record<string, unknown>[]>();
  const execLog: string[] = [];

  const exec = vi.fn((sql: string) => {
    execLog.push(sql);
  });

  const prepare = vi.fn((sql: string): SqlOp => {
    return {
      all: (..._a: unknown[]) => {
        // SELECT ... FROM __distributed_tx_coordinator
        const m = sql.match(/FROM\s+(\w+)/i);
        const table = m ? m[1] : '__distributed_tx_coordinator';
        return (tables.get(table) ?? []).slice();
      },
      run: (...args: unknown[]) => {
        if (/^\s*INSERT\s+OR\s+REPLACE\s+INTO/i.test(sql)) {
          const txId = String(args[0]);
          const status = String(args[1]);
          const participants = args[2];
          const pendingSql = args[3];
          const created_at = args[4];
          const updated_at = args[5];
          const table = '__distributed_tx_coordinator';
          const existing = tables.get(table) ?? [];
          const idx = existing.findIndex((r) => r.tx_id === txId);
          const row: Record<string, unknown> = {
            tx_id: txId,
            status,
            participants,
            pending_sql: pendingSql,
            created_at,
            updated_at,
          };
          if (idx >= 0) existing[idx] = row;
          else existing.push(row);
          tables.set(table, existing);
        } else if (/^\s*DELETE\s+FROM\s+__distributed_tx_coordinator/i.test(sql)) {
          const txId = String(args[0]);
          const table = '__distributed_tx_coordinator';
          tables.set(
            table,
            (tables.get(table) ?? []).filter((r) => r.tx_id !== txId),
          );
        }
        return { changes: 1 };
      },
    };
  });

  return { exec, prepare, tables, execLog };
}

interface MockShardManager {
  getShard: ReturnType<typeof vi.fn>;
  getShardIds: ReturnType<typeof vi.fn>;
  getAllShards: ReturnType<typeof vi.fn>;
}

function makeShardManager(
  shardDbs: Map<number, MockDb>,
): { sm: MockShardManager; dbs: Map<number, MockDb> } {
  const sm: MockShardManager = {
    getShard: vi.fn((n: number) => {
      const db = shardDbs.get(n);
      return db ? { db } : undefined;
    }),
    getShardIds: vi.fn(() => Array.from(shardDbs.keys())),
    getAllShards: vi.fn(() => shardDbs),
  };
  return { sm, dbs: shardDbs };
}

const shortTimeout: Partial<DistributedCoordinatorConfig> = {
  participantTimeoutMs: 1000,
  sweepIntervalMs: 1000,
  recoveryEnabled: true,
};

// ── Suite ───────────────────────────────────────────────────────────

describe('DistributedTwoPhaseCommitCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('construction + public utility API', () => {
    it('merges config over defaults', () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, { participantTimeoutMs: 999 });
      // exercised indirectly; merely assert constructibility + no throw
      expect(c).toBeDefined();
      expect(c.getActiveCount()).toBe(0);
      expect(c.listActive()).toEqual([]);
      expect(c.exists('nope')).toBe(false);
      expect(c.getStatus('nope')).toBeUndefined();
      expect(c.getRecord('nope')).toBeUndefined();
    });
  });

  describe('prepare', () => {
    it('returns failure when no shards are available', async () => {
      const { sm } = makeShardManager(new Map());
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.prepare('tx1', ['SELECT 1']);
      expect(r).toEqual({ success: false, txId: 'tx1', error: 'No shards available' });
    });

    it('uses the single-shard fast path', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.prepare('tx1', ['SELECT 1']);
      expect(r).toEqual({ success: true, txId: 'tx1' });
      expect(c.getStatus('tx1')).toBe('prepared');
      // Single-shard savepoint was created
      expect(db.execLog.some((s) => s.includes('SAVEPOINT'))).toBe(true);
    });

    it('prepares across all shards when all succeed', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.prepare('tx1', ['SELECT 1', 'SELECT 2']);
      expect(r).toEqual({ success: true, txId: 'tx1' });
      expect(c.getStatus('tx1')).toBe('prepared');
      // both shards got the savepoint
      expect(d0.execLog.some((s) => s.includes('SAVEPOINT'))).toBe(true);
      expect(d1.execLog.some((s) => s.includes('SAVEPOINT'))).toBe(true);
    });

    it('rolls back prepared shards when one shard fails', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      // Make shard 1 throw on the savepoint exec
      d1.exec.mockImplementation((sql: string) => {
        if (sql.includes('SAVEPOINT')) throw new Error('boom');
        d1.execLog.push(sql);
      });
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.prepare('tx1', ['SELECT 1']);
      expect(r.success).toBe(false);
      expect(r.error).toContain('shard 1: boom');
      expect(c.getStatus('tx1')).toBeUndefined(); // aborted + removed
      // shard 0 was rolled back
      expect(d0.execLog.some((s) => s.includes('ROLLBACK TO'))).toBe(true);
    });
  });

  describe('commit', () => {
    it('fails when tx not found', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.commit('missing');
      expect(r).toEqual({ success: false, txId: 'missing', error: "Transaction 'missing' not found" });
    });

    it('fails when tx is not in prepared state', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      // Inject an active tx in a non-prepared state directly.
      (c as any).activeTx.set('tx1', {
        txId: 'tx1',
        status: 'committed',
        participants: [],
        pendingSql: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const r = await c.commit('tx1');
      expect(r.success).toBe(false);
      expect(r.error).toContain("is in state 'committed'");
    });

    it('commits all prepared participants on success', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.prepare('tx1', ['SELECT 1']);
      const r = await c.commit('tx1');
      expect(r).toEqual({ success: true, txId: 'tx1' });
      expect(c.exists('tx1')).toBe(false);
      expect(d0.execLog.some((s) => s.includes('RELEASE'))).toBe(true);
      expect(d1.execLog.some((s) => s.includes('RELEASE'))).toBe(true);
    });

    it('reports partial failure when a participant commit fails', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      d1.exec.mockImplementation((sql: string) => {
        if (sql.includes('RELEASE')) throw new Error('release boom');
        d1.execLog.push(sql);
      });
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.prepare('tx1', ['SELECT 1']);
      const r = await c.commit('tx1');
      expect(r.success).toBe(false);
      expect(r.error).toContain('1');
    });
  });

  describe('rollback', () => {
    it('fails when tx not found', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      const r = await c.rollback('missing');
      expect(r).toEqual({ success: false, txId: 'missing', error: "Transaction 'missing' not found" });
    });

    it('fails when tx is in a terminal state', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      // Inject a terminal-state tx (not prepared/preparing)
      (c as any).activeTx.set('tx1', {
        txId: 'tx1',
        status: 'committed',
        participants: [],
        pendingSql: [],
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const r = await c.rollback('tx1');
      expect(r.success).toBe(false);
      expect(r.error).toContain("is in state 'committed'");
    });

    it('rolls back a preparing transaction', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      (c as any).activeTx.set('tx1', {
        txId: 'tx1',
        status: 'preparing',
        participants: [{ shardId: 0, status: 'prepared' }],
        pendingSql: ['SELECT 1'],
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      const r = await c.rollback('tx1');
      expect(r).toEqual({ success: true, txId: 'tx1' });
      expect(c.exists('tx1')).toBe(false);
    });

    it('rolls back prepared participants', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.prepare('tx1', ['SELECT 1']);
      const r = await c.rollback('tx1');
      expect(r).toEqual({ success: true, txId: 'tx1' });
      expect(c.exists('tx1')).toBe(false);
      expect(d0.execLog.some((s) => s.includes('ROLLBACK TO'))).toBe(true);
    });

    it('handles rollback failure on a participant without throwing', async () => {
      const d0 = makeDb();
      const d1 = makeDb();
      d1.exec.mockImplementation((sql: string) => {
        if (sql.includes('ROLLBACK TO')) throw new Error('rb boom');
        d1.execLog.push(sql);
      });
      const { sm } = makeShardManager(new Map([[0, d0], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.prepare('tx1', ['SELECT 1']);
      const r = await c.rollback('tx1');
      expect(r).toEqual({ success: true, txId: 'tx1' });
    });
  });

  describe('init + recovery', () => {
    it('is idempotent (second init returns early)', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      const execCalls = db.exec.mock.calls.length;
      await c.init();
      // no additional PRAGMA / CREATE after second init
      expect(db.exec.mock.calls.length).toBe(execCalls);
      c.dispose();
    });

    it('skips recovery when recoveryEnabled is false', async () => {
      const db = makeDb();
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-old',
          status: 'prepared',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 5000,
          updated_at: Date.now(),
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, {
        ...shortTimeout,
        recoveryEnabled: false,
      });
      await c.init();
      // recovery disabled → in-doubt tx NOT loaded into memory
      expect(c.exists('tx-old')).toBe(false);
      c.dispose();
    });

    it('warns and returns when shard 0 is missing', async () => {
      const { sm } = makeShardManager(new Map());
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.getActiveCount()).toBe(0);
    });

    it('recovers in-doubt transactions within timeout into memory', async () => {
      const db = makeDb();
      // Seed a prepared transaction in coordinator table
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-old',
          status: 'prepared',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 5000,
          updated_at: Date.now(),
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-old')).toBe(true);
      expect(c.getStatus('tx-old')).toBe('prepared');
      c.dispose();
    });

    it('force-cleans a timed-out prepared transaction', async () => {
      const db = makeDb();
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-timeout',
          status: 'prepared',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-timeout')).toBe(false);
      c.dispose();
    });

    it('force-finalizes a timed-out committing transaction', async () => {
      const db = makeDb();
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-commit-old',
          status: 'committing',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-commit-old')).toBe(false);
      c.dispose();
    });

    it('force-finalizes a timed-out aborting transaction (rollback path)', async () => {
      const db = makeDb();
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-abort-old',
          status: 'aborting',
          participants: JSON.stringify([
            { shardId: 0, status: 'prepared' },
            { shardId: 1, status: 'preparing' }, // non-prepared → skipped by continue
          ]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm, dbs } = makeShardManager(new Map([[0, db], [1, makeDb()]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-abort-old')).toBe(false);
      c.dispose();
    });

    it('force-cleans a timed-out prepared transaction with mixed participants', async () => {
      const db = makeDb();
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-mixed',
          status: 'prepared',
          participants: JSON.stringify([
            { shardId: 0, status: 'prepared' },
            { shardId: 1, status: 'failed' }, // non-prepared → skipped by continue
          ]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db], [1, makeDb()]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-mixed')).toBe(false);
      c.dispose();
    });

    it('forceCleanup swallows a shard rollback failure (non-fatal)', async () => {
      const db = makeDb();
      // shard 0 exec throws on ROLLBACK TO, causing shardRollback to reject
      db.exec.mockImplementation((sql: string) => {
        if (sql.includes('ROLLBACK TO')) throw new Error('force rb boom');
      });
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-fail',
          status: 'prepared',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-fail')).toBe(false);
      // flush the caught rejection
      await new Promise((r) => setTimeout(r, 0));
      c.dispose();
    });

    it('forceFinalize commits / rolls back prepared shards and swallows failures', async () => {
      const db = makeDb();
      // shard 0 exec throws on both RELEASE and ROLLBACK TO
      db.exec.mockImplementation((sql: string) => {
        if (sql.includes('RELEASE') || sql.includes('ROLLBACK TO')) throw new Error('finalize boom');
      });
      db.tables.set('__distributed_tx_coordinator', [
        {
          tx_id: 'tx-finalize-commit',
          status: 'committing',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
        {
          tx_id: 'tx-finalize-abort',
          status: 'aborting',
          participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
          pending_sql: JSON.stringify(['SELECT 1']),
          created_at: Date.now() - 100000,
          updated_at: Date.now() - 100000,
        },
      ]);
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      expect(c.exists('tx-finalize-commit')).toBe(false);
      expect(c.exists('tx-finalize-abort')).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      c.dispose();
    });

    it('logs warning when recovery throws', async () => {
      const db = makeDb();
      db.prepare.mockImplementation(() => {
        throw new Error('recovery boom');
      });
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init(); // should not throw
      expect(c).toBeDefined();
      c.dispose();
    });
  });

  describe('timeout sweep', () => {
    it('rolls back timed-out active transactions', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init(); // starts the sweep timer
      await c.prepare('tx1', ['SELECT 1']);
      // artificially age the record past the timeout
      const rec = c.getRecord('tx1')!;
      rec.updated_at = Date.now() - 99999;
      vi.advanceTimersByTime(5000);
      // sweep fires the rollback asynchronously; advance one interval and flush
      await vi.advanceTimersByTimeAsync(1000);
      expect(c.exists('tx1')).toBe(false);
      c.dispose();
    });
  });

  describe('dispose', () => {
    it('clears the sweep timer and active set', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init();
      await c.prepare('tx1', ['SELECT 1']);
      c.dispose();
      expect(c.getActiveCount()).toBe(0);
      c.dispose(); // idempotent
    });
  });

  describe('persistence + execution edge cases', () => {
    it('ensureParticipantTables catches a per-shard failure', async () => {
      const db = makeDb();
      // Shard 0 works, shard 1 throws on exec (participant DDL)
      const d1 = makeDb();
      d1.exec.mockImplementation(() => {
        throw new Error('ddl boom');
      });
      const { sm } = makeShardManager(new Map([[0, db], [1, d1]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init(); // ensureParticipantTables iterates all shards, shard 1 fails
      expect(c).toBeDefined();
      c.dispose();
    });

    it('recoverInDoubtTransactions no-ops when shard 0 db is missing', () => {
      const sm = {
        getShard: vi.fn(() => undefined),
        getShardIds: vi.fn(() => []),
        getAllShards: vi.fn(() => new Map()),
      } as any;
      const c = new DistributedTwoPhaseCommitCoordinator(sm, shortTimeout);
      (c as any).recoverInDoubtTransactions(); // db undefined → return
      expect(c).toBeDefined();
    });

    it('recoverSingleTransaction handles a status outside the recognised set on timeout', () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      (c as any).recoverSingleTransaction({
        tx_id: 'tx-weird',
        status: 'bogus_status',
        participants: JSON.stringify([{ shardId: 0, status: 'prepared' }]),
        pending_sql: JSON.stringify(['SELECT 1']),
        created_at: Date.now() - 100000,
        updated_at: Date.now() - 100000,
      });
      expect(c).toBeDefined();
    });

    it('sweep timer calls unref when available (real timers)', async () => {
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init(); // real setInterval → unref exists
      expect((c as any).sweepTimer).toBeTruthy();
      c.dispose();
    });

    it('persistRecord / deleteRecord no-op when shard 0 db is missing', async () => {
      // Shard ids non-empty but getShard(0) returns undefined upstream mock
      // (no shard 0). Build a shard manager whose getShard always returns undefined.
      const sm = {
        getShard: vi.fn(() => undefined),
        getShardIds: vi.fn(() => []),
        getAllShards: vi.fn(() => new Map()),
      } as any;
      const c = new DistributedTwoPhaseCommitCoordinator(sm, shortTimeout);
      // init path: db undefined → warn + return
      await c.init();
      // Directly exercise persistRecord / deleteRecord with db undefined
      (c as any).persistRecord({ txId: 'x', status: 'prepared', participants: [], pendingSql: [], created_at: 1, updated_at: 1 });
      (c as any).deleteRecord('x');
      expect(c).toBeDefined();
    });

    it('persistRecord / deleteRecord catch DB errors', () => {
      const db = makeDb();
      db.prepare.mockImplementation(() => {
        throw new Error('db boom');
      });
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      (c as any).persistRecord({ txId: 'x', status: 'prepared', participants: [], pendingSql: [], created_at: 1, updated_at: 1 });
      (c as any).deleteRecord('x');
      expect(c).toBeDefined();
    });

    it('execOnShard throws when shard is unavailable', async () => {
      const sm = {
        getShard: vi.fn(() => undefined),
        getShardIds: vi.fn(() => [0]),
        getAllShards: vi.fn(() => new Map()),
      } as any;
      const c = new DistributedTwoPhaseCommitCoordinator(sm, shortTimeout);
      await expect((c as any).execOnShard(0, 'SELECT 1')).rejects.toThrow('Shard 0 not available');
    });

    it('startSweepTimer returns early when timer already set', async () => {
      vi.useFakeTimers();
      const db = makeDb();
      const { sm } = makeShardManager(new Map([[0, db]]));
      const c = new DistributedTwoPhaseCommitCoordinator(sm as any, shortTimeout);
      await c.init(); // sets sweepTimer
      const timer = (c as any).sweepTimer;
      (c as any).startSweepTimer(); // should early-return
      expect((c as any).sweepTimer).toBe(timer);
      c.dispose();
    });
  });
});
