/**
 * JsonAggShim — SQL/JSON Aggregate Constructor compatibility shim
 *
 * Implements PostgreSQL 15/16 SQL/JSON aggregate constructors by
 * rewriting them to SQLite-native json_group_object/json_group_array.
 *
 * Supported constructs:
 *   - JSON_OBJECTAGG(KEY k VALUE v)       → json_group_object(k, v)
 *   - JSON_ARRAYAGG(v)                    → json_group_array(v)
 *   - JSON_ARRAYAGG(v ORDER BY col)       → json_group_array(v ORDER BY col)
 *
 * SQLite has native json_group_object() and json_group_array() aggregate
 * functions that behave identically to the PG SQL/JSON constructors.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('JsonAggShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface JsonAggResult {
  sql: string;
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches JSON_OBJECTAGG(KEY <key_expr> VALUE <value_expr>).
 *
 * The pattern uses non-greedy matching to extract key and value expressions.
 * Uses global flag to handle multiple occurrences in one query.
 */
const JSON_OBJECTAGG_RE = /\bJSON_OBJECTAGG\s*\(\s*KEY\s+(.+?)\s+VALUE\s+(.+?)\s*\)/gi;

/**
 * Matches JSON_ARRAYAGG(<value_expr> [ORDER BY <order_expr>]).
 * Uses global flag to handle multiple occurrences in one query.
 */
const JSON_ARRAYAGG_RE = /\bJSON_ARRAYAGG\s*\(\s*([^)]+?)(?:\s+ORDER\s+BY\s+(.+?))?\s*\)/gi;

/**
 * Combined pattern to detect ANY JSON aggregate constructor.
 */
const ANY_JSON_AGG_RE = /\bJSON_(?:OBJECTAGG|ARRAYAGG)\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any JSON aggregate constructors
 * (JSON_OBJECTAGG or JSON_ARRAYAGG).
 */
export function detectJsonAgg(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return ANY_JSON_AGG_RE.test(sql);
}

/**
 * Rewrite JSON_OBJECTAGG/JSON_ARRAYAGG constructors to SQLite-compatible
 * json_group_object/json_group_array expressions.
 *
 * Rewrites:
 *   JSON_OBJECTAGG(KEY k VALUE v)       → json_group_object(k, v)
 *   JSON_ARRAYAGG(v)                    → json_group_array(v)
 *   JSON_ARRAYAGG(v ORDER BY col)       → json_group_array(v ORDER BY col)
 *
 * Handles FILTER clauses transparently (they are preserved on the outer
 * aggregate call) and passes through non-matching SQL unchanged.
 */
export function rewriteJsonAgg(sql: string): JsonAggResult {
  if (!detectJsonAgg(sql)) {
    return { sql, rewritten: false };
  }

  let rewrittenSql = sql;
  let matchFound = false;

  // 1. Rewrite JSON_OBJECTAGG(KEY k VALUE v) → json_group_object(k, v)
  //    Uses /g flag to handle multiple occurrences in one query.
  rewrittenSql = rewrittenSql.replace(
    JSON_OBJECTAGG_RE,
    (match, keyExpr: string, valueExpr: string) => {
      matchFound = true;
      const key = keyExpr.trim();
      const value = valueExpr.trim();
      return `json_group_object(${key}, ${value})`;
    },
  );

  // 2. Rewrite JSON_ARRAYAGG(v [ORDER BY col]) → json_group_array(v [ORDER BY col])
  rewrittenSql = rewrittenSql.replace(
    JSON_ARRAYAGG_RE,
    (match, valueExpr: string, orderExpr: string | undefined) => {
      matchFound = true;
      const value = valueExpr.trim();
      if (orderExpr) {
        const orderBy = orderExpr.trim();
        return `json_group_array(${value} ORDER BY ${orderBy})`;
      }
      return `json_group_array(${value})`;
    },
  );

  if (matchFound) {
    logger.debug(
      { original: sql, rewritten: rewrittenSql },
      'JSON aggregate constructor rewritten',
    );
    return { sql: rewrittenSql, rewritten: true };
  }

  // Fallback: no match found in actual replacement pass
  return { sql, rewritten: false };
}
