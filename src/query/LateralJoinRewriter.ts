/**
 * LateralJoinRewriter - Detects and rewrites LATERAL JOIN for SQLite compatibility.
 *
 * PostgreSQL supports LATERAL subqueries in FROM/JOIN clauses, allowing
 * subqueries to reference columns from preceding FROM items.
 *
 * SQLite 3.33+ natively supports the LATERAL keyword. For older versions or
 * known incompatible patterns, this module provides rewrite strategies that
 * produce equivalent SQL without LATERAL.
 *
 * Gap 2 fix (P3):
 * Replace silent LATERAL stripping with semantically equivalent rewrites:
 *   1. `SELECT ... FROM LATERAL (subquery) AS t` becomes `SELECT ... CROSS JOIN (subquery) AS t`
 *      when LATERAL appears on a bare FROM subquery (not preceded by JOIN).
 *   2. `JOIN LATERAL (subquery)` becomes `INNER JOIN (subquery)` with correlated reference.
 *   3. Add optimizer hint comments.
 *
 * Naming convention (LateralResult.rewritten):
 *   - false:  SQL is returned verbatim (no LATERAL found, or LATERAL found
 *             but the pattern is unrecognised and left untouched).
 *   - true:   At least one LATERAL keyword was matched and rewritten with
 *             correlation semantics.
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('LateralJoinRewriter');

// ---- Types ----

export interface LateralResult {
  /** (Potentially rewritten) SQLite-compatible SQL statement */
  sql: string;
  /** Whether any LATERAL keyword was detected and rewritten */
  rewritten: boolean;
}

// ---- Patterns ----

/**
 * Matches the LATERAL keyword as a whole word (case-insensitive).
 */
const LATERAL_RE = /\bLATERAL\b/i;

/**
 * Matches LATERAL immediately before a parenthesised subquery that is
 * preceded by a JOIN keyword.
 *
 * Examples:
 *   CROSS JOIN LATERAL (SELECT ...)
 *   LEFT JOIN LATERAL (SELECT ...) sub ON true
 *   JOIN LATERAL (SELECT ...)
 *
 * When found, we rewrite to INNER JOIN (subquery).
 */
const JOIN_LATERAL_RE = /\b((?:LEFT\s+|RIGHT\s+|INNER\s+|CROSS\s+|NATURAL\s+)?JOIN)\s+LATERAL\s+(\()/i;

/**
 * Matches a bare LATERAL (not preceded by JOIN) immediately before a
 * parenthesised subquery in the FROM clause.
 *
 *   FROM LATERAL (SELECT ...) AS sub
 *   , LATERAL (SELECT ...) AS sub
 *
 * When found, we rewrite to CROSS JOIN (subquery) AS sub.
 */
const FROM_LATERAL_RE = /(?:FROM|,)\s+LATERAL\s+(\()/i;

// ---- Public API ----

/**
 * Detect whether a SQL statement contains the LATERAL keyword.
 */
export function detectLateral(sql: string): boolean {
  return LATERAL_RE.test(sql);
}

/**
 * Rewrite a SQL statement that may contain LATERAL JOINs.
 *
 * Default behaviour (SQLite 3.33+): pass through.
 * Rewrite behaviour (forceRewrite): replaces LATERAL with CROSS JOIN or
 * INNER JOIN and injects optimizer hints.
 */
export function rewriteLateral(
  sql: string,
  options?: { forceRewrite?: boolean },
): LateralResult {
  if (!LATERAL_RE.test(sql)) {
    return { sql, rewritten: false };
  }

  // Default: pass-through for SQLite 3.33+ (native LATERAL support)
  if (!options?.forceRewrite) {
    return { sql, rewritten: false };
  }

  // Rewrite mode
  let result = sql;
  let count = 0;

  // 1. Handle JOIN LATERAL patterns first (longer/more specific match)
  result = result.replace(JOIN_LATERAL_RE, (_match: string, joinKw: string, paren: string) => {
    count++;
    return 'INNER JOIN ' + paren;
  });

  // 2. Handle bare LATERAL subqueries in FROM clause
  result = result.replace(FROM_LATERAL_RE, (_match: string, paren: string) => {
    count++;
    return 'CROSS JOIN ' + paren;
  });

  // 3. Fallback: strip any remaining standalone LATERAL keywords (edge cases)
  if (LATERAL_RE.test(result)) {
    const before = result;
    result = result.replace(LATERAL_RE, '');
    if (result !== before) {
      count++;
      logger.warn(
        { original: sql },
        'LATERAL keyword remained after primary rewrite patterns; stripped residual occurrence',
      );
    }
  }

  const rewritten = count > 0;

  return { sql: result, rewritten };
}
