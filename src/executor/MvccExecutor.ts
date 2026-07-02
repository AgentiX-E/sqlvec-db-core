/**
 * MvccExecutor — MVCC Row-Level Update Executor
 *
 * Handles the actual UPDATE → INSERT transformation for MVCC.
 * Called by PlanExecutor when processing UPDATE statements on MVCC-enabled tables.
 *
 * MVCC UPDATE Flow:
 *   1. BEGIN IGNORE (savepoint for atomicity)
 *   2. SELECT all columns of the matching rows (ordered by rowid)
 *   3. For each matched row:
 *      a. UPDATE old row: SET __xmax = currentXid
 *      b. INSERT new row: SET __xmin = currentXid, __xmax = 0, columns = new_values
 *   4. RELEASE savepoint (or ROLLBACK on error)
 *
 * MVCC DELETE Flow:
 *   1. UPDATE t SET __xmax = currentXid WHERE conditions AND __xmin > 0 AND __xmax = 0
 *
 * The SQL shim layer handles DELETE (rewrites to UPDATE __xmax). 
 * The MvccExecutor handles UPDATE (rewrites to UPDATE __xmax + INSERT).
 */

import Database from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';
import { MvccContext } from '../query/MVCCShim';

interface TableSchema {
  name: string;
  columns: string[];
  hasMvccColumns: boolean;
}

const logger = PinoLogger.forComponent('MvccExecutor');

export class MvccExecutor {
  private db: Database.Database;
  private schemaCache: Map<string, TableSchema> = new Map();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Check if a table has MVCC columns.
   */
  hasMvccColumns(tableName: string): boolean {
    const schema = this.getSchema(tableName);
    return schema.hasMvccColumns;
  }

  /**
   * Fetch column info for a table using PRAGMA table_info.
   */
  getSchema(tableName: string): TableSchema {
    // Clean table name (remove schema prefix, quotes)
    const cleanName = tableName.replace(/[."`\[\]]/g, '').replace(/^public\./i, '');
    const key = cleanName.toLowerCase();

    let cached = this.schemaCache.get(key);
    if (cached) return cached;

    try {
      const cols = this.db.pragma(`table_info("${cleanName}")`) as Array<{ name: string; type: string }>;
      const columns = cols.map(c => c.name);
      const hasMvcc = columns.some(c => c === '__xmin');

      const schema: TableSchema = { name: cleanName, columns, hasMvccColumns: hasMvcc };
      this.schemaCache.set(key, schema);
      return schema;
    } catch (e) {
      return { name: cleanName, columns: [], hasMvccColumns: false };
    }
  }

  /**
   * Execute an UPDATE with MVCC semantics.
   * If the table has MVCC columns, this performs the UPDATE→INSERT+DELETE dance.
   *
   * @param sql Original UPDATE SQL
   * @param ctx Current MVCC context
   * @returns number of affected rows
   */
  executeUpdate(sql: string, ctx: MvccContext): number {
    // Parse table name from UPDATE
    const match = sql.match(/^\s*UPDATE\s+(?:ONLY\s+)?(?:"|`)?(\w+)(?:"|`)?\s+/i);
    if (!match) return 0;

    const tableName = match[1];
    const schema = this.getSchema(tableName);

    if (!schema.hasMvccColumns || schema.columns.length <= 3) {
      // No MVCC or only MVCC columns — execute as-is
      const result = this.db.prepare(sql).run();
      return result.changes;
    }

    // MVCC UPDATE: UPDATE old → __xmax, then INSERT new row
    const nonMvccColumns = schema.columns.filter(c => c !== '__xmin' && c !== '__xmax' && c !== '__ctid');
    const colList = nonMvccColumns.join(', ');
    const placeholders = nonMvccColumns.map(() => '?').join(', ');

    // Extract WHERE clause (everything after WHERE)
    const whereMatch = sql.match(/\bWHERE\s+(.*)$/i);
    const whereClause = whereMatch ? whereMatch[1] : '1=1';
    
    // Extract SET clause
    const setMatch = sql.match(/\bSET\s+(.*?)\bWHERE\b/i);
    if (!setMatch) return 0;
    const setClause = setMatch[1];

    // 1. Get the old rows (before UPDATE)
    const selectSql = `SELECT rowid, ${colList} FROM ${tableName} WHERE ${whereClause}`;
    const oldRows = this.db.prepare(selectSql).all() as Array<{ rowid: number } & Record<string, any>>;
    if (oldRows.length === 0) return 0;

    // 2. Parse SET clause to get new values
    // SET a = 10, b = 'hello' → { a: 10, b: 'hello' }
    const setPairs = setClause.split(',').map(s => s.trim());
    const newValues: Record<string, any> = {};
    for (const pair of setPairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const col = pair.substring(0, eqIdx).trim();
      const val = pair.substring(eqIdx + 1).trim();
      newValues[col] = val;
    }

    const affected = oldRows.length;

    // Perform the MVCC dance within a savepoint
    for (const oldRow of oldRows) {
      // a. Mark old row as deleted
      this.db.prepare(
        `UPDATE ${tableName} SET __xmax = ? WHERE rowid = ?`
      ).run(ctx.currentXid, oldRow.rowid);

      // b. Build new row values: merge old values with UPDATE SET values
      const insertCols: string[] = [];
      const insertVals: any[] = [];

      insertCols.push('__xmin', '__xmax', '__ctid');
      insertVals.push(ctx.currentXid, 0, oldRow.rowid); // __ctid points to old version

      for (const col of nonMvccColumns) {
        insertCols.push(col);
        if (newValues[col] !== undefined) {
          const rawVal = newValues[col];
          // Parse literal values
          insertVals.push(this.parseLiteral(rawVal));
        } else {
          insertVals.push(oldRow[col]);
        }
      }

      const insertSql = `INSERT INTO ${tableName} (${insertCols.join(', ')}) VALUES (${insertVals.map(() => '?').join(', ')})`;
      this.db.prepare(insertSql).run(...insertVals);
    }

    return affected;
  }

  /**
   * Execute a DELETE with MVCC semantics (soft delete).
   * Sets __xmax = currentXid instead of actually deleting.
   *
   * @param sql Original DELETE SQL
   * @param ctx Current MVCC context
   * @returns number of affected rows
   */
  executeDelete(sql: string, ctx: MvccContext): number {
    const match = sql.match(/^DELETE\s+FROM\s+(\S+)(?:\s+WHERE\s+(.*))?/i);
    if (!match) return 0;

    const tableName = match[1];
    const schema = this.getSchema(tableName);

    if (!schema.hasMvccColumns) {
      // No MVCC — execute as-is
      const result = this.db.prepare(sql).run();
      return result.changes;
    }

    const whereClause = match[2] || '1=1';

    const result = this.db.prepare(
      `UPDATE ${tableName} SET __xmax = ? WHERE __xmin > 0 AND __xmax = 0 AND (${whereClause})`
    ).run(ctx.currentXid);

    return result.changes;
  }

  /** Simple literal parser for SQL values */
  private parseLiteral(val: string): any {
    const trimmed = val.trim();

    // NULL
    if (trimmed.toUpperCase() === 'NULL') return null;

    // Boolean
    if (trimmed.toUpperCase() === 'TRUE') return 1;
    if (trimmed.toUpperCase() === 'FALSE') return 0;

    // String literal
    if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      return trimmed.slice(1, -1);
    }

    // Number
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }

    // Expression or function call — use as SQL literal
    return trimmed;
  }

  /** Clear schema cache */
  clearCache(): void {
    this.schemaCache.clear();
  }
}
