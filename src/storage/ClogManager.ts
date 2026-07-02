/**
 * ClogManager — Commit Log (CLOG) Manager
 *
 * Implements PostgreSQL's CLOG equivalent for tracking transaction status.
 * Backed by SQLite's `__clog` table for durability.
 *
 * Transaction states: IN_PROGRESS, COMMITTED, ABORTED
 *
 * Architecture:
 *   - In-memory cache (LRU, 10K entries) for hot XID lookups
 *   - SQLite `__clog` table for cold data + crash recovery
 *   - Lazy allocation: XID assigned only on first write in a transaction
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import Database from 'better-sqlite3';

export const CLOG_TABLE = '__clog';

export enum XidStatus {
  IN_PROGRESS = 'in_progress',
  COMMITTED = 'committed',
  ABORTED = 'aborted',
}

export interface ClogEntry {
  xid: number;
  status: XidStatus;
  commitTs: number | null;
}

const CACHE_MAX = 10000;

export class ClogManager {
  private logger = PinoLogger.forComponent('ClogManager');
  private db: Database.Database;
  /** LRU cache: Map<XID, ClogEntry>. Access order tracked via cacheOrder[] */
  private cache: Map<number, ClogEntry> = new Map();
  /** XID order for LRU eviction (most-recently-used at end) */
  private cacheOrder: number[] = [];
  private xidCounter: number;
  private initialized = false;

  constructor(db: Database.Database) {
    this.db = db;
    this.xidCounter = 0;
  }

  /** Initialize the __clog table and load the XID counter */
  init(): void {
    // Always ensure tables exist (safe with IF NOT EXISTS)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${CLOG_TABLE} (
        xid INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'in_progress',
        commit_ts INTEGER
      )
    `);
    // Index for getLatestCommittedXid() — MAX with WHERE status
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_clog_status ON ${CLOG_TABLE}(status, xid)
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS __xid_counter (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_xid INTEGER NOT NULL DEFAULT 100
      )
    `);

    if (this.initialized) return;

    // Load or create XID counter
    const row = this.db.prepare('SELECT next_xid FROM __xid_counter WHERE id = 1').get() as { next_xid: number } | undefined;
    if (row) {
      this.xidCounter = row.next_xid;
    } else {
      this.xidCounter = 100;
      this.db.prepare('INSERT INTO __xid_counter (id, next_xid) VALUES (1, ?)').run(this.xidCounter);
    }

    // On startup, abort all in_progress transactions (crash recovery)
    const inProgress = this.db.prepare(
      `SELECT xid FROM ${CLOG_TABLE} WHERE status = ?`
    ).all(XidStatus.IN_PROGRESS) as { xid: number }[];

    if (inProgress.length > 0) {
      this.logger.warn(`Aborting ${inProgress.length} in-progress transactions from previous crash`);
      const update = this.db.prepare(`UPDATE ${CLOG_TABLE} SET status = ? WHERE xid = ?`);
      for (const row of inProgress) {
        update.run(XidStatus.ABORTED, row.xid);
      }
    }

    this.initialized = true;
    this.logger.info(`ClogManager initialized, next_xid = ${this.xidCounter}`);
  }

  /** Allocate a new XID atomically */
  allocateXid(): number {
    const xid = this.xidCounter++;
    this.db.prepare('UPDATE __xid_counter SET next_xid = ? WHERE id = 1').run(this.xidCounter);

    this.db.prepare(
      `INSERT OR IGNORE INTO ${CLOG_TABLE} (xid, status, commit_ts) VALUES (?, ?, NULL)`
    ).run(xid, XidStatus.IN_PROGRESS);

    this.setCache(xid, { xid, status: XidStatus.IN_PROGRESS, commitTs: null });
    return xid;
  }

  /** Mark a transaction as committed */
  commitTransaction(xid: number): void {
    const now = Date.now();
    this.db.prepare(
      `UPDATE ${CLOG_TABLE} SET status = ?, commit_ts = ? WHERE xid = ?`
    ).run(XidStatus.COMMITTED, now, xid);
    this.setCache(xid, { xid, status: XidStatus.COMMITTED, commitTs: now });
  }

  /** Mark a transaction as aborted */
  abortTransaction(xid: number): void {
    this.db.prepare(
      `UPDATE ${CLOG_TABLE} SET status = ? WHERE xid = ?`
    ).run(XidStatus.ABORTED, xid);
    this.setCache(xid, { xid, status: XidStatus.ABORTED, commitTs: null });
  }

  /** Get the status of a transaction (updates LRU order on cache hit) */
  getStatus(xid: number): XidStatus {
    const cached = this.cache.get(xid);
    if (cached) {
      this.touchLru(xid);
      return cached.status;
    }

    const row = this.db.prepare(
      `SELECT status FROM ${CLOG_TABLE} WHERE xid = ?`
    ).get(xid) as { status: string } | undefined;

    if (!row) return XidStatus.ABORTED;
    const status = row.status as XidStatus;
    this.setCache(xid, { xid, status, commitTs: null });
    return status;
  }

  /** Check if a transaction committed */
  isCommitted(xid: number): boolean {
    return this.getStatus(xid) === XidStatus.COMMITTED;
  }

  /** Get the latest committed XID (for snapshot xmax calculation) */
  getLatestCommittedXid(): number {
    const row = this.db.prepare(
      `SELECT MAX(xid) as max_xid FROM ${CLOG_TABLE} WHERE status = ?`
    ).get(XidStatus.COMMITTED) as { max_xid: number | null } | undefined;
    return row?.max_xid ?? 0;
  }

  /** Get current counter value */
  getCurrentCounter(): number {
    return this.xidCounter;
  }

  /** LRU: move XID to end of order (most-recently-used) */
  private touchLru(xid: number): void {
    const idx = this.cacheOrder.indexOf(xid);
    if (idx >= 0) {
      this.cacheOrder.splice(idx, 1);
      this.cacheOrder.push(xid);
    }
  }

  private setCache(xid: number, entry: ClogEntry): void {
    if (this.cache.size >= CACHE_MAX) {
      // Evict least-recently-used (front of cacheOrder)
      const oldest = this.cacheOrder.shift();
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(xid, entry);
    this.cacheOrder.push(xid);
  }

  /** Reset for testing */
  reset(): void {
    this.initialized = false;
    this.cache.clear();
    this.xidCounter = 0;
  }
}
