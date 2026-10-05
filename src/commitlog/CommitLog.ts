/**
 * CommitLog — Transaction commit/abort tracking backed by SQLite.
 *
 * Mirrors PostgreSQL's CLOG (Commit Log) subsystem.  Tracks which
 * transaction IDs (XIDs) have been committed, aborted, or are still
 * in-progress.
 *
 * ## Table schema
 * ```sql
 * CREATE TABLE IF NOT EXISTS __pg_clog (
 *   xid          INTEGER PRIMARY KEY,
 *   status       TEXT    NOT NULL,  -- 'committed' | 'aborted'
 *   commit_time  INTEGER            -- epoch ms (only for committed)
 * );
 * ```
 *
 * ## Usage
 * ```ts
 * const db = new Database(':memory:');
 * const clog = new CommitLog(db);
 * clog.commit(42, Date.now());
 * clog.isCommitted(42); // true
 * clog.abort(99);
 * clog.getStatus(99); // 'aborted'
 * ```
 *
 * @module commitlog/CommitLog
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('CommitLog');

// ── Types ────────────────────────────────────────────────────────

export type ClogStatus = 'committed' | 'aborted' | 'unknown';

/**
 * Minimal SQLite database interface compatible with better-sqlite3.
 */
export interface ClogDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  };
}

// ── CommitLog ────────────────────────────────────────────────────

export class CommitLog {
  private db: ClogDatabase;

  /**
   * @param db  A better-sqlite3 Database instance (or compatible)
   */
  constructor(db: ClogDatabase) {
    this.db = db;
    this.ensureTable();
  }

  /**
   * Create the `__pg_clog` table if it does not exist.
   */
  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS __pg_clog (
        xid          INTEGER PRIMARY KEY,
        status       TEXT    NOT NULL,
        commit_time  INTEGER
      )
    `);
  }

  /**
   * Mark an XID as committed.
   *
   * Upserts the entry: if the XID already exists (e.g., was previously
   * marked as aborted during an earlier replay), it is overwritten with
   * 'committed'.
   *
   * @param xid          Transaction ID to commit
   * @param commitTime   Optional commit timestamp (epoch ms, defaults to Date.now())
   */
  commit(xid: number, commitTime?: number): void {
    if (xid <= 0) return;
    const time = commitTime ?? Date.now();
    this.db.prepare(
      'INSERT OR REPLACE INTO __pg_clog (xid, status, commit_time) VALUES (?, ?, ?)',
    ).run(xid, 'committed', time);
    logger.trace({ xid }, 'CommitLog: committed');
  }

  /**
   * Mark an XID as aborted.
   *
   * Upserts the entry.  If the XID was previously committed, it is
   * overwritten — this matches PG behavior where a subsequent ABORT
   * record for the same XID takes precedence (relevant during crash
   * recovery replay).
   *
   * @param xid  Transaction ID to abort
   */
  abort(xid: number): void {
    if (xid <= 0) return;
    this.db.prepare(
      'INSERT OR REPLACE INTO __pg_clog (xid, status, commit_time) VALUES (?, ?, NULL)',
    ).run(xid, 'aborted');
    logger.trace({ xid }, 'CommitLog: aborted');
  }

  /**
   * Get the commit status of a transaction.
   *
   * Returns one of:
   *   - 'committed' — XID was committed
   *   - 'aborted'   — XID was aborted
   *   - 'unknown'   — XID is not known to the system at all
   *
   * This CLOG only records the terminal commit/abort outcomes; it never
   * allocates XIDs, so it has no "in-progress" state. (XID allocation and
   * in-progress tracking live in the separate ClogManager.)
   *
   * @param xid  Transaction ID
   * @returns    ClogStatus
   */
  getStatus(xid: number): ClogStatus {
    if (xid <= 0) return 'unknown';
    const row = this.db.prepare(
      'SELECT status FROM __pg_clog WHERE xid = ?',
    ).get(xid) as { status: string } | undefined;

    if (!row) return 'unknown';
    if (row.status === 'committed') return 'committed';
    if (row.status === 'aborted') return 'aborted';
    return 'unknown';
  }

  /**
   * Check whether an XID is committed.
   *
   * @param xid  Transaction ID
   * @returns    `true` if the XID is definitely committed
   */
  isCommitted(xid: number): boolean {
    return this.getStatus(xid) === 'committed';
  }

  /**
   * Check whether an XID is aborted.
   *
   * @param xid  Transaction ID
   * @returns    `true` if the XID is definitely aborted
   */
  isAborted(xid: number): boolean {
    return this.getStatus(xid) === 'aborted';
  }

  /**
   * Remove CLog entries for XIDs below the given threshold.
   *
   * Used by VACUUM to trim the CLog and prevent unbounded growth.
   * The `beforeXid` threshold should be the oldest XID that any active
   * transaction might still reference.
   *
   * @param beforeXid  Remove entries with xid < beforeXid
   * @returns          Number of entries removed
   */
  cleanup(beforeXid: number): number {
    if (beforeXid <= 0) return 0;
    const result = this.db.prepare(
      'DELETE FROM __pg_clog WHERE xid < ?',
    ).run(beforeXid);
    const removed = result.changes;
    if (removed > 0) {
      logger.debug({ beforeXid, removed }, 'CommitLog: cleanup completed');
    }
    return removed;
  }

  /**
   * Get the total number of CLog entries.
   */
  get size(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS cnt FROM __pg_clog',
    ).get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Delete all CLog entries (for testing).
   */
  clear(): void {
    this.db.exec('DELETE FROM __pg_clog');
    logger.debug('CommitLog: cleared');
  }

  /**
   * Get all committed XIDs.
   */
  getCommittedXids(): number[] {
    const rows = this.db.prepare(
      'SELECT xid FROM __pg_clog WHERE status = ? ORDER BY xid',
    ).all('committed') as Array<{ xid: number }>;
    return rows.map(r => r.xid);
  }

  /**
   * Get all aborted XIDs.
   */
  getAbortedXids(): number[] {
    const rows = this.db.prepare(
      'SELECT xid FROM __pg_clog WHERE status = ? ORDER BY xid',
    ).all('aborted') as Array<{ xid: number }>;
    return rows.map(r => r.xid);
  }
}

export default CommitLog;
