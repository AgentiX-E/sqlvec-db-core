/**
 * PgBufferCacheShim — PostgreSQL pg_buffercache extension shim for SQLite.
 *
 * PostgreSQL's pg_buffercache extension exposes the shared buffer pool
 * contents via a `pg_buffercache` view.  SQLite has no shared buffer pool,
 * so we provide a synthetic view backed by pragma data.
 *
 * ## Exported functions
 *
 * | Function                              | Description                                       |
 * |---------------------------------------|---------------------------------------------------|
 * | `pgBuffercache(pageCount?)`           | Return synthetic buffer-cache row objects         |
 * | `getPgBufferCacheRows(db, activeSessions?)` | Return real SQLite-backed buffer-cache rows |
 * | `detectPgBufferCache(sql)`            | Regex-detect references to pg_buffercache          |
 * | `rewritePgBufferCache(sql)`           | Rewrite queries targeting pg_buffercache          |
 *
 * Each "buffer" row contains:
 *   - bufferid       : 1‑based buffer slot index
 *   - relfilenode    : OID of the relation (table/index)
 *   - relforknumber  : fork number (0 = main)
 *   - relblocknumber : page number within the fork
 *   - isdirty        : always 0 (no dirty tracking in SQLite)
 *   - usagecount     : estimated from cache usage ratio
 *   - pinning_backends: estimated from active session count
 *
 * @module query/PgBufferCacheShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PgBufferCacheShim');

// ── Types ────────────────────────────────────────────────────────

export interface PgBufferCacheRow {
  bufferid: number;
  relfilenode: number;
  relforknumber: number;
  relblocknumber: number;
  isdirty: number;
  usagecount: number;
  pinning_backends: number;
}

export interface BufferCacheRewriteResult {
  sql: string;
  rewritten: boolean;
}

// ── Real SQLite-backed implementation ────────────────────────────

/**
 * Maximum rows to return to avoid overwhelming output for large databases.
 * Matches PostgreSQL behaviour (sampling on large shared_buffers).
 */
const MAX_BUFFER_CACHE_ROWS = 100;

/**
 * Read real SQLite cache statistics from PRAGMA and generate
 * buffer-cache-like rows.
 *
 * @param db             A better-sqlite3 Database instance (must have .pragma())
 * @param activeSessions Number of active connections (for pinning_backends estimation)
 * @returns An array of PgBufferCacheRow objects (max MAX_BUFFER_CACHE_ROWS)
 */
export function getPgBufferCacheRows(
  db: { pragma: (stmt: string, opts?: { simple: boolean }) => any },
  activeSessions: number = 0,
): PgBufferCacheRow[] {
  try {
    const pageCount = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    const cacheSize = db.pragma('cache_size', { simple: true }) as number;
  const cacheSpill = db.pragma('cache_spill', { simple: true }) as boolean;

  const rows: PgBufferCacheRow[] = [];
  const count = pageCount > 0 ? Math.min(pageCount, MAX_BUFFER_CACHE_ROWS) : 1;

    // usagecount estimation: use cache_size / page_count ratio
    // The negative cache_size is SQLite's meaning (in kibibytes); take absolute.
  const effectiveCachePages = Math.max(1, Math.abs(cacheSize) * 1024 / pageSize);
    const cacheRatio = Math.min(1, effectiveCachePages / Math.max(1, pageCount));

    for (let i = 1; i <= count; i++) {
    // Simulate usage: first pages more likely to be cached; usage decays
    // gradually from high to low based on position.
    const positionRatio = 1 - (i - 1) / count;
    const rawUsage = Math.round(cacheRatio * positionRatio * 5); // 0..5 scale
    const usagecount = Math.max(1, Math.min(5, rawUsage));

      rows.push({
      bufferid: i,
        relfilenode: 1,        // single SQLite database file
        relforknumber: 0,       // main fork
      relblocknumber: i - 1,  // 0-based block number
        isdirty: 0,
      usagecount,
        pinning_backends: Math.min(activeSessions, 5),
      });
    }

    return rows;
  } catch (err) {
    logger.warn({ err }, 'Failed to read SQLite pragma data, falling back to synthetic');
    return pgBuffercache(10);
  }
}

// ── Synthetic fallback implementation ────────────────────────────

/**
 * Generate synthetic pg_buffercache rows.
 *
 * Since SQLite has no shared buffer pool, we read the page count from
 * `pragma_page_count` (provided externally) and simulate a buffer for
 * each page.
 *
 * @param pageCount - Total number of pages in the database (from pragma).
 * @returns An array of buffer-cache row objects.
 */
export function pgBuffercache(pageCount: number = 0): PgBufferCacheRow[] {
  const count = pageCount > 0 ? Math.min(pageCount, MAX_BUFFER_CACHE_ROWS) : 100;
  const rows: PgBufferCacheRow[] = [];

  for (let i = 1; i <= count; i++) {
    rows.push({
      bufferid: i,
      relfilenode: 0,           // unknown / synthetic
      relforknumber: 0,         // main fork
      relblocknumber: i - 1,    // 0-based block number
      isdirty: 0,
      usagecount: 1,
      pinning_backends: 0,
    });
  }

  return rows;
}

// ── SQL-level detection & rewriting ─────────────────────────────

const RE_PG_BUFFERCACHE = /\bpg_buffercache\b/i;

/**
 * Detect whether a SQL string references the pg_buffercache view.
 */
export function detectPgBufferCache(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return RE_PG_BUFFERCACHE.test(sql);
}

/**
 * Rewrite a query targeting pg_buffercache into a SELECT that
 * calls our synthetic function.
 */
export function rewritePgBufferCache(sql: string, rows?: PgBufferCacheRow[]): BufferCacheRewriteResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  const cleaned = sql.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, '').replace(/\s+/g, ' ').trim();

  if (!RE_PG_BUFFERCACHE.test(cleaned)) {
    return { sql, rewritten: false };
  }

  // If rows are provided, rewrite as VALUES
  const dataRows = rows ?? pgBuffercache(100);
  if (dataRows.length > 0) {
    const valuesSql = dataRows.map(r =>
      `(${r.bufferid},${r.relfilenode},${r.relforknumber},${r.relblocknumber},${r.isdirty},${r.usagecount},${r.pinning_backends})`
    ).join(',');

    const result = sql.replace(
      /\bpg_buffercache\b/gi,
      `(SELECT * FROM (VALUES ${valuesSql}) AS pg_buffercache(bufferid,relfilenode,relforknumber,relblocknumber,isdirty,usagecount,pinning_backends))`,
    );

    logger.debug({ original: sql, rewritten: result }, 'Rewrote pg_buffercache reference');
    return { sql: result, rewritten: true };
  }

  // Fallback to old subquery approach
  const result = sql.replace(
    /\bpg_buffercache\b/gi,
    '(SELECT 1 AS bufferid, 0 AS relfilenode, 0 AS relforknumber, 0 AS relblocknumber, 0 AS isdirty, 1 AS usagecount, 0 AS pinning_backends)',
  );

  const rewritten = result !== sql;
  if (rewritten) {
    logger.debug({ original: sql, rewritten: result }, 'Rewrote pg_buffercache reference (fallback)');
  }

  return { sql: result, rewritten };
}

export { logger };
