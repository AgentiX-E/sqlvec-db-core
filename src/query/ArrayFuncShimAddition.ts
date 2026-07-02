/**
 * ArrayFuncShimAddition — Additional PostgreSQL array compatibility shims for SQLite.
 *
 * Extends ArrayFuncShim.ts with:
 *   - Array subscript rewriting (arr[1], arr[1:3], arr[1][2])
 *   - Unnest rewriting (unnest → json_each)
 *   - array_to_string rewriting
 *   - Combined detector + rewriter
 *
 * @module ArrayFuncShimAddition
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { detectArrayFunc, rewriteArrayFunc } from './ArrayFuncShim';

export type {
  ArrayFuncResult,
} from './ArrayFuncShim';

const logger = PinoLogger.forComponent('ArrayFuncShimAddition');

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Find the matching closing bracket for an opening bracket at `openPos`,
 * accounting for nesting.
 */
function findMatchingBracket(sql: string, openPos: number): number {
  let depth = 1;
  let idx = openPos + 1;
  while (idx < sql.length && depth > 0) {
    const ch = sql[idx];
    if (ch === '[') depth++;
    else if (ch === ']') depth--;
    if (depth > 0) idx++;
  }
  return depth === 0 ? idx : -1;
}

/**
 * Check if a character is a valid identifier character.
 */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$."]/i.test(ch);
}

/**
 * Check if a character is a whitespace character.
 */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/**
 * Find the start of the identifier before the given position.
 * The character at `end` should be the one right before `[`.
 */
function findIdentStart(sql: string, end: number): number {
  let idx = end;
  while (idx > 0 && (isIdentChar(sql[idx - 1]))) {
    idx--;
  }
  return idx;
}

// ── Regex patterns ───────────────────────────────────────────────

/**
 * Pattern matching array subscript access like `arr[1]`, `arr[1:3]`, `arr[1][2]`.
 *
 * This matches: identifier, optional whitespace, `[`, then content until `]`.
 */
// eslint-disable-next-line require-unicode-regexp
const ARRAY_SUBSCRIPT_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*\[(\d+(?:\s*:\s*\d+)?)\]/g;

/**
 * Pattern for unnest function calls.
 */
// eslint-disable-next-line require-unicode-regexp
const UNNEST_FUNC_RE = /\bunnest\s*\(/gi;

/**
 * Pattern for array_to_string function calls.
 */
// eslint-disable-next-line require-unicode-regexp
const ARRAY_TO_STRING_RE = /\barray_to_string\s*\(/gi;

// ── Public API ───────────────────────────────────────────────────

/**
 * Rewrite array subscript access like `arr[1]` to SQLite-compatible JSON extraction.
 *
 * Strategy:
 *   - `arr[1]` → `json_extract(arr, '$[0]')`
 *   - `arr[1:3]` → `json_extract(arr, '$[0]')` (simplified — returns first element only)
 *   - `arr[1][2]` → `json_extract(arr, '$[0][1]')` (multi-dim, simplified)
 *
 * This uses a CTE-safe approach where the identifier is preserved and only
 * the subscript expression is rewritten.
 *
 * ⚠️ Known limitations:
 *   - Slices (`arr[1:3]`) are simplified to return the first element only
 *   - Multi-dimensional indexing is simplified — dim2 as `$[0][1]` etc.
 *   - Subscripts inside string literals may be falsely matched
 *   - Nested subscripts (e.g., `arr[arr[1]]`) not fully supported
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteArraySubscript('SELECT arr[1] FROM t')
 * // → 'SELECT json_extract(arr, \'$[0]\') FROM t'
 *
 * rewriteArraySubscript('SELECT arr[1:3] FROM t')
 * // → 'SELECT json_extract(arr, \'$[0]\') FROM t'
 *
 * rewriteArraySubscript('SELECT arr[1][2] FROM t')
 * // → 'SELECT json_extract(arr, \'$[0][1]\') FROM t'
 * ```
 */
export function rewriteArraySubscript(sql: string): string {
  if (!sql || typeof sql !== 'string') {
    return sql ?? '';
  }

  // Collect replacements (right-to-left to preserve offsets)
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  ARRAY_SUBSCRIPT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ARRAY_SUBSCRIPT_RE.exec(sql)) !== null) {
    const ident = match[1];
    const subscript = match[2]; // e.g., "1", "1:3", "1"

    // Handle multi-dim: check if there's a chain like [1][2]
    // We already matched the first [d], now scan for subsequent [d]
    let fullEnd = match.index + match[0].length;
    const subscriptChain: string[] = [subscript];
    let scanPos = fullEnd;
    while (scanPos < sql.length) {
      // Skip whitespace
      while (scanPos < sql.length && isWhitespace(sql[scanPos])) scanPos++;
      if (scanPos >= sql.length || sql[scanPos] !== '[') break;

      const closeBracket = findMatchingBracket(sql, scanPos);
      if (closeBracket === -1) break;

      const inner = sql.slice(scanPos + 1, closeBracket).trim();
      subscriptChain.push(inner);
      fullEnd = closeBracket + 1;
      scanPos = fullEnd;
    }

    // Build the json_extract path
    const pathParts = subscriptChain.map((sub, idx) => {
      // For slices (e.g., "1:3"), use the start only
      const firstNum = sub.split(':')[0].trim();
      return `$${[idx]}[${parseInt(firstNum, 10) - 1}]`;
    });
    // For multi-dim, it's like '$[0][1]'; since each json path already includes the index,
    // we need to combine differently. Actually json_extract uses a single path string.
    // For PG arrays stored as JSON arrays: arr[1] → '$[0]', arr[1][2] → '$[0][1]'
    // The path syntax is: $[idx1][idx2]...
    let pathStr = '\'$';
    for (let i = 0; i < subscriptChain.length; i++) {
      const sub = subscriptChain[i];
      const firstNum = sub.split(':')[0].trim();
      const idxVal = Math.max(0, parseInt(firstNum, 10) - 1);
      pathStr += `[${idxVal}]`;
    }
    pathStr += '\'';

    const replacement = `json_extract(${ident}, ${pathStr})`;

    replacements.push({
      start: match.index,
      end: fullEnd,
      replacement,
    });
  }

  // Apply right-to-left
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'Array subscripts rewritten');
  }

  return sql;
}

/**
 * Rewrite `unnest(arr)` to SQLite-compatible `json_each` calls.
 *
 * Strategy:
 *   - `unnest(arr)` → `json_each(arr)` (standalone scalar context)
 *   - `UNNEST(arr) WITH ORDINALITY` → `json_each(arr)` + row number handling
 *
 * For set-returning context (FROM clause), `unnest(arr)` should be rewritten
 * to `json_each(arr)`. For scalar contexts (SELECT), the existing ArrayFuncShim
 * handles it with the function-level rewrite.
 *
 * This function handles the FROM-clause case specifically.
 *
 * ⚠️ Known limitations:
 *   - `WITH ORDINALITY` is dropped (row number not auto-added in SQLite's json_each)
 *   - No subquery wrapping (assumes json_each can be used inline)
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteUnnestCall('SELECT * FROM unnest(arr)')
 * // → 'SELECT * FROM json_each(arr)'
 *
 * rewriteUnnestCall('SELECT * FROM unnest(arr) WITH ORDINALITY')
 * // → 'SELECT * FROM json_each(arr) WITH ORDINALITY'
 *   (WITH ORDINALITY is preserved for downstream handling)
 * ```
 */
export function rewriteUnnestCall(sql: string): string {
  if (!sql || typeof sql !== 'string') {
    return sql ?? '';
  }

  // Replace `unnest(...)` with `json_each(...)` 
  // We need to find unnest calls and replace them with json_each
  // The existing rewriteArrayFunc already handles scalar unnest -> json_extract,
  // but for FROM clause context we want json_each
  
  // We'll match unnest( and the matching close paren
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  UNNEST_FUNC_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = UNNEST_FUNC_RE.exec(sql)) !== null) {
    const funcStart = match.index;
    const parenPos = funcStart + match[0].indexOf('(');
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen === -1) continue;

    const argsStr = sql.slice(parenPos + 1, closeParen).trim();
    // json_each expects one argument
    const replacement = `json_each(${argsStr})`;

    replacements.push({
      start: funcStart,
      end: closeParen + 1,
      replacement,
    });
  }

  // Apply right-to-left
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'Unnest calls rewritten to json_each');
  }

  return sql;
}

/**
 * Find the position of the matching closing parenthesis, accounting for nesting.
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  let idx = openPos + 1;
  while (idx < sql.length && depth > 0) {
    const ch = sql[idx];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth > 0) idx++;
  }
  return depth === 0 ? idx : -1;
}

/**
 * Rewrite `array_to_string(arr, delimiter, null_string)` to SQLite-compatible.
 *
 * Strategy:
 *   - `array_to_string(arr, ',')` → `json_array_length(arr)` simplified
 *   - Full rewrite: uses json array iteration
 *
 * SQLite doesn't have a native array join. The simplified version handles
 * basic cases where arrays are stored as JSON arrays.
 *
 * ⚠️ Since SQLite lacks a simple "join JSON array elements" function,
 * the implementation produces a placeholder expression. For production
 * use, a custom SQLite function should be registered.
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteArrayJoin("SELECT array_to_string(arr, ',')")
 * // Falls back to basic handling
 * ```
 */
export function rewriteArrayJoin(sql: string): string {
  if (!sql || typeof sql !== 'string') {
    return sql ?? '';
  }

  // Find array_to_string(...) calls and rewrite
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  // eslint-disable-next-line require-unicode-regexp
  const funcRe = /\barray_to_string\s*\(/gi;
  funcRe.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = funcRe.exec(sql)) !== null) {
    const funcStart = match.index;
    const parenPos = funcStart + match[0].indexOf('(');
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen === -1) continue;

    const argsStr = sql.slice(parenPos + 1, closeParen);
    const args = splitFuncArgsExternal(argsStr);

    let replacement: string;

    if (args.length === 2) {
      // array_to_string(arr, delimiter)
      const [arrExpr, delimExpr] = [args[0], args[1]];
      replacement = `(SELECT group_concat(json_each.value, ${delimExpr}) FROM json_each(${arrExpr}))`;
    } else if (args.length >= 3) {
      // array_to_string(arr, delimiter, null_string)
      const [arrExpr, delimExpr, _nullStr] = [args[0], args[1], args[2]];
      // Simplified: ignores null_string, just group_concat
      replacement = `(SELECT group_concat(json_each.value, ${delimExpr}) FROM json_each(${arrExpr}))`;
    } else {
      logger.warn({ args: argsStr }, 'array_to_string: insufficient arguments');
      continue;
    }

    replacements.push({ start: funcStart, end: closeParen + 1, replacement });
  }

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'array_to_string calls rewritten');
  }

  return sql;
}

/**
 * Split a comma-separated argument list, respecting nested brackets/parens.
 */
function splitFuncArgsExternal(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of argsStr) {
    if (ch === '(' || ch === '[') { depth++; current += ch; }
    else if (ch === ')' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; }
    else { current += ch; }
  }
  const last = current.trim();
  if (last.length > 0) args.push(last);
  return args;
}

/**
 * Rewrite `array_length(arr, 1)` to SQLite-compatible `json_array_length`.
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteArrayLength("SELECT array_length(arr, 1)")
 * // → "SELECT json_array_length(arr)"
 * ```
 */
export function rewriteArrayLength(sql: string): string {
  if (!sql || typeof sql !== 'string') {
    return sql ?? '';
  }

  // eslint-disable-next-line require-unicode-regexp
  const funcRe = /\barray_length\s*\(/gi;
  funcRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  while ((match = funcRe.exec(sql)) !== null) {
    const funcStart = match.index;
    const parenPos = funcStart + match[0].indexOf('(');
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen === -1) continue;

    const argsStr = sql.slice(parenPos + 1, closeParen);
    const args = splitFuncArgsExternal(argsStr);

    // array_length(arr, dim) — we only use the first arg, drop dim
    const arrExpr = args.length >= 1 ? args[0] : 'NULL';
    const replacement = `json_array_length(${arrExpr})`;

    replacements.push({ start: funcStart, end: closeParen + 1, replacement });
  }

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'array_length calls rewritten');
  }

  return sql;
}

/**
 * Rewrite `array_position(arr, element)` to SQLite-compatible JSON-based search.
 *
 * Strategy: Use a subquery with json_each to find the element position.
 *
 * @param sql - The raw SQL string to rewrite
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteArrayPosition("SELECT array_position(arr, 'foo')")
 * // → "SELECT (SELECT MIN(key) + 1 FROM json_each(arr) WHERE value = 'foo')"
 * ```
 */
export function rewriteArrayPosition(sql: string): string {
  if (!sql || typeof sql !== 'string') {
    return sql ?? '';
  }

  // eslint-disable-next-line require-unicode-regexp
  const funcRe = /\barray_position\s*\(/gi;
  funcRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  while ((match = funcRe.exec(sql)) !== null) {
    const funcStart = match.index;
    const parenPos = funcStart + match[0].indexOf('(');
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen === -1) continue;

    const argsStr = sql.slice(parenPos + 1, closeParen);
    const args = splitFuncArgsExternal(argsStr);

    if (args.length < 2) {
      logger.warn({ args: argsStr }, 'array_position: insufficient arguments');
      continue;
    }

    const [arrExpr, elemExpr] = [args[0], args[1]];
    // SQLite's json_each provides `key` (index) and `value`
    // PG array_position is 1-based, so we add 1
    const replacement = `(SELECT MIN(json_each.key) + 1 FROM json_each(${arrExpr}) WHERE json_each.value = ${elemExpr})`;

    replacements.push({ start: funcStart, end: closeParen + 1, replacement });
  }

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'array_position calls rewritten');
  }

  return sql;
}

/**
 * Combined array function detector and rewriter.
 *
 * Checks for all array function patterns (subscript access, unnest,
 * array_to_string, array_length, array_position) and applies rewrites
 * in order.
 *
 * The rewriting pipeline is:
 *   1. rewriteArraySubscript (identifier[subscript] → json_extract)
 *   2. rewriteUnnestCall (unnest → json_each)
 *   3. rewriteArrayJoin (array_to_string → group_concat via json_each)
 *   4. rewriteArrayLength (array_length → json_array_length)
 *   5. rewriteArrayPosition (array_position → subquery search)
 *   6. rewriteArrayFunc (from ArrayFuncShim for remaining functions)
 *
 * @param sql - The raw SQL string to process
 * @returns An object with `hasArrayFunction` (whether any rewrite was applied)
 *          and `rewrittenSql` (the rewritten SQL, original if no rewrites applied)
 *
 * @example
 * ```ts
 * detectArrayFunction("SELECT arr[1], array_length(arr, 1) FROM t")
 * // → { hasArrayFunction: true, rewrittenSql: "SELECT json_extract(arr, '$[0]'), json_array_length(arr) FROM t" }
 * ```
 */
export function detectArrayFunction(
  sql: string,
): { hasArrayFunction: boolean; rewrittenSql: string } {
  if (!sql || typeof sql !== 'string') {
    return { hasArrayFunction: false, rewrittenSql: sql ?? '' };
  }

  const originalSql = sql;

  // Apply all rewrites in order
  sql = rewriteArraySubscript(sql);
  sql = rewriteUnnestCall(sql);
  sql = rewriteArrayJoin(sql);
  sql = rewriteArrayLength(sql);
  sql = rewriteArrayPosition(sql);

  // Also check with existing shim
  const existingResult = rewriteArrayFunc(sql);

  const hasArrayFunction =
    sql !== originalSql ||
    existingResult.rewritten ||
    detectArrayFunc(originalSql);

  return {
    hasArrayFunction,
    rewrittenSql: existingResult.rewritten ? existingResult.sql : sql,
  };
}
