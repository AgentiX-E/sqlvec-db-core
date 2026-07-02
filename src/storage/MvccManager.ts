/**
 * MvccManager — Row-Level MVCC Visibility Manager
 *
 * Provides the core MVCC visibility logic for SqlVec DB.
 *
 * PG Compatibility:
 *   - Each row has __xmin (insert XID), __xmax (delete/update XID, 0 = active)
 *   - Snapshot-based visibility: a row is visible if:
 *       xmin is committed AND (xmax = 0 OR xmax is NOT committed OR xmin IN xip_list)
 *   - Supports READ COMMITTED and REPEATABLE READ isolation levels
 *
 * The snapshot contains:
 *   - xmin: oldest active XID at snapshot time
 *   - xmax: latest committed XID + 1 at snapshot time
 *   - xip_list: all active XIDs at snapshot time (excluding self)
 *
 * Visibility Rule (simplified PG):
 *   Row is visible if:
 *     (1) xmin is committed AND (xmin < snapshot.xmin OR xmin = snapshot.current_xid)
 *     (2) AND (xmax = 0 OR NOT xmax_is_committed OR xmax IS IN xip_list)
 *
 * Usage:
 *   const snapshot = mvcc.createSnapshot(sessionId, xid);
 *   // SQL WHERE clause: __xmin > 0 AND (__xmax = 0 OR __xmax > ?)
 *   // (simplified: __xmin < snapshot.xmax AND (__xmax = 0 OR __xmax >= snapshot.xmin))
 */

import { PinoLogger } from '../logger/PinoLogger';
import { ClogManager, XidStatus } from './ClogManager';

export interface MvccSnapshot {
  /** Unique ID for the current session's transaction (0 if read-only/auto-commit) */
  currentXid: number;
  /** Oldest active XID at snapshot creation time */
  xmin: number;
  /** Latest committed XID + 1 at snapshot creation time (upper bound) */
  xmax: number;
  /** List of active XIDs (excluding current) at snapshot creation time */
  xipList: number[];
  /** Isolation level used for this snapshot */
  isolationLevel: 'read_committed' | 'repeatable_read';
  /** Timestamp when snapshot was created */
  createdAt: number;
}

export class MvccManager {
  private logger = PinoLogger.forComponent('MvccManager');
  private clog: ClogManager;
  // Track which XIDs are currently in-progress per session
  private activeTransactions: Map<string, number> = new Map();
  // Track which XIDs are in-progress globally (for snapshot xip_list)
  private globalActiveXids: Set<number> = new Set();
  // Track per-session snapshots (used for REPEATABLE READ isolation)
  private sessionSnapshots: Map<string, MvccSnapshot> = new Map();

  constructor(clog: ClogManager) {
    this.clog = clog;
  }

  /** Begin a transaction for a session, allocating or returning XID */
  beginTransaction(sessionId: string): number {
    const xid = this.clog.allocateXid();
    this.activeTransactions.set(sessionId, xid);
    this.globalActiveXids.add(xid);
    return xid;
  }

  /** Get the current XID for a session (0 if no active transaction) */
  getCurrentXid(sessionId: string): number {
    return this.activeTransactions.get(sessionId) ?? 0;
  }

  /** Commit the current transaction */
  commitTransaction(sessionId: string): void {
    const xid = this.activeTransactions.get(sessionId);
    if (xid !== undefined) {
      this.clog.commitTransaction(xid);
      this.activeTransactions.delete(sessionId);
      this.globalActiveXids.delete(xid);
      this.sessionSnapshots.delete(sessionId);
    }
  }

  /** Rollback the current transaction */
  rollbackTransaction(sessionId: string): void {
    const xid = this.activeTransactions.get(sessionId);
    if (xid !== undefined) {
      this.clog.abortTransaction(xid);
      this.activeTransactions.delete(sessionId);
      this.globalActiveXids.delete(xid);
      this.sessionSnapshots.delete(sessionId);
    }
  }

  /**
   * Create a snapshot for MVCC visibility.
   * For READ COMMITTED, create fresh on each statement.
   * For REPEATABLE READ, cache and reuse for the transaction.
   */
  createSnapshot(sessionId: string, isolationLevel: 'read_committed' | 'repeatable_read'): MvccSnapshot {
    const currentXid = this.getCurrentXid(sessionId);

    // REPEATABLE READ: reuse cached snapshot for this transaction
    if (isolationLevel === 'repeatable_read') {
      const cached = this.sessionSnapshots.get(sessionId);
      if (cached) return cached;
    }

    const latestCommitted = this.clog.getLatestCommittedXid();
    const xipList = Array.from(this.globalActiveXids)
      .filter(xid => xid !== currentXid)
      .sort((a, b) => a - b);

    const snapshot: MvccSnapshot = {
      currentXid,
      xmin: xipList.length > 0 ? xipList[0] : currentXid || (latestCommitted + 1),
      xmax: Math.max(latestCommitted + 1, currentXid + 1),
      xipList,
      isolationLevel,
      createdAt: Date.now(),
    };

    // Cache for REPEATABLE READ
    if (isolationLevel === 'repeatable_read' && currentXid > 0) {
      this.sessionSnapshots.set(sessionId, snapshot);
    }

    return snapshot;
  }

  /**
   * Check if a row is visible given a snapshot.
   * Uses the simplified PG visibility rule.
   */
  isVisible(snapshot: MvccSnapshot, xmin: number, xmax: number): boolean {
    // xmin = 0 means system row (always visible)
    if (xmin === 0) return true;

    // --- xmin check: is the inserting transaction visible? ---
    const xminVisible = this.xidIsVisible(snapshot, xmin);
    if (!xminVisible) return false;

    // --- xmax check: is the deleting transaction invisible? ---
    if (xmax === 0) return true; // No deleter = visible

    // xmax = current XID = self-deleting = invisible to self
    if (xmax === snapshot.currentXid) return false;

    // xmax is committed = invisible
    if (this.clog.isCommitted(xmax)) return false;

    // xmax is in-progress and in xip_list = invisible
    if (this.globalActiveXids.has(xmax)) return false;

    // xmax is aborted = visible (delete was rolled back)
    return true;
  }

  /**
   * Generate a SQLite-compatible WHERE clause for MVCC visibility.
   * This is injected into SELECT queries to filter visible rows.
   *
   * SQL for READ COMMITTED:
   *   (__xmin <= :xmax AND (__xmax = 0 OR __xmax >= :xmin))
   *   AND NOT (__xmin IN ($XIP_LIST) AND __xmax != 0)
   */
  generateVisibilityWhere(snapshot: MvccSnapshot): string {
    if (snapshot.currentXid === 0) {
      // No active transaction, use most conservative filter
      return `(__xmin > 0 AND (__xmax IS NULL OR __xmax = 0))`;
    }

    // Core visibility: xmin must be ≤ xmax (committed before or at snapshot)
    // AND xmax must be 0 or ≥ xmin (not yet deleted at snapshot time OR deleted by aborted txn)
    // AND xmin must be committed (not in XIP list)
    const xipFilter = snapshot.xipList.length > 0
      ? ` AND __xmin NOT IN (${snapshot.xipList.join(',')})`
      : '';

    // For rows deleted by in-progress transactions: they should be visible
    // (the deleter hasn't committed yet, so the old version is still valid)
    const xipDeleteFilter = snapshot.xipList.length > 0
      ? ` AND (__xmax = 0 OR __xmax NOT IN (${snapshot.xipList.join(',')}) OR __xmax = ${snapshot.currentXid})`
      : ` AND (__xmax = 0 OR __xmax = ${snapshot.currentXid})`;

    return `(__xmin <= ${snapshot.xmax}${xipFilter}${xipDeleteFilter})`;
  }

  /**
   * Generate an optimized MVCC WHERE clause using integer comparisons.
   * Faster execution: (__xmin BETWEEN 0 AND ?) AND (__xmax = 0 OR __xmax > ?)
   *
   * Uses bound parameters for better SQLite caching.
   */
  generateVisibilityWhereParam(snapshot: MvccSnapshot): { clause: string; params: number[] } {
    const params: number[] = [];

    if (snapshot.currentXid === 0) {
      return { clause: '(__xmin > 0 AND (__xmax IS NULL OR __xmax = 0))', params: [] };
    }

    // Simple form: xmin must be visible (committed and ≤ snapshot), xmax must be invisible
    const xidStr = snapshot.xipList.length > 0
      ? snapshot.xipList.join(',')
      : '0';

    if (snapshot.xipList.length > 0) {
      return {
        clause: `(__xmin <= ? AND __xmin NOT IN (${xidStr}) AND (__xmax = 0 OR __xmax < ? OR __xmax IN (${xidStr}) OR __xmax = (?)))`,
        params: [snapshot.xmax, snapshot.xmin, snapshot.currentXid],
      };
    }

    return {
      clause: `(__xmin <= ? AND (__xmax = 0 OR __xmax < ? OR __xmax = ?))`,
      params: [snapshot.xmax, snapshot.xmin, snapshot.currentXid],
    };
  }

  /** Clear all state (for testing / shutdown) */
  reset(): void {
    this.activeTransactions.clear();
    this.globalActiveXids.clear();
    this.sessionSnapshots.clear();
  }

  getActiveTransactionCount(): number {
    return this.activeTransactions.size;
  }

  private xidIsVisible(snapshot: MvccSnapshot, xid: number): boolean {
    if (xid === 0) return true;
    if (xid === snapshot.currentXid) return true; // Self-inserted

    // In xip_list = in-progress = invisible
    if (snapshot.xipList.includes(xid)) return false;

    // Past xmax = definitely committed (or aborted) = visible
    if (xid < snapshot.xmin) return true;

    // Between xmin and xmax: check CLOG
    return this.clog.isCommitted(xid);
  }
}
