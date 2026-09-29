/**
 * AggregateFuncShim — PostgreSQL statistical aggregate function compatibility shim for SQLite.
 *
 * PostgreSQL supports a wide range of statistical aggregate functions:
 *   bool_and, bool_or, every, stddev_pop, stddev_samp, var_pop, var_samp,
 *   covar_pop, covar_samp, corr, regr_avgx, regr_avgy, regr_count,
 *   regr_intercept, regr_r2, regr_slope, regr_sxx, regr_sxy, regr_syy
 *
 * SQLite has no native support for these. This shim rewrites them into
 * equivalent SQLite expressions using CASE, AVG, SUM, COUNT and arithmetic.
 *
 * ## Strategy
 *
 * Each function is detected by regex pattern and rewritten to an equivalent
 * SQL expression. For complex statistical aggregates (covar, corr, regr_*),
 * the SQL-rewritten form uses running sum calculations.
 *
 * ## Rewrite Rules
 *
 * | PG Function              | SQLite Rewrite                                                     |
 * |--------------------------|--------------------------------------------------------------------|
 * | `bool_and(expr)`         | `MIN(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1`                     |
 * | `bool_or(expr)`          | `MAX(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1`                     |
 * | `every(expr)`            | `MIN(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1`                     |
 * | `stddev_pop(expr)`       | `SQRT(AVG((expr)*(expr)) - AVG(expr)*AVG(expr))`                  |
 * | `stddev_samp(expr)`      | `SQRT((AVG(expr*expr) - AVG(expr)*AVG(expr)) * cnt/(cnt-1))`      |
 * | `var_pop(expr)`          | `AVG((expr)*(expr)) - AVG(expr)*AVG(expr)`                        |
 * | `var_samp(expr)`         | `(AVG(expr*expr) - AVG(expr)*AVG(expr)) * cnt/(cnt-1)`            |
 * | `covar_pop(y, x)`        | `AVG(y*x) - AVG(y)*AVG(x)`                                        |
 * | `covar_samp(y, x)`       | `(AVG(y*x) - AVG(y)*AVG(x)) * cnt/(cnt-1)`                        |
 * | `corr(y, x)`             | `(n*Σxy - Σx*Σy) / SQRT((n*Σx² - (Σx)²)*(n*Σy² - (Σy)²))`       |
 * | `regr_avgx(y, x)`        | `AVG(x)`                                                           |
 * | `regr_avgy(y, x)`        | `AVG(y)`                                                           |
 * | `regr_count(y, x)`       | `COUNT(CASE WHEN y IS NOT NULL AND x IS NOT NULL THEN 1 END)`     |
 * | `regr_intercept(y, x)`   | `AVG(y) - (regr_slope(y,x) * AVG(x))`                             |
 * | `regr_r2(y, x)`          | `POWER(corr(y,x), 2)`                                              |
 * | `regr_slope(y, x)`       | `(n*Σxy - Σx*Σy) / (n*Σx² - (Σx)²)`                              |
 * | `regr_sxx(y, x)`         | `SUM(x*x) - SUM(x)*SUM(x)/COUNT(*)`                                |
 * | `regr_sxy(y, x)`         | `SUM(x*y) - SUM(x)*SUM(y)/COUNT(*)`                                |
 * | `regr_syy(y, x)`         | `SUM(y*y) - SUM(y)*SUM(y)/COUNT(*)`                                |
 *
 * @module AggregateFuncShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('AggregateFuncShim');

// ── Types ────────────────────────────────────────────────────────

export interface AggFuncResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Function registry ───────────────────────────────────────────

/**
 * A single aggregate-function rewrite rule.
 *
 * `arity` is the number of comma-separated arguments the SQL function takes
 * (1 for `bool_and(expr)`, 2 for `covar_pop(y, x)`). `render` receives the
 * trimmed argument expressions and returns the SQLite-compatible replacement.
 */
interface AggRewriteRule {
  arity: 1 | 2;
  render: (args: string[]) => string;
}

/**
 * Ordered registry of every PostgreSQL statistical aggregate function this shim
 * rewrites. Ordering matters: `every` must be tested before any longer name
 * would swallow it (none share a prefix here, so lookup is stable).
 */
const AGG_REWRITE_RULES: Record<string, AggRewriteRule> = {
  bool_and: {
    arity: 1,
    render: ([e]) => `MIN(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  bool_or: {
    arity: 1,
    render: ([e]) => `MAX(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  every: {
    arity: 1,
    render: ([e]) => `MIN(CASE WHEN (${e}) THEN 1 ELSE 0 END) = 1`,
  },
  stddev_pop: {
    arity: 1,
    render: ([e]) => `SQRT(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`,
  },
  stddev_samp: {
    arity: 1,
    render: ([e]) =>
      `SQRT((SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL))`,
  },
  var_pop: {
    arity: 1,
    render: ([e]) => `(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`,
  },
  var_samp: {
    arity: 1,
    render: ([e]) =>
      `(SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL)`,
  },
  covar_pop: {
    arity: 2,
    render: ([y, x]) => `(AVG(${y}*${x}) - AVG(${y})*AVG(${x}))`,
  },
  covar_samp: {
    arity: 2,
    render: ([y, x]) =>
      `((AVG(${y}*${x}) - AVG(${y})*AVG(${x})) * CAST(COUNT(*) AS REAL) / CAST(MAX(COUNT(*) - 1, 1) AS REAL))`,
  },
  corr: {
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
    arity: 2,
    render: ([_y, x]) => `AVG(${x})`,
  },
  regr_avgy: {
    arity: 2,
    render: ([y]) => `AVG(${y})`,
  },
  regr_count: {
    arity: 2,
    render: ([y, x]) =>
      `COUNT(CASE WHEN ${y} IS NOT NULL AND ${x} IS NOT NULL THEN 1 END)`,
  },
  regr_intercept: {
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      return `(AVG(${y}) - ((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})), 1e-100)) * AVG(${x}))`;
    },
  },
  regr_r2: {
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      const corrExpr = `((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / SQRT(MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})) * (${n}*SUM(${y}*${y}) - SUM(${y})*SUM(${y})), 1e-100)))`;
      return `POWER(${corrExpr}, 2)`;
    },
  },
  regr_slope: {
    arity: 2,
    render: ([y, x]) => {
      const n = `CAST(COUNT(*) AS REAL)`;
      return `((${n}*SUM(${y}*${x}) - SUM(${y})*SUM(${x})) / MAX((${n}*SUM(${x}*${x}) - SUM(${x})*SUM(${x})), 1e-100))`;
    },
  },
  regr_sxx: {
    arity: 2,
    render: ([_y, x]) =>
      `(SUM(${x}*${x}) - SUM(${x})*SUM(${x})/CAST(COUNT(*) AS REAL))`,
  },
  regr_sxy: {
    arity: 2,
    render: ([y, x]) =>
      `(SUM(${x}*${y}) - SUM(${x})*SUM(${y})/CAST(COUNT(*) AS REAL))`,
  },
  regr_syy: {
    arity: 2,
    render: ([y]) =>
      `(SUM(${y}*${y}) - SUM(${y})*SUM(${y})/CAST(COUNT(*) AS REAL))`,
  },
};

/**
 * Names of every rewrite rule, sorted by length descending so a scanner that
 * matches the longest candidate name first never mis-detects a shorter prefix
 * (e.g. `stddev_samp` before `stddev`).
 */
const AGG_FUNC_NAMES = Object.keys(AGG_REWRITE_RULES).sort((a, b) => b.length - a.length);

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains PostgreSQL statistical
 * aggregate functions that SQLite does not support.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if an unsupported aggregate function is detected
 */
export function detectAggFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return findNextAggCall(sql.trim(), 0) !== null;
}

/**
 * Rewrite a SQL string that may contain PostgreSQL statistical aggregate
 * functions into SQLite-compatible expressions.
 *
 * Each function is replaced with an equivalent SQL expression using
 * AVG, SUM, COUNT, CASE, SQRT, and POWER.
 *
 * @param sql - The raw SQL string to process
 * @returns An AggFuncResult with the rewritten SQL and a flag indicating if changes were made
 *
 * @example
 * ```ts
 * rewriteAggFunc("SELECT bool_and(active) FROM users")
 * // → { sql: "SELECT MIN(CASE WHEN (active) THEN 1 ELSE 0 END) = 1 FROM users", rewritten: true }
 *
 * rewriteAggFunc("SELECT stddev_pop(salary) FROM employees")
 * // → { sql: "SELECT SQRT(AVG((salary)*(salary)) - AVG(salary)*AVG(salary)) FROM employees", rewritten: true }
 *
 * rewriteAggFunc("SELECT 1")
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
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
    logger.debug({ before: sql, after: result }, 'Statistical aggregate function rewritten');
  }

  return { sql: result, rewritten };
}

// ── Internal scanner helpers ─────────────────────────────────────

interface LocatedAggCall {
  /** Index of the function name's first character. */
  start: number;
  /** Index just past the closing parenthesis of the call. */
  end: number;
  /** The SQLite-compatible replacement expression. */
  replacement: string;
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
    // Skip over any literal/comment so its contents never match a function name.
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    // A function name must start at a word boundary and be followed by `(`.
    const boundaryOk = i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]);
    if (!boundaryOk) {
      i++;
      continue;
    }

    // Match the longest candidate name first (stable against shared prefixes).
    for (const name of AGG_FUNC_NAMES) {
      if (sql.slice(i, i + name.length).toLowerCase() !== name) continue;

      // Require `(` after the name (allowing whitespace).
      let j = i + name.length;
      while (j < len && /\s/.test(sql[j])) j++;
      if (j >= len || sql[j] !== '(') continue;

      const closeParen = findMatchingParen(sql, j);
      if (closeParen === -1) return null; // unbalanced — leave the rest untouched

      const rule = AGG_REWRITE_RULES[name];
      const rawArgs = sql.slice(j + 1, closeParen);
      const args = rule.arity === 1
        ? [rawArgs.trim()]
        : splitTopLevelCommas(rawArgs).map((a) => a.trim());

      // Defensive: if argument count doesn't match arity, or an argument is
      // empty (e.g. `bool_and()`), skip — it is not a valid call to rewrite.
      if (args.length !== rule.arity || args.some((a) => a.length === 0)) {
        i = closeParen + 1;
        break;
      }

      return {
        start: i,
        end: closeParen + 1,
        replacement: rule.render(args),
      };
    }

    i++;
  }

  return null;
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
    const ch = sql[i];

    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

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
