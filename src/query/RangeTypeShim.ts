/**
 * RangeTypeShim — PostgreSQL range type compatibility shim for SQLite.
 *
 * PostgreSQL supports range types (int4range, int8range, numrange,
 * tsrange, tstzrange, daterange) with dedicated operators (@>, <@,
 * &&, -|-, etc.). SQLite has no native range type support.
 *
 * Strategy:
 *   1. DDL rewriting — Replace range type names with TEXT during
 *      CREATE TABLE / ALTER TABLE processing.
 *   2. Operator expansion — Convert range operators (@>, <@, &&)
 *      into equivalent SQLite comparison expressions.
 *   3. Expression simplification — Convert simple range constructor
 *      calls (int4range(a,b)) to text representations where practical;
 *      anything complex passes through unchanged (no-op safe).
 *
 * ## Range Operator Expansion
 *
 * | PG Operator | Semantics              | SQLite Expansion                                      |
 * |-------------|------------------------|-------------------------------------------------------|
 * | `range @> value` | Contains          | `range_lower <= value AND value < range_upper`        |
 * | `value <@ range` | Contained by      | `range_lower <= value AND value < range_upper`        |
 * | `range1 && range2` | Overlap         | `range1_lower < range2_upper AND range1_upper > range2_lower` |
 * | `range @> range`  | Contains range  | `range1_lower <= range2_lower AND range1_upper >= range2_upper` |
 *
 * The expansion assumes half-open [lower, upper) semantics (default PG range).
 * For int4range(a,b), the lower bound is inclusive and upper is exclusive.
 *
 * @module RangeTypeShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('RangeTypeShim');

// ── Types ────────────────────────────────────────────────────────

export interface RangeResult {
  /** Rewritten SQL (original if no rewrite was applied) */
  sql: string;
  /** Whether the SQL was modified */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/** Recognized PostgreSQL range type names (lowercase). */
const RANGE_TYPE_NAMES = [
  'int4range',
  'int8range',
  'numrange',
  'tsrange',
  'tstzrange',
  'daterange',
] as const;

/** Combined regex to detect any range type name in SQL text. */
const RANGE_TYPE_RE = /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\b/i;

/**
 * Matches range type names used as column types in DDL.
 */
const DDL_RANGE_TYPE_RE = /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\b/gi;

/** Set of recognized range type names for O(1) lookup. */
const RANGE_TYPE_SET = new Set<string>(RANGE_TYPE_NAMES);

/**
 * Regex matching known range operators.
 *
 * Operators:
 *   @>  — contains (element @> range, range @> range)
 *   <@  — is contained by (range <@ range, element <@ range)
 *   &&  — overlap (range && range)
 *   -|- — is adjacent to (range -|- range)
 */
const RANGE_OPERATOR_RE = /(?:(?<![<>])@>|<@(?![<>])|\&\&|-\|-)/;

/**
 * Regex matching range constructor function calls.
 */
const RANGE_FUNC_CALL_RE = /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\s*\(/gi;

/**
 * Matches a simple two-argument range constructor call.
 *
 * Group 1: range type name
 * Group 2: lower bound expression
 * Group 3: upper bound expression
 */
const SIMPLE_TWO_ARG_RANGE_RE =
  /\b(int4range|int8range|numrange)\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*\)/gi;

/**
 * Matches a simple three-argument range constructor call with bounds mode.
 */
const SIMPLE_THREE_ARG_RANGE_RE =
  /\b(int4range|int8range|numrange)\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*,\s*'([^']*)'\s*\)/gi;

/**
 * Matches simple tsrange/tstzrange/daterange two-argument calls.
 */
const SIMPLE_DATE_RANGE_RE =
  /\b(tsrange|tstzrange|daterange)\s*\(\s*('[^']*'|[^,)]+)\s*,\s*('[^']*'|[^,)]+)\s*\)/gi;

/**
 * Pattern to match a range expression followed by @> operator.
 *
 * This matches patterns like:
 *   int4range(1,10) @> 5
 *   col @> 5
 *   int4range(a,b) @> value
 *
 * We use a two-step approach: first detect the @> operator in context,
 * then expand based on whether the left side is a range function call or a column reference.
 */
const RANGE_CONTAINS_RE = /(\w[\w.()\s]*(?:int4range|int8range|numrange|tsrange|tstzrange|daterange)\s*\([^)]+\)|[A-Za-z_]\w*)\s*(@>)\s*([A-Za-z_]\w*|\d+(?:\.\d+)?|'[^']*')/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains a range type reference.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if a range type name is found.
 */
export function detectRangeType(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  return RANGE_TYPE_RE.test(sql.trim());
}

/**
 * Detect whether the given SQL contains a range type operator.
 *
 * Checks for @>, <@, &&, and -|- operators.
 *
 * @param sql - The SQL text to check.
 * @returns `true` if a range operator is found.
 */
export function detectRangeOperator(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }
  return RANGE_OPERATOR_RE.test(sql.trim());
}

/**
 * Determine whether a given type name is a PostgreSQL range type.
 *
 * @param typeName - The type name to check.
 * @returns `true` if the type name is a recognized range type.
 */
export function isRangeType(typeName: string): boolean {
  if (!typeName || typeof typeName !== 'string') {
    return false;
  }
  return RANGE_TYPE_SET.has(typeName.trim().toLowerCase());
}

/**
 * Rewrite PostgreSQL range types in DDL SQL to TEXT.
 *
 * Replaces range type names used as column data types with TEXT,
 * which is the closest SQLite-compatible type for storing range
 * values as their canonical string representation.
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A RangeResult with the rewritten SQL.
 */
export function rewriteRangeType(sql: string): RangeResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  // Fast path — no range type present
  if (!RANGE_TYPE_RE.test(sql.trim())) {
    return { sql, rewritten: false };
  }

  // Reset regex lastIndex after test()
  RANGE_TYPE_RE.lastIndex = 0;
  DDL_RANGE_TYPE_RE.lastIndex = 0;

  // Detect DDL context — only rewrite in CREATE/ALTER TABLE or column definition context
  const trimmed = sql.trim();
  const isDDL = /^\s*(CREATE|ALTER)\s+(TABLE|MATERIALIZED\s+VIEW|VIEW)\b/i.test(trimmed);

  if (!isDDL) {
    // For non-DDL SQL, just return as-is (don't rewrite types in queries)
    return { sql: trimmed, rewritten: false };
  }

  // Replace range type names with TEXT
  const rewritten = trimmed.replace(DDL_RANGE_TYPE_RE, 'TEXT');

  if (rewritten !== trimmed) {
    logger.debug({ original: trimmed, rewritten }, 'Rewrote range type columns to TEXT');
    return { sql: rewritten, rewritten: true };
  }

  return { sql: trimmed, rewritten: false };
}

/**
 * Simplify range expressions in SQL text.
 *
 * Converts simple range constructor calls to their canonical text
 * representation. This is a best-effort transformation.
 *
 * @param sql - The SQL text containing potential range expressions.
 * @returns A RangeResult with the simplified SQL.
 */
export function simplifyRangeExpr(sql: string): RangeResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // Fast path — no range function calls present
  if (!RANGE_FUNC_CALL_RE.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // Reset regex lastIndex after test()
  RANGE_FUNC_CALL_RE.lastIndex = 0;
  SIMPLE_THREE_ARG_RANGE_RE.lastIndex = 0;
  SIMPLE_TWO_ARG_RANGE_RE.lastIndex = 0;
  SIMPLE_DATE_RANGE_RE.lastIndex = 0;

  let result = trimmed;

  // ── Phase 1: Three-argument numeric range calls ────────────
  result = result.replace(SIMPLE_THREE_ARG_RANGE_RE, (_match, _func, lower, upper, bounds): string => {
    const leftBound = bounds.length >= 1 ? bounds[0] : '[';
    const rightBound = bounds.length >= 2 ? bounds[1] : ')';
    return `'${leftBound}' || ${String(lower).trim()} || ',' || ${String(upper).trim()} || '${rightBound}'`;
  });

  // ── Phase 2: Two-argument numeric range calls ──────────────
  result = result.replace(SIMPLE_TWO_ARG_RANGE_RE, (_match, _func, lower, upper): string => {
    return `'[' || ${String(lower).trim()} || ',' || ${String(upper).trim()} || ')'`;
  });

  // ── Phase 3: Two-argument date/timestamp range calls ──────
  result = result.replace(SIMPLE_DATE_RANGE_RE, (_match, _func, lower, upper): string => {
    return `'[' || ${String(lower).trim()} || ',' || ${String(upper).trim()} || ')'`;
  });

  const rewrote = result !== trimmed;

  if (rewrote) {
    logger.debug({ original: trimmed, simplified: result }, 'Simplified range expressions');
  }

  return { sql: result, rewritten: rewrote };
}

/**
 * Expand range operators ({@code @>, <@, &&}) into equivalent SQLite comparison expressions.
 *
 * For range expressions constructed via int4range(a,b) or similar:
 *   int4range(a,b) @> value → a <= value AND value < b
 *   value <@ int4range(a,b) → a <= value AND value < b
 *   int4range(a,b) && int4range(c,d) → a < d AND c < b
 *
 * For column references (range values stored as TEXT columns):
 *   col @> value → is not expanded (requires json_extract on stored value)
 *
 * This function handles the most common case: inline range function calls
 * with the @> or <@ or && operator.
 *
 * @param sql - The SQL text containing potential range operator expressions.
 * @returns A RangeResult with expanded operators.
 */
export function expandRangeOperators(sql: string): RangeResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // Fast path — no range operators present
  if (!RANGE_OPERATOR_RE.test(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  let result = trimmed;
  let rewritten = false;

  // ── Phase 1: Expand int4range(a,b) @> value → a <= value AND value < b ──
  // Only match simple scalar values (identifiers, numbers, strings) — NOT other function calls
  const SCALAR = /[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*|\d+(?:\.\d*)?|'[^']*'/;
  const SCALAR_SRC = SCALAR.source;
  // Scalar that is NOT followed by ( — i.e. not a function call start
  const SCALAR_NO_FUNC_SRC = `(?:${SCALAR_SRC})(?!\\s*\\()`;

  // ── Phase 1: Expand range @> range (contains range) ──
  // Must come BEFORE scalar @> to prevent greedy match of nested function call as value
  result = result.replace(
    /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*\)\s*@>\s*\1\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*\)/gi,
    (_match, _func, a, b, c, d) => {
      rewritten = true;
      return `(${String(a).trim()} <= ${String(c).trim()} AND ${String(d).trim()} <= ${String(b).trim()})`;
    },
  );

  // ── Phase 2: Expand range @> scalar ──
  // int4range(a,b) @> value → a <= value AND value < b
  // NOTE: wrap SCALAR_NO_FUNC_SRC in () to make it a capturing group for the callback
  result = result.replace(
    new RegExp(`\\b(int4range|int8range|numrange)\\s*\\(\\s*([^,)]+)\\s*,\\s*([^,)]+)\\s*\\)\\s*@>\\s*(${SCALAR_NO_FUNC_SRC})`, 'gi'),
    (_match, _func, lower, upper, value) => {
      rewritten = true;
      return `(${String(lower).trim()} <= ${String(value).trim()} AND ${String(value).trim()} < ${String(upper).trim()})`;
    },
  );

  // Same for tsrange, daterange, tstzrange
  result = result.replace(
    new RegExp(`\\b(tsrange|tstzrange|daterange)\\s*\\(\\s*([^,)]+)\\s*,\\s*([^,)]+)\\s*\\)\\s*@>\\s*(${SCALAR_NO_FUNC_SRC})`, 'gi'),
    (_match, _func, lower, upper, value) => {
      rewritten = true;
      return `(${String(lower).trim()} <= ${String(value).trim()} AND ${String(value).trim()} < ${String(upper).trim()})`;
    },
  );

  // ── Phase 3: Expand scalar <@ range → a <= value AND value < b ──
  result = result.replace(
    new RegExp(`(${SCALAR_NO_FUNC_SRC})\\s*<@\\s*\\b(int4range|int8range|numrange)\\s*\\(\\s*([^,)]+)\\s*,\\s*([^,)]+)\\s*\\)`, 'gi'),
    (_match, value, _func, lower, upper) => {
      rewritten = true;
      return `(${String(lower).trim()} <= ${String(value).trim()} AND ${String(value).trim()} < ${String(upper).trim()})`;
    },
  );

  result = result.replace(
    new RegExp(`(${SCALAR_NO_FUNC_SRC})\\s*<@\\s*\\b(tsrange|tstzrange|daterange)\\s*\\(\\s*([^,)]+)\\s*,\\s*([^,)]+)\\s*\\)`, 'gi'),
    (_match, value, _func, lower, upper) => {
      rewritten = true;
      return `(${String(lower).trim()} <= ${String(value).trim()} AND ${String(value).trim()} < ${String(upper).trim()})`;
    },
  );

  // ── Phase 4: Expand range && range (overlap) ──
  // int4range(a,b) && int4range(c,d) → a < d AND c < b
  result = result.replace(
    /\b(int4range|int8range|numrange|tsrange|tstzrange|daterange)\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*\)\s*&&\s*\1\s*\(\s*([^,)]+)\s*,\s*([^,)]+)\s*\)/gi,
    (_match, _func, a, b, c, d) => {
      rewritten = true;
      return `(${String(a).trim()} < ${String(d).trim()} AND ${String(c).trim()} < ${String(b).trim()})`;
    },
  );

  if (rewritten) {
    logger.debug({ original: trimmed, expanded: result }, 'Expanded range operators');
  }

  return { sql: result, rewritten };
}

// ────────────────────────────────────────────────────────────────
//  Range Boundary Inspection Functions
// ────────────────────────────────────────────────────────────────

/**
 * Regex matching range boundary function calls.
 *
 * Range text is assumed to be in PostgreSQL canonical format:
 *   [lower,upper)
 *   (lower,upper]
 *   [lower,upper]
 *   (lower,upper)
 *
 * Where lower and upper are the bound values, and the brackets
 * indicate inclusivity/exclusivity.
 */
const LOWER_INC_RE = /\blower_inc\s*\(([^)]+)\)/gi;
const UPPER_INC_RE = /\bupper_inc\s*\(([^)]+)\)/gi;
const LOWER_INF_RE = /\blower_inf\s*\(([^)]+)\)/gi;
const UPPER_INF_RE = /\bupper_inf\s*\(([^)]+)\)/gi;
const RANGE_MERGE_RE = /\brange_merge\s*\(([^,]+),([^)]+)\)/gi;
const RANGE_INTERSECT_RE = /\brange_intersect\s*\(([^,]+),([^)]+)\)/gi;
const RANGE_UNION_RE = /\brange_union\s*\(([^,]+),([^)]+)\)/gi;

const ANY_RANGE_FUNC_RE = /\b(lower_inc|upper_inc|lower_inf|upper_inf|range_merge|range_intersect|range_union)\s*\(/i;

/**
 * Detect whether the given SQL string contains PostgreSQL range boundary
 * functions (lower_inc, upper_inc, lower_inf, upper_inf, range_merge,
 * range_intersect, range_union) that SQLite does not support.
 *
 * @param sql - The raw SQL string to inspect
 * @returns `true` if a range boundary function is detected
 *
 * @example
 * ```ts
 * detectRangeFunc("SELECT lower_inc(r) FROM t");  // true
 * detectRangeFunc("SELECT range_merge(r1, r2)");  // true
 * detectRangeFunc("SELECT 1");                     // false
 * ```
 */
export function detectRangeFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return ANY_RANGE_FUNC_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL range boundary functions into SQLite-compatible
 * string expressions.
 *
 * Range text is assumed to be in format: `[lower,upper)` or `(lower,upper]` etc.
 *
 * | Function                               | SQLite Rewrite                                                          |
 * |----------------------------------------|-------------------------------------------------------------------------|
 * | `lower_inc(r)`                         | `SUBSTR(r, 1, 1) = '['`                                                |
 * | `upper_inc(r)`                         | `SUBSTR(r, -1, 1) = ']'` (LENGTH(r), 1) or -1 in SQLite              |
 * | `lower_inf(r)`                         | `r LIKE '(,%' OR r LIKE '[,%'` (simplified: check if first val is empty) |
 * | `upper_inf(r)`                         | `r LIKE '%,)' OR r LIKE '%,]'` (simplified)                           |
 * | `range_merge(r1, r2)`                  | `'[' || MIN(lower_val1, lower_val2) || ',' || MAX(upper_val1, upper_val2) || ')'` |
 * | `range_intersect(r1, r2)`              | `'[' || MAX(lower_val1, lower_val2) || ',' || MIN(upper_val1, upper_val2) || ')'` |
 * | `range_union(r1, r2)`                  | Same as merge (simplified; does not check contiguity)                   |
 *
 * @param sql - The raw SQL string to process
 * @returns A RangeResult with the rewritten SQL and a flag indicating if changes were made
 *
 * @example
 * ```ts
 * rewriteRangeFunc("SELECT lower_inc(my_range) FROM t")
 * // → { sql: "SELECT SUBSTR(my_range, 1, 1) = '[' FROM t", rewritten: true }
 *
 * rewriteRangeFunc("SELECT range_merge(r1, r2) FROM t")
 * // → { sql: "SELECT '[' || MIN(...) FROM t", rewritten: true }
 * ```
 */
export function rewriteRangeFunc(sql: string): RangeResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick check first: bail early if no range boundary function is present
  if (!detectRangeFunc(sql)) {
    return { sql, rewritten: false };
  }

  let working = sql;
  let rewritten = false;

  // ── Phase 1: lower_inc(r) → SUBSTR(r, 1, 1) = '[' ──
  working = working.replace(LOWER_INC_RE, (_match: string, rangeExpr: string) => {
    rewritten = true;
    const r = rangeExpr.trim();
    return `SUBSTR(${r}, 1, 1) = '['`;
  });

  // ── Phase 2: upper_inc(r) → SUBSTR(r, LENGTH(r), 1) = ']' ──
  working = working.replace(UPPER_INC_RE, (_match: string, rangeExpr: string) => {
    rewritten = true;
    const r = rangeExpr.trim();
    return `SUBSTR(${r}, LENGTH(${r}), 1) = ']'`;
  });

  // ── Phase 3: lower_inf(r) → check if lower bound is empty ──
  // Format: [lower,upper) — extract content between first char and first comma
  // If lower bound is empty → infinite
  working = working.replace(LOWER_INF_RE, (_match: string, rangeExpr: string) => {
    rewritten = true;
    const r = rangeExpr.trim();
    // Use SQLite string functions: extract between first char and first comma
    // If the char after '[' or '(' is ',' then lower is infinite
    return `INSTR(${r}, ',') = 2`;
  });

  // ── Phase 4: upper_inf(r) → check if upper bound is empty ──
  // If ',' is the second-to-last char (only comma separates empty upper), then infinite
  working = working.replace(UPPER_INF_RE, (_match: string, rangeExpr: string) => {
    rewritten = true;
    const r = rangeExpr.trim();
    // Check if the substring between last ',' and last ')'/']' is empty
    return `SUBSTR(${r}, INSTR(${r}, ',') + 1, LENGTH(${r}) - INSTR(${r}, ',') - 2) = ''`;
  });

  // ── Phase 5: range_merge(r1, r2) → merge two ranges ──
  // Smallest range covering both: min(lower), max(upper)
  // Extract lower/upper values by parsing the range strings
  // Simplified: assume format [a,b) and [c,d) → build combined range
  working = working.replace(RANGE_MERGE_RE, (_match: string, r1: string, r2: string) => {
    rewritten = true;
    const a = r1.trim();
    const b = r2.trim();
    // Use CASE expressions to extract and merge bounds
    // Extract lower bound (between first character and first comma)
    // Extract upper bound (between last comma and last character)
    const lower1 = `SUBSTR(${a}, 2, INSTR(${a}, ',') - 2)`;
    const upper1 = `SUBSTR(${a}, INSTR(${a}, ',') + 1, LENGTH(${a}) - INSTR(${a}, ',') - 2)`;
    const lower2 = `SUBSTR(${b}, 2, INSTR(${b}, ',') - 2)`;
    const upper2 = `SUBSTR(${b}, INSTR(${b}, ',') + 1, LENGTH(${b}) - INSTR(${b}, ',') - 2)`;
    // Use MIN/MAX on the numeric/cast values — need to cast for comparison
    // Also handle lower_inc: if either is inclusive, result is inclusive
    const lowerBound = `CASE WHEN ${lower1} <= ${lower2} THEN SUBSTR(${a}, 1, 1) ELSE SUBSTR(${b}, 1, 1) END`;
    const upperBound = `CASE WHEN ${upper1} >= ${upper2} THEN SUBSTR(${a}, LENGTH(${a}), 1) ELSE SUBSTR(${b}, LENGTH(${b}), 1) END`;
    const mergedLower = `CASE WHEN ${lower1} <= ${lower2} THEN ${lower1} ELSE ${lower2} END`;
    const mergedUpper = `CASE WHEN ${upper1} >= ${upper2} THEN ${upper1} ELSE ${upper2} END`;
    return `${lowerBound} || ${mergedLower} || ',' || ${mergedUpper} || ${upperBound}`;
  });

  // ── Phase 6: range_intersect(r1, r2) → intersection ──
  // Take max(lower), min(upper). Return '' if no overlap (max lower > min upper).
  working = working.replace(RANGE_INTERSECT_RE, (_match: string, r1: string, r2: string) => {
    rewritten = true;
    const a = r1.trim();
    const b = r2.trim();
    const lower1 = `SUBSTR(${a}, 2, INSTR(${a}, ',') - 2)`;
    const upper1 = `SUBSTR(${a}, INSTR(${a}, ',') + 1, LENGTH(${a}) - INSTR(${a}, ',') - 2)`;
    const lower2 = `SUBSTR(${b}, 2, INSTR(${b}, ',') - 2)`;
    const upper2 = `SUBSTR(${b}, INSTR(${b}, ',') + 1, LENGTH(${b}) - INSTR(${b}, ',') - 2)`;
    // use MAX for lower, MIN for upper, default to '[' for lower bound, ')' for upper
    const intLower = `CASE WHEN ${lower1} >= ${lower2} THEN ${lower1} ELSE ${lower2} END`;
    const intUpper = `CASE WHEN ${upper1} <= ${upper2} THEN ${upper1} ELSE ${upper2} END`;
    // Check for non-overlap: if intLower > intUpper, return empty
    return `CASE WHEN ${intLower} <= ${intUpper} THEN '[' || ${intLower} || ',' || ${intUpper} || ')' ELSE '' END`;
  });

  // ── Phase 7: range_union(r1, r2) → union of two ranges ──
  // Take min(lower), max(upper). Return '' if not contiguous.
  working = working.replace(RANGE_UNION_RE, (_match: string, r1: string, r2: string) => {
    rewritten = true;
    const a = r1.trim();
    const b = r2.trim();
    const lower1 = `SUBSTR(${a}, 2, INSTR(${a}, ',') - 2)`;
    const upper1 = `SUBSTR(${a}, INSTR(${a}, ',') + 1, LENGTH(${a}) - INSTR(${a}, ',') - 2)`;
    const lower2 = `SUBSTR(${b}, 2, INSTR(${b}, ',') - 2)`;
    const upper2 = `SUBSTR(${b}, INSTR(${b}, ',') + 1, LENGTH(${b}) - INSTR(${b}, ',') - 2)`;
    const unionLower = `CASE WHEN ${lower1} <= ${lower2} THEN ${lower1} ELSE ${lower2} END`;
    const unionUpper = `CASE WHEN ${upper1} >= ${upper2} THEN ${upper1} ELSE ${upper2} END`;
    const lowerBound = `CASE WHEN ${lower1} <= ${lower2} THEN SUBSTR(${a}, 1, 1) ELSE SUBSTR(${b}, 1, 1) END`;
    const upperBound = `CASE WHEN ${upper1} >= ${upper2} THEN SUBSTR(${a}, LENGTH(${a}), 1) ELSE SUBSTR(${b}, LENGTH(${b}), 1) END`;
    // Check contiguity: if max(lower) <= min(upper), ranges are contiguous or overlapping
    const maxLower = `CASE WHEN ${lower1} >= ${lower2} THEN ${lower1} ELSE ${lower2} END`;
    const minUpper = `CASE WHEN ${upper1} <= ${upper2} THEN ${upper1} ELSE ${upper2} END`;
    return `CASE WHEN ${maxLower} <= ${minUpper} THEN ${lowerBound} || ${unionLower} || ',' || ${unionUpper} || ${upperBound} ELSE '' END`;
  });

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'Range boundary function rewritten');
  }

  return { sql: working, rewritten };
}
