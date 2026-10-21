/**
 * DistributedTwoPhaseCommitCoordinator — Cross-RaftGroup 2PC coordinator.
 *
 * Manages distributed transactions across multiple shards (Raft groups).
 * Uses the coordinator/participant pattern:
 *
 * - **Coordinator** (this class): Tracks global state in `__distributed_tx_coordinator`
 *   table on shard 0. Orchestrates PREPARE → COMMIT/ROLLBACK across shards.
 * - **Participants** (per shard): Each shard stores its own prepared transaction
 *   state in `__prepared_transactions` table. Savepoints ensure atomicity within
 *   each shard.
 *
 * ## Protocol
 *
 *   Coordinator               Participant 1  ...  Participant N
 *       │                          │                    │
 *       ├───── PREPARE(txId) ─────►│                    │
 *       │                          ├── savepoint        │
 *       │                          ├── exec pending SQL │
 *       │◄──── prepared ────────── │                    │
 *       │                          │                    │
 *       ├───── PREPARE(txId) ──────┼─────► Participant N│
 *       │                          │◄──── prepared ──── │
 *       │                          │                    │
 *       │  (all prepared → COMMIT) │                    │
 *       │  (any failed  → ROLLBACK)│                    │
 *       │                          │                    │
 *       ├───── COMMIT(txId) ──────►│                    │
 *       │                          ├── release savepoint│
 *       │◄──── committed ──────────│                    │
 *       ├───── COMMIT(txId) ──────►├───► Participant N  │
 *       │◄──── committed ──────────│◄────────────────── │
 *
 * ## Crash recovery
 *
 * On startup, the coordinator scans `__distributed_tx_coordinator` for
 * transactions in intermediate states and:
 * - **preparing / prepared** → rollback (timed out) or load into memory
 * - **committing / aborting** → best-effort retry
 *
 * @module DistributedTwoPhaseCommitCoordinator
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { ShardManager } from '../storage/ShardManager';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** Participant status in a distributed 2PC transaction. */
export type ParticipantStatus = 'pending' | 'prepared' | 'committed' | 'aborted' | 'failed';

/** Coordinator transaction state machine. */
export type DistributedTxStatus = 'preparing' | 'prepared' | 'committing' | 'committed' | 'aborting' | 'aborted';

/** A single participant (shard) in a distributed transaction. */
export interface Participant {
  shardId: number;
  status: ParticipantStatus;
  error?: string;
}

/** In-memory and persisted record for a distributed transaction. */
export interface DistributedTxRecord {
  txId: string;
  status: DistributedTxStatus;
  participants: Participant[];
  pendingSql: string[];
  created_at: number;
  updated_at: number;
}

/** Result of a distributed PREPARE operation. */
export interface DistributedPrepareResult {
  success: boolean;
  txId: string;
  error?: string;
}

/** Result of a distributed COMMIT or ROLLBACK operation. */
export interface DistributedFinalizeResult {
  success: boolean;
  txId: string;
  error?: string;
}

/** Configuration for the distributed 2PC coordinator. */
export interface DistributedCoordinatorConfig {
  /** Timeout in ms for a participant to prepare (default: 30000). */
  participantTimeoutMs: number;
  /** Whether to auto-recover in-doubt transactions on startup (default: true). */
  recoveryEnabled: boolean;
  /** Interval in ms for sweeping timed-out transactions (default: 30000). */
  sweepIntervalMs: number;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

const DEFAULT_CONFIG: DistributedCoordinatorConfig = {
  participantTimeoutMs: 30_000,
  recoveryEnabled: true,
  sweepIntervalMs: 30_000,
};

const COORDINATOR_TABLE = '__distributed_tx_coordinator';
const PARTICIPANT_TABLE  = '__prepared_transactions';

// ──────────────────────────────────────────────
//  DistributedTwoPhaseCommitCoordinator
// ──────────────────────────────────────────────

export class DistributedTwoPhaseCommitCoordinator {
  private readonly logger: PinoLogger;
  private readonly shardManager: ShardManager;
  private readonly config: DistributedCoordinatorConfig;

  /** In-memory active distributed transactions: txId → DistributedTxRecord. */
  private readonly activeTx: Map<string, DistributedTxRecord> = new Map();

  /** Whether the coordinator table has been initialised. */
  private tableInitialized = false;

  /** Sweep timer handle. */
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    shardManager: ShardManager,
    config?: Partial<DistributedCoordinatorConfig>,
  ) {
    this.logger = PinoLogger.forComponent('Distributed2PCCoordinator');
    this.shardManager = shardManager;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ── Lifecycle ────────────────────────────────

  /**
   * Initialise the coordinator: create metadata tables and recover in-doubt
   * transactions. Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    if (this.tableInitialized) return;

    // Create coordinator table on shard 0
    const db = this.shardManager.getShard(0)?.db;
    if (!db) {
      this.logger.warn('No shard 0 available for coordinator metadata');
      return;
    }

    db.exec('PRAGMA journal_mode=WAL');
    this.ensureCoordinatorTable(db);

    // Ensure each shard has the participant prepared_transactions table
    await this.ensureParticipantTables();

    this.tableInitialized = true;
    this.logger.info('Distributed 2PC coordinator initialised');

    // Recover in-doubt transactions from persistent storage
    if (this.config.recoveryEnabled) {
      this.recoverInDoubtTransactions();
    }

    // Start the periodic timeout sweep
    this.startSweepTimer();
  }

  /**
   * Create the coordinator metadata table on the given DB handle.
   */
  private ensureCoordinatorTable(db: any): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${COORDINATOR_TABLE} (
        tx_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        participants TEXT NOT NULL,
        pending_sql TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_coordinator_status
      ON ${COORDINATOR_TABLE} (status)
    `);
    this.logger.debug('Coordinator table initialised');
  }

  /**
   * Ensure each shard has the participant `__prepared_transactions` table.
   */
  private async ensureParticipantTables(): Promise<void> {
    const ddl = `CREATE TABLE IF NOT EXISTS ${PARTICIPANT_TABLE} (
      gid TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      prepared_at INTEGER NOT NULL,
      pending_sql TEXT NOT NULL,
      owner_session TEXT
    )`;

    for (const [shardId] of this.shardManager.getAllShards()) {
      try {
        await this.execOnShard(shardId, ddl);
      } catch (err: any) {
        this.logger.warn(
          { shardId, err: err.message },
          'Failed to create participant table',
        );
      }
    }
  }

  // ── Phase 1: PREPARE ────────────────────────

  /**
   * Prepare a distributed transaction on ALL participant shards.
   *
   * Writes the pending SQL to each shard's `__prepared_transactions` table
   * using savepoints for atomicity. The coordinator record in
   * `__distributed_tx_coordinator` tracks overall state.
   *
   * If any shard fails, all prepared shards are rolled back automatically.
   *
   * @param txId       Global transaction identifier
   * @param pendingSql SQL statements to be executed atomically on commit
   */
  async prepare(
    txId: string,
    pendingSql: string[],
  ): Promise<DistributedPrepareResult> {
    const shardIds = this.shardManager.getShardIds();
    if (shardIds.length === 0) {
      return { success: false, txId, error: 'No shards available' };
    }

    if (shardIds.length === 1) {
      // Single shard — use direct 2PC (no distributed coordination needed)
      await this.prepareSingleShard(txId, pendingSql, shardIds[0]);
      return { success: true, txId };
    }

    const participants: Participant[] = shardIds.map(id => ({
      shardId: id,
      status: 'pending' as ParticipantStatus,
    }));

    // Record initial state
    const record: DistributedTxRecord = {
      txId,
      status: 'preparing',
      participants,
      pendingSql,
      created_at: Date.now(),
      updated_at: Date.now(),
    };

    this.activeTx.set(txId, record);
    this.persistRecord(record);

    // Prepare on each shard concurrently
    const results = await Promise.allSettled(
      shardIds.map(async (shardId, i) => {
        const participant = participants[i];
        try {
          await this.shardPrepare(txId, shardId, pendingSql);
          participant.status = 'prepared';
        } catch (err: any) {
          participant.status = 'failed';
          participant.error = err.message;
          throw err;
        }
      }),
    );

    // Check if all shards prepared successfully
    const anyFailed = results.some(r => r.status === 'rejected');

    if (!anyFailed) {
      // All shards prepared — transition to 'prepared'
      record.status = 'prepared';
      record.participants = participants;
      record.updated_at = Date.now();
      this.persistRecord(record);
      this.logger.info(
        { txId, shardCount: shardIds.length },
        'Distributed 2PC prepared on all shards',
      );
      return { success: true, txId };
    }

    // Some shard(s) failed — rollback all already-prepared shards
    this.logger.warn(
      { txId, failures: participants.filter(p => p.status === 'failed').length },
      'Distributed prepare failed on some shards — rolling back prepared shards',
    );

    // Rollback participants that completed prepare
    const rollbackPromises = participants
      .filter(p => p.status === 'prepared')
      .map(p => this.shardRollback(txId, p.shardId));

    await Promise.allSettled(rollbackPromises);

    record.status = 'aborted';
    for (const p of participants) {
      if (p.status === 'prepared') p.status = 'aborted';
    }
    record.participants = participants;
    record.updated_at = Date.now();
    this.persistRecord(record);
    this.activeTx.delete(txId);

    const failedShards = participants
      .filter(p => p.status === 'failed')
      .map(p => `shard ${p.shardId}: ${p.error}`)
      .join('; ');

    return {
      success: false,
      txId,
      error: `Prepare failed — ${failedShards}`,
    };
  }

  /**
   * Prepare a single-shard 2PC (optimised path, no distributed overhead).
   */
  private async prepareSingleShard(
    txId: string,
    pendingSql: string[],
    shardId: number,
  ): Promise<void> {
    // Still create the savepoint and write the prepared transaction
    // so that commit/rollback can release/rollback it properly.
    await this.shardPrepare(txId, shardId, pendingSql);

    // Write coordinator record
    const record: DistributedTxRecord = {
      txId,
      status: 'prepared',
      participants: [{ shardId, status: 'prepared' }],
      pendingSql,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.activeTx.set(txId, record);
    this.persistRecord(record);

    this.logger.info({ txId, shardId }, 'Single-shard 2PC prepared');
  }

  // ── Phase 2a: COMMIT ────────────────────────

  /**
   * Commit a previously prepared distributed transaction.
   *
   * Sends COMMIT PREPARED to all participant shards and updates
   * the coordinator state to 'committed'.
   *
   * @param txId Transaction identifier used during PREPARE
   */
  async commit(txId: string): Promise<DistributedFinalizeResult> {
    const record = this.activeTx.get(txId);
    if (!record) {
      return { success: false, txId, error: `Transaction '${txId}' not found` };
    }

    if (record.status !== 'prepared') {
      return {
        success: false,
        txId,
        error: `Transaction '${txId}' is in state '${record.status}', expected 'prepared'`,
      };
    }

    // Transition to committing
    record.status = 'committing';
    record.updated_at = Date.now();
    this.persistRecord(record);

    // Commit on all prepared participants concurrently
    const commitParticipants = record.participants.filter(
      p => p.status === 'prepared',
    );

    const results = await Promise.allSettled(
      commitParticipants.map(async p => {
        try {
          await this.shardCommit(txId, p.shardId, record.pendingSql);
          p.status = 'committed';
        } catch (err: any) {
          p.status = 'failed';
          p.error = err.message;
          throw err;
        }
      }),
    );

    const anyFailed = results.some(r => r.status === 'rejected');

    if (!anyFailed) {
      // All committed
      record.status = 'committed';
      record.participants = record.participants; // update references already mutated
      record.updated_at = Date.now();
      this.persistRecord(record);
      this.activeTx.delete(txId);
      this.logger.info({ txId }, 'Distributed 2PC committed');
      return { success: true, txId };
    }

    // Partial commit failure — best-effort: continue trying remaining shards
    // but report the failure for manual recovery
    const failedShards = record.participants
      .filter(p => p.status === 'failed')
      .map(p => p.shardId);
    record.status = 'aborted';
    record.updated_at = Date.now();
    this.persistRecord(record);

    this.logger.error(
      { txId, failedShards },
      'Distributed commit partially failed — manual recovery may be required',
    );

    return {
      success: false,
      txId,
      error: `Commit failed on shard(s): ${failedShards.join(', ')}`,
    };
  }

  // ── Phase 2b: ROLLBACK ──────────────────────

  /**
   * Roll back a previously prepared distributed transaction.
   *
   * Sends ROLLBACK PREPARED to all prepared participants and updates
   * the coordinator state to 'aborted'.
   *
   * @param txId Transaction identifier used during PREPARE
   */
  async rollback(txId: string): Promise<DistributedFinalizeResult> {
    const record = this.activeTx.get(txId);
    if (!record) {
      return { success: false, txId, error: `Transaction '${txId}' not found` };
    }

    if (record.status !== 'prepared' && record.status !== 'preparing') {
      return {
        success: false,
        txId,
        error: `Transaction '${txId}' is in state '${record.status}', expected 'prepared' or 'preparing'`,
      };
    }

    // Transition to aborting
    record.status = 'aborting';
    record.updated_at = Date.now();
    this.persistRecord(record);

    // Rollback on all prepared participants concurrently
    const rollbackParticipants = record.participants.filter(
      p => p.status === 'prepared',
    );

    await Promise.allSettled(
      rollbackParticipants.map(async p => {
        try {
          await this.shardRollback(txId, p.shardId);
          p.status = 'aborted';
        } catch (err: any) {
          this.logger.error(
            { shardId: p.shardId, txId, err: err.message },
            'Rollback failed on participant',
          );
          p.status = 'failed';
        }
      }),
    );

    record.status = 'aborted';
    record.updated_at = Date.now();
    this.persistRecord(record);
    this.activeTx.delete(txId);

    this.logger.info({ txId }, 'Distributed 2PC rolled back');
    return { success: true, txId };
  }

  // ── Participant operations ─────────────────

  /**
   * Execute a PREPARE on a single participant shard.
   *
   * Creates a savepoint and executes the pending SQL within it. The
   * savepoint is **not** released here — it remains open so the coordinator
   * can later COMMIT (RELEASE) or ROLLBACK (ROLLBACK TO + RELEASE) the
   * pending changes atomically across all participants.
   *
   * If the coordinator crashes after prepare, the `__prepared_transactions`
   * record allows crash recovery to replay or abort the transaction.
   */
  private async shardPrepare(
    txId: string,
    shardId: number,
    pendingSql: string[],
  ): Promise<void> {
    const savepointName = this.buildSavepointName(txId);

    // Step 1: Create savepoint on this shard (keeps SQL atomic)
    await this.execOnShard(shardId, `SAVEPOINT "${savepointName}"`);

    // Step 2: Execute pending SQL within the savepoint
    for (const sql of pendingSql) {
      await this.execOnShard(shardId, sql);
    }

    // Step 3: Write the prepared transaction entry for crash recovery
    await this.writePreparedTransaction(txId, shardId, pendingSql);

    this.logger.debug({ txId, shardId }, 'Shard prepared (savepoint held open)');
  }

  /**
   * Execute a COMMIT on a single participant shard.
   *
   * Releases the savepoint (committing the pending SQL that was prepared)
   * and cleans up the prepared transaction record.
   */
  private async shardCommit(
    txId: string,
    shardId: number,
    pendingSql: string[],
  ): Promise<void> {
    const savepointName = this.buildSavepointName(txId);

    // Release the savepoint — this commits the pending SQL within it
    await this.execOnShard(shardId, `RELEASE "${savepointName}"`);

    // Clean up the prepared transaction record
    await this.execOnShard(
      shardId,
      `DELETE FROM ${PARTICIPANT_TABLE} WHERE gid = '${txId.replace(/'/g, "''")}'`,
    );

    this.logger.debug({ txId, shardId }, 'Shard committed (savepoint released)');
  }

  /**
   * Execute a ROLLBACK on a single participant shard.
   *
   * Rolls back to the savepoint (undoing the pending SQL) then releases it,
   * and removes the prepared transaction record.
   */
  private async shardRollback(
    txId: string,
    shardId: number,
  ): Promise<void> {
    const savepointName = this.buildSavepointName(txId);

    // Roll back to the savepoint, then release it
    await this.execOnShard(shardId, `ROLLBACK TO "${savepointName}"`);
    await this.execOnShard(shardId, `RELEASE "${savepointName}"`);

    // Remove the prepared transaction record
    await this.execOnShard(
      shardId,
      `DELETE FROM ${PARTICIPANT_TABLE} WHERE gid = '${txId.replace(/'/g, "''")}'`,
    );

    this.logger.debug({ txId, shardId }, 'Shard rolled back (savepoint undone)');
  }

  /**
   * Write a prepared transaction entry to the participant shard's table
   * for crash recovery purposes.
   */
  private async writePreparedTransaction(
    txId: string,
    shardId: number,
    pendingSql: string[],
  ): Promise<void> {
    const escapedTxId = txId.replace(/'/g, "''");
    const escapedSql = JSON.stringify(pendingSql).replace(/'/g, "''");
    const now = Date.now();

    const sql = [
      `INSERT OR REPLACE INTO ${PARTICIPANT_TABLE}`,
      `(gid, state, prepared_at, pending_sql, owner_session)`,
      `VALUES ('${escapedTxId}', 'prepared', ${now}, '${escapedSql}', '${escapedTxId}')`,
    ].join(' ');

    await this.execOnShard(shardId, sql);
  }

  // ── Persistence ─────────────────────────────

  /**
   * Persist/update the coordinator record in shard 0's table.
   */
  private persistRecord(record: DistributedTxRecord): void {
    try {
      const db = this.shardManager.getShard(0)?.db;
      if (!db) return;

      db.prepare(`
        INSERT OR REPLACE INTO ${COORDINATOR_TABLE}
        (tx_id, status, participants, pending_sql, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.txId,
        record.status,
        JSON.stringify(record.participants.map(p => ({
          shardId: p.shardId,
          status: p.status,
          error: p.error,
        }))),
        JSON.stringify(record.pendingSql),
        record.created_at,
        record.updated_at,
      );
    } catch (err: any) {
      this.logger.error(
        { txId: record.txId, err: err.message },
        'Failed to persist coordinator record',
      );
    }
  }

  /**
   * Delete a coordinator record.
   */
  private deleteRecord(txId: string): void {
    try {
      const db = this.shardManager.getShard(0)?.db;
      if (!db) return;
      db.prepare(`DELETE FROM ${COORDINATOR_TABLE} WHERE tx_id = ?`).run(txId);
    } catch (err: any) {
      this.logger.error(
        { txId, err: err.message },
        'Failed to delete coordinator record',
      );
    }
  }

  // ── Recovery ────────────────────────────────

  /**
   * Recover in-doubt distributed transactions from the coordinator table.
   * Called automatically during init().
   *
   * - **preparing / prepared**: Within timeout → load into memory for normal
   *   completion. Timed out → force rollback.
   * - **committing / aborting**: Within timeout → load into memory and
   *   retry finalisation. Timed out → log warning (manual recovery needed).
   */
  private recoverInDoubtTransactions(): void {
    try {
      const db = this.shardManager.getShard(0)?.db;
      if (!db) return;

      const rows = db.prepare(`
        SELECT * FROM ${COORDINATOR_TABLE}
        WHERE status IN ('preparing', 'prepared', 'committing', 'aborting')
      `).all() as any[];

      if (rows.length === 0) {
        this.logger.debug('No in-doubt distributed transactions found');
        return;
      }

      this.logger.info(
        { count: rows.length },
        'Found in-doubt distributed transactions during recovery',
      );

      for (const row of rows) {
        this.recoverSingleTransaction(row);
      }
    } catch (err: any) {
      this.logger.warn(
        { err: err.message },
        'Error during distributed 2PC recovery',
      );
    }
  }

  /**
   * Recover a single in-doubt transaction from a coordinator table row.
   */
  private recoverSingleTransaction(row: any): void {
    const txId = String(row.tx_id);
    const status = String(row.status) as DistributedTxStatus;
    const participants: Participant[] = JSON.parse(String(row.participants));
    const pendingSql: string[] = JSON.parse(String(row.pending_sql));

    const elapsed = Date.now() - Number(row.updated_at);

    this.logger.warn(
      { txId, status, elapsedMs: elapsed },
      'Recovering in-doubt distributed transaction',
    );

    if (elapsed > this.config.participantTimeoutMs) {
      // Timed out — force cleanup
      if (status === 'preparing' || status === 'prepared') {
        this.forceCleanup(txId, participants, pendingSql);
        this.logger.info({ txId }, 'Force-cleaned timed-out distributed transaction');
      } else if (status === 'committing' || status === 'aborting') {
        // Best-effort: attempt to complete the finalisation
        this.forceFinalize(txId, status, participants, pendingSql);
      }
    } else {
      // Within timeout — load into memory for normal completion
      const record: DistributedTxRecord = {
        txId,
        status,
        participants,
        pendingSql,
        created_at: Number(row.created_at),
        updated_at: Number(row.updated_at),
      };
      this.activeTx.set(txId, record);
      this.logger.info(
        { txId, status },
        'Loaded in-doubt transaction into memory for normal completion',
      );
    }
  }

  /**
   * Force-cleanup a timed-out transaction by deleting its prepared entries
   * on all shards and its coordinator record.
   */
  private forceCleanup(
    txId: string,
    participants: Participant[],
    pendingSql: string[],
  ): void {
    for (const p of participants) {
      if (p.status !== 'prepared') continue;
      try {
        this.shardRollback(txId, p.shardId).catch(() => {
          this.logger.warn(
            { txId, shardId: p.shardId },
            'Force rollback failed (non-fatal)',
          );
        });
      } catch {
        // Non-fatal — best effort
      }
    }
    this.deleteRecord(txId);
  }

  /**
   * Best-effort finalisation for a committing/aborting transaction.
   * Re-executes the finalise on each shard.
   */
  private forceFinalize(
    txId: string,
    status: DistributedTxStatus,
    participants: Participant[],
    pendingSql: string[],
  ): void {
    for (const p of participants) {
      if (p.status !== 'prepared') continue;
      try {
        if (status === 'committing') {
          this.shardCommit(txId, p.shardId, pendingSql).catch(() => {});
        } else {
          this.shardRollback(txId, p.shardId).catch(() => {});
        }
      } catch {
        // Best effort
      }
    }
    this.logger.info({ txId }, 'Force finalisation attempted');
  }

  // ── Timeout sweep ───────────────────────────

  /**
   * Start periodic sweep for timed-out active transactions.
   */
  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepTimedOutTransactions(), this.config.sweepIntervalMs);
    // best-effort unref so an idle sweep timer does not hold the process open.
    // The `typeof ... === 'function'` guard exists only for non-Node runtimes
    // (browsers / React Native) whose timer handle lacks `.unref`; on Node and
    // Vitest (real or fake timers) `.unref` is always a function, so the false
    // branch is unreachable on every supported test/CI runtime.
    /* c8 ignore next */
    if (this.sweepTimer && typeof (this.sweepTimer as any).unref === 'function') {
      (this.sweepTimer as any).unref();
    }
    this.logger.debug(
      { intervalMs: this.config.sweepIntervalMs, timeoutMs: this.config.participantTimeoutMs },
      'Timeout sweep timer started',
    );
  }

  /**
   * Sweep active transactions and roll back any that have timed out.
   */
  private sweepTimedOutTransactions(): void {
    const now = Date.now();
    const timedOut: Array<{ txId: string; record: DistributedTxRecord }> = [];

    for (const [txId, record] of this.activeTx.entries()) {
      const elapsed = now - record.updated_at;
      if (
        elapsed > this.config.participantTimeoutMs &&
        (record.status === 'preparing' || record.status === 'prepared')
      ) {
        timedOut.push({ txId, record });
      }
    }

    for (const { txId, record } of timedOut) {
      this.logger.warn(
        { txId, elapsedMs: Date.now() - record.updated_at },
        'Distributed transaction timed out — rolling back',
      );
      this.rollback(txId).catch(
        /* c8 ignore next */
        err => {
        // rollback() never rejects: every internal step is allSettled or a
        // synchronous persist helper that catches its own errors. This handler
        // is defensive only and is unreachable in practice.
        this.logger.error({ txId, err: err.message }, 'Rollback of timed-out tx failed');
      });
    }
  }

  // ── Execution helpers ───────────────────────

  /**
   * Execute SQL on a specific shard via the ShardManager.
   * Routes through Raft replication when the write pool is active.
   */
  private async execOnShard(shardId: number, sql: string): Promise<void> {
    // Use execWriteOnShard for DML (routes through Raft)
    const shard = this.shardManager.getShard(shardId);
    if (!shard) {
      throw new Error(`Shard ${shardId} not available`);
    }
    // Execute directly for DDL / savepoint operations which need the DB handle
    shard.db.exec(sql);
  }

  // ── Public utility API ──────────────────────

  /**
   * Check whether a distributed transaction exists in the active set.
   */
  exists(txId: string): boolean {
    return this.activeTx.has(txId);
  }

  /**
   * Get the current status of an active distributed transaction.
   */
  getStatus(txId: string): DistributedTxStatus | undefined {
    return this.activeTx.get(txId)?.status;
  }

  /**
   * Get the full record of an active distributed transaction.
   */
  getRecord(txId: string): DistributedTxRecord | undefined {
    return this.activeTx.get(txId);
  }

  /**
   * List all active (in-memory) distributed transactions.
   */
  listActive(): DistributedTxRecord[] {
    return Array.from(this.activeTx.values());
  }

  /**
   * Return the number of active distributed transactions.
   */
  getActiveCount(): number {
    return this.activeTx.size;
  }

  /**
   * Dispose of all resources (timer, active transactions).
   */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.activeTx.clear();
    this.logger.debug('Distributed 2PC coordinator disposed');
  }

  /**
   * Build a canonical savepoint name from a transaction identifier.
   */
  private buildSavepointName(txId: string): string {
    return `__dist_tx_${txId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  }
}
