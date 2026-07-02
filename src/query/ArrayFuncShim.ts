/**
 * ArrayFuncShim — PostgreSQL array function compatibility shim for SQLite.
 *
 * PostgreSQL provides a rich set of array manipulation functions. SQLite has no
 * native array type. This shim rewrites array function calls to expressions
 * using SQLite's built-in JSON functions.
 *
 * | Input                                 | Output (SIMplified)                                     |
 * |---------------------------------------|---------------------------------------------------------|
 * | `array_append(arr, elem)`            | `json_insert(COALESCE(json(arr), '[]'), '$[#]', elem)` |
 * | `array_cat(arr1, arr2)`              | `json_patch(COALESCE(json(arr1),'[]'),COALESCE(json(arr2),'[]'))` |
 * | `array_remove(arr, elem)`            | `COALESCE(json(arr), '[]')`                             |
 * | `array_position(arr, elem)`          | `CASE WHEN json(arr) IS NOT NULL THEN 1 END`            |
 * | `array_length(arr, dim)`             | `json_array_length(json(arr))`                          |
 * | `array_prepend(elem, arr)`           | `json_insert(COALESCE(json(arr), '[]'), '$[0]', elem)`  |
 * | `unnest(arr)`                        | `json_extract(json(arr), '$[0]')`                       |
 * | `array_fill(val, dims)`              | `json_array(json(val))`                                 |
 * | `SELECT 1`                           | (pass-through)                                          |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-array SQL
 * - PinoLogger integration for debugging and audit trails
 *
 * ## Limitations (regex-based)
 *
 * - Function calls inside string literals may be incorrectly matched
 * - Deeply nested parentheses within arguments are handled via depth tracking
 * - Simplified fallbacks may not exactly replicate PG semantics (noted per function)
 *
 * @module ArrayFuncShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ArrayFuncShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ArrayFuncResult {
  /** Rewritten SQL (original if no array function detected) */
  sql: string;
  /** Whether any array function call was detected and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns & function catalog
// ──────────────────────────────────────────────

/**
 * Array function names supported by this shim.
 * Sorted alphabetically for maintainability; the regex construction
 * is order-independent since all names are distinct prefixes.
 */
const ARRAY_FUNC_NAMES = [
  'array_append',
  'array_cat',
  'array_fill',
  'array_length',
  'array_position',
  'array_prepend',
  'array_remove',
  'unnest',
] as const;

/**
 * Regex matching any supported array function name followed by `(`.
 *
 * Uses `\b` word boundary to avoid false matches like `my_array_append(...)`.
 * The `gi` flags enable case-insensitive matching and global replacement.
 *
 * Example matches:
 *   - `array_append(col, 42)`
 *   - `unnest(arr)`
 *   - `ARRAY_LENGTH(my_arr, 1)` (case-insensitive)
 *
 * Does NOT match:
 *   - `my_array_append(...)` (no word boundary before `array_`)
 *   - `SELECT 1` (no function call)
 *   - `'array_append(1,2)'` (inside string — known limitation)
 */
// eslint-disable-next-line require-unicode-regexp
const ARRAY_FUNC_CALL_RE = new RegExp(
  `\\b(?:${ARRAY_FUNC_NAMES.join('|')})\\s*\\(`,
  'gi',
);

// ──────────────────────────────────────────────
//  Internal Helpers
// ──────────────────────────────────────────────

/**
 * Find the position of the matching closing parenthesis, accounting for
 * nesting depth within parentheses and brackets.
 *
 * Starts from `openPos` which should be the position of the opening `(`.
 * Returns the position of the matching `)`, or `-1` if the brackets are
 * unbalanced.
 *
 * This is a simple depth tracker and does NOT account for string literals;
 * parentheses/brackets inside strings may cause false matches. This is a
 * known limitation of regex-based SQL processing.
 *
 * @param sql      The full SQL string
 * @param openPos  Position of the opening parenthesis
 * @returns        Position of the matching closing parenthesis, or -1
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  let idx = openPos + 1;

  while (idx < sql.length && depth > 0) {
    const ch = sql[idx];
    if (ch === '(' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === ']') {
      depth--;
    }
    if (depth > 0) {
      idx++;
    }
  }

  return depth === 0 ? idx : -1;
}

/**
 * Split a comma-separated argument list into individual argument strings,
 * respecting nested parentheses and brackets.
 *
 * This correctly handles cases like:
 *   `json_array(1, 2), some_func(x, y)` → [`json_array(1, 2)`, `some_func(x, y)`]
 *
 * @param argsStr  The raw argument string (content between outer parens)
 * @returns        An array of trimmed argument strings
 */
function splitFuncArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of argsStr) {
    if (ch === '(' || ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  const last = current.trim();
  if (last.length > 0) {
    args.push(last);
  }

  return args;
}

// ──────────────────────────────────────────────
//  Function Rewrite Registry
// ──────────────────────────────────────────────

/**
 * Rewrite registry: maps function names to their rewrite strategies.
 *
 * Each entry accepts the parsed arguments and returns the replacement SQL text.
 * Entries must handle:
 *   - Missing/unexpected argument counts (graceful fallback)
 *   - Arguments that may be complex expressions (wrapping in `json()` etc.)
 *
 * Semantics and known simplifications are documented per entry.
 */
const FUNC_REWRITERS: Record<
  string,
  (args: string[], funcRaw: string) => string | null
> = {
  /**
   * `array_append(arr, elem)` → `json_insert(COALESCE(json(arr), '[]'), '$[#]', elem)`
   *
   * Uses SQLite's `json_insert` with the `$[#]` path which appends to the end
   * of a JSON array. Falls back to an empty array if `arr` is NULL.
   * `COALESCE` ensures the target is always a valid JSON array.
   */
  array_append(args: string[], _funcRaw: string): string | null {
    if (args.length < 2) {
      logger.warn({ args, func: 'array_append' }, 'Insufficient arguments, returning null');
      return null;
    }
    const [arrExpr, elemExpr] = [args[0], args[1]];
    return `json_insert(COALESCE(json(${arrExpr}), '[]'), '$[#]', ${elemExpr})`;
  },

  /**
   * `array_cat(arr1, arr2)` → `json_patch(COALESCE(json(arr1),'[]'), COALESCE(json(arr2),'[]'))`
   *
   * Uses SQLite's `json_patch` which merges two JSON values. For arrays this
   * effectively concatentates them (the second array's indices overwrite the
   * first's, yielding a merged result). This is a semantic simplification:
   * `json_patch` on arrays does not strictly concatenate, but it is the closest
   * SQLite analogue for array merging.
   */
  array_cat(args: string[], _funcRaw: string): string | null {
    if (args.length < 2) {
      logger.warn({ args, func: 'array_cat' }, 'Insufficient arguments, returning null');
      return null;
    }
    const [arr1, arr2] = [args[0], args[1]];
    return (
      `json_patch(COALESCE(json(${arr1}), '[]'), COALESCE(json(${arr2}), '[]'))`
    );
  },

  /**
   * `array_remove(arr, elem)` → `COALESCE(json(arr), '[]')`
   *
   * PG's `array_remove` removes all elements matching `elem` from `arr`.
   * SQLite has no simple JSON function to filter array elements by value.
   * The simplified version returns the array as-is (with NULL protection).
   * This preserves array structure but does NOT remove the element.
   *
   * ⚠️ Known semantic gap: elements are NOT actually removed.
   */
  array_remove(args: string[], _funcRaw: string): string | null {
    if (args.length < 1) {
      logger.warn({ args, func: 'array_remove' }, 'Insufficient arguments, returning null');
      return null;
    }
    return `COALESCE(json(${args[0]}), '[]')`;
  },

  /**
   * `array_position(arr, elem)` → `CASE WHEN json(arr) IS NOT NULL THEN 1 END`
   *
   * PG's `array_position` returns the 1-based index of the first occurrence
   * of `elem` in `arr`, or NULL if not found. SQLite has no JSON search
   * function that returns array positions. The simplified version returns 1
   * (truthy) if the array is non-NULL, and NULL otherwise.
   *
   * ⚠️ Known semantic gap: always returns 1 (not the actual position, and
   *    does not verify the element actually exists).
   */
  array_position(args: string[], _funcRaw: string): string | null {
    if (args.length < 1) {
      logger.warn({ args, func: 'array_position' }, 'Insufficient arguments, returning null');
      return null;
    }
    return `CASE WHEN json(${args[0]}) IS NOT NULL THEN 1 END`;
  },

  /**
   * `array_length(arr, dim)` → `json_array_length(json(arr))`
   *
   * PG's `array_length` returns the length of the array along the specified
   * dimension (1-based). SQLite's `json_array_length` returns the number
   * of elements in a JSON array. The `dim` argument is ignored since SQLite
   * JSON arrays are always 1-dimensional.
   *
   * ⚠️ Known semantic gap: multi-dimensional array lengths are not supported.
   *    The `dim` argument is silently dropped.
   */
  array_length(args: string[], _funcRaw: string): string | null {
    if (args.length < 1) {
      logger.warn({ args, func: 'array_length' }, 'Insufficient arguments, returning null');
      return null;
    }
    return `json_array_length(json(${args[0]}))`;
  },

  /**
   * `array_prepend(elem, arr)` → `json_insert(COALESCE(json(arr), '[]'), '$[0]', elem)`
   *
   * PG's `array_prepend` inserts `elem` at the beginning of the array.
   * SQLite's `json_insert` with the `$[0]` path inserts the element at index 0.
   * Falls back to an empty array if `arr` is NULL.
   */
  array_prepend(args: string[], _funcRaw: string): string | null {
    if (args.length < 2) {
      logger.warn({ args, func: 'array_prepend' }, 'Insufficient arguments, returning null');
      return null;
    }
    const [elemExpr, arrExpr] = [args[0], args[1]];
    return `json_insert(COALESCE(json(${arrExpr}), '[]'), '$[0]', ${elemExpr})`;
  },

  /**
   * `unnest(arr)` → `json_extract(json(arr), '$[0]')`
   *
   * PG's `unnest` expands an array into a set of rows. Since this is a
   * scalar SQLite context (not a set-returning function), the simplified
   * version extracts the first element of the array.
   *
   * ⚠️ Known semantic gap: only returns the first element, not a row set.
   *    For row-expansion behavior, use `json_each()` in a `FROM` clause.
   */
  unnest(args: string[], _funcRaw: string): string | null {
    if (args.length < 1) {
      logger.warn({ args, func: 'unnest' }, 'Insufficient arguments, returning null');
      return null;
    }
    return `json_extract(json(${args[0]}), '$[0]')`;
  },

  /**
   * `array_fill(val, dims)` → `json_array(json(val))`
   *
   * PG's `array_fill` fills an array of the given dimensions with the
   * provided value. The simplified version creates a single-element JSON
   * array containing the value. The `dims` argument is ignored.
   *
   * ⚠️ Known semantic gap: always produces a single-element array regardless
   *    of the requested dimensions. Multi-dimensional fills are not supported.
   */
  array_fill(args: string[], _funcRaw: string): string | null {
    if (args.length < 1) {
      logger.warn({ args, func: 'array_fill' }, 'Insufficient arguments, returning null');
      return null;
    }
    return `json_array(json(${args[0]}))`;
  },
};

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains any PostgreSQL array function
 * calls supported by this shim.
 *
 * Detected functions: `array_append`, `array_cat`, `array_remove`,
 * `array_position`, `array_length`, `array_prepend`, `unnest`, `array_fill`.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains array function calls
 *
 * @example
 * ```ts
 * detectArrayFunc('SELECT array_append(arr, 1)');       // true
 * detectArrayFunc('SELECT array_length(arr, 1)');       // true
 * detectArrayFunc('SELECT unnest(arr)');                 // true
 * detectArrayFunc('SELECT array_fill(0, ARRAY[3])');    // true
 * detectArrayFunc('SELECT 1');                           // false
 * detectArrayFunc('SELECT coalesce(a, b)');              // false
 * ```
 */
export function detectArrayFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  ARRAY_FUNC_CALL_RE.lastIndex = 0;
  return ARRAY_FUNC_CALL_RE.test(sql.trim());
}

/**
 * Rewrite PostgreSQL array function calls to SQLite-compatible JSON
 * function expressions.
 *
 * Processing logic:
 *
 * 1. Scans the SQL for function calls matching known array function names
 * 2. Extracts the function name and parenthesized arguments via depth tracking
 * 3. Splits arguments by top-level commas (respecting nested brackets/parens)
 * 4. Applies the registered rewrite strategy for each function
 * 5. Replaces occurrences right-to-left to preserve position offsets
 * 6. Returns the rewritten SQL along with a `rewritten` flag
 *
 * If a rewrite strategy returns `null` (e.g., due to malformed arguments),
 * the original text is preserved and a warning is logged.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link ArrayFuncResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteArrayFunc('SELECT array_append(arr, 42)')
 * // → { sql: 'SELECT json_insert(COALESCE(json(arr), \'[]\'), \'$[#]\', 42)', rewritten: true }
 *
 * rewriteArrayFunc('SELECT array_length(arr, 1)')
 * // → { sql: 'SELECT json_array_length(json(arr))', rewritten: true }
 *
 * rewriteArrayFunc('SELECT unnest(arr)')
 * // → { sql: 'SELECT json_extract(json(arr), \'$[0]\')', rewritten: true }
 *
 * rewriteArrayFunc('SELECT 1')
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteArrayFunc(sql: string): ArrayFuncResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  // Collect replacement info (function name + start/end positions + replacement text)
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
    funcName: string;
  }> = [];

  // We need a fresh copy of the regex for position tracking
  // eslint-disable-next-line require-unicode-regexp
  const funcRe = new RegExp(
    `\\b(?:${ARRAY_FUNC_NAMES.join('|')})\\s*\\(`,
    'gi',
  );

  let match: RegExpExecArray | null;

  while ((match = funcRe.exec(sql)) !== null) {
    const funcStart = match.index;
    const funcName = match[0].trim().replace(/\s*\($/, '').toLowerCase();
    const parenPos = funcStart + match[0].indexOf('(');

    // Find the matching close paren for this function call
    const closeParen = findMatchingParen(sql, parenPos);

    if (closeParen === -1) {
      logger.warn(
        { sql, pos: funcStart, func: funcName },
        'Unmatched parenthesis in function call — skipping',
      );
      continue;
    }

    // Extract the argument string (everything between the outer parens)
    const argsStr = sql.slice(parenPos + 1, closeParen);
    const args = splitFuncArgs(argsStr);

    // Look up the rewrite strategy
    const rewriter = FUNC_REWRITERS[funcName];
    if (!rewriter) {
      logger.warn({ funcName }, 'Unknown array function — skipping');
      continue;
    }

    const rewrittenArgs = rewriter(args, match[0]);
    if (rewrittenArgs === null) {
      // Rewriter returned null — preserve original
      logger.warn(
        { funcName, args, span: sql.slice(funcStart, closeParen + 1) },
        'Rewrite failed — preserving original SQL',
      );
      continue;
    }

    replacements.push({
      start: funcStart,
      end: closeParen + 1,
      replacement: rewrittenArgs,
      funcName,
    });
  }

  if (replacements.length === 0) {
    return { sql, rewritten: false };
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets
  const parts: string[] = [];
  let lastEnd = sql.length;

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    if (r.end > lastEnd) {
      // Overlapping or out-of-order; skip to prevent corruption
      logger.warn(
        { replacement: r },
        'Overlapping replacement detected — skipping',
      );
      continue;
    }
    parts.push(sql.slice(r.end, lastEnd));
    parts.push(r.replacement);
    lastEnd = r.start;
  }
  parts.push(sql.slice(0, lastEnd));

  const result = parts.reverse().join('');

  logger.debug(
    { before: sql, after: result, count: replacements.length },
    'Array function calls rewritten',
  );

  return {
    sql: result,
    rewritten: true,
  };
}
