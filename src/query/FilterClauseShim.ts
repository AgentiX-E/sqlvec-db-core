/**
 * FilterClauseShim — PostgreSQL FILTER (WHERE) aggregate clause compatibility for SQLite.
 *
 * PostgreSQL supports FILTER (WHERE condition) on aggregate and window functions:
 *   SELECT SUM(x) FILTER (WHERE x > 0) FROM t
 *
 * SQLite does not support the FILTER syntax. This shim rewrites it to an equivalent
 * CASE WHEN expression:
 *   SUM(x) FILTER (WHERE x > 0) → SUM(CASE WHEN x > 0 THEN x END)
 *
 * ## Strategy
 *
 * Instead of a fragile one-shot regex that fails on nested parens or string literals
 * containing commas/parens, we use a scanner-based approach:
 *   1. Find `FILTER (WHERE ...)` via regex
 *   2. Walk backward to find the matching aggregate function
 *      (using balanced-parenthesis matching)
 *   3. Walk forward to check for an optional OVER clause
 *   4. Replace with the CASE WHEN equivalent
 *
 * Supported aggregate functions: SUM, AVG, COUNT, MIN, MAX, ARRAY_AGG,
 * STRING_AGG, json_agg, jsonb_agg.
 *
 * ## Rewrite rules
 *
 * | Input                                                    | Output                                                |
 * |----------------------------------------------------------|-------------------------------------------------------|
 * | `SUM(x) FILTER (WHERE x > 0)`                            | `SUM(CASE WHEN (x > 0) THEN x END)`                   |
 * | `count(*) FILTER (WHERE x > 0)`                          | `count(CASE WHEN (x > 0) THEN 1 END)`                 |
 * | `AVG(x) FILTER (WHERE x IS NOT NULL)`                    | `AVG(CASE WHEN (x IS NOT NULL) THEN x END)`           |
 * | `SUM(x) FILTER (WHERE cond) OVER (PARTITION BY y)`       | `SUM(CASE WHEN (cond) THEN x END) OVER (PARTITION BY y)` |
 * | `ARRAY_AGG(x ORDER BY y) FILTER (WHERE x > 0)`           | `ARRAY_AGG(CASE WHEN (x > 0) THEN x ORDER BY y END)`  |
 * | `STRING_AGG(x, ',') FILTER (WHERE x IS NOT NULL)`        | `STRING_AGG(CASE WHEN (x IS NOT NULL) THEN x END, ',')` |
 * | Multiple FILTERs in same query                            | Each rewritten independently                          |
 * | No FILTER clause                                          | Pass through unchanged                                |
 * | FILTER inside a string literal or comment                 | Not matched (protected)                               |
 *
 * @module FilterClauseShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('FilterClauseShim');

// ── Types ────────────────────────────────────────────────────────

export interface FilterClauseResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/** Aggregate function names supported by FILTER clause. */
const AGG_FUNC_NAMES = [
  'SUM', 'AVG', 'COUNT', 'MIN', 'MAX',
  'ARRAY_AGG', 'STRING_AGG',
  'json_agg', 'jsonb_agg',
];

/** Compiled regex for aggregate function name detection at end of string segment. */
const AGG_FUNC_AT_END_RE = new RegExp(
  `(${AGG_FUNC_NAMES.join('|')})\\s*\\(\\s*$`,
  'i',
);

/**
 * Regex to find `FILTER (WHERE ...)` clause positions.
 * Used as the scanner anchor; each match is then processed via balanced-paren walking.
 */
const FILTER_WHERE_RE = /FILTER\s*\(\s*WHERE\b/gi;

/**
 * Over clause detection — `OVER (...)`. Used after the FILTER clause.
 */
const OVER_CLAUSE_RE = /^OVER\s*\(/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a FILTER (WHERE) clause on an
 * aggregate or window function.
 *
 * Strips string/comment content before scanning to avoid false positives.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if a FILTER clause is detected
 */
export function detectFilter(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  const stripped = stripSqlLiterals(sql);
  FILTER_WHERE_RE.lastIndex = 0;
  return FILTER_WHERE_RE.test(stripped);
}

/**
 * Rewrite a SQL string, replacing FILTER (WHERE) clauses on aggregate/window
 * functions with CASE WHEN expressions.
 *
 * Uses a scanner-based approach for robustness against nested parentheses
 * and string literals.
 *
 * @param sql - The raw SQL string to process
 * @returns A FilterClauseResult with the rewritten SQL and a flag
 */
export function rewriteFilter(sql: string): FilterClauseResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick pre-check: any FILTER at all?
  const stripped = stripSqlLiterals(sql);
  FILTER_WHERE_RE.lastIndex = 0;
  if (!FILTER_WHERE_RE.test(stripped)) {
    return { sql, rewritten: false };
  }

  // Collect replacements (start, end, new text) from the original sql,
  // then apply them in reverse to preserve indices.
  interface Replacement {
    start: number;
    end: number;
    text: string;
  }
  const replacements: Replacement[] = [];

  FILTER_WHERE_RE.lastIndex = 0;

  while (true) {
    const filterMatch = FILTER_WHERE_RE.exec(sql);
    if (!filterMatch) break;

    const filterWhereStart = filterMatch.index;
    const filterFullStart = filterWhereStart; // "FILTER" starts here

    // Find the opening paren of FILTER(...)
    const filterOpen = sql.indexOf('(', filterWhereStart);
    if (filterOpen === -1) continue;

    // Find matching closing paren
    const filterClose = _findMatchingParen(sql, filterOpen);
    if (filterClose === -1) continue;

    // Extract WHERE condition from within the FILTER parens
    const filterInner = sql.slice(filterOpen + 1, filterClose).trim();
    const whereContentMatch = filterInner.match(/^WHERE\s+(.*)$/is);
    if (!whereContentMatch) continue;
    const cond = whereContentMatch[1].trim();

    // ── Walk backward to find the aggregate function ──────────

    // Skip whitespace backward
    let pos = filterWhereStart - 1;
    while (pos >= 0 && /\s/.test(sql[pos])) pos--;
    if (pos < 0) continue;

    // The char right before FILTER should be ')' (the agg func's closing paren)
    if (sql[pos] !== ')') {
      // It could also be a function call like FUNC()FILTER(WHERE...) without space
      // OR it could be a standalone FILTER not associated with an agg function
      // Let's try to find a closing paren nearby (within reasonable distance)
      // For the scanner, if there's no ')' nearby, skip this FILTER
      // Check if it's preceded by something like "COUNT(*)...FILTER"
      // The regex-based approach in AGG_FUNC_AT_END might help
      continue;
    }

    const aggCloseParen = pos;

    // Find matching opening paren for the agg function
    const aggOpenParen = _findMatchingOpenParen(sql, aggCloseParen);
    if (aggOpenParen === -1) continue;

    const aggExpr = sql.slice(aggOpenParen + 1, aggCloseParen).trim();

    // Find the function name before the opening paren
    const beforeOpen = sql.slice(0, aggOpenParen).trimEnd();
    const funcMatch = beforeOpen.match(
      new RegExp(`(${AGG_FUNC_NAMES.join('|')})\\s*$`, 'i'),
    );
    if (!funcMatch) continue;

    const func = funcMatch[1];
    const funcStart = funcMatch.index!;

    // ── Check for optional OVER clause after FILTER ───────────

    const afterFilterRaw = sql.slice(filterClose + 1);
    const filterSuffixTrimLen = afterFilterRaw.length - afterFilterRaw.trimStart().length;
    const afterFilter = afterFilterRaw.trimStart();
    let overClause: string | null = null;
    let overLen = 0;

    const overMatch = afterFilter.match(OVER_CLAUSE_RE);
    if (overMatch) {
      // Find the opening ( of OVER(...)
      const overOpen = afterFilter.indexOf('(', overMatch.index!);
      if (overOpen !== -1) {
        const overClose = _findMatchingParen(afterFilter, overOpen);
        if (overClose !== -1) {
          overClause = afterFilter.slice(overMatch.index!, overClose + 1);
          overLen = filterSuffixTrimLen + overClose + 1;
        }
      }
    }

    // ── Compute full span ──────────────────────────────────────

    const fullStart = funcStart;
    const fullEnd = overClause
      ? filterClose + 1 + overLen
      : filterClose + 1;

    // ── Build replacement ─────────────────────────────────────

    const funcUpper = func.toUpperCase();
    let replacement: string;

    if (aggExpr === '*' && funcUpper === 'COUNT') {
      // count(*) FILTER (WHERE cond) → count(CASE WHEN (cond) THEN 1 END)
      const newExpr = `CASE WHEN (${cond}) THEN 1 END`;
      replacement = `count(${newExpr})`;
    } else if (funcUpper === 'STRING_AGG') {
      // STRING_AGG(value_expr, delimiter) — only wrap the first argument
      // This handles cases like STRING_AGG(x, ',') and STRING_AGG(x ORDER BY y, sep)
      const aggArgs = _topLevelSplit(aggExpr, ',');
      if (aggArgs.length >= 2) {
        const valueExpr = aggArgs[0].trim();
        const delimiter = aggArgs.slice(1).join(',').trim();
        const newExpr = `CASE WHEN (${cond}) THEN ${valueExpr} END`;
        replacement = `${func}(${newExpr}, ${delimiter})`;
      } else {
        // Single argument STRING_AGG (no explicit delimiter)
        const newExpr = `CASE WHEN (${cond}) THEN ${aggExpr} END`;
        replacement = `${func}(${newExpr})`;
      }
    } else {
      // Single-argument or func(x ORDER BY y) aggregates: wrap the entire expression
      const newExpr = `CASE WHEN (${cond}) THEN ${aggExpr} END`;
      replacement = `${func}(${newExpr})`;
    }

    if (overClause) {
      replacement += ` ${overClause}`;
    }

    // Store for later application
    replacements.push({
      start: fullStart,
      end: fullEnd,
      text: replacement,
    });

    // Advance regex lastIndex past this match to continue scanning
    FILTER_WHERE_RE.lastIndex = fullEnd;
  }

  // ── Apply replacements in reverse (bottom-up) ───────────────

  if (replacements.length === 0) {
    return { sql, rewritten: false };
  }

  // Sort by start descending so that applying doesn't shift indices
  replacements.sort((a, b) => b.start - a.start);

  // Deduplicate overlapping replacements
  const deduped: Replacement[] = [];
  for (const rep of replacements) {
    const overlaps = deduped.some(
      (d) =>
        (rep.start >= d.start && rep.start < d.end) ||
        (d.start >= rep.start && d.start < rep.end),
    );
    if (!overlaps) {
      deduped.push(rep);
    }
  }

  const resultArr = sql.split('');
  for (const { start, end, text } of deduped) {
    if (start >= 0 && end <= resultArr.length && start < end) {
      resultArr.splice(start, end - start, text);
    }
  }
  const result = resultArr.join('');

  logger.debug(
    { original: sql, rewritten: result },
    'FILTER clause rewritten as CASE WHEN',
  );

  return { sql: result, rewritten: true };
}

// ══════════════════════════════════════════════════════════════════
//  Internal Helpers
// ══════════════════════════════════════════════════════════════════

/**
 * Strip SQL string literals, identifiers, and comments to prevent false matches
 * on FILTER keywords inside strings or comments.
 *
 * Replaces matched content with same-length placeholder text (underscores)
 * to preserve character positions.
 *
 * Each token kind is matched with escape awareness so an embedded doubled
 * quote (`''` / `""`) does not prematurely terminate the token and shift the
 * placeholder alignment.
 */
function stripSqlLiterals(sql: string): string {
  let result = sql;
  // Single-quoted strings (dollar-escaped '' → '')
  result = result.replace(/'(?:[^']|'')*'/g, (m) => '_'.repeat(m.length));
  // Double-quoted identifiers (doubled "" → "")
  result = result.replace(/"(?:[^"]|"")*"/g, (m) => '_'.repeat(m.length));
  // Line comments
  result = result.replace(/--[^\n]*/g, (m) => '_'.repeat(m.length));
  // Block comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, (m) => '_'.repeat(m.length));
  return result;
}

/**
 * Find the matching closing parenthesis for the opening parenthesis at `openPos`.
 * Returns the index of the matching `)`, or -1 if not found.
 *
 * Exported (underscore-prefixed) for direct unit testing of its defensive
 * guard branches.
 */
export function _findMatchingParen(sql: string, openPos: number): number {
  if (openPos < 0 || openPos >= sql.length || sql[openPos] !== '(') {
    return -1;
  }
  let depth = 1;
  for (let i = openPos + 1; i < sql.length; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Find the matching opening parenthesis for the closing parenthesis at `closePos`.
 * Returns the index of the matching `(`, or -1 if not found.
 *
 * Exported (underscore-prefixed) for direct unit testing of its defensive
 * guard branches.
 */
/**
 * Find the matching opening parenthesis for the closing parenthesis at `closePos`.
 * Returns the index of the matching `(`, or -1 if not found.
 *
 * Walks right-to-left while skipping string literals (including `''` escapes)
 * so an unbalanced `(` or `)` inside a string does not corrupt paren counting.
 *
 * Exported (underscore-prefixed) for direct unit testing of its defensive
 * guard branches.
 */
export function _findMatchingOpenParen(sql: string, closePos: number): number {
  if (closePos < 0 || closePos >= sql.length || sql[closePos] !== ')') {
    return -1;
  }
  let depth = 1;
  for (let i = closePos - 1; i >= 0; i--) {
    // Skip a string literal by scanning back over it in reverse. A trailing
    // single quote marks the end of a literal; we walk back to its opening
    // quote, honoring `''` escapes.
    if (sql[i] === "'") {
      let j = i - 1;
      for (; j >= 0; j--) {
        if (sql[j] === "'") {
          if (j > 0 && sql[j - 1] === "'") {
            j--; // doubled quote escape, keep going
          } else {
            break; // opening quote
          }
        }
      }
      i = j; // continue scanning before the opening quote
      continue;
    }

    if (sql[i] === ')') depth++;
    else if (sql[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a string at the top level by a delimiter, respecting parentheses and
 * string literal boundaries.
 *
 * This is essential for correctly handling multi-argument aggregate function
 * expressions like STRING_AGG(x, ','), where the comma inside the string
 * literal should NOT be a split point.
 *
 * Exported (underscore-prefixed) for direct unit testing of its defensive
 * guard branches.
 *
 * @param text - The string to split
 * @param delimiter - The delimiter character (typically ',')
 * @returns Array of trimmed substrings split at the top level
 */
export function _topLevelSplit(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (let i = 0; i < text.length; ) {
    const skipped = skipSqlLiteral(text, i);
    if (skipped !== -1) {
      current += text.slice(i, skipped);
      i = skipped;
      continue;
    }

    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === delimiter && depth === 0) {
      parts.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}
