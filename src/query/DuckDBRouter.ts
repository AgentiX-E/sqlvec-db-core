/**
 * DuckDBRouter — Route SQL queries to DuckDB for native execution
 *
 * Two routing modes:
 *   1. **Pattern-based** (legacy) — Detect PG-specific SQL patterns (PIVOT, QUALIFY, etc.)
 *      that DuckDB natively supports but SQLite cannot.
 *   2. **Classifier-based** (P0+) — Use AnalyticQueryClassifier for intelligent routing
 *      of complex SELECT queries (JOIN, aggregation, window functions, subqueries)
 *      to DuckDB columnar engine.
 *
 * Both paths gracefully degrade: if DuckDB/sqlite_scanner is unavailable, returns
 * a fallback indicator so the caller can try the standard SQLite path.
 *
 * ## Routable Patterns (Legacy)
 *
 * | Pattern          | DuckDB Support | Kind             |
 * |------------------|----------------|------------------|
 * | PIVOT ... IN ... | Native         | `pivot`          |
 * | QUALIFY          | Native         | `qualify`        |
 * | SELECT * EXCLUDE | Native         | `exclude_col`    |
 * | LISTAGG          | Native         | `listagg`        |
 * | GROUP BY ALL     | Native         | `group_by_all`   |
 *
 * ## Flow
 *
 * ```
 * tryRouteDuckDB(sql, duckDB, start, classifier, parsed, ctx)
 *   ├─ Classifier available + parsed
 *   │   └─ classify(sql) → DUCKDB_OLAP → execute & return
 *   │   └─ classify(sql) → SQLITE_OLTP → return { routed: false }
 *   └─ Classifier unavailable (legacy)
 *       └─ detectDuckDBPattern(sql) → match → execute & return
 *       └─ detectDuckDBPattern(sql) → null → return { routed: false }
 * ```
 */

import { PinoLogger } from '../logger/PinoLogger';
import {
  DuckDBAnalyticsManager,
  DuckDBResult,
} from '../analytics/DuckDBAnalyticsManager';
import {
  AnalyticQueryClassifier,
  AnalyticQueryClassifierResult,
  QueryTarget,
  QueryClassifierContext,
} from '../analytics/AnalyticQueryClassifier';
import { ParsedStatement } from './SqlParser';
import type { AnalyticsFederationClient } from '../analytics/AnalyticsFederationClient';

const logger = PinoLogger.forComponent('DuckDBRouter');

// ──────────────────────────────────────────────
//  Pattern Detection (Legacy)
// ──────────────────────────────────────────────

/**
 * Detected PG SQL pattern types that can be routed to DuckDB.
 */
export enum DuckDBPattern {
  PIVOT = 'pivot',
  QUALIFY = 'qualify',
  EXCLUDE_COL = 'exclude_col',
  LISTAGG = 'listagg',
  GROUP_BY_ALL = 'group_by_all',
  UNPIVOT = 'unpivot',
  /** LATERAL subquery in FROM/JOIN */
  LATERAL = 'lateral',
  /** Window function FILTER (WHERE ...) clause */
  FILTER_CLAUSE = 'filter_clause',
  /** TABLESAMPLE / USING SAMPLE */
  TABLESAMPLE = 'tablesample',
  /** Approximate aggregates (approx_count_distinct, approx_median, approx_quantile) */
  APPROX_AGG = 'approx_agg',
}

const PATTERN_DETECTORS: Array<{ kind: DuckDBPattern; re: RegExp }> = [
  // PIVOT: SELECT ... FROM ... PIVOT (... FOR ... IN (...))
  { kind: DuckDBPattern.PIVOT, re: /\bPIVOT\s*\(/i },
  // UNPIVOT: SELECT ... FROM ... UNPIVOT (... FOR ... IN (...))
  { kind: DuckDBPattern.UNPIVOT, re: /\bUNPIVOT\s*\(/i },
  // QUALIFY: SELECT ... QUALIFY row_number() OVER (...)
  { kind: DuckDBPattern.QUALIFY, re: /\bQUALIFY\s+(?:ROW_NUMBER|RANK|DENSE_RANK|NTILE|LEAD|LAG|FIRST_VALUE|LAST_VALUE|NTH_VALUE|COUNT|SUM|AVG|MIN|MAX)\s*\(/i },
  // SELECT * EXCLUDE col / SELECT * REPLACE (col / 2 AS col)
  { kind: DuckDBPattern.EXCLUDE_COL, re: /\bEXCLUDE\s+\(/i },
  // LISTAGG(col, delimiter)
  { kind: DuckDBPattern.LISTAGG, re: /\bLISTAGG\s*\(/i },
  // GROUP BY ALL
  { kind: DuckDBPattern.GROUP_BY_ALL, re: /\bGROUP\s+BY\s+ALL\b/i },
  // LATERAL: FROM ... LATERAL (SELECT ...)
  { kind: DuckDBPattern.LATERAL, re: /\bLATERAL\s*\(/i },
  // FILTER clause in window functions: agg(x) FILTER (WHERE ...) OVER (...)
  { kind: DuckDBPattern.FILTER_CLAUSE, re: /FILTER\s*\(\s*WHERE\b/i },
  // TABLESAMPLE: FROM ... TABLESAMPLE BERNOULLI|SYSTEM|USING SAMPLE
  { kind: DuckDBPattern.TABLESAMPLE, re: /\bTABLESAMPLE\s+(?:BERNOULLI|SYSTEM)\b|\bUSING\s+SAMPLE\b/i },
  // Approximate aggregates: approx_count_distinct, approx_median, approx_quantile
  { kind: DuckDBPattern.APPROX_AGG, re: /\b(?:approx_count_distinct|approx_median|approx_quantile)\s*\(/i },
];

/**
 * Debug: export the actual regexes as strings for unit testing.
 */
export function getPatternDebugInfo(): Array<{ kind: DuckDBPattern; pattern: string }> {
  return PATTERN_DETECTORS.map(p => ({ kind: p.kind, pattern: p.re.source }));
}

/**
 * Detect whether a SQL statement contains a DuckDB-routable PG pattern.
 * @returns The detected pattern kind, or null if none detected.
 */
export function detectDuckDBPattern(sql: string): DuckDBPattern | null {
  if (typeof sql !== 'string' || !sql.trim()) return null;
  for (const { kind, re } of PATTERN_DETECTORS) {
    if (re.test(sql)) return kind;
  }
  return null;
}

// ──────────────────────────────────────────────
//  SQL Rewriting (PG → DuckDB)
// ──────────────────────────────────────────────

/**
 * Rewrite a PG SQL statement for DuckDB compatibility.
 * Most PG patterns are already natively supported by DuckDB, but some syntax
 * adjustments may be needed (e.g., removing ::type casts that differ).
 *
 * @param sql    Original PG SQL
 * @param kind   Detected pattern kind
 * @returns      DuckDB-compatible SQL
 */
export function rewriteForDuckDB(sql: string, _kind: DuckDBPattern): string {
  // DuckDB's PG compatibility is high — most patterns pass through unchanged.
  // Future: handle specific PG → DuckDB syntax differences here.
  return sql;
}

// ──────────────────────────────────────────────
//  Result Mapping (DuckDB → PG-compatible)
// ──────────────────────────────────────────────

export interface DuckDBRouteResult {
  routed: boolean;
  reason?: string;
  pattern?: DuckDBPattern;
  classification?: AnalyticQueryClassifierResult;
  result?: { rows: any[]; rowCount: number; queryTimeMs: number; engine: 'duckdb' };
}

/**
 * Map a DuckDB result to a format compatible with QueryRouter's expected output.
 * Column names and types are preserved; row data is returned as-is.
 */
export function mapDuckDBResult(result: DuckDBResult, originalSql: string): {
  rows: any[];
  rowCount: number;
  queryTimeMs: number;
  engine: 'duckdb';
} {
  return {
    rows: result.rows,
    rowCount: result.rowCount,
    queryTimeMs: 0, // caller should measure
    engine: 'duckdb',
  };
}

// ──────────────────────────────────────────────
//  Route Interface — P0 Enhanced
// ──────────────────────────────────────────────

/**
 * Try to route a SQL query through DuckDB.
 *
 * @param sql        Original PG SQL statement
 * @param duckDB     DuckDBAnalyticsManager instance
 * @param startTime  Performance start time (for queryTimeMs)
 * @param classifier Optional: AnalyticQueryClassifier for intelligent routing
 * @param parsed     Optional: ParsedStatement (required when classifier is provided)
 * @param ctx        Optional: QueryClassifierContext (transaction state, etc.)
 * @returns          RouteResult indicating whether the query was routed + result
 */
export async function tryRouteDuckDB(
  sql: string,
  duckDB: DuckDBAnalyticsManager,
  startTime: number,
  classifier?: AnalyticQueryClassifier,
  parsed?: ParsedStatement,
  ctx?: QueryClassifierContext,
  fedClient?: AnalyticsFederationClient,
): Promise<DuckDBRouteResult> {
  // Check availability
  if (!duckDB.isAvailable) {
    logger.warn('[RT] DuckDB unavailable');
    return { routed: false, reason: 'DuckDB unavailable' };
  }

  // ── Mode 1: Classifier-based routing (P0+) ──
  if (classifier && parsed) {
    const decision = classifier.classify(sql, parsed, ctx ?? { inTransaction: false });
    if (decision.target !== QueryTarget.DUCKDB_OLAP) {
      logger.debug('[RT] Classifier says NO:%s', decision.reason?.substring(0, 60));
      return {
        routed: false,
        reason: `classifier: ${decision.reason}`,
        classification: decision,
      };
    }

    // Classifier says DuckDB — execute
    logger.debug('[RT] Classifier says YES -> DuckDB');
    return executeOnDuckDB(sql, duckDB, startTime, classifier, undefined, fedClient);
  }

  // ── Mode 2: Legacy pattern-based routing ──
  const pattern = detectDuckDBPattern(sql);
  if (!pattern) {
    return { routed: false, reason: 'No routable pattern detected' };
  }

  logger.debug({ pattern: pattern.toString(), sql: sql.substring(0, 80) }, 'Pattern routed to DuckDB');
  return executeOnDuckDB(sql, duckDB, startTime, classifier, pattern);
}

/**
 * Execute a SQL query on DuckDB and format the result.
 * Shared by both routing modes.
 */
async function executeOnDuckDB(
  sql: string,
  duckDB: DuckDBAnalyticsManager,
  startTime: number,
  classifier?: AnalyticQueryClassifier,
  pattern?: DuckDBPattern,
  fedClient?: AnalyticsFederationClient,
): Promise<DuckDBRouteResult> {
  try {
    let result: DuckDBResult;

    if (fedClient) {
      // Use federation client for distributed strategy selection
      result = await fedClient.executeDistributed(sql);
    } else {
      const rewrittenSql = rewriteForDuckDB(sql, pattern ?? DuckDBPattern.PIVOT); // placeholder kind — rewrite is no-op
      result = await duckDB.execute(rewrittenSql);
    }

    const mapped = mapDuckDBResult(result, sql);
    mapped.queryTimeMs = performance.now() - startTime;

    classifier?.reportDuckDBSuccess();

    return {
      routed: true,
      pattern,
      result: mapped,
    };
  } catch (err: any) {
    logger.warn({ err: err.message }, 'DuckDB execution failed');
    classifier?.reportDuckDBFailure();
    return { routed: false, reason: `DuckDB execution error: ${err.message}`, pattern };
  }
}
