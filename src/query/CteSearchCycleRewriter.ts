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

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('CteSearchCycleRewriter');

// ──────────────────────────────────────────────
// Literal-aware scanning
// ──────────────────────────────────────────────

/**
 * Given a position `pos` into `sql`, return the index just past the SQL
 * literal/comment that starts at `pos`, or `-1` if `pos` is not inside a
 * literal/comment. Recognizes:
 *   - single-quoted strings (with '' and E'' backslash escapes)
 *   - double-quoted identifiers (with "" escapes)
 *   - dollar-quoted strings ($$ ... $$ and $tag$ ... $tag$)
 *   - line comments (-- ...) and block comments (/* ... *​/)
 *
 * Returns `sql.length` when a literal/comment is unterminated (so the scan
 * consumes the rest of the input).
 */
function skipSqlLiteral(sql: string, pos: number): number {
  const c = sql[pos];
  const len = sql.length;

  // Line comment: `--` to end of line.
  if (c === '-' && sql[pos + 1] === '-') {
    let j = pos + 2;
    while (j < len && sql[j] !== '\n') j++;
    return j;
  }

  // Block comment: `/*` to `*/`.
  if (c === '/' && sql[pos + 1] === '*') {
    const end = sql.indexOf('*/', pos + 2);
    return end === -1 ? len : end + 2;
  }

  // Single-quoted string.
  if (c === "'") {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '\\' && j + 1 < len) {
        j += 2; // E''-style backslash escape consumes the next char too.
        continue;
      }
      if (sql[j] === "'") {
        if (sql[j + 1] === "'") { j += 2; continue; } // doubled '' escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated string
  }

  // Double-quoted identifier.
  if (c === '"') {
    let j = pos + 1;
    while (j < len) {
      if (sql[j] === '"') {
        if (sql[j + 1] === '"') { j += 2; continue; } // doubled "" escape
        return j + 1;
      }
      j++;
    }
    return len; // unterminated identifier
  }

  // Dollar-quoted string: $$ ... $$ or $tag$ ... $tag$.
  if (c === '$') {
    const m = sql.slice(pos).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
    if (m) {
      const tag = m[0];
      const close = sql.indexOf(tag, pos + tag.length);
      return close === -1 ? len : close + tag.length;
    }
    return -1; // a bare $ that is not a dollar-quote opener
  }

  return -1;
}

/**
 * Return true if `pos` is inside a string literal, quoted identifier,
 * dollar-quoted string, or comment (i.e. the character there is not real SQL).
 */
function isInsideLiteral(sql: string, pos: number): boolean {
  let i = 0;
  const len = sql.length;
  while (i < pos && i < len) {
    const skip = skipSqlLiteral(sql, i);
    if (skip === -1) {
      i++;
      continue;
    }
    if (pos < skip) return true;
    i = skip;
  }
  return false;
}

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

/**
 * Find the index of the closing parenthesis that matches the opening paren at
 * `openPos`, skipping parentheses that occur inside string literals, quoted
 * identifiers, dollar-quotes, and comments. Returns -1 if unmatched.
 */
function findMatchingCloseParen(sql: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;
  const len = sql.length;
  while (i < len) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip;
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

  // Find the closing paren of the CTE body (literal-aware).
  const closePos = findMatchingCloseParen(sql, headerEnd - 1);
  if (closePos === -1) return null;

  const body = sql.substring(headerEnd, closePos).trim();

  // Find UNION ALL inside the body
  const uaMatch = body.match(UNION_ALL_PATTERN);
  if (!uaMatch) return null;

  const uaPos = uaMatch.index!;
  const anchorSql = body.substring(0, uaPos).trim();
  const recursiveSql = body.substring(uaPos + uaMatch[0].length).trim();

  return { headerSql, cteName, cteCols, anchorSql, recursiveSql };
}

// ──────────────────────────────────────────────
//  Column manipulation helpers
// ──────────────────────────────────────────────

/**
 * Find the index of the first match of `pattern` at or after `from`,
 * ignoring matches that occur inside string literals, quoted identifiers,
 * or comments. Returns -1 when no literal-aware match exists.
 */
function findKeyword(sql: string, pattern: RegExp, from: number): number {
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
 * Split a SELECT column list into individual column expressions, splitting
 * on top-level commas (ignoring commas inside parentheses, strings, quoted
 * identifiers, and comments). Returns the expressions trimmed.
 */
function splitSelectList(sql: string): string[] {
  const cols: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      cols.push(sql.substring(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  cols.push(sql.substring(start).trim());
  return cols.filter((c) => c.length > 0);
}

/**
 * Inject a column expression into a SELECT list.
 * Handles SELECT [DISTINCT] col_list FROM|WHERE|etc.
 */
function injectSelectColumn(sql: string, colExpr: string): string {
  const selectMatch = sql.match(/^\s*(SELECT\s+(?:DISTINCT\s+)?)/i);
  if (!selectMatch) return sql;

  const selectEnd = selectMatch[0].length;

  // Find the first clause keyword after the select list (literal-aware).
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const clausePos = findKeyword(sql, clauseRe, selectEnd);

  if (clausePos !== -1) {
    const cols = sql.substring(selectEnd, clausePos).replace(/\s+$/, '');
    return `${sql.substring(0, selectEnd)}${cols}, ${colExpr} ${sql.substring(clausePos)}`;
  }

  return `${sql.replace(/\s+$/, '')}, ${colExpr}`;
}

/**
 * Wrap the anchor SELECT so that references to the CTE's declared column
 * names are resolvable from the injected path/depth/marker expressions.
 *
 * SQLite (like PostgreSQL) does not allow a SELECT list to reference another
 * column in the same list, so the anchor cannot reference `cycleCol` (or any
 * CTE column) directly while injecting `',' || cycleCol || ','`. We therefore
 * materialize the anchor inside a subquery, assigning the declared CTE column
 * names to the anchor's output columns, and reference those names from the
 * outer SELECT.
 *
 * `anchorSql`    e.g. `SELECT 0` (the anchor member body)
 * `cteCols`      the CTE's declared column names (comma-separated), e.g. `n`
 *
 * Returns the wrapped anchor if wrapping is necessary, otherwise the original.
 */
function wrapAnchorForColumnRefs(anchorSql: string, cteCols: string): string {
  const colNames = cteCols
    ? cteCols.split(',').map((c) => c.trim()).filter((c) => c.length > 0)
    : [];
  if (colNames.length === 0) return anchorSql;

  const selectMatch = anchorSql.match(/^\s*(SELECT\s+(?:DISTINCT\s+)?)/i);
  if (!selectMatch) return anchorSql;

  const selectPrelude = selectMatch[0];
  const selectEnd = selectMatch[0].length;

  // Locate the end of the SELECT list (first FROM / clause keyword).
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW|UNION\b)/i;
  const clausePos = findKeyword(anchorSql, clauseRe, selectEnd);

  let listSql: string;
  let tail: string;
  if (clausePos !== -1) {
    listSql = anchorSql.substring(selectEnd, clausePos);
    tail = ` ${anchorSql.substring(clausePos)}`;
  } else {
    listSql = anchorSql.substring(selectEnd);
    tail = '';
  }

  const exprs = splitSelectList(listSql);
  if (exprs.length === 0) return anchorSql;

  // Assign declared column names to each anchor expression. If the anchor
  // has fewer columns than declared (e.g. `SELECT 0` for a 1-column CTE),
  // name the matching ones; extra declared columns are appended as NULLs
  // so the wrapper always exposes exactly the declared columns.
  const innerCols: string[] = [];
  for (let i = 0; i < colNames.length; i++) {
    if (i < exprs.length) {
      innerCols.push(`${exprs[i]} AS ${colNames[i]}`);
    } else {
      innerCols.push(`NULL AS ${colNames[i]}`);
    }
  }

  const inner = `${selectPrelude}${innerCols.join(', ')}${tail}`;
  return `SELECT ${colNames.join(', ')} FROM (${inner}) AS _anchor`;
}

/**
 * Extract the SELECT column expressions of a member (anchor or recursive),
 * returning them in order. Returns an empty array if the member is not a
 * plain SELECT (e.g. VALUES or a set operation).
 */
function extractSelectColumns(memberSql: string): string[] {
  const selectMatch = memberSql.match(/^\s*(SELECT\s+(?:DISTINCT\s+)?)/i);
  if (!selectMatch) return [];
  const selectEnd = selectMatch[0].length;
  const clauseRe = /\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW|UNION\b)/i;
  const clausePos = findKeyword(memberSql, clauseRe, selectEnd);
  const listSql = clausePos !== -1
    ? memberSql.substring(selectEnd, clausePos)
    : memberSql.substring(selectEnd);
  return splitSelectList(listSql);
}

/**
 * Given the CTE's declared columns and a member's SELECT expressions, return
 * a map from declared column name to the member's expression for that column.
 * The declared column at index i maps to the member's i-th expression.
 */
function mapColumnsToExprs(cteCols: string, exprs: string[]): Map<string, string> {
  const names = cteCols.split(',').map((c) => c.trim()).filter((c) => c.length > 0);
  const map = new Map<string, string>();
  for (let i = 0; i < names.length; i++) {
    map.set(names[i], exprs[i] ?? names[i]);
  }
  return map;
}

/**
 * Resolve the value expression for a referenced column (cycleCol or a search
 * column) inside the recursive member. In the recursive member the CTE column
 * name refers to the *previous* row (via `FROM cte`), so to track the *new*
 * value we must use the expression the recursive SELECT assigns to that
 * column. Falls back to the bare column name when it cannot be determined.
 */
function resolveRecursiveValueExpr(
  recursiveSql: string,
  cteCols: string,
  colName: string,
): string {
  const exprs = extractSelectColumns(recursiveSql);
  const map = mapColumnsToExprs(cteCols, exprs);
  return map.get(colName) ?? colName;
}

function addCondition(sql: string, condition: string): string {
  const wherePos = findKeyword(sql, /\bWHERE\b/i, 0);
  if (wherePos !== -1) {
    const rest = sql.substring(wherePos + 5).replace(/^\s+/, '');
    return `${sql.substring(0, wherePos)}WHERE ${condition} AND ${rest}`;
  }
  const delimRe = /\b(GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW)\b/i;
  const delimPos = findKeyword(sql, delimRe, 0);
  if (delimPos !== -1) {
    return sql.substring(0, delimPos) + ` WHERE ${condition} ` + sql.substring(delimPos);
  }
  return sql + ` WHERE ${condition}`;
}

/**
 * Add ORDER BY to the outer query if not already present.
 */
function addOrderByToOuter(sql: string, orderClause: string): string {
  // Check for existing ORDER BY
  if (/\bORDER\s+BY\b/i.test(sql)) {
    // Replace existing ORDER BY ... (through end of statement)
    return sql.replace(/\bORDER\s+BY\s+.*/i, `ORDER BY ${orderClause}`);
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
  const closePos = findMatchingCloseParen(sql, headerEnd - 1);
  if (closePos === -1) return null;
  return sql.substring(closePos + 1).trim();
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
  /* v8 ignore next -- ?? fallback is defensive default */
  const trimmed = (sql ?? '').trim();
  if (!trimmed) return { sql: '', rewritten: false, details: {} };

  const details: SearchCycleRewriteResult['details'] = {};

  // Parse CTE structure
  const parsed = parseCteBody(trimmed);
  if (!parsed) return { sql: trimmed, rewritten: false, details };

  const { headerSql, cteName, cteCols, anchorSql, recursiveSql } = parsed;

  // Find all text after CTE body closing paren (literal-aware).
  const headerEnd = headerSql.length;
  const closePos = findMatchingCloseParen(trimmed, headerEnd - 1);
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
    details.search = (searchType + ' FIRST') as 'DEPTH FIRST' | 'BREADTH FIRST';
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
    // DEFAULT value: group 5 (captures both quoted and unquoted). When the
    // DEFAULT clause is omitted, PostgreSQL defaults the cycle marker's
    // non-cycle value to boolean false — mirroring that here, keeping the
    // same quoting style as the TO value so the CASE branches stay type-
    // consistent.
    const isQuotedTrue = /^'/.test(cycleTrueValue);
    cycleFalseValue = cycleMatch[5] ?? (isQuotedTrue ? "'false'" : 'false');
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

  // Parse the existing declared column names (already split) so we can check
  // whether a synthesized column name collides with an existing one. Using
  // `includes` on the whole `cteCols` string would only match an exact
  // single-column list, silently re-injecting `__sqlpath`/`__sqldepth`.
  const existingColNames = new Set<string>();
  for (const colChunk of newColsList) {
    for (const name of colChunk.split(',')) {
      const trimmed = name.trim();
      if (trimmed) existingColNames.add(trimmed);
    }
  }

  // Always need __sqlpath for both SEARCH and CYCLE
  const hasPathCol = !existingColNames.has('__sqlpath');
  const hasDepthCol = !existingColNames.has('__sqldepth');

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

    // In the recursive member, the path must accumulate the *new* value of the
    // tracked column(s), not the previous-row value the CTE column name refers
    // to. Resolve each tracked column to its recursive-member expression.
    let recursiveValueExpr: string;
    if (cycleCol) {
      recursiveValueExpr = resolveRecursiveValueExpr(recursiveSql, cteCols, cycleCol);
    } else {
      recursiveValueExpr = searchCols!
        .split(',')
        .map((c) => c.trim())
        .map((c) => resolveRecursiveValueExpr(recursiveSql, cteCols, c))
        .join(" || ',' || ");
    }

    injectColumns.push({
      name: '__sqlpath',
      anchorExpr: `${pathExpr} AS __sqlpath`,
      recursiveExpr: `__sqlpath || ${recursiveValueExpr} || ',' AS __sqlpath`,
    });
  }

  if (cycleCol && cycleMarker && !cycleMarkerAlreadyExists) {
    // Track the *new* value of the cycle column for detection, and append the
    // new value to the path so the guard works against the current row.
    const recursiveCycleValue = resolveRecursiveValueExpr(recursiveSql, cteCols, cycleCol);
    injectColumns.push({
      name: cycleMarker!,
      anchorExpr: `${cycleFalseValue} AS ${cycleMarker}`,
      recursiveExpr: `CASE WHEN INSTR(__sqlpath, ',' || ${recursiveCycleValue} || ',') > 0 THEN ${cycleTrueValue} ELSE ${cycleFalseValue} END AS ${cycleMarker}`,
    });
  }

  // Build new column list
  const allCols = [...newColsList, ...injectColumns.map(c => c.name)].join(', ');

  // Rewrite anchor and recursive members
  let newAnchor = anchorSql;
  let newRecursive = recursiveSql;

  // If path/depth/marker injections reference the CTE's declared column names
  // (e.g. `',' || cycleCol || ','`), the anchor member must materialize those
  // columns inside a subquery first, because SQLite does not allow a SELECT
  // list to reference its own output columns.
  if ((cycleCol || searchCols) && cteCols) {
    newAnchor = wrapAnchorForColumnRefs(anchorSql, cteCols);
  }

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
