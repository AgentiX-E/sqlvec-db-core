/**
 * parallel-index-worker.ts — Piscina worker thread for parallel index building.
 *
 * Each worker receives a task to build a sub-index table for a specific rowid
 * range. The sub-index table contains (rowid, col1, col2, ...) entries from
 * the source table within that range, plus a SQLite index on the indexed columns.
 *
 * Sub-index tables are named `__idx_{indexName}__part_{workerId}`.
 *
 * This worker is designed to be used with Piscina via ParallelIndexBuilder.
 *
 * @module index/parallel-index-worker
 */

import Database from 'better-sqlite3';

export interface IndexWorkerTask {
  /** Always 'build-sub-index' for this worker type */
  taskType: 'build-sub-index';
  /** Path to the SQLite database file */
  dbPath: string;
  /** Name of the source table being indexed */
  tableName: string;
  /** Name of the index being created */
  indexName: string;
  /** Columns to include in the index */
  columns: string[];
  /** Rowid range for this worker's segment */
  range: { min: number; max: number };
  /** Worker identifier (0-based) */
  workerId: number;
  /** Whether the index is UNIQUE */
  unique?: boolean;
  /** WHERE clause for partial indexes (without the WHERE keyword) */
  where?: string;
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
}

export interface IndexWorkerResult {
  /** Whether the worker completed successfully */
  success: boolean;
  /** Worker identifier (0-based) */
  workerId: number;
  /** Number of rows inserted into the sub-index */
  rowCount: number;
  /** Error message on failure, null on success */
  error: string | null;
  /** Wall-clock time in ms */
  timeMs: number;
}

/**
 * Main worker function — called by Piscina for each parallel index-building task.
 *
 * Opens the database in read-write mode, creates a sub-index table, populates it
 * with data from the source table within the assigned rowid range, and creates
 * a SQLite index on the indexed columns for fast lookups within this segment.
 */
export default function buildSubIndexWorker(task: IndexWorkerTask): IndexWorkerResult {
  const start = performance.now();
  const { dbPath, tableName, indexName, columns, range, workerId, unique = false, where } = task;

  let db: Database.Database | null = null;

  try {
    db = new Database(dbPath, { readonly: false });
    db.pragma('busy_timeout = 5000');
    // Use WAL mode for better concurrent access
    db.pragma('journal_mode = WAL');

    const partTableName = `__idx_${indexName}__part_${workerId}`;

    // ── Step 1: Drop existing part table if any (clean slate) ─────────
    db.exec(`DROP TABLE IF EXISTS [${partTableName}]`);

    // ── Step 2: Get column type information from source table ─────────
    const colInfo = db.pragma(`table_info([${tableName}])`) as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    // Build column type map
    const colTypeMap = new Map<string, string>();
    for (const col of colInfo) {
      colTypeMap.set(col.name, col.type);
    }

    // ── Step 3: Generate column name list with deduplication ──────────
    // Ensure rowid is always present (for the PK), while excluding any
    // explicit rowid alias (`rowid` / `_rowid_` / `oid`) from the indexed
    // columns so the generated table does not declare a duplicate column
    // (which SQLite rejects with "duplicate column name").
    const ROWID_ALIASES = new Set(['rowid', '_rowid_', 'oid']);
    const dedupColumns = Array.from(new Set(columns)).filter(
      (col) => !ROWID_ALIASES.has(col.toLowerCase()),
    );
    const subIndexColumns = ['rowid', ...dedupColumns];

    // Build the CREATE TABLE statement with proper types
    const colDefs = subIndexColumns.map((col) => {
      if (col.toLowerCase() === 'rowid' || col.toLowerCase() === '_rowid_' || col === 'oid') {
        return `[${col}] INTEGER`;
      }
      const type = colTypeMap.get(col) || 'TEXT';
      return `[${col}] ${type}`;
    });

    db.exec(
      `CREATE TABLE [${partTableName}] (\n` +
        `  ${colDefs.join(',\n  ')},\n` +
        `  PRIMARY KEY (rowid)\n` +
        `)`,
    );

    // ── Step 4: Populate the part table from the source table ─────────
    // Build the SELECT clause: rowid + indexed columns
    const selectCols = ['rowid', ...dedupColumns.map((c) => `[${c}]`)].join(', ');
    const whereClause = where ? `AND (${where})` : '';

    const insertSql = `INSERT INTO [${partTableName}] (${subIndexColumns.map((c) => `[${c}]`).join(', ')})\n` +
      `SELECT ${selectCols}\n` +
      `FROM [${tableName}]\n` +
      `WHERE rowid >= ? AND rowid <= ? ${whereClause}`;

    const insertStmt = db.prepare(insertSql);

    // Use a transaction for bulk insert performance
    const insertInTransaction = db.transaction(() => {
      const info = insertStmt.run(range.min, range.max);
      return Number(info.changes);
    });

    const rowCount = insertInTransaction();

    // ── Step 5: Create a SQLite index on the part table for fast lookups ──
    // Skip when there are no non-rowid columns (all requested columns were
    // rowid aliases), avoiding an invalid empty-column index statement.
    if (dedupColumns.length > 0) {
      const partIdxName = `__idx_${indexName}__part_${workerId}_idx`;
      const uniqueKeyword = unique ? 'UNIQUE' : '';
      const indexCols = dedupColumns.map((c) => `[${c}]`).join(', ');

      db.exec(
        `CREATE ${uniqueKeyword} INDEX IF NOT EXISTS [${partIdxName}] ON [${partTableName}] (${indexCols})`,
      );
    }

    const timeMs = performance.now() - start;

    return {
      success: true,
      workerId,
      rowCount,
      error: null,
      timeMs,
    };
  } catch (err: any) {
    const timeMs = performance.now() - start;

    return {
      success: false,
      workerId,
      rowCount: 0,
      /* c8 ignore next -- String(err) is defensive: every throwable here is an Error with a .message */
      error: err.message || String(err),
      timeMs,
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
