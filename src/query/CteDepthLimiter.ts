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
  const value = parseInt(match[1], 10);
  if (isNaN(value)) return null;
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

  // Balance parens to find the closing paren of the CTE body
  let depth = 1;
  let closePos = -1;
  for (let i = headerEnd; i < trimmed.length; i++) {
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

  const uaPos = (ua.index || 0);
  const anchorSql = body.substring(0, uaPos).trim();
  const recursiveSql = body.substring(uaPos + ua[0].length).trim();
  const outerSql = trimmed.substring(closePos + 1).trim();

  const prefix = trimmed.substring(0, headerEnd); // everything up to and including "("

  return { prefix, cteName, cteCols, anchorSql, recursiveSql, outerSql };
}

/**
 * Insert a column expression into a SELECT list (before FROM, WHERE, etc.)
 * Returns the modified SQL.
 */
function injectColumnInSelect(sql: string, colExpr: string): string {
  // Find the first FROM keyword that's after the SELECT list
  // Strategy: find SELECT, then find the next FROM/WHERE/GROUP/HAVING/ORDER/LIMIT
  const selectRe = /^\s*SELECT\s+/i;
  if (!selectRe.test(sql)) return sql;

  // Find the end of the SELECT column list — look for the first clause keyword
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const clauseMatch = sql.match(clauseRe);
  
  if (clauseMatch && clauseMatch.index !== undefined) {
    // Insert before the clause keyword
    return sql.substring(0, clauseMatch.index) + ', ' + colExpr + ' ' + sql.substring(clauseMatch.index);
  }
  
  // No clause found — just append
  return sql + ', ' + colExpr;
}

/**
 * Add a condition to a WHERE clause, or add a WHERE clause if none exists.
 */
function addCondition(sql: string, condition: string): string {
  const whereRe = /\bWHERE\b/i;
  if (whereRe.test(sql)) {
    return sql.replace(whereRe, `WHERE ${condition} AND `);
  }
  // Find a good place to add WHERE — after FROM clause but before GROUP/ORDER/LIMIT
  const delimRe = /\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const delim = sql.match(delimRe);
  if (delim && delim.index !== undefined) {
    return sql.substring(0, delim.index) + ` WHERE ${condition} ` + sql.substring(delim.index);
  }
  return sql + ` WHERE ${condition}`;
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
  let newAnchor = rewriteSelectForDepth(anchorSql, '1', true);
  if (newAnchor === anchorSql) {
    // Fallback: inject manually
    newAnchor = injectColumnInSelect(anchorSql, '1 AS __sqldepth');
  }

  // Rewrite recursive member: add `, __sqldepth+1 AS __sqldepth` + WHERE __sqldepth < N
  let newRecursive = rewriteSelectForDepth(recursiveSql, '__sqldepth+1', true);
  if (newRecursive === recursiveSql) {
    newRecursive = injectColumnInSelect(recursiveSql, '__sqldepth+1 AS __sqldepth');
  }
  // Add depth limit condition
  newRecursive = addCondition(newRecursive, `__sqldepth < ${depth}`);

  // Rebuild: prefix + new column list + new body + outer query
  const newBody = `${newAnchor}\nUNION ALL\n${newRecursive}`;
  const rewritten = `WITH RECURSIVE ${cteName}(${newCols}) AS (\n${newBody}\n) ${outerSql}`;

  logger.debug(
    { maxDepth: depth, cteName },
    'CTE depth limit injected',
  );

  return { sql: rewritten, rewritten: true, maxDepth: depth };
}

/**
 * Rewrite a SELECT statement to add a depth column.
 * Naive approach: find the first SELECT, then the first FROM, and insert.
 */
function rewriteSelectForDepth(sql: string, depthExpr: string, addAlias: boolean): string {
  const selectMatch = sql.match(/^\s*SELECT\s+/i);
  if (!selectMatch) return sql;

  const selectEnd = (selectMatch.index || 0) + selectMatch[0].length;
  const rest = sql.substring(selectEnd);

  // Find the first clause keyword
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET)\b/i;
  const clauseMatch = rest.match(clauseRe);

  if (clauseMatch && clauseMatch.index !== undefined) {
    const aliasClause = addAlias ? `AS __sqldepth` : '';
    const inject = `, ${depthExpr} ${aliasClause}`.trim();
    return sql.substring(0, selectEnd) + 
           rest.substring(0, clauseMatch.index) + inject + ' ' +
           rest.substring(clauseMatch.index);
  }

  return sql; // Can't parse
}
