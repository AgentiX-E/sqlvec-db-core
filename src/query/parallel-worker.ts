/**
 * parallel-worker.ts — Worker thread for parallel query execution
 *
 * This file runs inside a Piscina worker_thread and executes a single SQL
 * query against a local better-sqlite3 database shard.
 *
 * Each worker receives a task with:
 *   - sql: the SQL query string to execute
 *   - shardId: the shard to query
 *   - dbPath: path to the SQLite database file for this shard
 *   - timeoutMs: maximum execution time (default 30000)
 *   - taskType: 'select' | 'insert' | 'update' | 'delete' | 'merge'
 *
 * For SELECT tasks, databases are opened in read-only mode.
 * For DML tasks (insert/update/delete/merge), databases are opened in
 * read-write mode and the .run() method is used instead of .all().
 *
 * Returns:
 *   - rows: array of result rows (empty for DML without RETURNING)
 *   - rowCount: number of rows returned
 *   - shardId: the shard that was queried
 *   - error: error message if the query failed (null on success)
 *   - changes: number of rows affected (DML only)
 *   - lastInsertRowid: last inserted row ID (INSERT only)
 *
 * Error isolation: if a worker throws, Piscina rejects the task for that
 * worker only. Other workers continue unaffected.
 *
 * @module query/parallel-worker
 */

import Database from 'better-sqlite3';

interface WorkerTask {
  sql: string;
  shardId: number;
  dbPath: string;
  timeoutMs?: number;
  taskType?: 'select' | 'insert' | 'update' | 'delete' | 'merge';
  /** Intra-table parallel scan mode: splits a single table into rowid ranges */
  scanMode?: 'intra-table';
  /** Rowid range for intra-table scan segment (used with scanMode='intra-table') */
  rowidRange?: { min: number; max: number };
  /** Table name for intra-table scan (used with scanMode='intra-table') */
  tableName?: string;
}

interface WorkerResult {
  rows: any[];
  rowCount: number;
  shardId: number;
  queryTimeMs: number;
  error: string | null;
  changes?: number;
  lastInsertRowid?: number;
}

/**
 * Determine the effective task type from the SQL string.
 * If taskType is explicitly provided, use it. Otherwise, infer from SQL.
 */
function inferTaskType(sql: string): 'select' | 'insert' | 'update' | 'delete' | 'merge' {
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) return 'select';
  if (trimmed.startsWith('INSERT')) return 'insert';
  if (trimmed.startsWith('UPDATE')) return 'update';
  if (trimmed.startsWith('DELETE')) return 'delete';
  if (trimmed.startsWith('MERGE')) return 'merge';
  // Default to select for safety (read-only)
  return 'select';
}

/**
 * Main worker function — called by Piscina for each parallel task.
 */
export default function executeInWorker(task: WorkerTask): WorkerResult {
  const start = performance.now();
  const { sql, shardId, dbPath, timeoutMs = 30000 } = task;

  // Handle intra-table parallel scan: construct SQL from table name and rowid range
  let effectiveSql = sql;
  if (task.scanMode === 'intra-table') {
    const tableName = task.tableName ?? '';
    const range = task.rowidRange;
    if (!tableName) {
      return {
        rows: [],
        rowCount: 0,
        shardId,
        queryTimeMs: performance.now() - start,
        error: 'Intra-table scan requires tableName',
      };
    }
    if (!range || range.min === undefined || range.max === undefined) {
      return {
        rows: [],
        rowCount: 0,
        shardId,
        queryTimeMs: performance.now() - start,
        error: 'Intra-table scan requires valid rowidRange',
      };
    }
    // Construct rowid range scan query — maintain order within the segment
    effectiveSql = `SELECT * FROM [${tableName}] WHERE rowid >= ? AND rowid <= ? ORDER BY rowid`;
  }

  const taskType = task.taskType ?? inferTaskType(effectiveSql);

  let db: Database.Database | null = null;

  try {
    const isDml = taskType === 'insert' || taskType === 'update' || taskType === 'delete' || taskType === 'merge';

    // Open the database: read-only for SELECT, read-write for DML
    db = new Database(dbPath, { readonly: !isDml });

    // Set busy timeout
    db.pragma('busy_timeout = 5000');

    if (isDml) {
      // DML execution: use .run() to capture changes/lastInsertRowid
      const stmt = db.prepare(effectiveSql);
      let info: Database.RunResult;

      // For intra-table scans, bind rowid range parameters
      if (task.scanMode === 'intra-table' && task.rowidRange) {
        info = stmt.run(task.rowidRange.min, task.rowidRange.max);
      } else {
        info = stmt.run();
      }

      // For INSERT ... RETURNING or UPDATE/DELETE with RETURNING,
      // also fetch the returned rows
      let rows: any[] = [];
      if (/\bRETURNING\b/i.test(sql)) {
        try {
          rows = stmt.all() as any[];
        } catch {
          // RETURNING might not work with .run() in all SQLite versions
          // Fall back: just return empty rows
        }
      }

      const queryTimeMs = performance.now() - start;

      const result: WorkerResult = {
        rows,
        rowCount: rows.length,
        shardId,
        queryTimeMs,
        error: null,
        changes: Number(info.changes),
      };

      if (taskType === 'insert') {
        result.lastInsertRowid = Number(info.lastInsertRowid);
      }

      return result;
    } else {
      // SELECT execution (existing behavior)
      const stmt = db.prepare(effectiveSql);

      let rows: any[];
      // For intra-table scans, bind rowid range parameters
      if (task.scanMode === 'intra-table' && task.rowidRange) {
        rows = stmt.all(task.rowidRange.min, task.rowidRange.max) as any[];
      } else {
        rows = stmt.all() as any[];
      }

      const queryTimeMs = performance.now() - start;

      return {
        rows,
        rowCount: rows.length,
        shardId,
        queryTimeMs,
        error: null,
      };
    }
  } catch (err: any) {
    const queryTimeMs = performance.now() - start;

    return {
      rows: [],
      rowCount: 0,
      shardId,
      queryTimeMs,
      error: err.message || String(err),
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Non-fatal: close best-effort
      }
    }
  }
}
