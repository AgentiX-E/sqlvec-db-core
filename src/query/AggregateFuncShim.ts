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

const logger = PinoLogger.forComponent('AggregateFuncShim');

// ── Types ────────────────────────────────────────────────────────

export interface AggFuncResult {
  /** Rewritten SQL (original if unchanged) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants – Regex patterns ───────────────────────────────────

/**
 * Detects `bool_and(expr)` — true if ALL inputs are true.
 */
const BOOL_AND_RE = /\bbool_and\s*\(([^)]+)\)/gi;

/**
 * Detects `bool_or(expr)` — true if ANY input is true.
 */
const BOOL_OR_RE = /\bbool_or\s*\(([^)]+)\)/gi;

/**
 * Detects `every(expr)` — same as bool_and.
 */
const EVERY_RE = /\bevery\s*\(([^)]+)\)/gi;

/**
 * Detects `stddev_pop(expr)` — population standard deviation.
 */
const STDDEV_POP_RE = /\bstddev_pop\s*\(([^)]+)\)/gi;

/**
 * Detects `stddev_samp(expr)` — sample standard deviation.
 */
const STDDEV_SAMP_RE = /\bstddev_samp\s*\(([^)]+)\)/gi;

/**
 * Detects `var_pop(expr)` — population variance.
 */
const VAR_POP_RE = /\bvar_pop\s*\(([^)]+)\)/gi;

/**
 * Detects `var_samp(expr)` — sample variance.
 */
const VAR_SAMP_RE = /\bvar_samp\s*\(([^)]+)\)/gi;

/**
 * Detects `covar_pop(y, x)` — population covariance.
 */
const COVAR_POP_RE = /\bcovar_pop\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `covar_samp(y, x)` — sample covariance.
 */
const COVAR_SAMP_RE = /\bcovar_samp\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `corr(y, x)` — correlation coefficient.
 */
const CORR_RE = /\bcorr\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_avgx(y, x)` — average of independent variable (x).
 */
const REGR_AVGX_RE = /\bregr_avgx\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_avgy(y, x)` — average of dependent variable (y).
 */
const REGR_AVGY_RE = /\bregr_avgy\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_count(y, x)` — number of rows where both are non-null.
 */
const REGR_COUNT_RE = /\bregr_count\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_intercept(y, x)` — y-intercept of linear regression.
 */
const REGR_INTERCEPT_RE = /\bregr_intercept\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_r2(y, x)` — R-squared.
 */
const REGR_R2_RE = /\bregr_r2\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_slope(y, x)` — slope of linear regression.
 */
const REGR_SLOPE_RE = /\bregr_slope\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_sxx(y, x)` — sum of squares of independent (x).
 */
const REGR_SXX_RE = /\bregr_sxx\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_sxy(y, x)` — sum of products.
 */
const REGR_SXY_RE = /\bregr_sxy\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Detects `regr_syy(y, x)` — sum of squares of dependent (y).
 */
const REGR_SYY_RE = /\bregr_syy\s*\(([^,]+),([^)]+)\)/gi;

/**
 * Combined pattern for detecting any aggregate function.
 */
const ANY_AGG_FUNC_RE = /\b(bool_and|bool_or|every|stddev_pop|stddev_samp|var_pop|var_samp|covar_pop|covar_samp|corr|regr_avgx|regr_avgy|regr_count|regr_intercept|regr_r2|regr_slope|regr_sxx|regr_sxy|regr_syy)\s*\(/i;

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
  return ANY_AGG_FUNC_RE.test(sql.trim());
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

  // Quick check first: bail early if no function is present
  if (!detectAggFunc(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // ── Phase 1: bool_and(expr) → MIN(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1 ──
  working = working.replace(BOOL_AND_RE, (_match: string, expr: string) => {
    rewritten = true;
    return `MIN(CASE WHEN (${expr.trim()}) THEN 1 ELSE 0 END) = 1`;
  });

  // ── Phase 2: bool_or(expr) → MAX(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1 ──
  working = working.replace(BOOL_OR_RE, (_match: string, expr: string) => {
    rewritten = true;
    return `MAX(CASE WHEN (${expr.trim()}) THEN 1 ELSE 0 END) = 1`;
  });

  // ── Phase 3: every(expr) → MIN(CASE WHEN (expr) THEN 1 ELSE 0 END) = 1 ──
  working = working.replace(EVERY_RE, (_match: string, expr: string) => {
    rewritten = true;
    return `MIN(CASE WHEN (${expr.trim()}) THEN 1 ELSE 0 END) = 1`;
  });

  // ── Phase 4: stddev_pop(x) → SQRT(AVG(x*x) - AVG(x)*AVG(x)) ──
  working = working.replace(STDDEV_POP_RE, (_match: string, expr: string) => {
    rewritten = true;
    const e = expr.trim();
    return `SQRT(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`;
  });

  // ── Phase 5: stddev_samp(x) → SQRT((AVG(x*x) - AVG(x)*AVG(x)) * cnt/(cnt-1)) ──
  // Use SUM + COUNT to compute: SQRT((SUM(x²)-SUM(x)²/n)/(n-1))
  working = working.replace(STDDEV_SAMP_RE, (_match: string, expr: string) => {
    rewritten = true;
    const e = expr.trim();
    return `SQRT((SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL))`;
  });

  // ── Phase 6: var_pop(x) → AVG(x*x) - AVG(x)*AVG(x) ──
  working = working.replace(VAR_POP_RE, (_match: string, expr: string) => {
    rewritten = true;
    const e = expr.trim();
    return `(AVG((${e})*(${e})) - AVG(${e})*AVG(${e}))`;
  });

  // ── Phase 7: var_samp(x) → (SUM(x²)-SUM(x)²/n)/(n-1) ──
  working = working.replace(VAR_SAMP_RE, (_match: string, expr: string) => {
    rewritten = true;
    const e = expr.trim();
    return `(SUM((${e})*(${e})) - SUM(${e})*SUM(${e})/CAST(COUNT(${e}) AS REAL)) / CAST(MAX(COUNT(${e}) - 1, 1) AS REAL)`;
  });

  // ── Phase 8: covar_pop(y, x) → AVG(y*x) - AVG(y)*AVG(x) ──
  working = working.replace(COVAR_POP_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    return `(AVG(${yy}*${xx}) - AVG(${yy})*AVG(${xx}))`;
  });

  // ── Phase 9: covar_samp(y, x) → (AVG(y*x) - AVG(y)*AVG(x)) * n/(n-1) ──
  working = working.replace(COVAR_SAMP_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    return `((AVG(${yy}*${xx}) - AVG(${yy})*AVG(${xx})) * CAST(COUNT(*) AS REAL) / CAST(MAX(COUNT(*) - 1, 1) AS REAL))`;
  });

  // ── Phase 10: corr(y, x) ──
  working = working.replace(CORR_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    const n = `CAST(COUNT(*) AS REAL)`;
    const sumX = `SUM(${xx})`;
    const sumY = `SUM(${yy})`;
    const sumXY = `SUM(${yy}*${xx})`;
    const sumX2 = `SUM(${xx}*${xx})`;
    const sumY2 = `SUM(${yy}*${yy})`;
    return `((${n}*${sumXY} - ${sumX}*${sumY}) / SQRT(MAX((${n}*${sumX2} - ${sumX}*${sumX}) * (${n}*${sumY2} - ${sumY}*${sumY}), 1e-100)))`;
  });

  // ── Phase 11: regr_avgx(y, x) → AVG(x) ──
  working = working.replace(REGR_AVGX_RE, (_match: string, _y: string, x: string) => {
    rewritten = true;
    return `AVG(${x.trim()})`;
  });

  // ── Phase 12: regr_avgy(y, x) → AVG(y) ──
  working = working.replace(REGR_AVGY_RE, (_match: string, y: string, _x: string) => {
    rewritten = true;
    return `AVG(${y.trim()})`;
  });

  // ── Phase 13: regr_count(y, x) ──
  working = working.replace(REGR_COUNT_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    return `COUNT(CASE WHEN ${y.trim()} IS NOT NULL AND ${x.trim()} IS NOT NULL THEN 1 END)`;
  });

  // ── Phase 14: regr_intercept(y, x) ──
  // AVG(y) - regr_slope(y,x) * AVG(x)
  // First we need to handle this in a special way since it references regr_slope
  // For now, inline the formula: AVG(y) - (n*Σxy - Σx*Σy)/(n*Σx² - (Σx)²) * AVG(x)
  working = working.replace(REGR_INTERCEPT_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    const n = `CAST(COUNT(*) AS REAL)`;
    return `(AVG(${yy}) - ((${n}*SUM(${yy}*${xx}) - SUM(${yy})*SUM(${xx})) / MAX((${n}*SUM(${xx}*${xx}) - SUM(${xx})*SUM(${xx})), 1e-100)) * AVG(${xx}))`;
  });

  // ── Phase 15: regr_r2(y, x) → POWER(corr(y,x), 2) ──
  // Inline the correlation formula
  working = working.replace(REGR_R2_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    const n = `CAST(COUNT(*) AS REAL)`;
    const corrExpr = `((${n}*SUM(${yy}*${xx}) - SUM(${yy})*SUM(${xx})) / SQRT(MAX((${n}*SUM(${xx}*${xx}) - SUM(${xx})*SUM(${xx})) * (${n}*SUM(${yy}*${yy}) - SUM(${yy})*SUM(${yy})), 1e-100)))`;
    return `POWER(${corrExpr}, 2)`;
  });

  // ── Phase 16: regr_slope(y, x) ──
  working = working.replace(REGR_SLOPE_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    const n = `CAST(COUNT(*) AS REAL)`;
    return `((${n}*SUM(${yy}*${xx}) - SUM(${yy})*SUM(${xx})) / MAX((${n}*SUM(${xx}*${xx}) - SUM(${xx})*SUM(${xx})), 1e-100))`;
  });

  // ── Phase 17: regr_sxx(y, x) → SUM(x*x) - SUM(x)*SUM(x)/COUNT(*) ──
  working = working.replace(REGR_SXX_RE, (_match: string, _y: string, x: string) => {
    rewritten = true;
    const xx = x.trim();
    return `(SUM(${xx}*${xx}) - SUM(${xx})*SUM(${xx})/CAST(COUNT(*) AS REAL))`;
  });

  // ── Phase 18: regr_sxy(y, x) → SUM(x*y) - SUM(x)*SUM(y)/COUNT(*) ──
  working = working.replace(REGR_SXY_RE, (_match: string, y: string, x: string) => {
    rewritten = true;
    const yy = y.trim();
    const xx = x.trim();
    return `(SUM(${xx}*${yy}) - SUM(${xx})*SUM(${yy})/CAST(COUNT(*) AS REAL))`;
  });

  // ── Phase 19: regr_syy(y, x) → SUM(y*y) - SUM(y)*SUM(y)/COUNT(*) ──
  working = working.replace(REGR_SYY_RE, (_match: string, y: string, _x: string) => {
    rewritten = true;
    const yy = y.trim();
    return `(SUM(${yy}*${yy}) - SUM(${yy})*SUM(${yy})/CAST(COUNT(*) AS REAL))`;
  });

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'Statistical aggregate function rewritten');
  }

  return { sql: working, rewritten };
}
