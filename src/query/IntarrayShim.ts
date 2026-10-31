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

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

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
  /* v8 ignore next -- ?? fallback is defensive default */
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
  const ast = _parseQueryExpression(query);
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

export function _tokenizeQuery(input: string): RawToken[] {
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

/**
 * Parse a query_int expression string into an AST (internal, exported for
 * direct unit testing of the recursive-descent edge cases).
 */
export function _parseQueryExpression(input: string): QueryNode | null {
  const tokens = _tokenizeQuery(input);
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
interface IntarrayOccurrence {
  op: 'contains' | 'contained_by' | 'overlap';
  start: number; // index of the first char of the LHS (replacement start)
  end: number; // index just past the RHS `]` (replacement end)
  lhs: string;
  rhsStart: number;
  rhsEnd: number;
}

/**
 * Locate the closing `]` of an `ARRAY[...]` literal, skipping string literals
 * and quoted identifiers so a `]` inside them does not terminate the array.
 *
 * @param sql        - The SQL text.
 * @param openBracket - Index of the `[` just after `ARRAY`.
 * @returns Index of the matching `]`, or `-1` if unterminated.
 */
function findArrayClose(sql: string, openBracket: number): number {
  let i = openBracket + 1;
  while (i < sql.length) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    if (sql[i] === ']') return i;
    i++;
  }
  return -1;
}

/**
 * Extract the left-hand operand ending at (inclusive) `end`. Returns the
 * operand text and the index of its first character, or `null` if none.
 *
 * Handles: `ARRAY[...]` literals, quoted identifiers (`"col"`, `` `col` ``),
 * parenthesised expressions/function calls, and plain/dotted identifiers.
 */
function extractLhs(sql: string, end: number): { text: string; start: number } | null {
  const ch = sql[end];

  // Quoted identifier: `"..."` or `` `...` ``. Walk back to the opening quote,
  // then continue over any dotted prefix (e.g. `sch."col"`).
  if (ch === '"' || ch === '`') {
    const open = skipBackwardLiteral(sql, end); // index of the opening quote
    let cursor = open - 1;
    while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    return { text: sql.slice(cursor + 1, end + 1), start: cursor + 1 };
  }

  // ARRAY[...] literal on the left side. Walk back from the `]` to the `ARRAY`
  // (or the `[`), including the bracketed content.
  if (ch === ']') {
    // Locate the matching `[` for this `]`, scanning backward with nested
    // bracket depth and literal skipping.
    let depth = 0;
    let cursor = end;
    while (cursor >= 0) {
      const c = sql[cursor];
      const skipBack = skipBackwardLiteral(sql, cursor);
      if (skipBack !== -1) {
        cursor = skipBack;
        continue;
      }
      if (c === ']') { depth++; cursor--; continue; }
      if (c === '[') {
        depth--;
        cursor--;
        if (depth <= 0) break;
        continue;
      }
      cursor--;
    }
    // cursor is now just before the `[` (or the ARRAY keyword may precede).
    let kwEnd = cursor + 1;
    let kwStart = kwEnd;
    while (kwStart > 0 && /\s/.test(sql[kwStart - 1])) kwStart--;
    const kwMatch = sql.slice(0, kwStart).match(/ARRAY$/i);
    if (kwMatch) {
      return { text: sql.slice(kwStart - 5, end + 1), start: kwStart - 5 };
    }
    return { text: sql.slice(cursor + 1, end + 1), start: cursor + 1 };
  }

  // Parenthesised expression / function call.
  if (ch === ')') {
    let depth = 0;
    let cursor = end;
    while (cursor >= 0) {
      const c = sql[cursor];
      const skipBack = skipBackwardLiteral(sql, cursor);
      if (skipBack !== -1) {
        cursor = skipBack;
        continue;
      }
      if (c === ')') { depth++; cursor--; continue; }
      if (c === '(') {
        depth--;
        cursor--;
        if (depth <= 0) break;
        continue;
      }
      if (depth > 0) { cursor--; continue; }
      break;
    }
    while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    return { text: sql.slice(cursor + 1, end + 1), start: cursor + 1 };
  }

  // Plain identifier or dotted qualified name.
  let cursor = end;
  while (cursor >= 0 && /[A-Za-z0-9_."`[\]]/.test(sql[cursor])) cursor--;
  return { text: sql.slice(cursor + 1, end + 1), start: cursor + 1 };
}

/**
 * Skip backward over a string literal, quoted identifier, or dollar-quoted
 * string whose *closing* edge is at (inclusive) `pos`. Returns the index of the
 * *opening* edge of the construct, or `-1` if `pos` is not such a closing edge.
 */
function skipBackwardLiteral(sql: string, pos: number): number {
  const c = sql[pos];
  if (c !== "'" && c !== '"' && c !== '`') return -1;

  let j = pos - 1;
  while (j >= 0) {
    const prev = sql[j];
    if (prev === c) {
      // Doubled-quote escape (`''`, `""`, `` ``).
      if (j - 1 >= 0 && sql[j - 1] === c) {
        j -= 2;
        continue;
      }
      return j; // index of the matching opening quote
    }
    // Backslash escape inside an E'' string.
    if (prev === '\\' && c === "'" && j - 1 >= 0) {
      j -= 2;
      continue;
    }
    j--;
  }
  return -1;
}

/**
 * Scan `sql` for intarray operators (`@>`, `<@`, `&&`) outside of literals and
 * comments. Each occurrence must have a right-hand side starting with `ARRAY[`.
 */
function findIntarrayOccurrences(sql: string): IntarrayOccurrence[] {
  const occurrences: IntarrayOccurrence[] = [];

  for (let i = 0; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    const ch = sql[i];
    let op: IntarrayOccurrence['op'] | null = null;
    let opEnd = i;

    if (ch === '@' && sql[i + 1] === '>') {
      op = 'contains';
      opEnd = i + 2;
    } else if (ch === '<' && sql[i + 1] === '@') {
      op = 'contained_by';
      opEnd = i + 2;
    } else if (ch === '&' && sql[i + 1] === '&') {
      op = 'overlap';
      opEnd = i + 2;
    }

    if (op === null) continue;

    // Locate the `ARRAY[` of the right-hand side.
    let rhsStart = opEnd;
    while (rhsStart < sql.length && /\s/.test(sql[rhsStart])) rhsStart++;
    if (!/^ARRAY\b/i.test(sql.slice(rhsStart))) continue;

    let bracket = rhsStart + 5;
    while (bracket < sql.length && /\s/.test(sql[bracket])) bracket++;
    if (bracket >= sql.length || sql[bracket] !== '[') continue;
    const rhsEnd = findArrayClose(sql, bracket);
    if (rhsEnd === -1) continue;

    // Extract the left-hand operand.
    let lhsEnd = i - 1;
    while (lhsEnd >= 0 && /\s/.test(sql[lhsEnd])) lhsEnd--;
    if (lhsEnd < 0) continue;
    const lhsInfo = extractLhs(sql, lhsEnd);
    if (!lhsInfo || lhsInfo.text.trim() === '') continue;

    occurrences.push({
      op,
      start: lhsInfo.start,
      end: rhsEnd + 1,
      lhs: lhsInfo.text,
      rhsStart,
      rhsEnd,
    });
    i = rhsEnd;
  }

  return occurrences;
}

/**
 * Detect intarray operators (@>, <@, &&) outside of literals/comments, or a
 * `query_int(...)` call.
 */
export function detectIntarrayOperator(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  if (findIntarrayOccurrences(sql).length > 0) return true;

  // query_int(...) call outside of literals.
  for (let i = 0; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (/^query_int\s*\(/i.test(sql.slice(i))) return true;
  }
  return false;
}

/**
 * Rewrite intarray operators to function calls, literal-aware.
 *
 * Rewrites:
 *   `arr @> ARRAY[1,2]`   → `intarray_contains(arr, ARRAY[1,2])`
 *   `arr <@ ARRAY[1,2]`   → `intarray_contained_by(arr, ARRAY[1,2])`
 *   `arr && ARRAY[1,2]`   → `intarray_overlap(arr, ARRAY[1,2])`
 */
export function rewriteIntarrayOperators(sql: string): { sql: string; rewritten: boolean } {
  if (!sql || typeof sql !== 'string') {
  /* v8 ignore next -- ?? fallback is defensive default */
    return { sql: sql ?? '', rewritten: false };
  }

  const occurrences = findIntarrayOccurrences(sql);
  if (occurrences.length === 0) {
    return { sql, rewritten: false };
  }

  const fnName = {
    contains: 'intarray_contains',
    contained_by: 'intarray_contained_by',
    overlap: 'intarray_overlap',
  } as const;

  // Apply right-to-left to keep earlier offsets valid.
  const parts: string[] = [];
  let lastEnd = sql.length;
  for (const occ of [...occurrences].sort((a, b) => b.start - a.start)) {
    if (occ.end > lastEnd) {
      logger.warn({ occurrence: occ }, 'Overlapping intarray replacement — skipping');
      continue;
    }
    const rhs = sql.slice(occ.rhsStart, occ.rhsEnd + 1).trim();
    parts.push(sql.slice(occ.end, lastEnd));
    parts.push(`${fnName[occ.op]}(${occ.lhs.trim()}, ${rhs})`);
    lastEnd = occ.start;
  }
  parts.push(sql.slice(0, lastEnd));

  const result = parts.reverse().join('');
  logger.debug({ before: sql, after: result }, 'Rewrote intarray operators');
  return { sql: result, rewritten: true };
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

  if (!inner.trim()) {
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

/**
 * Register the intarray operator functions that the operator rewrite emits.
 *
 * `rewriteIntarrayOperators` translates `a @> b` / `a <@ b` / `a && b` into
 * `intarray_contains(a, b)` / `intarray_contained_by(a, b)` /
 * `intarray_overlap(a, b)`. These names are NOT re-mapped to JSON expressions
 * by {@link rewriteIntarrayFunctions} (only the standalone functions such as
 * `icount`/`sort_asc` are), so the operator results cannot execute unless the
 * three names are bound as SQL functions.
 *
 * SQLite has no array type: an `integer[]` value reaches these callbacks as a
 * JSON array string (e.g. `[1,2,3]`, produced by `json_array(...)` or stored
 * verbatim in a TEXT column). Each callback therefore decodes its JSON-array
 * arguments with {@link toIntArray}, delegates to the pure implementation, and
 * returns a boolean exactly as PostgreSQL does.
 *
 * @param db - SQLite connection exposing `.function(name, opts, fn)`.
 */
export function registerIntarrayFunctions(db: any): void {
  if (typeof db?.function !== 'function') {
    logger.warn('No `.function()` method on database — cannot register intarray operator functions');
    return;
  }
  const opts = { deterministic: true } as const;
  // better-sqlite3 only accepts number/string/null/Buffer return values, so
  // the boolean operator results are mapped to SQLite integers (1/0), which
  // SQLite treats as truthy/falsy exactly as PostgreSQL treats boolean.
  db.function('intarray_contains', opts, (a: any, b: any) => (intarrayContains(toIntArray(a), toIntArray(b)) ? 1 : 0));
  db.function('intarray_contained_by', opts, (a: any, b: any) => (intarrayContainedBy(toIntArray(a), toIntArray(b)) ? 1 : 0));
  db.function('intarray_overlap', opts, (a: any, b: any) => (intarrayOverlap(toIntArray(a), toIntArray(b)) ? 1 : 0));
}

/**
 * Decode a SQLite value that represents an `integer[]` into a `number[]`.
 *
 * Accepts a JSON array string (`[1,2]`), a PostgreSQL array-literal
 * (`{1,2}`), and a pre-parsed number array (for programmatic callers). An
 * empty/undefined value is treated as an empty array, matching the
 * PostgreSQL semantic where an unset operand never satisfies `@>`.
 */
function toIntArray(value: any): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (value == null) return [];
  const s = String(value).trim();
  if (s === '' || s === '{}' || s === '[]') return [];
  if (s[0] === '{') return parsePgArray(s);
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.map(Number);
  /* v8 ignore next -- catch is defensive fallback */
  } catch {
    // Fall through: not JSON — treat as a single-element array (a bare scalar).
  }
  const n = Number(s);
  return Number.isNaN(n) ? [] : [n];
}

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
  /* v8 ignore next -- ?? fallback is defensive default */
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
        // offset and string are always last two args in the replace callback,
        // so group indices stop well before `args.length - 2`.
  /* v8 ignore next -- ?? fallback is defensive default */
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
