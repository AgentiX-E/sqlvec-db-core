// @ts-nocheck
/**
 * WALStateManager — Unified WAL state management for PostgreSQL compatibility
 * shims in sqlvec-db.
 *
 * PostgreSQL uses a Write-Ahead Log (WAL) with a 64-bit Log Sequence Number
 * (LSN) to track the position in the WAL stream.  The LSN display format is
 * `XXXXXXXX/YYYYYYYY` where each half is a 32-bit hex value:
 *
 *   - Upper 32 bits = log segment (incremented every 4 GB of WAL)
 *   - Lower 32 bits = offset within the segment (0 to 0xFFFFFFFF)
 *
 * Since sqlvec-db uses SQLite (which does not produce a real WAL stream
 * in the PostgreSQL sense), WALStateManager simulates a monotonic LSN counter
 * that advances by `walSegmentSize` (default 16 MB) each time a WAL switch is
 * requested.  This provides realistic-enough values for PG-compatible tools,
 * connection pool heartbeats, and monitoring queries.
 *
 * ## Usage
 *
 * ```ts
 * const wsm = WALStateManager.getInstance();
 * wsm.setArchiveMode('on');
 * wsm.setArchiveCommand('cp %p /archive/%f');
 *
 * const lsn = wsm.switchWAL();        // '0/1000000'
 * const name = wsm.lsnToFileName(lsn); // '000000010000000000000001'
 * const diff = wsm.lsnDiff('0/2000000', '0/1000000'); // 16777216
 * ```
 *
 * ## Thread-safety
 *
 * WALStateManager is designed for single-threaded JavaScript.  In a
 * multi-shard or multi-worker setup, each worker should create its own
 * instance or share via a synchronized context.
 *
 * @module WALStateManager
 */

import { PinoLogger } from '../logger/PinoLogger';
import { WALArchiver } from '../backup/WALArchiver';
import { PgWalSegmentManager } from './PgWalSegmentManager';
import { MvccCrashRecovery } from '../recovery/MvccCrashRecovery';
import { WalRecordReader } from '../recovery/WalRecordReader';

const logger = PinoLogger.forComponent('WALStateManager');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export type ArchiveMode = 'on' | 'off';
export type WalLevel = 'minimal' | 'replica' | 'logical';

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** PostgreSQL default WAL segment size: 16 MB */
const DEFAULT_WAL_SEGMENT_SIZE = 16 * 1024 * 1024;

// ──────────────────────────────────────────────
//  WALStateManager
// ──────────────────────────────────────────────

export class WALStateManager {
  private static instance: WALStateManager;

  // ── GUC state ──────────────────────────────

  /** Whether archiving is enabled */
  private _archiveMode: ArchiveMode = 'off';

  /** Shell command used to archive WAL segments */
  private _archiveCommand: string = '';

  /** Maximum time (seconds) to wait before forcing a WAL switch */
  private _archiveTimeout: number = 0;

  /** WAL level (SQLite uses replica-level semantics) */
  private _walLevel: WalLevel = 'replica';

  /** Whether WAL replay is paused (used by PITR shim) */
  private _replayPaused: boolean = false;

  // ── LSN tracking ───────────────────────────

  /**
   * Monotonically increasing byte counter representing the current WAL
   * position.  Each call to `switchWAL()` advances this by
   * `walSegmentSize` (16 MB).
   *
   * This is a **byte count**, not a segment count.  LSN display splits it
   * into `XXXXXXXX/YYYYYYYY` hex representation.
   *
   * @internal
   */
  private _currentLSN: number = 0;

  /** PostgreSQL WAL segment size (default 16 MB) */
  private readonly _walSegmentSize: number;

  /**
   * Optional WALArchiver instance for performing actual WAL file archiving.
   * If provided, `archive()` will delegate to it.
   */
  private _walArchiver: WALArchiver | null = null;

  /**
   * Optional reference to the PgWalSegmentManager for WAL segment lifecycle
   * tracking.  Set via `setSegmentManager()`.
   */
  private _segmentManager: PgWalSegmentManager | null = null;

  // ── Construction ───────────────────────────

  private constructor(segmentSize: number = DEFAULT_WAL_SEGMENT_SIZE) {
    this._walSegmentSize = segmentSize;
  }

  /**
   * Get the singleton instance.  The instance is created lazily on first
   * access.
   */
  static getInstance(): WALStateManager {
    if (!WALStateManager.instance) {
      WALStateManager.instance = new WALStateManager();
    }
    return WALStateManager.instance;
  }

  /**
   * Reset the singleton to its initial state.  Used primarily in tests.
   *
   * Resets internal fields rather than replacing the instance, so that
   * existing module-level references (e.g. `const wsm = WALStateManager.getInstance()`)
   * remain valid after reset.
   */
  static resetInstance(): void {
    const inst = WALStateManager.getInstance();
    inst._archiveMode = 'off';
    inst._archiveCommand = '';
    inst._archiveTimeout = 0;
    inst._walLevel = 'replica';
    inst._replayPaused = false;
    inst._currentLSN = 0;
    inst._receivedLSN = 0;
    inst._replayedLSN = 0;
    inst._lastRestorePointLSN = 0;
    inst._lastCheckpointLSN = 0;
    inst._checkpointCounter = 0;
    inst._lastCheckpointTime = 0;
    inst._restorePoints = [];
    inst._walArchiver = null;
    inst._segmentManager = null;
    logger.debug('WALStateManager reset to initial state');
  }

  /**
   * Inject a WALArchiver instance so that `archive()` can perform actual
   * file-based WAL archiving.
   */
  setWALArchiver(archiver: WALArchiver): void {
    this._walArchiver = archiver;
  }

  /**
   * Inject a PgWalSegmentManager instance for WAL segment lifecycle tracking.
   * The segment manager will be notified on every switchWAL() call.
   */
  setSegmentManager(manager: PgWalSegmentManager): void {
    this._segmentManager = manager;
  }

  // ── Archive mode ───────────────────────────

  setArchiveMode(mode: ArchiveMode): void {
    this._archiveMode = mode;
    logger.debug({ archiveMode: mode }, 'WAL archive mode updated');
  }

  getArchiveMode(): ArchiveMode {
    return this._archiveMode;
  }

  // ── Archive command ────────────────────────

  setArchiveCommand(cmd: string): void {
    this._archiveCommand = cmd;
    logger.debug({ archiveCommand: cmd }, 'WAL archive command updated');
  }

  getArchiveCommand(): string {
    return this._archiveCommand;
  }

  // ── Archive timeout ────────────────────────

  setArchiveTimeout(timeout: number): void {
    this._archiveTimeout = timeout;
    logger.debug({ archiveTimeout: timeout }, 'WAL archive timeout updated');
  }

  getArchiveTimeout(): number {
    return this._archiveTimeout;
  }

  // ── WAL level ──────────────────────────────

  setWalLevel(level: WalLevel): void {
    this._walLevel = level;
  }

  getWalLevel(): WalLevel {
    return this._walLevel;
  }

  // ── Replication tracking ────────────────────

  /**
   * Simulated receive LSN byte position.  In PostgreSQL, this represents
   * the position up to which WAL has been received from the primary.
   * Since sqlvec-db is always a primary, this tracks the same
   * position as the current WAL (i.e., full receive).
   */
  private _receivedLSN: number = 0;

  /**
   * Simulated replay LSN byte position.  In PostgreSQL, this represents
   * the position up to which WAL has been replayed on a standby.
   * Since sqlvec-db is always a primary, this tracks the same
   * position as the current WAL (i.e., fully replayed).
   */
  private _replayedLSN: number = 0;

  /**
   * Last restore point LSN (byte position).  Updated whenever
   * `createRestorePoint()` is called.
   */
  private _lastRestorePointLSN: number = 0;

  /**
   * LSN of the last checkpoint that was written.
   * Used by CHECKPOINT command and by pg_stat_checkpointer.
   * Initialised to 0 (no checkpoint).
   */
  private _lastCheckpointLSN: number = 0;

  /**
   * Counter of CHECKPOINT operations performed since startup.
   * Incremented every time recordCheckpoint() is called.
   */
  private _checkpointCounter: number = 0;

  /**
   * Timestamp of the last CHECKPOINT (epoch ms).
   */
  private _lastCheckpointTime: number = 0;

  /**
   * Array of named restore points created via `pg_create_restore_point()`.
   * Each entry records the name, LSN string, and creation timestamp.
   */
  private _restorePoints: Array<{
    name: string;
    lsn: string;
    time: number;
  }> = [];

  // ── Replay paused state ────────────────────

  setReplayPaused(paused: boolean): void {
    this._replayPaused = paused;
    logger.debug({ replayPaused: paused }, 'WAL replay pause state updated');
  }

  isReplayPaused(): boolean {
    return this._replayPaused;
  }

  // ── LSN operations ─────────────────────────

  /**
   * Convert the internal LSN byte counter to the PG display format
   * `XXXXXXXX/YYYYYYYY` (two 32-bit hex values separated by '/').
   *
   * Examples:
   *   - `0`         → `'0/0'`
   *   - `16777216`  → `'0/1000000'`  (16 MB)
   *   - `33554432`  → `'0/2000000'`  (32 MB)
   *   - `4294967296` → `'1/0'`       (4 GB)
   */
  private lsnToString(lsnBytes: number): string {
    const upper = Math.floor(lsnBytes / 0x100000000);
    const lower = lsnBytes % 0x100000000;
    return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
  }

  /**
   * Parse an LSN string `XXXXXXXX/YYYYYYYY` back to a byte count.
   *
   * @param lsn  LSN string in PG format (e.g. `'0/1000000'`)
   * @returns    Byte count
   * @throws     If the LSN string format is invalid
   */
  private lsnToNumber(lsn: string): number {
    const parts = lsn.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid LSN format: "${lsn}" (expected "XXXXXXXX/YYYYYYYY")`);
    }
    const upper = parseInt(parts[0], 16);
    const lower = parseInt(parts[1], 16);
    if (isNaN(upper) || isNaN(lower)) {
      throw new Error(`Invalid LSN format: "${lsn}" (non-hexadecimal parts)`);
    }
    return upper * 0x100000000 + lower;
  }

  /**
   * Get the current LSN as a PG-format string.
   */
  getCurrentLSN(): string {
    return this.lsnToString(this._currentLSN);
  }

  /**
   * Get the simulated receive LSN as a PG-format string.
   *
   * In PostgreSQL, `pg_last_wal_receive_lsn()` returns the position up to
   * which WAL has been received from the primary.  Since sqlvec-db is
   * always a primary, this returns the current WAL position (i.e., all WAL
   * is considered received).
   */
  getLastReceiveLSN(): string {
    return this.lsnToString(this._receivedLSN);
  }

  /**
   * Get the simulated replay LSN as a PG-format string.
   *
   * In PostgreSQL, `pg_last_wal_replay_lsn()` returns the position up to
   * which WAL has been replayed on a standby.  Since sqlvec-db is
   * always a primary, this returns the current WAL position (i.e., all WAL
   * is considered replayed).
   */
  getLastReplayLSN(): string {
    return this.lsnToString(this._replayedLSN);
  }

  /**
   * Create a named restore point and return its LSN.
   *
   * This mirrors PostgreSQL's `pg_create_restore_point(name)`.  The restore
   * point uses the current WAL position to provide a realistic LSN value.
   * The point is stored in the internal `restorePoints` array for audit
   * and future reference.
   *
   * @param name  Restore point name (must be non-empty)
   * @returns     LSN string (PG format, e.g. `'0/1000000'`)
   * @throws      If name is empty or invalid
   */
  createRestorePoint(name: string): string {
    if (!name || typeof name !== 'string') {
      throw new Error(
        `Invalid restore point name: "${name}" (must be a non-empty string)`,
      );
    }
    // Use the last-restore-point LSN, advancing it by one virtual "page"
    // to ensure each restore point has a unique, monotonically increasing
    // position.  If no previous restore point exists, start at the current
    // WAL position.
    if (this._lastRestorePointLSN === 0) {
      this._lastRestorePointLSN = this._currentLSN;
    }
    this._lastRestorePointLSN += this._walSegmentSize;

    const lsn = this.lsnToString(this._lastRestorePointLSN);
    this._restorePoints.push({
      name,
      lsn,
      time: Date.now(),
    });

    logger.debug(
      { name, lsn, count: this._restorePoints.length },
      'Restore point created',
    );
    return lsn;
  }

  /**
   * Get the list of all created restore points.
   */
  getRestorePoints(): Array<{ name: string; lsn: string; time: number }> {
    return [...this._restorePoints];
  }

  /**
   * Get the last restore point's LSN as a PG-format string.
   */
  getLastRestorePointLSN(): string {
    return this.lsnToString(this._lastRestorePointLSN);
  }

  /**
   * Switch to a new WAL segment and return the new LSN.
   *
   * Advances the internal byte counter by `walSegmentSize` (16 MB by default)
   * and returns the new LSN position in PG format.
   *
   * If a PgWalSegmentManager has been registered, its `onWalSwitch()` is
   * called to track the segment lifecycle.
   *
   * @returns New LSN string (e.g. `'0/1000000'`)
   */
  switchWAL(): string {
    this._currentLSN += this._walSegmentSize;
    const newLsn = this.lsnToString(this._currentLSN);

    // Notify the segment manager if one is registered
    if (this._segmentManager) {
      this._segmentManager.onWalSwitch(this._currentLSN);
    }

    logger.debug({ newLSN: newLsn }, 'WAL segment switched');
    return newLsn;
  }

  /**
   * Compute the difference between two LSNs (lsn1 - lsn2) in bytes.
   *
   * Returns a positive number if lsn1 > lsn2, negative if lsn1 < lsn2,
   * zero if equal.
   *
   * This mirrors PostgreSQL's `pg_wal_lsn_diff()` function.
   *
   * @param lsn1  First LSN (PG format)
   * @param lsn2  Second LSN (PG format)
   * @returns     Difference in bytes
   */
  lsnDiff(lsn1: string, lsn2: string): number {
    return this.lsnToNumber(lsn1) - this.lsnToNumber(lsn2);
  }

  /**
   * Convert an LSN to a PostgreSQL WAL file name.
   *
   * PG WAL file naming convention:
   *   `TTTTTTTTLLLLLLLLSSSSSSSS`
   *
   * Where:
   *   - TTTTTTTT = timeline ID (fixed at `00000001` for our shim)
   *   - LLLLLLLL = log segment ID = upper 32 bits of LSN
   *   - SSSSSSSS = segment number = floor(lower 32 bits / walSegmentSize)
   *
   * Each component is zero-padded to 8 hex characters.
   *
   * @param lsn  LSN string (PG format, e.g. `'0/2000000'`)
   * @returns    WAL file name (e.g. `'000000010000000000000002'`)
   */
  lsnToFileName(lsn: string): string {
    const bytes = this.lsnToNumber(lsn);
    const upper = Math.floor(bytes / 0x100000000);
    const lower = bytes % 0x100000000;
    const segmentNum = Math.floor(lower / this._walSegmentSize);

    const timeline = '00000001';
    const logId = upper.toString(16).toUpperCase().padStart(8, '0');
    const segment = segmentNum.toString(16).toUpperCase().padStart(8, '0');

    return `${timeline}${logId}${segment}`;
  }

  /**
   * Convert an LSN to a file name and offset pair.
   *
   * Returns:
   *   - `fileName`: Full WAL file name (same as `lsnToFileName`)
   *   - `fileOffset`: Byte offset within the WAL segment (lower 32 bits
   *     modulo walSegmentSize)
   *
   * @param lsn  LSN string (PG format)
   * @returns    Object with `fileName` and `fileOffset`
   */
  lsnToFileOffset(lsn: string): { fileName: string; fileOffset: number } {
    const bytes = this.lsnToNumber(lsn);
    const lower = bytes % 0x100000000;
    const fileOffset = lower % this._walSegmentSize;
    return {
      fileName: this.lsnToFileName(lsn),
      fileOffset,
    };
  }

  /**
   * Get the current WAL segment size in bytes.
   */
  getWalSegmentSize(): number {
    return this._walSegmentSize;
  }

  /**
   * Get the raw byte counter (for testing/diagnostics).
   */
  getRawLSN(): number {
    return this._currentLSN;
  }

  // ── Archive ────────────────────────────────

  /**
   * Perform a WAL archive operation.
   *
   * If a WALArchiver has been registered, delegates to it.  Otherwise,
   * this is a no-op that returns `true`.
   *
   * @param shardId   Shard identifier
   * @param walPath   Path to the WAL file to archive
   * @param pointName Optional restore point name
   * @returns         `true` if the archive succeeded (or no archiver registered)
   */
  async archive(
    shardId: string,
    walPath: string,
    pointName?: string,
  ): Promise<boolean> {
    if (!this._walArchiver) {
      logger.warn('No WALArchiver registered — archive is a no-op');
      return true;
    }
    try {
      await this._walArchiver.archiveWAL(shardId, walPath, pointName);
      logger.info({ shardId, walPath }, 'WAL archived successfully');
      return true;
    } catch (err: any) {
      logger.error({ err: err.message, shardId, walPath }, 'WAL archive failed');
      return false;
    }
  }

  // ── Replay integration ─────────────────────────

  /**
   * Set the replayed LSN position.  Called by PhysicalWalReplayer after
   * each WAL record is replayed.
   *
   * @param lsn  LSN string (PG format, e.g. "0/1ABCDEF")
   */
  setReplayedLSN(lsn: string): void {
    this._replayedLSN = this.lsnToNumber(lsn);
  }

  /**
   * Get the current replayed LSN as a byte value.
   */
  getReplayedLSNRaw(): number {
    return this._replayedLSN;
  }

  // ── Crash recovery ────────────────────────────

  /**
   * Run crash recovery from WAL segments.
   *
   * Scans the segment directory, replays WAL records, and reconstructs
   * transaction state (committed/aborted/in-progress XIDs) and row
   * version metadata.
   *
   * @param segmentDir  Directory containing WAL segment files
   * @returns           RecoveryResult with reconstructed state
   */
  recoverFromCrash(segmentDir: string): {
    recovered: boolean;
    committedXids: number[];
    abortedXids: number[];
    inProgressXids: number[];
    replayStartLSN: string;
    replayEndLSN: string;
    recordsReplayed: number;
    durationMs: number;
  } {
    const reader = new WalRecordReader();
    const recovery = new MvccCrashRecovery(reader);
    return recovery.recover(segmentDir);
  }

  /**
   * Check whether recovery is needed.
   *
   * Recovery is needed if (a) WAL segment files exist in the segment
   * directory, and (b) the current LSN is out of sync with what the
   * segments suggest (non-empty segments with no checkpoint matching
   * the current state).
   *
   * This is a heuristic — in production, a more robust check would
   * compare a stored "last clean shutdown" flag or LSN boundary.
   *
   * @returns  `true` if a crash recovery scan should be attempted
   */
  needsRecovery(): boolean {
    // In a real system, this would check for a clean-shutdown marker.
    // For now, the LSN state alone determines recovery need:
    // If LSN > 0 and we have no stored checkpoint, recovery may be needed.
    return this._currentLSN > 0;
  }

  /**
   * Record a checkpoint at the current WAL position.
   *
   * Updates the last-checkpoint LSN, increments the counter, and records
   * the timestamp.  This is the companion to the CHECKPOINT SQL command:
   * after PgWalWriter.writeCheckpoint() writes the binary WAL record,
   * call this to update the in-memory checkpoint state.
   *
   * @returns  The checkpoint LSN (PG format string, e.g. "0/1000000")
   */
  recordCheckpoint(): string {
    this._lastCheckpointLSN = this._currentLSN;
    this._checkpointCounter++;
    this._lastCheckpointTime = Date.now();
    const lsn = this.lsnToString(this._lastCheckpointLSN);
    logger.debug({ checkpointLSN: lsn, count: this._checkpointCounter }, 'Checkpoint recorded');
    return lsn;
  }

  /**
   * Get the last checkpoint LSN as a PG-formatted string.
   */
  getLastCheckpointLSN(): string {
    return this.lsnToString(this._lastCheckpointLSN);
  }

  /**
   * Get the number of checkpoints performed since startup.
   */
  getCheckpointCount(): number {
    return this._checkpointCounter;
  }

  /**
   * Get the timestamp of the last checkpoint (epoch ms).
   */
  getLastCheckpointTime(): number {
    return this._lastCheckpointTime;
  }

  /**
   * Prune WAL segments before (older than) the last checkpoint LSN.
   *
   * When a PgWalSegmentManager is registered, this marks all segments
   * whose end position is <= the last checkpoint LSN as archived and
   * removed, effectively cleaning up old WAL data.
   *
   * In a production system this would also delete physical segment files.
   *
   * @returns  Number of segments pruned
   */
  pruneBeforeCheckpoint(): number {
    if (this._lastCheckpointLSN === 0 || !this._segmentManager) {
      return 0;
    }

    const allSegments = this._segmentManager.getAllSegments();
    let pruned = 0;

    for (const seg of allSegments) {
      // Convert segment LSN to byte position
      const segLsnBytes = this.lsnToNumber(seg.lsn);
      // A segment ends at startLSN + segmentSize
      const segEnd = segLsnBytes + this._walSegmentSize;

      // If the entire segment ends before the checkpoint, prune it
      if (segEnd <= this._lastCheckpointLSN) {
        if (!seg.archived) {
          this._segmentManager.markArchived(seg.name);
        }
        if (!seg.removed) {
          this._segmentManager.markRemoved(seg.name);
        }
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.debug({ prunedSegments: pruned, checkpointLSN: this.getLastCheckpointLSN() }, 'WAL segments pruned before checkpoint');
    }
    return pruned;
  }

  /**
   * Return a human-readable summary of the current WAL state (for diagnostics).
   */
  getStatusSummary(): Record<string, unknown> {
    return {
      archiveMode: this._archiveMode,
      archiveCommand: this._archiveCommand,
      archiveTimeout: this._archiveTimeout,
      walLevel: this._walLevel,
      currentLSN: this.getCurrentLSN(),
      rawLSNbytes: this._currentLSN,
      walSegmentSize: this._walSegmentSize,
      replayPaused: this._replayPaused,
      receivedLSN: this.getLastReceiveLSN(),
      replayedLSN: this.getLastReplayLSN(),
      restorePointCount: this._restorePoints.length,
      lastRestorePointLSN: this.getLastRestorePointLSN(),
      lastCheckpointLSN: this.getLastCheckpointLSN(),
      checkpointCount: this._checkpointCounter,
      lastCheckpointTime: this._lastCheckpointTime
        ? new Date(this._lastCheckpointTime).toISOString()
        : null,
      hasArchiver: this._walArchiver !== null,
    };
  }
}
