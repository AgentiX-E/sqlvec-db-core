import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('prewarm');

/**
 * PrewarmShim — PostgreSQL pg_prewarm() compatibility for SQLite.
 *
 * PostgreSQL's pg_prewarm extension loads table data into the OS page cache
 * or PostgreSQL's shared buffers, reducing first-access latency.
 *
 * Since SQLite does not have a managed buffer pool, this shim:
 *   1. Performs a SELECT COUNT(*) on the target table to force SQLite
 *      to read all pages into the OS page cache
 *   2. Optionally performs a full sequential scan (SELECT *) to maximise
 *      cache residency
 *
 * Usage:
 *   const prewarm = new PrewarmShim(db);
 *   const pages = await prewarm.prewarm('my_table');
 *   // → 42 (number of pages read)
 *
 * Modes (matching pg_prewarm):
 *   - 'prefetch'     Not supported on SQLite (falls back to read)
 *   - 'read'         SELECT COUNT(*) to read all pages
 *   - 'buffer'       Full sequential scan (MAXIMAL warming)
 */

export type PrewarmMode = 'prefetch' | 'read' | 'buffer';

export interface PrewarmResult {
  table: string;
  mode: PrewarmMode;
  pagesRead: number;
  durationMs: number;
  bytesRead: number;
}

export class PrewarmShim {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Prewarm a table by reading its pages into the OS page cache.
   *
   * @param tableName Table name to prewarm
   * @param mode     Prewarm mode (default: 'read')
   * @returns        Prewarm result with page count and timing
   */
  prewarm(tableName: string, mode: PrewarmMode = 'read'): PrewarmResult {
    const startTime = Date.now();
    let pagesRead = 0;
    let bytesRead = 0;

    // Validate table exists
    const tableCheck = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name=?`,
    ).get(tableName) as { cnt: number } | undefined;

    if (!tableCheck || tableCheck.cnt === 0) {
      throw new Error(`Table "${tableName}" does not exist`);
    }

    try {
      if (mode === 'read' || mode === 'prefetch') {
        // Use page_count pragma to get actual page count
        const pageCount = this.db.pragma('page_count', { simple: true }) as number;
        const pageSize = this.db.pragma('page_size', { simple: true }) as number;

        // SELECT COUNT(*) forces a full index or table scan to warm cache
        const countStmt = this.db.prepare(`SELECT COUNT(*) FROM "${tableName}"`);
        const rowResult = countStmt.get() as Record<string, number>;
        const rowCount = Object.values(rowResult)[0] ?? 0;

        if (rowCount === 0) {
          pagesRead = 0;
          bytesRead = 0;
        } else {
          pagesRead = pageCount;
          bytesRead = pageCount * pageSize;
        }
      } else if (mode === 'buffer') {
        // Full sequential scan — this guarantees all pages are in cache
        const scanStmt = this.db.prepare(`SELECT * FROM "${tableName}"`);
        let rowCount = 0;
        let totalSize = 0;

        // Iterate to force page reads
        for (const row of scanStmt.iterate() as IterableIterator<Record<string, unknown>>) {
          rowCount++;
          // Estimate row size
          let rowSize = 0;
          for (const val of Object.values(row)) {
            if (val === null) continue;
            if (typeof val === 'string') rowSize += val.length * 2;
            else if (typeof val === 'number') rowSize += 8;
            else if (val instanceof Buffer) rowSize += val.length;
            // defensive fallback for an unexpected non-scalar value: with
            // better-sqlite3 the only non-null shapes are string/number/Buffer,
            // so this branch is unreachable against real SQLite data but keeps
            // the `unknown` row-value contract total.
            else rowSize += 4;
          }
          totalSize += rowSize;
        }

        pagesRead = rowCount;
        bytesRead = totalSize;
      }

      const endTime = Date.now();
      logger.info({
        table: tableName,
        mode,
        pagesRead,
        bytesRead,
        durationMs: endTime - startTime,
      }, 'Table prewarmed');

      return {
        table: tableName,
        mode,
        pagesRead,
        durationMs: endTime - startTime,
        bytesRead,
      };
    } catch (err) {
      const endTime = Date.now();
      logger.error({ err, table: tableName, mode }, 'Prewarm failed');
      throw err;
    }
  }

  /**
   * Prewarm all user tables (skipping SQLite internal tables and sequences).
   */
  prewarmAll(mode: PrewarmMode = 'read'): PrewarmResult[] {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 8) != '_sqlvec_'`,
    ).all() as { name: string }[];

    const results: PrewarmResult[] = [];
    for (const { name } of tables) {
      try {
        results.push(this.prewarm(name, mode));
      } catch (err) {
        logger.error({ err, table: name }, 'PrewarmAll failed for table');
      }
    }

    return results;
  }
}
