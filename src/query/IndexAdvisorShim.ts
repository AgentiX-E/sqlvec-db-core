/**
 * IndexAdvisorShim — PostgreSQL index advisor extension compatibility shim for SQLite.
 *
 * PostgreSQL supports several index advisor / index-tuning extensions (e.g.
 * pg_hint_plan, HypoPG, auto_explain) that generate SQL with PG-specific
 * syntax. SQLite does not support these extensions.
 *
 * ## Strategy
 *
 * Detect PostgreSQL-specific index advisor syntax patterns inside CREATE
 * INDEX statements and rewrite them to SQLite-compatible forms:
 *
 *   - `INCLUDE (col1, col2)` — stripped (INCLUDE columns in a covering
 *     index are a PG feature; SQLite does not support them).
 *   - `NULLS DISTINCT` / `NULLS NOT DISTINCT` — stripped (PG 15+ feature
 *     controlling NULL treatment in unique indexes).
 *   - `WITH (storage_parameter = value)` — stripped (PG index storage
 *     parameters such as fillfactor).
 *
 * These transformations are scoped to `CREATE INDEX` statements only, to
 * avoid false positives when these patterns appear in other contexts.
 *
 * | Input SQL (all wrapped in CREATE INDEX)                               | Output SQL                                            | rewritten |
 * |------------------------------------------------------------------------|-------------------------------------------------------|-----------|
 * | `CREATE INDEX i ON t (a) INCLUDE (b)`                                  | `CREATE INDEX i ON t (a)`                             | true      |
 * | `CREATE UNIQUE INDEX i ON t (a) NULLS NOT DISTINCT`                    | `CREATE UNIQUE INDEX i ON t (a)`                      | true      |
 * | `CREATE UNIQUE INDEX i ON t (a) NULLS DISTINCT`                        | `CREATE UNIQUE INDEX i ON t (a)`                      | true      |
 * | `CREATE INDEX i ON t (a) WITH (fillfactor = 70)`                       | `CREATE INDEX i ON t (a)`                             | true      |
 * | `CREATE INDEX i ON t (a) INCLUDE (b) WITH (fillfactor = 90)`           | `CREATE INDEX i ON t (a)`                             | true      |
 * | `CREATE INDEX i ON t (a)`                                              | `CREATE INDEX i ON t (a)`                             | false     |
 * | `SELECT * FROM t WHERE a = 1`                                          | `SELECT * FROM t WHERE a = 1`                         | false     |
 * | `INSERT INTO t (a) VALUES (1) INCLUDE (extra)`                         | `INSERT INTO t (a) VALUES (1) INCLUDE (extra)`        | false     |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite DDL
 * - No false positives on non-CREATE-INDEX statements
 * - Patterns are only stripped inside a CREATE INDEX context
 * - Original keyword casing is preserved for non-removed tokens
 * - Handles optional whitespace between keyword and parentheses
 * - Handles multiple pattern occurrences (INCLUDE + WITH together)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module IndexAdvisorShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { parse } from 'pgsql-ast-parser';
import type Database from 'better-sqlite3';

const logger = PinoLogger.forComponent('IndexAdvisorShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface IndexAdvisorResult {
  /** Rewritten SQL (PG-specific patterns stripped if found, original otherwise) */
  sql: string;
  /** Whether any PG-specific index advisor syntax was detected and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Detection regex: matches a CREATE INDEX statement (optionally preceded
 * by UNIQUE) across its full span. Used to scope rewrite rules to CREATE
 * INDEX context only, preventing false positives in other SQL statements.
 *
 * Matches:
 *   - `CREATE INDEX ...`
 *   - `CREATE UNIQUE INDEX ...`
 *   - `CREATE INDEX IF NOT EXISTS ...`
 *
 * The `[\s\S]*?` between keywords allows for newlines and arbitrary content
 * within the statement. The DOTALL flag is not available in standard RegExp,
 * so `[\s\S]` is used as a cross-engine workaround.
 *
 * Does NOT match:
 *   - `SELECT INCLUDE(...)`
 *   - `ALTER TABLE t INCLUDE(...)`
 *   - Plain SQL without CREATE INDEX context
 */
// eslint-disable-next-line require-unicode-regexp
const CREATE_INDEX_STMT_RE = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*/i;

/**
 * Matches the PostgreSQL `INCLUDE (column_list)` clause on a CREATE INDEX
 * statement.
 *
 * PostgreSQL covering indexes use:
 *   `CREATE INDEX i ON t (a) INCLUDE (b, c)`
 *
 * Group context: the entire match (including the INCLUDE keyword and its
 * parenthesised column list) is replaced with an empty string.
 *
 * Does NOT match:
 *   - `INCLUDE` used as an identifier outside a CREATE INDEX context
 *     (handled by scoping to CREATE_INDEX_STMT_RE checks)
 *   - Mismatched parentheses (simple `[^)]*` ensures a balanced closing paren)
 */
// eslint-disable-next-line require-unicode-regexp
const INCLUDE_CLAUSE_RE = /\bINCLUDE\s*\([^)]*\)/gi;

/**
 * Matches the PostgreSQL `NULLS DISTINCT` / `NULLS NOT DISTINCT` clause.
 *
 * PG 15+ allows controlling whether NULL values are treated as distinct
 * in a UNIQUE index:
 *   `CREATE UNIQUE INDEX i ON t (a) NULLS NOT DISTINCT`
 *   `CREATE UNIQUE INDEX i ON t (a) NULLS DISTINCT`
 *
 * SQLite treats all NULLs as distinct by default in UNIQUE constraints
 * (i.e., multiple NULLs are allowed), so neither variant is needed.
 */
// eslint-disable-next-line require-unicode-regexp
const NULLS_DISTINCT_CLAUSE_RE = /\bNULLS\s+(?:NOT\s+)?DISTINCT\b/gi;

/**
 * Matches the PostgreSQL `WITH (storage_parameter = value, ...)` clause
 * after a CREATE INDEX statement.
 *
 * PG index storage parameters include:
 *   - `fillfactor` (space utilization)
 *   - `vacuum_cleanup_index_scale_factor`
 *   - `deduplicate_items` (B-tree)
 *
 * Example:
 *   `CREATE INDEX i ON t (a) WITH (fillfactor = 70)`
 */
// eslint-disable-next-line require-unicode-regexp
const WITH_CLAUSE_RE = /\bWITH\s*\([^)]*\)/gi;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a CREATE INDEX statement
 * that may use PostgreSQL-specific index advisor syntax.
 *
 * This performs a case-insensitive scan for `CREATE INDEX` or
 * `CREATE UNIQUE INDEX` at the statement level.
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if the SQL starts or contains a CREATE INDEX statement.
 *
 * @example
 * ```ts
 * detectIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE (b)');              // true
 * detectIndexAdvisor('CREATE UNIQUE INDEX i ON t (a) NULLS DISTINCT');    // true
 * detectIndexAdvisor('CREATE INDEX i ON t (a)');                          // true
 * detectIndexAdvisor('SELECT 1');                                          // false
 * detectIndexAdvisor('');                                                  // false
 * ```
 */
export function detectIndexAdvisor(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return CREATE_INDEX_STMT_RE.test(sql);
}

/**
 * Rewrite PostgreSQL-specific index advisor syntax in the given SQL to
 * SQLite-compatible DDL.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. If the SQL does **not** contain a `CREATE INDEX` statement, return
 *    unchanged with `rewritten: false`.
 * 3. Sequentially strip the following PG-specific patterns from within
 *    the CREATE INDEX statement:
 *
 *    a. `INCLUDE (col1, col2, ...)` — strip the entire INCLUDE clause
 *       (covering indexes are not supported by SQLite).
 *    b. `NULLS DISTINCT` / `NULLS NOT DISTINCT` — strip the NULLS clause
 *       (SQLite uses default NULL distinct behaviour).
 *    c. `WITH (storage_parameter = value, ...)` — strip the WITH clause
 *       (SQLite does not support index storage parameters).
 *
 * 4. Clean up any resulting double spaces or trailing whitespace.
 * 5. If any transformation was applied, return the rewritten SQL with
 *    `rewritten: true`. Otherwise, return the original with `false`.
 *
 * @param sql - The raw SQL string to process.
 * @returns An {@link IndexAdvisorResult} indicating the handling outcome.
 *
 * @example
 * ```ts
 * rewriteIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE (b)');
 * // → { sql: 'CREATE INDEX i ON t (a)', rewritten: true }
 *
 * rewriteIndexAdvisor('CREATE UNIQUE INDEX i ON t (a) NULLS NOT DISTINCT');
 * // → { sql: 'CREATE UNIQUE INDEX i ON t (a)', rewritten: true }
 *
 * rewriteIndexAdvisor('CREATE INDEX i ON t (a) WITH (fillfactor = 70)');
 * // → { sql: 'CREATE INDEX i ON t (a)', rewritten: true }
 *
 * rewriteIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE (b) WITH (fillfactor = 90)');
 * // → { sql: 'CREATE INDEX i ON t (a)', rewritten: true }
 *
 * rewriteIndexAdvisor('CREATE INDEX i ON t (a)');
 * // → { sql: 'CREATE INDEX i ON t (a)', rewritten: false }
 *
 * rewriteIndexAdvisor('SELECT 1');
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteIndexAdvisor(sql: string): IndexAdvisorResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Does this statement contain a CREATE INDEX? ──────────

  if (!detectIndexAdvisor(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  let rewritten = trimmed;
  let didRewrite = false;

  // ── Step 2a: Strip INCLUDE (col1, col2, ...) ───────────────────

  const afterInclude = rewritten.replace(INCLUDE_CLAUSE_RE, (match) => {
    logger.debug(
      { original: match },
      'Stripping INCLUDE clause — SQLite does not support covering indexes',
    );
    return '';
  });

  if (afterInclude !== rewritten) {
    didRewrite = true;
    rewritten = afterInclude;
  }

  // ── Step 2b: Strip NULLS DISTINCT / NULLS NOT DISTINCT ──────────

  const afterNulls = rewritten.replace(NULLS_DISTINCT_CLAUSE_RE, (match) => {
    logger.debug(
      { original: match },
      'Stripping NULLS DISTINCT clause — SQLite uses default NULL distinct behaviour',
    );
    return '';
  });

  if (afterNulls !== rewritten) {
    didRewrite = true;
    rewritten = afterNulls;
  }

  // ── Step 2c: Strip WITH (storage_parameter = value, ...) ───────

  const afterWith = rewritten.replace(WITH_CLAUSE_RE, (match) => {
    logger.debug(
      { original: match },
      'Stripping WITH clause — SQLite does not support index storage parameters',
    );
    return '';
  });

  if (afterWith !== rewritten) {
    didRewrite = true;
    rewritten = afterWith;
  }

  // ── Step 3: Clean up whitespace artifacts ──────────────────────

  if (didRewrite) {
    // Collapse multiple consecutive spaces into one
    rewritten = rewritten.replace(/  +/g, ' ').trim();

    // Remove spaces before closing paren (e.g., "(a )" → "(a)")
    rewritten = rewritten.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

    // Remove trailing semicolon whitespace gaps
    rewritten = rewritten.replace(/\s+;/g, ';').trim();
  }

  // ── Step 4: Did anything change? ────────────────────────────────

  if (!didRewrite) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  logger.debug(
    { original: trimmed, rewritten },
    'Index advisor PG-specific syntax rewritten successfully',
  );

  return {
    sql: rewritten,
    rewritten: true,
  };
}

// ── G23: IndexAdvisorShim ────────────────────────────────────────

export interface IndexSchema {
  tables: string[];
  columns: string[];
  existingIndexes: string[];
}

export class IndexAdvisorShim {
  /**
   * Analyze a SQL query and recommend indexes based on the schema.
   * Extracts WHERE/JOIN/ORDER BY columns and compares with existing indexes.
   *
   * @param sql    - The SQL query to analyze
   * @param schema - Schema information (tables, columns, existingIndexes)
   * @returns Array of CREATE INDEX statement recommendations
   */
  analyze(sql: string, schema: IndexSchema): string[] {
    const recommendations: string[] = [];

    // Extract column references from WHERE clause
    const whereColumns = this.extractWhereColumns(sql);
    // Extract columns from JOIN clauses
    const joinColumns = this.extractJoinColumns(sql);
    // Extract columns from ORDER BY
    const orderColumns = this.extractOrderColumns(sql);

    // Merge all referenced columns
    const referencedColumns = [...new Set([...whereColumns, ...joinColumns, ...orderColumns])];

    // For each referenced column, check if an index exists
    for (const col of referencedColumns) {
      const needsIndex = !schema.existingIndexes.some(
        (idx) => idx.toLowerCase().includes(col.toLowerCase()),
      );

      if (needsIndex && schema.columns.includes(col)) {
        // Determine the best table for this column
        const table = this.inferTable(sql, col) || 'table';
        const idxName = `idx_${table}_${col}`;

        // Check if we already recommended this
        const statement = `CREATE INDEX IF NOT EXISTS ${idxName} ON ${table} (${col})`;
        // `referencedColumns` is built from a deduplicated Set and `idxName`
        // embeds the unique table+column pair, so this statement can never be
        // present twice within a single analyze() call. The false side of the
        // `includes` guard is therefore unreachable.
        /* c8 ignore next */
        if (!recommendations.includes(statement)) {
          recommendations.push(statement);
        }
      }
    }

    // Check for composite index opportunities (multiple WHERE conditions)
    if (whereColumns.length >= 2) {
      const table = this.inferTable(sql, whereColumns[0]) || 'table';
      const compositeName = `idx_${table}_${whereColumns.join('_')}`;
      const compositeCols = whereColumns.join(', ');
      const compositeStmt = `CREATE INDEX IF NOT EXISTS ${compositeName} ON ${table} (${compositeCols})`;

      const exists = schema.existingIndexes.some(
        (idx) => idx.toLowerCase().includes(compositeName.toLowerCase()),
      );

      // The composite statement has the form `(a, b)` and is emitted only
      // here (after the single-column loop above, which uses the distinct
      // `(col)` form). `recommendations.includes(compositeStmt)` can never be
      // true because no single-column branch pushes a multi-column statement.
      /* c8 ignore next */
      if (!exists && !recommendations.includes(compositeStmt)) {
        recommendations.push(compositeStmt);
      }
    }

    logger.info(
      { whereColumns, joinColumns, orderColumns, recommendations: recommendations.length },
      'Index advisor analysis complete',
    );

    return recommendations;
  }

  /**
   * Extract column references from WHERE clause conditions.
   */
  private extractWhereColumns(sql: string): string[] {
    const columns: string[] = [];
    // The lookahead matches a following clause keyword OR end-of-string. The
    // previous regex anchored `$` behind `\s+`, so a bare `WHERE col = val`
    // with no trailing GROUP/ORDER/LIMIT/HAVING never matched (end-of-string
    // has no leading whitespace). Split the anchor so end-of-string is matched
    // independently of the whitespace that precedes a clause keyword.
    const whereMatch = sql.match(/\bWHERE\s+(.+?)(?=\s+(?:GROUP|ORDER|LIMIT|HAVING)\b|$)/is);
    if (!whereMatch) return columns;

    const whereClause = whereMatch[1];
    // Match column references like "col = ?", "col IN (...)", "col > ?", "col LIKE ?"
    const colMatches = whereClause.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|!=|<>|<|>|<=|>=|IN|LIKE|BETWEEN|IS\s+NOT\s+NULL|IS\s+NULL)/gi);

    for (const match of colMatches) {
      const col = match[1].toLowerCase();
      // Skip SQL keywords and operators
      if (!['and', 'or', 'not', 'in', 'where', 'from', 'select'].includes(col)) {
        columns.push(col);
      }
    }

    return [...new Set(columns)];
  }

  /**
   * Extract column references from JOIN conditions.
   */
  private extractJoinColumns(sql: string): string[] {
    const columns: string[] = [];
    // Same fix as extractWhereColumns: end-of-string must be matched
    // independently of the whitespace that precedes the next clause keyword.
    const joinMatches = sql.matchAll(/\b(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS|NATURAL|)\s*JOIN\s+(.+?)\s+ON\s+(.+?)(?=\s+(?:LEFT|RIGHT|INNER|OUTER|FULL|CROSS|NATURAL|JOIN|WHERE|GROUP|ORDER|LIMIT)\b|$)/gis);

    for (const match of joinMatches) {
      const onClause = match[2];
      // Extract column references like "table.col = other_table.col"
      const colRefs = onClause.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=)/gi);
      for (const ref of colRefs) {
        const col = ref[1].toLowerCase();
        if (!['and', 'or', '=', 'on'].includes(col)) {
          columns.push(col);
        }
      }
    }

    return [...new Set(columns)];
  }

  /**
   * Extract column references from ORDER BY clause.
   */
  private extractOrderColumns(sql: string): string[] {
    const columns: string[] = [];
    const orderMatch = sql.match(/\bORDER\s+BY\s+(.+?)(?=\s+(?:LIMIT|OFFSET)\b|$)/is);
    if (!orderMatch) return columns;

    const orderClause = orderMatch[1];
    const colMatches = orderClause.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)/gi);

    for (const match of colMatches) {
      const col = match[1].toLowerCase();
      if (!['asc', 'desc', 'nulls', 'first', 'last'].includes(col)) {
        columns.push(col);
      }
    }

    return [...new Set(columns)];
  }

  /**
   * Infer the table name from a SQL query context.
   */
  private inferTable(sql: string, _column: string): string | null {
    const fromMatch = sql.match(/\bFROM\s+([`"'\w.]+)/i);
    if (fromMatch) {
      return fromMatch[1].replace(/[`"']/g, '');
    }
    return null;
  }
}

// ──────────────────────────────────────────────
//  Enhanced Index Recommendation Types (E8)
// ──────────────────────────────────────────────

/**
 * A recommended index for a specific table and column combination.
 */
export interface IndexRecommendation {
  /** The table the index should be created on */
  table: string;
  /** The columns to include in the index (in recommended order) */
  columns: string[];
  /** Index type — B-tree for general purpose, UNIQUE for unique constraints */
  type: 'btree' | 'unique';
  /** Estimated cardinality (number of distinct values / columns) */
  cardinality: number;
  /** Human-readable explanation for why this index was recommended */
  reason: string;
}

// ── Index Advisor E8 types ────────────────────

/**
 * A candidate column extracted from a SQL query, annotated with context.
 */
export interface CandidateColumn {
  table: string;
  column: string;
  context: 'WHERE' | 'JOIN' | 'ORDER_BY' | 'GROUP_BY';
}

/**
 * Information about an existing database index.
 */
export interface IndexInfo {
  table: string;
  name: string;
  columns: string[];
  unique: boolean;
}

// ──────────────────────────────────────────────
//  IndexAdvisor — AST-based index recommender
// ──────────────────────────────────────────────

/**
 * IndexAdvisor — parses SQL queries using `pgsql-ast-parser` and recommends
 * database indexes based on WHERE clause predicates and JOIN conditions.
 *
 * ## Features
 *
 * - **AST-driven**: Uses `pgsql-ast-parser` to reliably extract column
 *   references from WHERE conditions and JOIN ON clauses.
 * - **Composite index detection**: When multiple columns appear together
 *   in a WHERE clause (`a = 1 AND b = 2`), a single composite B-tree
 *   index is recommended.
 * - **JOIN index detection**: Columns used in JOIN ON conditions are
 *   recommended as individual B-tree indexes per table.
 * - **Deduplication**: Repeated recommendations of the same
 *   (table, columns-sorted, type) combination are suppressed.
 *
 * ## Usage
 *
 * ```ts
 * const advisor = new IndexAdvisor();
 *
 * // Analyze a query for column references
 * const cols = advisor.analyzeQuery('SELECT * FROM t WHERE a = 1 AND b = 2');
 * //   → ['a', 'b']
 *
 * // Recommend indexes based on query patterns
 * const recs = advisor.recommendIndexes('t', [
 *   'SELECT * FROM t WHERE a = 1 AND b = 2',
 * ]);
 * //   → [{ table: 't', columns: ['a', 'b'], type: 'btree', ... }]
 * ```
 */
export class IndexAdvisor {
  private readonly recommendations: IndexRecommendation[] = [];
  private readonly dedupKeys: Set<string> = new Set();

  // ──────────────────────────────────────────
  //  Public API
  // ──────────────────────────────────────────

  /**
   * Parse a single SQL query and return all column names referenced in
   * WHERE conditions and JOIN ON clauses.
   *
   * Uses `pgsql-ast-parser` under the hood for reliable AST parsing.
   * Returns unqualified column names (the `name` property of each `ExprRef`
   * node). If parsing fails (invalid SQL), an empty array is returned.
   *
   * @param sql - The SQL query string to analyze.
   * @returns An array of unique column names found in WHERE/JOIN predicates.
   *
   * @example
   * ```ts
   * advisor.analyzeQuery('SELECT * FROM t WHERE a = 1 AND b = 2');
   * // → ['a', 'b']
   *
   * advisor.analyzeQuery('SELECT * FROM t1 JOIN t2 ON t1.x = t2.y');
   * // → ['x', 'y']
   * ```
   */
  analyzeQuery(sql: string): string[] {
    const refs = this.extractAllRefs(sql);
    return [...new Set(refs.map((r) => r.column))];
  }

  /**
   * Analyze multiple SQL queries for a specific table and generate index
   * recommendations.
   *
   * **Logic:**
   *
   * 1. Parse each query to extract qualified column references (table.col).
   * 2. Filter references that belong to the target `table`.
   * 3. If a query's WHERE clause references **two or more** columns from the
   *    target table, a single **composite B-tree index** on those columns is
   *    recommended (in the order they appear in the WHERE expression tree).
   * 4. If a query has JOIN ON conditions involving the target table, each
   *    JOIN column gets an **individual B-tree index**.
   * 5. Otherwise, single-column B-tree indexes are recommended for each
   *    remaining unique column.
   * 6. **Deduplication**: identical recommendations (same table, same column
   *    set sorted lexicographically, same index type) are emitted only once
   *    across all calls to this method.
   *
   * @param table   - The table name to recommend indexes for.
   * @param queries - An array of SQL query strings associated with this table.
   * @returns An array of unique {@link IndexRecommendation} objects.
   *
   * @example
   * ```ts
   * const advisor = new IndexAdvisor();
   *
   * // WHERE columns → composite index
   * advisor.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1 AND b = 2']);
   * // → [{ table: 't', columns: ['a', 'b'], type: 'btree', cardinality: 2, ... }]
   *
   * // JOIN columns → individual indexes per table
   * advisor.recommendIndexes('t1', ['SELECT * FROM t1 JOIN t2 ON t1.x = t2.y']);
   * // → [{ table: 't1', columns: ['x'], type: 'btree', ... }]
   * ```
   *
   * @overload Analyze multiple queries for a table and recommend indexes.
   */
  recommendIndexes(table: string, queries: string[]): IndexRecommendation[];
  /**
   * Recommend indexes for a SQL query by comparing candidate columns against
   * existing indexes in the database.
   *
   * Full pipeline:
   * 1. Extract candidate columns from the query (WHERE, JOIN, ORDER_BY, GROUP_BY)
   * 2. Query existing indexes from the database
   * 3. Compare candidates against existing indexes' left-prefix coverage
   * 4. Generate missing index recommendations sorted by impact (WHERE > JOIN > ORDER_BY > GROUP_BY)
   *
   * @param sql - The SQL query to analyze.
   * @param db  - A better-sqlite3 Database instance for existing index lookup.
   * @returns An array of {@link IndexRecommendation} objects for missing indexes.
   *
   * @example
   * ```ts
   * const recs = advisor.recommendIndexes('SELECT * FROM t WHERE a = 1', db);
   * // → [{ table: 't', columns: ['a'], type: 'btree', ... }]
   * ```
   *
   * @overload Analyze a SQL query against a Database and recommend missing indexes.
   */
  recommendIndexes(sql: string, db: Database.Database): IndexRecommendation[];
  recommendIndexes(tableOrSql: string, queriesOrDb: string[] | Database.Database): IndexRecommendation[] {
    // ── Overload 1: (table, queries[]) — analyze multiple queries for a table
    if (Array.isArray(queriesOrDb)) {
      return this.recommendIndexesForTable(tableOrSql, queriesOrDb);
    }

    // ── Overload 2: (sql, db) — analyze a query against a live database
    return this.recommendIndexesForDb(tableOrSql, queriesOrDb);
  }

  /**
   * Original: analyze multiple queries for a specific table.
   */
  private recommendIndexesForTable(table: string, queries: string[]): IndexRecommendation[] {
    const result: IndexRecommendation[] = [];

    for (const query of queries) {
      const whereTableCols = this.extractWhereColumnsForTable(query, table);
      const joinTableCols = this.extractJoinColumnsForTable(query, table);

      // Composite index for multi-column WHERE predicates
      if (whereTableCols.length >= 2) {
        const rec: IndexRecommendation = this.buildRec(
          table,
          whereTableCols,
          'btree',
          `Composite B-tree index on columns (${whereTableCols.join(', ')}) used together in WHERE clause`,
        );
        if (this.addIfUnique(rec)) {
          result.push(rec);
        }
        // Skip individual column recommendations for these columns
        continue;
      }

      // Individual indexes for JOIN ON columns
      for (const col of joinTableCols) {
        const rec: IndexRecommendation = this.buildRec(
          table,
          [col],
          'btree',
          `B-tree index on JOIN column ${table}.${col}`,
        );
        if (this.addIfUnique(rec)) {
          result.push(rec);
        }
      }

      // Individual indexes for remaining WHERE columns
      for (const col of whereTableCols) {
        // Only if we didn't already recommend it above (single WHERE col, no composite)
        if (joinTableCols.includes(col)) {
          continue;
        }
        const rec: IndexRecommendation = this.buildRec(
          table,
          [col],
          'btree',
          `B-tree index on column ${table}.${col} used in query filter`,
        );
        if (this.addIfUnique(rec)) {
          result.push(rec);
        }
      }
    }

    return result;
  }

  /**
   * New E8 overload: analyze a SQL query against a Database and recommend missing indexes.
   */
  private recommendIndexesForDb(sql: string, db: Database.Database): IndexRecommendation[] {
    const candidates = this.extractCandidateColumns(sql);
    if (candidates.length === 0) return [];

    const existing = this.getExistingIndexes(db);
    const recommendations: IndexRecommendation[] = [];

    // Group candidates by table
    const tableCandidates = new Map<string, CandidateColumn[]>();
    for (const c of candidates) {
      if (!tableCandidates.has(c.table)) {
        tableCandidates.set(c.table, []);
      }
      tableCandidates.get(c.table)!.push(c);
    }

    for (const [table, cols] of tableCandidates) {
      // Check if any existing index covers the left prefix of candidate columns
      const existingForTable = existing.filter((e) => e.table === table || e.table.toLowerCase() === table.toLowerCase());

      // Group candidate columns by context priority
      const whereCols = cols.filter((c) => c.context === 'WHERE').map((c) => c.column);
      const joinCols = cols.filter((c) => c.context === 'JOIN').map((c) => c.column);
      const orderCols = cols.filter((c) => c.context === 'ORDER_BY').map((c) => c.column);
      const groupCols = cols.filter((c) => c.context === 'GROUP_BY').map((c) => c.column);

      // Generate recommended column sets (de-duplicated)
      const recommendedSets = this.generateColumnSets(
        whereCols, joinCols, orderCols, groupCols, existingForTable,
      );

      for (const recCols of recommendedSets) {
        const rec: IndexRecommendation = {
          table,
          columns: recCols.columns,
          type: 'btree',
          cardinality: recCols.columns.length,
          reason: recCols.reason,
        };

        // Deduplicate against accumulated recommendations
        if (this.addIfUnique(rec)) {
          recommendations.push(rec);
        }
      }
    }

    return recommendations;
  }

  /**
   * Return all recommendations accumulated so far across all
   * `recommendIndexes()` calls.
   *
   * @returns A shallow copy of the internal recommendations array.
   */
  getRecommendedIndexes(): IndexRecommendation[] {
    return [...this.recommendations];
  }

  // ──────────────────────────────────────────
  //  E8: Enhanced Public API
  // ──────────────────────────────────────────

  /**
   * Extract candidate columns from a SQL query, annotated with their usage
   * context (WHERE, JOIN, ORDER_BY, GROUP_BY).
   *
   * Uses `pgsql-ast-parser` for reliable AST parsing and classifies each
   * column reference by its syntactic role.
   *
   * @param sql - The SQL query string to analyze.
   * @returns An array of {@link CandidateColumn} objects with context annotations.
   *
   * @example
   * ```ts
   * advisor.extractCandidateColumns('SELECT * FROM t WHERE a = 1 ORDER BY b');
   * // → [
   * //   { table: 't', column: 'a', context: 'WHERE' },
   * //   { table: 't', column: 'b', context: 'ORDER_BY' },
   * // ]
   * ```
   */
  extractCandidateColumns(sql: string): CandidateColumn[] {
    const candidates: CandidateColumn[] = [];
    const seenKeys = new Set<string>();

    try {
      const stmts = parse(sql);
      for (const stmt of stmts) {
        if (stmt.type !== 'select') continue;

        // WHERE 条件中的列
        if (stmt.where) {
          const whereRefs: QualifiedRef[] = [];
          this.collectRefsFromExpr(stmt.where, whereRefs);
          for (const ref of whereRefs) {
            const table = ref.table ?? this.inferTableFromFrom(stmt.from ?? []);
            const key = `${table}|${ref.column}|WHERE`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              candidates.push({ table, column: ref.column, context: 'WHERE' });
            }
          }
        }

        // JOIN ON 中的列
        if (stmt.from) {
          for (const from of stmt.from) {
            if (from.type === 'table' && from.join?.on) {
              const joinRefs: QualifiedRef[] = [];
              this.collectRefsFromExpr(from.join.on, joinRefs);
              for (const ref of joinRefs) {
                // `from.type === 'table'` (guarded above) guarantees
                // `from.name` is a non-null `{ name: string }`, so the second
                // `?? ''` fallback for `from.name?.name` is unreachable.
                /* c8 ignore next */
                const table = ref.table ?? (from.name?.name ?? '');
                const key = `${table}|${ref.column}|JOIN`;
                if (!seenKeys.has(key)) {
                  seenKeys.add(key);
                  candidates.push({ table, column: ref.column, context: 'JOIN' });
                }
              }
            }
          }
        }

        // ORDER BY 中的列
        if (stmt.orderBy) {
          for (const ob of stmt.orderBy) {
            const obExpr = ob.by as { type?: string; name?: string; table?: { name?: string } };
            if (obExpr.type === 'ref') {
              const table = obExpr.table?.name ?? this.inferTableFromFrom(stmt.from ?? []);
              const key = `${table}|${obExpr.name}|ORDER_BY`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                // `obExpr.type === 'ref'` guarantees `obExpr.name` is a
                // non-null string, so the `?? ''` fallback is unreachable.
                /* c8 ignore next */
                candidates.push({ table, column: obExpr.name ?? '', context: 'ORDER_BY' });
              }
            }
          }
        }

        // GROUP BY 中的列
        if (stmt.groupBy) {
          for (const gb of stmt.groupBy) {
            const gbExpr = gb as { type?: string; name?: string; table?: { name?: string } };
            if (gbExpr.type === 'ref') {
              const table = gbExpr.table?.name ?? this.inferTableFromFrom(stmt.from ?? []);
              const key = `${table}|${gbExpr.name}|GROUP_BY`;
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                // `gbExpr.type === 'ref'` guarantees `gbExpr.name` is a
                // non-null string, so the `?? ''` fallback is unreachable.
                /* c8 ignore next */
                candidates.push({ table, column: gbExpr.name ?? '', context: 'GROUP_BY' });
              }
            }
          }
        }
      }
    } catch {
      // Parsing failure — return what we have
    }

    return candidates;
  }

  /**
   * Get existing indexes from a better-sqlite3 Database by querying
   * sqlite_master and PRAGMA index_info for each index.
   *
   * @param db - A better-sqlite3 Database instance.
   * @returns An array of {@link IndexInfo} objects describing all indexes
   *          (excluding auto-generated sqlite_autoindex entries).
   *
   * @example
   * ```ts
   * const db = new Database(':memory:');
   * const indexes = advisor.getExistingIndexes(db);
   * // → [{ table: 't', name: 'idx_t_a', columns: ['a'], unique: false }]
   * ```
   */
  getExistingIndexes(db: Database.Database): IndexInfo[] {
    const indexes: IndexInfo[] = [];

    try {
      // Query all indexes from sqlite_master, excluding sqlite_autoindex
      const indexRows = db.prepare(
        "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex%'",
      ).all() as Array<{ name: string; tbl_name: string; sql: string | null }>;

      for (const row of indexRows) {
        const isUnique = row.sql ? /^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(row.sql) : false;

        // Get columns via PRAGMA index_info
        const colRows = db.prepare(`PRAGMA index_info('${row.name}')`).all() as Array<{
          seqno: number;
          cid: number;
          name: string;
        }>;

        const columns = colRows
          .sort((a, b) => a.seqno - b.seqno)
          .map((c) => c.name);

        indexes.push({
          table: row.tbl_name,
          name: row.name,
          columns,
          unique: isUnique,
        });
      }
    } catch {
      // PRAGMA may fail — return what we have
    }

    return indexes;

  }

  /**
   * Convert index recommendations to pg_catalog-compatible rows.
   *
   * Produces rows resembling `pg_index` view output with extensions
   * for recommendation metadata.
   *
   * @param recommendations - The index recommendations to convert.
   * @returns An array of row objects suitable for pg_catalog display.
   *
   * @example
   * ```ts
   * const rows = advisor.toPgCatalogRows(recs);
   * // → [{ schemaname: 'public', tablename: 't', indexname: 'idx_t_a', ... }]
   * ```
   */
  toPgCatalogRows(recommendations: IndexRecommendation[]) {
    return recommendations.map((rec, i) => {
      const colList = rec.columns.join(', ');
      const idxName = `idx_${rec.table}_${rec.columns.join('_')}`;
      return {
        schemaname: 'public',
        tablename: rec.table,
        indexname: idxName,
        indexdef: `CREATE INDEX IF NOT EXISTS ${idxName} ON ${rec.table} (${colList})`,
        columns: colList,
        type: rec.type,
        estimated_impact: rec.cardinality,
        reason: rec.reason,
      };
    });
  }

  // ──────────────────────────────────────────
  //  E8: Private helpers
  // ──────────────────────────────────────────

  /**
   * Infer the primary table name from the FROM clause.
   */
  private inferTableFromFrom(from: Array<{ type: string; name?: { name: string } }>): string {
    for (const f of from) {
      if (f.type === 'table' && f.name?.name) {
        return f.name.name;
      }
    }
    return '';
  }

  /**
   * Generate column sets to recommend as indexes, deduplicated against
   * existing indexes (left-prefix matching).
   *
   * Priority: WHERE composite > WHERE single > JOIN > ORDER BY > GROUP BY
   */
  private generateColumnSets(
    whereCols: string[],
    joinCols: string[],
    orderCols: string[],
    groupCols: string[],
    existing: IndexInfo[],
  ): Array<{ columns: string[]; reason: string }> {
    const results: Array<{ columns: string[]; reason: string }> = [];

    // Helper: check if columns are covered by any existing index (left-prefix match)
    const isCovered = (cols: string[], existing: IndexInfo[]): boolean => {
      const normalized = cols.map((c) => c.toLowerCase());
      for (const idx of existing) {
        const idxCols = idx.columns.map((c) => c.toLowerCase());
        // Left-prefix match: existing index columns start with our candidate columns
        if (this.arrayStartsWith(idxCols, normalized) || this.arrayStartsWith(normalized, idxCols)) {
          return true;
        }
      }
      return false;
    };

    // 1. Composite index for multi-column WHERE predicates (highest priority)
    if (whereCols.length >= 2) {
      const dedupedWhere = [...new Set(whereCols)];
      if (!isCovered(dedupedWhere, existing)) {
        results.push({
          columns: dedupedWhere,
          reason: `Composite B-tree index on columns (${dedupedWhere.join(', ')}) used together in WHERE clause`,
        });
      }
    }

    // 2. Single-column WHERE columns (only if not already covered by composite)
    for (const col of whereCols) {
      if (!isCovered([col], existing)) {
        results.push({
          columns: [col],
          reason: `B-tree index on column used in WHERE filter`,
        });
      }
    }

    // 3. JOIN columns
    for (const col of [...new Set(joinCols)]) {
      if (!isCovered([col], existing)) {
        results.push({
          columns: [col],
          reason: `B-tree index on JOIN column`,
        });
      }
    }

    // 4. ORDER BY columns
    for (const col of [...new Set(orderCols)]) {
      if (!isCovered([col], existing)) {
        results.push({
          columns: [col],
          reason: `B-tree index on ORDER BY column`,
        });
      }
    }

    // 5. GROUP BY columns
    for (const col of [...new Set(groupCols)]) {
      if (!isCovered([col], existing)) {
        results.push({
          columns: [col],
          reason: `B-tree index on GROUP BY column`,
        });
      }
    }

    return results;
  }

  /**
   * Check if array `a` starts with all elements of array `b` (order-sensitive).
   */
  private arrayStartsWith(a: string[], b: string[]): boolean {
    if (b.length > a.length) return false;
    for (let i = 0; i < b.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ──────────────────────────────────────────
  //  Private helpers (existing)
  // ──────────────────────────────────────────

  private buildRec(
    table: string,
    columns: string[],
    type: 'btree' | 'unique',
    reason: string,
  ): IndexRecommendation {
    return {
      table,
      columns: [...columns], // defensive copy
      type,
      cardinality: columns.length,
      reason,
    };
  }

  /**
   * Add a recommendation only if no identical one (by (table, sorted-columns, type))
   * has been added before.
   *
   * @returns `true` if the recommendation was added, `false` if it was a duplicate.
   */
  private addIfUnique(rec: IndexRecommendation): boolean {
    const sortedCols = [...rec.columns].sort();
    const key = `${rec.table}|${sortedCols.join(',')}|${rec.type}`;
    if (this.dedupKeys.has(key)) {
      return false;
    }
    this.dedupKeys.add(key);
    this.recommendations.push(rec);
    return true;
  }

  /**
   * Parse SQL, return all qualified refs (table, column) from WHERE and JOIN ON.
   */
  private extractAllRefs(sql: string): QualifiedRef[] {
    try {
      const stmts = parse(sql);
      const refs: QualifiedRef[] = [];

      for (const stmt of stmts) {
        if (stmt.type === 'select') {
          // WHERE clause
          if (stmt.where) {
            this.collectRefsFromExpr(stmt.where, refs);
          }

          // FROM / JOIN clauses
          if (stmt.from) {
            for (const from of stmt.from) {
              if (from.type === 'table' && from.join?.on) {
                this.collectRefsFromExpr(from.join.on, refs);
              }
            }
          }
        }
      }

      return refs;
    } catch {
      return [];
    }
  }

  /**
   * Extract refs from the WHERE clause only.
   */
  private extractWhereRefs(sql: string): QualifiedRef[] {
    try {
      const stmts = parse(sql);
      const refs: QualifiedRef[] = [];

      for (const stmt of stmts) {
        if (stmt.type === 'select' && stmt.where) {
          this.collectRefsFromExpr(stmt.where, refs);
        }
      }

      return refs;
    } catch {
      return [];
    }
  }

  /**
   * Extract refs from JOIN ON clauses only.
   */
  private extractJoinRefs(sql: string): QualifiedRef[] {
    try {
      const stmts = parse(sql);
      const refs: QualifiedRef[] = [];

      for (const stmt of stmts) {
        if (stmt.type === 'select' && stmt.from) {
          for (const from of stmt.from) {
            if (from.type === 'table' && from.join?.on) {
              this.collectRefsFromExpr(from.join.on, refs);
            }
          }
        }
      }

      return refs;
    } catch {
      return [];
    }
  }

  /**
   * Recursively traverse an expression tree and collect all `ExprRef` nodes
   * into the provided array.
   */
  private collectRefsFromExpr(expr: unknown, refs: QualifiedRef[]): void {
    if (expr === null || expr === undefined || typeof expr !== 'object') {
      return;
    }

    const node = expr as Record<string, unknown>;

    if (node.type === 'ref') {
      const refNode = expr as {
        type: 'ref';
        name: string;
        table?: { name: string } | null;
      };
      refs.push({
        table: refNode.table?.name ?? null,
        column: refNode.name,
      });
      return;
    }

    if (node.type === 'binary') {
      const binNode = expr as { left: unknown; right: unknown };
      this.collectRefsFromExpr(binNode.left, refs);
      this.collectRefsFromExpr(binNode.right, refs);
      return;
    }

    if (node.type === 'unary') {
      const unaryNode = expr as { operand: unknown };
      this.collectRefsFromExpr(unaryNode.operand, refs);
      return;
    }

    if (node.type === 'cast') {
      const castNode = expr as { operand: unknown };
      this.collectRefsFromExpr(castNode.operand, refs);
      return;
    }

    if (node.type === 'ternary') {
      const ternaryNode = expr as { value: unknown; lo: unknown; hi: unknown };
      this.collectRefsFromExpr(ternaryNode.value, refs);
      this.collectRefsFromExpr(ternaryNode.lo, refs);
      this.collectRefsFromExpr(ternaryNode.hi, refs);
      return;
    }

    if (node.type === 'call') {
      const callNode = expr as { args?: unknown[] };
      if (callNode.args) {
        for (const arg of callNode.args) {
          this.collectRefsFromExpr(arg, refs);
        }
      }
      return;
    }
  }

  /**
   * Extract column names from the WHERE clause that belong to `table`.
   * Returns columns in the order they appear in the WHERE expression tree
   * (left-to-right traversal).
   */
  private extractWhereColumnsForTable(sql: string, table: string): string[] {
    const refs = this.extractWhereRefs(sql);
    const seen = new Set<string>();
    const result: string[] = [];

    for (const ref of refs) {
      // A ref belongs to this table if:
      //  (a) it is explicitly qualified (ref.table === table), OR
      //  (b) it is unqualified (no table prefix) — assumed to be the target table
      const matches = ref.table === null || ref.table === table;
      if (matches && !seen.has(ref.column)) {
        seen.add(ref.column);
        result.push(ref.column);
      }
    }

    return result;
  }

  /**
   * Extract column names from JOIN ON clauses that belong to `table`.
   * Returns columns in the order they appear.
   */
  private extractJoinColumnsForTable(sql: string, table: string): string[] {
    const refs = this.extractJoinRefs(sql);
    const seen = new Set<string>();
    const result: string[] = [];

    for (const ref of refs) {
      // In a JOIN, we only match explicitly qualified refs (table.col)
      // because the context distinguishes multiple tables.
      // If the ref is unqualified in a JOIN, match it anyway (it's the only table).
      const matches = ref.table === null || ref.table === table;
      if (matches && !seen.has(ref.column)) {
        seen.add(ref.column);
        result.push(ref.column);
      }
    }

    return result;
  }
}

interface QualifiedRef {
  /** Table name (null if unqualified) */
  table: string | null;
  /** Column name */
  column: string;
}
