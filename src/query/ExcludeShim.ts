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

import { PinoLogger } from '../logger/PinoLogger';
import { protectSQL, restoreSQL } from './LiteralProtectionLayer';

const logger = PinoLogger.forComponent('ExcludeShim');

// ── Types ────────────────────────────────────────────────────────

export interface ExcludeShimResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

/** Aggregate function names this shim can rewrite arithmetically. */
type ArithmeticAggFunc = 'SUM' | 'AVG' | 'COUNT';

/** Aggregate function names the CTE (GROUP/TIES) path can rewrite. */
type CteAggFunc = 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX';

/** EXCLUDE variants handled by the CTE (GROUP/TIES) path. */
type CteExcludeType = 'GROUP' | 'TIES';

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
  // Mask string literals and comments so `EXCLUDE` inside them is not matched
  // (BUG #431/#432).
  const { protectedSql } = protectSQL(sql);
  return ANY_EXCLUDE.test(protectedSql);
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

  // Mask literals/comments so regexes never rewrite their contents (BUG #431/#432).
  const protectedSql = protectSQL(sql);

  const trimmed = protectedSql.protectedSql.trim();

  // EXCLUDE NO OTHERS is the default behavior — just strip it
  if (/\bEXCLUDE\s+NO\s+OTHERS\b/i.test(trimmed)) {
    const result = trimmed.replace(EXCLUDE_NO_OTHERS_RE, '');
    return { sql: restoreSQL({ ...protectedSql, protectedSql: result }), rewritten: true };
  }

  // Check if we can do EXCLUDE CURRENT ROW with arithmetic adjustment
  if (/\bEXCLUDE\s+CURRENT\s+ROW\b/i.test(trimmed)) {
    const arithmeticResult = rewriteExcludeCurrentRow(trimmed);
    if (arithmeticResult.rewritten) {
      const out = restoreSQL({ ...protectedSql, protectedSql: arithmeticResult.sql });
      logger.debug(
        { original: sql, rewritten: out },
        'EXCLUDE CURRENT ROW rewritten with arithmetic adjustment',
      );
      return { sql: out, rewritten: true };
    }
  }

  // For EXCLUDE GROUP / EXCLUDE TIES, or fallback: strip EXCLUDE and add warning
  // EXCLUDE GROUP and EXCLUDE TIES require semantic correction similar to GROUPS
  // Try CTE rewrite first
  if (/\bEXCLUDE\s+(GROUP|TIES)\b/i.test(trimmed) && isSimpleSelect(trimmed)) {
    const cteResult = rewriteExcludeGroupTies(trimmed);
    if (cteResult.rewritten) {
      const out = restoreSQL({ ...protectedSql, protectedSql: cteResult.sql });
      logger.debug(
        { original: sql, rewritten: out, type: 'EXCLUDE GROUP/TIES' },
        'EXCLUDE GROUP/TIES rewritten with CTE',
      );
      return { sql: out, rewritten: true };
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
  const out = restoreSQL({ ...protectedSql, protectedSql: working });
  logger.debug({ original: sql, rewritten: out }, 'EXCLUDE clause stripped (fallback)');
  return { sql: out, rewritten: true };
}

// ── Internal: simple select check ────────────────────────────────

function isSimpleSelect(sql: string): boolean {
  return /^\s*SELECT\b/i.test(sql.trim());
}

// ── Internal: parenthesis matcher ────────────────────────────────

/**
 * Return the index of the `)` that balances the `(` at `openParen`, or -1.
 *
 * The input has already been passed through `protectSQL`, so every string
 * literal, quoted identifier, dollar-quoted string, and comment has been
 * replaced by a `__LIT_N__` placeholder (which contains no parens). Plain
 * depth counting is therefore unambiguous.
 */
function findMatchingParen(sql: string, openParen: number): number {
  let depth = 0;
  for (let i = openParen; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ── Internal: EXCLUDE CURRENT ROW (arithmetic) ───────────────────

/**
 * Rewrite EXCLUDE CURRENT ROW using arithmetic adjustment.
 *
 * Strategy: strip EXCLUDE, then wrap the result with current-row subtraction.
 * Only applies to SUM, AVG, COUNT on ROWS/RANGE frames (not GROUPS).
 */
function rewriteExcludeCurrentRow(sql: string): ExcludeShimResult {
  // Scan for SUM/AVG/COUNT(...) OVER (... EXCLUDE CURRENT ROW ...) using a
  // balanced-paren approach. This handles nested arguments like SUM(f(a,b))
  // that a `[^()]+` regex cannot (BUG #433). Literals are already masked by
  // protectSQL before this routine runs.
  let working = sql;
  let found = false;

  let i = 0;
  while (i < working.length) {
    // Match an aggregate function name at a word boundary.
    const fnMatch = /^(SUM|AVG|COUNT)\b/i.exec(working.slice(i));
    if (!fnMatch) {
      i++;
      continue;
    }

    const aggFunc = fnMatch[1].toUpperCase() as ArithmeticAggFunc;
    let j = i + fnMatch[0].length;

    // Skip whitespace then expect an opening paren.
    while (j < working.length && /\s/.test(working[j])) j++;
    if (working[j] !== '(') {
      i++;
      continue;
    }

    const argOpen = j;
    const argClose = findMatchingParen(working, argOpen);
    if (argClose === -1) {
      i++;
      continue;
    }
    const aggArg = working.slice(argOpen + 1, argClose).trim();

    // After the argument, look for OVER (...).
    let k = argClose + 1;
    while (k < working.length && /\s/.test(working[k])) k++;
    const overMatch = /^OVER\b/i.exec(working.slice(k));
    if (!overMatch) {
      i = argClose + 1;
      continue;
    }
    k += overMatch[0].length;
    while (k < working.length && /\s/.test(working[k])) k++;
    if (working[k] !== '(') {
      i = argClose + 1;
      continue;
    }

    const overOpen = k;
    const overClose = findMatchingParen(working, overOpen);
    if (overClose === -1) {
      i = argClose + 1;
      continue;
    }
    const overContent = working.slice(overOpen + 1, overClose).trim();

    // Ensure the OVER clause actually contains EXCLUDE CURRENT ROW.
    if (!/\bEXCLUDE\s+CURRENT\s+ROW\b/i.test(overContent)) {
      i = overClose + 1;
      continue;
    }

    // Do not apply arithmetic if the frame uses GROUPS (GROUPS shim handles it).
    if (/\bGROUPS\b/i.test(overContent)) {
      i = overClose + 1;
      continue;
    }

    // Strip EXCLUDE CURRENT ROW from the OVER clause.
    const cleanOver = overContent
      .replace(/\bEXCLUDE\s+CURRENT\s+ROW\b/i, '')
      .trim();
    const cleanOverClause = `OVER (${cleanOver})`;

    let replacement: string;
    switch (aggFunc) {
      case 'SUM':
        replacement = `COALESCE(SUM(${aggArg}) ${cleanOverClause}, 0) - COALESCE(${aggArg}, 0)`;
        break;
      case 'COUNT':
        if (aggArg === '*' || aggArg === '1') {
          replacement = `COUNT(${aggArg}) ${cleanOverClause} - 1`;
        } else {
          replacement = `COUNT(${aggArg}) ${cleanOverClause} - CASE WHEN ${aggArg} IS NOT NULL THEN 1 ELSE 0 END`;
        }
        break;
      case 'AVG':
        // AVG(x) with the current row excluded = (SUM(x) - x) / (COUNT(x) - 1),
        // preserving NULL semantics: a NULL current row contributes to neither
        // SUM nor COUNT, so subtract 0 in both. The denominator must be COUNT
        // (not AVG). (BUG: previously divided by AVG(x) - 1, which is a unit
        // mismatch and yields wildly wrong results.)
        replacement =
          `CAST(COALESCE(SUM(${aggArg}) ${cleanOverClause}, 0) - COALESCE(${aggArg}, 0) AS REAL) / ` +
          `CAST(COUNT(${aggArg}) ${cleanOverClause} - CASE WHEN ${aggArg} IS NOT NULL THEN 1 ELSE 0 END AS REAL)`;
        break;
      default:
        // Unreachable: the scan regex only yields SUM/AVG/COUNT.
        i = overClose + 1;
        continue;
    }

    const fullLen = overClose + 1 - i;
    working = working.slice(0, i) + replacement + working.slice(overClose + 1);
    found = true;
    // Advance past the replacement to avoid re-scanning it.
    i += replacement.length;
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

  let counter = 0;
  let workingSelect = selectClause;
  const cteDefs: string[] = [];
  const cteAliases: string[] = [];
  let found = false;

  // Scan the SELECT list for AGG(arg) OVER (... EXCLUDE GROUP|TIES ...) using a
  // balanced-paren approach so nested args like SUM(f(a,b)) work (BUG #435).
  // Literals are already masked by protectSQL before this routine runs.
  let i = 0;
  while (i < workingSelect.length) {
    const fnMatch = /^(SUM|AVG|COUNT|MIN|MAX)\b/i.exec(workingSelect.slice(i));
    if (!fnMatch) {
      i++;
      continue;
    }

    const aggFunc = fnMatch[1].toUpperCase() as CteAggFunc;
    let j = i + fnMatch[0].length;
    while (j < workingSelect.length && /\s/.test(workingSelect[j])) j++;
    if (workingSelect[j] !== '(') {
      i++;
      continue;
    }

    const argOpen = j;
    const argClose = findMatchingParen(workingSelect, argOpen);
    if (argClose === -1) {
      i = argOpen + 1;
      continue;
    }
    const aggArg = workingSelect.slice(argOpen + 1, argClose).trim();

    // Expect OVER (...).
    let k = argClose + 1;
    while (k < workingSelect.length && /\s/.test(workingSelect[k])) k++;
    const overMatch = /^OVER\b/i.exec(workingSelect.slice(k));
    if (!overMatch) {
      i = argClose + 1;
      continue;
    }
    k += overMatch[0].length;
    while (k < workingSelect.length && /\s/.test(workingSelect[k])) k++;
    if (workingSelect[k] !== '(') {
      i = argClose + 1;
      continue;
    }

    const overOpen = k;
    const overClose = findMatchingParen(workingSelect, overOpen);
    if (overClose === -1) {
      i = argClose + 1;
      continue;
    }
    const overContent = workingSelect.slice(overOpen + 1, overClose).trim();

    // Determine the EXCLUDE type present in the OVER clause.
    const excludeMatch = /\bEXCLUDE\s+(CURRENT\s+ROW|GROUP|TIES)\b/i.exec(overContent);
    if (!excludeMatch) {
      i = overClose + 1;
      continue;
    }
    const excludeTypeRaw = excludeMatch[1].trim().toUpperCase();

    // EXCLUDE CURRENT ROW is handled by the arithmetic path.
    if (excludeTypeRaw === 'CURRENT ROW') {
      i = overClose + 1;
      continue;
    }
    const excludeType = excludeTypeRaw as CteExcludeType;

    const cteAlias = `__exc_cte_${counter}`;
    const grpAlias = `__exc_grp_${counter}`;

    // Strip the EXCLUDE spec from the OVER content so ORDER BY / PARTITION BY
    // extraction sees only the real frame spec (BUG #435 residual EXCLUDE).
    // Use `\b` not `\s+` so EXCLUDE at the very start of the frame is matched.
    const cleanOverContent = overContent.replace(/\bEXCLUDE\s+(GROUP|TIES)\b/i, '').trim();

    // Extract ORDER BY
    const orderByMatch = cleanOverContent.match(/ORDER\s+BY\s+(.+)/i);
    if (!orderByMatch) {
      // No ORDER BY — all rows are in one peer group; strip EXCLUDE only.
      const cleanFn =
        `${aggFunc}(${aggArg}) OVER (${cleanOverContent})`;
      workingSelect =
        workingSelect.slice(0, i) + cleanFn + workingSelect.slice(overClose + 1);
      found = true;
      counter++;
      i += cleanFn.length;
      continue;
    }

    const orderBy = orderByMatch[1].trim();

    // Extract PARTITION BY (from the cleaned content)
    const partitionBy = extractPartitionBy(cleanOverContent);

    cteAliases.push(cteAlias);

    // Build DENSE_RANK
    const drPartition = partitionBy ? `PARTITION BY ${partitionBy}` : '';
    const denseRankClause = `DENSE_RANK() OVER (${drPartition} ORDER BY ${orderBy})`;

    // CTE: same query with DENSE_RANK group numbers
    cteDefs.push(`${cteAlias} AS (SELECT *, ${denseRankClause} AS ${grpAlias} FROM ${cteFrom})`);

    // Build the subquery based on exclude type
    let whereExclude: string;
    switch (excludeType) {
      case 'GROUP':
        // EXCLUDE GROUP: exclude ALL peer rows (every row sharing the current
        // row's ORDER BY group), including the current row itself. Only rows
        // from other groups remain. (BUG #434 — previously kept other peers.)
        whereExclude = `sub.${grpAlias} <> ${cteAlias}.${grpAlias}`;
        break;
      case 'TIES':
        // EXCLUDE TIES: exclude peers but KEEP the current row. Rows from other
        // groups are kept, and the current row is kept. (BUG #434 — previously
        // collapsed to the current row only.)
        whereExclude = `sub.${grpAlias} <> ${cteAlias}.${grpAlias} OR sub.rowid = ${cteAlias}.rowid`;
        break;
      default:
        // Unreachable: EXCLUDE CURRENT ROW was skipped above; only GROUP/TIES
        // can reach this switch.
        i = overClose + 1;
        continue;
    }

    // Add PARTITION BY filter
    let partitionFilter = '';
    if (partitionBy) {
      // `partitionBy` is non-empty here, so `split(',')` always yields at least
      // one column; no separate length guard is needed.
      const pcols = partitionBy.split(',').map((c) => c.trim().replace(/["`]/g, ''));
      partitionFilter = pcols.map((c) => `sub.${c} = ${cteAlias}.${c}`).join(' AND ') + ' AND ';
    }

    // Build the aggregate subquery for the full frame range (without EXCLUDE)
    let aggExpr: string;
    switch (aggFunc) {
      case 'SUM':
        aggExpr =
          `(SELECT COALESCE(SUM(sub.${aggArg}), 0) FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        break;
      case 'COUNT':
        if (aggArg === '*' || aggArg === '1') {
          aggExpr =
            `(SELECT COUNT(*) FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        } else {
          aggExpr =
            `(SELECT COUNT(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        }
        break;
      case 'AVG':
        aggExpr =
          `(SELECT CASE WHEN COUNT(sub.${aggArg}) = 0 THEN NULL ELSE CAST(COALESCE(SUM(sub.${aggArg}), 0) AS REAL) / CAST(COUNT(sub.${aggArg}) AS REAL) END FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        break;
      case 'MIN':
        aggExpr =
          `(SELECT MIN(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        break;
      case 'MAX':
        aggExpr =
          `(SELECT MAX(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${partitionFilter}${whereExclude})`;
        break;
      default:
        // Unreachable: the scan regex only yields SUM/AVG/COUNT/MIN/MAX.
        i = overClose + 1;
        continue;
    }

    workingSelect =
      workingSelect.slice(0, i) + aggExpr + workingSelect.slice(overClose + 1);
    found = true;
    counter++;
    i += aggExpr.length;
  }

  if (!found) {
    return { sql, rewritten: false };
  }

  // When no CTE was actually built (every match lacked ORDER BY and was merely
  // stripped), return the stripped SELECT clause directly.
  if (cteAliases.length === 0) {
    return { sql: `SELECT ${workingSelect} FROM ${cteFrom}` + (outerTail ? ` ${outerTail}` : ''), rewritten: true };
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
