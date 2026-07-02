/**
 * BRINIndexShim — Translates PostgreSQL BRIN indexes to SQLite-compatible equivalents.
 *
 * PostgreSQL's BRIN (Block Range INdex) is a specialized index type designed for
 * large tables where data is physically clustered (e.g., time-series, log tables).
 * It works by summarizing ranges of physical blocks rather than individual rows.
 *
 * SQLite has no BRIN equivalent, so the strategy is straightforward:
 *   - Strip `USING BRIN` → fall back to a standard B-tree index
 *   - Strip `CONCURRENTLY` (SQLite does not support concurrent index creation)
 *
 * | Input Example                                      | Output                                      |
 * |----------------------------------------------------|---------------------------------------------|
 * | CREATE INDEX ix ON t USING BRIN (col)              | CREATE INDEX ix ON t (col)                 |
 * | CREATE INDEX CONCURRENTLY ON t USING BRIN (a, b)   | CREATE INDEX ON t (a, b)                   |
 * | CREATE UNIQUE INDEX ix ON t USING BRIN (col)       | CREATE UNIQUE INDEX ix ON t (col)          |
 *
 * Limitations (regex-based approach):
 *   - BRIN appearing inside string literals or comments may trigger false positives
 *   - Mixed-expression indexes are handled as a single pass
 *   - Always strips both `USING BRIN` and `CONCURRENTLY` unconditionally
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import Flatbush from 'flatbush';

const logger = PinoLogger.forComponent('BRINIndexShim');

// ──────────────────────────────────────────────
//  Real BRIN (Block Range Index) Implementation
// ──────────────────────────────────────────────

/**
 * Options for configuring a BRIN index on a column.
 */
export interface BrinIndexOptions {
  /** Number of rows per page range block (default 128) */
  pagesPerRange: number;
}

/**
 * Represents a summarized block range: min/max values for a page range.
 */
export interface BrinBlockRange {
  pageRangeStart: number;
  pageRangeEnd: number;
  minVal: any;
  maxVal: any;
  hasNull: boolean;
}

/**
 * Real BRIN (Block Range INdex) implementation for SQLite.
 *
 * BRIN indexes work by summarizing ranges of rows (block ranges) rather than
 * individual rows. This is efficient for append-only / time-series workloads
 * where data is naturally clustered.
 *
 * The index stores per-range metadata:
 *   - page_range_start, page_range_end
 *   - min_val, max_val (range boundaries)
 *   - has_null (whether NULLs exist in the range)
 *
 * Query pruning: when querying with a WHERE clause, `canPrune()` checks if
 * a page range's min/max excludes the query value entirely — allowing the
 * entire range to be skipped.
 */
export class BrinBlockRangeIndex {
  /** Table name for the underlying BRIN metadata table */
  private metaTable: string;
  /** Number of rows per page range */
  private pagesPerRange: number;
  /** Cache of loaded block ranges: page_range_start → BrinBlockRange */
  private ranges: Map<number, BrinBlockRange> = new Map();
  /** Flatbush spatial index for fast min/max range pruning.
   *  Each item: minX=minVal, maxX=maxVal, minY=startPage, maxY=endPage
   *  To prune: search for (minX <= queryVal <= maxX) using flatbush.search()
   *  Note: flatbush is static — rebuilt via buildFlatbushIndex(). */
  private flatbushIndex: Flatbush | null = null;
  /** Parallel array mapping flatbush index positions → pageRangeStart */
  private fbPageStarts: number[] = [];
  /** Whether the column type is numeric/timestamp/date (can use flatbush) */
  private isNumericCol: boolean;

  /**
   * @param table - Parent table name
   * @param column - Indexed column name
   * @param options - BRIN options (pagesPerRange defaults to 128)
   * @param isNumeric - Whether the column is numeric/timestamp/date (default true)
   */
  constructor(
    public readonly table: string,
    public readonly column: string,
    options?: Partial<BrinIndexOptions>,
    isNumeric: boolean = true,
  ) {
    this.pagesPerRange = options?.pagesPerRange ?? 128;
    this.metaTable = `__brin_pages_${table}_${column}`;
    this.isNumericCol = isNumeric;
  }

  /**
   * Get the name of the metadata table used for persisting block ranges.
   */
  getMetaTable(): string {
    return this.metaTable;
  }

  /**
   * Get the pages_per_range configuration.
   */
  getPagesPerRange(): number {
    return this.pagesPerRange;
  }

  /**
   * Get the flatbush index (null if not built).
   */
  getFlatbushIndex(): Flatbush | null {
    return this.flatbushIndex;
  }

  /**
   * Build or rebuild the flatbush index from the current range cache.
   * Must be called after summarizing all ranges.
   *
   * Flatbush stores each page range's [minVal, maxVal] as the spatial extent.
   * A query for value N searches for ranges where minVal <= N <= maxVal.
   */
  buildFlatbushIndex(): void {
    const rangeList = Array.from(this.ranges.values())
      .filter(r => r.minVal !== null && r.maxVal !== null)
      .sort((a, b) => a.pageRangeStart - b.pageRangeStart);

    if (rangeList.length === 0) {
      this.flatbushIndex = null;
      this.fbPageStarts = [];
      return;
    }

    this.fbPageStarts = [];

    let validCount = 0;
    for (const r of rangeList) {
      const minV = parseFloat(String(r.minVal));
      const maxV = parseFloat(String(r.maxVal));
      if (isFinite(minV) && isFinite(maxV)) {
        validCount++;
      }
    }

    if (validCount === 0) {
      this.flatbushIndex = null;
      return;
    }

    const fb = new Flatbush(validCount);

    for (const r of rangeList) {
      const minV = parseFloat(String(r.minVal));
      const maxV = parseFloat(String(r.maxVal));
      if (isFinite(minV) && isFinite(maxV)) {
        fb.add(minV, r.pageRangeStart, maxV, r.pageRangeEnd);
        this.fbPageStarts.push(r.pageRangeStart);
      }
    }

    fb.finish();
    this.flatbushIndex = fb;
  }

  /**
   * Use flatbush to quickly find candidate page ranges for a range query.
   *
   * flatbush items are stored as:
   *   minX = minVal (numeric), minY = pageRangeStart
   *   maxX = maxVal (numeric), maxY = pageRangeEnd
   *
   * Query bounds are computed operator-dependently so that flatbush.search()
   * returns ranges whose [min, max] INTERSECTS the query extent.
   *
   * @param queryVal - Query value (numeric)
   * @param op - Comparison operator for appropriate flatbush query bounds
   * @returns Array of page_range_start values, or null if flatbush not available
   */
  private _flatbushSearch(queryVal: number, op: string): number[] | null {
    if (!this.flatbushIndex || !this.isNumericCol) return null;

    const normalOp = op.toUpperCase().trim();
    const eps = 1e-9;
    let minX: number;
    let maxX: number;

    switch (normalOp) {
      case '>':
        // Ranges where max > queryVal → intersect (-Inf, Inf) with (query+ε, Inf)
        minX = queryVal + eps;
        maxX = Infinity;
        break;
      case '>=':
        // Ranges where max >= queryVal → intersect (-Inf, Inf) with (query, Inf)
        minX = queryVal;
        maxX = Infinity;
        break;
      case '<':
        // Ranges where min < queryVal → intersect (-Inf, Inf) with (-Inf, query-ε)
        minX = -Infinity;
        maxX = queryVal - eps;
        break;
      case '<=':
        // Ranges where min <= queryVal → intersect (-Inf, Inf) with (-Inf, query)
        minX = -Infinity;
        maxX = queryVal;
        break;
      default:
        // '=' / 'BETWEEN': ranges where min <= query <= max → intersect with (query, query)
        minX = queryVal;
        maxX = queryVal;
        break;
    }

    const indices = this.flatbushIndex.search(minX, -Infinity, maxX, Infinity);
    return indices.map(i => this.fbPageStarts[i]);
  }

  /**
   * Create the BRIN metadata table in the database.
   *
   * @param db - better-sqlite3 Database instance
   */
  createMetaTable(db: any): void {
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.metaTable} (
      page_range_start INTEGER PRIMARY KEY,
      page_range_end INTEGER NOT NULL,
      min_val TEXT,
      max_val TEXT,
      has_null INTEGER NOT NULL DEFAULT 0
    )`);

    logger.debug(
      { metaTable: this.metaTable, pagesPerRange: this.pagesPerRange },
      'BRIN: metadata table created',
    );
  }

  /**
   * Summarize a block range by computing min/max values for the given
   * range of rows in the parent table.
   *
   * @param db - better-sqlite3 Database instance
   * @param startPage - The starting page/row number of the range to summarize
   */
  summarizeRange(db: any, startPage: number): void {
    const endPage = startPage + this.pagesPerRange - 1;

    // Ensure metadata table exists before writing to it
    this.createMetaTable(db);

    // Use the column directly without explicit CAST for MIN/MAX so that
    // native type ordering (REAL/INTEGER) is preserved (contrast with
    // CAST(... AS TEXT) which would compare "9" > "192" as text).
    // Wrap the result with CAST to TEXT to match the metadata table schema
    // and produce consistent text representations for pg-style output.
    const row = db.prepare(`
      SELECT
        CAST(MIN(${this.column}) AS TEXT) AS min_val,
        CAST(MAX(${this.column}) AS TEXT) AS max_val,
        MAX(CASE WHEN ${this.column} IS NULL THEN 1 ELSE 0 END) AS has_null
      FROM ${this.table}
      WHERE rowid >= ? AND rowid < ?
    `).get(startPage, startPage + this.pagesPerRange) as any;

    const blockRange: BrinBlockRange = {
      pageRangeStart: startPage,
      pageRangeEnd: endPage,
      minVal: row?.min_val ?? null,
      maxVal: row?.max_val ?? null,
      hasNull: row?.has_null === 1,
    };

    // Persist to metadata table
    db.prepare(`
      INSERT OR REPLACE INTO ${this.metaTable}
        (page_range_start, page_range_end, min_val, max_val, has_null)
      VALUES (?, ?, ?, ?, ?)
    `).run(startPage, endPage, blockRange.minVal, blockRange.maxVal, blockRange.hasNull ? 1 : 0);

    // Update cache
    this.ranges.set(startPage, blockRange);

    logger.debug(
      { startPage, endPage, minVal: blockRange.minVal, maxVal: blockRange.maxVal, hasNull: blockRange.hasNull },
      'BRIN: range summarized',
    );
  }

  /**
   * Summarize all page ranges for the entire table.
   * Useful for initial BRIN index creation.
   *
   * @param db - better-sqlite3 Database instance
   */
  summarizeAll(db: any): void {
    this.createMetaTable(db);

    const row = db.prepare(`SELECT MAX(rowid) AS max_rowid FROM ${this.table}`).get() as any;
    const maxRowid = row?.max_rowid ?? 0;

    for (let startPage = 1; startPage <= maxRowid; startPage += this.pagesPerRange) {
      this.summarizeRange(db, startPage);
    }

    // Build flatbush index after summarizing all ranges
    this.buildFlatbushIndex();

    logger.info(
      { table: this.table, column: this.column, ranges: this.ranges.size, flatbushBuilt: this.flatbushIndex !== null },
      'BRIN: all ranges summarized with flatbush index',
    );
  }

  /**
   * Check whether a specific page range can be pruned (excluded) based on
   * the query predicate.
   *
   * The function checks if the query value falls outside the stored [min, max]
   * range for the page block, meaning the entire block can be skipped.
   *
   * @param db - better-sqlite3 Database instance
   * @param startPage - The starting page number of the range to check
   * @param op - Comparison operator: '=', '<', '<=', '>', '>=', 'BETWEEN'
   * @param value - Query value (for BETWEEN, provide an array [low, high])
   * @returns `true` if the range can be pruned (no matching rows possible)
   *
   * @example
   * ```ts
   * const brin = new BrinBlockRangeIndex('logs', 'created_at');
   * brin.summarizeRange(db, 1);
   *
   * // Can we prune page 1 if we're looking for values > 999?
   * const prune = brin.canPrune(db, 1, '>', 999);
   * // Prune if max_val of page 1 is <= 999
   * ```
   */
  canPrune(db: any, startPage: number, op: string, value: any): boolean {
    // Normalize operator
    const normalOp = op.toUpperCase().trim();

    // Load the range from cache or DB
    let range = this.ranges.get(startPage);
    if (!range) {
      const row = db.prepare(
        `SELECT * FROM ${this.metaTable} WHERE page_range_start = ?`
      ).get(startPage) as any;
      if (!row) return false; // Range not found — assume can't prune
      range = {
        pageRangeStart: row.page_range_start,
        pageRangeEnd: row.page_range_end,
        minVal: row.min_val,
        maxVal: row.max_val,
        hasNull: row.has_null === 1,
      };
      this.ranges.set(startPage, range);
    }

    // Handle IS NULL / IS NOT NULL explicitly before null value checks
    if (normalOp === 'IS NULL') {
      return !range.hasNull;
    }
    if (normalOp === 'IS NOT NULL') {
      return false; // Cannot determine exclusion for NOT NULL
    }

    // Handle NULL value queries
    if (value === null || value === undefined || value === 'NULL') {
      const opForNull = normalOp === '=' ? 'IS' : normalOp;
      if (opForNull === 'IS') {
        return !range.hasNull;
      }
      if (opForNull === 'IS NOT' || opForNull === '!=' || opForNull === '<>') {
        return false;
      }
      return false;
    }

    // Null guards for comparison
    if (range.minVal === null) return false;

    // Use numeric comparison for numeric columns
    let val: string | number = String(value);
    let min: string | number = String(range.minVal);
    let max: string | number = String(range.maxVal);

    if (this.isNumericCol) {
      val = parseFloat(String(value));
      min = parseFloat(String(range.minVal));
      max = parseFloat(String(range.maxVal));
      if (!isFinite(val) || !isFinite(min) || !isFinite(max)) {
        val = String(value);
        min = String(range.minVal);
        max = String(range.maxVal);
      }
    }

    // For BETWEEN, if the entire range falls outside [low, high], prune
    if (normalOp === 'BETWEEN') {
      return val > max;
    }

    switch (normalOp) {
      case '=':
      case '==':
        // Prune if value is outside [min, max]
        return val < min || val > max;

      case '<':
        // Prune if range's min >= value (nothing in range is less than value)
        return min >= val;

      case '<=':
        // Prune if range's min > value (nothing in range is <= value)
        return min > val;

      case '>':
        // Prune if range's max <= value (nothing in range is > value)
        return max <= val;

      case '>=':
        // Prune if range's max < value (nothing in range is >= value)
        return max < val;

      case '!=':
      case '<>':
        // Can't prune for inequality — all ranges have matching and non-matching rows
        return false;

      default:
        return false;
    }
  }

  /**
   * Prune a list of candidate page ranges based on a query predicate.
   * Returns only the ranges that CANNOT be pruned (might contain matching
   * rows).
   *
   * Uses flatbush for fast index-assisted pruning when available,
   * falling back to exhaustive range scan for non-numeric columns.
   *
   * @param db - better-sqlite3 Database instance
   * @param op - Comparison operator: '=', '<', '<=', '>', '>=', 'BETWEEN'
   * @param value - Query value
   * @returns Array of {@link BrinBlockRange}s that may contain matching rows
   */
  getCandidateRanges(db: any, op: string, value: any): BrinBlockRange[] {
    this.createMetaTable(db);

    // Try flatbush first (fast path for numeric columns with built index)
    if (this.flatbushIndex && this.isNumericCol) {
      const numVal = parseFloat(String(value));
      if (isFinite(numVal)) {
        const candidateStarts = this._flatbushSearch(numVal, op);
        if (candidateStarts !== null) {
          // Load ranges for candidate starts
          const candidates: BrinBlockRange[] = [];
          for (const startPage of candidateStarts) {
            let range = this.ranges.get(startPage);
            if (!range) {
              const row = db.prepare(
                `SELECT * FROM ${this.metaTable} WHERE page_range_start = ?`
              ).get(startPage) as any;
              if (!row) continue;
              range = {
                pageRangeStart: row.page_range_start,
                pageRangeEnd: row.page_range_end,
                minVal: row.min_val,
                maxVal: row.max_val,
                hasNull: row.has_null === 1,
              };
              this.ranges.set(startPage, range);
            }
            if (!this.canPrune(db, startPage, op, value)) {
              candidates.push(range);
            }
          }
          return candidates;
        }
      }
    }

    // Fallback: exhaustive scan
    const allRanges = db.prepare(
      `SELECT * FROM ${this.metaTable} ORDER BY page_range_start`
    ).all() as any[];

    const candidates: BrinBlockRange[] = [];

    for (const row of allRanges) {
      const range: BrinBlockRange = {
        pageRangeStart: row.page_range_start,
        pageRangeEnd: row.page_range_end,
        minVal: row.min_val,
        maxVal: row.max_val,
        hasNull: row.has_null === 1,
      };

      if (!this.canPrune(db, row.page_range_start, op, value)) {
        candidates.push(range);
      }
    }

    return candidates;
  }

  /**
   * Get all stored block ranges (for inspection/debugging).
   */
  getRanges(): BrinBlockRange[] {
    return Array.from(this.ranges.values());
  }

  /**
   * Clear the in-memory range cache and flatbush index.
   */
  clearCache(): void {
    this.ranges.clear();
    this.flatbushIndex = null;
    this.fbPageStarts = [];
  }
}

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface BRINIndexResult {
  /** Rewritten SQL string (always valid SQLite) */
  sql: string;
  /** Whether a USING BRIN clause was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — detection patterns
// ──────────────────────────────────────────────

/** Detect the `USING BRIN` clause in a CREATE INDEX statement */
const USING_BRIN_PATTERN = /\bUSING\s+BRIN\b/i;

/** Detect the `CONCURRENTLY` keyword in a CREATE INDEX statement */
const CONCURRENTLY_PATTERN = /\bCONCURRENTLY\b/i;

// ──────────────────────────────────────────────
//  Private helpers
// ──────────────────────────────────────────────

/**
 * Remove the `USING BRIN` clause from a CREATE INDEX statement.
 *
 * Handles the position between the table name and the column list:
 *   `CREATE INDEX idx ON t USING BRIN (col)` → `CREATE INDEX idx ON t (col)`
 *
 * Removes `USING <method>` entirely so that SQLite falls back to its
 * default index type (B-tree).
 */
function stripUsingBrin(sql: string): string {
  return sql.replace(USING_BRIN_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Remove the `CONCURRENTLY` keyword from a CREATE INDEX statement.
 *
 * SQLite does not support concurrent index creation, so we strip it:
 *   `CREATE INDEX CONCURRENTLY ON t (col)` → `CREATE INDEX ON t (col)`
 */
function stripConcurrently(sql: string): string {
  return sql.replace(CONCURRENTLY_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains a `USING BRIN` index clause.
 *
 * @param sql - A SQL statement (typically a CREATE INDEX)
 * @returns `true` if the SQL contains USING BRIN
 *
 * @example
 * ```ts
 * detectBRIN('CREATE INDEX ON t USING BRIN (col)'); // true
 * detectBRIN('CREATE INDEX ON t (col)');             // false
 * ```
 */
export function detectBRIN(sql: string): boolean {
  return USING_BRIN_PATTERN.test(sql);
}

/**
 * Rewrite a `CREATE INDEX ... USING BRIN` statement to produce always-executable
 * SQLite SQL.
 *
 * The rewrite strategy:
 *   1. Strip `CONCURRENTLY` (not supported in SQLite)
 *   2. Strip `USING BRIN` (not supported in SQLite) → fall back to B-tree
 *
 * If no `USING BRIN` clause is present, the SQL passes through unchanged.
 *
 * @param sql - A CREATE INDEX statement that may contain USING BRIN
 * @returns A {@link BRINIndexResult} with the rewritten SQL
 *
 * @example
 * ```ts
 * rewriteBRIN('CREATE INDEX ix ON t USING BRIN (col)');
 * // → { sql: 'CREATE INDEX ix ON t (col)', rewritten: true }
 *
 * rewriteBRIN('CREATE INDEX CONCURRENTLY ON t USING BRIN (a, b)');
 * // → { sql: 'CREATE INDEX ON t (a, b)', rewritten: true }
 *
 * rewriteBRIN('CREATE INDEX ix ON t (col)');
 * // → { sql: 'CREATE INDEX ix ON t (col)', rewritten: false }
 * ```
 */
export function rewriteBRIN(sql: string): BRINIndexResult {
  const trimmed = sql.trim();

  if (!detectBRIN(trimmed)) {
    // No BRIN detected — pass through unchanged
    return { sql: trimmed, rewritten: false };
  }

  // Step 1: Strip CONCURRENTLY (SQLite does not support it)
  let rewritten = stripConcurrently(trimmed);

  // Step 2: Strip USING BRIN (not supported in SQLite) → fall back to B-tree
  rewritten = stripUsingBrin(rewritten);

  logger.warn(
    { original: trimmed, rewritten },
    'BRINIndexShim: rewrite complete (BRIN → B-tree fallback — block-range optimization not available)',
  );

  return { sql: rewritten, rewritten: true };
}

// ──────────────────────────────────────────────────────────────
//  BRIN Query Rewrite — Range Pruning via WHERE EXISTS
// ──────────────────────────────────────────────────────────────

/**
 * Information needed to rewrite a query against a BRIN index.
 * Maps a BRIN-indexed column to its metadata table for range pruning.
 */
export interface BRINQueryRewrite {
  /** Name of the parent table */
  table: string;
  /** Name of the BRIN-indexed column */
  column: string;
  /** Name of the BRIN metadata table (__brin_pages_{table}_{column}) */
  metaTable: string;
  /** Whether the column is numeric/timestamp (affects comparison in SQL) */
  isNumeric: boolean;
}

/**
 * Result of BRIN query rewriting.
 */
export interface BRINQueryRewriteResult {
  /** Whether the query was rewritten (at least one BRIN prune added) */
  rewritten: boolean;
  /** The rewritten SQL (original if not rewritten) */
  sql: string;
  /** Names of the BRIN metadata tables referenced in the rewritten query */
  brinTables: string[];
  /** Number of WHERE conditions rewritten (one per BRIN column detected) */
  rewrittenConditions: number;
}

// ──────────────────────────────────────────────
//  BRIN Query Rewrite Registry
// ──────────────────────────────────────────────

const brinQueryRegistry = new Map<string, BRINQueryRewrite>();

/**
 * Register a BrinBlockRangeIndex for query rewriting.
 * This allows `rewriteBrinQuery` to find the corresponding BRIN metadata
 * table when a range operator is detected on the indexed column.
 *
 * Registers under both the unqualified column name and the qualified
 * `table.column` form.
 *
 * @param brinIndex - A BrinBlockRangeIndex instance
 *
 * @example
 * ```ts
 * const brin = new BrinBlockRangeIndex('logs', 'created_at');
 * registerBrinIndex(brin);
 * // Now queries with WHERE created_at = ... will get range pruning
 * ```
 */
export function registerBrinIndex(brinIndex: BrinBlockRangeIndex): void {
  const rewrite: BRINQueryRewrite = {
    table: brinIndex.table,
    column: brinIndex.column,
    metaTable: brinIndex.getMetaTable(),
    isNumeric: (brinIndex as any).isNumericCol ?? true,
  };

  // Register by unqualified column name
  brinQueryRegistry.set(brinIndex.column, rewrite);

  // Register by qualified name (table.column)
  brinQueryRegistry.set(`${brinIndex.table}.${brinIndex.column}`, rewrite);
}

/**
 * Unregister a BRIN index from the query rewrite registry.
 *
 * @param column - Column name (unqualified or qualified)
 * @param table - Optional table name (used to clean up qualified registration)
 *
 * @example
 * ```ts
 * unregisterBrinIndex('created_at');
 * unregisterBrinIndex('created_at', 'logs'); // Also cleans qualified name
 * ```
 */
export function unregisterBrinIndex(column: string, table?: string): void {
  // Remove unqualified entry
  brinQueryRegistry.delete(column);

  if (table) {
    // Remove qualified entry with known table name
    brinQueryRegistry.delete(`${table}.${column}`);
  } else {
    // Remove ALL qualified entries matching this column (table.col)
    for (const key of brinQueryRegistry.keys()) {
      if (key.endsWith(`.${column}`)) {
        brinQueryRegistry.delete(key);
      }
    }
  }
}

/**
 * Clear the BRIN query rewrite registry (useful for testing).
 */
export function clearBrinRegistry(): void {
  brinQueryRegistry.clear();
}

// ──────────────────────────────────────────────
//  Private helpers for query rewriting
// ──────────────────────────────────────────────

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract the value part from an operator match group.
 * For IN clauses, returns the list value as a string.
 */
function extractValue(match: RegExpExecArray, groupIndex: number): string {
  return match[groupIndex];
}

/**
 * Build a BRIN prune subquery for a given column, operator, and value(s).
 *
 * Generates SQL like:
 *   EXISTS (SELECT 1 FROM __brin_pages_t_col WHERE <condition>)
 *
 * The condition checks whether ANY page range in the BRIN metadata table
 * could contain matching rows for the predicate. If no page range could,
 * the EXISTS returns FALSE and the row is pruned.
 *
 * @param rewrite - BRIN query rewrite info (table, column, metaTable)
 * @param op - The SQL operator: '=', '>', '<', '>=', '<=', 'BETWEEN', 'IN'
 * @param value - The query value(s) as a string
 * @param parentAlias - Optional table alias in the main query
 * @returns EXISTS subquery SQL string
 *
 * @example
 * ```ts
 * buildBrinSubquery(rewrite, '=', '5')
 * // → "EXISTS (SELECT 1 FROM __brin_pages_logs_created_at
 * //     WHERE CAST(min_val AS REAL) <= 5 AND CAST(max_val AS REAL) >= 5)"
 * ```
 */
function buildBrinSubquery(
  rewrite: BRINQueryRewrite,
  op: string,
  value: string,
  parentAlias?: string,
): string {
  const normalOp = op.toUpperCase().trim();
  const metaTable = rewrite.metaTable;
  const minExpr = rewrite.isNumeric ? `CAST(min_val AS REAL)` : `min_val`;
  const maxExpr = rewrite.isNumeric ? `CAST(max_val AS REAL)` : `max_val`;

  let condition: string;

  switch (normalOp) {
    case '=':
    case '==': {
      // Range must have min <= value <= max
      condition = `${minExpr} <= ${value} AND ${maxExpr} >= ${value}`;
      break;
    }

    case '>': {
      // Range must have max > value (some value in range could be > query value)
      condition = `${maxExpr} > ${value}`;
      break;
    }

    case '<': {
      // Range must have min < value (some value in range could be < query value)
      condition = `${minExpr} < ${value}`;
      break;
    }

    case '>=': {
      // Range must have max >= value
      condition = `${maxExpr} >= ${value}`;
      break;
    }

    case '<=': {
      // Range must have min <= value
      condition = `${minExpr} <= ${value}`;
      break;
    }

    case 'BETWEEN': {
      // BETWEEN v1 AND v2: range must overlap [v1, v2]
      // Extract the two values from "v1 AND v2"
      const parts = value.split(/\s+AND\s+/i);
      const v1 = parts[0]?.trim() ?? '0';
      const v2 = parts[1]?.trim() ?? '0';
      condition = `${minExpr} <= ${v2} AND ${maxExpr} >= ${v1}`;
      break;
    }

    case 'IN': {
      // IN (v1, v2, ...): check if range overlaps with the span of values
      // The span is MIN(v1,v2,...) to MAX(v1,v2,...)
      // We use SQLite's MIN/MAX to compute inline
      condition = `${minExpr} <= (SELECT MAX(val) FROM (VALUES ${value})) AND ${maxExpr} >= (SELECT MIN(val) FROM (VALUES ${value}))`;
      break;
    }

    default:
      return '';
  }

  return `EXISTS (SELECT 1 FROM ${metaTable} br WHERE ${condition})`;
}

// ──────────────────────────────────────────────
//  Operator detection patterns
// ──────────────────────────────────────────────

/**
 * Build a regex pattern for detecting column + operator + value in SQL.
 * Returns null if the pattern doesn't match the column.
 */
function buildOpPattern(colPattern: string, operator: string): RegExp {
  // Support unqualified (col) and qualified (table.col) column references
  const escCol = escapeRegex(colPattern);
  const numVal = `(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`;
  const strVal = `('(?:[^']*(?:'')*[^']*)*')`;
  const numOrStrVal = `(?:${numVal}|${strVal})`;

  switch (operator) {
    case '=':
    case '==':
    case '>':
    case '<':
    case '>=':
    case '<=':
      return new RegExp(
        `\\b${escCol}\\s*${operator}\\s*${numOrStrVal}`,
        'i',
      );
    case 'BETWEEN':
      return new RegExp(
        `\\b${escCol}\\s+BETWEEN\\s+${numOrStrVal}\\s+AND\\s+${numOrStrVal}`,
        'i',
      );
    case 'IN':
      return new RegExp(
        `\\b${escCol}\\s+IN\\s*\\(([^)]+)\\)`,
        'i',
      );
    default:
      return /$^/; // never matches
  }
}

/**
 * Try to find an operator pattern for a column in the WHERE clause.
 * Returns match info if found, null otherwise.
 */
interface OpMatch {
  op: string;
  value: string;
  matchedText: string;
}

function findOpInWhere(whereContent: string, col: string): OpMatch | null {
  const ops = ['>=', '<=', '>', '<', '=', 'BETWEEN', 'IN'];
  // Check longer ops first to avoid partial matches
  ops.sort((a, b) => b.length - a.length);

  for (const op of ops) {
    const escaped = escapeRegex(col);

    if (op === 'BETWEEN') {
      const re = new RegExp(
        `\\b${escaped}\\s+BETWEEN\\s+(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\s+AND\\s+(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
        'i',
      );
      const m = re.exec(whereContent);
      if (m) {
        return {
          op: 'BETWEEN',
          value: `${m[1]} AND ${m[2]}`,
          matchedText: m[0],
        };
      }
    } else if (op === 'IN') {
      const re = new RegExp(
        `\\b${escaped}\\s+IN\\s*\\(([^)]+)\\)`,
        'i',
      );
      const m = re.exec(whereContent);
      if (m) {
        return {
          op: 'IN',
          value: m[1].trim(),
          matchedText: m[0],
        };
      }
    } else {
      // Single-char and two-char ops: test >= before >, <= before <, then =, ==
      const numRe = new RegExp(
        `\\b${escaped}\\s*${op}\\s*(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`,
        'i',
      );
      const m = numRe.exec(whereContent);
      if (m) {
        return {
          op,
          value: m[1],
          matchedText: m[0],
        };
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────
//  Main rewrite function
// ──────────────────────────────────────────────

/**
 * Detect and extract the WHERE clause content from a SQL statement.
 * Returns the content (without 'WHERE' keyword) and the position info.
 */
interface WhereInfo {
  /** The content after WHERE (before GROUP BY / ORDER BY / LIMIT / HAVING) */
  content: string;
  /** Index where WHERE content starts (after 'WHERE ') */
  startIndex: number;
  /** Index where WHERE clause ends */
  endIndex: number;
  /** The full SQL up to the start of WHERE content */
  prefix: string;
  /** The full SQL after the WHERE clause */
  suffix: string;
}

/**
 * Extract WHERE clause information from a SQL statement.
 * Handles deeply nested parenthesis (subqueries) to correctly
 * determine WHERE clause boundaries.
 */
function extractWhereInfo(sql: string): WhereInfo | null {
  // Find the first WHERE keyword that's part of a SELECT/UPDATE/DELETE
  // and is at the top level (not inside a subquery).
  // Strategy: find all WHERE appearances and verify they're top-level
  // by counting parenthesis depth before their position.

  const trimmedSql = sql.trim();
  const stmtType = trimmedSql.match(/^\s*(SELECT|UPDATE|DELETE|WITH)\b/i);
  if (!stmtType) return null;

  // We need to find WHERE outside of subqueries.
  // Approach: find all WHERE positions, then check each for paren balance.
  const whereRe = /\bWHERE\b/gi;
  let whereMatch: RegExpExecArray | null;

  while ((whereMatch = whereRe.exec(trimmedSql)) !== null) {
    const wherePos = whereMatch.index;

    // Count paren depth up to WHERE position
    let parenDepth = 0;
    let inString = false;
    let stringChar: string | null = null;

    for (let i = 0; i < wherePos; i++) {
      const ch = trimmedSql[i];

      if (inString) {
        if (ch === stringChar && trimmedSql[i - 1] !== '\\') {
          inString = false;
          stringChar = null;
        }
        continue;
      }

      if (ch === "'" || ch === '"') {
        inString = true;
        stringChar = ch;
        continue;
      }

      if (ch === '(') parenDepth++;
      else if (ch === ')') parenDepth--;
    }

    // Only process WHERE at top level (parenDepth === 0)
    if (parenDepth === 0) {
      const afterWhere = wherePos + 'WHERE'.length;

      // Skip whitespace after WHERE
      let contentStart = afterWhere;
      while (contentStart < trimmedSql.length && /\s/.test(trimmedSql[contentStart])) {
        contentStart++;
      }

      // Find end of WHERE clause — look for GROUP BY, ORDER BY, HAVING, LIMIT
      // at the top level
      const remaining = trimmedSql.substring(contentStart);
      let endIdx = findClauseEnd(remaining);

      const content = remaining.substring(0, endIdx).trim();
      const whereEndPos = contentStart + endIdx;
      const prefix = trimmedSql.substring(0, contentStart);
      const suffix = trimmedSql.substring(whereEndPos);

      return {
        content,
        startIndex: contentStart,
        endIndex: whereEndPos,
        prefix,
        suffix,
      };
    }
  }

  return null;
}

/**
 * Find the end of a WHERE clause by looking for top-level clause keywords.
 * Respects nested parentheses (subqueries).
 */
function findClauseEnd(sql: string): number {
  const clauseKeywords = /\b(GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|FOR\s+UPDATE|UNION|INTERSECT|EXCEPT)\b/i;

  let parenDepth = 0;
  let inString = false;
  let stringChar: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inString) {
      if (ch === stringChar && sql[i - 1] !== '\\') {
        inString = false;
        stringChar = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '(') { parenDepth++; continue; }
    if (ch === ')') { parenDepth--; continue; }

    // Only check for clause boundaries at top level
    if (parenDepth === 0) {
      clauseKeywords.lastIndex = 0;
      // Simple check: are we at the start of a clause keyword?
      const rest = sql.substring(i);
      const clauseMatch = clauseKeywords.exec(rest);
      if (clauseMatch && clauseMatch.index === 0) {
        return i;
      }
    }
  }

  return sql.length;
}

/**
 * Rewrite a SELECT/UPDATE/DELETE query to use BRIN block-range indexes
 * for WHERE clause pruning.
 *
 * Detects range operator patterns (`=`, `>`, `<`, `>=`, `<=`, `BETWEEN`, `IN`)
 * on BRIN-indexed columns in WHERE clauses and adds an EXISTS subquery that
 * checks the BRIN metadata table for page-range pruning.
 *
 * The function first checks the provided `brinIndexes` map (if given), then
 * falls back to the globally registered BRIN indexes via `registerBrinIndex()`.
 *
 * @param sql - A SQL query with potential BRIN-indexed column predicates
 * @param brinIndexes - Optional map of column name → BrinBlockRangeIndex
 *                      (if not provided, uses the registered index registry)
 * @returns A {@link BRINQueryRewriteResult} with the rewritten query
 *
 * @example
 * ```ts
 * // Register a BRIN index on logs.created_at
 * const brin = new BrinBlockRangeIndex('logs', 'created_at');
 * registerBrinIndex(brin);
 *
 * // Before:
 * //   SELECT * FROM logs WHERE created_at > 1000000
 * // After:
 * //   SELECT * FROM logs WHERE
 * //     EXISTS (SELECT 1 FROM __brin_pages_logs_created_at br
 * //       WHERE CAST(max_val AS REAL) > 1000000)
 * //     AND (created_at > 1000000)
 * ```
 */
export function rewriteBrinQuery(
  sql: string,
  brinIndexes?: Map<string, BrinBlockRangeIndex>,
): BRINQueryRewriteResult {
  const usedTables: string[] = [];
  const rewrittenConditions: string[] = [];

  // Collect all BRIN query rewrites from the provided map and/or registry
  const brinRewrites = new Map<string, BRINQueryRewrite>();

  if (brinIndexes) {
    for (const [col, idx] of brinIndexes) {
      const rewrite: BRINQueryRewrite = {
        table: idx.table,
        column: idx.column,
        metaTable: idx.getMetaTable(),
        isNumeric: (idx as any).isNumericCol ?? true,
      };
      brinRewrites.set(col, rewrite);
      brinRewrites.set(`${idx.table}.${idx.column}`, rewrite);
    }
  }

  // Fall back to registry
  if (brinRewrites.size === 0) {
    for (const [col, rewrite] of brinQueryRegistry) {
      brinRewrites.set(col, rewrite);
    }
  }

  if (brinRewrites.size === 0) {
    return { rewritten: false, sql, brinTables: [], rewrittenConditions: 0 };
  }

  // Skip non-DML queries
  const stmtType = sql.trim().match(/^\s*(SELECT|UPDATE|DELETE|WITH)\b/i);
  if (!stmtType) {
    return { rewritten: false, sql, brinTables: [], rewrittenConditions: 0 };
  }

  // Extract WHERE clause
  const whereInfo = extractWhereInfo(sql);
  if (!whereInfo) {
    return { rewritten: false, sql, brinTables: [], rewrittenConditions: 0 };
  }

  // For each registered BRIN index, check if the column appears in WHERE
  // with a range operator. Check qualified names first, then unqualified.
  const processedColumns = new Set<string>();
  const subqueries: string[] = [];

  // Check if this query has already been rewritten (idempotency guard).
  // If the SQL already references a BRIN metadata table, we skip rewriting
  // for that column to avoid double-rewriting.
  const alreadyRewrittenCols = new Set<string>();
  for (const [, rewrite] of brinRewrites) {
    if (sql.includes(rewrite.metaTable)) {
      alreadyRewrittenCols.add(rewrite.column);
    }
  }

  // Sort rewrites: qualified names first (longest → shortest) to match
  // `table.column` before just `column`
  const sortedRewrites = Array.from(brinRewrites.entries())
    .sort(([a], [b]) => b.length - a.length);

  for (const [colKey, rewrite] of sortedRewrites) {
    // Skip if we already processed this column (avoid duplicates)
    if (processedColumns.has(rewrite.column)) continue;

    // Skip if this BRIN metadata table is already referenced (idempotency)
    if (alreadyRewrittenCols.has(rewrite.column)) continue;

    const match = findOpInWhere(whereInfo.content, colKey);
    if (!match) {
      // Try just the column name (for qualified entries)
      if (colKey.includes('.')) {
        const simpleCol = colKey.split('.').pop()!;
        if (!processedColumns.has(simpleCol) && !alreadyRewrittenCols.has(simpleCol)) {
          const simpleMatch = findOpInWhere(whereInfo.content, simpleCol);
          if (!simpleMatch) continue;
          processedColumns.add(simpleCol);
          const subquery = buildBrinSubquery(rewrite, simpleMatch.op, simpleMatch.value);
          if (subquery) {
            subqueries.push(subquery);
            if (!usedTables.includes(rewrite.metaTable)) {
              usedTables.push(rewrite.metaTable);
            }
          }
          continue;
        }
      }
      continue;
    }

    processedColumns.add(rewrite.column);
    const subquery = buildBrinSubquery(rewrite, match.op, match.value);
    if (subquery) {
      subqueries.push(subquery);
      if (!usedTables.includes(rewrite.metaTable)) {
        usedTables.push(rewrite.metaTable);
      }
    }
  }

  if (subqueries.length === 0) {
    return { rewritten: false, sql, brinTables: [], rewrittenConditions: 0 };
  }

  // Build the combined EXISTS clause
  const combinedExists = subqueries.length === 1
    ? subqueries[0]
    : `(${subqueries.join(' AND\n    ')})`;

  // Insert the EXISTS subquery(ies) before the WHERE clause conditions.
  // The EXISTS is AND-ed with the original conditions.
  const rewrittenSql =
    whereInfo.prefix +
    combinedExists +
    ' AND (' +
    whereInfo.content +
    ')' +
    whereInfo.suffix;

  logger.debug(
    { original: sql, rewritten: rewrittenSql, conditions: subqueries.length, tables: usedTables },
    'BRINIndexShim: query rewritten with range pruning',
  );

  return {
    rewritten: true,
    sql: rewrittenSql,
    brinTables: usedTables,
    rewrittenConditions: subqueries.length,
  };
}
