/**
 * CteSearchCycleRewriter — PostgreSQL CTE SEARCH/CYCLE implementation for SQLite.
 *
 * PostgreSQL 16+ adds SEARCH and CYCLE clauses to recursive CTEs:
 *
 * ## SEARCH {DEPTH|BREADTH} FIRST BY col [...] SET order_col
 *
 * Controls ordering of recursive CTE results:
 * - DEPTH FIRST: depth-first traversal (parent before children)
 * - BREADTH FIRST: breadth-first traversal (all depth=N before depth=N+1)
 *
 * Implementation: inject a path column and ORDER BY:
 * - DEPTH FIRST → ORDER BY __sqlpath (lexicographic order = depth-first)
 * - BREADTH FIRST → ORDER BY LENGTH(__sqlpath), __sqldepth, cols
 *
 * ## CYCLE col SET is_cycle TO value DEFAULT default_value
 *
 * Detects cycles in recursive CTEs by tracking visited values:
 * - Injects a path text column that accumulates visited values
 * - Sets the cycle-marker column when a value repeats
 * - Recursion naturally stops when all rows have is_cycle = true
 *
 * ## Examples
 *
 * Input:
 * ```sql
 * WITH RECURSIVE t(n) AS (
 *   SELECT 1
 *   UNION ALL
 *   SELECT n+1 FROM t WHERE n < 10
 * )
 * SEARCH DEPTH FIRST BY n SET order_col
 * CYCLE n SET is_cycle TO true DEFAULT false
 * SELECT * FROM t;
 * ```
 *
 * Output (approximately):
 * ```sql
 * WITH RECURSIVE t(n, __sqlpath, __sqldepth, is_cycle) AS (
 *   SELECT 1, ',' || 1 || ',', 0, false
 *   UNION ALL
 *   SELECT n+1,
 *          __sqlpath || n+1 || ',',
 *          __sqldepth + 1,
 *          CASE WHEN INSTR(__sqlpath, ',' || n+1 || ',') > 0 THEN true ELSE false END
 *   FROM t WHERE n < 10 AND NOT is_cycle
 * )
 * SELECT * FROM t ORDER BY __sqlpath;
 * ```
 *
 * @module CteSearchCycleRewriter
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('CteSearchCycleRewriter');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SearchCycleRewriteResult {
  /** (Potentially rewritten) SQL string */
  sql: string;
  /** Whether any rewriting was applied */
  rewritten: boolean;
  /** Details of what was rewritten */
  details: {
    search?: 'DEPTH FIRST' | 'BREADTH FIRST';
    cycle?: { column: string; marker: string };
  };
}

// ──────────────────────────────────────────────
//  Regex patterns
// ──────────────────────────────────────────────

/**
 * Pattern to find SEARCH clause after CTE body closing paren.
 *   `) SEARCH DEPTH FIRST BY col1, col2 SET order_col`
 */
/**
 * Pattern to find SEARCH clause — used for detection on after-body text.
 */
const SEARCH_DETECT = /SEARCH\s+(DEPTH|BREADTH)\s+FIRST\s+BY\s+([^)]+?)\s+SET\s+([a-zA-Z_][a-zA-Z0-9_]*)/i;

/**
 * Pattern to find CYCLE clause — used for detection on after-body text.
 * The cycle col and marker are [a-zA-Z_][a-zA-Z0-9_]*, then TO value [DEFAULT default].
 */
const CYCLE_DETECT = /CYCLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+SET\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+TO\s+('[^']*'|(\S+?))(?:\s+DEFAULT\s+('[^']*'|(\S+?)))?(?=\s|\)|$)/i;

/**
 * Pattern to detect WITH RECURSIVE.
 */
const WITH_RECURSIVE_PATTERN = /^\s*WITH\s+RECURSIVE\s+/i;

/**
 * Pattern to find CTE name and column list.
 *   `WITH RECURSIVE name[(cols)] AS (`
 */
const CTE_HEADER_PATTERN = /(WITH\s+RECURSIVE\s+)([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*AS\s*\(/i;

/**
 * Pattern to find UNION ALL.
 */
const UNION_ALL_PATTERN = /\bUNION\s+ALL\b/i;

// ──────────────────────────────────────────────
//  CTE parsing (paren-balanced)
// ──────────────────────────────────────────────

interface ParsedCteBody {
  headerSql: string;       // everything up to and including the opening "("
  cteName: string;
  cteCols: string;
  anchorSql: string;
  recursiveSql: string;
}

function parseCteBody(sql: string): ParsedCteBody | null {
  const headerMatch = sql.match(CTE_HEADER_PATTERN);
  if (!headerMatch) return null;

  const headerEnd = (headerMatch.index || 0) + headerMatch[0].length;
  const cteName = headerMatch[2];
  const cteCols = (headerMatch[3] || '').trim();
  const headerSql = sql.substring(0, headerEnd);

  // Balance parens to find the closing paren of the CTE body
  let depth = 1;
  let closePos = -1;
  for (let i = headerEnd; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) { closePos = i; break; }
    }
  }
  if (closePos === -1) return null;

  const body = sql.substring(headerEnd, closePos).trim();

  // Find UNION ALL inside the body
  const uaMatch = body.match(UNION_ALL_PATTERN);
  if (!uaMatch) return null;

  const uaPos = (uaMatch.index || 0);
  const anchorSql = body.substring(0, uaPos).trim();
  const recursiveSql = body.substring(uaPos + uaMatch[0].length).trim();

  return { headerSql, cteName, cteCols, anchorSql, recursiveSql };
}

// ──────────────────────────────────────────────
//  Column manipulation helpers
// ──────────────────────────────────────────────

/**
 * Inject a column expression into a SELECT list.
 * Handles SELECT [DISTINCT] col_list FROM|WHERE|etc.
 */
function injectSelectColumn(sql: string, colExpr: string): string {
  const selectEndMatch = sql.match(/^\s*(SELECT\s+(?:DISTINCT\s+)?)/i);
  if (!selectEndMatch) return sql;

  const selectEnd = selectEndMatch[0].length;
  const rest = sql.substring(selectEnd);

  // Find first clause keyword after select list
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const clauseMatch = rest.match(clauseRe);

  if (clauseMatch && clauseMatch.index !== undefined) {
    return sql.substring(0, selectEnd) +
      rest.substring(0, clauseMatch.index) +
      `, ${colExpr} ` +
      rest.substring(clauseMatch.index);
  }

  return sql + `, ${colExpr}`;
}

function addCondition(sql: string, condition: string): string {
  const whereRe = /\bWHERE\b/i;
  if (whereRe.test(sql)) {
    return sql.replace(whereRe, `WHERE (${condition}) AND `);
  }
  const delimRe = /\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const delim = sql.match(delimRe);
  if (delim && delim.index !== undefined) {
    return sql.substring(0, delim.index) + ` WHERE ${condition} ` + sql.substring(delim.index);
  }
  return sql + ` WHERE ${condition}`;
}

/**
 * Add ORDER BY to the outer query if not already present.
 */
function addOrderByToOuter(sql: string, orderClause: string): string {
  // Check for existing ORDER BY
  if (/\bORDER\s+BY\b/i.test(sql)) {
    // Replace existing ORDER BY
    return sql.replace(/\bORDER\s+BY\s+.*/i, orderClause);
  }
  return sql + ` ORDER BY ${orderClause}`;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the SQL contains a SEARCH clause.
 * Uses after-cte-body text for detection.
 */
export function detectSearchClause(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  if (!WITH_RECURSIVE_PATTERN.test(sql.trim())) return false;
  // Extract after-body text and test
  const after = extractAfterCteBody(sql.trim());
  if (after === null) return false;
  return SEARCH_DETECT.test(after);
}

/**
 * Detect whether the SQL contains a CYCLE clause.
 */
export function detectCycleClause(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  if (!WITH_RECURSIVE_PATTERN.test(sql.trim())) return false;
  const after = extractAfterCteBody(sql.trim());
  if (after === null) return false;
  return CYCLE_DETECT.test(after);
}

/**
 * Extract the text after the CTE body's closing paren.
 * Returns null if the structure can't be parsed.
 */
function extractAfterCteBody(sql: string): string | null {
  const headerMatch = sql.match(CTE_HEADER_PATTERN);
  if (!headerMatch) return null;
  const headerEnd = (headerMatch.index || 0) + headerMatch[0].length;
  let depth = 1;
  for (let i = headerEnd; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) {
        return sql.substring(i + 1).trim();
      }
    }
  }
  return null;
}

/**
 * Full rewrite: translate SEARCH and/or CYCLE into real SQLite constructs.
 * 
 * Steps:
 * 1. Parse the CTE structure
 * 2. Inject path/depth/cycle columns
 * 3. Remove original SEARCH/CYCLE clauses
 * 4. Add ORDER BY for SEARCH
 * 5. Return rewritten SQL
 */
export function rewriteSearchCycle(sql: string): SearchCycleRewriteResult {
  const trimmed = (sql ?? '').trim();
  if (!trimmed) return { sql: '', rewritten: false, details: {} };

  const details: SearchCycleRewriteResult['details'] = {};

  // Parse CTE structure
  const parsed = parseCteBody(trimmed);
  if (!parsed) return { sql: trimmed, rewritten: false, details };

  const { headerSql, cteName, cteCols, anchorSql, recursiveSql } = parsed;

  // Find all text after CTE body closing paren
  const headerEnd = headerSql.length;
  let depth = 1;
  let closePos = -1;
  for (let i = headerEnd; i < trimmed.length; i++) {
    if (trimmed[i] === '(') depth++;
    else if (trimmed[i] === ')') {
      depth--;
      if (depth === 0) { closePos = i; break; }
    }
  }
  if (closePos === -1) return { sql: trimmed, rewritten: false, details };

  const afterCteBody = trimmed.substring(closePos + 1).trim();

  // Detect SEARCH and CYCLE in the after-body text
  const searchMatch = afterCteBody.match(SEARCH_DETECT);
  const cycleMatch = afterCteBody.match(CYCLE_DETECT);

  if (!searchMatch && !cycleMatch) {
    return { sql: trimmed, rewritten: false, details: {} };
  }

  // Extract clause info
  let searchType: string | undefined;
  let searchCols: string | undefined;
  let searchOrderCol: string | undefined;
  if (searchMatch) {
    searchType = searchMatch[1].toUpperCase();  // DEPTH or BREADTH
    searchCols = searchMatch[2].trim();
    searchOrderCol = searchMatch[3];
    details.search = searchType as 'DEPTH FIRST' | 'BREADTH FIRST';
  }

  let cycleCol: string | undefined;
  let cycleMarker: string | undefined;
  let cycleTrueValue: string | undefined;
  let cycleFalseValue: string | undefined;
  if (cycleMatch) {
    cycleCol = cycleMatch[1];
    cycleMarker = cycleMatch[2];
    // TO value: group 3 (captures both quoted and unquoted)
    cycleTrueValue = cycleMatch[3];
    // DEFAULT value: group 5 (captures both quoted and unquoted)
    cycleFalseValue = cycleMatch[5] || (cycleTrueValue === 'true' ? 'false' : '0');
    details.cycle = { column: cycleCol!, marker: cycleMarker! };
  }

  // Strip SEARCH / CYCLE from the after-body text
  const SEARCH_STRIP = /SEARCH\s+(?:DEPTH|BREADTH)\s+FIRST\s+BY\s+[^)]+?\s+SET\s+[a-zA-Z_][a-zA-Z0-9_]*\s*/gi;
  const CYCLE_STRIP = /CYCLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+SET\s+[a-zA-Z_][a-zA-Z0-9_]*\s+TO\s+(?:'[^']*'|\S+)(?:\s+DEFAULT\s+(?:'[^']*'|\S+))?\s*/gi;
  let cleanAfter = afterCteBody
    .replace(SEARCH_STRIP, '')
    .replace(CYCLE_STRIP, '')
    .trim();

  // Build new columns for the CTE
  const newColsList: string[] = [];
  if (cteCols) {
    newColsList.push(cteCols);
  }

  // Always need __sqlpath for both SEARCH and CYCLE
  const hasPathCol = !newColsList.includes('__sqlpath');
  const hasDepthCol = !newColsList.includes('__sqldepth');

  // Add cycle marker column if needed
  let cycleMarkerAlreadyExists = false;
  if (cycleMarker) {
    // Check if cycleMarker already matches an existing column
    cycleMarkerAlreadyExists = cteCols
      ? cteCols.split(',').map(c => c.trim()).includes(cycleMarker!)
      : false;
  }

  // Build columns we need to add
  const injectColumns: { name: string; anchorExpr: string; recursiveExpr: string }[] = [];

  // __sqldepth is needed for BREADTH FIRST ordering
  if (hasDepthCol) {
    injectColumns.push({
      name: '__sqldepth',
      anchorExpr: '0 AS __sqldepth',
      recursiveExpr: '__sqldepth + 1 AS __sqldepth',
    });
  }

  // __sqlpath for cycle detection and search ordering
  if ((cycleCol || searchCols) && hasPathCol) {
    // For CYCLE: path is cycleCol || val
    // For SEARCH: path is cols concatenated
    const pathExpr = cycleCol
      ? `',' || ${cycleCol} || ','`
      : `',' || ${searchCols!.split(',').map(c => c.trim()).join(" || ',' || ")} || ','`;

    injectColumns.push({
      name: '__sqlpath',
      anchorExpr: `${pathExpr} AS __sqlpath`,
      recursiveExpr: `__sqlpath || ${cycleCol ? cycleCol : searchCols!.split(',').map(c => c.trim()).join(" || ',' || ")} || ',' AS __sqlpath`,
    });
  }

  if (cycleCol && cycleMarker && !cycleMarkerAlreadyExists) {
    injectColumns.push({
      name: cycleMarker!,
      anchorExpr: `${cycleFalseValue} AS ${cycleMarker}`,
      recursiveExpr: `CASE WHEN INSTR(__sqlpath, ',' || ${cycleCol} || ',') > 0 THEN ${cycleTrueValue} ELSE ${cycleFalseValue} END AS ${cycleMarker}`,
    });
  }

  // Build new column list
  const allCols = [...newColsList, ...injectColumns.map(c => c.name)].join(', ');

  // Rewrite anchor and recursive members
  let newAnchor = anchorSql;
  let newRecursive = recursiveSql;

  for (const col of injectColumns) {
    newAnchor = injectSelectColumn(newAnchor, col.anchorExpr);
    newRecursive = injectSelectColumn(newRecursive, col.recursiveExpr);
  }

  // Add cycle guard to recursive member
  if (cycleCol && cycleMarker) {
    newRecursive = addCondition(newRecursive, `(${cycleMarker} = ${cycleFalseValue} OR ${cycleMarker} IS NULL)`);
  }

  // Rebuild the CTE
  const newBody = `${newAnchor}\n    UNION ALL\n    ${newRecursive}`;
  let rebuilt = `WITH RECURSIVE ${cteName}(${allCols}) AS (\n    ${newBody}\n  ) ${cleanAfter}`;

  // Add ORDER BY for SEARCH
  if (searchType && searchOrderCol) {
    if (searchType === 'DEPTH') {
      rebuilt = addOrderByToOuter(rebuilt, `__sqlpath`);
    } else if (searchType === 'BREADTH') {
      // For BREADTH FIRST: order by depth first, then by search columns
      rebuilt = addOrderByToOuter(rebuilt, `__sqldepth, ${searchCols}`);
    }
  }

  logger.debug(
    { searchType, cycleCol: cycleCol || null, rewritten: true },
    'CTE SEARCH/CYCLE rewrite applied',
  );

  return { sql: rebuilt, rewritten: true, details };
}
