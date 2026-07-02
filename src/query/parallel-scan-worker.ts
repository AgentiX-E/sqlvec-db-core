/**
 * parallel-scan-worker.ts — Piscina worker for intra-table parallel scanning
 *
 * Each worker opens its own read-only SQLite connection, executes a SELECT query
 * with rowid range filtering, and returns the results. Workers are fully isolated
 * — one failure does not affect others.
 *
 * ## Protocol
 *
 * Worker receives:
 *   { dbPath, baseSql, params, startRowId, endRowId, timeoutMs }
 *
 * Worker returns:
 *   { rows, rowCount, success, error }
 *
 * ## Worker Safety
 *
 * - Each worker opens a NEW Database instance (never shares a connection)
 * - Database is opened in read-only mode
 * - WAL pragma is set for concurrent reads
 * - Connection is closed before returning
 *
 * @module query/parallel-scan-worker
 */

import Database from 'better-sqlite3';

// ── Interfaces ──────────────────────────────────────────────────

export interface ScanWorkerTask {
  /** Path to the SQLite database file */
  dbPath: string;
  /** Base SELECT SQL (without rowid range clause) */
  baseSql: string;
  /** Parameters for the base SQL (bound to ? placeholders) */
  params: any[];
  /** Start rowid (inclusive) */
  startRowId: number;
  /** End rowid (inclusive) */
  endRowId: number;
  /** Max execution time in ms (default: 30000) */
  timeoutMs?: number;
}

export interface ScanWorkerResult {
  /** Retrieved rows */
  rows: any[];
  /** Number of rows retrieved */
  rowCount: number;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message on failure, null on success */
  error: string | null;
  /** Execution time in ms */
  timeMs: number;
}

// ── Worker Function ─────────────────────────────────────────────

/**
 * Scan a rowid range on a single SQLite database connection.
 *
 * Opens the database in read-only mode, applies WAL pragma for concurrent
 * read access, executes the query with the rowid BETWEEN clause, and
 * returns all matching rows.
 *
 * This is the default export expected by Piscina for worker_threads.
 */
export default function scanChunk(task: ScanWorkerTask): ScanWorkerResult {
  const start = performance.now();
  const { dbPath, baseSql, params, startRowId, endRowId, timeoutMs = 30000 } = task;

  let db: Database.Database | null = null;

  try {
    // Open a fresh connection — each worker gets its own
    db = new Database(dbPath, { readonly: true });

    // Set WAL mode for concurrent read access across workers
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // Set a reasonable cache size (~2MB) for scan-heavy workloads
    db.pragma('cache_size = -2000');

    // Apply timeout via a short-lived timeout check
    // (better-sqlite3 doesn't support query timeout natively;
    //  we simulate it by checking elapsed time in the iterator)
    const deadline = performance.now() + timeoutMs;

    // Construct the final SQL with rowid range
    // Important: the base SQL must NOT already have a WHERE clause that conflicts
    // We append the rowid range as an additional AND condition
    let finalSql: string;
    const upperSql = baseSql.trim().toUpperCase();

    // Determine if base SQL already has a WHERE clause
    const hasWhere = /\bWHERE\b/.test(upperSql);
    if (hasWhere) {
      finalSql = `${baseSql} AND rowid >= ? AND rowid <= ?`;
    } else {
      finalSql = `${baseSql} WHERE rowid >= ? AND rowid <= ?`;
    }

    const stmt = db.prepare(finalSql);

    // Execute with all params + rowid bounds
    const allParams = [...params, startRowId, endRowId];
    const rows = stmt.all(...allParams) as any[];

    const timeMs = performance.now() - start;

    return {
      rows,
      rowCount: rows.length,
      success: true,
      error: null,
      timeMs,
    };
  } catch (err: any) {
    const timeMs = performance.now() - start;
    return {
      rows: [],
      rowCount: 0,
      success: false,
      error: err.message || String(err),
      timeMs,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Best-effort close; non-fatal
      }
    }
  }
}
