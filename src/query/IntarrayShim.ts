/**
 * IntarrayShim — PostgreSQL intarray extension compatibility shim.
 *
 * PostgreSQL's intarray extension provides integer array operations that are not
 * available in SQLite. DDL referencing intarray functions (uniq(), sort_asc(),
 * idx(), subarray(), etc.) will fail without this shim.
 *
 * ## Functions Shimmed
 *
 * | Function                   | Signature                                   | Description                       |
 * |----------------------------|---------------------------------------------|-----------------------------------|
 * | `uniq(arr)`                | `number[] → number[]`                       | Remove duplicate elements         |
 * | `sort_asc(arr)`            | `number[] → number[]`                       | Sort ascending                    |
 * | `sort_desc(arr)`           | `number[] → number[]`                       | Sort descending                   |
 * | `sort(arr, dir?)`          | `(string, string?) → number[]`              | Sort with direction param         |
 * | `idx(arr, item)`           | `(number[], number) → number`               | 1-based index of element          |
 * | `subarray(arr, start, n?)` | `(number[], number, number?) → number[]`    | Slice from 1-based start          |
 * | `intset(arr)`              | `number[] → number[]`                       | Alias for uniq                    |
 * | `icount(arr)`              | `number[] → number`                         | Count elements                    |
 * | `push_array(arr, items)`   | `(number[], number[]) → number[]`           | Append items                      |
 * | `push_front_array(arr,items)`| `(number[], number[]) → number[]`         | Prepend items                     |
 *
 * ## Operators Shimmed
 *
 * | Operator    | Signature                | Description                       |
 * |-------------|--------------------------|-----------------------------------|
 * | `@>`        | `arr1 @> arr2 → bool`    | Contains: arr1 has all of arr2    |
 * | `<@`        | `arr1 <@ arr2 → bool`    | Contained by: all of arr1 in arr2 |
 * | `&&`        | `arr1 && arr2 → bool`    | Overlap: any common element       |
 *
 * ## query_int
 *
 * Supports `query_int(arr, query)` where query uses:
 *   - `1 & 2`   (AND)
 *   - `1 | 2`   (OR)
 *   - `!1`      (NOT)
 *   - `(1 & 2) | 3` (parentheses)
 *
 * ## Detection & Registration
 *
 * - `detectIntarrayFunction(sql)` — Regex-based SQL interception
 * - `INTAARRAY_FUNCTIONS` — Catalog metadata for pg_proc
 *
 * @module query/IntarrayShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('IntarrayShim');

// ──────────── Individual function implementations ────────────────

/**
 * Remove duplicate elements from an integer array.
 *
 * PostgreSQL signature:
 *   uniq(integer[]) → integer[]
 *
 * Uses a Set internally for O(n) deduplication. The deduplicated result
 * preserves the original insertion order of first occurrences.
 *
 * @param arr - Input integer array
 * @returns New array with duplicates removed
 */
export function uniq(arr: number[]): number[] {
  return [...new Set(arr)];
}

/**
 * Sort an integer array in ascending order.
 *
 * PostgreSQL signature:
 *   sort_asc(integer[]) → integer[]
 *
 * Sorts using standard numeric comparison (not string coercion).
 *
 * @param arr - Input integer array
 * @returns New array sorted ascending
 */
export function sort_asc(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b);
}

/**
 * Sort an integer array in descending order.
 *
 * PostgreSQL signature:
 *   sort_desc(integer[]) → integer[]
 *
 * Sorts using standard numeric comparison (not string coercion).
 *
 * @param arr - Input integer array
 * @returns New array sorted descending
 */
export function sort_desc(arr: number[]): number[] {
  return [...arr].sort((a, b) => b - a);
}

/**
 * Sort an integer array with an explicit direction parameter.
 *
 * PostgreSQL signature:
 *   sort(integer[], text) → integer[]
 *
 * PostgreSQL passes arrays as string literals (e.g. `'{3,1,2}'`), so this
 * function accepts both a string representation and a pre-parsed number array.
 *
 * The `dir` argument is a case-insensitive string: `'asc'` or `'desc'`.
 * Defaults to `'asc'` if omitted or unrecognised.
 *
 * @param arr - Input integer array (PG literal string or pre-parsed number[])
 * @param dir - Sort direction: `'asc'` (default) or `'desc'`
 * @returns New array sorted accordingly
 */
export function sort(arr: string | number[], dir?: string): number[] {
  // Always copy to avoid mutating the input
  let parsed: number[];
  if (typeof arr === 'string') {
    // PostgreSQL passes arrays as strings like '{3,1,2}' or '[3,1,2]'
    parsed = parsePgArray(arr);
  } else if (Array.isArray(arr)) {
    parsed = [...arr];
  } else {
    parsed = [];
  }
  const direction = (dir ?? 'asc').toLowerCase();
  if (direction === 'desc') {
    return parsed.sort((a, b) => b - a);
  }
  return parsed.sort((a, b) => a - b);
}

/**
 * Find the 1-based index of an element in an integer array.
 *
 * PostgreSQL signature:
 *   idx(integer[], integer) → integer
 *
 * Returns 0 if the element is not found (matching PostgreSQL behaviour).
 *
 * @param arr - Input integer array
 * @param item - Element to locate
 * @returns 1-based index (0 if not found)
 */
export function idx(arr: number[], item: number): number {
  const zeroBased = arr.indexOf(item);
  return zeroBased === -1 ? 0 : zeroBased + 1;
}

/**
 * Extract a subarray from a 1-based start position, optionally limited to a count.
 *
 * PostgreSQL signature:
 *   subarray(integer[], integer [, integer]) → integer[]
 *
 * `start` is 1-based. If `start` is negative or exceeds the array length,
 * appropriate boundaries are applied (matching PostgreSQL's behaviour).
 *
 * @param arr      - Input integer array
 * @param start    - 1-based start index
 * @param count    - Optional maximum number of elements to extract
 * @returns Extracted subarray
 */
export function subarray(arr: number[], start: number, count?: number): number[] {
  if (arr.length === 0) {
    return [];
  }
  // Convert 1-based start to 0-based index
  const zeroBasedStart = Math.max(0, start - 1);
  if (zeroBasedStart >= arr.length) {
    return [];
  }
  if (count !== undefined && count >= 0) {
    return arr.slice(zeroBasedStart, zeroBasedStart + count);
  }
  return arr.slice(zeroBasedStart);
}

/**
 * Alias for uniq: remove duplicates from an integer array.
 *
 * PostgreSQL signature:
 *   intset(integer[]) → integer[]
 *
 * @param arr - Input integer array
 * @returns New array with duplicates removed
 */
export function intset(arr: number[]): number[] {
  return uniq(arr);
}

/**
 * Count the number of elements in an integer array.
 *
 * PostgreSQL signature:
 *   icount(integer[]) → integer
 *
 * @param arr - Input integer array
 * @returns Element count
 */
export function icount(arr: number[]): number {
  return arr.length;
}

/**
 * Append items to an integer array (push_array).
 *
 * PostgreSQL signature:
 *   push_array(integer[], integer[]) → integer[]
 *
 * Returns a new array with all elements from items appended to arr.
 *
 * @param arr   - Base integer array
 * @param items - Elements to append
 * @returns New concatenated integer array
 */
export function push_array(arr: number[], items: number[]): number[] {
  return [...arr, ...items];
}

/**
 * Prepend items to an integer array (push_front_array).
 *
 * PostgreSQL signature:
 *   push_front_array(integer[], integer[]) → integer[]
 *
 * Returns a new array with items inserted at the front.
 *
 * @param arr   - Base integer array
 * @param items - Elements to prepend
 * @returns New concatenated integer array
 */
export function push_front_array(arr: number[], items: number[]): number[] {
  return [...items, ...arr];
}

// ──────────── Operator implementations ──────────────────────────

/**
 * Check if arr1 contains arr2 (`@>` operator).
 *
 * Returns true if all elements of arr2 appear in arr1.
 *
 * PostgreSQL signature:
 *   integer[] @> integer[] → boolean
 *
 * @param arr1 - Superset candidate
 * @param arr2 - Subset candidate
 * @returns true if arr2 ⊆ arr1
 */
export function intarrayContains(arr1: number[], arr2: number[]): boolean {
  if (arr2.length === 0) return true;
  const set1 = new Set(arr1);
  return arr2.every(v => set1.has(v));
}

/**
 * Check if arr1 is contained by arr2 (`<@` operator).
 *
 * Returns true if all elements of arr1 appear in arr2.
 *
 * PostgreSQL signature:
 *   integer[] <@ integer[] → boolean
 *
 * @param arr1 - Subset candidate
 * @param arr2 - Superset candidate
 * @returns true if arr1 ⊆ arr2
 */
export function intarrayContainedBy(arr1: number[], arr2: number[]): boolean {
  if (arr1.length === 0) return true;
  const set2 = new Set(arr2);
  return arr1.every(v => set2.has(v));
}

/**
 * Check if two arrays overlap (`&&` operator).
 *
 * Returns true if the arrays share at least one common element.
 *
 * PostgreSQL signature:
 *   integer[] && integer[] → boolean
 *
 * @param arr1 - First integer array
 * @param arr2 - Second integer array
 * @returns true if arr1 ∩ arr2 ≠ ∅
 */
export function intarrayOverlap(arr1: number[], arr2: number[]): boolean {
  if (arr1.length === 0 || arr2.length === 0) return false;
  const set1 = new Set(arr1);
  return arr2.some(v => set1.has(v));
}

// ──────────── query_int support ──────────────────────────────────

/**
 * Simple query_int parser/evaluator.
 *
 * Supports a subset of PG's query_int syntax:
 *   - `1 & 2`       AND: element must be in both sets
 *   - `1 | 2`       OR:  element must be in either set
 *   - `!1`          NOT: element must NOT be in set 1
 *   - `(1 & 2) | 3` Parentheses for grouping
 *   - `1`           Simple: element must equal 1
 *
 * A "query" is parsed as a binary tree and evaluated against each
 * element in the input array. The function returns elements that
 * *match* the query.
 *
 * PostgreSQL signature:
 *   query_int(integer[], text) → integer[]
 *
 * @param arr   - Input integer array to filter.
 * @param query - Query expression string (e.g. '1 & (2 | 3)').
 * @returns Elements of arr that match the query.
 */
export function query_int(arr: number[], query: string): number[] {
  const elements = parseQueryElements(query);
  if (elements.length === 0) return [];

  // Parse the query as a set of conditions
  const ast = parseQueryExpression(query);
  if (!ast) return [];

  return arr.filter(v => evaluateQueryTree(ast, v));
}

// ── Query AST types ──────────────────────────────────────────────

interface QueryBinOp {
  type: 'binop';
  op: '&' | '|';
  left: QueryNode;
  right: QueryNode;
}

interface QueryUnaryOp {
  type: 'unary';
  op: '!';
  operand: QueryNode;
}

interface QueryLeaf {
  type: 'leaf';
  value: number;
}

type QueryNode = QueryBinOp | QueryUnaryOp | QueryLeaf;

// ── Simple recursive descent parser for query_int ───────────────

function parseQueryExpression(input: string): QueryNode | null {
  const tokens = tokenizeQuery(input);
  if (tokens.length === 0) return null;
  let pos = 0;

  function parseOr(): QueryNode {
    let left = parseAnd();
    while (pos < tokens.length && tokens[pos].value === '|') {
      pos++; // consume '|'
      const right = parseAnd();
      left = { type: 'binop', op: '|', left, right };
    }
    return left;
  }

  function parseAnd(): QueryNode {
    let left = parseUnary();
    while (pos < tokens.length && tokens[pos].value === '&') {
      pos++; // consume '&'
      const right = parseUnary();
      left = { type: 'binop', op: '&', left, right };
    }
    return left;
  }

  function parseUnary(): QueryNode {
    if (pos < tokens.length && tokens[pos].value === '!') {
      pos++; // consume '!'
      const operand = parsePrimary();
      return { type: 'unary', op: '!', operand };
    }
    return parsePrimary();
  }

  function parsePrimary(): QueryNode {
    if (pos >= tokens.length) {
      // Default: return a leaf with 0
      return { type: 'leaf', value: 0 };
    }
    const token = tokens[pos];
    if (token.type === 'number') {
      pos++;
      return { type: 'leaf', value: token.value as number };
    }
    if (token.value === '(') {
      pos++; // consume '('
      const node = parseOr();
      if (pos < tokens.length && tokens[pos].value === ')') {
        pos++; // consume ')'
      }
      return node;
    }
    // Unexpected token — skip
    pos++;
    return { type: 'leaf', value: 0 };
  }

  const result = parseOr();
  return result;
}

interface RawToken {
  type: 'number' | 'op' | 'paren';
  value: string | number;
}

function tokenizeQuery(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  const trimmed = input.trim();
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }

    if (ch === '&' || ch === '|' || ch === '!') {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    if (/[0-9\-]/.test(ch)) {
      const start = i;
      if (ch === '-') i++;
      while (i < trimmed.length && /[0-9]/.test(trimmed[i])) i++;
      const numStr = trimmed.slice(start, i);
      const num = parseInt(numStr, 10);
      if (!isNaN(num)) {
        tokens.push({ type: 'number', value: num });
      }
      continue;
    }

    i++; // skip unknown chars
  }

  return tokens;
}

function parseQueryElements(query: string): number[] {
  const elems: number[] = [];
  // eslint-disable-next-line require-unicode-regexp
  const re = /(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    elems.push(parseInt(m[1], 10));
  }
  return [...new Set(elems)];
}

function evaluateQueryTree(node: QueryNode, value: number): boolean {
  switch (node.type) {
    case 'leaf':
      return value === node.value;
    case 'unary':
      return !evaluateQueryTree(node.operand, value);
    case 'binop': {
      const leftVal = evaluateQueryTree(node.left, value);
      const rightVal = evaluateQueryTree(node.right, value);
      return node.op === '&' ? leftVal && rightVal : leftVal || rightVal;
    }
  }
}

// ──────────── SQL-level operator rewriting ───────────────────────

/**
 * Detect intarray operators (@>, <@, &&) in a SQL string.
 */
export function detectIntarrayOperator(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  const cleaned = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/--[^\n]*/g, '');
  // Check for @>, <@, && with array-like expressions
  // eslint-disable-next-line require-unicode-regexp
  return /\bARRAY\s*\[[^\]]*\]\s*@>\s*ARRAY\s*\[/i.test(cleaned) ||
    // eslint-disable-next-line require-unicode-regexp
    /\bARRAY\s*\[[^\]]*\]\s*<@\s*ARRAY\s*\[/i.test(cleaned) ||
    // eslint-disable-next-line require-unicode-regexp
    /\bARRAY\s*\[[^\]]*\]\s*&&\s*ARRAY\s*\[/i.test(cleaned) ||
    // Detect query_int function
    /\bquery_int\s*\(/i.test(cleaned);
}

/**
 * Rewrite intarray operators and query_int to function calls.
 *
 * Rewrites:
 *   `arr @> ARRAY[1,2]`   → `intarray_contains(arr, ARRAY[1,2])`
 *   `arr <@ ARRAY[1,2]`   → `intarray_contained_by(arr, ARRAY[1,2])`
 *   `arr && ARRAY[1,2]`   → `intarray_overlap(arr, ARRAY[1,2])`
 *   `query_int(arr, 'q')` → `query_int(arr, 'q')` (already function)
 */
export function rewriteIntarrayOperators(sql: string): { sql: string; rewritten: boolean } {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = sql;
  let rewritten = false;

  // `@>` → intarray_contains
  // Handles: col @> ARRAY[...] or ARRAY[...] @> ARRAY[...]
  // eslint-disable-next-line require-unicode-regexp
  result = result.replace(
    /([\w.()"`]+)\s*@>\s*(ARRAY\s*\[[^\]]*\])/gi,
    (_match, left, right) => {
      rewritten = true;
      return `intarray_contains(${left.trim()}, ${right.trim()})`;
    },
  );

  // Also handle ARRAY[...] on the left side of @>
  // eslint-disable-next-line require-unicode-regexp
  result = result.replace(
    /(ARRAY\s*\[[^\]]*\])\s*@>\s*(ARRAY\s*\[[^\]]*\])/gi,
    (_match, left, right) => {
      rewritten = true;
      return `intarray_contains(${left.trim()}, ${right.trim()})`;
    },
  );

  // `<@` → intarray_contained_by
  // eslint-disable-next-line require-unicode-regexp
  result = result.replace(
    /([\w.()"`]+)\s*<@\s*(ARRAY\s*\[[^\]]*\])/gi,
    (_match, left, right) => {
      rewritten = true;
      return `intarray_contained_by(${left.trim()}, ${right.trim()})`;
    },
  );

  // Also handle ARRAY[...] on the left side of <@
  // eslint-disable-next-line require-unicode-regexp
  result = result.replace(
    /(ARRAY\s*\[[^\]]*\])\s*<@\s*(ARRAY\s*\[[^\]]*\])/gi,
    (_match, left, right) => {
      rewritten = true;
      return `intarray_contained_by(${left.trim()}, ${right.trim()})`;
    },
  );

  // `&&` → intarray_overlap
  // eslint-disable-next-line require-unicode-regexp
  result = result.replace(
    /(ARRAY\s*\[[^\]]*\])\s*&&\s*(ARRAY\s*\[[^\]]*\])/gi,
    (_match, left, right) => {
      rewritten = true;
      return `intarray_overlap(${left.trim()}, ${right.trim()})`;
    },
  );

  if (rewritten) {
    logger.debug({ before: sql, after: result }, 'Rewrote intarray operators');
  }

  return { sql: result, rewritten };
}

// ──────────── Parsing helpers ────────────────────────────────────

/**
 * Parse a PostgreSQL array literal string into a number array.
 *
 * Supports formats:
 *   - `'{1,2,3}'`   (PG literal)
 *   - `'[1,2,3]'`   (JSON-like)
 *   - `'{}'`        (empty PG array)
 *
 * @param input - String representation of an integer array
 * @returns Parsed number array
 */
export function parsePgArray(input: string): number[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed === '{}' || trimmed === '[]') {
    return [];
  }

  let inner: string;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    inner = trimmed.slice(1, -1);
  } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    inner = trimmed.slice(1, -1);
  } else {
    // Try comma-separated numbers
    inner = trimmed;
  }

  if (!inner) {
    return [];
  }

  return inner.split(',').map(s => {
    const cleaned = s.trim();
    const num = Number(cleaned);
    return Number.isNaN(num) ? 0 : num;
  });
}

// ──────────── SQL-level detection ────────────────────────────────

/**
 * All intarray function names recognised by this shim.
 */
const INTAARRAY_FN_NAMES = [
  'uniq',
  'sort_asc',
  'sort_desc',
  'sort',
  'idx',
  'subarray',
  'intset',
  'icount',
  'push_array',
  'push_front_array',
];

/**
 * Compiled regex for detecting intarray function calls in SQL.
 *
 * Matches both direct calls (`uniq(...)`) and schema-qualified calls
 * (`public.uniq(...)`) in SQL statements.
 */
const INTAARRAY_FUNC_RE = new RegExp(
  `(?:\\b|(?<=\\.))(${INTAARRAY_FN_NAMES.join('|')})\\s*\\(`,
  'gi'
);

/**
 * Detect whether a SQL statement contains any intarray function calls.
 *
 * @param sql - Raw SQL string
 * @returns `true` if any intarray function is detected
 */
export function detectIntarrayFunction(sql: string): boolean {
  INTAARRAY_FUNC_RE.lastIndex = 0;
  return INTAARRAY_FUNC_RE.test(sql);
}

// ──────────── Catalog registration ──────────────────────────────

/**
 * Metadata for a single intarray function, compatible with pg_proc registration.
 */
export interface IntarrayFunctionMeta {
  /** Function name as exposed to SQL */
  name: string;
  /** Number of arguments (0 = variadic) */
  argCount: number;
  /** Comma-separated argument type names */
  argTypes: string;
  /** Return type name */
  returnType: string;
  /** Brief description */
  description: string;
}

/**
 * Full catalog of intarray extension functions for pg_proc registration.
 *
 * Import and register this array so that `SELECT * FROM pg_proc` returns
 * accurate metadata for all shimmed intarray functions.
 */
export const INTAARRAY_FUNCTIONS: IntarrayFunctionMeta[] = [
  {
    name: 'uniq',
    argCount: 1,
    argTypes: 'integer[]',
    returnType: 'integer[]',
    description: 'Remove duplicate elements from an integer array',
  },
  {
    name: 'sort_asc',
    argCount: 1,
    argTypes: 'integer[]',
    returnType: 'integer[]',
    description: 'Sort an integer array in ascending order',
  },
  {
    name: 'sort_desc',
    argCount: 1,
    argTypes: 'integer[]',
    returnType: 'integer[]',
    description: 'Sort an integer array in descending order',
  },
  {
    name: 'sort',
    argCount: 2,
    argTypes: 'integer[], text',
    returnType: 'integer[]',
    description: 'Sort an integer array with direction parameter',
  },
  {
    name: 'idx',
    argCount: 2,
    argTypes: 'integer[], integer',
    returnType: 'integer',
    description: 'Find 1-based index of an element in an integer array',
  },
  {
    name: 'subarray',
    argCount: 2,
    argTypes: 'integer[], integer',
    returnType: 'integer[]',
    description: 'Extract a subarray from a 1-based start position',
  },
  {
    name: 'intset',
    argCount: 1,
    argTypes: 'integer[]',
    returnType: 'integer[]',
    description: 'Alias for uniq: remove duplicates from an integer array',
  },
  {
    name: 'icount',
    argCount: 1,
    argTypes: 'integer[]',
    returnType: 'integer',
    description: 'Count elements in an integer array',
  },
  {
    name: 'push_array',
    argCount: 2,
    argTypes: 'integer[], integer[]',
    returnType: 'integer[]',
    description: 'Append items to an integer array',
  },
  {
    name: 'push_front_array',
    argCount: 2,
    argTypes: 'integer[], integer[]',
    returnType: 'integer[]',
    description: 'Prepend items to an integer array',
  },
];

/**
 * Convenience map for dynamic dispatch: function name → implementation.
 *
 * Useful for runtime interception of SQL function calls.
 */
export const INTAARRAY_FN_MAP: Record<string, (...args: any[]) => any> = {
  uniq,
  sort_asc,
  sort_desc,
  sort,
  idx,
  subarray,
  intset,
  icount,
  push_array,
  push_front_array,
  intarray_contains: intarrayContains,
  intarray_contained_by: intarrayContainedBy,
  intarray_overlap: intarrayOverlap,
  query_int,
};

export { logger };

// ═══════════════════════════════════════════════════════════════════
//  SQL-Level Function Rewrite (Phase E depth: inline JSON expressions)
// ═══════════════════════════════════════════════════════════════════

/**
 * Regex patterns for SQL-level function detection and rewrite.
 * Maps each intarray function to a SQLite-compatible JSON expression.
 */
const FN_REWRITE_PATTERNS: Array<{ re: RegExp; sql: string }> = [
  // icount(arr) → json_array_length(arr)
  { re: /\bicount\s*\((\s*((?:[^()]+|\([^)]*\))+)\s*)\)/gi, sql: 'json_array_length($1)' },
  // idx(arr, elem) → COALESCE(ordinal FROM json_each, 0)
  { re: /\bidx\s*\(([^,]+),([^)]+)\)/gi, sql: "COALESCE((SELECT __je_idx.\"key\"+1 FROM json_each($1) AS __je_idx WHERE __je_idx.value = $2 LIMIT 1), 0)" },
  // sort_asc(arr) → json_group_array ORDER BY ASC
  { re: /\bsort_asc\s*\(([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_sa.value ORDER BY __je_sa.value ASC) FROM json_each($1) AS __je_sa)" },
  // sort_desc(arr) → json_group_array ORDER BY DESC
  { re: /\bsort_desc\s*\(([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_sd.value ORDER BY __je_sd.value DESC) FROM json_each($1) AS __je_sd)" },
  // sort(arr, dir) → json_group_array with direction
  { re: /\bsort\s*\(([^,]+),([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_s.value ORDER BY CASE WHEN $2 = 'desc' OR $2 = 'DESC' THEN __je_s.value END DESC, __je_s.value ASC) FROM json_each($1) AS __je_s)" },
  // uniq(arr) → dedup via GROUP BY
  { re: /\buniq\s*\(([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_u.value ORDER BY MIN(__je_u.\"key\")) FROM json_each($1) AS __je_u GROUP BY __je_u.value)" },
  // intset(arr) → alias for uniq
  { re: /\bintset\s*\(([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_is.value ORDER BY MIN(__je_is.\"key\")) FROM json_each($1) AS __je_is GROUP BY __je_is.value)" },
  // subarray(arr, start) → subset from 1-based position
  { re: /\bsubarray\s*\(([^,]+),([^)]+)\)/gi, sql: "(SELECT json_group_array(__je_s2.value ORDER BY __je_s2.\"key\") FROM json_each($1) AS __je_s2 WHERE __je_s2.\"key\" >= ($2)-1)" },
];

/**
 * Rewrite intarray function calls to SQLite JSON expressions.
 *
 * @param sql - SQL statement containing intarray function calls
 * @returns Rewritten SQL
 */
export function rewriteIntarrayFunctions(sql: string): { sql: string; rewritten: boolean } {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = sql;
  let rewritten = false;

  for (const { re, sql: replacement } of FN_REWRITE_PATTERNS) {
    result = result.replace(re, (...args) => {
      rewritten = true;
      // Build replacement with proper capture group references
      let r = replacement;
      for (let i = 1; i < args.length - 2; i++) {
        // offset and string are always last two args in replace callback
        if (i >= args.length - 2) break;
        r = r.replace(new RegExp(`\\$${i}(?![0-9])`, 'g'), (args[i] ?? '').trim());
      }
      return r;
    });
  }

  if (rewritten) {
    logger.debug({ before: sql, after: result }, 'IntarrayShim: function rewrite applied');
  }

  return { sql: result, rewritten };
}

/**
 * Combined detection: operators OR functions.
 * Catches both ARRAY[...] operator syntax and column-based operators.
 */
export function detectIntarray(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  // Functions
  if (detectIntarrayFunction(sql)) return true;
  // ARRAY[...] operators (existing)
  if (detectIntarrayOperator(sql)) return true;
  // Column-based operators: column @> column, column && column, column <@ column
  const cleaned = sql.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '').replace(/--[^\n]*/g, '');
  if (/\w+\s*@>\s*\w+|\w+\s*<@\s*\w+|\w+\s*&&\s*\w+/i.test(cleaned)) return true;
  return false;
}

/**
 * Combined rewrite: operators THEN functions.
 */
export function rewriteIntarray(sql: string): { sql: string; rewritten: boolean } {
  let ops = rewriteIntarrayOperators(sql);
  let funcs = rewriteIntarrayFunctions(ops.sql);
  return { sql: funcs.sql, rewritten: ops.rewritten || funcs.rewritten };
}
