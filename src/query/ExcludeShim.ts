/**
 * ExcludeShim — PostgreSQL window frame EXCLUDE clause simulation for SQLite.
 *
 * SQLite does not support EXCLUDE CURRENT ROW / GROUP / TIES in window frames.
 * PostgreSQL supports:
 * - EXCLUDE CURRENT ROW: excludes the current row from the frame
 * - EXCLUDE GROUP: excludes all peers (same ORDER BY values) of the current row
 * - EXCLUDE TIES: excludes peers except the current row
 * - EXCLUDE NO OTHERS: default (no exclusion — already SQLite compatible)
 *
 * ## Strategy
 *
 * ### EXCLUDE CURRENT ROW (on ROWS/RANGE frames)
 * Use arithmetic adjustment:
 * - SUM(x) → COALESCE(SUM(x) OVER (frame WITHOUT EXCLUDE), 0) - COALESCE(x, 0)
 * - COUNT(*) → COUNT(*) OVER (frame WITHOUT EXCLUDE) - 1
 * - AVG(x) → (COALESCE(SUM(x) OVER (...), 0) - COALESCE(x, 0)) /
 *             CAST(COUNT(*) OVER (...) - 1 AS REAL)
 *
 * ### EXCLUDE GROUP / EXCLUDE TIES
 * Use DENSE_RANK + correlated subquery (similar to GROUPS shim):
 * - EXCLUDE GROUP: filter sub.__grp != current.__grp
 * - EXCLUDE TIES: filter sub.__grp = current.__grp (only current row's peers,
 *   then the current row is included automatically)
 *
 * @module ExcludeShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ExcludeShim');

// ── Types ────────────────────────────────────────────────────────

export interface ExcludeShimResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/** Detects any EXCLUDE window clause. */
const ANY_EXCLUDE = /\bEXCLUDE\s+(?:CURRENT\s+ROW|GROUP|TIES|NO\s+OTHERS)\b/i;

/** EXCLUDE NO OTHERS (no-op — default behavior, just strip the clause). */
const EXCLUDE_NO_OTHERS_RE = /\s+EXCLUDE\s+NO\s+OTHERS\b/i;

/** EXCLUDE CURRENT ROW (preceded by whitespace). */
const EXCLUDE_CURRENT_ROW_RE = /\s+EXCLUDE\s+CURRENT\s+ROW\b/i;

/** EXCLUDE GROUP (preceded by whitespace). */
const EXCLUDE_GROUP_RE = /\s+EXCLUDE\s+GROUP\b/i;

/** EXCLUDE TIES (preceded by whitespace). */
const EXCLUDE_TIES_RE = /\s+EXCLUDE\s+TIES\b/i;

/**
 * Matches an OVER clause containing EXCLUDE CURRENT ROW.
 * Captures: (1) content before EXCLUDE, (2) EXCLUDE spec.
 *
 * The content before EXCLUDE is the frame spec (ROWS/RANGE ...).
 */
const EXCLUDE_OVER_CLAUSE_RE =
  /OVER\s*\(\s*((?:[^()]|\([^()]*\))*?)\s+EXCLUDE\s+(CURRENT\s+ROW|GROUP|TIES)\s*\)/i;

/**
 * Matches an aggregate window function with OVER clause.
 * Captures: (1) agg function, (2) argument, (3) full OVER clause content.
 */
const AGG_WINDOW_FN_RE =
  /\b(SUM|AVG|COUNT)\s*\(\s*([^()]+)\s*\)\s*(OVER\s*\([^()]*\))/i;

/**
 * Matches a window function with EXCLUDE in a SELECT list,
 * including the function, arg, frame, and an EXCLUDE spec.
 *
 * Captures: (1) function, (2) arg, (3) over content (no EXCLUDE),
 * (4) EXCLUDE spec (CURRENT ROW, GROUP, or TIES).
 */
const EXCLUDE_FN_SELECT_RE =
  /\b(SUM|AVG|COUNT|MIN|MAX)\s*\(\s*([^()]+)\s*\)\s*OVER\s*\(\s*((?:[^()]|\([^()]*\))*?)\s+EXCLUDE\s+(CURRENT\s+ROW|GROUP|TIES)\s*\)/gi;

/**
 * Simple SELECT pattern: SELECT ... FROM ... [trailing clauses].
 */
const SELECT_FROM_RE =
  /^\s*SELECT\s+(.+?)\s+FROM\s+(.+)$/is;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains an EXCLUDE window clause.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if EXCLUDE CURRENT ROW, EXCLUDE GROUP, or EXCLUDE TIES is detected
 *
 * @example
 * ```ts
 * detectExclude('SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t');
 * // → true
 * ```
 */
export function detectExclude(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return ANY_EXCLUDE.test(sql.trim());
}

/**
 * Rewrite SQL containing EXCLUDE window clause for SQLite compatibility.
 *
 * ## Processing rules
 *
 * | Input                                                | Output                                                                                  |
 * |------------------------------------------------------|-----------------------------------------------------------------------------------------|
 * | `SUM(x) OVER (ROWS 5 PRECEDING EXCLUDE CURRENT ROW)` | `COALESCE(SUM(x) OVER (ROWS 5 PRECEDING), 0) - COALESCE(x, 0)`                         |
 * | `COUNT(*) OVER (RANGE ... EXCLUDE CURRENT ROW)`      | `COUNT(*) OVER (RANGE ...) - 1`                                                         |
 * | `AVG(x) OVER (ROWS ... EXCLUDE CURRENT ROW)`         | `(COALESCE(SUM(x) OVER (ROWS ...), 0) - COALESCE(x, 0)) / CAST(COUNT(*) OVER (...) - 1 AS REAL)` |
 * | `... EXCLUDE GROUP` (simple)                         | CTE + DENSE_RANK + subquery exclusion                                                   |
 * | `... EXCLUDE TIES` (simple)                          | CTE + DENSE_RANK + subquery ties-only                                                   |
 * | No EXCLUDE clause                                    | Unchanged                                                                               |
 *
 * @param sql - The raw SQL string to process
 * @returns ExcludeShimResult with rewritten SQL
 *
 * @example
 * ```ts
 * const r = rewriteExclude(
 *   'SELECT SUM(x) OVER (ORDER BY y ROWS 5 PRECEDING EXCLUDE CURRENT ROW) FROM t'
 * );
 * // → rewritten: true
 * ```
 */
export function rewriteExclude(sql: string): ExcludeShimResult {
  if (!detectExclude(sql)) {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // EXCLUDE NO OTHERS is the default behavior — just strip it
  if (/\bEXCLUDE\s+NO\s+OTHERS\b/i.test(trimmed)) {
    const result = trimmed.replace(EXCLUDE_NO_OTHERS_RE, '');
    return { sql: result, rewritten: true };
  }

  // Check if we can do EXCLUDE CURRENT ROW with arithmetic adjustment
  if (/\bEXCLUDE\s+CURRENT\s+ROW\b/i.test(trimmed)) {
    const arithmeticResult = rewriteExcludeCurrentRow(trimmed);
    if (arithmeticResult.rewritten) {
      logger.debug(
        { original: trimmed, rewritten: arithmeticResult.sql },
        'EXCLUDE CURRENT ROW rewritten with arithmetic adjustment',
      );
      return arithmeticResult;
    }
  }

  // For EXCLUDE GROUP / EXCLUDE TIES, or fallback: strip EXCLUDE and add warning
  // EXCLUDE GROUP and EXCLUDE TIES require semantic correction similar to GROUPS
  // Try CTE rewrite first
  if (/\bEXCLUDE\s+(GROUP|TIES)\b/i.test(trimmed) && isSimpleSelect(trimmed)) {
    const cteResult = rewriteExcludeGroupTies(trimmed);
    if (cteResult.rewritten) {
      logger.debug(
        { original: trimmed, rewritten: cteResult.sql, type: 'EXCLUDE GROUP/TIES' },
        'EXCLUDE GROUP/TIES rewritten with CTE',
      );
      return cteResult;
    }
  }

  // Fallback: strip EXCLUDE clause and add warning
  const EXCLUDE_FALLBACK_WARNING =
    ' /* WARNING: frame exclusion clause stripped — SQLite does not support EXCLUDE */';
  let working = trimmed
    .replace(EXCLUDE_CURRENT_ROW_RE, '')
    .replace(EXCLUDE_GROUP_RE, '')
    .replace(EXCLUDE_TIES_RE, '')
    .replace(/\s{2,}/g, ' ');

  working += EXCLUDE_FALLBACK_WARNING;
  logger.debug({ original: trimmed, rewritten: working }, 'EXCLUDE clause stripped (fallback)');
  return { sql: working, rewritten: true };
}

// ── Internal: simple select check ────────────────────────────────

function isSimpleSelect(sql: string): boolean {
  return /^\s*SELECT\b/i.test(sql.trim());
}

// ── Internal: escape regex ───────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Internal: EXCLUDE CURRENT ROW (arithmetic) ───────────────────

/**
 * Rewrite EXCLUDE CURRENT ROW using arithmetic adjustment.
 *
 * Strategy: strip EXCLUDE, then wrap the result with current-row subtraction.
 * Only applies to SUM, AVG, COUNT on ROWS/RANGE frames (not GROUPS).
 */
function rewriteExcludeCurrentRow(sql: string): ExcludeShimResult {
  // Check for simple aggregate functions with EXCLUDE CURRENT ROW on ROWS/RANGE
  // (not GROUPS — those need the CTE approach)
  const EXCLUDE_SIMPLE_RE =
    /\b(SUM|AVG|COUNT)\s*\(\s*([^()]+)\s*\)\s*OVER\s*\(\s*((?:[^()]|\([^()]*\))*?)\s+EXCLUDE\s+CURRENT\s+ROW\s*\)/gi;

  EXCLUDE_SIMPLE_RE.lastIndex = 0;

  let working = sql;
  let found = false;
  let match: RegExpExecArray | null;

  while ((match = EXCLUDE_SIMPLE_RE.exec(working)) !== null) {
    const fullMatch = match[0];
    const aggFunc = match[1];
    const aggArg = match[2].trim();
    const overContent = match[3].trim();

    // Do not apply arithmetic if the frame uses GROUPS (GROUPS shim handles it)
    if (/\bGROUPS\b/i.test(overContent)) {
      continue;
    }

    // Strip EXCLUDE from the OVER clause to get the clean frame
    const cleanOverClause = `OVER (${overContent})`;

    // Build the arithmetic expression
    let replacement: string;
    switch (aggFunc.toUpperCase()) {
      case 'SUM': {
        // COALESCE(SUM(x) OVER (...), 0) - COALESCE(x, 0)
        replacement = `COALESCE(${aggFunc}(${aggArg}) ${cleanOverClause}, 0) - COALESCE(${aggArg}, 0)`;
        break;
      }
      case 'COUNT': {
        if (aggArg === '*' || aggArg === '1') {
          replacement = `${aggFunc}(${aggArg}) ${cleanOverClause} - 1`;
        } else {
          // COUNT(col) — NULLs not counted, need conditional
          replacement = `${aggFunc}(${aggArg}) ${cleanOverClause} - CASE WHEN ${aggArg} IS NOT NULL THEN 1 ELSE 0 END`;
        }
        break;
      }
      case 'AVG': {
        // (SUM(x) - COALESCE(x, 0)) / (COUNT(*) - 1)
        // Using COALESCE(SUM, 0) to handle NULL sum
        replacement =
          `CAST(COALESCE(SUM(${aggArg}) ${cleanOverClause}, 0) - COALESCE(${aggArg}, 0) AS REAL) / ` +
          `CAST(${aggFunc}(${aggArg}) ${cleanOverClause} - 1 AS REAL)`;
        break;
      }
      default:
        // Should not reach
        continue;
    }

    const escaped = escapeRegex(fullMatch);
    working = working.replace(new RegExp(escaped), replacement);
    found = true;
  }

  return { sql: working, rewritten: found };
}

// ── Internal: EXCLUDE GROUP / EXCLUDE TIES (CTE rewrite) ────────

/**
 * Rewrite EXCLUDE GROUP and EXCLUDE TIES using CTE + DENSE_RANK + subquery.
 *
 * EXCLUDE GROUP: Exclude all peer rows (same ORDER BY group).
 * Rewrites as:
 * - CTE with DENSE_RANK
 * - Outer SELECT with subquery that filters out rows in the same group
 *
 * EXCLUDE TIES: Include only one row per peer group (the current row).
 * The standard behavior of EXCLUDE TIES is to exclude peer rows except the
 * current row. So if the frame includes 5 rows that are peers, only the
 * first one (current) is kept.
 */
function rewriteExcludeGroupTies(sql: string): ExcludeShimResult {
  const selectMatch = sql.match(SELECT_FROM_RE);
  if (!selectMatch) {
    return { sql, rewritten: false };
  }

  const selectClause = selectMatch[1].trim();
  const fromBody = selectMatch[2].trim();

  // Extract trailing ORDER BY, LIMIT, OFFSET from the fromBody
  const { cteFrom, outerTail } = splitCteBody(fromBody);

  // Detect the EXCLUDE type and extract OVER clause info
  EXCLUDE_FN_SELECT_RE.lastIndex = 0;

  let counter = 0;
  let workingSelect = selectClause;
  const cteDefs: string[] = [];
  const cteAliases: string[] = [];
  let found = false;

  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = EXCLUDE_FN_SELECT_RE.exec(workingSelect)) !== null) {
    const fullMatch = fnMatch[0];
    const aggFunc = fnMatch[1];
    const aggArg = fnMatch[2].trim();
    const overContent = fnMatch[3].trim();
    const excludeType = fnMatch[4].trim().toUpperCase(); // CURRENT ROW, GROUP, or TIES

    // EXCLUDE CURRENT ROW with CTE approach is handled by arithmetic path above
    if (excludeType === 'CURRENT ROW') continue;

    const cteAlias = `__exc_cte_${counter}`;
    const grpAlias = `__exc_grp_${counter}`;
    cteAliases.push(cteAlias);

    // Extract ORDER BY
    const orderByMatch = overContent.match(/ORDER\s+BY\s+(.+)/i);
    if (!orderByMatch) {
      // No ORDER BY — all rows are in one peer group, simple to handle
      // Just strip EXCLUDE and use the frame as-is
      const cleanFn = fullMatch.replace(/\s+EXCLUDE\s+(GROUP|TIES)\b/i, '');
      workingSelect = workingSelect.replace(new RegExp(escapeRegex(fullMatch)), cleanFn);
      found = true;
      counter++;
      continue;
    }

    const orderBy = orderByMatch[1].trim();

    // Extract PARTITION BY
    const partitionBy = extractPartitionBy(overContent);

    // Build DENSE_RANK
    const drPartition = partitionBy ? `PARTITION BY ${partitionBy}` : '';
    const denseRankClause = `DENSE_RANK() OVER (${drPartition} ORDER BY ${orderBy})`;

    // CTE: same query with DENSE_RANK group numbers
    cteDefs.push(`${cteAlias} AS (SELECT *, ${denseRankClause} AS ${grpAlias} FROM ${cteFrom})`);

    // Build the subquery based on exclude type
    let whereExclude: string;
    switch (excludeType) {
      case 'GROUP':
        // Exclude all peers (same group, but not current row)
        whereExclude = `sub.${grpAlias} = ${cteAlias}.${grpAlias} AND sub.rowid <> ${cteAlias}.rowid`;
        break;
      case 'TIES':
        // Exclude peers except current row
        whereExclude = `sub.${grpAlias} = ${cteAlias}.${grpAlias} AND sub.rowid = ${cteAlias}.rowid`;
        break;
      default:
        continue; // Should not reach
    }

    // Add PARTITION BY filter
    let partitionFilter = '';
    if (partitionBy) {
      const pcols = partitionBy.split(',').map((c) => c.trim().replace(/["`]/g, ''));
      if (pcols.length > 0) {
        partitionFilter = pcols.map((c) => `sub.${c} = ${cteAlias}.${c}`).join(' AND ') + ' AND ';
      }
    }

    // Build the aggregate subquery for the full frame range (without EXCLUDE)
    let aggExpr: string;
    switch (aggFunc.toUpperCase()) {
      case 'SUM':
        aggExpr =
          `(SELECT COALESCE(SUM(sub.${aggArg}), 0) FROM ${cteAlias} sub WHERE ${whereExclude})`;
        break;
      case 'COUNT':
        if (aggArg === '*' || aggArg === '1') {
          aggExpr =
            `(SELECT COUNT(*) FROM ${cteAlias} sub WHERE ${whereExclude})`;
        } else {
          aggExpr =
            `(SELECT COUNT(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereExclude})`;
        }
        break;
      case 'AVG':
        aggExpr =
          `(SELECT CASE WHEN COUNT(sub.${aggArg}) = 0 THEN NULL ELSE CAST(COALESCE(SUM(sub.${aggArg}), 0) AS REAL) / CAST(COUNT(sub.${aggArg}) AS REAL) END FROM ${cteAlias} sub WHERE ${whereExclude})`;
        break;
      case 'MIN':
        aggExpr =
          `(SELECT MIN(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereExclude})`;
        break;
      case 'MAX':
        aggExpr =
          `(SELECT MAX(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereExclude})`;
        break;
      default:
        continue;
    }

    const escaped = escapeRegex(fullMatch);
    workingSelect = workingSelect.replace(new RegExp(escaped), aggExpr);
    found = true;
    counter++;
  }

  if (!found) {
    return { sql, rewritten: false };
  }

  // Assemble final SQL
  const ctePrefix = 'WITH ' + cteDefs.join(', ');
  const fromCte = cteAliases[0];
  const resultSql = `${ctePrefix}\nSELECT ${workingSelect}\nFROM ${fromCte}` +
    (outerTail ? ` ${outerTail}` : '');

  return { sql: resultSql, rewritten: true };
}

// ── Internal: PARTITION BY extraction ────────────────────────────

function extractPartitionBy(overContent: string): string {
  const m = overContent.match(/PARTITION\s+BY\s+(.+?)(?:\s+ORDER\s+BY\s+|$)/i);
  return m ? m[1].trim() : '';
}

// ── Internal: ORDER BY extraction ────────────────────────────────

function extractOrderBy(overContent: string): string {
  const m = overContent.match(/ORDER\s+BY\s+(.*)/i);
  return m ? m[1].trim() : '';
}

// ── Internal: CTE body splitting ─────────────────────────────────

function splitCteBody(fromBody: string): { cteFrom: string; outerTail: string } {
  const tailRe =
    /\s+(ORDER\s+BY\s+.*|LIMIT\s+.*|OFFSET\s+.*|FETCH\s+.*|FOR\s+UPDATE\s+.*)$/is;
  const tailMatch = fromBody.match(tailRe);
  if (tailMatch) {
    const cteFrom = fromBody.slice(0, tailMatch.index).trim();
    const outerTail = tailMatch[1].trim();
    return { cteFrom, outerTail };
  }
  return { cteFrom: fromBody, outerTail: '' };
}
