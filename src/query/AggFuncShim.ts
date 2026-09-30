/**
 * AggFuncShim — PostgreSQL aggregate function compatibility shim for SQLite.
 *
 * PostgreSQL supports many aggregate functions with no native SQLite
 * equivalent. This shim rewrites them into equivalent SQLite expressions using
 * CASE, AVG, SUM, COUNT, SQRT and arithmetic:
 *
 *   - boolean: `bool_and`, `bool_or`, `every`
 *   - statistics: `stddev`, `stddev_pop`, `stddev_samp`, `var_pop`, `var_samp`
 *   - two-variable: `covar_pop`, `covar_samp`, `corr`, `regr_*`
 *   - collection: `string_agg`, `array_agg`
 *   - ordered-set: `PERCENTILE_CONT`, `PERCENTILE_DISC`, `MODE`
 *
 * ## Strategy
 *
 * Rewriting is driven by a literal-aware scanner, not regex. The scanner skips
 * string literals, quoted identifiers, dollar-quoted strings and comments
 * (via `skipSqlLiteral`) and matches argument lists with balanced-paren
 * tracking, so a function name inside a literal/comment is never rewritten and
 * a nested expression inside an argument is never truncated by a greedy
 * `[^)]+` pattern.
 *
 * @module AggFuncShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('AggFuncShim');

// ── Types ────────────────────────────────────────────────────────

export interface AggFuncResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Function registry ───────────────────────────────────────────

/**
 * Kinds of rewrite rule. `call` functions take a fixed number of comma-
 * separated arguments. `stringAgg` accepts one or two arguments with an
 * optional `ORDER BY`. `arrayAgg` replaces only the function-name prefix
 * (keeping the argument list intact, including `DISTINCT`). `withinGroup`
 * handles ordered-set aggregates using the `... WITHIN GROUP (ORDER BY ...)`
 * grammar.
 */
type RuleKind = 'call' | 'stringAgg' | 'arrayAgg' | 'withinGroup';

interface AggRewriteRule {
  kind: RuleKind;
  /** For `call` rules: the exact number of comma-separated arguments. */
  arity?: 1 | 2;
  render: (args: string[], extra?: string) => string;
}

/**
 * Ordered registry of every PostgreSQL aggregate function this shim rewrites.
 * Only the lowercased name is matched, so case-insensitivity is handled by the
 * scanner. Lookup always prefers the longest name to avoid prefix ambiguity
 * (e.g. `stddev_samp` before `stddev`).
 */
const AGG_REWRITE_RULES: Record<string, AggRewriteRule> = {
  bool_and: {
    kind: 'call',
    arity: 1,
    render: ([e]) => `MIN(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  bool_or: {
    kind: 'call',
    arity: 1,
    render: ([e]) => `MAX(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  every: {
    kind: 'call',
    arity: 1,
    render: ([e]) => `MIN(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  stddev_pop: {
    kind: 'call',
    arity: 1,
    render: ([e]) => `SQRT(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`,
  },
  stddev_samp: {
    kind: 'call',
    arity: 1,
    render: ([e]) =>
      `SQRT((SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL))`,
  },
  stddev: {
    kind: 'call',
    arity: 1,
    render: ([e]) =>
      `SQRT((SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL))`,
  },
  var_pop: {
    kind: 'call',
    arity: 1,
    render: ([e]) => `(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`,
  },
  var_samp: {
    kind: 'call',
    arity: 1,
    render: ([e]) =>
      `(SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL)`,
  },
  covar_pop: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) => `(AVG(${y}*${x}) - AVG(${y})*AVG(${x}))`,
  },
  covar_samp: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) =>
      `((AVG(${y}*${x}) - AVG(${y})*AVG(${x})) * CAST(COUNT(*) AS REAL) / CAST(MAX(COUNT(*) - 1, 1) AS REAL))`,
  },
  corr: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      const sumX = `SUM(${x})`;
      const sumY = `SUM(${y})`;
      const sumXY = `SUM(${y}*${x})`;
      const sumX2 = `SUM(${x}*${x})`;
      const sumY2 = `SUM(${y}*${y})`;
      return `((${n}*${sumXY} - ${sumX}*${sumY}) / SQRT(MAX((${n}*${sumX2} - ${sumX}*${sumX}) * (${n}*${sumY2} - ${sumY}*${sumY}), 1e-100)))`;
    },
  },
  regr_avgx: {
    kind: 'call',
    arity: 2,
    render: ([_y, x]) => `AVG(${x})`,
  },
  regr_avgy: {
    kind: 'call',
    arity: 2,
    render: ([y]) => `AVG(${y})`,
  },
  regr_count: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) =>
      `COUNT(CASE WHEN ${y} IS NOT NULL AND ${x} IS NOT NULL THEN 1 END)`,
  },
  regr_intercept: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      return `(AVG(${y}) - ((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})), 1e-100)) * AVG(${x}))`;
    },
  },
  regr_r2: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      const corrExpr = `((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / SQRT(MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})) * (${n}*SUM(${y}*${y}) - SUM(${y})*SUM(${y})), 1e-100)))`;
      return `POWER(${corrExpr}, 2)`;
    },
  },
  regr_slope: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      return `((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})), 1e-100))`;
    },
  },
  regr_sxx: {
    kind: 'call',
    arity: 2,
    render: ([_y, x]) =>
      `(SUM(${x}*${x}) - SUM(${x})*SUM(${x})/CAST(COUNT(*) AS REAL))`,
  },
  regr_sxy: {
    kind: 'call',
    arity: 2,
    render: ([y, x]) =>
      `(SUM(${x}*${y}) - SUM(${x})*SUM(${y})/CAST(COUNT(*) AS REAL))`,
  },
  regr_syy: {
    kind: 'call',
    arity: 2,
    render: ([y]) =>
      `(SUM(${y}*${y}) - SUM(${y})*SUM(${y})/CAST(COUNT(*) AS REAL))`,
  },
  string_agg: {
    kind: 'stringAgg',
    render: (args, orderBy) => {
      const [expr, delim] = args;
      if (orderBy !== undefined) {
        // Ordered concatenation: build an ordered json array, then join it.
        return `(SELECT group_concat(value, ${delim}) FROM json_each((SELECT json_group_array(${expr} ORDER BY ${orderBy}) FROM ___subq___)))`;
      }
      if (delim !== undefined) {
        return `GROUP_CONCAT(${expr}, ${delim})`;
      }
      return `GROUP_CONCAT(${expr})`;
    },
  },
  array_agg: {
    kind: 'arrayAgg',
    render: ([rawArgs]) => `json_group_array(${rawArgs})`,
  },
  percentile_cont: {
    kind: 'withinGroup',
    render: ([frac], orderBy) =>
      `(SELECT ${orderBy} FROM (SELECT ${orderBy}, ROW_NUMBER() OVER (ORDER BY ${orderBy}) - 1 AS rn, COUNT(*) OVER () AS cnt FROM ___subq___) WHERE CAST(rn AS REAL) >= CAST(cnt AS REAL) * ${frac} ORDER BY rn LIMIT 1)`,
  },
  percentile_disc: {
    kind: 'withinGroup',
    render: ([frac], orderBy) =>
      `(SELECT ${orderBy} FROM (SELECT ${orderBy}, ROW_NUMBER() OVER (ORDER BY ${orderBy}) - 1 AS rn, COUNT(*) OVER () AS cnt FROM ___subq___) WHERE CAST(rn AS REAL) >= CAST(CEIL(CAST(cnt AS REAL) * ${frac}) - 1 AS REAL) ORDER BY rn LIMIT 1)`,
  },
  mode: {
    kind: 'withinGroup',
    render: (_args, orderBy) =>
      `(SELECT ${orderBy} FROM ___subq___ GROUP BY ${orderBy} ORDER BY COUNT(*) DESC LIMIT 1)`,
  },
};

/**
 * Rule names sorted by length descending so the scanner matches the longest
 * candidate first and never confuses a shorter prefix with a longer function.
 */
const AGG_FUNC_NAMES = Object.keys(AGG_REWRITE_RULES).sort((a, b) => b.length - a.length);

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains PostgreSQL aggregate functions
 * that SQLite does not support.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if an unsupported aggregate function is detected
 */
export function detectAggFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return findNextAggCall(sql, 0) !== null;
}

/**
 * Rewrite a SQL string that may contain PostgreSQL aggregate functions into
 * SQLite-compatible expressions.
 *
 * @param sql - The raw SQL string to process
 * @returns An AggFuncResult with the rewritten SQL and a flag indicating if changes were made
 */
export function rewriteAggFunc(sql: string): AggFuncResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = '';
  let cursor = 0;
  let rewritten = false;
  const len = sql.length;

  while (cursor < len) {
    const found = findNextAggCall(sql, cursor);
    if (found === null) {
      result += sql.slice(cursor);
      break;
    }

    result += sql.slice(cursor, found.start);
    result += found.replacement;
    rewritten = true;
    cursor = found.end;
  }

  if (rewritten) {
    logger.debug({ before: sql, after: result }, 'Aggregate function rewritten');
  }

  return { sql: result, rewritten };
}

// ── Internal scanner helpers ─────────────────────────────────────

interface LocatedAggCall {
  /** Index of the function name's first character. */
  start: number;
  /** Index just past the end of the rewritten construct. */
  end: number;
  /** The SQLite-compatible replacement expression. */
  replacement: string;
}

/** True when `c` is a character that can occur in an identifier. */
function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

/**
 * Find the next rewriteable aggregate function call at or after `from`,
 * skipping string literals, quoted identifiers, dollar-quoted strings and
 * comments so keywords inside them never match.
 *
 * @returns The located call, or `null` if none remain.
 */
function findNextAggCall(sql: string, from: number): LocatedAggCall | null {
  const len = sql.length;

  for (let i = from; i < len; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const boundaryOk = i === 0 || !isIdentChar(sql[i - 1]);
    if (!boundaryOk) {
      i++;
      continue;
    }

    for (const name of AGG_FUNC_NAMES) {
      if (sql.slice(i, i + name.length).toLowerCase() !== name) continue;

      // Require `(` after the name (allowing whitespace).
      let open = i + name.length;
      while (open < len && /\s/.test(sql[open])) open++;
      if (open >= len || sql[open] !== '(') continue;

      const rule = AGG_REWRITE_RULES[name];
      const located = locateByKind(sql, i, open, name, rule);
      if (located !== null) return located;
      // No valid match for this name; fall through to the next name/slot.
    }

    i++;
  }

  return null;
}

/**
 * Locate and rewrite a single function call `name(...)` whose opening paren is
 * at `open`, dispatching on the rule kind. Returns `null` when the construct is
 * not a valid call of the expected shape (unbalanced, wrong arity, or an empty
 * argument), in which case the caller keeps scanning.
 */
function locateByKind(
  sql: string,
  nameStart: number,
  open: number,
  name: string,
  rule: AggRewriteRule,
): LocatedAggCall | null {
  const closeParen = findMatchingParen(sql, open);
  if (closeParen === -1) return null; // unbalanced — leave the rest untouched

  const rawArgs = sql.slice(open + 1, closeParen);

  if (rule.kind === 'arrayAgg') {
    // Prefix replacement: keep the argument list verbatim (including DISTINCT).
    return {
      start: nameStart,
      end: closeParen + 1,
      replacement: rule.render([rawArgs]),
    };
  }

  if (rule.kind === 'stringAgg') {
    const args = splitTopLevelCommas(rawArgs).map((a) => a.trim());
    if (args.length < 1 || args.length > 2 || args.some((a) => a.length === 0)) {
      return null;
    }
    // Detect a trailing `ORDER BY` inside the final argument.
    const orderBy = extractStringAggOrderBy(args);
    const renderArgs = orderBy !== undefined ? [args[0], orderBy.delim] : args;
    if (orderBy !== undefined && renderArgs.some((a) => a.length === 0)) return null;
    return {
      start: nameStart,
      end: closeParen + 1,
      replacement: rule.render(renderArgs, orderBy?.orderBy),
    };
  }

  if (rule.kind === 'withinGroup') {
    const args = splitTopLevelCommas(rawArgs).map((a) => a.trim());
    // `MODE()` takes no argument; `PERCENTILE_CONT/DISC` take exactly one.
    const validArity = name === 'mode' ? args.length === 0 : args.length === 1;
    if (!validArity || (args.length > 0 && args[0].length === 0)) return null;
    const orderBy = findWithinGroupOrderBy(sql, closeParen);
    if (orderBy === null) return null;
    return {
      start: nameStart,
      end: orderBy.end,
      replacement: rule.render(args, orderBy.orderBy),
    };
  }

  // `call` rules.
  const args = rule.arity === 1
    ? [rawArgs.trim()]
    : splitTopLevelCommas(rawArgs).map((a) => a.trim());

  if (args.length !== rule.arity || args.some((a) => a.length === 0)) {
    return null;
  }

  return {
    start: nameStart,
    end: closeParen + 1,
    replacement: rule.render(args),
  };
}

/**
 * Extract an `ORDER BY` clause from a `string_agg` argument list. When present,
 * the second argument is the delimiter and the trailing `ORDER BY ...` names the
 * ordering expression. Returns `undefined` when there is no `ORDER BY`.
 */
function extractStringAggOrderBy(
  args: string[],
): { delim: string; orderBy: string } | undefined {
  if (args.length < 2) return undefined;

  const second = args[1];
  const m = /\s+ORDER\s+BY\s+/i.exec(second);
  if (!m) return undefined;

  const delim = second.slice(0, m.index).trim();
  const orderBy = second.slice(m.index + m[0].length).trim();
  if (delim.length === 0 || orderBy.length === 0) return undefined;
  return { delim, orderBy };
}

/**
 * Find a trailing `WITHIN GROUP (ORDER BY ...)` clause following the closing
 * paren at `closeParen`, returning the trimmed ordering expression and the index
 * just past the clause's closing paren, or `null` when absent or malformed.
 */
function findWithinGroupOrderBy(
  sql: string,
  closeParen: number,
): { orderBy: string; end: number } | null {
  let i = closeParen + 1;
  while (i < sql.length && /\s/.test(sql[i])) i++;

  const within = 'WITHIN';
  if (sql.slice(i, i + within.length).toUpperCase() !== within) return null;
  i += within.length;
  while (i < sql.length && /\s/.test(sql[i])) i++;

  const group = 'GROUP';
  if (sql.slice(i, i + group.length).toUpperCase() !== group) return null;
  i += group.length;
  while (i < sql.length && /\s/.test(sql[i])) i++;

  if (i >= sql.length || sql[i] !== '(') return null;
  const orderParen = i;
  const closeOrder = findMatchingParen(sql, orderParen);
  if (closeOrder === -1) return null;

  const orderContent = sql.slice(orderParen + 1, closeOrder).trim();
  const m = /^ORDER\s+BY\s+/i.exec(orderContent);
  if (!m) return null;

  const orderBy = orderContent.slice(m[0].length).trim();
  if (orderBy.length === 0) return null;
  return { orderBy, end: closeOrder + 1 };
}

/**
 * Find the index of the `)` that balances the `(` at `openParen`, honoring
 * string literals, quoted identifiers, dollar-quoted strings and comments.
 * Returns `-1` if the parentheses are unbalanced.
 */
function findMatchingParen(sql: string, openParen: number): number {
  let depth = 0;
  const len = sql.length;

  for (let i = openParen; i < len; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }

  return -1;
}

/**
 * Split an argument list by commas only at the top nesting level, honoring
 * string literals, quoted identifiers, dollar-quoted strings and comments so
 * commas inside them are not treated as separators.
 */
function splitTopLevelCommas(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const len = content.length;

  for (let i = 0; i < len; ) {
    const skipped = skipSqlLiteral(content, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const ch = content[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(content.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }

  const last = content.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}
