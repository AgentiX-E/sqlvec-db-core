/**
 * PgWalSegmentShim — WAL segment management compatibility for sqlvec-db.
 *
 * PostgreSQL provides several built-in functions for WAL segment inspection
 * and lifecycle management.  This shim aggregates the real implementations
 * that delegate to WALStateManager and PgWalSegmentManager.
 *
 * ## Function mapping
 * | PG function                            | Handler                                | Status      |
 * |----------------------------------------|----------------------------------------|-------------|
 * | `pg_current_wal_lsn()`                 | ReplicationLagShim / WALStateManager   | ✅ Shipped  |
 * | `pg_current_wal_insert_lsn()`          | WALStateManager.getCurrentLSN()        | ✅ Shipped  |
 * | `pg_current_wal_flush_lsn()`           | WALStateManager.getCurrentLSN()        | ✅ Shipped  |
 * | `pg_walfile_name(lsn)`                 | WALArchiveShim / WALStateManager       | ✅ Shipped  |
 * | `pg_walfile_name_offset(lsn)`          | WALArchiveShim / WALStateManager       | ✅ Shipped  |
 * | `pg_switch_wal()`                      | HAPromotionShim / WALStateManager      | ✅ Shipped  |
 * | `pg_wal_lsn_diff(lsn1, lsn2)`          | WALStateManager.lsnDiff()              | ✅ Shipped  |
 * | `pg_wal_replay_pause()`                | PITRShim / WALStateManager             | ✅ Shipped  |
 * | `pg_wal_replay_resume()`               | PITRShim / WALStateManager             | ✅ Shipped  |
 * | `pg_stat_wal` (view)                   | PgWalSegmentManager.getAllSegments()   | 🆕 This file |
 * | `pg_wal_segment_size()`                | PgWalSegmentManager.getSegmentSize()   | 🆕 This file |
 *
 * ## Integration note
 *
 * The functions above are already handled by their respective shims
 * (ReplicationLagShim, WALArchiveShim, HAPromotionShim, PITRShim).
 * This file provides:
 *   1. Direct TypeScript accessors for SQL function resolution
 *   2. A convenience for `pg_wal_segment_size()`
 *   3. Segment status helpers for diagnostic views
 *
 * @module PgWalSegmentShim
 */

import { WALStateManager } from '../storage/WALStateManager';
import { PgWalSegmentManager, WalSegment } from '../storage/PgWalSegmentManager';

// ──────────────────────────────────────────────
//  SQL-compatible return types
// ──────────────────────────────────────────────

export interface WalSegmentSizeResult {
  wal_segment_size: number;
}

export interface WalStatResult {
  wal_name: string;
  lsn: string;
  size: number;
  archived: boolean;
  removed: boolean;
  created_at: number;
}

// ──────────────────────────────────────────────
//  Public shim functions
// ──────────────────────────────────────────────

/**
 * Return the current WAL segment size in bytes.
 *
 * PG equivalent: `SELECT pg_wal_segment_size()` → `16777216`
 *
 * This helper resolves the value from WALStateManager or, if available,
 * from PgWalSegmentManager.
 */
export function getWalSegmentSize(): WalSegmentSizeResult {
  const wsm = WALStateManager.getInstance();
  const psm = PgWalSegmentManager.getInstance();
  const size = psm.getSegmentSize() || wsm.getWalSegmentSize();
  return { wal_segment_size: size };
}

/**
 * Return a status array of all known WAL segments (for diagnostics / views).
 *
 * PG equivalent: `SELECT * FROM pg_stat_wal` (segment-specific columns)
 */
export function getWalSegmentStats(): WalStatResult[] {
  const psm = PgWalSegmentManager.getInstance();
  return psm.getAllSegments().map(s => ({
    wal_name: s.name,
    lsn: s.lsn,
    size: s.size,
    archived: s.archived,
    removed: s.removed,
    created_at: s.createdAt,
  }));
}

/**
 * Return the current WAL insert LSN.
 *
 * PG equivalent: `SELECT pg_current_wal_insert_lsn()`
 *
 * Delegates to `WALStateManager.getCurrentLSN()` which returns a
 * monotonic LSN string in `XXXXXXXX/YYYYYYYY` format.
 */
export function getCurrentWalInsertLSN(): string {
  return WALStateManager.getInstance().getCurrentLSN();
}

/**
 * Return the current WAL flush LSN.
 *
 * PG equivalent: `SELECT pg_current_wal_flush_lsn()`
 *
 * In sqlvec-db (primary-only), all WAL is always "flushed", so
 * this returns the same value as `getCurrentWalInsertLSN()`.
 */
export function getCurrentWalFlushLSN(): string {
  return WALStateManager.getInstance().getCurrentLSN();
}

/**
 * Check whether the given LSN falls within a known WAL segment.
 *
 * @param lsn  LSN in PG format (e.g. `'0/1000000'`)
 * @returns    The matching segment or `undefined`
 */
export function findSegmentForLSN(lsn: string): WalSegment | undefined {
  const psm = PgWalSegmentManager.getInstance();
  const name = psm.resolveSegmentName(lsn);
  return psm.getSegment(name);
}

/**
 * Return a human-readable summary of the current WAL segment state.
 */
export function getSegmentSummary(): Record<string, unknown> {
  const psm = PgWalSegmentManager.getInstance();
  const current = psm.getCurrentSegment();
  const pending = psm.getPendingArchiveSegments().length;
  const total = psm.getAllSegments().length;

  return {
    currentSegment: current.name,
    currentLSN: current.lsn,
    segmentSize: current.size,
    totalSegments: total,
    pendingArchive: pending,
    archived: psm.getAllSegments().filter(s => s.archived).length,
    removed: psm.getAllSegments().filter(s => s.removed).length,
  };
}

export default {
  getWalSegmentSize,
  getWalSegmentStats,
  getCurrentWalInsertLSN,
  getCurrentWalFlushLSN,
  findSegmentForLSN,
  getSegmentSummary,
};
