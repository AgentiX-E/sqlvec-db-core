/**
 * two-phase-commit-manager — unit tests for TwoPhaseCommitManager and its
 * standalone helpers (detectTwoPhase, rewriteTwoPhase, validateTxId).
 *
 * Covers the in-memory registry lifecycle (prepare / commit / rollback /
 * list / exists / count / clear / discard / stats), the timing-out sweep,
 * zombie flagging, crash recovery from a persisted table, and the persistence
 * helpers, using a minimal better-sqlite3-style mock for the fallback DB.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TwoPhaseCommitManager,
  detectTwoPhase,
  rewriteTwoPhase,
  validateTxId,
} from '../query/TwoPhaseCommitManager';
import type { PinoLogger } from '../logger/PinoLogger';

// ── Minimal better-sqlite3-style mock ────────────────────────────────

interface MockRow {
  [k: string]: unknown;
}

interface MockDb {
  exec: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  // accumulated rows keyed by table
  rows: Map<string, MockRow[]>;
}

function createMockDb(): MockDb {
  const store = new Map<string, MockRow[]>();

  const prepare = vi.fn((sql: string) => {
    const op = {
      all: vi.fn(() => {
        // Match table name from a SELECT ... FROM <table>
        const m = sql.match(/FROM\s+(\w+)/i);
        const table = m ? m[1] : '__prepared_transactions';
        return (store.get(table) ?? []).slice();
      }),
      run: vi.fn((...args: unknown[]) => {
        if (/^\s*INSERT/i.test(sql)) {
          // INSERT OR REPLACE INTO __prepared_transactions (gid, state, prepared_at, pending_sql, owner_session) VALUES (?, 'prepared', ?, ?, ?)
          const table = '__prepared_transactions';
          const gid = String(args[0]);
          const state = 'prepared';
          const prepared_at = args[1];
          const pending_sql = args[2];
          const owner_session = args[3];
          const existing = store.get(table) ?? [];
          const idx = existing.findIndex((r) => r.gid === gid);
          const row: MockRow = { gid, state, prepared_at, pending_sql, owner_session };
          if (idx >= 0) existing[idx] = row;
          else existing.push(row);
          store.set(table, existing);
        } else if (/^\s*DELETE/i.test(sql)) {
          const table = '__prepared_transactions';
          if (/WHERE\s+gid\s*=\s*\?/i.test(sql)) {
            const gid = String(args[0]);
            const existing = (store.get(table) ?? []).filter((r) => r.gid !== gid);
            store.set(table, existing);
          } else {
            store.set(table, []);
          }
        }
        return { changes: 1 };
      }),
    };
    return op;
  });

  const exec = vi.fn((sql: string) => {
    if (/^\s*DELETE\s+FROM\s+(\w+)/i.test(sql)) {
      const table = sql.match(/^\s*DELETE\s+FROM\s+(\w+)/i)![1];
      store.set(table, []);
    }
  });

  return { exec, prepare, rows: store };
}

function createShardManager(db: MockDb) {
  return {
    getShard: vi.fn((n: number) => (n === 0 ? { db } : undefined)),
  } as any;
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as PinoLogger;

describe('TwoPhaseCommitManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Standalone helpers ────────────────────────────────

  describe('detectTwoPhase', () => {
    it('detects PREPARE TRANSACTION', () => {
      expect(detectTwoPhase("PREPARE TRANSACTION 'abc'")).toBe('prepare');
    });
    it('detects COMMIT PREPARED', () => {
      expect(detectTwoPhase("COMMIT PREPARED 'abc'")).toBe('commit');
    });
    it('detects ROLLBACK PREPARED', () => {
      expect(detectTwoPhase("ROLLBACK PREPARED 'abc'")).toBe('rollback');
    });
    it('is case-insensitive and tolerant of trailing semicolon / whitespace', () => {
      expect(detectTwoPhase("  prepare transaction 'foo';  ")).toBe('prepare');
      expect(detectTwoPhase("  commit prepared 'foo';  ")).toBe('commit');
      expect(detectTwoPhase("  rollback prepared 'foo';  ")).toBe('rollback');
    });
    it('returns false for non-2PC SQL', () => {
      expect(detectTwoPhase('SELECT 1')).toBe(false);
      expect(detectTwoPhase('PREPARE foo')).toBe(false);
      expect(detectTwoPhase('COMMIT')).toBe(false);
      expect(detectTwoPhase('ROLLBACK')).toBe(false);
      expect(detectTwoPhase('BEGIN')).toBe(false);
    });
    it('returns false for 2PC-shaped input missing a gid / with trailing junk', () => {
      // Passes the fast prefix + regex-prefix gates but fails the full regex.
      expect(detectTwoPhase('ROLLBACK PREPARED')).toBe(false);
      expect(detectTwoPhase("ROLLBACK PREPARED 'a' extra")).toBe(false);
      expect(detectTwoPhase('COMMIT PREPARED')).toBe(false);
      expect(detectTwoPhase('PREPARE TRANSACTION')).toBe(false);
    });
    it('returns false for empty / non-string input', () => {
      expect(detectTwoPhase('')).toBe(false);
      expect(detectTwoPhase('   ')).toBe(false);
      expect(detectTwoPhase(123 as any)).toBe(false);
      expect(detectTwoPhase(undefined as any)).toBe(false);
      expect(detectTwoPhase(null as any)).toBe(false);
    });
    it('handles escaped quotes in the transaction id', () => {
      expect(detectTwoPhase("PREPARE TRANSACTION 'it''s'")).toBe('prepare');
    });
  });

  describe('validateTxId', () => {
    it('accepts a normal identifier', () => {
      expect(validateTxId('my_tx')).toBe(true);
    });
    it('rejects empty / whitespace / non-string', () => {
      expect(validateTxId('')).toBe(false);
      expect(validateTxId('   ')).toBe(false);
      expect(validateTxId(1 as any)).toBe(false);
      expect(validateTxId(undefined as any)).toBe(false);
    });
    it('trims surrounding whitespace before validating', () => {
      expect(validateTxId('  my_tx  ')).toBe(true);
    });
    it('rejects identifiers exceeding 200 UTF-8 bytes', () => {
      expect(validateTxId('a'.repeat(201))).toBe(false);
      expect(validateTxId('a'.repeat(200))).toBe(true);
      // multi-byte: 100 '中' = 300 bytes
      expect(validateTxId('中'.repeat(100))).toBe(false);
    });
  });

  describe('rewriteTwoPhase', () => {
    it('returns unchanged for non-2PC SQL', () => {
      expect(rewriteTwoPhase('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    });
    it('returns unchanged (rewritten:false) for empty / non-string', () => {
      expect(rewriteTwoPhase('')).toEqual({ sql: '', rewritten: false });
      expect(rewriteTwoPhase(123 as any)).toEqual({ sql: 123 as any, rewritten: false });
    });
    it('returns an empty sql for null / undefined input', () => {
      expect(rewriteTwoPhase(null as any)).toEqual({ sql: '', rewritten: false });
      expect(rewriteTwoPhase(undefined as any)).toEqual({ sql: '', rewritten: false });
    });
    it('rewrites a detected 2PC statement to an inert no-op', () => {
      const r = rewriteTwoPhase("PREPARE TRANSACTION 'abc'");
      expect(r.rewritten).toBe(true);
      expect(r.sql).toContain('-- 2PC (prepare) no-op:');
      expect(r.sql).toContain("PREPARE TRANSACTION 'abc'");
      expect(r.sql).toContain('SELECT 1');
    });
    it('rewrites commit and rollback with the correct phase label', () => {
      expect(rewriteTwoPhase("COMMIT PREPARED 'x'").sql).toContain('-- 2PC (commit) no-op:');
      expect(rewriteTwoPhase("ROLLBACK PREPARED 'x'").sql).toContain('-- 2PC (rollback) no-op:');
    });
    it('folds newlines in the original SQL for the comment', () => {
      const r = rewriteTwoPhase("PREPARE TRANSACTION 'a\nb'");
      expect(r.rewritten).toBe(true);
      expect(r.sql).not.toContain('\nREPARE'); // naïvely: newline inside comment folded
      expect(r.sql).toContain("PREPARE TRANSACTION 'a b'");
    });
  });

  // ── In-memory lifecycle (no persistence) ──────────────

  describe('prepare / commit / rollback lifecycle', () => {
    it('prepares a transaction and returns a canonical savepoint name', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      const r = m.prepare('my_tx');
      expect(r.rewritten).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.savepointName).toBe('pg_prep_tx_my_tx');
      expect(m.exists('my_tx')).toBe(true);
      expect(m.getPreparedCount()).toBe(1);
    });

    it('trims the tx id and rejects an empty id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      const empty = m.prepare('   ');
      expect(empty.rewritten).toBe(false);
      expect(empty.error).toMatch(/non-empty/);
      expect(m.getPreparedCount()).toBe(0);
    });

    it('rejects a duplicate tx id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('dup');
      const dup = m.prepare('dup');
      expect(dup.error).toMatch(/already exists/);
      expect(m.getPreparedCount()).toBe(1);
    });

    it('enforces the maxPrepared limit', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger, maxPrepared: 2 });
      expect(m.prepare('a').error).toBeUndefined();
      expect(m.prepare('b').error).toBeUndefined();
      const third = m.prepare('c');
      expect(third.error).toMatch(/Maximum number/);
      expect(m.getPreparedCount()).toBe(2);
    });

    it('commits a prepared transaction and removes it from the registry', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('tx', [{ sql: 'INSERT INTO t VALUES (1)' }]);
      const r = m.commitPrepared('tx');
      expect(r.rewritten).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.savepointName).toBe('pg_prep_tx_tx');
      expect(m.exists('tx')).toBe(false);
    });

    it('fails commit for an unknown tx id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      const r = m.commitPrepared('nope');
      expect(r.error).toMatch(/not found/);
    });

    it('fails commit for an empty tx id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      const r = m.commitPrepared('   ');
      expect(r.rewritten).toBe(false);
      expect(r.error).toMatch(/non-empty/);
    });

    it('rolls back a prepared transaction (without executing pending SQL)', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('tx', [{ sql: 'INSERT INTO t VALUES (1)' }]);
      const r = m.rollbackPrepared('tx');
      expect(r.rewritten).toBe(true);
      expect(r.error).toBeUndefined();
      expect(m.exists('tx')).toBe(false);
    });

    it('fails rollback for an unknown / empty tx id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      expect(m.rollbackPrepared('nope').error).toMatch(/not found/);
      expect(m.rollbackPrepared('  ').error).toMatch(/non-empty/);
    });

    it('renders a canonical savepoint name for ids with special chars', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      const r = m.prepare('a b-c.d/e');
      // non-alphanumeric (except _) become underscores
      expect(r.savepointName).toBe('pg_prep_tx_a_b_c_d_e');
    });

    it('tracks pending SQL count and increments it', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('tx', [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
      const before = m.listPrepared()[0];
      expect(before.gid).toBe('tx');
      m.incrementPendingSql('tx');
      expect(m.getPreparedByGid('tx')?.pendingSqlCount).toBe(3);
      m.incrementPendingSql('unknown'); // no-op
    });
  });

  describe('listPrepared / exists / count / clear', () => {
    it('lists prepared transactions with metadata', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('tx', undefined, 'session-1', 'db-1');
      const list = m.listPrepared();
      expect(list).toHaveLength(1);
      const info = list[0];
      expect(info.gid).toBe('tx');
      expect(info.owner).toBe('session-1');
      expect(info.database).toBe('db-1');
      expect(info.sessionId).toBe('session-1');
      expect(info.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(info.zombie).toBe(false);
    });

    it('flags ownerless transactions as zombie', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('orphan');
      const list = m.listPrepared();
      expect(list[0].zombie).toBe(true);
    });

    it('clearAll removes every prepared transaction and returns the count', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('a');
      m.prepare('b');
      m.prepare('c');
      expect(m.clearAll()).toBe(3);
      expect(m.getPreparedCount()).toBe(0);
    });

    it('discardPreparedTransactions removes only the matching session', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('a', undefined, 's1');
      m.prepare('b', undefined, 's2');
      m.prepare('c', undefined, 's1');
      const n = m.discardPreparedTransactions('s1');
      expect(n).toBe(2);
      expect(m.exists('a')).toBe(false);
      expect(m.exists('c')).toBe(false);
      expect(m.exists('b')).toBe(true);
    });

    it('discardPreparedTransactions is a no-op for an empty session id', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('a', undefined, 's1');
      expect(m.discardPreparedTransactions('')).toBe(0);
      expect(m.exists('a')).toBe(true);
    });
  });

  describe('stats and cleanup sweep', () => {
    it('reports stats with current total and cumulative counters', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('a');
      m.prepare('b');
      m.rollbackPrepared('a');
      expect(m.getStats()).toEqual({ total: 1, timedOut: 0, zombie: 0, rolledBack: 1 });
      expect(m.countPrepared()).toBe(1);
    });

    it('stopPreparedCleanup is a no-op when no timer is running', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      expect(() => m.stopPreparedCleanup()).not.toThrow();
    });

    it('startPreparedCleanup + stopPreparedCleanup manage a timer', () => {
      vi.useFakeTimers();
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.startPreparedCleanup();
      m.startPreparedCleanup(); // idempotent — stops the previous timer
      m.stopPreparedCleanup();
      vi.runAllTimers();
      expect(m.getPreparedCount()).toBe(0);
    });

    it('sweep flags an ownerless transaction as zombie before timeout', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('zombie'); // no owner → zombie

      m.startPreparedCleanup();
      // First sweep fires at cleanupIntervalMs (60s), which is well under the
      // 5-minute timeout, so the ownerless entry is flagged (not rolled back).
      vi.advanceTimersByTime(60 * 1000);

      expect(m.exists('zombie')).toBe(true);
      expect(m.listPrepared().some((x) => x.gid === 'zombie' && x.zombie)).toBe(true);
      // Not rolled back: counted once as zombie, never as timed out.
      expect(m.getStats()).toMatchObject({ zombie: 1, timedOut: 0, rolledBack: 0 });

      m.stopPreparedCleanup();
    });

    it('does not double-count a zombie already flagged', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('zombie'); // no owner → zombie

      m.startPreparedCleanup();
      // First sweep flags the zombie.
      vi.advanceTimersByTime(60 * 1000);
      expect(m.getStats().zombie).toBe(1);
      // Second sweep sees it already flagged and must not increment again.
      vi.advanceTimersByTime(60 * 1000);
      expect(m.getStats().zombie).toBe(1);

      m.stopPreparedCleanup();
    });

    it('sweep rolls back a transaction after the timeout threshold', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('timed', undefined, 'owner-1'); // owned → not zombie

      m.startPreparedCleanup();
      // Advance past timeoutMs (5 min); the interval fires 6 times and the
      // owned transaction is rolled back on the first sweep after 5 minutes.
      vi.advanceTimersByTime(6 * 60 * 1000);

      expect(m.exists('timed')).toBe(false);
      const stats = m.getStats();
      expect(stats.timedOut).toBe(1);
      expect(stats.rolledBack).toBe(1);
      expect(stats.total).toBe(0);

      m.stopPreparedCleanup();
    });
  });

  // ── Persistence (fallbackDb) ─────────────────────────

  describe('persistence via fallbackDb', () => {
    it('persists a prepared transaction and recovers it after restart', () => {
      const db = createMockDb();
      const m1 = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      m1.prepare('persisted', [{ sql: 'INSERT INTO t VALUES (1)' }], 'sess');

      // Simulate a restart with a fresh manager over the same DB.
      const m2 = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      const list = m2.listPrepared();
      expect(list.some((x) => x.gid === 'persisted')).toBe(true);
      expect(m2.exists('persisted')).toBe(true);
    });

    it('commits a persisted transaction and purges it from the table', () => {
      const db = createMockDb();
      const m1 = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      m1.prepare('t', undefined, 'sess');
      m1.commitPrepared('t');

      const m2 = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      expect(m2.exists('t')).toBe(false);
    });

    it('recovers committed leftovers by executing pending SQL then purging', () => {
      const db = createMockDb();
      // Pre-seed a committed leftover row directly.
      db.rows.set('__prepared_transactions', [
        { gid: 'leftover', state: 'committed', prepared_at: Date.now(), pending_sql: '["INSERT INTO t VALUES (9)"]', owner_session: 's' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      expect(m.exists('leftover')).toBe(false);
      // The leftover's pending SQL is executed and the row purged.
      expect(db.rows.get('__prepared_transactions')).toEqual([]);
    });

    it('purges orphan records with an unknown state', () => {
      const db = createMockDb();
      db.rows.set('__prepared_transactions', [
        { gid: 'orphan', state: 'weird', prepared_at: Date.now(), pending_sql: '[]', owner_session: '' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      expect(m.exists('orphan')).toBe(false);
      expect(db.rows.get('__prepared_transactions')).toEqual([]);
    });

    it('removes persisted rows on clearAll', () => {
      const db = createMockDb();
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      m.prepare('a', undefined, 's');
      m.prepare('b', undefined, 's');
      expect(m.clearAll()).toBe(2);
      expect(db.rows.get('__prepared_transactions')).toEqual([]);
    });

    it('listPrepared surfaces DB-persisted rows not yet loaded in memory', () => {
      const db = createMockDb();
      // Seed a prepared row directly without going through manager.prepare.
      db.rows.set('__prepared_transactions', [
        { gid: 'disk-only', state: 'prepared', prepared_at: Date.now(), pending_sql: '[]', owner_session: 'sess-x' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      // recoverInDoubtTransactions loads it into memory on construction; clear
      // the registry to simulate a row that only exists on disk.
      m.clearAll();
      // Re-seed the row so listPrepared can find a DB-only entry.
      db.rows.set('__prepared_transactions', [
        { gid: 'disk-only', state: 'prepared', prepared_at: Date.now(), pending_sql: '[]', owner_session: 'sess-x' },
      ]);
      const list = m.listPrepared();
      const disk = list.find((x) => x.gid === 'disk-only');
      expect(disk).toBeDefined();
      expect(disk!.owner).toBe('sess-x');
    });

    it('recoverInDoubtTransactions returns 0 when no db is configured', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      expect(m.getPreparedCount()).toBe(0);
    });

    it('recoverInDoubtTransactions handles an empty pending SQL list', () => {
      const db = createMockDb();
      db.rows.set('__prepared_transactions', [
        { gid: 'empty-sql', state: 'committed', prepared_at: Date.now(), pending_sql: '[]', owner_session: 's' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      // committed leftover with no pending SQL: purged without execution.
      expect(db.rows.get('__prepared_transactions') ?? []).toEqual([]);
      expect(m.exists('empty-sql')).toBe(false);
    });

    it('flags DB-only rows with an empty owner_session as zombie', () => {
      const db = createMockDb();
      // Seed a prepared row with an empty owner_session directly.
      db.rows.set('__prepared_transactions', [
        { gid: 'no-owner', state: 'prepared', prepared_at: Date.now(), pending_sql: '[]', owner_session: '' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      // recoverInDoubtTransactions loads it; clear to force listPrepared's DB
      // fallback branch, then re-seed so it only exists on disk.
      m.clearAll();
      db.rows.set('__prepared_transactions', [
        { gid: 'no-owner', state: 'prepared', prepared_at: Date.now(), pending_sql: '[]', owner_session: '' },
      ]);
      const list = m.listPrepared();
      const row = list.find((x) => x.gid === 'no-owner');
      expect(row).toBeDefined();
      expect(row!.owner).toBe('');
      expect(row!.zombie).toBe(true);
    });

    it('recovers a prepared row that is already in memory without duplicating', () => {
      const db = createMockDb();
      // Seed a 'prepared' row on disk before constructing the manager, so the
      // constructor's recoverInDoubtTransactions loads it into memory.
      db.rows.set('__prepared_transactions', [
        { gid: 'already', state: 'prepared', prepared_at: Date.now(), pending_sql: '[]', owner_session: 's' },
      ]);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, fallbackDb: db });
      expect(m.exists('already')).toBe(true);

      // Calling recoverInDoubtTransactions again (it is idempotent / public)
      // must skip the already-in-memory gid instead of re-populating.
      const n = m.recoverInDoubtTransactions();
      expect(n).toBe(0);
      expect(m.exists('already')).toBe(true);
    });
  });

  describe('shardManager persistence path', () => {
    it('uses shardManager.getShard(0).db for persistence', () => {
      const db = createMockDb();
      const shardManager = createShardManager(db);
      const m = new TwoPhaseCommitManager({ logger: silentLogger, shardManager });
      m.prepare('via-shard', undefined, 's');
      expect(db.rows.get('__prepared_transactions')?.some((r) => r.gid === 'via-shard')).toBe(true);
    });

    it('falls back to fallbackDb when shardManager yields no db', () => {
      const db = createMockDb();
      // getShard returns undefined (no shard 0), forcing getShardDb fallback.
      const shardManagerNoDb = { getShard: () => undefined } as any;
      const m = new TwoPhaseCommitManager({
        logger: silentLogger,
        shardManager: shardManagerNoDb,
        fallbackDb: db,
      });
      m.prepare('fallback', undefined, 's');
      expect(db.rows.get('__prepared_transactions')?.some((r) => r.gid === 'fallback')).toBe(true);
    });

    it('handles a shardManager whose getShard throws', () => {
      const db = createMockDb();
      const shardManagerThrows = {
        getShard: () => {
          throw new Error('no shard');
        },
      } as any;
      const m = new TwoPhaseCommitManager({
        logger: silentLogger,
        shardManager: shardManagerThrows,
        fallbackDb: db,
      });
      m.prepare('throwing', undefined, 's');
      expect(db.rows.get('__prepared_transactions')?.some((r) => r.gid === 'throwing')).toBe(true);
    });

    it('skips persistence gracefully when getShardDb yields no db', () => {
      // shardManager exists but getShard(0) returns a shard without a .db, and
      // no fallbackDb is provided → getShardDb() returns null. Persistence ops
      // must no-op without throwing.
      const shardManagerNoDb = { getShard: () => ({ db: null }) } as any;
      const m = new TwoPhaseCommitManager({ logger: silentLogger, shardManager: shardManagerNoDb });
      const r = m.prepare('no-db', [{ sql: 'SELECT 1' }], 's');
      expect(r.error).toBeUndefined();
      expect(m.exists('no-db')).toBe(true);

      // commit / rollback also traverse the null-db persistence paths.
      expect(m.commitPrepared('no-db').error).toBeUndefined();
      m.prepare('no-db-2', undefined, 's');
      expect(m.rollbackPrepared('no-db-2').error).toBeUndefined();

      // listPrepared / clearAll also guard against a missing db.
      expect(m.listPrepared().length).toBe(0);
      expect(m.prepare('no-db-3', undefined, 's').error).toBeUndefined();
      expect(m.clearAll()).toBe(1);
    });

    it('handles a shardManager whose getShard is not a function', () => {
      const db = createMockDb();
      // getShard is a non-function property → getShardDb falls through to
      // fallbackDb (or null).
      const shardManagerNotFn = { getShard: 'not-a-function' } as any;
      const m = new TwoPhaseCommitManager({
        logger: silentLogger,
        shardManager: shardManagerNotFn,
        fallbackDb: db,
      });
      m.prepare('not-fn', undefined, 's');
      expect(db.rows.get('__prepared_transactions')?.some((r) => r.gid === 'not-fn')).toBe(true);
    });
  });

  describe('default logger and cleanup timer internals', () => {
    it('constructs with a default logger when none is supplied', () => {
      const m = new TwoPhaseCommitManager();
      m.prepare('x');
      expect(m.exists('x')).toBe(true);
    });

    it('calls unref on the interval handle when available', () => {
      vi.useFakeTimers();
      const unref = vi.fn();
      const origSetInterval = globalThis.setInterval;
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(((fn: any, ms?: number) => {
          const h = origSetInterval(fn, ms);
          (h as any).unref = unref;
          return h;
        }) as any);
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.startPreparedCleanup();
      expect(unref).toHaveBeenCalled();
      m.stopPreparedCleanup();
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it('skips unref when the interval handle has no unref function', () => {
      vi.useFakeTimers();
      const origSetInterval = globalThis.setInterval;
      // Return a handle without an `unref` method to exercise the typeof guard.
      const setIntervalSpy = vi
        .spyOn(globalThis, 'setInterval')
        .mockImplementation(((fn: any, ms?: number) => {
          return { _pseudoTimer: origSetInterval(fn, ms) } as any;
        }) as any);
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      expect(() => m.startPreparedCleanup()).not.toThrow();
      m.stopPreparedCleanup();
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it('discard with no matching session logs complete=false path (returns 0)', () => {
      const m = new TwoPhaseCommitManager({ logger: silentLogger });
      m.prepare('a', undefined, 's1');
      expect(m.discardPreparedTransactions('s2')).toBe(0);
      expect(m.exists('a')).toBe(true);
    });
  });
});
