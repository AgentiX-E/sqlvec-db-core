/**
 * CteDepthLimiter — PostgreSQL max_recursive_query_depth compatibility for SQLite.
 *
 * PostgreSQL's `max_recursive_query_depth` GUC controls max recursion depth
 * of recursive CTEs (default: 100). When exceeded, PG raises error 42P17
 * (infinite recursion detected).
 *
 * ## Strategy
 *
 * Rewrite recursive CTEs with a depth counter column + WHERE clause:
 *
 * Input:
 *   WITH RECURSIVE t(n) AS (
 *     SELECT 1
 *     UNION ALL
 *     SELECT n+1 FROM t WHERE n < 200
 *   ) SELECT * FROM t
 *
 * Output:
 *   WITH RECURSIVE t(n, __sqldepth) AS (
 *     SELECT 1, 1
 *     UNION ALL
 *     SELECT n+1, __sqldepth+1 FROM t WHERE n < 200 AND __sqldepth < 100
 *   ) SELECT n FROM t
 *
 * @module CteDepthLimiter
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('CteDepthLimiter');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface CteDepthLimitResult {
  sql: string;
  rewritten: boolean;
  maxDepth: number;
  error?: string;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

export const DEFAULT_MAX_RECURSIVE_DEPTH = 100;
export const MIN_DEPTH = 1;
export const MAX_DEPTH = 10000;

const SET_MAX_DEPTH_PATTERN = /^\s*SET\s+["']?max_recursive_query_depth["']?\s*(?:=\s*|\s+TO\s+)(\d+)\s*;?\s*$/i;
const WITH_RECURSIVE_PREFIX_PATTERN = /^\s*WITH\s+RECURSIVE\b/i;

// ──────────────────────────────────────────────
//  Public API — SET max_recursive_query_depth
// ──────────────────────────────────────────────

export function detectSetMaxDepth(sql: string): number | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) return null;
  const trimmed = sql.trim();
  if (!trimmed.toUpperCase().startsWith('SET ')) return null;
  const match = trimmed.match(SET_MAX_DEPTH_PATTERN);
  if (!match) return null;
  // match[1] is guaranteed to be a run of digits by the capture group, so
  // parseInt can never yield NaN here.
  const value = parseInt(match[1], 10);
  return Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, value));
}

export function handleSetMaxDepth(sql: string): number | null {
  return detectSetMaxDepth(sql);
}

// ──────────────────────────────────────────────
//  Public API — Detect recursive CTE
// ──────────────────────────────────────────────

export function detectRecursiveCte(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return WITH_RECURSIVE_PREFIX_PATTERN.test(sql.trim());
}

// ──────────────────────────────────────────────
//  CTE Body Parsing (paren-balanced)
// ──────────────────────────────────────────────

interface ParsedCte {
  prefix: string;           // "WITH RECURSIVE name[(cols)] AS ("
  cteName: string;
  cteCols: string;
  anchorSql: string;
  recursiveSql: string;
  outerSql: string;
}

/**
 * Return the index just past a SQL literal/comment starting at `i`, or `i` if
 * the character at `i` does not begin a literal. Recognizes single-quoted
 * strings (`''` and `E''` backslash escapes), double-quoted identifiers
 * (`""`), dollar-quoted strings (`$$...$$` / `$tag$...$tag$`), line comments
 * (`--`), and block comments (`/* *\/`). This lets paren-balancing and keyword
 * scanning ignore parentheses and keywords that only occur inside literals.
 */
function skipSqlLiteral(sql: string, i: number): number {
  const len = sql.length;
  const c = sql[i];

  if (c === '-' && sql[i + 1] === '-') {
    let j = i + 2;
    while (j < len && sql[j] !== '\n') j++;
    return j;
  }

  if (c === '/' && sql[i + 1] === '*') {
    let j = i + 2;
    while (j < len && !(sql[j] === '*' && sql[j + 1] === '/')) j++;
    return j < len ? j + 2 : len;
  }

  if (c === "'") {
    let j = i + 1;
    while (j < len) {
      if (sql[j] === '\\' && j + 1 < len) { j += 2; continue; }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return j;
  }

  if (c === '"') {
    let j = i + 1;
    while (j < len) {
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return j;
  }

  if (c === '$') {
    const tagMatch = sql.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (tagMatch) {
      const tag = tagMatch[0];
      const close = sql.indexOf(tag, i + tag.length);
      return close === -1 ? len : close + tag.length;
    }
  }

  return i;
}

/**
 * Parse a recursive CTE into its components.
 * Uses paren balancing to find the CTE definition boundaries.
 */
function parseCteStructure(sql: string): ParsedCte | null {
  const trimmed = sql.trim();

  // Extract WITH RECURSIVE <name>[(<cols>)] AS (
  const headerRe = /^\s*(WITH\s+RECURSIVE\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*AS\s*\(/i;
  const m = trimmed.match(headerRe);
  if (!m) return null;

  const headerEnd = (m.index || 0) + m[0].length;
  const cteName = m[2];
  const cteCols = (m[3] || '').trim();

  // Balance parens to find the closing paren of the CTE body, skipping
  // parentheses that occur inside string literals, quoted identifiers,
  // dollar-quotes, or comments.
  let depth = 1;
  let closePos = -1;
  for (let i = headerEnd; i < trimmed.length; i++) {
    const skip = skipSqlLiteral(trimmed, i);
    if (skip > i) {
      i = skip - 1;
      continue;
    }
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')') {
      depth--;
      if (depth === 0) { closePos = i; break; }
    }
  }
  if (closePos === -1) return null;

  const body = trimmed.substring(headerEnd, closePos).trim();

  // Find UNION ALL inside the body
  const uaRe = /\bUNION\s+ALL\b/i;
  const ua = body.match(uaRe);
  if (!ua) return null;

  const uaPos = ua.index!;
  const anchorSql = body.substring(0, uaPos).trim();
  const recursiveSql = body.substring(uaPos + ua[0].length).trim();
  const outerSql = trimmed.substring(closePos + 1).trim();

  const prefix = trimmed.substring(0, headerEnd); // everything up to and including "("

  return { prefix, cteName, cteCols, anchorSql, recursiveSql, outerSql };
}

/**
 * Add a condition to a WHERE clause, or add a WHERE clause if none exists.
 */
function addCondition(sql: string, condition: string): string {
  const wherePos = findKeywordByRe(sql, /\bWHERE\b/i, 0);
  if (wherePos !== -1) {
    // Insert the new condition right after WHERE, preserving the existing
    // condition that follows (trimmed to avoid double spaces).
    const rest = sql.substring(wherePos + 5).replace(/^\s+/, '');
    return `${sql.substring(0, wherePos)}WHERE ${condition} AND ${rest}`;
  }
  // Find a good place to add WHERE — after FROM clause but before GROUP/ORDER/LIMIT
  const delimPos = findKeywordByRe(sql, POST_FROM_CLAUSE_RE, 0);
  if (delimPos !== -1) {
    return sql.substring(0, delimPos) + ` WHERE ${condition} ` + sql.substring(delimPos);
  }
  return sql + ` WHERE ${condition}`;
}

const CLAUSE_KEYWORD_RE = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;

/**
 * Clause keywords that may FOLLOW a FROM sub-clause — a WHERE condition must be
 * inserted BEFORE these (and thus after FROM), so they exclude FROM itself.
 */
const POST_FROM_CLAUSE_RE = /\b(WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;

/**
 * Find the index of the first keyword matching `pattern` at or after `from`,
 * ignoring occurrences inside string literals, quoted identifiers,
 * dollar-quotes, and comments. Returns -1 when none is found.
 */
function findKeywordByRe(sql: string, pattern: RegExp, from: number): number {
  // Clone with the global flag so RegExp#exec can iterate all matches.
  const re = new RegExp(pattern.source, pattern.flags.replace(/g/g, '') + 'g');
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m.index < from) continue;
    if (isInsideLiteral(sql, m.index)) continue;
    return m.index;
  }
  return -1;
}

/**
 * Find the index of the first clause keyword (FROM/WHERE/GROUP BY/etc.) at or
 * after `from`, ignoring occurrences inside literals/comments.
 */
function findClauseKeyword(sql: string, from: number): number {
  return findKeywordByRe(sql, CLAUSE_KEYWORD_RE, from);
}

/**
 * Determine whether `pos` lies inside a string literal, quoted identifier,
 * dollar-quote, or comment by scanning the SQL from the start (re-skipping
 * literals). This is O(n) per call, which is acceptable for the short CTE
 * bodies this module rewrites.
 */
function isInsideLiteral(sql: string, pos: number): boolean {
  for (let i = 0; i < pos; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip > i) {
      if (pos < skip) return true;
      i = skip - 1;
    }
  }
  return false;
}

// ──────────────────────────────────────────────
//  Public API — Inject depth limit
// ──────────────────────────────────────────────

/**
 * Inject a depth limit into a recursive CTE.
 * 
 * @param sql       Raw SQL
 * @param maxDepth  Maximum recursion depth (default: 100)
 */
export function injectCteDepthLimit(
  sql: string,
  maxDepth: number = DEFAULT_MAX_RECURSIVE_DEPTH
): CteDepthLimitResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false, maxDepth };
  }

  const trimmed = sql.trim();

  if (!detectRecursiveCte(trimmed)) {
    return { sql: trimmed, rewritten: false, maxDepth };
  }

  const depth = Math.max(MIN_DEPTH, Math.min(MAX_DEPTH, maxDepth));
  const parsed = parseCteStructure(trimmed);

  if (!parsed) {
    logger.warn({ sql: trimmed }, 'Failed to parse recursive CTE structure');
    return { sql: trimmed, rewritten: false, maxDepth: depth };
  }

  const { prefix, cteName, cteCols, anchorSql, recursiveSql, outerSql } = parsed;

  // Build new column list
  const newCols = cteCols ? `${cteCols}, __sqldepth` : '__sqldepth';

  // Rewrite anchor member: add `, 1 AS __sqldepth` to SELECT
  const newAnchor = rewriteSelectForDepth(anchorSql, '1');

  // Rewrite recursive member: add `, __sqldepth+1 AS __sqldepth` + WHERE __sqldepth < N
  const newRecursive = rewriteSelectForDepth(recursiveSql, '__sqldepth+1');
  // Add depth limit condition
  const finalRecursive = addCondition(newRecursive, `__sqldepth < ${depth}`);

  // Rebuild: prefix + new column list + new body + outer query
  const newBody = `${newAnchor}\nUNION ALL\n${finalRecursive}`;
  const rewritten = `WITH RECURSIVE ${cteName}(${newCols}) AS (\n${newBody}\n) ${outerSql}`;

  logger.debug(
    { maxDepth: depth, cteName },
    'CTE depth limit injected',
  );

  return { sql: rewritten, rewritten: true, maxDepth: depth };
}

/**
 * Rewrite a SELECT statement to append a depth column (aliased `__sqldepth`).
 * The column is added to the end of the SELECT list, before the first
 * clause keyword (FROM/WHERE/GROUP BY/…), or appended if there is no clause.
 * Non-SELECT members (e.g. a `VALUES` anchor) are returned unchanged.
 */
function rewriteSelectForDepth(sql: string, depthExpr: string): string {
  const selectMatch = sql.match(/^\s*SELECT\s+/i);
  if (!selectMatch) return sql;

  const selectEnd = (selectMatch.index || 0) + selectMatch[0].length;

  // Find the first clause keyword (literal-aware)
  const clausePos = findClauseKeyword(sql, selectEnd);

  if (clausePos !== -1) {
    const inject = `${depthExpr} AS __sqldepth`.trim();
    const cols = sql.substring(selectEnd, clausePos).replace(/\s+$/, '');
    return `${sql.substring(0, selectEnd)}${cols}, ${inject} ${sql.substring(clausePos)}`;
  }

  // No clause — append the depth column directly after the SELECT list.
  const cols = sql.substring(selectEnd).replace(/\s+$/, '');
  return `${sql.substring(0, selectEnd)}${cols}, ${depthExpr} AS __sqldepth`.trim();
}
