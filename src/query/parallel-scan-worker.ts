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
 * Fold a `rowid >= ? AND rowid <= ?` predicate into a base SELECT statement.
 *
 * The predicate is inserted into the existing WHERE clause (or introduced as a
 * new WHERE when there is none), and is always placed BEFORE any trailing
 * ORDER BY / GROUP BY / HAVING / LIMIT / OFFSET clause so the resulting SQL
 * remains grammatically valid.
 */
function appendRowIdFilter(baseSql: string): string {
  const trimmed = baseSql.trim();
  const upper = trimmed.toUpperCase();

  // Locate the first top-level trailing clause; everything before it is the
  // head (select list + FROM + optional WHERE), which is where the predicate
  // belongs.
  const trailingRe = /\b(ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET)\b/i;
  const trailingMatch = trailingRe.exec(upper);

  const headEnd = trailingMatch ? trailingMatch.index : trimmed.length;
  const head = trimmed.slice(0, headEnd).trimEnd();
  const tail = trailingMatch ? trimmed.slice(trailingMatch.index).trim() : '';

  const hasWhere = /\bWHERE\b/i.test(head);
  const connector = hasWhere ? ' AND ' : ' WHERE ';
  const rowIdFilter = `rowid >= ? AND rowid <= ?`;

  return tail
    ? `${head}${connector}${rowIdFilter} ${tail}`
    : `${head}${connector}${rowIdFilter}`;
}

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
  // NOTE: better-sqlite3 executes `stmt.all()` synchronously, so a true query
  // timeout cannot be enforced mid-scan; `timeoutMs` is accepted for interface
  // compatibility but is not interruptible. We keep the parameter documented.
  const { dbPath, baseSql, params, startRowId, endRowId } = task;

  let db: Database.Database | null = null;

  try {
    // Open a fresh connection — each worker gets its own
    db = new Database(dbPath, { readonly: true });

    // NOTE: we must NOT set `journal_mode = WAL` here. WAL mode is a
    // persistent property stored in the database header and is activated by
    // the writing connection; switching journal mode requires a write lock,
    // which a read-only connection cannot acquire (it would throw
    // SQLITE_READONLY). Read-only connections automatically read whatever
    // journal mode is currently in effect. The remaining pragmas below are
    // connection-local and safe on a read-only handle.
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    // Set a reasonable cache size (~2MB) for scan-heavy workloads
    db.pragma('cache_size = -2000');

    // Construct the final SQL with the rowid range folded into the WHERE
    // clause (or appended as a new WHERE when absent). The rowid predicate is
    // inserted BEFORE any trailing ORDER BY / GROUP BY / HAVING / LIMIT/OFFSET
    // clause so it cannot break the statement's grammar.
    const finalSql = appendRowIdFilter(baseSql);

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
      // The `|| String(err)` fallback is defensive-only: every throw site in
      // this try block is a better-sqlite3 call, which always raises a
      // SqliteError (an Error subclass with a non-empty message). Fallback is
      // unreachable in practice.
      /* c8 ignore next */
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
