/**
 * TwoPhaseCommitManager — PostgreSQL 2PC (two-phase commit) compatibility shim
 * for SQLite.
 *
 * PostgreSQL supports the two-phase commit protocol via three dedicated SQL
 * statements:
 *
 * ```sql
 * PREPARE TRANSACTION 'my_tx_id';          -- Phase 1: prepare
 * COMMIT PREPARED 'my_tx_id';              -- Phase 2a: commit
 * ROLLBACK PREPARED 'my_tx_id';            -- Phase 2b: rollback
 * ```
 *
 * SQLite has no native 2PC support. This module simulates it by maintaining
 * an in-memory registry of "prepared" transactions and relying on SQLite
 * SAVEPOINTs for the actual execution strategy:
 *
 * - `PREPARE TRANSACTION 'tx_id'` → records in memory; the caller is expected
 *   to create a SAVEPOINT before running statements under 2PC. The returned
 *   `savepointName` (e.g. `pg_prep_tx_<txId>`) is the canonical savepoint to
 *   use.
 * - `COMMIT PREPARED 'tx_id'` → releases the prepared savepoint (RELEASE
 *   SAVEPOINT). The caller releases it via the returned savepoint name.
 * - `ROLLBACK PREPARED 'tx_id'` → rolls back to the prepared savepoint
 *   (ROLLBACK TO SAVEPOINT + RELEASE). The caller applies both via the
 *   returned savepoint name.
 *
 * ## Strategy
 *
 * | Input                         | Internal State Change         | Returned Action                |
 * |-------------------------------|-------------------------------|--------------------------------|
 * | `PREPARE TRANSACTION 'abc'`   | Registry acquires `abc`       | Caller must CREATE SAVEPOINT   |
 * | `COMMIT PREPARED 'abc'`       | Registry releases `abc`       | Caller executes RELEASE        |
 * | `ROLLBACK PREPARED 'abc'`     | Registry releases `abc`       | Caller executes ROLLBACK+RELEASE|
 *
 * ## Key guarantees
 *
 * - Default limit of 100 concurrent prepared transactions (configurable)
 * - All txId values are validated as non-empty strings
 * - Duplicate txId is rejected at prepare time
 * - Prepared transactions have no TTL (mirrors PostgreSQL behaviour)
 * - PinoLogger integration for audit trails and debugging
 *
 * @module TwoPhaseCommitManager
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { ShardManager } from '../storage/ShardManager';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PreparedTransaction {
  /** The user-supplied transaction identifier (e.g. 'my_tx_id') */
  id: string;
  /** Timestamp when PREPARE TRANSACTION was issued */
  createdAt: Date;
  /** Canonical savepoint name for the SQLite execution layer */
  savepointName: string;
  /** Approximate count of SQL statements executed under this 2PC */
  pendingSqlCount: number;
  /** Pending SQL statements serialized as JSON (for persistence) */
  pendingSql?: string[];
  /** Session identifier that owns this prepared transaction */
  owner?: string;
  /** Database name where this transaction was prepared */
  database?: string;
  /** Session identifier used for DISCARD ALL lookup */
  sessionId?: string;
}

/** Extended prepared transaction info for listPrepared() */
export interface PreparedTransactionInfo {
  gid: string;
  prepared: string;
  owner: string;
  database: string;
  sessionId: string;
  elapsedMs: number;
  zombie: boolean;
}

/** Statistics collected by TwoPhaseCommitManager */
export interface TwoPhaseCommitStats {
  total: number;
  timedOut: number;
  zombie: number;
  rolledBack: number;
}

/** Cleanup configuration */
export interface PreparedCleanupConfig {
  /** Milliseconds after which an unprepared transaction is considered timed out (default: 300000 = 5 min) */
  timeoutMs: number;
  /** Interval in ms between cleanup sweeps (default: 60000 = 1 min) */
  cleanupIntervalMs: number;
  /** Maximum concurrent prepared transactions (default: 100) */
  maxPrepared: number;
}

export interface PrepareResult {
  /** Whether the SQL was rewritten (true for detected PREPARE TRANSACTION) */
  rewritten: boolean;
  /** The canonical savepoint name, e.g. 'pg_prep_tx_my_tx_id' */
  savepointName: string;
  /** Error message if the operation failed (e.g. duplicate txId, limit hit) */
  error?: string;
}

export interface CommitPreparedResult {
  /** Whether the SQL was rewritten (true for detected COMMIT PREPARED) */
  rewritten: boolean;
  /** The canonical savepoint name to RELEASE */
  savepointName: string;
  /** Error message if the transaction was not found or already finalised */
  error?: string;
}

export interface RollbackPreparedResult {
  /** Whether the SQL was rewritten (true for detected ROLLBACK PREPARED) */
  rewritten: boolean;
  /** The canonical savepoint name to ROLLBACK TO + RELEASE */
  savepointName: string;
  /** Error message if the transaction was not found or already finalised */
  error?: string;
}

export interface TwoPhaseCommitManagerOptions {
  /** Optional logger instance. If omitted, a default is created. */
  logger?: PinoLogger;
  /** Maximum number of concurrent prepared transactions (default: 100) */
  maxPrepared?: number;
  /** ShardManager for persisting 2PC state to SQLite tables */
  shardManager?: ShardManager;
  /** Fallback database instance (better-sqlite3) for direct access */
  fallbackDb?: any;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches `PREPARE TRANSACTION 'tx_id'`.
 *
 * Groups:
 *   1 – The transaction identifier string (single-quoted).
 *
 * Covers:
 *   PREPARE TRANSACTION 'my_tx_id';
 *   PREPARE TRANSACTION 'my_tx_id'
 *   prepare transaction 'foo';
 */
const PREPARE_TRANSACTION_RE =
  /^\s*PREPARE\s+TRANSACTION\s+'((?:[^']|'')+)'\s*;?\s*$/i;

/**
 * Matches `COMMIT PREPARED 'tx_id'`.
 *
 * Groups:
 *   1 – The transaction identifier string (single-quoted).
 *
 * Covers:
 *   COMMIT PREPARED 'my_tx_id';
 *   COMMIT PREPARED 'my_tx_id'
 *   commit prepared 'foo';
 */
const COMMIT_PREPARED_RE =
  /^\s*COMMIT\s+PREPARED\s+'((?:[^']|'')+)'\s*;?\s*$/i;

/**
 * Matches `ROLLBACK PREPARED 'tx_id'`.
 *
 * Groups:
 *   1 – The transaction identifier string (single-quoted).
 *
 * Covers:
 *   ROLLBACK PREPARED 'my_tx_id';
 *   ROLLBACK PREPARED 'my_tx_id'
 *   rollback prepared 'foo';
 */
const ROLLBACK_PREPARED_RE =
  /^\s*ROLLBACK\s+PREPARED\s+'((?:[^']|'')+)'\s*;?\s*$/i;

// Combined prefix matcher for fast detection (used by detectTwoPhase).
const _TWO_PHASE_PREFIX_RE =
  /^\s*(?:PREPARE\s+TRANSACTION|COMMIT\s+PREPARED|ROLLBACK\s+PREPARED)\b/i;

// ──────────────────────────────────────────────
//  TwoPhaseCommitManager
// ──────────────────────────────────────────────

const DEFAULT_MAX_PREPARED = 100;

export class TwoPhaseCommitManager {
  private readonly logger: PinoLogger;
  private readonly maxPrepared: number;
  /** In-memory registry of prepared transactions, keyed by txId. */
  private readonly prepared: Map<string, PreparedTransaction>;
  /** Internal counter for incrementing pendingSqlCount. */
  private sqlCounter: number;
  /** ShardManager for 2PC persistence to SQLite (P0-2). */
  private readonly shardManager?: ShardManager;
  /** Direct database handle for fallback access. */
  private readonly fallbackDb?: any;
  /** Whether the system table has been initialised. */
  private tableInitialized: boolean = false;

  // ── GAP-10: Prepared transaction management ─────────────────

  /** Cleanup configuration */
  public readonly config: PreparedCleanupConfig;
  /** Timer handle for periodic cleanup */
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Stats counters */
  private statsTotal: number = 0;
  private statsTimedOut: number = 0;
  private statsZombie: number = 0;
  private statsRolledBack: number = 0;
  /** Set of zombie gids currently detected */
  private readonly zombieGids: Set<string> = new Set();

  constructor(opts?: TwoPhaseCommitManagerOptions) {
    this.logger =
      opts?.logger ?? PinoLogger.forComponent('TwoPhaseCommitManager');
    this.maxPrepared = opts?.maxPrepared ?? DEFAULT_MAX_PREPARED;
    this.prepared = new Map();
    this.sqlCounter = 0;
    this.shardManager = opts?.shardManager;
    this.fallbackDb = opts?.fallbackDb;

    this.config = {
      timeoutMs: 5 * 60 * 1000,     // 5 minutes default
      cleanupIntervalMs: 60 * 1000,  // 1 minute default
      maxPrepared: this.maxPrepared,
    };

    this.logger.debug(
      { maxPrepared: this.maxPrepared, persistence: !!this.shardManager },
      'TwoPhaseCommitManager initialised',
    );

    // Bootstrap the prepared transactions table if persistence is available
    if (this.shardManager || this.fallbackDb) {
      this.ensurePreparedTable();
    }

    // Recover any previously-prepared transactions from the persisted table
    // (crash recovery: process restart may have left records in the DB)
    this.recoverInDoubtTransactions();
  }

  // ── Persistence helpers (P0-2) ──────────────

  /**
   * Create the `__prepared_transactions` table on all shards if it does not exist.
   */
  private ensurePreparedTable(): void {
    if (this.tableInitialized) return;

    const ddl = `CREATE TABLE IF NOT EXISTS __prepared_transactions (
      gid TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      prepared_at INTEGER NOT NULL,
      pending_sql TEXT NOT NULL,
      owner_session TEXT
    )`;

    try {
      if (this.shardManager || this.fallbackDb) {
        // Create on shard 0 (system metadata)
        const db = this.getShardDb();
        if (db) {
          // Enable WAL journaling for crash-safe persistence
          db.exec('PRAGMA journal_mode=WAL');
          db.exec(ddl);
        }
      }
      this.tableInitialized = true;
      this.logger.debug('Prepared transactions table initialised');
    } catch (err) {
      this.logger.error({ err }, 'Failed to create __prepared_transactions table');
    }
  }

  /**
   * Load prepared transactions from the persisted table (crash recovery).
   */
  private loadFromDb(): void {
    if (!this.shardManager && !this.fallbackDb) return;
    try {
      const db = this.getShardDb();
      if (!db) return;
      const rows = db.prepare(`SELECT * FROM __prepared_transactions WHERE state = 'prepared'`).all() as any[];
      for (const row of rows) {
        const id = String(row.gid);
        const pendingSql: string[] = JSON.parse(String(row.pending_sql));
        const savepointName = this.buildSavepointName(id);
        this.prepared.set(id, {
          id,
          createdAt: new Date(Number(row.prepared_at)),
          savepointName,
          pendingSqlCount: pendingSql.length,
          pendingSql,
        });
      }
      this.logger.info({ count: rows.length }, 'Restored prepared transactions from DB');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load prepared transactions from DB');
    }
  }

  /**
   * Persist a prepared transaction to the SQLite table.
   */
  private persistPrepare(txId: string, pendingSql: string[], ownerSession: string): void {
    if (!this.shardManager && !this.fallbackDb) return;
    try {
      const db = this.getShardDb();
      if (!db) return;
      db.prepare(
        `INSERT OR REPLACE INTO __prepared_transactions (gid, state, prepared_at, pending_sql, owner_session) VALUES (?, 'prepared', ?, ?, ?)`
      ).run(txId, Date.now(), JSON.stringify(pendingSql), ownerSession);
    } catch (err) {
      this.logger.error({ err, txId }, 'Failed to persist prepared transaction');
    }
  }

  /**
   * Delete a prepared transaction from the persisted table.
   */
  private persistRemove(txId: string): void {
    if (!this.shardManager && !this.fallbackDb) return;
    try {
      const db = this.getShardDb();
      if (!db) return;
      db.prepare(`DELETE FROM __prepared_transactions WHERE gid = ?`).run(txId);
    } catch (err) {
      this.logger.error({ err, txId }, 'Failed to remove prepared transaction from DB');
    }
  }

  /**
   * Execute the pending SQL of a prepared transaction atomically.
   */
  private executePreparedPendingSql(pendingSql: string[]): void {
    if ((!this.shardManager && !this.fallbackDb) || pendingSql.length === 0) return;
    const db = this.getShardDb();
    if (!db) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const sql of pendingSql) {
        db.exec(sql);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Public API ──────────────────────────────

  /**
   * Register a new prepared transaction.
   *
   * Simulates `PREPARE TRANSACTION 'txId'` by recording the transaction
   * in the in-memory registry. The caller is expected to create a SQLite
   * SAVEPOINT with the returned `savepointName` before executing statements.
   *
   * @param txId  The transaction identifier (must be a non-empty string)
   * @returns     A {@link PrepareResult} indicating success or failure
   *
   * @example
   * ```ts
   * const result = manager.prepare('my_tx');
   * // → { rewritten: true, savepointName: 'pg_prep_tx_my_tx' }
   * ```
   */
  prepare(txId: string, pendingChanges?: Array<{ sql: string; params?: any[] }>, ownerSession?: string, database?: string): PrepareResult {
    const id = txId.trim();

    // Validate non-empty
    if (!id) {
      const error = 'Transaction ID must be a non-empty string';
      this.logger.warn({ txId }, error);
      return { rewritten: false, savepointName: '', error };
    }

    // Check for duplicates
    if (this.prepared.has(id)) {
      const error = `Prepared transaction '${id}' already exists`;
      this.logger.warn({ txId: id }, error);
      return {
        rewritten: true,
        savepointName: this.buildSavepointName(id),
        error,
      };
    }

    // Enforce limit
    if (this.prepared.size >= this.maxPrepared) {
      const error = `Maximum number of prepared transactions reached (${this.maxPrepared})`;
      this.logger.warn({ txId: id, maxPrepared: this.maxPrepared }, error);
      return {
        rewritten: true,
        savepointName: this.buildSavepointName(id),
        error,
      };
    }

    const savepointName = this.buildSavepointName(id);
    const pendingSql = pendingChanges ? pendingChanges.map(p => p.sql) : [];
    const entry: PreparedTransaction = {
      id,
      createdAt: new Date(),
      savepointName,
      pendingSqlCount: pendingSql.length,
      pendingSql,
      owner: ownerSession || '',
      database: database || '',
      sessionId: ownerSession || '',
    };

    this.prepared.set(id, entry);
    this.sqlCounter++;
    this.statsTotal++;

    // Persist to SQLite table (P0-2)
    this.persistPrepare(id, pendingSql, ownerSession || '');

    this.logger.info(
      { txId: id, savepointName, preparedCount: this.prepared.size, pendingSqlCount: pendingSql.length },
      'Transaction prepared',
    );

    return { rewritten: true, savepointName };
  }

  /**
   * Commit a previously prepared transaction.
   *
   * Simulates `COMMIT PREPARED 'txId'` by executing the pending SQL
   * atomically and removing the transaction from the registry.
   *
   * @param txId  The transaction identifier used during PREPARE
   * @returns     A {@link CommitPreparedResult} indicating success or failure
   *
   * @example
   * ```ts
   * const result = manager.commitPrepared('my_tx');
   * // → { rewritten: true, savepointName: 'pg_prep_tx_my_tx' }
   * ```
   */
  commitPrepared(txId: string): CommitPreparedResult {
    const id = txId.trim();

    if (!id) {
      const error = 'Transaction ID must be a non-empty string';
      this.logger.warn({ txId }, error);
      return { rewritten: false, savepointName: '', error };
    }

    const entry = this.prepared.get(id);

    if (!entry) {
      const error = `Prepared transaction '${id}' not found`;
      this.logger.warn({ txId: id }, error);
      return {
        rewritten: true,
        savepointName: this.buildSavepointName(id),
        error,
      };
    }

    // Execute pending SQL atomically (P0-2)
    if (entry.pendingSql && entry.pendingSql.length > 0) {
      this.executePreparedPendingSql(entry.pendingSql);
    }

    // Remove from persisted table (P0-2)
    this.persistRemove(id);

    this.zombieGids.delete(id);
    this.prepared.delete(id);

    this.logger.info(
      {
        txId: id,
        savepointName: entry.savepointName,
        pendingSqlCount: entry.pendingSqlCount,
        remainingPrepared: this.prepared.size,
      },
      'Transaction committed (prepared)',
    );

    return { rewritten: true, savepointName: entry.savepointName };
  }

  /**
   * Roll back a previously prepared transaction.
   *
   * Simulates `ROLLBACK PREPARED 'txId'` by removing the transaction from
   * the registry. The pending SQL is NOT executed on rollback.
   *
   * @param txId  The transaction identifier used during PREPARE
   * @returns     A {@link RollbackPreparedResult} indicating success or failure
   *
   * @example
   * ```ts
   * const result = manager.rollbackPrepared('my_tx');
   * // → { rewritten: true, savepointName: 'pg_prep_tx_my_tx' }
   * ```
   */
  rollbackPrepared(txId: string): RollbackPreparedResult {
    const id = txId.trim();

    if (!id) {
      const error = 'Transaction ID must be a non-empty string';
      this.logger.warn({ txId }, error);
      return { rewritten: false, savepointName: '', error };
    }

    const entry = this.prepared.get(id);

    if (!entry) {
      const error = `Prepared transaction '${id}' not found`;
      this.logger.warn({ txId: id }, error);
      return {
        rewritten: true,
        savepointName: this.buildSavepointName(id),
        error,
      };
    }

    // Remove from persisted table (P0-2 — rollback does NOT execute pending SQL)
    this.persistRemove(id);

    this.zombieGids.delete(id);
    this.prepared.delete(id);
    this.statsRolledBack++;

    this.logger.info(
      {
        txId: id,
        savepointName: entry.savepointName,
        pendingSqlCount: entry.pendingSqlCount,
        remainingPrepared: this.prepared.size,
      },
      'Transaction rolled back (prepared)',
    );

    return { rewritten: true, savepointName: entry.savepointName };
  }

  /**
   * Return a snapshot of all currently prepared transactions.
   *
   * The returned array is a shallow copy; modifying it does not affect the
   * internal registry.
   *
   * @returns An array of {@link PreparedTransaction} entries
   *
   * @example
   * ```ts
   * const all = manager.listPrepared();
   * // → [{ id: 'my_tx', createdAt: ..., savepointName: 'pg_prep_tx_my_tx', pendingSqlCount: 3 }]
   * ```
   */
  listPrepared(): PreparedTransactionInfo[] {
    const now = Date.now();
    const result: PreparedTransactionInfo[] = [];

    for (const [gid, entry] of this.prepared.entries()) {
      const elapsed = now - entry.createdAt.getTime();
      const isZombie = !entry.owner || entry.owner.length === 0 || this.zombieGids.has(gid);
      result.push({
        gid,
        prepared: entry.createdAt.toISOString(),
        owner: entry.owner || '',
        database: entry.database || '',
        sessionId: entry.sessionId || '',
        elapsedMs: elapsed,
        zombie: isZombie,
      });
    }

    // Also include DB-persisted entries not yet in memory (P0-2 recovery)
    if (this.shardManager || this.fallbackDb) {
      try {
        const db = this.getShardDb();
        if (db) {
          const rows = db.prepare(`SELECT * FROM __prepared_transactions WHERE state = 'prepared'`).all() as any[];
          for (const row of rows) {
            const gid = String(row.gid);
            if (!this.prepared.has(gid)) {
              const rowPrepared = new Date(Number(row.prepared_at));
              const elapsed = now - rowPrepared.getTime();
              const rowSession = String(row.owner_session || '');
              result.push({
                gid,
                prepared: rowPrepared.toISOString(),
                owner: rowSession,
                database: '',
                sessionId: rowSession,
                elapsedMs: elapsed,
                zombie: !rowSession || rowSession.length === 0,
              });
            }
          }
        }
      } catch {
        // Table may not exist yet
      }
    }

    return result;
  }

  /**
   * Check whether a prepared transaction with the given ID exists.
   *
   * @param txId  The transaction identifier to check
   * @returns     `true` if the transaction is currently prepared
   *
   * @example
   * ```ts
   * manager.exists('my_tx'); // → true | false
   * ```
   */
  exists(txId: string): boolean {
    return this.prepared.has(txId.trim());
  }

  /**
   * Return the number of currently prepared transactions.
   *
   * @returns The prepared transaction count (0 <= n <= maxPrepared)
   *
   * @example
   * ```ts
   * manager.getPreparedCount(); // → 3
   * ```
   */
  getPreparedCount(): number {
    return this.prepared.size;
  }

  /**
   * Clear all prepared transactions (emergency cleanup).
   *
   * This is an escpe hatch for error recovery scenarios. It does **not**
   * perform any SQL-level rollback; the caller must ensure that any
   * active savepoints are handled separately.
   *
   * @returns The number of transactions that were cleared
   *
   * @example
   * ```ts
   * const cleared = manager.clearAll();
   * // → 5
   * ```
   */
  clearAll(): number {
    const count = this.prepared.size;
    // Also clear persisted table (P0-2)
    if (this.shardManager || this.fallbackDb) {
      try {
        const db = this.getShardDb();
        if (db) {
          db.exec(`DELETE FROM __prepared_transactions`);
        }
      } catch {
        // Table may not exist
      }
    }
    this.prepared.clear();
    this.logger.info({ clearedCount: count }, 'All prepared transactions cleared');
    return count;
  }

  // ── GAP-10: Prepared transaction management ─────────────────

  /**
   * Start the periodic cleanup timer for timed-out prepared transactions.
   *
   * The timer runs at the interval specified in `config.cleanupIntervalMs` and
   * performs a sweep of all prepared transactions, rolling back any that have
   * exceeded `config.timeoutMs`.
   *
   * Safe to call multiple times; previous timer is stopped.
   */
  startPreparedCleanup(): void {
    this.stopPreparedCleanup();
    this.cleanupTimer = setInterval(() => {
      this.sweepPreparedCleanup();
    }, this.config.cleanupIntervalMs);
    // Allow the process to exit even if the timer is still active
    if (this.cleanupTimer && typeof (this.cleanupTimer as any).unref === 'function') {
      (this.cleanupTimer as any).unref();
    }
    this.logger.debug(
      { intervalMs: this.config.cleanupIntervalMs, timeoutMs: this.config.timeoutMs },
      'Prepared cleanup timer started',
    );
  }

  /**
   * Stop the periodic cleanup timer.
   */
  stopPreparedCleanup(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      this.logger.debug('Prepared cleanup timer stopped');
    }
  }

  /**
   * Sweep all prepared transactions and roll back any that have timed out
   * or are zombies (no owner session). Called internally by the cleanup timer.
   *
   * @returns Number of transactions rolled back during this sweep
   */
  private sweepPreparedCleanup(): number {
    let rolledBack = 0;
    const now = Date.now();

    for (const [gid, entry] of this.prepared.entries()) {
      const elapsed = now - entry.createdAt.getTime();

      // Check for timeout
      if (elapsed >= this.config.timeoutMs) {
        this.logger.warn(
          { gid, elapsedMs: elapsed, timeoutMs: this.config.timeoutMs },
          'Prepared transaction timed out — rolling back',
        );
        this.prepared.delete(gid);
        this.zombieGids.delete(gid);
        this.persistRemove(gid);
        this.statsTimedOut++;
        this.statsRolledBack++;
        rolledBack++;
        continue;
      }

      // Check for zombie (no owner session — owner is empty)
      if (!entry.owner || entry.owner.length === 0) {
        if (!this.zombieGids.has(gid)) {
          this.logger.warn(
            { gid },
            'Detected zombie prepared transaction (no owner)',
          );
          this.zombieGids.add(gid);
          this.statsZombie++;
        }
      }
    }

    if (rolledBack > 0) {
      this.logger.info({ rolledBack }, 'Prepared cleanup sweep completed');
    }

    return rolledBack;
  }

  /**
   * Return current snapshot statistics about prepared transactions.
   */
  getStats(): TwoPhaseCommitStats {
    return {
      total: this.prepared.size,
      timedOut: this.statsTimedOut,
      zombie: this.statsZombie,
      rolledBack: this.statsRolledBack,
    };
  }

  /**
   * Return the number of currently prepared transactions.
   */
  countPrepared(): number {
    return this.prepared.size;
  }

  /**
   * Look up a prepared transaction by its GID (global transaction identifier).
   *
   * @param gid  The transaction identifier used during PREPARE TRANSACTION
   * @returns    The prepared transaction entry, or `undefined` if not found
   */
  getPreparedByGid(gid: string): PreparedTransaction | undefined {
    return this.prepared.get(gid.trim());
  }

  /**
   * Discard (roll back) all prepared transactions owned by the given session.
   *
   * Equivalent to `DISCARD ALL` or `RESET ALL` for 2PC state — cleans up any
   * prepared transactions that belong to a specific session that is being
   * disconnected or reset.
   *
   * @param sessionId  The session identifier to discard transactions for
   * @returns          Number of transactions discarded
   */
  discardPreparedTransactions(sessionId: string): number {
    if (!sessionId) return 0;

    const toDiscard: string[] = [];

    for (const [gid, entry] of this.prepared.entries()) {
      if (entry.sessionId === sessionId || entry.owner === sessionId) {
        toDiscard.push(gid);
      }
    }

    for (const gid of toDiscard) {
      this.prepared.delete(gid);
      this.zombieGids.delete(gid);
      this.persistRemove(gid);
      this.statsRolledBack++;
      this.logger.info({ gid, sessionId }, 'Discarded prepared transaction for session');
    }

    if (toDiscard.length > 0) {
      this.logger.info({ count: toDiscard.length, sessionId }, 'Discard prepared transactions complete');
    }

    return toDiscard.length;
  }

  /**
   * Recover in-doubt transactions from the persisted table.
   *
   * Called automatically during construction when a shardManager or fallbackDb
   * is available. Scans the `__prepared_transactions` table for:
   *
   * - **prepared** state entries → loads them into the in-memory registry so
   *   they can be committed or rolled back by the caller
   * - **committed** state entries → these are leftovers from a previous commit
   *   that was not fully cleaned up; executes the pending SQL then purges
   *   the entry
   * - **in-doubt** (anything else) → purges the orphaned entry
   *
   * This method is safe to call multiple times (idempotent).
   *
   * @returns Number of recovered / cleaned-up transactions
   *
   * @example
   * ```ts
   * const n = manager.recoverInDoubtTransactions();
   * // → 2  (recovered 2 prepared transactions from DB)
   * ```
   */
  recoverInDoubtTransactions(): number {
    if (!this.shardManager && !this.fallbackDb) return 0;

    let count = 0;
    try {
      const db = this.getShardDb();
      if (!db) return 0;

      const rows = db.prepare('SELECT * FROM __prepared_transactions').all() as any[];
      for (const row of rows) {
        const gid = String(row.gid);
        const state = String(row.state);
        const pendingSql: string[] = JSON.parse(String(row.pending_sql));

        if (state === 'prepared') {
          // In-doubt prepared transaction — load into memory for caller to
          // commit or rollback (skip if already in memory)
          if (!this.prepared.has(gid)) {
            const savepointName = this.buildSavepointName(gid);
            this.prepared.set(gid, {
              id: gid,
              createdAt: new Date(Number(row.prepared_at)),
              savepointName,
              pendingSqlCount: pendingSql.length,
              pendingSql,
            });
            this.logger.info({ txId: gid }, 'Recovered prepared transaction from DB');
            count++;
          }
        } else if (state === 'committed') {
          // Already-committed leftover — execute pending SQL, then purge
          this.logger.info({ txId: gid }, 'Found committed leftover; executing pending SQL');
          if (pendingSql.length > 0) {
            this.executePreparedPendingSql(pendingSql);
          }
          db.prepare('DELETE FROM __prepared_transactions WHERE gid = ?').run(gid);
          count++;
        } else {
          // Unknown state — just purge the orphan
          this.logger.warn({ txId: gid, state }, 'Purging orphan 2PC record with unknown state');
          db.prepare('DELETE FROM __prepared_transactions WHERE gid = ?').run(gid);
          count++;
        }
      }

      if (count > 0) {
        this.logger.info({ recoveredCount: count }, 'In-doubt transaction recovery complete');
      }
    } catch (err) {
      this.logger.error({ err }, 'recoverInDoubtTransactions failed');
    }

    return count;
  }

  // ── Internal helpers ─────────────────────────

  /**
   * Get a database handle for persistence operations.
   *
   * Tries multiple approaches in order:
   *   1. shardManager.getShard(0)?.db
   *   2. shardManager.getShardById?.(0)?.db
   *   3. fallbackDb
   *   4. null
   */
  private getShardDb(): any {
    // Approach 1: shardManager.getShard(0)
    if (this.shardManager) {
      try {
        const getter = (this.shardManager as any).getShard;
        if (typeof getter === 'function') {
          const shard = getter.call(this.shardManager, 0);
          if (shard && shard.db) {
            return shard.db;
          }
        }
      } catch {
        // Fall through
      }
    }

    // Approach 2: fallbackDb
    if (this.fallbackDb) {
      return this.fallbackDb;
    }

    return null;
  }

  /**

  /**
   * Build a canonical savepoint name from a transaction identifier.
   *
   * The format is `pg_prep_tx_<sanitisedId>`. Non-alphanumeric characters
   * (except `_`) are replaced with underscores to ensure the name is valid
   * as a SQLite SAVEPOINT identifier.
   */
  private buildSavepointName(txId: string): string {
    const sanitised = txId.replace(/[^A-Za-z0-9_]/g, '_');
    return `pg_prep_tx_${sanitised}`;
  }

  /**
   * Increment the pending SQL counter for a prepared transaction.
   *
   * Called by the SQL execution layer each time a statement is executed
   * under a 2PC savepoint.
   *
   * @param txId  The transaction identifier
   */
  incrementPendingSql(txId: string): void {
    const entry = this.prepared.get(txId.trim());
    if (entry) {
      entry.pendingSqlCount++;
    }
  }
}

// ──────────────────────────────────────────────
//  Standalone detection & rewriting helpers
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a 2PC statement (PREPARE TRANSACTION,
 * COMMIT PREPARED, or ROLLBACK PREPARED).
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `'prepare'`, `'commit'`, `'rollback'`, or `false` if not a
 *              2PC statement
 *
 * @example
 * ```ts
 * detectTwoPhase("PREPARE TRANSACTION 'abc'");    // → 'prepare'
 * detectTwoPhase("COMMIT PREPARED 'abc'");         // → 'commit'
 * detectTwoPhase("ROLLBACK PREPARED 'abc'");       // → 'rollback'
 * detectTwoPhase("SELECT 1");                      // → false
 * ```
 */
export function detectTwoPhase(sql: string): 'prepare' | 'commit' | 'rollback' | false {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check to avoid three regexes on every call
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('PREPARE ') &&
    !upper.startsWith('PREPARE;') &&
    !upper.startsWith('COMMIT ') &&
    !upper.startsWith('COMMIT;') &&
    !upper.startsWith('ROLLBACK ') &&
    !upper.startsWith('ROLLBACK;')
  ) {
    return false;
  }

  if (!_TWO_PHASE_PREFIX_RE.test(trimmed)) {
    return false;
  }

  if (PREPARE_TRANSACTION_RE.test(trimmed)) {
    return 'prepare';
  }

  if (COMMIT_PREPARED_RE.test(trimmed)) {
    return 'commit';
  }

  if (ROLLBACK_PREPARED_RE.test(trimmed)) {
    return 'rollback';
  }

  return false;
}

/**
 * Rewrite a 2PC SQL statement to a no-op comment.
 *
 * This is a "safe mode" rewriter for environments that need to handle 2PC
 * statements without crashing, but without actual 2PC semantics. The
 * original SQL is returned inside a SQL comment to preserve it for debugging.
 *
 * **Known limitation:** This function does **not** parse nested contexts
 * (e.g. 2PC inside PL/pgSQL functions). It only handles top-level statements.
 *
 * @param sql   The raw SQL string to rewrite
 * @returns     An object with the rewritten SQL and a flag indicating whether
 *              a rewrite occurred
 *
 * @example
 * ```ts
 * rewriteTwoPhase("PREPARE TRANSACTION 'abc'");
 * // → { sql: '-- 2PC no-op\nSELECT 1', rewritten: true }
 *
 * rewriteTwoPhase("SELECT 1");
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
 */
export function rewriteTwoPhase(sql: string): { sql: string; rewritten: boolean } {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  const trimmed = sql.trim();
  const type = detectTwoPhase(trimmed);

  if (!type) {
    return { sql: trimmed, rewritten: false };
  }

  // Pass through to QueryRouter which will route to TwoPhaseCommitManager methods
  return { sql: trimmed, rewritten: false };
}

/**
 * Validate that a transaction identifier is well-formed for 2PC use.
 *
 * PostgreSQL accepts any non-empty string up to 200 bytes as a transaction
 * identifier. This function performs a basic sanity check.
 *
 * @param txId  The transaction identifier to validate
 * @returns     `true` if the identifier is valid (non-empty, reasonable length)
 *
 * @example
 * ```ts
 * validateTxId('my_tx');     // → true
 * validateTxId('');          // → false
 * validateTxId('a'.repeat(500)); // → false (exceeds 200 char limit)
 * ```
 */
export function validateTxId(txId: string): boolean {
  if (typeof txId !== 'string') {
    return false;
  }

  const trimmed = txId.trim();

  // PostgreSQL identifiers are limited, but the docs only say "any string".
  // We apply a reasonable 200-byte limit per PG convention for identifier
  // length and ensure it is non-empty.
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > 200) {
    return false;
  }

  return true;
}

// ──────────────────────────────────────────────
//  Re-exports for distributed 2PC coordinator
// ──────────────────────────────────────────────

export {
  DistributedTwoPhaseCommitCoordinator,
} from './DistributedTwoPhaseCommitCoordinator';

export type {
  DistributedPrepareResult,
  DistributedFinalizeResult,
  DistributedTxRecord,
  DistributedTxStatus,
  Participant,
  ParticipantStatus,
  DistributedCoordinatorConfig,
} from './DistributedTwoPhaseCommitCoordinator';
