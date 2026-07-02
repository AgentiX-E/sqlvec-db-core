/**
 * MVCCExecutor — True MVCC with optimistic locking and retry for SQLite.
 *
 * Implements a lightweight Multi-Version Concurrency Control layer on top of
 * SQLite by assigning monotonically increasing XIDs to transactions, tracking
 * row versions via _xmin / _xmax system columns, and detecting write conflicts
 * at commit time.
 *
 * ## Design
 *
 * Each transaction receives a unique XID and records a snapshot (the latest
 * committed XID at the moment it began). When a row is inserted/updated, the
 * current txn's XID is written as _xmin. When a row is deleted/updated by
 * another txn, the new txn's XID is written as _xmax.
 *
 * Conflict detection on UPDATE compares the current row's _xmax against the
 * value captured at the start of the transaction. If _xmax has changed, the
 * row was modified by another concurrent transaction → abort with 40P01.
 *
 * ## P0-3 fixes
 * - hasConflict() only checks against still-active transactions (not committed)
 * - XID counter is persisted to SQLite for crash recovery
 * - Infrastructure for _xmin/_xmax visibility checks on SELECT
 *
 * ## References
 *
 * - PostgreSQL MVCC: https://www.postgresql.org/docs/current/mvcc.html
 * - Serialization Anomaly (40P01):
 *   https://www.postgresql.org/docs/current/errcodes-appendix.html
 *
 * @module query/MVCCExecutor
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { Mutex } from 'async-mutex';
import { DatabaseError } from '../error/DatabaseError';
import type MvccWalLogger from './MvccWalLogger';
import type { PgWalWriter } from '../storage/PgWalWriter';

// ── Types ────────────────────────────────────────────────────────

export interface OwnWriteRow {
  /** Table name */
  table: string;
  /** Write operation type */
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Unique key: `${table}:${rowId}` */
  rowKey: string;
  /** Row data for INSERT/UPDATE */
  data?: any;
  /** Primary key value */
  rowId: any;
  /**
   * xmin of the row when this txn first accessed it (for RR conflict detection).
   * Undefined for INSERTs (no prior version).
   */
  prevXmin?: number;
}

export interface SelectVisibility {
  /** Transaction snapshot (max committed XID at txn start) */
  snapshot: number;
  /** Isolation level */
  isolation: IsolationLevel;
  /** Rows written by THIS txn (for merge into SELECT results) */
  ownWrites: OwnWriteRow[];
  /** Set of XIDs for still-active transactions (filter out uncommitted rows) */
  activeXidSet: Set<number>;
  /** Copy of row version map (for phantom prevention — filters SELECT results) */
  committedRowVersions: Map<string, RowVersion>;
}

export interface MVCCTransaction {
  /** Globally unique, monotonically increasing transaction ID. */
  xid: number;
  /** Epoch ms when the transaction started. */
  started: number;
  /** Snapshot — the highest committed XID at begin time. */
  snapshot: number;
  /** Whether this transaction is read-only (skips conflict checks). */
  readOnly: boolean;
  /** Optional timeout in ms. If elapsed before commit, the txn is rolled back. */
  timeoutMs?: number;
}

/**
 * Result of a commit operation.
 * SSI conflicts return `success: false` with errorCode '40001'.
 */
export interface CommitResult {
  /** Whether the commit succeeded. */
  success: boolean;
  /** PostgreSQL error code (e.g. '40001' for serialization failure). */
  errorCode?: string;
  /** Human-readable error message. */
  errorMessage?: string;
}

export interface MVCCConfig {
  /** Default transaction timeout in ms (default: 30000). */
  defaultTimeoutMs: number;
  /** Whether to enable detailed conflict logging (default: false). */
  verboseConflictLogging: boolean;
  /** Optional better-sqlite3 Database instance for XID persistence. */
  db?: any;
  /** Optional function to persist the XID counter (receives last XID). */
  persistXid?: (lastXid: number) => void;
  /** Optional function to read persisted XID counter. */
  readPersistedXid?: () => number | null;
  /** Maximum number of retries before SERIALIZABLE degrades (default: 3). */
  maxRetriesBeforeDegrade?: number;
  /** Base exponential backoff delay in ms (default: 10). */
  backoffBaseMs?: number;
  /** Optional MvccWalLogger instance for WAL logging. */
  walLogger?: MvccWalLogger;
  /** Optional PgWalWriter for direct WAL operations (checkpoint). */
  pgWalWriter?: PgWalWriter;
  /** Enable PRAGMA synchronous=FULL for XID persistence (default: true). */
  xidFullSync?: boolean;
  /** Optional callback invoked after VACUUM FREEZE completes. */
  onVacuum?: (frozenRows: number) => void;
  /** Maximum number of row version entries before GC triggers (default: 100_000). */
  maxRowVersions?: number;
  /** Fraction of maxRowVersions that triggers GC when reached (default: 0.8). */
  rowVersionGcThreshold?: number;
  /**
   * Optional async function for writing to the database.
   * When set, all internal writes (row versions, XID, etc.) use this instead
   * of the direct `db` reference. This enables routing through the write pool
   * worker thread to avoid database lock conflicts.
   */
  writeSql?: (sql: string) => Promise<void>;
}

/**
 * Isolation level for MVCC transactions.
 * PG string forms ('serializable', 'read committed') are normalized
 * to underscore forms before dispatch.
 */
export type IsolationLevel = 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE'
  | 'read committed' | 'repeatable read' | 'serializable'
  | 'READ COMMITTED' | 'REPEATABLE READ';

const DEFAULT_CONFIG: MVCCConfig = {
  defaultTimeoutMs: 30000,
  verboseConflictLogging: false,
  maxRetriesBeforeDegrade: 3,
  backoffBaseMs: 10,
  maxRowVersions: 100_000,
  rowVersionGcThreshold: 0.8,
};

// ── XID Wrapping Constants ──────────────────────────────────────
//
// XID is a 32-bit counter. To avoid overflow issues with signed 32-bit,
// we wrap at 2^31 (2,147,483,648), well before the unsigned 32-bit limit.
// This is analogous to PostgreSQL's XID wrapping behavior.
//
// XID values 0 and 1 are reserved. XID_FROZEN (2) marks rows that should
// always be visible (equivalent to PG's frozen XID).
// Normal XIDs start at 3 after wrapping.

/** XID wrap limit — ~2.1 billion, half of unsigned 32-bit range. */
export const XID_WRAP_LIMIT = 2147483648;

/** Special XID for frozen rows — always visible regardless of snapshot. */
export const XID_FROZEN = 2;

/**
 * Internal row version snapshots for conflict detection.
 *
 * Keyed by `${tableName}:${rowId}`.
 */
export interface RowVersion {
  xmin: number; // XID that created this version
  xmax: number | null; // XID that deleted/superseded this version (null = live)
}

/**
 * C01: per-row write serialization queue entry.
 * When multiple txns want to write the same row, the queue ensures
 * only one txn holds the write token at a time.
 */
interface WriteQueueEntry {
  xid: number;
  resolve: () => void;
  reject: (err: Error) => void;
}

/**
 * C01: Conflict statistics per session for adaptive retry backoff.
 */
export interface ConflictStats {
  totalRetries: number;
  conflictCount: number;
  commitCount: number;
  rollbackCount: number;
  deadlockCount: number;
  firstConflictAt: number;   // epoch ms
  lastActivityAt: number;    // epoch ms
}

/**
 * C01: Degradation record — tracks isolation level degradation for a session.
 */
export interface DegradationRecord {
  originalIsolation: IsolationLevel;
  currentIsolation: IsolationLevel;
  degradedAt: number;        // epoch ms
  totalDegradations: number;
  nextElevationAt: number | null;  // cool-off period before re-elevating
}

/**
 * Global MVCC statistics snapshot.
 */
export interface GlobalMvccStats {
  activeTxnCount: number;
  committedCount: number;
  rolledBackCount: number;
  conflictCount: number;
  deadlockCount: number;
  currentXid: number;
  oldestActiveTxnMs: number | null;
  sessions: number;
  degradedSessions: number;
}

/**
 * Per-session MVCC statistics snapshot.
 */
export interface SessionMvccStats {
  sessionId: string;
  xid: number;
  isolation: IsolationLevel;
  readOnly: boolean;
  started: number;
  elapsedMs: number;
  conflictStats: ConflictStats | null;
  degradationRecord: DegradationRecord | null;
  waitingFor: string | null;
  deadlocked: boolean;
}

// ── SSI Types ──────────────────────────────────────────────────────

/**
 * SSI: A predicate lock represents a range of values that a SERIALIZABLE
 * transaction read from a table. Used for fine-grained phantom prevention.
 *
 * Unlike PostgreSQL's SIREAD locks which track all accessed tuples,
 * this implementation uses range-based predicates extracted from WHERE
 * clauses, enabling precise conflict detection without O(#tuples) memory.
 *
 * Variants:
 *   - eqPredicate:     { table, column, eqValue }
 *   - rangePredicate:  { table, column, minValue, maxValue }
 *   - tablePredicate:  { table } — legacy table-level (any INSERT conflicts)
 */
export interface PredicateLock {
  /** Table name */
  table: string;
  /** Column name (undefined for table-level predicate) */
  column?: string;
  /** Exact-match value (for col = literal predicates) */
  eqValue?: any;
  /** Lower bound for range predicates */
  minValue?: any;
  /** Upper bound for range predicates */
  maxValue?: any;
}

/**
 * Extract range predicate information from a SQL SELECT statement's WHERE clause.
 * Handles common patterns:
 *   - `WHERE col = value` → { column, eqValue }
 *   - `WHERE col BETWEEN x AND y` → { column, minValue, maxValue }
 *   - `WHERE col > x` / `col >= x` → { column, minValue }
 *   - `WHERE col < x` / `col <= x` → { column, maxValue }
 *
 * Returns undefined when no recognizable predicate is found.
 * Uses simple regex parsing — does NOT perform full SQL parsing.
 * Conservative: always returns at least the first WHERE condition found
 * for serializable correctness (over-approximation is safe).
 */
export function extractWhereRange(sql: string): {
  column?: string;
  eqValue?: any;
  minValue?: any;
  maxValue?: any;
} | undefined {
  // Remove comments and normalize whitespace for regex matching
  const normalized = sql.replace(/--.*$/gm, '').trim();

  // Locate WHERE clause (after the first WHERE, ignoring subqueries)
  const whereIdx = normalized.search(/\bWHERE\s+/i);
  if (whereIdx === -1) return undefined;

  const afterWhere = normalized.slice(whereIdx + 6).trim();

  // 1. Exact equality: col = literal_value (supports numbers and single-quoted strings)
  //    Matches `col = 123` or `col = 'foo'`
  const eqMatch = afterWhere.match(/^(\w+)\s*=\s*(\d+|'[^']*'|"[^"]*")\s*/i);
  if (eqMatch) {
    const col = eqMatch[1];
    const rawVal = eqMatch[2];
    const numVal = Number(rawVal);
    const val = isNaN(numVal) ? rawVal.replace(/^['"]|['"]$/g, '') : numVal;
    return { column: col, eqValue: val };
  }

  // 2. Range: col BETWEEN x AND y
  const betweenMatch = afterWhere.match(/^(\w+)\s+BETWEEN\s+(\d+)\s+AND\s+(\d+)\b/i);
  if (betweenMatch) {
    return {
      column: betweenMatch[1],
      minValue: Number(betweenMatch[2]),
      maxValue: Number(betweenMatch[3]),
    };
  }

  // 3. Inequality: col > x, col >= x, col < x, col <= x
  const ineqMatch = afterWhere.match(/^(\w+)\s*([><]=?)\s*(\d+)\b/i);
  if (ineqMatch) {
    const col = ineqMatch[1];
    const op = ineqMatch[2];
    const val = Number(ineqMatch[3]);
    if (op === '>' || op === '>=') {
      return { column: col, minValue: val };
    }
    if (op === '<' || op === '<=') {
      return { column: col, maxValue: val };
    }
  }

  return undefined;
}

// ── MVCCExecutor ─────────────────────────────────────────────────

export class MVCCExecutor {
  /** XID for frozen rows — always visible, never garbage-collected. */
  public static readonly XID_FROZEN = 2;
  /** Maximum XID before wrap — PostgreSQL compat (2^31). */
  public static readonly XID_WRAP_LIMIT = 2_147_483_648;

  private readonly logger = PinoLogger.forComponent('mvccexecutor');

  private xidCounter: number = 3;
  private activeTxns: Map<string, MVCCTransaction> = new Map();
  /** P0-3: Set of XIDs for still-active transactions (faster conflict lookup). */
  private activeXidSet: Set<number> = new Set();
  private rowVersions: Map<string, RowVersion> = new Map();
  private config: MVCCConfig;
  /** Whether XID persistence via SQLite is initialized. */
  private xidTableInitialized = false;

  // C01: Per-row write serialization queues
  private writeQueues: Map<string, WriteQueueEntry[]> = new Map();
  private writeLocks: Set<string> = new Set(); // keys of rows currently being written

  // FOR UPDATE: Shared locks for FOR SHARE / FOR KEY SHARE
  // Map<key, Set<xid>> — multiple transactions can hold shared locks on the same row
  private shareLocks: Map<string, Set<number>> = new Map();

  // FOR UPDATE: Track which share locks are held by each transaction
  private txnShareLocks: Map<number, Set<string>> = new Map();

  // FOR UPDATE: Table-level locks (LOCK TABLE statement)
  // Map<tableName, Map<xid, lockMode>>
  private tableLocks: Map<string, Map<number, string>> = new Map();

  // C01: Conflict stats per session
  private conflictStats: Map<string, ConflictStats> = new Map();

  // C01: Degradation tracking per session
  private degradationRecords: Map<string, DegradationRecord> = new Map();

  // P0 gap: Per-row async mutexes for fine-grained locking
  private rowMutexes: Map<string, { mutex: Mutex; refCount: number }> = new Map();

  // C-04: Mutex protecting write lock acquisition to prevent TOCTOU between
  // `!writeLocks.has(key)` check and `writeLocks.add(key)` in async context
  private writeLockMutex: Mutex = new Mutex();

  // P0 gap: Isolation level per transaction
  private txnIsolation: Map<number, IsolationLevel> = new Map();

  // P0 gap: Snapshot data for REPEATABLE READ — previously a full copy of
  // all visible rows at txn start (O(#visible-rows) memory).  Now replaced
  // with xmin tracking on OwnWriteRow at write time (O(#writes) memory).
  // Kept as a field to avoid changing the interface, but no longer populated.
  private txnSnapshots: Map<number, Map<string, RowVersion>> = new Map();

  // SSI: Predicate locks — range-level for phantom prevention
  // When a SERIALIZABLE txn reads from a table with a WHERE clause,
  // it records precise range predicates instead of just the table name.
  // This enables fine-grained phantom detection:
  //   - Table-level: any INSERT into the same table triggers conflict
  //   - Range-level: only INSERTs whose values fall within the predicate's
  //     range trigger conflict (e.g., WHERE id BETWEEN 10 AND 20 only
  //     conflicts with INSERT of id=15, not id=9999)
  // Map<sessionId, Set<PredicateLock>>
  private predicateLocks: Map<string, Set<PredicateLock>> = new Map();

  // SSI: Track INSERTed row data for predicate matching
  // Map<sessionId, Map<tableName, rowData[]>>
  private insertedRowData: Map<string, Map<string, any[]>> = new Map();
  /** Committed INSERTs that fell within active predicate locks.
   *  Persisted after writer commit so that a later-committing reader can still
   *  detect phantom conflicts (writer committed before reader). */
  private committedPredicateWrites: Array<{ table: string; rowData: any; predLockTxnXid: number }> = [];

  // P0 gap: Read-set tracking for write-skew detection (SERIALIZABLE)
  private txnReadSets: Map<number, Set<string>> = new Map();

  // SSI: Read set tracking (sessionId-based, for SERIALIZABLE rw-conflict detection)
  readSets: Map<string, Set<string>> = new Map();

  // SSI: Write set tracking (sessionId-based, for SERIALIZABLE rw-conflict detection)
  writeSets: Map<string, Set<string>> = new Map();

  // MVCC Phase 1: Tracks actual row data written by each transaction
  // Map<txn xid, Map<rowKey, OwnWriteRow>>
  private txnOwnRowData: Map<number, Map<string, OwnWriteRow>> = new Map();

  // Phase 4: Operation counter for periodic cleanup trigger
  private operationCount: number = 0;

  // Phase 4: Cleanup interval (every 100 operations)
  private readonly CLEANUP_INTERVAL: number = 100;

  // Phase 4: Degradation thresholds
  private readonly CONFLICTS_BEFORE_DEGRADE_SERIALIZABLE: number = 3;
  private readonly CONFLICTS_BEFORE_DEGRADE_RR: number = 5;

  // Phase 4: Re-elevation cool-off in ms (30 seconds without conflict)
  private readonly ELEVATION_COOLDOWN_MS: number = 30000;

  // M-07: Max entries for conflictStats and degradationRecords to prevent unbounded growth
  private static readonly MAX_CONFLICT_STATS_ENTRIES = 1000;
  private static readonly MAX_DEGRADATION_RECORDS = 500;

  // Visibility Map: RowVersion GC stats
  private rowVersionGcFreed: number = 0;
  private rowVersionGcRuns: number = 0;

  // P0: WAL logger for durability
  private walLogger: MvccWalLogger | undefined;
  // P0: PgWalWriter for direct WAL ops (checkpoint, etc.)
  private pgWalWriter: PgWalWriter | undefined;
  // P0: Last WAL commit LSN for checkpoint tracking
  private lastCommitLSN: string = '0/0';
  // P1: Periodic deadlock detection timer
  private deadlockTimer: ReturnType<typeof setInterval> | null = null;
  // P1: Snapshot memory GC — tracks which XIDs should be GC'd
  private snapshotGCCandidates: Set<number> = new Set();
  // P2: Last checkpoint timestamp for periodic checkpointing
  private lastCheckpointTime: number = Date.now();
  // P2: XID wrap prevention — threshold at 2/3 of WRAP_LIMIT
  private static readonly XID_WRAP_WARNING_THRESHOLD = Math.floor(2_147_483_648 * 2 / 3);
  // P2: PRAGMA synchronous=FULL flag

  constructor(config?: Partial<MVCCConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // P14: Initialize XID persistence table in SQLite
    if (this.config.db) {
      this.initializeXidTable();
    }

    // P14: Restore XID counter from persisted state — SQLite takes precedence
    if (this.xidTableInitialized) {
      this.restoreXidFromDb();
    }

    // P14: Initialize row versions persistence table
    if (this.config.db) {
      this.initializeRowVersionsTable();
    }

    // P0-3: Restore XID counter from callback-based persisted state (backward compat)
    if (!this.xidTableInitialized && this.config.readPersistedXid) {
      const lastXid = this.config.readPersistedXid();
      if (lastXid !== null && lastXid > 0) {
        let newXid = lastXid + 1;
        // Ensure XID never falls below 3 to preserve XID_FROZEN
        newXid = Math.max(newXid, 3);
        this.xidCounter = newXid;
        this.logger.debug({ restoredXid: this.xidCounter }, 'MVCC XID counter restored from callback');
      }
    }

    // P0: Store WAL logger ref
    this.walLogger = this.config.walLogger;
    this.pgWalWriter = this.config.pgWalWriter;

    // P1: Start periodic deadlock detection (every 5 seconds)
    this.startDeadlockDetection();
  }

  // ── Transaction lifecycle ──────────────────────────────────────

  /**
   * Begin a new MVCC transaction.
   *
   * Generates a unique XID, records the snapshot (current high-water mark),
   * and stores the transaction in the active map keyed by `sessionId`.
   *
   * P0 gap: Enhanced with isolation level tracking and snapshot copying
   * for REPEATABLE READ.
   *
   * @param sessionId - Session identifier for the client.
   * @param isolation - Isolation level ('READ_COMMITTED', 'REPEATABLE_READ', 'SERIALIZABLE').
   * @param readOnly  - If `true`, conflict detection is skipped on commit.
   * @returns The newly created MVCCTransaction descriptor.
   */
  begin(sessionId: string, isolation: IsolationLevel, readOnly: boolean): MVCCTransaction {
    // Phase 4: Periodic cleanup trigger
    this.operationCount++;
    if (this.operationCount % this.CLEANUP_INTERVAL === 0) {
      this.cleanupStaleTxns();
    }

    const xid = this.allocateXid();

    // Normalize isolation level
    const isoLevel: IsolationLevel = this.normalizeIsolation(isolation);

    const snapshot = this.xidCounter - 1;
    const txn: MVCCTransaction = {
      xid,
      started: Date.now(),
      snapshot,
      readOnly,
      timeoutMs: this.config.defaultTimeoutMs,
    };

    this.activeTxns.set(sessionId, txn);
    this.activeXidSet.add(xid);
    this.txnIsolation.set(xid, isoLevel);

    // P0 gap: For REPEATABLE READ, capture snapshot metadata at txn start.
    // Conflict detection at commit uses the per-row prevXmin recorded in
    // OwnWriteRow (O(#writes)) instead of requiring a full row copy.
    // No data is copied here — snapshot capture is O(1).

    // P14: Persist XID counter to survive restarts
    this.persistXidIfEnabled();

    this.logger.info(
      { sessionId, xid, isolation: isoLevel, readOnly, snapshot: txn.snapshot },
      'MVCC txn began',
    );

    return txn;
  }

  /**
   * Commit an active MVCC transaction.
   *
   * For read-write transactions, performs write-conflict detection. If no
   * conflicts are found, the transaction commits successfully. If a conflict
   * is detected, the transaction is rolled back and `false` is returned (the
   * caller should retry with a new transaction).
   *
   * @param sessionId - Session identifier whose transaction to commit.
   * @returns CommitResult — `{ success: true }` on success, `{ success: false, errorCode, errorMessage }` on failure.
   * @throws {Error} If the session has no active transaction.
   */
  commit(sessionId: string): CommitResult {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) {
      throw new Error(`MVCC commit: no active transaction for session "${sessionId}"`);
    }

    // Phase 4: Periodic cleanup trigger
    this.operationCount++;
    if (this.operationCount % this.CLEANUP_INTERVAL === 0) {
      this.cleanupStaleTxns();
    }

    if (txn.readOnly) {
      // Read-only txns skip conflict checks.
      this.activeTxns.delete(sessionId);
      this.activeXidSet.delete(txn.xid);
      this.txnIsolation.delete(txn.xid);
      this.txnSnapshots.delete(txn.xid);
      // Phase 4: Track commit stats
      this.recordCommitStats(sessionId);
      this.logger.info({ sessionId, xid: txn.xid }, 'MVCC read-only txn committed');
      return { success: true };
    }

    // P0 gap: REPEATABLE READ — check if any rows written by this txn
    // were modified by a concurrent transaction after our snapshot.
    // Uses prevXmin stored in OwnWriteRow (O(#writes)) instead of iterating
    // a full copy of all visible rows (O(#rows)).
    const isoLevel = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
    if (isoLevel === 'REPEATABLE_READ') {
      const ownData = this.txnOwnRowData.get(txn.xid);
      if (ownData) {
        for (const [key, ownRow] of ownData) {
          if (ownRow.type === 'INSERT' || ownRow.prevXmin === undefined) continue;
          const currentRv = this.rowVersions.get(key);
          // If row doesn't exist anymore or its xmin is no longer ours,
          // another txn wrote a newer version after us
          if (!currentRv || currentRv.xmin !== txn.xid) {
            this.recordConflict(sessionId);
            this.recordRollbackStats(sessionId);
            this.rollback(sessionId);
            this.cleanupReadWriteSets(sessionId);
            this.logger.warn(
              { sessionId, xid: txn.xid, key, prevXmin: ownRow.prevXmin },
              'MVCC REPEATABLE READ anomaly — row modified by concurrent txn',
            );
            return { success: false };
          }
        }
      }
    }

    // SSI: SERIALIZABLE rw-cycle detection — replaces simplified write-skew check
    // Uses readSet/writeSet rw-dependency graph cycle detection.
    // If a cycle exists (G2 anomaly), the transaction is aborted with 40001.
    if (isoLevel === 'SERIALIZABLE') {
      const conflict = this.detectSerializationConflict(sessionId);
      if (conflict.conflict) {
        this.recordConflict(sessionId);
        this.recordRollbackStats(sessionId);
        this.rollback(sessionId);
        this.cleanupReadWriteSets(sessionId);
        this.logger.warn(
          { sessionId, victimXid: conflict.victimXid },
          'MVCC SERIALIZABLE rw-cycle detected — serialization failure (40001)',
        );
        return {
          success: false,
          errorCode: '40001',
          errorMessage: 'could not serialize access due to read/write dependencies among transactions',
        };
      }

      // Predicate-based conflict (phantom prevention): if this txn has a predicate
      // lock on a table that another active SERIALIZABLE txn inserted into,
      // abort this txn to prevent phantom reads.
      const predConflict = this.detectPredicateConflict(sessionId);
      if (predConflict) {
        this.recordConflict(sessionId);
        this.recordRollbackStats(sessionId);
        this.rollback(sessionId);
        this.cleanupReadWriteSets(sessionId);
        this.logger.warn(
          { sessionId, msg: 'Predicate conflict — phantom prevention abort (40001)' },
          'MVCC SERIALIZABLE predicate conflict detected',
        );
        return {
          success: false,
          errorCode: '40001',
          errorMessage: 'could not serialize access due to phantom read detection',
        };
      }
    }

    // ── Conflict detection ──────────────────────────────────────
    // C01: Record the pre-commit snapshot for conflict tracking
    const preCommitHasConflict = this.hasConflict(txn);

    if (preCommitHasConflict) {
      this.recordConflict(sessionId);
      this.recordRollbackStats(sessionId);
      this.rollback(sessionId);
      this.cleanupReadWriteSets(sessionId);
      this.logger.warn(
        { sessionId, xid: txn.xid },
        'MVCC write conflict detected — serialization failure (40P01)',
      );
      return { success: false };
    }

    // C01: Reset conflict stats on success (so retry counter resets)
    this.resetConflictStats(sessionId);

    // Phase 4: Track commit stats, update last activity
    this.recordCommitStats(sessionId);

    // Phase 4: Check if session can be re-elevated
    this.checkElevation(sessionId);

    // C01: Release all write locks held by this txn
    this.releaseTxnWriteLocks(txn.xid);

    // FOR UPDATE: Release shared locks and table locks
    this.releaseTxnShareLocks(txn.xid);
    this.releaseTxnTableLocks(txn.xid);

    // C01: Clean up deadlock state
    this.clearWait(txn.xid);
    this.txnDeadlocked.delete(txn.xid);

    // ── Success ─────────────────────────────────────────────────
    // Advance the snapshot watermark so future transactions see this
    // transaction's writes.
    txn.snapshot = txn.xid;
    this.activeTxns.delete(sessionId);
    this.activeXidSet.delete(txn.xid);
    this.txnIsolation.delete(txn.xid);
    this.txnSnapshots.delete(txn.xid);
    this.txnReadSets.delete(txn.xid);
    this.txnOwnRowData.delete(txn.xid);
    this.cleanupReadWriteSets(sessionId);

    // P0: WAL — log commit before marking success
    if (this.walLogger) {
      this.walLogger.logCommit(sessionId, txn.xid);
    }

    // Visibility Map: Trigger RowVersion GC if map exceeds threshold
    const maxVersions = this.config.maxRowVersions ?? 100_000;
    const threshold = this.config.rowVersionGcThreshold ?? 0.8;
    if (this.rowVersions.size >= maxVersions * threshold) {
      // Fire-and-forget — don't block commit
      setImmediate(() => {
        try { this.gcRowVersions(true); } catch { /* best-effort */ }
      });
    }

    this.logger.info({ sessionId, xid: txn.xid }, 'MVCC txn committed');
    return { success: true };
  }

  /**
   * Roll back (abandon) an active MVCC transaction.
   *
   * Discards all uncommitted writes associated with the transaction.
   *
   * @param sessionId - Session identifier whose transaction to roll back.
   */
  rollback(sessionId: string): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) {
      this.logger.warn({ sessionId }, 'MVCC rollback: no active transaction');
      return;
    }

    this.activeTxns.delete(sessionId);
    this.activeXidSet.delete(txn.xid);
    this.txnIsolation.delete(txn.xid);
    this.txnSnapshots.delete(txn.xid);

    // Phase 4: Track rollback stats
    this.recordRollbackStats(sessionId);

    // Remove all row version entries written by this txn (uncommitted).
    for (const [key, rv] of this.rowVersions) {
      if (rv.xmin === txn.xid) {
        this.rowVersions.delete(key);
        // Also remove from SQLite persistence
        this.deleteRowVersion(key);
      }
    }

    // Clean up read-set tracking for this txn
    this.txnReadSets.delete(txn.xid);
    // Clean up own row data
    this.txnOwnRowData.delete(txn.xid);

    // C01: Release all write locks held by this txn
    this.releaseTxnWriteLocks(txn.xid);

    // FOR UPDATE: Release shared locks and table locks
    this.releaseTxnShareLocks(txn.xid);
    this.releaseTxnTableLocks(txn.xid);

    // C01: Clean up deadlock state
    this.clearWait(txn.xid);
    this.txnDeadlocked.delete(txn.xid);
    this.cleanupReadWriteSets(sessionId);

    // P0: WAL — log abort
    if (this.walLogger) {
      this.walLogger.logAbort(sessionId, txn.xid);
    }

    this.logger.info({ sessionId, xid: txn.xid }, 'MVCC txn rolled back');
  }

  // ── C01: Row tracking for write lock management ──────────────

  /**
   * Track which rows a txn has write-locked so we can release them on rollback.
   * Maps xid → Set of `${table}:${rowId}` keys.
   */
  private txnWriteLocks: Map<number, Set<string>> = new Map();

  // ── Deadlock detection state ─────────────────────────────────

  /**
   * Track which resource each txn is currently waiting for.
   * Maps xid → key string (`${table}:${rowId}`).
   */
  private txnWaitFor: Map<number, string> = new Map();

  /**
   * Set of XIDs that have been marked as deadlock victims.
   */
  private txnDeadlocked: Set<number> = new Set();

  // ── Deadlock detection (Wait-For Graph) ──────────────────────

  /**
   * Build a wait-for graph from current lock and wait state.
   * Returns Map<XID, Set<XID>> where X → Y means X is waiting for Y.
   */
  private buildWaitForGraph(): Map<number, Set<number>> {
    const edges = new Map<number, Set<number>>();

    for (const [waiterXid, key] of this.txnWaitFor) {
      // Skip deadlocked transactions
      if (this.txnDeadlocked.has(waiterXid)) continue;

      for (const [holderXid, heldKeys] of this.txnWriteLocks) {
        if (holderXid !== waiterXid && heldKeys.has(key)) {
          if (!edges.has(waiterXid)) {
            edges.set(waiterXid, new Set());
          }
          edges.get(waiterXid)!.add(holderXid);
        }
      }
    }

    return edges;
  }

  /**
   * Check whether a deadlock exists in the current wait-for graph.
   * Uses DFS with tricolor marking (white/grey/black).
   * If a grey node is revisited, a cycle exists → deadlock.
   */
  private checkDeadlock(): boolean {
    const edges = this.buildWaitForGraph();
    if (edges.size === 0) return false;

    type Color = 'white' | 'grey' | 'black';
    const color = new Map<number, Color>();

    // Initialize all nodes as white
    const allNodes = new Set<number>();
    for (const [from, tos] of edges) {
      allNodes.add(from);
      for (const to of tos) allNodes.add(to);
    }
    for (const xid of allNodes) {
      color.set(xid, 'white');
    }

    const dfs = (xid: number): boolean => {
      color.set(xid, 'grey');

      const targets = edges.get(xid);
      if (targets) {
        for (const target of targets) {
          const c = color.get(target);
          if (c === 'grey') return true; // back edge → cycle
          if (c === 'white') {
            if (dfs(target)) return true;
          }
        }
      }

      color.set(xid, 'black');
      return false;
    };

    for (const xid of allNodes) {
      if (color.get(xid) === 'white') {
        if (dfs(xid)) return true;
      }
    }

    return false;
  }

  /**
   * Find a deadlock cycle involving the given XID.
   * Traverses the wait-for graph from the given node until a cycle is found.
   * Returns the nodes in the cycle (may include the given XID).
   */
  private findCycle(startXid: number): number[] {
    const edges = this.buildWaitForGraph();
    const visited = new Set<number>();
    const path: number[] = [];

    let current = startXid;
    while (!visited.has(current)) {
      visited.add(current);
      path.push(current);
      const nextSet = edges.get(current);
      if (!nextSet || nextSet.size === 0) break;
      // Pick the first (and typically only) target
      current = [...nextSet][0];
    }

    // If we found a cycle, trim to just the cycle
    const cycleStartIdx = path.indexOf(current);
    if (cycleStartIdx >= 0 && cycleStartIdx < path.length - 1) {
      return path.slice(cycleStartIdx);
    }

    // Fall back to full BFS-based cycle detection
    const fullColor = new Map<number, 'white' | 'grey' | 'black'>();
    const fullParent = new Map<number, number | null>();
    for (const [from, tos] of edges) {
      fullColor.set(from, 'white');
      for (const to of tos) fullColor.set(to, 'white');
    }

    let foundCycle: number[] = [];

    const dfs = (xid: number, parent: number | null): boolean => {
      fullColor.set(xid, 'grey');
      fullParent.set(xid, parent);

      for (const neighbor of edges.get(xid) || []) {
        if (fullColor.get(neighbor) === 'grey') {
          // Found cycle — extract it
          const cycle: number[] = [];
          let cur: number | null = xid;
          cycle.push(neighbor);
          while (cur !== null && cur !== neighbor) {
            cycle.push(cur);
            cur = fullParent.get(cur) ?? null;
          }
          if (cur === neighbor) cycle.push(cur);
          foundCycle = [...new Set(cycle)];
          return true;
        }
        if (fullColor.get(neighbor) === 'white') {
          if (dfs(neighbor, xid)) return true;
        }
      }

      fullColor.set(xid, 'black');
      return false;
    };

    for (const xid of fullColor.keys()) {
      if (fullColor.get(xid) === 'white') {
        if (dfs(xid, null)) break;
      }
    }

    return foundCycle.length > 0 ? foundCycle : [startXid];
  }

  /**
   * Select the victim transaction from a deadlock cycle.
   * The victim is the transaction with the smallest XID (youngest/recent).
   */
  private selectVictim(cycle: number[]): number {
    if (cycle.length === 0) return 0;
    return Math.min(...cycle);
  }

  /**
   * Register a wait for a transaction (for deadlock detection).
   */
  private recordWait(xid: number, key: string): void {
    this.txnWaitFor.set(xid, key);
  }

  /**
   * Clear the wait registration for a transaction.
   */
  private clearWait(xid: number): void {
    this.txnWaitFor.delete(xid);
  }

  /**
   * Check if a session's transaction has been marked as a deadlock victim.
   */
  isDeadlocked(sessionId: string): boolean {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return false;
    return this.txnDeadlocked.has(txn.xid);
  }

  /**
   * Register a row written by a transaction and acquire the write lock.
   * If another txn holds the lock, this returns false (caller should wait).
   * If a deadlock is detected and this txn is the victim, returns 'deadlocked'.
   */
  acquireRowWriteLock(sessionId: string, tableName: string, rowId: any): boolean | 'deadlocked' {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return true;

    const key = `${tableName}:${String(rowId)}`;

    // Already deadlocked — prevent further attempts
    if (this.txnDeadlocked.has(txn.xid)) {
      return 'deadlocked';
    }

    if (this.writeLocks.has(key)) {
      // Check if the write lock is held by THIS transaction
      const writeLockKeys = this.txnWriteLocks.get(txn.xid);
      if (writeLockKeys && writeLockKeys.has(key)) {
        // Own write lock — allow re-acquisition
        return true;
      }

      // Lock contended — register wait and check for deadlock
      this.recordWait(txn.xid, key);

      if (this.checkDeadlock()) {
        const cycle = this.findCycle(txn.xid);
        const victim = this.selectVictim(cycle);
        this.txnDeadlocked.add(victim);
        // Clear wait for the victim (it won't continue waiting)
        this.clearWait(victim);
        // Phase 4: Track deadlock count for the victim session
        this.recordDeadlockStats(victim);
        this.logger.warn(
          { xid: txn.xid, victim, cycle: Array.from(new Set(cycle)), key },
          'Deadlock detected',
        );

        if (victim === txn.xid) {
          return 'deadlocked';
        }
      }

      return false; // lock contended, no deadlock or not the victim
    }

    // Check for share lock contention: if another transaction holds a
    // shared (FOR SHARE/FOR KEY SHARE) lock on this row, write lock is blocked
    if (this.hasOtherShareLock(txn.xid, key)) {
      this.recordWait(txn.xid, key);
      // Since share→write is a conflict (not a deadlockable cycle),
      // just return false without deadlock detection
      this.clearWait(txn.xid);
      return false;
    }

    this.writeLocks.add(key);
    // Track for cleanup
    if (!this.txnWriteLocks.has(txn.xid)) {
      this.txnWriteLocks.set(txn.xid, new Set());
    }
    this.txnWriteLocks.get(txn.xid)!.add(key);

    // SSI: Record to writeSets for rw-dependency detection
    if (txn.xid) {
      if (!this.writeSets.has(sessionId)) {
        this.writeSets.set(sessionId, new Set());
      }
      this.writeSets.get(sessionId)!.add(key);
    }

    return true;
  }

  /**
   * Release all write locks held by a transaction (on commit/rollback).
   */
  private releaseTxnWriteLocks(xid: number): void {
    const keys = this.txnWriteLocks.get(xid);
    if (!keys) return;
    for (const key of keys) {
      this.releaseWriteLockByKey(key);
    }
    this.txnWriteLocks.delete(xid);
  }

  /**
   * Release a write lock by its table:rowId key.
   */
  private releaseWriteLockByKey(key: string): void {
    const queue = this.writeQueues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.writeQueues.delete(key);
      } else {
        this.writeQueues.set(key, queue);
      }
      next.resolve();
    } else {
      this.writeLocks.delete(key);
      this.writeQueues.delete(key);
    }
  }

  /**
   * Release a write lock on a row.
   */
  releaseWriteLock(tableName: string, rowId: any): void {
    this.releaseWriteLockByKey(`${tableName}:${String(rowId)}`);
  }

  // ── Shared (SHARE) locks — FOR SHARE / FOR KEY SHARE ────────

  /**
   * Get the XID for a session's active transaction.
   * Returns `undefined` if no active transaction or the txn is read-only.
   */
  getTxnXid(sessionId: string): number | undefined {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return undefined;
    return txn.xid;
  }

  /**
   * Acquire a shared (read) lock on a row, for FOR SHARE / FOR KEY SHARE.
   *
   * Shared locks are compatible with each other (multiple transactions can
   * hold a shared lock on the same row), but incompatible with write locks
   * (FOR UPDATE / FOR NO KEY UPDATE).
   *
   * @param sessionId - Session identifier.
   * @param tableName - Table name.
   * @param rowId     - Row identifier.
   * @returns `true` if the lock was acquired, `false` if contention exists.
   */
  acquireRowShareLock(sessionId: string, tableName: string, rowId: any): boolean {
    const xid = this.getTxnXid(sessionId);
    if (xid === undefined) return true; // Read-only txn or no txn → no locking needed
    const key = `${tableName}:${String(rowId)}`;

    // Check if the row has a write lock held by another transaction
    if (this.writeLocks.has(key)) {
      // Check if write lock is held by THIS transaction
      const writeLockKeys = this.txnWriteLocks.get(xid);
      if (writeLockKeys && writeLockKeys.has(key)) {
        // Own write lock is compatible with own shared lock
        // Register share lock too
        if (!this.shareLocks.has(key)) {
          this.shareLocks.set(key, new Set());
        }
        this.shareLocks.get(key)!.add(xid);
        if (!this.txnShareLocks.has(xid)) {
          this.txnShareLocks.set(xid, new Set());
        }
        this.txnShareLocks.get(xid)!.add(key);
        return true;
      }
      // Write lock held by another txn — contention
      return false;
    }

    // Register the shared lock
    if (!this.shareLocks.has(key)) {
      this.shareLocks.set(key, new Set());
    }
    this.shareLocks.get(key)!.add(xid);

    // Track for cleanup
    if (!this.txnShareLocks.has(xid)) {
      this.txnShareLocks.set(xid, new Set());
    }
    this.txnShareLocks.get(xid)!.add(key);

    // SSI: Record to readSets for rw-dependency
    this.recordReadOperation(sessionId, tableName, String(rowId));

    return true;
  }

  /**
   * Check if a row has any shared lock held by other transactions.
   * Used by acquireRowWriteLock to enforce share→write lock incompatibility.
   */
  private hasOtherShareLock(xid: number, key: string): boolean {
    const shareHolders = this.shareLocks.get(key);
    if (!shareHolders || shareHolders.size === 0) return false;
    // Check if any holder other than this xid has a share lock
    for (const holder of shareHolders) {
      if (holder !== xid) return true;
    }
    return false;
  }

  /**
   * Release all shared locks held by a transaction (on commit/rollback).
   */
  private releaseTxnShareLocks(xid: number): void {
    const keys = this.txnShareLocks.get(xid);
    if (!keys) return;
    for (const key of keys) {
      const holders = this.shareLocks.get(key);
      if (holders) {
        holders.delete(xid);
        if (holders.size === 0) {
          this.shareLocks.delete(key);
        }
      }
    }
    this.txnShareLocks.delete(xid);
  }

  /**
   * Release a specific shared lock on a row.
   */
  releaseRowShareLock(sessionId: string, tableName: string, rowId: any): void {
    const xid = this.getTxnXid(sessionId);
    if (xid === undefined) return;
    const key = `${tableName}:${String(rowId)}`;
    const holders = this.shareLocks.get(key);
    if (holders) {
      holders.delete(xid);
      if (holders.size === 0) {
        this.shareLocks.delete(key);
      }
    }
    const txnKeys = this.txnShareLocks.get(xid);
    if (txnKeys) {
      txnKeys.delete(key);
      if (txnKeys.size === 0) {
        this.txnShareLocks.delete(xid);
      }
    }
  }

  // ── Table-level locks (LOCK TABLE) ──────────────────────────

  /**
   * Lock modes ranked by strength (higher = more restrictive).
   */
  private static readonly LOCK_MODE_RANK: Record<string, number> = {
    'ACCESS SHARE': 1,
    'ROW SHARE': 2,
    'ROW EXCLUSIVE': 3,
    'SHARE UPDATE EXCLUSIVE': 4,
    'SHARE': 5,
    'SHARE ROW EXCLUSIVE': 6,
    'EXCLUSIVE': 7,
    'ACCESS EXCLUSIVE': 8,
  };

  /**
   * Lock mode compatibility matrix.
   * Returns `true` if modeA is compatible with modeB (both can be held concurrently).
   *
   * The matrix implements PostgreSQL's lock mode compatibility:
   *   ACCESS SHARE: compatible with everything except ACCESS EXCLUSIVE
   *   ROW SHARE: compatible with everything except EXCLUSIVE, ACCESS EXCLUSIVE
   *   ROW EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE
   *   SHARE UPDATE EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE, SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE
   *   SHARE: compatible with ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE
   *   SHARE ROW EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE
   *   EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE
   *   ACCESS EXCLUSIVE: compatible with nothing
   *
   * Simplified: higher rank = fewer compatibilities.
   */
  static areLockModesCompatible(modeA: string, modeB: string): boolean {
    const rankA = MVCCExecutor.LOCK_MODE_RANK[modeA.toUpperCase()] ?? 1;
    const rankB = MVCCExecutor.LOCK_MODE_RANK[modeB.toUpperCase()] ?? 1;

    // ACCESS EXCLUSIVE blocks everything (including itself from other txns)
    if (rankA >= 8 || rankB >= 8) return false;

    // EXCLUSIVE: only compatible with ACCESS SHARE and ROW SHARE
    if (rankA >= 7 && rankB <= 2) return true;
    if (rankB >= 7 && rankA <= 2) return true;
    if (rankA >= 7 || rankB >= 7) return false;

    // SHARE ROW EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE
    if (rankA >= 6 && rankB <= 2) return true;
    if (rankB >= 6 && rankA <= 2) return true;
    if (rankA >= 6 || rankB >= 6) return false;

    // SHARE: compatible with ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE, SHARE UPDATE EXCLUSIVE, SHARE
    if (rankA === 5 && rankB <= 5) return true;
    if (rankB === 5 && rankA <= 5) return true;

    // SHARE UPDATE EXCLUSIVE: compatible with ACCESS SHARE, ROW SHARE, SHARE, SHARE UPDATE EXCLUSIVE
    if (rankA === 4 && (rankB <= 2 || rankB === 4 || rankB === 5)) return true;
    if (rankB === 4 && (rankA <= 2 || rankA === 4 || rankA === 5)) return true;

    // Remaining incompatibilities
    return rankA <= 3 && rankB <= 3;
  }

  /**
   * Acquire a table-level lock (LOCK TABLE statement).
   *
   * @param sessionId - Session identifier.
   * @param tableName - Table name to lock.
   * @param lockMode  - Lock mode (e.g. 'ACCESS EXCLUSIVE', 'SHARE', etc.).
   * @param nowait    - If true, fail immediately if lock not available.
   * @returns `true` if lock acquired, `false` if contention and NOWAIT.
   */
  lockTable(sessionId: string, tableName: string, lockMode: string = 'ACCESS EXCLUSIVE', nowait: boolean = false): boolean {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return true;
    const xid = txn.xid;
    const tableUpper = tableName.toUpperCase();
    const modeUpper = lockMode.toUpperCase();

    // Check existing table locks
    const existingLocks = this.tableLocks.get(tableUpper);
    if (existingLocks) {
      for (const [holderXid, holderMode] of existingLocks) {
        if (holderXid === xid) continue;
        // Check if the holder's lock is compatible with requested lock
        if (!MVCCExecutor.areLockModesCompatible(holderMode, modeUpper)) {
          if (nowait) {
            return false;
          }
          // For simplicity, return false if incompatible
          return false;
        }
      }
    }

    // Register the lock
    if (!this.tableLocks.has(tableUpper)) {
      this.tableLocks.set(tableUpper, new Map());
    }
    this.tableLocks.get(tableUpper)!.set(xid, modeUpper);

    this.logger.debug({ tableName, lockMode: modeUpper, xid }, 'Table-level lock acquired');
    return true;
  }

  /**
   * Release all table-level locks held by a transaction (on commit/rollback).
   */
  private releaseTxnTableLocks(xid: number): void {
    for (const [tableName, lockMap] of this.tableLocks) {
      if (lockMap.has(xid)) {
        lockMap.delete(xid);
        if (lockMap.size === 0) {
          this.tableLocks.delete(tableName);
        }
      }
    }
  }

  // ── C01: acquireRowWriteLock (non-blocking) ─────────────────

  /**
   * Try to acquire a write lock for a specific row without waiting.
   * Returns true if acquired, false if contended.
   * Used by QueryRouter for synchronous write-path integration.
   */

  // ── end releaseWriteLock ──────────────────────────────────────

  /**
   * Detect whether a write conflict exists for the given transaction.
   *
   * A conflict occurs when any row modified by this transaction has been
   * modified by another ACTIVE transaction whose XID is > this txn's snapshot.
   *
   * @param sessionId - Session identifier to check.
   * @param tableName - Table name (scoped check).
   * @param rowId     - Row identifier (scoped check).
   * @returns `true` if a conflict was detected.
   */
  detectConflict(sessionId: string, tableName: string, rowId: any): boolean {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return false;

    const key = `${tableName}:${String(rowId)}`;
    const rv = this.rowVersions.get(key);

    if (!rv) return false;

    // P0-3: Only check conflicts against ACTIVE transactions
    if (rv.xmax !== null && rv.xmax > txn.snapshot && this.activeXidSet.has(rv.xmax)) {
      if (this.config.verboseConflictLogging) {
        this.logger.warn(
          { sessionId, xid: txn.xid, tableName, rowId, rowXmax: rv.xmax, snapshot: txn.snapshot },
          'Write conflict detected on row',
        );
      }
      return true;
    }

    return false;
  }

  /**
   * Check whether the current transaction has exceeded its timeout.
   *
   * @param sessionId - Session identifier to check.
   * @returns `true` if the transaction has timed out.
   */
  isExpired(sessionId: string): boolean {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.timeoutMs === undefined) return false;

    return Date.now() - txn.started > txn.timeoutMs;
  }

  /**
   * Record a row version for conflict tracking.
   *
   * Called by the QueryRouter when INSERT/UPDATE/DELETE touches a row.
   *
   * @param sessionId - Session performing the write.
   * @param tableName - Table being modified.
   * @param rowId     - Row identifier.
   * @param isDelete  - If `true`, sets _xmax (logical delete). If `false` (insert/update), sets _xmin.
   */
  recordWrite(sessionId: string, tableName: string, rowId: any, isDelete: boolean = false): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return;

    const key = `${tableName}:${String(rowId)}`;

    // C01: Track write lock for cleanup on commit/rollback
    if (!this.txnWriteLocks.has(txn.xid)) {
      this.txnWriteLocks.set(txn.xid, new Set());
    }
    this.txnWriteLocks.get(txn.xid)!.add(key);
    // SSI: Record to writeSets for rw-dependency detection
    if (!this.writeSets.has(sessionId)) {
      this.writeSets.set(sessionId, new Set());
    }
    this.writeSets.get(sessionId)!.add(key);
    // Also mark as write-locked (non-blocking)
    this.writeLocks.add(key);

    if (isDelete) {
      // Mark the current version as deleted by this txn
      const existing = this.rowVersions.get(key);
      if (existing) {
        existing.xmax = txn.xid;
        // Persist updated xmax to SQLite
        this.persistRowVersion(key, existing.xmin, existing.xmax);
      }
    } else {
      // Insert or update — create a new version
      const rv: RowVersion = { xmin: txn.xid, xmax: null };
      this.rowVersions.set(key, rv);
      // Persist new row version to SQLite
      this.persistRowVersion(key, rv.xmin, rv.xmax);
    }
  }

  /**
   * Record a row read for write-skew detection in SERIALIZABLE transactions.
   * Tracks which rows were read by the current txn so commit-time detection
   * can identify write-skew anomalies.
   */
  recordRead(sessionId: string, tableName: string, rowId: any): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return;

    // Only track reads for SERIALIZABLE transactions
    const isoLevel = this.txnIsolation.get(txn.xid);
    if (isoLevel !== 'SERIALIZABLE') return;

    const key = `${tableName}:${String(rowId)}`;
    if (!this.txnReadSets.has(txn.xid)) {
      this.txnReadSets.set(txn.xid, new Set());
    }
    this.txnReadSets.get(txn.xid)!.add(key);
  }

  /**
   * SSI: Record a row read for rw-dependency detection in SERIALIZABLE transactions.
   * Records to both the new sessionId-based readSets (for SSI cycle detection)
   * and the existing xid-based txnReadSets (for backward compat).
   *
   * @param sessionId - Session identifier.
   * @param tableName - Table name.
   * @param rowId     - Row identifier.
   */
  recordReadOperation(sessionId: string, tableName: string, rowId: string): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return;

    // Only track reads for SERIALIZABLE transactions
    const isoLevel = this.txnIsolation.get(txn.xid);
    if (isoLevel !== 'SERIALIZABLE') return;

    const key = `${tableName}:${String(rowId)}`;

    // Record to SSI readSets (sessionId-based)
    if (!this.readSets.has(sessionId)) {
      this.readSets.set(sessionId, new Set());
    }
    this.readSets.get(sessionId)!.add(key);

    // Also record to existing txnReadSets for backward compat
    if (!this.txnReadSets.has(txn.xid)) {
      this.txnReadSets.set(txn.xid, new Set());
    }
    this.txnReadSets.get(txn.xid)!.add(key);
  }

  /**
   * Get the active transaction for a session.
   *
   * @param sessionId - Session identifier.
   * @returns The active transaction, or `undefined` if none.
   */
  getTransaction(sessionId: string): MVCCTransaction | undefined {
    return this.activeTxns.get(sessionId);
  }

  /**
   * SSI: Clean up read/write sets for a session after commit or rollback.
   */
  cleanupReadWriteSets(sessionId: string): void {
    const txn = this.activeTxns.get(sessionId);
    if (txn) {
      // Clean up committedPredicateWrites entries for this txn's predicate locks
      const xid = txn.xid;
      for (let i = this.committedPredicateWrites.length - 1; i >= 0; i--) {
        if (this.committedPredicateWrites[i].predLockTxnXid === xid) {
          this.committedPredicateWrites.splice(i, 1);
        }
      }
    }
    this.readSets.delete(sessionId);
    this.writeSets.delete(sessionId);
    this.predicateLocks.delete(sessionId);
    this.insertedRowData.delete(sessionId);
  }

  /**
   * SSI: Record a predicate lock for a SERIALIZABLE transaction.
   *
   * When a SERIALIZABLE txn reads from a table, it acquires a predicate lock.
   * The lock captures the specific WHERE range so that only INSERTs whose
   * values fall within that range trigger phantom conflicts.
   *
   * Variants:
   *   - recordPredicateLock(sessionId, table) — table-level (backward compat)
   *   - recordPredicateLock(sessionId, table, { column, eqValue }) — exact match
   *   - recordPredicateLock(sessionId, table, { column, minValue, maxValue }) — range
   */
  recordPredicateLock(sessionId: string, table: string, range?: {
    column?: string;
    eqValue?: any;
    minValue?: any;
    maxValue?: any;
  }): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return;

    const isoLevel = this.txnIsolation.get(txn.xid);
    if (isoLevel !== 'SERIALIZABLE') return;

    if (!this.predicateLocks.has(sessionId)) {
      this.predicateLocks.set(sessionId, new Set());
    }

    const lock: PredicateLock = { table };

    if (range) {
      if (range.column) lock.column = range.column;
      if (range.eqValue !== undefined) lock.eqValue = range.eqValue;
      if (range.minValue !== undefined) lock.minValue = range.minValue;
      if (range.maxValue !== undefined) lock.maxValue = range.maxValue;
    }

    this.predicateLocks.get(sessionId)!.add(lock);
  }

  /**
   * SSI: Record an INSERTed row for predicate conflict checking.
   * Stores full row data so that at commit time we can check if the
   * INSERTed row matches any active predicate lock's range.
   */
  recordInsertRow(sessionId: string, table: string, rowData: any): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return;

    if (!this.insertedRowData.has(sessionId)) {
      this.insertedRowData.set(sessionId, new Map());
    }
    const tableMap = this.insertedRowData.get(sessionId)!;
    if (!tableMap.has(table)) {
      tableMap.set(table, []);
    }
    tableMap.get(table)!.push(rowData);

    // Check if this INSERT matches any active predicate lock.
    // If so, record it in committedPredicateWrites so the reader-side
    // detection can still find it even after this txn commits and cleans up.
    const txnIso = this.txnIsolation.get(txn.xid);
    if (txnIso !== 'SERIALIZABLE') return;

    for (const [otherSid, otherTxn] of this.activeTxns) {
      if (otherSid === sessionId) continue;
      if (otherTxn.readOnly) continue;

      const otherIso = this.txnIsolation.get(otherTxn.xid);
      if (otherIso !== 'SERIALIZABLE') continue;

      const preds = this.predicateLocks.get(otherSid);
      if (!preds || preds.size === 0) continue;

      for (const lock of preds) {
        if (lock.table !== table) continue;
        if (this.rowMatchesPredicate(rowData, lock)) {
          this.committedPredicateWrites.push({
            table,
            rowData: { ...rowData },
            predLockTxnXid: otherTxn.xid,
          });
          this.logger.debug(
            { sessionId, otherSid, table, lock },
            'SSI: INSERT matches predicate lock — recorded for phantom detection',
          );
        }
      }
    }
  }

  /**
   * SSI: Check if any INSERTed row from session B matches a predicate lock
   * held by session A. Used to detect phantom-read conflicts between
   * concurrent SERIALIZABLE transactions.
   */
    /**
   * SSI: Detect rw-dependency cycles (G2 anomaly / serialization anomaly)
   * among active SERIALIZABLE transactions.
   *
   * Algorithm:
   * 1. Collect all active SERIALIZABLE transactions (non-read-only)
   * 2. Build rw-dependency graph:
   *    - A reads what B wrote → A→B edge
   * 3. Detect cycles in the dependency graph using DFS
   * 4. If a cycle exists, return the victim (smallest XID in cycle)
   *
   * @param sessionId - Session identifier of the committing transaction.
   * @returns Conflict result with victim XID if a cycle was detected.
   */
  detectSerializationConflict(sessionId: string): { conflict: boolean; victimXid?: number } {
    const thisTxn = this.activeTxns.get(sessionId);
    if (!thisTxn) return { conflict: false };

    const isoLevel = this.txnIsolation.get(thisTxn.xid);
    if (isoLevel !== 'SERIALIZABLE') return { conflict: false };

    // Collect all active SERIALIZABLE sessions (excluding read-only)
    const serializableSessions: string[] = [];
    for (const [sid, txn] of this.activeTxns) {
      if (txn.readOnly) continue;
      const otherIso = this.txnIsolation.get(txn.xid);
      if (otherIso !== 'SERIALIZABLE') continue;
      serializableSessions.push(sid);
    }

    // Need at least 2 active SERIALIZABLE txns for a cycle
    if (serializableSessions.length < 2) return { conflict: false };

    // Build rw-dependency graph (sessionId → Set<sessionId>)
    const rwEdges: Map<string, Set<string>> = new Map();

    // Step 1: Existing row-level rw-conflicts (readSet ∩ writeSet)
    for (const sidA of serializableSessions) {
      const readSetA = this.readSets.get(sidA);
      if (!readSetA || readSetA.size === 0) continue;

      for (const sidB of serializableSessions) {
        if (sidA === sidB) continue;

        const writeSetB = this.writeSets.get(sidB);
        if (!writeSetB || writeSetB.size === 0) continue;

        // Check if A reads any row that B wrote → A→B rw-dependency
        for (const key of readSetA) {
          if (writeSetB.has(key)) {
            if (!rwEdges.has(sidA)) rwEdges.set(sidA, new Set());
            rwEdges.get(sidA)!.add(sidB);
            break;
          }
        }
      }
    }

    // Step 2: Predicate-based rw-conflicts (phantom prevention)
    // A holds a predicate lock on table T, B INSERTed into T → A→B edge
    for (const sidA of serializableSessions) {
      const predsA = this.predicateLocks.get(sidA);
      if (!predsA || predsA.size === 0) continue;

      for (const sidB of serializableSessions) {
        if (sidA === sidB) continue;

        const insertsB = this.insertedRowData.get(sidB);
        if (!insertsB || insertsB.size === 0) continue;

        // Check if B inserted into any table that A has a predicate lock on
        for (const lock of predsA) {
          const rows = insertsB.get(lock.table);
          if (rows && rows.length > 0) {
            if (!rwEdges.has(sidA)) rwEdges.set(sidA, new Set());
            rwEdges.get(sidA)!.add(sidB);
            break;
          }
        }
      }
    }

    if (rwEdges.size === 0) return { conflict: false };

    // Full DFS cycle detection — handles 2-transaction cycles AND
    // longer cycles (A→B→C→A or longer). C-05: Always run the full DFS
    // instead of returning early on the simplified bidirectional check,
    // because 3+ transaction cycles would be missed by a 2-way check.
    type Color = 'white' | 'gray' | 'black';
    const color: Map<string, Color> = new Map();
    for (const sid of serializableSessions) color.set(sid, 'white');

    let hasCycle = false;
    let cycleSids: string[] = [];

    const dfs = (sid: string, path: string[]): void => {
      if (hasCycle) return;
      color.set(sid, 'gray');
      path.push(sid);

      const neighbors = rwEdges.get(sid);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (color.get(neighbor) === 'gray') {
            // Found a cycle
            hasCycle = true;
            const cycleStart = path.indexOf(neighbor);
            cycleSids = path.slice(cycleStart);
            return;
          }
          if (color.get(neighbor) === 'white') {
            dfs(neighbor, path);
            if (hasCycle) return;
          }
        }
      }

      path.pop();
      color.set(sid, 'black');
    };

    for (const sid of serializableSessions) {
      if (color.get(sid) === 'white') {
        dfs(sid, []);
        if (hasCycle) break;
      }
    }

    if (hasCycle && cycleSids.length >= 2) {
      let minXid = Infinity;
      for (const sid of cycleSids) {
        const txn = this.activeTxns.get(sid);
        if (txn && txn.xid < minXid) minXid = txn.xid;
      }
      if (minXid < Infinity) {
        return { conflict: true, victimXid: minXid };
      }
    }

    return { conflict: false };
  }

  /**
   * SSI: Check if an INSERTed row value falls within a predicate lock's range.
   * Handles exact-match (eqValue) and range (minValue/maxValue) predicates.
   * Falls back to conservative (match=true) when the column is unknown or
   * values are non-comparable, ensuring correctness over false negatives.
   */
  private rowMatchesPredicate(rowData: any, lock: PredicateLock): boolean {
    if (lock.eqValue !== undefined && lock.column) {
      const rowVal = rowData[lock.column];
      if (rowVal === undefined) return true; // Unknown column — conservative
      const eqNum = Number(lock.eqValue);
      const rowNum = Number(rowVal);
      if (!isNaN(eqNum) && !isNaN(rowNum)) {
        return rowNum === eqNum;
      }
      return String(rowVal) === String(lock.eqValue);
    }

    if (lock.minValue !== undefined || lock.maxValue !== undefined) {
      if (!lock.column) return true; // Conservative fallback
      const rowVal = rowData[lock.column];
      if (rowVal === undefined) return true;
      const rowNum = Number(rowVal);
      if (isNaN(rowNum)) return true; // Non-numeric — conservative

      if (lock.minValue !== undefined) {
        const minNum = Number(lock.minValue);
        if (!isNaN(minNum) && rowNum < minNum) return false;
      }
      if (lock.maxValue !== undefined) {
        const maxNum = Number(lock.maxValue);
        if (!isNaN(maxNum) && rowNum > maxNum) return false;
      }
      return true;
    }

    // Table-level predicate (no column, no range): any INSERT matches
    return true;
  }

  /**
   * SSI: Detect if any concurrent SERIALIZABLE transaction's INSERTed rows
   * fall within this transaction's predicate lock ranges.
   */
  private detectPredicateConflict(sessionId: string): boolean {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return false;

    const isoLevel = this.txnIsolation.get(txn.xid);
    if (isoLevel !== 'SERIALIZABLE') return false;

    const preds = this.predicateLocks.get(sessionId);
    if (!preds || preds.size === 0) return false;

    // Check 1: Active SERIALIZABLE transactions' INSERTed rows
    for (const [otherSid, otherTxn] of this.activeTxns) {
      if (otherSid === sessionId) continue;
      if (otherTxn.readOnly) continue;

      const otherIso = this.txnIsolation.get(otherTxn.xid);
      if (otherIso !== 'SERIALIZABLE') continue;

      const inserts = this.insertedRowData.get(otherSid);
      if (!inserts || inserts.size === 0) continue;

      for (const lock of preds) {
        const rows = inserts.get(lock.table);
        if (!rows || rows.length === 0) continue;

        for (const row of rows) {
          if (this.rowMatchesPredicate(row, lock)) {
            this.logger.debug(
              { sessionId, otherSid, table: lock.table, lock },
              'SSI: range predicate conflict detected — INSERT matches lock',
            );
            return true;
          }
        }
      }
    }

    // Check 2: ALREADY committed writes that fell within predicate range
    // (writer committed before this reader is trying to commit)
    for (const entry of this.committedPredicateWrites) {
      // Only consider entries whose predicate lock was held by THIS txn
      if (entry.predLockTxnXid !== txn.xid) continue;
      for (const lock of preds) {
        if (lock.table !== entry.table) continue;
        if (this.rowMatchesPredicate(entry.rowData, lock)) {
          this.logger.debug(
            { sessionId, table: lock.table, lock },
            'SSI: committed write matches predicate — phantom prevention abort',
          );
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Get the count of active transactions.
   */
  get activeCount(): number {
    return this.activeTxns.size;
  }

  /**
   * Return the current set of active XIDs.
   * P0-3: Used by the query layer for visibility checks.
   */
  getActiveXidSet(): ReadonlySet<number> {
    return this.activeXidSet;
  }

  /**
   * Return the current snapshot (max committed XID).
   * P0-3: Used by the query layer for SELECT visibility filters.
   */
  getCurrentXid(): number {
    return this.xidCounter;
  }

  /**
   * Check if an XID is frozen (always visible).
   */
  isFrozen(xid: number): boolean {
    return xid === MVCCExecutor.XID_FROZEN;
  }

  /**
   * Freeze the current transaction's XID. Returns the assigned XID_FROZEN value.
   * Called by autovacuum to mark rows as frozen so they survive XID wrap.
   */
  freezeTransaction(): number {
    return MVCCExecutor.XID_FROZEN;
  }

  /**
   * Build a WHERE clause for SELECT visibility filtering.
   * P0-3: Filters rows that are visible to the current snapshot.
   *
   * @param snapshot - The snapshot XID for the current session.
   * @returns A SQL WHERE clause string.
   */
  buildVisibilityClause(snapshot: number): string {
    return `(_xmax IS NULL OR _xmax <= ${snapshot})`;
  }

  // ── MVCC Phase 1: SELECT visibility ──────────────────────────

  /**
   * Get the isolation level for the current session's transaction.
   *
   * @param sessionId - Session identifier.
   * @returns The isolation level, or 'READ_COMMITTED' if no active transaction.
   */
  getIsolationForSession(sessionId: string): IsolationLevel {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return 'READ_COMMITTED';
    return this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
  }

  /**
   * Record a pending write with its row data.
   *
   * Stores both the row version (for conflict tracking) and the actual
   * row data (for SELECT visibility merge).
   *
   * @param sessionId - Session performing the write.
   * @param tableName - Table being modified.
   * @param rowId     - Primary key value.
   * @param type      - 'INSERT' | 'UPDATE' | 'DELETE'
   * @param data      - Row data for INSERT/UPDATE (optional for DELETE)
   */
  addOwnWriteRow(
    sessionId: string,
    tableName: string,
    rowId: any,
    type: 'INSERT' | 'UPDATE' | 'DELETE',
    data?: any,
  ): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return;

    const key = `${tableName}:${String(rowId)}`;
    // Capture original xmin BEFORE recordWrite overwrites the row version
    const existingRv = this.rowVersions.get(key);
    const prevXmin = existingRv?.xmin;
    const row: OwnWriteRow = {
      table: tableName,
      type,
      rowKey: key,
      rowId,
      data,
      prevXmin: type !== 'INSERT' ? prevXmin : undefined,
    };

    if (!this.txnOwnRowData.has(txn.xid)) {
      this.txnOwnRowData.set(txn.xid, new Map());
    }
    this.txnOwnRowData.get(txn.xid)!.set(key, row);

    // Also record the row version for conflict tracking
    this.recordWrite(sessionId, tableName, rowId, type === 'DELETE');

    // SSI: Record INSERTed row data for predicate conflict checking (phantom prevention)
    if (type === 'INSERT' && data) {
      this.recordInsertRow(sessionId, tableName, data);
    }

    // P0: WAL — log the DML operation
    if (this.walLogger) {
      try {
        switch (type) {
          case 'INSERT':
            this.walLogger.logInsert({
              sessionId,
              table: tableName,
              data: data ?? { rowId },
              xmin: txn.xid,
            });
            break;
          case 'DELETE':
            this.walLogger.logDelete({
              sessionId,
              table: tableName,
              oldData: data ?? { rowId },
              xmin: this.rowVersions.get(key)?.xmin ?? txn.xid,
              xmax: txn.xid,
            });
            break;
          case 'UPDATE':
            this.walLogger.logUpdate({
              sessionId,
              table: tableName,
              oldData: data?.oldData ?? { rowId },
              newData: data?.newData ?? { rowId },
              xmin: txn.xid,
              xmax: txn.xid,
            });
            break;
        }
      } catch (err: any) {
        this.logger.error(
          { err: err.message, sessionId, type, table: tableName },
          'Failed to log WAL record',
        );
      }
    }
  }

  /**
   * Clear all own writes for a given session.
   * Used after flushing pending writes to SQLite (Phase C flush-own-writes
   * in the read path), so the SELECT sees the flushed data via the physical
   * _xmin/_xmax columns rather than the in-memory own-write buffer.
   */
  clearOwnWrites(sessionId: string): void {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return;
    this.txnOwnRowData.delete(txn.xid);
  }

  /**
   * Get SELECT visibility information for a session.
   *
   * Returns the transaction's snapshot, isolation level, own pending writes,
   * and the active XID set. If the session has no active MVCC transaction,
   * returns `null`.
   *
   * @param sessionId - Session identifier.
   * @returns SelectVisibility or null if no active transaction.
   */
  getSelectVisibility(sessionId: string): SelectVisibility | null {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return null;

    const isolation = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
    // Uses internal normalized format (underscore-separated, e.g. 'REPEATABLE_READ')
    // as returned by isolation level type
    const ownWrites: OwnWriteRow[] = [];
    const ownData = this.txnOwnRowData.get(txn.xid);
    if (ownData) {
      for (const row of ownData.values()) {
        ownWrites.push(row);
      }
    }

    return {
      snapshot: txn.snapshot,
      isolation,
      ownWrites,
      activeXidSet: new Set(this.activeXidSet),
      committedRowVersions: new Map(this.rowVersions),
    };
  }

  /**
   * Determine whether a row version is visible under MVCC rules.
   *
   * Visibility rules:
   * - xmin must NOT be in activeXids (must be a committed transaction)
   * - xmin must be <= snapshot (committed before or at snapshot time)
   * - xmax must be NULL (row not deleted) OR
   *   xmax must be > snapshot (deleted after snapshot) OR
   *   xmax is an active (uncommitted) transaction
   *
   * @param xmin     - XID that created this version.
   * @param xmax     - XID that deleted/superseded this version, or null.
   * @param snapshot - The transaction's snapshot (max committed XID at start).
   * @param activeXids - Set of still-active transaction XIDs.
   * @param isolation - Isolation level (affects visibility of own writes).
   * @returns `true` if the row is visible.
   */
  isRowVisible(
    xmin: number,
    xmax: number | null,
    snapshot: number,
    activeXids: Set<number>,
    isolation: IsolationLevel,
  ): boolean {
    // XID_FROZEN rows are always visible regardless of snapshot
    if (xmin === MVCCExecutor.XID_FROZEN) return true;

    // Row created by an active txn → not visible (except own writes handled upstream)
    if (activeXids.has(xmin)) return false;

    // Row created after snapshot → not visible for REPEATABLE READ/SERIALIZABLE
    // READ COMMITTED allows seeing rows committed after the txn snapshot
    if (xmin > snapshot && isolation !== 'READ_COMMITTED') return false;

    // Row must not be deleted by a committed transaction within our snapshot
    if (xmax === null) return true;

    // P0-3: FROZEN_XID means the row was vacuum-frozen, not actually deleted.
    // Treat as visible (the frozen row represents the "original" version).
    if (xmax === MVCCExecutor.XID_FROZEN) return true;

    // If xmax is an active (uncommitted) txn, the row is still visible
    // (the deletion hasn't been committed yet)
    if (activeXids.has(xmax)) return true;

    // If xmax > snapshot, the deletion happened after our snapshot → visible
    if (xmax > snapshot) return true;

    // Otherwise, the deletion is committed and visible → row is not visible
    return false;
  }

  /**
   * Get own pending write rows for a specific transaction.
   *
   * @param sessionId - Session identifier.
   * @returns Array of OwnWriteRow, or empty array if no active txn or no pending writes.
   */
  getOwnWrites(sessionId: string): OwnWriteRow[] {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return [];
    const ownData = this.txnOwnRowData.get(txn.xid);
    if (!ownData) return [];
    return Array.from(ownData.values());
  }

  filterSelectResult(
    sessionId: string,
    resultRows: any[],
    tableName: string,
    pkColumn: string = 'id',
  ): any[] {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return resultRows;

    const isolation = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';

    return resultRows.filter((row) => {
      if (typeof row !== 'object' || row === null) return true;

      // Determine the primary key value from the row
      const rowId = row[pkColumn];
      if (rowId === undefined || rowId === null) return true;

      const key = `${tableName}:${String(rowId)}`;
      const rv = this.rowVersions.get(key);
      if (!rv) return true; // No version info → pre-existing row → visible

      // Apply MVCC visibility rules
      return this.isRowVisible(rv.xmin, rv.xmax, txn.snapshot, this.activeXidSet, isolation);
    });
  }


  // ── Phase D: Vacuum (physical row cleanup) ─────────────────---

  /**
   * Vacuum — remove physically dead row versions from the database.
   *
   * Deletes rows whose `_xmax` is less than the oldest active XID,
   * meaning no active transaction could possibly read those versions.
   * Rows with `_xmax = 0` are not dead (they were written before MVCC).
   *
   * @param connection - A better-sqlite3 Database instance (or any object
   *                     with a `exec(sql)` method) to run the deletion.
   * @returns The number of rows deleted.
   */
  vacuum(connection: { exec: (sql: string) => any }): number {
    const oldestActiveXid = this.computeOldestActiveXid();
    let totalFrozen = 0;

    // P0-3: VACUUM FREEZE — UPDATE _xmax to FROZEN_XID (2) instead of DELETE.
    // This preserves row data for long-running transactions that need to see
    // older versions, while marking the row as "frozen" for XID wrap purposes.
    try {
      // Get all user tables (connection may not have prepare in all contexts)
      const prepFn = (connection as any).prepare;
      if (typeof prepFn === 'function') {
        const tables = prepFn(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__'"
        ).all() as Array<{ name: string }> | undefined;

        if (tables) {
          for (const table of tables) {
            // Check if table has _xmax column
            const colInfo = prepFn(
              `PRAGMA table_info(${table.name})`
            ).all() as Array<{ name: string }> | undefined;

            if (colInfo && colInfo.some(c => c.name === '_xmax')) {
              // P0-3: FREEZE — set _xmax = FROZEN_XID instead of DELETE
              // Only freeze rows that are definitely dead (committed delete, no active txn at that xmax)
              const result = prepFn(
                `UPDATE "${table.name}" SET _xmax = ? WHERE _xmax > 0 AND _xmax <= ?`
              ).run(MVCCExecutor.XID_FROZEN, oldestActiveXid);
              if (result && result.changes) {
                totalFrozen += result.changes;
              }
            }
          }
        }
      }

      // Also freeze old row version metadata from the in-memory map
      let cleanedVersions = 0;
      for (const [key, rv] of this.rowVersions) {
        if (rv.xmax !== null && rv.xmax <= oldestActiveXid && rv.xmax > 0) {
          rv.xmax = MVCCExecutor.XID_FROZEN;
          this.persistRowVersion(key, rv.xmin, rv.xmax);
          cleanedVersions++;
        }
      }

      this.logger.info(
        { frozenRows: totalFrozen, cleanedVersions, oldestActiveXid },
        'VACUUM FREEZE completed',
      );
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'VACUUM FREEZE failed');
    }

    // Visibility Map: GC row versions that are no longer visible
    try {
      this.gcRowVersions(true);
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'RowVersion GC failed');
    }

    // P0-3: Trigger TOAST GC after vacuum freezes old rows
    try {
      this.config.onVacuum?.(totalFrozen);
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'TOAST GC callback failed');
    }

    return totalFrozen;
  }

  /**
   * Compute the oldest active XID among all current transactions.
   * If no transactions are active, returns the current XID counter.
   * Public — used by MvccVacuum for freeze boundary calculation.
   */
  public computeOldestActiveXid(): number {
    let oldest = this.xidCounter;
    for (const xid of this.activeXidSet) {
      if (xid < oldest) {
        oldest = xid;
      }
    }
    return oldest;
  }

  /**
   * Visibility Map: Compute the oldest snapshot XID across all active transactions.
   * Used to determine which row versions are truly dead and can be GC'd.
   *
   * A row version is "truly dead" when:
   *   - It has been deleted/superseded (xmax !== null)
   *   - The deleting XID is committed (no active txn has this XID)
   *   - The deleting XID is less than ALL active transactions' snapshots
   *     (meaning no txn, not even a new one, could possibly read the deleted version)
   */
  private computeOldestActiveSnapshot(): number {
    let oldest = this.xidCounter;
    for (const [, txn] of this.activeTxns) {
      // A txn's snapshot might be behind its xid for READ COMMITTED
      const effectiveSnapshot = Math.min(txn.snapshot, txn.xid);
      if (effectiveSnapshot < oldest) {
        oldest = effectiveSnapshot;
      }
    }
    return oldest;
  }

  /**
   * Visibility Map: Garbage-collect row versions that are no longer visible
   * to any possible transaction.
   *
   * Removes entries from `rowVersions` where the deleting XID (xmax) is known
   * to be committed and older than every active transaction's snapshot.
   *
   * This bounds the `rowVersions` map growth and improves filterSelectResult
   * lookup performance for tables with high write volume.
   *
   * @param force - If true, always run GC regardless of size (used by vacuum).
   * @returns Number of entries freed.
   */
  gcRowVersions(force: boolean = false): number {
    const maxVersions = this.config.maxRowVersions ?? 100_000;
    const threshold = this.config.rowVersionGcThreshold ?? 0.8;

    if (!force && this.rowVersions.size < maxVersions * threshold) {
      return 0;
    }

    const oldestSnapshot = this.computeOldestActiveSnapshot();
    let freed = 0;
    const startSize = this.rowVersions.size;

    for (const [key, rv] of this.rowVersions) {
      // Row is truly dead if:
      // 1. It was deleted/superseded by a committed XID (rv.xmax !== null, rv.xmax > 0)
      // 2. That XID is older than all active snapshots (no txn could see it)
      // 3. Row was NOT frozen (FROZEN_XID rows must be preserved for historical txns)
      if (rv.xmax !== null && rv.xmax > 0 && rv.xmax !== MVCCExecutor.XID_FROZEN && rv.xmax < oldestSnapshot) {
        this.rowVersions.delete(key);
        freed++;
      }
    }

    this.rowVersionGcFreed += freed;
    this.rowVersionGcRuns++;

    if (freed > 0) {
      this.logger.info(
        { freed, before: startSize, after: this.rowVersions.size, oldestSnapshot, runs: this.rowVersionGcRuns, totalFreed: this.rowVersionGcFreed },
        'RowVersion GC completed',
      );
    }

    return freed;
  }

  /**
   * Reset all internal state (for testing).
   */
  reset(): void {
    this.xidCounter = MVCCExecutor.XID_FROZEN + 1; // Start from XID_FROZEN + 1 to avoid collision
    this.activeTxns.clear();
    this.activeXidSet.clear();
    this.rowVersions.clear();
    this.txnReadSets.clear();
    this.readSets.clear();
    this.writeSets.clear();
    this.writeQueues.clear();
    this.writeLocks.clear();
    this.txnWaitFor.clear();
    this.txnDeadlocked.clear();
    this.conflictStats.clear();
    this.degradationRecords.clear();
    this.rowMutexes.clear();
    this.txnIsolation.clear();
    this.txnSnapshots.clear();
    this.txnOwnRowData.clear();
    this.txnWriteLocks.clear();
    this.shareLocks.clear();
    this.txnShareLocks.clear();
    this.tableLocks.clear();
    // Clear persisted row versions from SQLite
    this.clearRowVersions();
    this.logger.info('MVCC state reset');
  }

  // ── P0-4: WAL Checkpoint ──────────────────────────────────────

  /**
   * Perform a WAL checkpoint.
   *
   * Flushes the current WAL segment to disk and records a checkpoint record.
   * This ensures that all WAL entries up to this point are durable and also
   * allows crash recovery to start from this checkpoint rather than from
   * the very beginning of the WAL.
   *
   * @returns The LSN of the checkpoint record, or null if no WAL writer configured.
   */
  checkpoint(): string | null {
    // Flush in-memory row versions to SQLite
    if (this.config.db) {
      for (const [key, rv] of this.rowVersions) {
        this.persistRowVersion(key, rv.xmin, rv.xmax);
      }
    }

    // Persist XID counter durably
    this.persistXidIfEnabled();

    // Write checkpoint record via PgWalWriter
    if (this.pgWalWriter) {
      try {
        const xid = this.xidCounter;
        const rec = this.pgWalWriter.writeCheckpoint(xid);
        this.pgWalWriter.flushSegment();
        this.lastCommitLSN = rec.lsn;
        this.lastCheckpointTime = Date.now();
        this.logger.info({ lsn: rec.lsn, xid }, 'WAL checkpoint completed');
        return rec.lsn;
      } catch (err: any) {
        this.logger.error({ err: err.message }, 'WAL checkpoint failed');
        return null;
      }
    } else if (this.walLogger) {
      // Fallback: if we have a walLogger but no direct pgWalWriter, flush via writer
      try {
        const writer = this.walLogger.getWriter();
        writer.flushSegment();
        this.lastCheckpointTime = Date.now();
        this.logger.info('WAL segment flushed (no checkpoint record)');
        return 'flushed';
      } catch (err: any) {
        this.logger.error({ err: err.message }, 'WAL flush failed during checkpoint');
        return null;
      }
    }

    this.logger.debug('Checkpoint: no WAL writer configured');
    return null;
  }

  /**
   * Dispose the MVCCExecutor — stops background timers and releases resources.
   * Call this when the executor is no longer needed to prevent timer leaks.
   */
  dispose(): void {
    this.stopDeadlockDetection();
    this.logger.info('MVCCExecutor disposed — background timers stopped');
  }

  // ── P1: Deadlock Detection Timer ───────────────────────────────

  /**
   * Start periodic deadlock detection.
   * Runs every 5 seconds to detect deadlocks among active transactions.
   */
  private startDeadlockDetection(): void {
    if (this.deadlockTimer) return;
    this.deadlockTimer = setInterval(() => {
      this.detectDeadlocks();
    }, 5000);
    // Allow the timer to not prevent process exit
    if (this.deadlockTimer && typeof this.deadlockTimer === 'object' && 'unref' in this.deadlockTimer) {
      (this.deadlockTimer as any).unref();
    }
  }

  /**
   * Stop periodic deadlock detection.
   */
  private stopDeadlockDetection(): void {
    if (this.deadlockTimer) {
      clearInterval(this.deadlockTimer);
      this.deadlockTimer = null;
    }
  }

  /**
   * Periodic deadlock detection using wait-for graph.
   * Runs periodically and on commit() contention.
   */
  private detectDeadlocks(): void {
    // Only run if there are active transactions with wait-for relationships
    if (this.txnWaitFor.size === 0) return;

    // Build wait-for graph and detect cycles via DFS
    const visited = new Set<number>();
    const inStack = new Set<number>();

    const hasCycle = (node: number): boolean => {
      if (inStack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      inStack.add(node);

      // Check wait-for: which XID is this txn waiting for?
      for (const [waiter, target] of this.txnWaitFor) {
        // Fix TS: align types — convert string target to number for comparison
        if (Number(target) === node) {
          // Node is being waited on by waiter
          const waiterXid = this.activeTxns.get(String(waiter))?.xid;
          if (waiterXid && hasCycle(waiterXid)) return true;
        }
      }

      inStack.delete(node);
      return false;
    };

    // Check all XIDs that are part of the wait-for graph
    for (const [, targetXid] of this.txnWaitFor) {
      if (hasCycle(Number(targetXid))) {
        // Deadlock detected! Resolve by aborting the youngest transaction
        let youngestXid = 0;
        let youngestSession = '';
        for (const [session, txn] of this.activeTxns) {
          if (txn.xid > youngestXid) {
            youngestXid = txn.xid;
            youngestSession = session;
          }
        }
        if (youngestSession) {
          this.txnDeadlocked.add(youngestXid);
          this.logger.warn(
            { youngestSession, youngestXid, deadlockCycle: Array.from(inStack) },
            'Deadlock detected via periodic timer — aborting youngest transaction (40P01)',
          );
        }
        break;
      }
    }
  }

  // ── P2: Snapshot Memory Leak GC ────────────────────────────────

  /**
   * Garbage-collect stale snapshot data for transactions that have committed.
   * Removes txnSnapshots and txnReadSets for XIDs that are no longer active.
   */
  private gcStaleSnapshots(): void {
    let cleaned = 0;
    for (const [xid] of this.txnSnapshots) {
      if (!this.activeXidSet.has(xid)) {
        this.txnSnapshots.delete(xid);
        this.txnReadSets.delete(xid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.debug({ cleaned }, 'GC: stale snapshots collected');
    }
  }

  // ── P2: XID Wrap Prevention ────────────────────────────────────

  /**
   * Check if XID counter is approaching the wrap limit.
   * If at 2/3 of the wrap limit, trigger VACUUM FREEZE on available connections.
   * Returns true if XID wrap is approaching and VACUUM is needed.
   */
  private checkXidWrapPrevention(): boolean {
    if (this.xidCounter >= MVCCExecutor.XID_WRAP_WARNING_THRESHOLD) {
      this.logger.warn(
        { xidCounter: this.xidCounter, threshold: MVCCExecutor.XID_WRAP_WARNING_THRESHOLD },
        'XID wrap threshold approaching — VACUUM FREEZE recommended',
      );
      return true;
    }
    return false;
  }

  // ── C01: Write serialization queue ──────────────────────────

  /**
   * Acquire a write token for a specific row.
   * If another txn is already writing this row, the caller is queued
   * and the promise resolves when the current writer finishes.
   *
   * Returns the backoff delay in ms if queued (0 = acquired immediately).
   *
   * @param sessionId - Session identifier.
   * @param tableName - Table name.
   * @param rowId     - Row identifier.
   * @param timeoutMs - Max wait time in ms.
   * @returns The wait time in ms before acquiring the lock (0 = immediate).
   * @throws If the caller's txn is not found or the queue wait times out.
   */
  async acquireWriteLock(sessionId: string, tableName: string, rowId: any, timeoutMs: number = 5000): Promise<number> {
    const txn = this.activeTxns.get(sessionId);
    if (!txn || txn.readOnly) return 0;

    const key = `${tableName}:${String(rowId)}`;

    // C-04: Mutex protection prevents TOCTOU between `!has(key)` check and
    // `add(key)`, ensuring two concurrent async calls don't both pass the check.
    const release = await this.writeLockMutex.acquire();
    try {
      // No contention — acquire immediately
      if (!this.writeLocks.has(key)) {
        this.writeLocks.add(key);
        return 0;
      }
    } finally {
      release();
    }

    // Contention — queue up
    const queue = this.writeQueues.get(key) || [];
    const startWait = Date.now();

    return new Promise<number>((resolve, reject) => {
      const entry: WriteQueueEntry = {
        xid: txn.xid,
        resolve: () => {
          const waitTime = Date.now() - startWait;
          this.logger.debug({ key, xid: txn.xid, waitTime }, 'Write lock acquired after wait');
          // R-03: Clear the timeout handle to prevent leak
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = undefined;
          }
          resolve(waitTime);
        },
        reject: (err) => reject(err),
      };
      queue.push(entry);
      this.writeQueues.set(key, queue);

      // R-03: Store setTimeout handle so we can clearTimeout on resolve
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      timeoutHandle = setTimeout(() => {
        // Remove from queue if still pending
        const idx = queue.indexOf(entry);
        if (idx >= 0) {
          queue.splice(idx, 1);
          reject(new Error(`Write lock acquire timeout for ${key} (${timeoutMs}ms)`));
        }
      }, timeoutMs);
    });
  }

  // ── C01: Conflict probability tracker ─────────────────────

  /**
   * Ensure ConflictStats exists for a session, creating default if needed.
   * Evicts oldest entries if the map exceeds MAX_CONFLICT_STATS_ENTRIES.
   */
  private ensureConflictStats(sessionId: string): ConflictStats {
    // M-07: Evict oldest entries if over capacity
    this.evictOldestConflictStats();

    let stats = this.conflictStats.get(sessionId);
    if (!stats) {
      const now = Date.now();
      stats = {
        totalRetries: 0,
        conflictCount: 0,
        commitCount: 0,
        rollbackCount: 0,
        deadlockCount: 0,
        firstConflictAt: 0,
        lastActivityAt: now,
      };
      this.conflictStats.set(sessionId, stats);
    }
    return stats;
  }

  /**
   * M-07: Evict oldest entries from conflictStats when over MAX_CONFLICT_STATS_ENTRIES.
   * Evicts based on `lastActivityAt` (oldest first).
   */
  private evictOldestConflictStats(): void {
    if (this.conflictStats.size <= MVCCExecutor.MAX_CONFLICT_STATS_ENTRIES) return;
    const overage = this.conflictStats.size - MVCCExecutor.MAX_CONFLICT_STATS_ENTRIES + 10;
    const sorted = [...this.conflictStats.entries()]
      .sort(([, aVal], [, bVal]) => aVal.lastActivityAt - bVal.lastActivityAt);
    for (let i = 0; i < Math.min(overage, sorted.length); i++) {
      this.conflictStats.delete(sorted[i][0]);
    }
  }

  /**
   * M-07: Evict oldest entries from degradationRecords when over MAX_DEGRADATION_RECORDS.
   */
  private evictOldestDegradationRecords(): void {
    if (this.degradationRecords.size <= MVCCExecutor.MAX_DEGRADATION_RECORDS) return;
    const overage = this.degradationRecords.size - MVCCExecutor.MAX_DEGRADATION_RECORDS + 10;
    const sorted = [...this.degradationRecords.entries()]
      .sort((a, b) => a[1].degradedAt - b[1].degradedAt);
    for (let i = 0; i < Math.min(overage, sorted.length); i++) {
      this.degradationRecords.delete(sorted[i][0]);
    }
  }

  /**
   * Update lastActivityAt for a session.
   */
  private updateSessionActivity(sessionId: string): void {
    const stats = this.conflictStats.get(sessionId);
    if (stats) {
      stats.lastActivityAt = Date.now();
    }
  }

  /**
   * Record a conflict for a session (called on commit conflict or detectConflict hit).
   * Updates stats for adaptive backoff and possible isolation degradation.
   * Uses continuous conflict tracking (not just retries) for degradation decisions.
   *
   * @param sessionId - Session identifier.
   */
  recordConflict(sessionId: string): void {
    const stats = this.ensureConflictStats(sessionId);
    stats.totalRetries++;
    stats.conflictCount++;
    stats.lastActivityAt = Date.now();
    if (stats.firstConflictAt === 0) {
      stats.firstConflictAt = stats.lastActivityAt;
    }

    // Phase 4: Check if degradation is needed based on continuous conflict count
    const txn = this.activeTxns.get(sessionId);
    if (txn) {
      const iso = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
      this.checkDegradation(sessionId, iso);
    }
  }

  /**
   * Record a successful commit for a session.
   */
  private recordCommitStats(sessionId: string): void {
    const stats = this.ensureConflictStats(sessionId);
    stats.commitCount++;
    stats.lastActivityAt = Date.now();
  }

  /**
   * Record a rollback for a session.
   */
  private recordRollbackStats(sessionId: string): void {
    const stats = this.ensureConflictStats(sessionId);
    stats.rollbackCount++;
    stats.lastActivityAt = Date.now();
  }

  /**
   * Record a deadlock event for a transaction (identified by XID).
   * Finds the session for the given XID and increments deadlockCount.
   */
  private recordDeadlockStats(victimXid: number): void {
    for (const [sessionId, txn] of this.activeTxns) {
      if (txn.xid === victimXid) {
        const stats = this.ensureConflictStats(sessionId);
        stats.deadlockCount++;
        stats.lastActivityAt = Date.now();
        break;
      }
    }
  }

  /**
   * Get the recommended backoff delay in ms before retrying.
   * Uses exponential backoff: backoffBase * 2^(retries-1).
   *
   * @param sessionId - Session identifier.
   * @returns Delay in ms to wait before retry.
   */
  getBackoffMs(sessionId: string): number {
    const stats = this.conflictStats.get(sessionId);
    if (!stats || stats.totalRetries === 0) return 0;
    const base = this.config.backoffBaseMs ?? 10;
    return Math.min(base * Math.pow(2, stats.totalRetries - 1), 1000); // cap at 1s
  }

  /**
   * Reset conflict retry counter (called after a successful commit).
   * Also resets the conflict count used for degradation decisions.
   *
   * @param sessionId - Session identifier.
   */
  resetConflictStats(sessionId: string): void {
    const stats = this.conflictStats.get(sessionId);
    if (stats) {
      stats.totalRetries = 0;
      stats.conflictCount = 0;
    }
  }

  // ── C01: Adaptive isolation level degradation ──────────

  /**
   * Check whether the session's isolation level should be degraded
   * based on continuous conflict count since last commit.
   *
   * PostgreSQL-compatible degradation rules:
   * - 3+ continuous conflicts: SERIALIZABLE → REPEATABLE READ
   * - 5+ continuous conflicts: REPEATABLE READ → READ COMMITTED
   * - 30s without conflict after degradation: re-elevate
   */
  private checkDegradation(sessionId: string, currentIsolation: IsolationLevel): void {
    // M-07: Evict oldest if over capacity before adding new entries
    this.evictOldestDegradationRecords();

    const stats = this.conflictStats.get(sessionId);
    if (!stats) return;

    const existingRec = this.degradationRecords.get(sessionId);
    const effectiveIso = existingRec ? existingRec.currentIsolation : currentIsolation;

    // Check if re-elevation is due
    if (existingRec && existingRec.nextElevationAt !== null) {
      if (Date.now() > existingRec.nextElevationAt) {
        // Cool-off passed — re-elevate
        this.elevateSession(sessionId);
        return;
      }
    }

    if (effectiveIso === 'SERIALIZABLE' && stats.conflictCount >= this.CONFLICTS_BEFORE_DEGRADE_SERIALIZABLE) {
      // Degrade SERIALIZABLE → REPEATABLE READ
      this.degradationRecords.set(sessionId, {
        originalIsolation: currentIsolation,
        currentIsolation: 'REPEATABLE_READ',
        degradedAt: Date.now(),
        totalDegradations: existingRec ? existingRec.totalDegradations + 1 : 1,
        nextElevationAt: Date.now() + this.ELEVATION_COOLDOWN_MS,
      });
      // Reset conflict count for the new level
      stats.conflictCount = 0;
    } else if (effectiveIso === 'REPEATABLE_READ' && stats.conflictCount >= this.CONFLICTS_BEFORE_DEGRADE_RR) {
      // Degrade REPEATABLE READ → READ COMMITTED
      this.degradationRecords.set(sessionId, {
        originalIsolation: existingRec ? existingRec.originalIsolation : currentIsolation,
        currentIsolation: 'READ_COMMITTED',
        degradedAt: Date.now(),
        totalDegradations: existingRec ? existingRec.totalDegradations + 1 : 1,
        nextElevationAt: Date.now() + this.ELEVATION_COOLDOWN_MS,
      });
      stats.conflictCount = 0;
    }
  }

  /**
   * Check if a degraded session should be re-elevated back to its original level.
   * Called on successful commit (success = no conflict recently).
   */
  private checkElevation(sessionId: string): void {
    const rec = this.degradationRecords.get(sessionId);
    if (!rec) return;

    const stats = this.conflictStats.get(sessionId);
    // Re-elevate if 30s cool-off has passed and no recent conflicts
    if (rec.nextElevationAt !== null && Date.now() > rec.nextElevationAt) {
      this.elevateSession(sessionId);
    }
  }

  /**
   * Re-elevate a session back to its original isolation level.
   * Also resets conflict stats so degradation cycle starts fresh.
   */
  private elevateSession(sessionId: string): void {
    const rec = this.degradationRecords.get(sessionId);
    if (!rec) return;

    rec.currentIsolation = rec.originalIsolation;
    rec.nextElevationAt = null;
    this.degradationRecords.set(sessionId, rec);

    // Reset conflict count for fresh degradation cycle
    const stats = this.conflictStats.get(sessionId);
    if (stats) {
      stats.conflictCount = 0;
    }

    // Update the active transaction's isolation level if one exists
    const txn = this.activeTxns.get(sessionId);
    if (txn) {
      this.txnIsolation.set(txn.xid, rec.originalIsolation);
    }
  }

  /**
   * Get the effective isolation level for a session (accounting for degradation).
   */
  getEffectiveIsolation(sessionId: string): IsolationLevel {
    const rec = this.degradationRecords.get(sessionId);
    if (rec) return rec.currentIsolation;
    const txn = this.activeTxns.get(sessionId);
    if (txn) return this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
    return 'READ_COMMITTED';
  }

  /**
   * Check whether the session's isolation level should be
   * degraded due to repeated serialization failures.
   *
   * @param sessionId - Session identifier.
   * @param isolation - Original isolation level.
   * @returns `true` if degradation is recommended.
   */
  shouldDegrade(sessionId: string, isolation: string): boolean {
    const stats = this.conflictStats.get(sessionId);
    if (!stats) return false;

    const normIso = this.normalizeIsolation(isolation);
    if (normIso === 'SERIALIZABLE') {
      return stats.conflictCount >= this.CONFLICTS_BEFORE_DEGRADE_SERIALIZABLE;
    }
    if (normIso === 'REPEATABLE_READ') {
      return stats.conflictCount >= this.CONFLICTS_BEFORE_DEGRADE_RR;
    }
    return false;
  }

  /**
   * Record a degradation event for a session.
   *
   * @param sessionId - Session identifier.
   * @param originalIsolation - The isolation level before degradation.
   * @param retriesCount - Number of retries before degradation.
   */
  recordDegradation(sessionId: string, originalIsolation: string, retriesCount: number): void {
    const normIso = this.normalizeIsolation(originalIsolation);
    const existingRec = this.degradationRecords.get(sessionId);
    const newIso: IsolationLevel = normIso === 'SERIALIZABLE' ? 'REPEATABLE_READ' : 'READ_COMMITTED';

    this.degradationRecords.set(sessionId, {
      originalIsolation: normIso,
      currentIsolation: newIso,
      degradedAt: Date.now(),
      totalDegradations: existingRec ? existingRec.totalDegradations + 1 : 1,
      nextElevationAt: Date.now() + this.ELEVATION_COOLDOWN_MS,
    });
    // Reset conflict stats so we don't keep degrading
    this.conflictStats.delete(sessionId);
  }

  /**
   * Get the degradation record for a session (if any).
   */
  getDegradation(sessionId: string): DegradationRecord | undefined {
    return this.degradationRecords.get(sessionId);
  }

  /**
   * Get the recommended degradation suggestion.
   * Returns a human-readable string for the error message.
   */
  getDegradationSuggestion(sessionId: string): string | null {
    const rec = this.degradationRecords.get(sessionId);
    if (!rec) return null;
    return `MVCC: ${rec.originalIsolation} degraded to ${rec.currentIsolation} after ${rec.totalDegradations} degradation(s)`;
  }

  // ── Phase 4: Global / Per-session stats snapshot ───────

  /**
   * Get global MVCC statistics.
   */
  getGlobalStats(): GlobalMvccStats {
    let totalCommitted = 0;
    let totalRolledBack = 0;
    let totalConflicts = 0;
    let totalDeadlocks = 0;
    let oldestActive = Infinity;

    for (const [, stats] of this.conflictStats) {
      totalCommitted += stats.commitCount;
      totalRolledBack += stats.rollbackCount;
      totalConflicts += stats.conflictCount;
      totalDeadlocks += stats.deadlockCount;
    }

    for (const [, txn] of this.activeTxns) {
      if (txn.started < oldestActive) {
        oldestActive = txn.started;
      }
    }

    return {
      activeTxnCount: this.activeTxns.size,
      committedCount: totalCommitted,
      rolledBackCount: totalRolledBack,
      conflictCount: totalConflicts,
      deadlockCount: totalDeadlocks,
      currentXid: this.xidCounter,
      oldestActiveTxnMs: oldestActive === Infinity ? null : Date.now() - oldestActive,
      sessions: this.activeTxns.size,
      degradedSessions: this.degradationRecords.size,
    };
  }

  /**
   * Get per-session MVCC statistics.
   */
  getSessionStats(sessionId: string): SessionMvccStats | null {
    const txn = this.activeTxns.get(sessionId);
    if (!txn) return null;

    const waitingKey = this.txnWaitFor.get(txn.xid) || null;

    return {
      sessionId,
      xid: txn.xid,
      isolation: this.getEffectiveIsolation(sessionId),
      readOnly: txn.readOnly,
      started: txn.started,
      elapsedMs: Date.now() - txn.started,
      conflictStats: this.conflictStats.get(sessionId) || null,
      degradationRecord: this.degradationRecords.get(sessionId) || null,
      waitingFor: waitingKey,
      deadlocked: this.txnDeadlocked.has(txn.xid),
    };
  }

  /**
   * Get the list of all active session IDs.
   */
  getActiveSessions(): string[] {
    return Array.from(this.activeTxns.keys());
  }

  // ── Phase 4: Stale transaction cleanup ─────────────────

  /**
   * Clean up stale (timed out / deadlocked) transactions that are past maxAge.
   * Also removes transactions that have been deadlocked for too long.
   * Returns the number of cleaned up transactions.
   */
  cleanupStaleTxns(maxAgeMs: number = 300000): number {
    const now = Date.now();
    const staleSessions: string[] = [];

    for (const [sessionId, txn] of this.activeTxns) {
      // Skip fresh transactions
      if (now - txn.started < maxAgeMs && !this.txnDeadlocked.has(txn.xid)) continue;

      // Deadlocked txns are always stale
      if (this.txnDeadlocked.has(txn.xid)) {
        staleSessions.push(sessionId);
        continue;
      }

      // Check if txn has timed out or is not making progress
      if (now - txn.started >= maxAgeMs) {
        // Only clean up if it's in a conflicted/dead state
        const stats = this.conflictStats.get(sessionId);
        const hasRetries = stats && stats.totalRetries > 0;
        const waiting = this.txnWaitFor.has(txn.xid);
        if (hasRetries || waiting) {
          staleSessions.push(sessionId);
        }
      }
    }

    for (const sessionId of staleSessions) {
      const txn = this.activeTxns.get(sessionId);
      if (!txn) continue;
      this.logger.info(
        { sessionId, xid: txn.xid, elapsed: now - txn.started },
        'Cleaning up stale transaction',
      );
      // Force rollback
      this.rollback(sessionId);
    }

    return staleSessions.length;
  }

  // ── P0 gap: async-mutex row-level locking ───────────────

  /**
   * Lock a row with deadlock tracking for a specific session.
   * Records the wait-for relationship before acquiring, clears after.
   */
  async lockRowForSession(tableName: string, rowId: any, sessionId: string): Promise<void> {
    const key = `lock:${tableName}:${String(rowId)}`;
    const txn = this.activeTxns.get(sessionId);
    const xid = txn?.xid;

    if (xid) {
      this.recordWait(xid, key);
    }

    let entry = this.rowMutexes.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), refCount: 0 };
      this.rowMutexes.set(key, entry);
    }
    entry.refCount++;
    await entry.mutex.acquire();

    if (xid) {
      this.clearWait(xid);
    }
  }

  /**
   * Unlock a row previously locked via lockRowForSession.
   */
  unlockRowForSession(tableName: string, rowId: any, sessionId: string): void {
    const key = `lock:${tableName}:${String(rowId)}`;
    const txn = this.activeTxns.get(sessionId);
    if (txn) {
      this.clearWait(txn.xid);
    }

    const entry = this.rowMutexes.get(key);
    if (!entry) return;
    entry.mutex.release();
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.rowMutexes.delete(key);
    }
  }

  /**
   * Lock multiple rows for a session (sorted to prevent deadlocks).
   */
  async lockRowsForSession(tableName: string, rowIds: any[], sessionId: string): Promise<void> {
    const sortedKeys = rowIds
      .map(id => ({ id, key: `lock:${tableName}:${String(id)}` }))
      .sort((a, b) => a.key.localeCompare(b.key));

    for (const { id } of sortedKeys) {
      await this.lockRowForSession(tableName, id, sessionId);
    }
  }

  /**
   * Unlock multiple rows for a session.
   */
  unlockRowsForSession(tableName: string, rowIds: any[], sessionId: string): void {
    const sortedKeys = rowIds
      .map(id => ({ id, key: `lock:${tableName}:${String(id)}` }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .reverse();

    for (const { id } of sortedKeys) {
      this.unlockRowForSession(tableName, id, sessionId);
    }
  }

  /** Acquire an async mutex for a specific row. */
  async lockRow(tableName: string, rowId: any): Promise<void> {
    const key = `lock:${tableName}:${String(rowId)}`;
    let entry = this.rowMutexes.get(key);
    if (!entry) {
      entry = { mutex: new Mutex(), refCount: 0 };
      this.rowMutexes.set(key, entry);
    }
    entry.refCount++;
    await entry.mutex.acquire();
  }

  /** Release an async mutex for a specific row. */
  unlockRow(tableName: string, rowId: any): void {
    const key = `lock:${tableName}:${String(rowId)}`;
    const entry = this.rowMutexes.get(key);
    if (!entry) return;
    entry.mutex.release();
    entry.refCount--;
    if (entry.refCount <= 0) {
      this.rowMutexes.delete(key);
    }
  }

  /** Lock multiple rows atomically (sorted to prevent deadlocks). */
  async lockRows(tableName: string, rowIds: any[]): Promise<void> {
    const sortedKeys = rowIds
      .map(id => ({ id, key: `lock:${tableName}:${String(id)}` }))
      .sort((a, b) => a.key.localeCompare(b.key));

    for (const { id } of sortedKeys) {
      await this.lockRow(tableName, id);
    }
  }

  /** Unlock multiple rows. */
  unlockRows(tableName: string, rowIds: any[]): void {
    const sortedKeys = rowIds
      .map(id => ({ id, key: `lock:${tableName}:${String(id)}` }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .reverse(); // Unlock in reverse order

    for (const { id } of sortedKeys) {
      this.unlockRow(tableName, id);
    }
  }

  // ── P0 gap: Enhanced visibility checks ────────────────────

  /**
   * Check whether a row version is visible to a transaction's snapshot.
   * READ COMMITTED: sees all committed rows + own changes (not uncommitted).
   * REPEATABLE READ: sees the snapshot captured at txn start.
   *
   * M-01: Delegates to isRowVisible() which has the canonical implementation
   * with full READ_COMMITTED support.
   */
  isVisible(txn: MVCCTransaction, rv: RowVersion): boolean {
    const isoLevel = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';
    return this.isRowVisible(rv.xmin, rv.xmax, txn.snapshot, this.activeXidSet, isoLevel);
  }

  /**
   * Normalize isolation level string to enum.
   */
  private normalizeIsolation(isolation: string): IsolationLevel {
    const upper = isolation.toUpperCase().replace(/-/g, '_');
    if (upper === 'READ COMMITTED' || upper === 'READ_COMMITTED') return 'READ_COMMITTED';
    if (upper === 'REPEATABLE READ' || upper === 'REPEATABLE_READ') return 'REPEATABLE_READ';
    if (upper === 'SERIALIZABLE') return 'SERIALIZABLE';
    return 'READ_COMMITTED'; // default
  }

  /**
   * Get the isolation level for a transaction.
   */
  getIsolation(xid: number): IsolationLevel {
    return this.txnIsolation.get(xid) || 'READ_COMMITTED';
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Initialize the XID persistence table in SQLite.
   * Creates __mvcc_xid_seq if it doesn't exist.
   * D-01: Saves and restores the original PRAGMA synchronous mode to avoid
   * permanently setting synchronous=FULL on the entire connection.
   */
  private initializeXidTable(): void {
    const db = this.config.db;
    if (!db) return;
    // D-01: Save original synchronous mode before changing to FULL
    let originalSync: string | number = 'NORMAL';
    try {
      const row = db.pragma('synchronous', { simple: true }) as string | number;
      originalSync = row;
    } catch {
      // If reading fails, assume NORMAL
    }
    // Set FULL for crash-safe XID initialization
    db.exec('PRAGMA synchronous=FULL');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS __mvcc_xid_seq (last_xid INTEGER)');
      db.exec('INSERT OR IGNORE INTO __mvcc_xid_seq (last_xid) VALUES (2)'); // Start at 2 so first allocateXid returns 3 (XID_FROZEN + 1)
      this.xidTableInitialized = true;
    } finally {
      // D-01: Restore original synchronous mode
      db.pragma(`synchronous = ${originalSync}`);
    }
    this.logger.debug('XID persistence table initialized with synchronous=FULL (restored)');
  }

  /**
   * Initialize the row versions persistence table in SQLite.
   * Creates __row_versions if it doesn't exist and reloads existing
   * versions into the in-memory cache.
   */
  private initializeRowVersionsTable(): void {
    const db = this.config.db;
    if (!db) return;
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS __row_versions (' +
        '  key TEXT PRIMARY KEY,' +
        '  xmin INTEGER NOT NULL,' +
        '  xmax INTEGER' +
        ')'
      );
      this.logger.debug('__row_versions table initialized');
      // Reload existing row versions into in-memory cache
      this.reloadRowVersions();
    } catch (err: any) {
      this.logger.warn({ error: err.message }, '__row_versions table initialization failed');
    }
  }

  /**
   * Reload all row versions from the __row_versions table into the
   * in-memory rowVersions Map.
   */
  private reloadRowVersions(): void {
    const db = this.config.db;
    if (!db) return;
    try {
      const rows = db.prepare('SELECT key, xmin, xmax FROM __row_versions').all() as Array<{ key: string; xmin: number; xmax: number | null }>;
      this.rowVersions.clear();
      for (const row of rows) {
        this.rowVersions.set(row.key, { xmin: row.xmin, xmax: row.xmax });
      }
      this.logger.debug({ count: rows.length }, 'Row versions reloaded from SQLite');
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'Failed to reload row versions from SQLite');
    }
  }

  /**
   * Persist a single row version entry to the __row_versions table.
   */
  private persistRowVersion(key: string, xmin: number, xmax: number | null): void {
    const safeKey = key.replace(/'/g, "''");
    const xmaxVal = xmax === null ? 'NULL' : String(xmax);
    const sql = `INSERT OR REPLACE INTO __row_versions (key, xmin, xmax) VALUES ('${safeKey}', ${xmin}, ${xmaxVal})`;

    if (this.config.writeSql) {
      this.config.writeSql(sql).catch((err: any) => {
        this.logger.warn({ key, error: err.message }, 'Failed to persist row version');
      });
    } else {
      const db = this.config.db;
      if (!db) return;
      try {
        db.prepare(sql).run();
      } catch (err: any) {
        this.logger.warn({ key, error: err.message }, 'Failed to persist row version');
      }
    }
  }

  /**
   * Delete a row version entry from the __row_versions table.
   */
  private deleteRowVersion(key: string): void {
    const safeKey = key.replace(/'/g, "''");
    const sql = `DELETE FROM __row_versions WHERE key = '${safeKey}'`;

    if (this.config.writeSql) {
      this.config.writeSql(sql).catch((err: any) => {
        this.logger.warn({ key, error: err.message }, 'Failed to delete row version');
      });
    } else {
      const db = this.config.db;
      if (!db) return;
      try {
        db.prepare(sql).run();
      } catch (err: any) {
        this.logger.warn({ key, error: err.message }, 'Failed to delete row version');
      }
    }
  }

  /**
   * Clear all row versions from the __row_versions table.
   */
  private clearRowVersions(): void {
    const db = this.config.db;
    if (!db) return;
    try {
      db.exec('DELETE FROM __row_versions');
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'Failed to clear row versions');
    }
  }

  /**
   * Restore the XID counter from the persistence table.
   * If activeTxns is non-empty on recovery, starts XID from max(current, max active + 1).
   */
  private restoreXidFromDb(): void {
    const db = this.config.db;
    if (!db || !this.xidTableInitialized) return;
    try {
      const row = db.prepare('SELECT last_xid FROM __mvcc_xid_seq').get() as { last_xid: number } | undefined;
      if (row && row.last_xid > 0) {
        let restoredXid = row.last_xid;
        // If there are active txns, ensure XID is >= max active XID + 1
        if (this.activeTxns.size > 0) {
          const maxActiveXid = Math.max(0, ...Array.from(this.activeTxns.values()).map(t => t.xid));
          restoredXid = Math.max(restoredXid, maxActiveXid + 1);
        }
        // Ensure XID never falls below MIN_XID_START to preserve XID_FROZEN
        restoredXid = Math.max(restoredXid, 3);
        this.xidCounter = restoredXid;
        this.logger.debug({ restoredXid: this.xidCounter }, 'MVCC XID counter restored from SQLite');
      }
    } catch (err: any) {
      this.logger.warn({ error: err.message }, 'XID restore from SQLite failed');
    }
  }

  /**
   * Allocate the next XID, using SQLite for atomic increment when available.
   */
  private allocateXid(): number {
    // Allocate XID with SQLite atomic increment, skipping XID_FROZEN (reserved).
    // XID 1 = BootstrapTransactionId, XID 2 = FrozenTransactionId (PG convention).
    // Counter advances by 2 instead of 1 when we'd land on XID_FROZEN.
    for (;;) {
      if (this.xidTableInitialized && this.config.db) {
        try {
          const row = this.config.db.prepare(
            'UPDATE __mvcc_xid_seq SET last_xid = last_xid + 1 RETURNING last_xid'
          ).get() as { last_xid: number } | undefined;
          if (row) {
            this.xidCounter = row.last_xid;
            if (row.last_xid === MVCCExecutor.XID_FROZEN) continue; // skip, retry
            if (row.last_xid >= MVCCExecutor.XID_WRAP_LIMIT) return this.handleXidWrap();
            return row.last_xid;
          }
        } catch (err: any) {
          this.logger.warn({ error: err.message }, 'XID allocation via SQLite failed, falling back to in-memory');
        }
        break; // SQLite path failed, fall through to in-memory
      }
      break; // No DB configured
    }
    // In-memory fallback: skip XID_FROZEN
    const xid = this.xidCounter++;
    if (xid === MVCCExecutor.XID_FROZEN) {
      return this.xidCounter++;
    }
    if (xid >= MVCCExecutor.XID_WRAP_LIMIT) return this.handleXidWrap();
    return xid;
  }

  /**
   * Handle XID wrap-around. Should be called when allocateXid returns a value
   * at or above XID_WRAP_LIMIT. Resets counter to XID_FROZEN + 1.
   * M-10: Synchronously persists the new XID to SQLite before returning,
   * preventing duplicate XID assignment after crash recovery.
   */
  private handleXidWrap(): number {
    const wrapped = MVCCExecutor.XID_FROZEN + 1; // 3
    this.xidCounter = wrapped + 1; // next after wrapped
    this.logger.warn({ wrappedTo: wrapped }, 'XID wrap detected — resetting to XID_FROZEN+1');
    // M-10: Persist synchronously to prevent duplicate XID after crash recovery
    this.persistXidIfEnabled();
    return wrapped;
  }

  /**
   * Persist the current XID counter if a persistence mechanism is configured.
   * Throws on failure — caller should handle appropriately.
   */
  private persistXidIfEnabled(): void {
    if (this.config.persistXid) {
      this.config.persistXid(this.xidCounter);
    }
    // Also persist to SQLite if available
    if (this.xidTableInitialized && this.config.db) {
      this.config.db.prepare('UPDATE __mvcc_xid_seq SET last_xid = ?').run(this.xidCounter);
    }
  }

  /**
   * Check whether any row touched by `txn` has a conflict.
   *
   * P0 gap: Only checks rows that THIS txn wrote to (row-level).
   * P0-3: Only checks against transactions that are STILL ACTIVE.
   * A committed transaction's writes are no longer a conflict.
   */
  private hasConflict(txn: MVCCTransaction): boolean {
    const txnRows = this.txnWriteLocks.get(txn.xid);
    const isoLevel = this.txnIsolation.get(txn.xid) || 'READ_COMMITTED';

    if (!txnRows || txnRows.size === 0) return false;

    for (const key of txnRows) {
      const rv = this.rowVersions.get(key);
      if (!rv) continue;

      // Rows written by this txn are fine.
      if (rv.xmin === txn.xid) continue;

      // ── Conflict detection ──────────────────────────────────────
      // RC: Only conflicts with STILL ACTIVE transactions matter
      //     (latest committed data is always visible).
      // RR: ANY committed write AFTER our snapshot is a conflict —
      //     the row version changed since we first read it.
      //
      // P0 fix: RR must also flag conflicts against transactions that
      // committed after our snapshot (not just still-active ones).
      if (rv.xmin > txn.snapshot && rv.xmin !== txn.xid) {
        // For REPEATABLE READ, committed writes after snapshot = conflict
        if (isoLevel === 'REPEATABLE_READ' || this.activeXidSet.has(rv.xmin)) {
          if (this.config.verboseConflictLogging) {
            this.logger.warn(
              { key, ourXid: txn.xid, snapshot: txn.snapshot, rowXmin: rv.xmin, isoLevel },
              'Conflict detected during commit scan',
            );
          }
          return true;
        }
      }
    }

    // P1-6: Phantom read detection — currently limited by lack of range predicate tracking.
    // Overly aggressive: flags rows from independent concurrent transactions as phantoms.
    // Disabled — SERIALIZABLE rw-cycle detection (SSI) handles G2 anomalies properly,
    // and REPEATABLE READ uses snapshot version comparison earlier in commit().
    // TODO(P2): Implement proper predicate-based phantom detection when query ranges are tracked.

    return false;
  }
}
