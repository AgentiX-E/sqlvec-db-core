/**
 * CorrelationDetector — Analyzes a LATERAL subquery for correlated column references.
 *
 * A correlation reference occurs when a subquery's WHERE clause references a
 * column from the outer query via the outer table's alias, e.g.:
 *
 *   SELECT * FROM users u,
 *   LATERAL (SELECT * FROM orders o WHERE o.user_id = u.id) sub
 *
 * Here `u.id` is a correlation reference to the outer `users` table.
 * SQLite does not support this, and simple LATERAL keyword stripping
 * produces invalid SQL because `u.id` is undefined in the inner context.
 *
 * This module detects such references and provides replacement strategies.
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('CorrelationDetector');

// ---- Types ----

export interface CorrelationRef {
  /** The outer alias, e.g. "u" from `u.id` */
  alias: string;
  /** The column name, e.g. "id" from `u.id`, or "*" from `u.*` */
  column: string;
  /** The full reference string as it appears in SQL, e.g. "u.id" */
  fullRef: string;
}

export interface CorrelationResult {
  /** Whether any correlation references were detected */
  hasCorrelation: boolean;
  /** List of detected correlation references (deduplicated) */
  refs: CorrelationRef[];
  /**
   * The subquery SQL with correlation references replaced by placeholder
   * comments, e.g. the placeholder `\/\* CORR(u.id) \*\/`.
   * This is a best-effort placeholder — the SQL will NOT be valid
   * for execution without manual rewriting.
   */
  sqlWithoutCorrelation: string;
}

// ---- Internal Helpers ----

/**
 * Compute the parenthesis nesting depth at a given position in the SQL string.
 * Returns 0 for top-level text (not inside any parentheses), 1 for text inside
 * one level of parens, etc. Handles string literals to avoid false depth.
 */
function depthAt(sql: string, pos: number): number {
  let depth = 0;
  let inString = false;
  let stringChar: string | null = null;

  const max = Math.min(pos, sql.length);
  for (let i = 0; i < max; i++) {
    const ch = sql[i];

    // Handle string literals
    if (inString) {
      if (ch === '\\') {
        i++; // skip escaped character
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    // Handle comments
    if (ch === '-' && i + 1 < max && sql[i + 1] === '-') {
      // Single-line comment: skip to end of line
      while (i < max && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && i + 1 < max && sql[i + 1] === '*') {
      // Multi-line comment: skip to */
      i += 2;
      while (i < max) {
        if (sql[i] === '*' && i + 1 < max && sql[i + 1] === '/') {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth > 0) depth--;
    }
  }

  return depth;
}

// ---- Public API ----

/**
 * Detect correlated column references in a LATERAL subquery.
 *
 * Scans `subquerySql` for patterns `alias.column` or `alias.*` where `alias`
 * appears in `outerAliases`. Only matches at the top level (depth 0) to avoid
 * picking up references inside nested subqueries.
 *
 * @param subquerySql - The SQL text inside the LATERAL subquery's parentheses,
 *   e.g. `SELECT * FROM orders o WHERE o.user_id = u.id`
 * @param outerAliases - List of table aliases from the outer query's FROM clause,
 *   e.g. `['u']` when the outer query has `FROM users u`
 * @returns CorrelationResult with detected references
 */
export function detectCorrelation(
  subquerySql: string,
  outerAliases: string[],
): CorrelationResult {
  if (!subquerySql || !outerAliases || outerAliases.length === 0) {
    return { hasCorrelation: false, refs: [], sqlWithoutCorrelation: subquerySql };
  }

  const refs: CorrelationRef[] = [];
  // Track start/end positions to replace; sort by position later
  const replacements: Array<{ start: number; end: number }> = [];

  for (const alias of outerAliases) {
    if (!alias) continue;

    // Escape regex-special characters in the alias
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedAlias}\\.(\\w+|\\*)`, 'gi');

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(subquerySql)) !== null) {
      const pos = match.index;

      // Only match at top level (depth 0) — skip matches inside nested subqueries
      if (depthAt(subquerySql, pos) !== 0) {
        continue;
      }

      // Verify the matched alias name matches case-insensitively
      const matchedAlias = match[0].substring(0, match[0].indexOf('.'));
      if (matchedAlias.toLowerCase() !== alias.toLowerCase()) {
        continue;
      }

      const fullRef = match[0];

      // Deduplicate
      if (!refs.some(r => r.fullRef === fullRef)) {
        refs.push({
          alias: matchedAlias,
          column: match[1],
          fullRef,
        });
        replacements.push({ start: pos, end: pos + fullRef.length });
      }
    }
  }

  // Build SQL with correlation refs replaced by placeholder comments
  // Process in reverse order to preserve positions
  const sortedReplacements = [...replacements].sort((a, b) => b.start - a.start);

  let sqlWithoutCorrelation = subquerySql;
  for (const { start, end } of sortedReplacements) {
    const original = sqlWithoutCorrelation.substring(start, end);
    sqlWithoutCorrelation =
      sqlWithoutCorrelation.substring(0, start) +
      `/* CORR(${original}) */` +
      sqlWithoutCorrelation.substring(end);
  }

  if (refs.length > 0) {
    logger.debug(
      { refs: refs.map(r => r.fullRef), outerAliases },
      'Detected correlation references in LATERAL subquery',
    );
  }

  return {
    hasCorrelation: refs.length > 0,
    refs,
    sqlWithoutCorrelation,
  };
}
