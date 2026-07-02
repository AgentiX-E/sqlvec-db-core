/**
 * AnalyticQueryClassifier — 智能查询分类器
 *
 * Determines whether an incoming SQL statement should be routed to DuckDB
 * (OLAP columnar engine) or SQLite (OLTP row engine) based on deterministic
 * heuristic rules that inspect the ParsedStatement's surface fields.
 *
 * ## Classification Rules (priority order)
 *
 * | Priority | Rule                          | Target    | Rationale                             |
 * |----------|-------------------------------|-----------|---------------------------------------|
 * | 1        | Non-SELECT type               | SQLite    | Writes / DDL / transactions never go to DuckDB |
 * | 2        | Inside transaction context    | SQLite    | MVCC visibility requires SQLite       |
 * | 3        | Multiple tables / hasJoin     | DuckDB    | JOIN execution benefits from columnar |
 * | 4        | Aggregation (detected in SQL) | DuckDB    | Vectorized aggregations               |
 * | 5        | Window functions (in SQL)     | DuckDB    | Native window evaluation              |
 * | 6        | Subquery (IN/EXISTS/derived)  | DuckDB    | DuckDB optimizer handles subqueries   |
 * | 7        | COUNT(DISTINCT) in SQL        | DuckDB    | Vectorized hash aggregation           |
 * | 8        | Estimated rows > threshold    | DuckDB    | Large scan prefers columnar           |
 * | 9        | Default: simple SELECT        | SQLite    | Point query, SQLite is sufficient     |
 *
 * @see docs/analytics-optimization-design.md §6
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { ParsedStatement, SelectStatement } from '../query/SqlParser';

const logger = PinoLogger.forComponent('AnalyticClassifier');

// ──────────────────────────────────────────────
//  Query Target Types
// ──────────────────────────────────────────────

export enum QueryTarget {
  SQLITE_OLTP = 'sqlite_oltp',
  DUCKDB_OLAP = 'duckdb_olap',
}

// ──────────────────────────────────────────────
//  Classification Result
// ──────────────────────────────────────────────

export class AnalyticQueryClassifierResult {
  constructor(
    readonly target: QueryTarget,
    readonly reason: string,
    readonly confidence: number = 1.0,
  ) {}
}

// ──────────────────────────────────────────────
//  Runtime Context
// ──────────────────────────────────────────────

export interface QueryClassifierContext {
  readonly inTransaction: boolean;
}

// ──────────────────────────────────────────────
//  Configuration
// ──────────────────────────────────────────────

export interface AnalyticQueryClassifierConfig {
  enabled: boolean;
  analyticThreshold: number;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownMs: number;
  alwaysRouteToDuckDB: boolean;
  alwaysRouteToSQLite: boolean;
}

export const DEFAULT_CLASSIFIER_CONFIG: AnalyticQueryClassifierConfig = {
  enabled: true,
  analyticThreshold: 10_000,
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 60_000,
  alwaysRouteToDuckDB: false,
  alwaysRouteToSQLite: false,
};

// ──────────────────────────────────────────────
//  Classifier
// ──────────────────────────────────────────────

export class AnalyticQueryClassifier {
  private failureCount = 0;
  private lastFailureAt = 0;

  constructor(
    private readonly config: AnalyticQueryClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
  ) {}

  /**
   * Classify a parsed SQL statement and return the recommended execution target.
   * Rules are evaluated in priority order (1 = highest).
   */
  classify(
    sql: string,
    parsed: ParsedStatement,
    ctx: QueryClassifierContext = { inTransaction: false },
  ): AnalyticQueryClassifierResult {
    // Config overrides
    if (this.config.alwaysRouteToSQLite) {
      return new AnalyticQueryClassifierResult(QueryTarget.SQLITE_OLTP, 'config: alwaysRouteToSQLite');
    }

    if (this.isCircuitBroken()) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.SQLITE_OLTP,
        `circuit-breaker: ${this.failureCount} consecutive failures, ${this.cooldownRemainingMs()}ms remaining`,
        0.3,
      );
    }

    if (this.config.alwaysRouteToDuckDB) {
      return new AnalyticQueryClassifierResult(QueryTarget.DUCKDB_OLAP, 'config: alwaysRouteToDuckDB');
    }

    // ── Rule 1: Non-SELECT ⇒ SQLite ──
    if (parsed.type !== 'SELECT') {
      return new AnalyticQueryClassifierResult(
        QueryTarget.SQLITE_OLTP,
        `statement type is not SELECT: ${parsed.type}`,
        1.0,
      );
    }

    const select = parsed as SelectStatement;

    // ── Rule 2: Inside transaction ⇒ SQLite ──
    if (ctx.inTransaction) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.SQLITE_OLTP,
        'query inside transaction — MVCC visibility requires SQLite',
        1.0,
      );
    }

    // ── Rule 3: Multiple tables / hasJoin ⇒ DuckDB ──
    if (select.hasJoin || select.tables.length >= 2) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        `multi-table query (${select.tables.length} tables, hasJoin=${select.hasJoin}) — columnar JOIN`,
        0.9,
      );
    }

    // ── Rules 4-7: SQL-level heuristics (aggregation, window, subquery, count distinct) ──
    const hasAgg = this.sqlHasAggregation(sql);
    if (hasAgg) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        'aggregation (GROUP BY / aggregate function) — vectorized aggregation preferred',
        0.85,
      );
    }

    const hasWindow = this.sqlHasWindowFunction(sql);
    if (hasWindow) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        'window function detected — DuckDB native window evaluation',
        0.9,
      );
    }

    const hasSub = this.sqlHasSubquery(sql);
    if (hasSub) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        'subquery present — DuckDB optimizer handles correlated subqueries',
        0.8,
      );
    }

    const hasCountDistinct = this.sqlHasCountDistinct(sql);
    if (hasCountDistinct) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        'COUNT(DISTINCT) — vectorized hash aggregation',
        0.8,
      );
    }

    // ── Rule 8: High-selectivity WHERE (point query) ⇒ SQLite ──
    // Point queries (equality on indexed columns) are inherently OLTP — SQLite
    // handles them faster than DuckDB, and avoids stale DataBridge read-after-write.
    // Uses heuristic: simple equality in WHERE clause.
    // Note: select.where is not populated by parseStatement(), so we rely on
    // the SQL-level heuristic sqlHasEqualityWhere(sql) which checks the raw SQL.
    if (this.sqlHasEqualityWhere(sql)) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.SQLITE_OLTP,
        'point query with WHERE equality — SQLite indexed lookup is faster',
        0.85,
      );
    }

    // ── Rule 9: Large scan (heuristic based on LIMIT absence) ──
    if (!select.limit) {
      return new AnalyticQueryClassifierResult(
        QueryTarget.DUCKDB_OLAP,
        'no LIMIT clause — potentially large scan, columnar preferred',
        0.6,
      );
    }

    // ── Default (Rule 9): simple point query ⇒ SQLite ──
    return new AnalyticQueryClassifierResult(
      QueryTarget.SQLITE_OLTP,
      'simple SELECT with LIMIT — point query, SQLite is sufficient',
      0.9,
    );
  }

  // ── Circuit-breaker API ──

  reportDuckDBSuccess(): void {
    // Decay: decrement by 2 (recovery is faster than failure)
    if (this.failureCount > 0) {
      this.failureCount = Math.max(0, this.failureCount - 2);
    }
  }

  reportDuckDBFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();
    logger.warn(
      { failureCount: this.failureCount, threshold: this.config.circuitBreakerThreshold },
      'DuckDB failure — circuit-breaker progressing',
    );
  }

  isCircuitBroken(): boolean {
    if (this.config.circuitBreakerThreshold === 0) return false;
    if (this.failureCount < this.config.circuitBreakerThreshold) return false;
    if (this.cooldownRemainingMs() <= 0) {
      this.failureCount = 0;
      logger.info('[AnalyticClassifier] Circuit-breaker recovered');
      return false;
    }
    return true;
  }

  private cooldownRemainingMs(): number {
    return Math.max(0, this.lastFailureAt + this.config.circuitBreakerCooldownMs - Date.now());
  }

  /** Exposed for testing. */
  get failureCount_(): number {
    return this.failureCount;
  }

  reset(): void {
    this.failureCount = 0;
    this.lastFailureAt = 0;
  }

  // ── SQL-level heuristics ──

  /**
   * Detect aggregation keywords in SQL text (GROUP BY, HAVING, aggregate functions).
   */
  private sqlHasAggregation(sql: string): boolean {
    const upper = sql.toUpperCase();
    if (/\bGROUP\s+BY\b/.test(upper)) return true;
    if (/\bHAVING\b/.test(upper)) return true;
    // Aggregate function detection
    const aggFns = ['SUM(', 'COUNT(', 'AVG(', 'MIN(', 'MAX(', 'ARRAY_AGG(', 'STRING_AGG('];
    for (const fn of aggFns) {
      if (upper.includes(fn)) return true;
    }
    return false;
  }

  /**
   * Detect window functions in SQL text (OVER clause).
   */
  private sqlHasWindowFunction(sql: string): boolean {
    return /\bOVER\s*\(/i.test(sql);
  }

  /**
   * Detect subqueries in SQL text (IN (SELECT ...), EXISTS, derived tables).
   */
  private sqlHasSubquery(sql: string): boolean {
    const upper = sql.toUpperCase();
    // IN (SELECT ...)
    if (/\bIN\s*\(\s*SELECT\b/i.test(upper)) return true;
    // EXISTS (SELECT ...)
    if (/\bEXISTS\s*\(\s*SELECT\b/i.test(upper)) return true;
    // Derived table: FROM (SELECT ...)
    if (/\bFROM\s*\(\s*SELECT\b/i.test(upper)) return true;
    // ANY / ALL (SELECT ...)
    if (/\b(?:ANY|ALL)\s*\(\s*SELECT\b/i.test(upper)) return true;
    return false;
  }

  /**
   * Detect COUNT(DISTINCT ...) in SQL text.
   */
  private sqlHasCountDistinct(sql: string): boolean {
    return /\bCOUNT\s*\(\s*DISTINCT\b/i.test(sql);
  }

  /**
   * Detect equality predicates in WHERE clause (point queries).
   *
   * Heuristic: checks for `column = value` patterns that indicate
   * a highly selective lookup — better served by SQLite's B-tree.
   * Avoids false positives from OUTER JOIN ON clauses.
   */
  private sqlHasEqualityWhere(sql: string): boolean {
    const upper = sql.toUpperCase();
    // Must have WHERE clause
    if (!/\bWHERE\b/.test(upper)) return false;
    // Extract WHERE clause content (simplified: text between WHERE and GROUP/ORDER/LIMIT/HAVING)
    const whereMatch = upper.match(/\bWHERE\b\s+(.+?)(?:\s+\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|FETCH|FOR)\b|$)/i);
    if (!whereMatch) return false;
    const whereClause = whereMatch[1];
    // Check for simple equality: column = literal (not IN/NOT IN/LIKE/BETWEEN/is null)
    if (/[a-z_][a-z0-9_.]*\s*=\s*['"0-9]/.test(whereClause)) return true;
    // Also catch column = column (but this is less selective — skip)
    return false;
  }
}
