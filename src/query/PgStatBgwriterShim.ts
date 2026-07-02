import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('pg-stat-bgwriter');

/**
 * PgStatBgwriterShim — PostgreSQL pg_stat_bgwriter view compatibility.
 *
 * PostgreSQL's pg_stat_bgwriter exposes checkpointer and bgwriter statistics.
 * Since SQLite uses WAL (not a background writer), most counters are
 * derived from the SQLite WAL state or simply mocked.
 *
 * Fields:
 *   - checkpoints_timed       Number of scheduled checkpoints
 *   - checkpoints_req         Number of requested checkpoints
 *   - buffers_checkpoint      Buffers written during checkpoints
 *   - buffers_clean           Buffers written by background writer
 *   - buffers_backend         Buffers written by backends
 *   - buffers_backend_fsync   Number of fsync calls by backends
 *   - buffers_alloc           Total buffers allocated
 *   - stats_reset             Last reset timestamp
 *
 * Usage:
 *   SELECT * FROM pg_stat_bgwriter;
 *   → { checkpoints_timed: 42, checkpoints_req: 5, ... }
 */

export interface PgStatBgwriterRow {
  checkpoints_timed: number;
  checkpoints_req: number;
  buffers_checkpoint: number;
  buffers_clean: number;
  buffers_backend: number;
  buffers_backend_fsync: number;
  buffers_alloc: number;
  stats_reset: string;
}

export class PgStatBgwriterShim {
  private stats: PgStatBgwriterRow;
  private lastReset: Date;

  /**
   * Internal counters that are bumped by background operations.
   */
  private checkpointCount = 0;
  private checkpointReqCount = 0;
  private bufferCheckpoint = 0;
  private bufferClean = 0;
  private bufferBackend = 0;
  private fsyncCount = 0;
  private allocCount = 0;

  constructor() {
    this.lastReset = new Date();
    this.stats = this.snapshot();
  }

  /**
   * Bump timed checkpoint counter.
   */
  recordTimedCheckpoint(buffers: number): void {
    this.checkpointCount++;
    this.bufferCheckpoint += buffers;
  }

  /**
   * Bump requested checkpoint counter.
   */
  recordRequestedCheckpoint(buffers: number): void {
    this.checkpointReqCount++;
    this.bufferCheckpoint += buffers;
  }

  /**
   * Record a clean buffer write (bgwriter).
   */
  recordCleanBuffer(): void {
    this.bufferClean++;
  }

  /**
   * Record a backend buffer write.
   */
  recordBackendBuffer(fsyncRequired: boolean): void {
    this.bufferBackend++;
    if (fsyncRequired) {
      this.fsyncCount++;
    }
  }

  /**
   * Record a buffer allocation.
   */
  recordAlloc(count: number = 1): void {
    this.allocCount += count;
  }

  /**
   * Take a snapshot of current stats.
   */
  snapshot(): PgStatBgwriterRow {
    return {
      checkpoints_timed: this.checkpointCount,
      checkpoints_req: this.checkpointReqCount,
      buffers_checkpoint: this.bufferCheckpoint,
      buffers_clean: this.bufferClean,
      buffers_backend: this.bufferBackend,
      buffers_backend_fsync: this.fsyncCount,
      buffers_alloc: this.allocCount,
      stats_reset: this.lastReset.toISOString(),
    };
  }

  /**
   * Reset all stats counters.
   */
  reset(): void {
    this.checkpointCount = 0;
    this.checkpointReqCount = 0;
    this.bufferCheckpoint = 0;
    this.bufferClean = 0;
    this.bufferBackend = 0;
    this.fsyncCount = 0;
    this.allocCount = 0;
    this.lastReset = new Date();
    this.stats = this.snapshot();
    logger.info('PgStatBgwriter stats reset');
  }
}
