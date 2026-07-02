/**
 * GroupsWindowShim — PostgreSQL GROUPS window frame mode simulation for SQLite.
 *
 * SQLite supports only ROWS and RANGE frame modes, not GROUPS.
 * GROUPS defines peer groups based on ORDER BY values: rows with the same
 * ORDER BY values form a single "peer group" (one group unit).
 *
 * ## Strategy
 *
 * Use CTE + DENSE_RANK + correlated subquery to simulate GROUPS semantics:
 *
 * ```sql
 * -- Input:
 * SELECT id, y, SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t
 *
 * -- Rewritten:
 * WITH __gws_cte_0 AS (
 *   SELECT *, DENSE_RANK() OVER (ORDER BY y) AS __gws_grp_0 FROM t
 * )
 * SELECT id, y, (
 *   SELECT COALESCE(SUM(sub.x), 0) FROM __gws_cte_0 sub
 *   WHERE sub.__gws_grp_0 BETWEEN __gws_cte_0.__gws_grp_0 - 1
 *     AND __gws_cte_0.__gws_grp_0 + 1
 * ) FROM __gws_cte_0
 * ```
 *
 * ## Supported frame patterns
 * - GROUPS BETWEEN N PRECEDING AND M FOLLOWING
 * - GROUPS UNBOUNDED PRECEDING
 * - GROUPS CURRENT ROW
 * - GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
 * - With PARTITION BY
 * - Aggregate functions: SUM, AVG, COUNT, MIN, MAX
 *
 * @module GroupsWindowShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('GroupsWindowShim');

// ── Types ────────────────────────────────────────────────────────

export interface GroupsShimResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/** Detects GROUPS as a window frame unit keyword. */
const GROUPS_AS_FRAME_UNIT = /\bGROUPS\b/i;

/**
 * Matches an OVER clause containing GROUPS frame specification.
 * Captures: (1) content before GROUPS, (2) the frame spec after GROUPS.
 */
const GROUPS_OVER_CLAUSE_RE =
  /OVER\s*\(\s*((?:[^()]|\([^()]*\))*?)\s+GROUPS\s+((?:BETWEEN\s+(?:\w+(?:\s+PRECEDING)?)\s+AND\s+(?:\w+(?:\s+FOLLOWING)?)|UNBOUNDED\s+PRECEDING|CURRENT\s+ROW|(?:BETWEEN\s+)?UNBOUNDED\s+(?:PRECEDING|FOLLOWING)(?:\s+AND\s+UNBOUNDED\s+(?:PRECEDING|FOLLOWING))?))\s*\)/i;

/**
 * Matches a GROUPS window function in a SELECT list.
 * Captures: (1) agg function, (2) agg arg, (3) over content, (4) frame spec.
 *
 * LIMIT: does not handle deeply nested parentheses in function arguments
 * or OVER clause. Falls back to ROWS replacement for complex expressions.
 */
const GROUPS_FN_SELECT_RE =
  /\b(SUM|AVG|COUNT|MIN|MAX)\s*\(\s*([^()]+)\s*\)\s*OVER\s*\(\s*((?:\s*PARTITION\s+BY\s+[^()]+?)?(?:\s*ORDER\s+BY\s+[^()]+?)?)\s+GROUPS\s+(BETWEEN\s+(?:\w+\s+)?(?:PRECEDING|FOLLOWING)?(?:\s+AND\s+(?:\w+\s+)?(?:PRECEDING|FOLLOWING)?)?|UNBOUNDED\s+PRECEDING|CURRENT\s+ROW)\s*\)/gi;

/**
 * Simple SELECT pattern: SELECT ... FROM ... rest_of_query.
 * Group 1 = SELECT columns, Group 2 = everything after FROM (table + WHERE/ORDER/etc).
 */
const SELECT_FROM_RE =
  /^\s*SELECT\s+(.+?)\s+FROM\s+(.+)$/is;

// ── Fallback ─────────────────────────────────────────────────────

const GROUPS_FALLBACK_WARNING =
  ' /* WARNING: GROUPS rewritten to ROWS (CTE rewrite not possible — peer-group semantics lost) */';

// ── Public API ───────────────────────────────────────────────────

/**
 * Check if the SQL contains GROUPS in a window function context.
 */
export function hasGroupsFrame(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  return GROUPS_AS_FRAME_UNIT.test(sql) && GROUPS_OVER_CLAUSE_RE.test(sql);
}

/**
 * Detect whether the given SQL string contains GROUPS window frame mode.
 */
export function detectGroupsFrame(sql: string): boolean {
  return hasGroupsFrame(sql);
}

/**
 * Rewrite SQL with GROUPS frame specification using CTE + DENSE_RANK + subquery.
 *
 * Preserves peer-group semantics via correlated subquery on DENSE_RANK groups.
 * Falls back to GROUPS → ROWS replacement when CTE rewrite is not feasible.
 *
 * @param sql - The raw SQL string to process
 * @returns GroupsShimResult with rewritten SQL
 *
 * @example
 * ```ts
 * const r = rewriteGroupsFrame(
 *   'SELECT id, y, SUM(x) OVER (ORDER BY y GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM t'
 * );
 * // → rewritten: true, sql contains CTE + correlated subquery
 * ```
 */
export function rewriteGroupsFrame(sql: string): GroupsShimResult {
  if (!hasGroupsFrame(sql)) {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // Check if CTE rewrite is feasible (must be simple SELECT)
  if (!isSimpleSelect(trimmed)) {
    const fallback = trimmed.replace(/\bGROUPS\b/gi, 'ROWS') + GROUPS_FALLBACK_WARNING;
    logger.debug({ sql: trimmed }, 'GROUPS → ROWS fallback (not simple SELECT)');
    return { sql: fallback, rewritten: true };
  }

  // Try CTE rewrite
  try {
    const cteResult = rewriteWithCTE(trimmed);
    if (cteResult.rewritten) {
      logger.debug({ original: trimmed, rewritten: cteResult.sql }, 'GROUPS rewritten via CTE');
      return cteResult;
    }
  } catch (err: any) {
    logger.warn({ err: err.message, sql: trimmed }, 'CTE rewrite failed');
  }

  // Fallback: GROUPS → ROWS replacement
  const fallback = trimmed.replace(/\bGROUPS\b/gi, 'ROWS') + GROUPS_FALLBACK_WARNING;
  return { sql: fallback, rewritten: true };
}

// ── Internal: simple select check ────────────────────────────────

function isSimpleSelect(sql: string): boolean {
  const trimmed = sql.trim();
  return /^\s*SELECT\b/i.test(trimmed);
}

// ── Internal: frame spec parsing ─────────────────────────────────

interface FrameSpec {
  type: 'between' | 'unbounded_preceding' | 'current_row' | 'unbounded_both';
  lower?: number | 'UNBOUNDED';
  upper?: number | 'UNBOUNDED';
}

function parseGroupsFrameSpec(frameSpec: string): FrameSpec {
  const s = frameSpec.trim().toUpperCase();

  // GROUPS BETWEEN N PRECEDING AND M FOLLOWING
  const betweenMatch = s.match(
    /^BETWEEN\s+(?:(\d+)\s+)?PRECEDING\s+AND\s+(?:(\d+)\s+)?FOLLOWING$/,
  );
  if (betweenMatch) {
    return {
      type: 'between',
      lower: betweenMatch[1] ? parseInt(betweenMatch[1], 10) : 'UNBOUNDED',
      upper: betweenMatch[2] ? parseInt(betweenMatch[2], 10) : 'UNBOUNDED',
    };
  }

  // GROUPS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  if (/^BETWEEN\s+UNBOUNDED\s+PRECEDING\s+AND\s+UNBOUNDED\s+FOLLOWING$/.test(s)) {
    return { type: 'unbounded_both' };
  }

  // GROUPS UNBOUNDED PRECEDING
  if (/^UNBOUNDED\s+PRECEDING$/.test(s)) {
    return { type: 'unbounded_preceding' };
  }

  // GROUPS CURRENT ROW
  if (/^CURRENT\s+ROW$/.test(s)) {
    return { type: 'current_row' };
  }

  // Default: unbounded preceding
  return { type: 'unbounded_preceding' };
}

// ── Internal: PARTITION BY extraction ────────────────────────────

function extractPartitionBy(overContent: string): string {
  const m = overContent.match(/PARTITION\s+BY\s+(.+?)(?:\s+ORDER\s+BY\s+|$)/i);
  return m ? m[1].trim() : '';
}

function extractOrderBy(overContent: string): string {
  const m = overContent.match(/ORDER\s+BY\s+(.*)/i);
  return m ? m[1].trim() : '';
}

// ── Internal: CTE rewrite ────────────────────────────────────────

function rewriteWithCTE(sql: string): GroupsShimResult {
  const selectMatch = sql.match(SELECT_FROM_RE);
  if (!selectMatch) {
    return { sql, rewritten: false };
  }

  const selectClause = selectMatch[1].trim();
  const fromBody = selectMatch[2].trim();

  // Extract trailing ORDER BY, LIMIT, OFFSET from the fromBody
  // so they stay on the outer query (not inside the CTE)
  const { cteFrom, outerTail } = splitCteBody(fromBody);

  // Reset regex state
  GROUPS_FN_SELECT_RE.lastIndex = 0;

  let counter = 0;
  let workingSelect = selectClause;
  const cteDefs: string[] = [];
  const cteAliasList: string[] = [];
  let found = false;

  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = GROUPS_FN_SELECT_RE.exec(workingSelect)) !== null) {
    const fullMatch = fnMatch[0];
    const aggFunc = fnMatch[1];
    const aggArg = fnMatch[2].trim();
    const overContent = fnMatch[3].trim();
    const frameSpec = fnMatch[4].trim();

    const cteAlias = `__gws_cte_${counter}`;
    const grpAlias = `__gws_grp_${counter}`;
    cteAliasList.push(cteAlias);

    // Build DENSE_RANK clause
    const partitionBy = extractPartitionBy(overContent);
    const orderBy = extractOrderBy(overContent);
    const denseRankPartition = partitionBy
      ? `PARTITION BY ${partitionBy}`
      : '';
    const denseRankClause = `DENSE_RANK() OVER (${denseRankPartition} ORDER BY ${orderBy})`;

    // CTE definition (same base data for each)
    cteDefs.push(`${cteAlias} AS (SELECT *, ${denseRankClause} AS ${grpAlias} FROM ${cteFrom})`);

    // Build the correlated subquery
    const subquery = buildSubquery(aggFunc, aggArg, frameSpec, partitionBy, grpAlias, cteAlias);

    // Escape the original function match for safe regex (only replace one occurrence)
    const escapedFn = escapeRegex(fullMatch);
    workingSelect = workingSelect.replace(new RegExp(escapedFn), subquery);
    found = true;
    counter++;
  }

  if (!found) {
    return { sql, rewritten: false };
  }

  // Assemble final SQL
  const ctePrefix = 'WITH ' + cteDefs.join(', ');
  const fromCte = cteAliasList[0];
  const resultSql = `${ctePrefix}\nSELECT ${workingSelect}\nFROM ${fromCte}` +
    (outerTail ? ` ${outerTail}` : '');

  return { sql: resultSql, rewritten: true };
}

/**
 * Split the FROM body into CTE portion and outer tail.
 * The CTE portion includes table + WHERE/GROUP BY/HAVING/WINDOW.
 * The outer tail includes ORDER BY, LIMIT, OFFSET, FETCH, FOR UPDATE.
 */
function splitCteBody(fromBody: string): { cteFrom: string; outerTail: string } {
  // Match trailing ORDER BY, LIMIT, OFFSET, FETCH, FOR UPDATE
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

// ── Internal: subquery builder ───────────────────────────────────

function buildSubquery(
  aggFunc: string,
  aggArg: string,
  frameSpec: string,
  partitionBy: string,
  grpAlias: string,
  cteAlias: string,
): string {
  const frame = parseGroupsFrameSpec(frameSpec);

  // Build group range filter (WHERE clause for the subquery)
  let groupFilter: string;
  switch (frame.type) {
    case 'between': {
      const lower = frame.lower === 'UNBOUNDED'
        ? '-999999999'
        : `${cteAlias}.${grpAlias} - ${frame.lower}`;
      const upper = frame.upper === 'UNBOUNDED'
        ? '999999999'
        : `${cteAlias}.${grpAlias} + ${frame.upper}`;
      groupFilter = `sub.${grpAlias} BETWEEN ${lower} AND ${upper}`;
      break;
    }
    case 'unbounded_preceding':
      groupFilter = `sub.${grpAlias} <= ${cteAlias}.${grpAlias}`;
      break;
    case 'current_row':
      groupFilter = `sub.${grpAlias} = ${cteAlias}.${grpAlias}`;
      break;
    case 'unbounded_both':
      groupFilter = '1=1';
      break;
    default:
      groupFilter = `sub.${grpAlias} <= ${cteAlias}.${grpAlias}`;
  }

  // Add PARTITION BY filters
  let partitionFilter = '';
  if (partitionBy) {
    const pcols = partitionBy.split(',').map((c) => c.trim().replace(/["`]/g, ''));
    partitionFilter = ' AND ' + pcols
      .map((c) => `sub.${c} = ${cteAlias}.${c}`)
      .join(' AND ');
  }

  const whereClause = groupFilter + partitionFilter;

  // Build aggregate function for the subquery
  const fn = aggFunc.toUpperCase();
  let aggExpr: string;

  switch (fn) {
    case 'SUM':
      aggExpr = `(SELECT COALESCE(SUM(sub.${aggArg}), 0) FROM ${cteAlias} sub WHERE ${whereClause})`;
      break;
    case 'COUNT':
      if (aggArg === '*' || aggArg === '1') {
        aggExpr = `(SELECT COUNT(*) FROM ${cteAlias} sub WHERE ${whereClause})`;
      } else {
        aggExpr = `(SELECT COUNT(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereClause})`;
      }
      break;
    case 'AVG':
      aggExpr = `(SELECT CASE WHEN COUNT(sub.${aggArg}) = 0 THEN NULL ELSE CAST(COALESCE(SUM(sub.${aggArg}), 0) AS REAL) / CAST(COUNT(sub.${aggArg}) AS REAL) END FROM ${cteAlias} sub WHERE ${whereClause})`;
      break;
    case 'MIN':
      aggExpr = `(SELECT MIN(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereClause})`;
      break;
    case 'MAX':
      aggExpr = `(SELECT MAX(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereClause})`;
      break;
    default:
      aggExpr = `(SELECT ${aggFunc}(sub.${aggArg}) FROM ${cteAlias} sub WHERE ${whereClause})`;
  }

  return aggExpr;
}

// ── Internal: regex escape ───────────────────────────────────────

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
