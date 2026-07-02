/**
 * MvccSchemaShim — Physical row version column management for MVCC.
 *
 * Injects `_xmin INTEGER DEFAULT 0` and `_xmax INTEGER DEFAULT 0` columns
 * into CREATE TABLE statements so that every user table physically stores
 * the MVCC row version metadata required for visibility filtering.
 *
 * Also provides SQL rewriting functions for the write path (Phase B) to
 * populate _xmin/_xmax on INSERT/UPDATE/DELETE, and for the read path
 * (Phase C) to inject MVCC visibility predicates into SELECT WHERE clauses.
 *
 * ## Design Principles
 *
 * - Non-MVCC tables (pre-existing, created before this feature) retain
 *   `_xmin = 0` (DEFAULT), making them always visible under the visibility
 *   rules.
 * - `CREATE TEMP TABLE` and `CREATE TABLE ... AS SELECT` are left unchanged
 *   because they don't participate in multi-version concurrency.
 * - The column injection is text-based regex, consistent with the rest of
 *   the shim layer in this codebase (MVCCShim, AlterTableShim, etc.).
 *
 * @module query/MvccSchemaShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('MvccSchemaShim');

// ── Constants ──────────────────────────────────────────────────

const COLUMN_DEF = '_xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0';

/**
 * Matches the start of a `CREATE TABLE` (non-temp) statement, capturing
 * the table name and the column definition block.
 *
 * Group 1 — Table name (optional IF NOT EXISTS, schema-qualified, etc.)
 * Group 2 — The column definitions block (everything between outer parens)
 */
const CREATE_TABLE_REGEX =
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?\w+`?\s*\.\s*)?(?:"([^"]+)"|`?(\w+)`?)\s*\(([\s\S]*)\)\s*$/i;

/**
 * Matching `CREATE TEMP TABLE` (or TEMPORARY).
 */
const CREATE_TEMP_TABLE = /^\s*CREATE\s+TEMP(?:ORARY)?\s+TABLE/i;

/**
 * Matching `CREATE TABLE ... AS SELECT`.
 */
const CREATE_TABLE_AS_SELECT = /^\s*CREATE\s+(?:TEMP|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\s*\.\s*)?\w+\s+AS\s+/i;

/**
 * Matches the beginning of a VALUES clause for INSERT rewriting.
 */
const VALUES_CLAUSE = /\bVALUES\s*\(/i;

/**
 * Matches the columns list in an INSERT with explicit column names.
 * `INSERT INTO t (c1, c2) VALUES (...)` → captures `c1, c2`
 */
const INSERT_COLUMNS = /^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:`?\w+`?\s*\.\s*)?`?(\w+)`?\s*\(([^)]+)\)\s*(VALUES|SELECT)/i;

/**
 * Matches a DELETE FROM statement to rewrite to soft-delete UPDATE.
 */
const DELETE_REGEX = /^\s*DELETE\s+FROM\s+(?:ONLY\s+)?((?:`?\w+`?\s*\.\s*)?`?\w+`?)\s*/i;

/**
 * Matches `SET column = value` in an UPDATE statement.
 */
const UPDATE_SET = /^\s*UPDATE\s+(?:ONLY\s+)?((?:`?\w+`?\s*\.\s*)?`?\w+`?)\s+SET\s+/i;

/**
 * Matches the WHERE clause (if present) in a SQL statement.
 */
const WHERE_CLAUSE = /\bWHERE\b/i;

/**
 * Matches `_xmin` or `_xmax` in column lists or SET clauses (case-insensitive).
 */
const HAS_XMIN_COL = /\b_xmin\b/i;
const HAS_XMAX_COL = /\b_xmax\b/i;
const HAS_CMIN_COL = /\b_cmin\b/i;
const HAS_CMAX_COL = /\b_cmax\b/i;

/**
 * Detect if a column definition already has _xmin, _xmax, _cmin, or _cmax.
 */
function hasRowVersionColumnsInDef(colDefs: string): boolean {
  return HAS_XMIN_COL.test(colDefs) || HAS_XMAX_COL.test(colDefs)
    || HAS_CMIN_COL.test(colDefs) || HAS_CMAX_COL.test(colDefs);
}

// ── Public API ──────────────────────────────────────────────────

export class MvccSchemaShim {
  /**
   * Inject `_xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0` columns into
   * a CREATE TABLE statement if it is a regular (non-temp, non-AS-SELECT)
   * table creation.
   *
   * @param sql - The CREATE TABLE SQL statement (possibly already rewritten).
   * @returns The SQL with row version columns injected, or the original if
   *          no injection was needed.
   *
   * @example
   * ```ts
   * const shim = new MvccSchemaShim();
   * shim.injectRowVersionColumns("CREATE TABLE users (id INT, name TEXT)");
   * // → "CREATE TABLE users (id INT, name TEXT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0)"
   *
   * shim.injectRowVersionColumns("CREATE TEMP TABLE t (id INT)");
   * // → "CREATE TEMP TABLE t (id INT)" (unchanged)
   *
   * shim.injectRowVersionColumns("CREATE TABLE t AS SELECT * FROM src");
   * // → "CREATE TABLE t AS SELECT * FROM src" (unchanged)
   * ```
   */
  injectRowVersionColumns(sql: string): string {
    const trimmed = sql.trim().replace(/;\s*$/, "");

    // Skip CREATE TEMP TABLE — temporary tables don't need MVCC
    if (CREATE_TEMP_TABLE.test(trimmed)) {
      logger.debug('Skipping row version injection for TEMP TABLE');
      return sql;
    }

    // Skip CREATE TABLE ... AS SELECT — data comes from query, not current txn
    if (CREATE_TABLE_AS_SELECT.test(trimmed)) {
      logger.debug('Skipping row version injection for CREATE TABLE AS SELECT');
      return sql;
    }

    // Match CREATE TABLE name ( col_defs )
    const match = trimmed.match(CREATE_TABLE_REGEX);
    if (!match) {
      logger.debug({ sql: trimmed.slice(0, 80) }, 'CREATE TABLE pattern not matched, skipping injection');
      return sql;
    }

    const tableName = match[1] || match[2];
    const colDefs = match[3];

    // Don't inject if already present
    if (hasRowVersionColumnsInDef(colDefs)) {
      logger.debug({ tableName }, 'Row version columns already present, skipping');
      return sql;
    }

    // Find the first table-level constraint in the column definitions.
    // SQLite requires column definitions BEFORE table constraints,
    // so we must insert the MVCC columns before any table constraint.
    const constraintRegex = /^\s*(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT|CHECK)\s/i;
    const trimmedDef = colDefs.trimEnd();
    let insertPos = -1;
    let parenCount = 0;
    for (let i = 0; i < trimmedDef.length; i++) {
      const ch = trimmedDef[i];
      if (ch === '(') {
        parenCount++;
      } else if (ch === ')') {
        parenCount--;
      }
      if (parenCount === 0 && constraintRegex.test(trimmedDef.slice(i))) {
        insertPos = i;
        break;
      }
    }

    let newDef: string;
    if (insertPos >= 0) {
      // Insert MVCC columns before the first table constraint.
      // Strip any trailing comma/whitespace from the column definitions.
      const prefix = trimmedDef.slice(0, insertPos).replace(/,\s*$/, '');
      newDef = prefix + ', ' + COLUMN_DEF + ', ' + trimmedDef.slice(insertPos).trimStart();
    } else {
      // No table constraints — append at the end
      newDef = trimmedDef + ', ' + COLUMN_DEF;
    }

    // Inject at the correct position
    const result = trimmed.replace(
      CREATE_TABLE_REGEX,
      `CREATE TABLE IF NOT EXISTS ${tableName} (${newDef})`,
    );

    logger.debug({ tableName }, 'Row version columns injected');
    return result;
  }

  /**
   * Check whether a table's CREATE TABLE definition (captured from the SQL)
   * already has row version columns. Used for testing / verification.
   *
   * @param colDefs - The column definitions portion of a CREATE TABLE.
   * @returns `true` if `_xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0` is present.
   */
  hasRowVersionColumns(colDefs: string): boolean {
    return hasRowVersionColumnsInDef(colDefs);
  }

  /**
   * Generate an ALTER TABLE statement to add row version columns to an existing
   * table. SQLite supports ADD COLUMN for simple column adds.
   *
   * @param tableName - The table to alter.
   * @returns SQL statement(s) to add _xmin and _xmax columns.
   */
  alterTableAddRowVersionColumns(tableName: string): string {
    // SQLite only allows one column per ALTER TABLE ADD COLUMN
    return [
      `ALTER TABLE ${tableName} ADD COLUMN _xmin INTEGER DEFAULT 0`,
      `ALTER TABLE ${tableName} ADD COLUMN _xmax INTEGER DEFAULT 0`,
      `ALTER TABLE ${tableName} ADD COLUMN _cmin INTEGER DEFAULT 0`,
      `ALTER TABLE ${tableName} ADD COLUMN _cmax INTEGER DEFAULT 0`,
    ].join('; ');
  }

  // ── Phase B: Write path SQL rewriting ─────────────────────────

  /**
   * Rewrite pending SQL at commit time to include physical _xmin/_xmax values.
   *
   * For each pending SQL, injects the transaction's XID into the statement
   * so that the physical row version columns are populated in SQLite.
   *
   * Supports three operation types:
   *   - INSERT: add _xmin, _xmax columns/values
   *   - UPDATE: mark old version as deleted; set _xmin on new version
   *   - DELETE: soft-delete by setting _xmax
   *
   * @param sql    - The pending SQL statement from the transaction buffer.
   * @param xid    - The current transaction's XID.
   * @returns An array of SQL statements to execute (may be 1 or 2 statements).
   */
  rewriteWriteSql(sql: string, xid: number): string[] {
    const trimmed = sql.trim();

    // Detect statement type from the start
    if (/^\s*INSERT\b/i.test(trimmed)) {
      return this._rewriteInsert(trimmed, xid);
    }
    if (/^\s*UPDATE\b/i.test(trimmed)) {
      return this._rewriteUpdate(trimmed, xid);
    }
    if (/^\s*DELETE\b/i.test(trimmed)) {
      return this._rewriteDelete(trimmed, xid);
    }

    // Pass through for DDL and other statement types
    return [trimmed];
  }

  /**
   * Rewrite an INSERT statement to include _xmin and _xmax.
   *
   * Cases:
   *   INSERT INTO t (c1, c2) VALUES (v1, v2)
   *     → INSERT INTO t (c1, c2, _xmin, _xmax) VALUES (v1, v2, <xid>, NULL)
   *
   *   INSERT INTO t VALUES (v1, v2)
   *     → INSERT INTO t VALUES (v1, v2, <xid>, NULL)
   *
   *   INSERT INTO t (c1, c2) SELECT ...
   *     → INSERT INTO t (c1, c2, _xmin, _xmax) SELECT ..., <xid>, NULL
   */
  private _rewriteInsert(sql: string, xid: number): string[] {
    // Skip if _xmin is already in the column list
    if (HAS_XMIN_COL.test(sql)) {
      return [sql];
    }

    // Case 1: INSERT with explicit column list
    // INSERT INTO t (c1, c2) VALUES/SELECT ...
    const colMatch = sql.match(INSERT_COLUMNS);
    if (colMatch) {
      const tableName = colMatch[1];
      const colList = colMatch[2];
      const keyword = colMatch[3]; // VALUES or SELECT

      // If it's VALUES, we need to add to each value tuple
      if (keyword.toUpperCase() === 'VALUES') {
        // Append columns and add _xmin, _xmax, _cmin, _cmax to each value tuple
        const result = sql.replace(
          INSERT_COLUMNS,
          `INSERT INTO ${tableName} (${colList.trimEnd()}, _xmin, _xmax, _cmin, _cmax) VALUES`,
        );
        // Add _xmin, _xmax, _cmin, _cmax to each VALUES tuple
        // Match: ) after each VALUES tuple
        // Note: use nested-parens regex to handle function calls like NOW() inside tuples
        const withXid = result.replace(/(\bVALUES\s*(?:\((?:[^()]|\([^()]*\))*\)(?:\s*,\s*\((?:[^()]|\([^()]*\))*\))*))/i, (match) => {
          return match.replace(/\(((?:[^()]|\([^()]*\))*)\)/g, (tuple, content) => {
            return `(${content.trimEnd()}, ${xid}, NULL, 0, 0)`;
          });
        });
        return [withXid];
      }

      // INSERT INTO t (c1, c2) SELECT ... → append _xmin, _xmax to both column list and SELECT
      const result = sql.replace(
        INSERT_COLUMNS,
        `INSERT INTO ${tableName} (${colList.trimEnd()}, _xmin, _xmax) ${keyword}`,
      );
      // Find the SELECT ... part and add , xid, NULL to the SELECT list
      const selectIdx = result.toUpperCase().indexOf('SELECT ');
      if (selectIdx >= 0) {
        const beforeSelect = result.substring(0, selectIdx + 7); // "SELECT "
        const selectRest = result.substring(selectIdx + 7);
        const rewritten = `${beforeSelect}${selectRest.trimStart()}, ${xid} AS _xmin, NULL AS _xmax`;
        return [rewritten];
      }
      return [result];
    }

    // Case 2: INSERT without explicit column list
    // INSERT INTO t VALUES (v1, v2), (v3, v4)
    const valMatch = sql.match(VALUES_CLAUSE);
    if (valMatch) {
      // Append , xid, NULL, 0, 0 to each value tuple
      // Note: use nested-parens regex to handle function calls like NOW() inside tuples
      const result = sql.replace(/\(((?:[^()]|\([^()]*\))*)\)/g, (tuple, content) => {
        // Only rewrite tuples that are part of VALUES clause
        return `(${content.trimEnd()}, ${xid}, NULL, 0, 0)`;
      });
      return [result];
    }

    // Default: pass through unchanged
    return [sql];
  }

  /**
   * Rewrite an UPDATE statement to:
   *   1. Mark the old version(s) as deleted (SET _xmax = <xid>)
   *   2. Update the row data, setting _xmin = <xid>
   *
   * Result: [logical_delete_SQL, update_with_xmin_SQL]
   */
  private _rewriteUpdate(sql: string, xid: number): string[] {
    const stmtMatch = sql.match(UPDATE_SET);
    if (!stmtMatch) return [sql];

    const tableName = stmtMatch[1];

    // Extract WHERE clause (everything after WHERE), strip trailing `;`
    const whereIdx = sql.toUpperCase().indexOf(' WHERE ');
    let whereClause = '';
    if (whereIdx >= 0) {
      whereClause = sql.substring(whereIdx).replace(/;\s*$/, '');
    }

    // Construct the logical delete statement: UPDATE t SET _xmax = xid WHERE ...
    // Add MVCC guard: only delete rows that aren't already deleted
    const deleteGuard = whereClause
      ? `${whereClause} AND (_xmax IS NULL OR _xmax = 0)`
      : ' WHERE (_xmax IS NULL OR _xmax = 0)';

    const logicalDelete = `UPDATE ${tableName} SET _xmax = ${xid}${deleteGuard}`;

    // Rewrite the original UPDATE to set _xmin = xid
    // Add _xmin = xid to the SET clause
    let updateSql: string;
    if (HAS_XMIN_COL.test(sql)) {
      updateSql = sql; // Already has _xmin
    } else {
      // Add `_xmin = xid, _xmax = NULL` after the first SET keyword
      // _xmax must be reset to NULL so the dead-row marker from step 1
      // doesn't persist, which would cause SELECT visibility filters
      // `(_xmax IS NULL OR _xmax = 0)` to hide the updated row.
      updateSql = sql.replace(/SET\s+/i, (match) => {
        return `${match}_xmin = ${xid}, _xmax = NULL, `;
      });
    }

    return [logicalDelete, updateSql];
  }

  /**
   * Rewrite a DELETE statement to a soft-delete UPDATE.
   *
   * DELETE FROM t WHERE cond → UPDATE t SET _xmax = <xid> WHERE cond
   */
  private _rewriteDelete(sql: string, xid: number): string[] {
    const match = sql.match(DELETE_REGEX);
    if (!match) return [sql];

    const tableName = match[1];

    // Extract WHERE clause, strip trailing `;`
    const whereIdx = sql.toUpperCase().indexOf(' WHERE ');
    let whereClause = '';
    if (whereIdx >= 0) {
      whereClause = sql.substring(whereIdx).replace(/;\s*$/, '');
    }

    const softDelete = `UPDATE ${tableName} SET _xmax = ${xid}${whereClause}`;
    return [softDelete];
  }

  // ── Phase C: Read path — MVCC visibility predicate injection ──

  /**
   * Inject MVCC visibility predicates into a SELECT WHERE clause.
   *
   * Adds conditions so that only rows visible to the current snapshot
   * are returned:
   *
   *   WHERE (_xmin <= <snapshot> OR _xmin = 0)
   *     AND (_xmax IS NULL OR _xmax > <snapshot>)
   *     AND <original_where_conditions>
   *
   * @param sql      - The SELECT SQL statement.
   * @param snapshot - The transaction's snapshot XID.
   * @returns The SELECT SQL with MVCC visibility predicates injected.
   */
  injectSelectVisibility(sql: string, snapshot: number): string {
    const trimmed = sql.trim();

    // Don't inject if _xmin predicates are already present
    if (HAS_XMIN_COL.test(trimmed) && /\b_xmin\s*[<>=]/.test(trimmed)) {
      return trimmed;
    }

    const mvccPredicate = (snapshot === 0)
      // Auto-commit: show all committed rows, hide soft-deleted (_xmax > 0)
      ? `(_xmax IS NULL OR _xmax = 0)`
      // Transaction (READ COMMITTED / REPEATABLE READ):
      // - Row visible if _xmin = 0 (auto-commit) or _xmin <= snapshot (committed)
      // - Row NOT visible if _xmax > 0 AND _xmax <= snapshot (soft-deleted at/before snapshot)
      : `(_xmin = 0 OR _xmin <= ${snapshot}) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > ${snapshot})`;

    // Find the FROM clause and inject into WHERE
    const fromIdx = trimmed.toUpperCase().indexOf(' FROM ');
    if (fromIdx < 0) {
      return trimmed; // No FROM → can't inject (not a table query)
    }

    const fromRest = trimmed.substring(fromIdx);
    const whereIdx = fromRest.toUpperCase().indexOf(' WHERE ');

    if (whereIdx >= 0) {
      // Has WHERE — inject before existing conditions
      const beforeWhere = trimmed.substring(0, fromIdx + whereIdx + 7); // up to and including " WHERE "
      const afterWhere = trimmed.substring(fromIdx + whereIdx + 7);
      return `${beforeWhere}${mvccPredicate} AND ${afterWhere}`;
    }

    // No WHERE clause — add one
    // Don't inject into subqueries or CTEs (just simple SELECT)
    const hasGroupBy = /\bGROUP\s+BY\b/i.test(trimmed);
    const hasHaving = /\bHAVING\b/i.test(trimmed);

    // Inject after FROM clause but before ORDER BY / LIMIT / GROUP BY / HAVING
    const insertPatterns = [
      /\bORDER\s+BY\b/i,
      /\bLIMIT\b/i,
      /\bGROUP\s+BY\b/i,
      /\bHAVING\b/i,
    ];
    let insertPos = -1;
    let insertKeyword = '';
    for (const pattern of insertPatterns) {
      const match = trimmed.match(pattern);
      if (match && match.index && match.index > fromIdx) {
        if (insertPos === -1 || match.index < insertPos) {
          insertPos = match.index;
          insertKeyword = match[0];
        }
      }
    }

    if (insertPos >= 0) {
      return `${trimmed.substring(0, insertPos)} WHERE ${mvccPredicate} ${trimmed.substring(insertPos)}`;
    }

    // No trailing clause — append WHERE at the end
    return `${trimmed} WHERE ${mvccPredicate}`;
  }
}
