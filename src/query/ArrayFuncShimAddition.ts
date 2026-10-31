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

import { PinoLogger } from '../logger/PinoLogger';
import { detectArrayFunc, rewriteArrayFunc } from './ArrayFuncShim';
import { skipSqlLiteral } from './SqlLiteralScanner';

export type {
  ArrayFuncResult,
} from './ArrayFuncShim';

const logger = PinoLogger.forComponent('ArrayFuncShimAddition');

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Find the matching closing bracket for an opening bracket at `openPos`,
 * accounting for nesting and skipping string literals, quoted identifiers and
 * comments so brackets inside them are not miscounted.
 */
function findMatchingBracket(sql: string, openPos: number): number {
  let depth = 1;
  for (let idx = openPos + 1; idx < sql.length; ) {
    const skipped = skipSqlLiteral(sql, idx);
    if (skipped !== -1) {
      idx = skipped;
      continue;
    }
    const ch = sql[idx];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return idx;
    }
    idx++;
  }
  return -1;
}

/**
 * Find the matching closing parenthesis for an opening parenthesis at
 * `openPos`, accounting for nesting and skipping literals/comments.
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  for (let idx = openPos + 1; idx < sql.length; ) {
    const skipped = skipSqlLiteral(sql, idx);
    if (skipped !== -1) {
      idx = skipped;
      continue;
    }
    const ch = sql[idx];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return idx;
    }
    idx++;
  }
  return -1;
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
 * Find the start of the identifier immediately before position `end` (which is
 * the index of the `[`).
 */
function findIdentStartBackward(sql: string, before: number): number {
  let idx = before;
  while (idx > 0 && /[A-Za-z0-9_]/.test(sql[idx - 1])) idx--;
  return idx < before ? idx : -1;
}

/**
 * Split a comma-separated argument list, respecting nested parentheses and
 * brackets and skipping string literals, quoted identifiers and comments so
 * commas or brackets inside them are never treated as separators.
 */
function splitFuncArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < argsStr.length; ) {
    const skipped = skipSqlLiteral(argsStr, i);
    if (skipped !== -1) {
      current += argsStr.slice(i, skipped);
      i = skipped;
      continue;
    }
    const ch = argsStr[i];
    if (ch === '(' || ch === '[') { depth++; current += ch; }
    else if (ch === ')' || ch === ']') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; }
    else { current += ch; }
    i++;
  }
  const last = current.trim();
  if (last.length > 0) args.push(last);
  return args;
}

/**
 * Locate the next occurrence of a function name followed by `(` at or after
 * `from`, skipping literals/comments, and return the positions of the name
 * start and opening paren, or `null` when no further call exists.
 */
function findNextCall(
  sql: string,
  name: string,
  from: number,
): { nameStart: number; parenPos: number } | null {
  const lower = sql.toLowerCase();
  const needle = name.toLowerCase();
  const len = sql.length;

  for (let i = from; i < len; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const boundaryOk = i === 0 || !isIdentChar(sql[i - 1]);
    if (boundaryOk && lower.slice(i, i + needle.length) === needle) {
      let open = i + needle.length;
      while (open < len && isWhitespace(sql[open])) open++;
      if (open < len && sql[open] === '(') {
        return { nameStart: i, parenPos: open };
      }
    }
    i++;
  }

  return null;
}


// ── Regex patterns have been removed in favor of literal-aware scanning ──

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
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  // Collect replacements (right-to-left to preserve offsets).
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  const len = sql.length;

  for (let i = 0; i < len; ) {
    // Skip literal/comment spans so `[` inside them is never matched.
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    if (sql[i] !== '[') {
      i++;
      continue;
    }

    // Find the identifier immediately before `[`.
    const identStart = findIdentStartBackward(sql, i);
    if (identStart === -1) {
      i++;
      continue;
    }
    const ident = sql.slice(identStart, i);

    // Match the first subscript: `[` digits (`: digit`) `]`.
    const first = matchSubscriptDigits(sql, i);
    if (first === null) {
      i++;
      continue;
    }

    // Collect chained subscripts `[1][2]`.
    const subscriptChain: string[] = [first.content];
    let fullEnd = first.end;
    let scanPos = fullEnd;
    for (;;) {
      while (scanPos < len && isWhitespace(sql[scanPos])) scanPos++;
      if (scanPos >= len || sql[scanPos] !== '[') break;

      const closeBracket = findMatchingBracket(sql, scanPos);
      if (closeBracket === -1) break;
      const inner = sql.slice(scanPos + 1, closeBracket).trim();
      if (!/^\d+(?:\s*:\s*\d+)?$/.test(inner)) break;
      subscriptChain.push(inner);
      fullEnd = closeBracket + 1;
      scanPos = fullEnd;
    }

    // Build the json_extract path, one `[idx]` per dimension.
    let pathStr = "'$";
    for (const sub of subscriptChain) {
      const firstNum = sub.split(':')[0].trim();
      const idxVal = Math.max(0, parseInt(firstNum, 10) - 1);
      pathStr += `[${idxVal}]`;
    }
    pathStr += "'";

    replacements.push({
      start: identStart,
      end: fullEnd,
      replacement: `json_extract(${ident}, ${pathStr})`,
    });

    i = fullEnd;
  }

  // Apply right-to-left.
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'Array subscripts rewritten');
  }

  return sql;
}

/**
 * Match a numeric subscript at `openBracket`, of the form `[digits]` or
 * `[digits : digits]`. Returns the normalized content (with whitespace
 * collapsed) and the index just past the closing bracket, or `null` when the
 * bracket content is not a plain numeric subscript.
 */
function matchSubscriptDigits(
  sql: string,
  openBracket: number,
): { content: string; end: number } | null {
  const close = findMatchingBracket(sql, openBracket);
  if (close === -1) return null;
  const inner = sql.slice(openBracket + 1, close).trim();
  if (!/^\d+(?:\s*:\s*\d+)?$/.test(inner)) return null;
  return { content: inner, end: close + 1 };
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
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let from = 0;
  let loc = findNextCall(sql, 'unnest', from);
  while (loc !== null) {
    const { nameStart, parenPos } = loc;
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen !== -1) {
      const argsStr = sql.slice(parenPos + 1, closeParen).trim();
      replacements.push({
        start: nameStart,
        end: closeParen + 1,
        replacement: `json_each(${argsStr})`,
      });
      from = closeParen + 1;
    } else {
      from = parenPos + 1;
    }
    loc = findNextCall(sql, 'unnest', from);
  }

  // Apply right-to-left.
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + r.replacement + sql.slice(r.end);
  }

  if (replacements.length > 0) {
    logger.debug({ count: replacements.length }, 'Unnest calls rewritten to json_each');
  }

  return sql;
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
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let from = 0;
  let loc = findNextCall(sql, 'array_to_string', from);
  while (loc !== null) {
    const { nameStart, parenPos } = loc;
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen !== -1) {
      const argsStr = sql.slice(parenPos + 1, closeParen);
      const args = splitFuncArgs(argsStr);

      if (args.length >= 2) {
        const [arrExpr, delimExpr] = [args[0], args[1]];
        replacements.push({
          start: nameStart,
          end: closeParen + 1,
          replacement: `(SELECT group_concat(json_each.value, ${delimExpr}) FROM json_each(${arrExpr}))`,
        });
        from = closeParen + 1;
      } else {
        logger.warn({ args: argsStr }, 'array_to_string: insufficient arguments');
        from = closeParen + 1;
      }
    } else {
      from = parenPos + 1;
    }
    loc = findNextCall(sql, 'array_to_string', from);
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
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let from = 0;
  let loc = findNextCall(sql, 'array_length', from);
  while (loc !== null) {
    const { nameStart, parenPos } = loc;
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen !== -1) {
      const argsStr = sql.slice(parenPos + 1, closeParen);
      const args = splitFuncArgs(argsStr);
      // array_length(arr, dim) — only the first arg is used; dim is dropped.
      const arrExpr = args.length >= 1 ? args[0] : 'NULL';
      replacements.push({
        start: nameStart,
        end: closeParen + 1,
        replacement: `json_array_length(${arrExpr})`,
      });
      from = closeParen + 1;
    } else {
      from = parenPos + 1;
    }
    loc = findNextCall(sql, 'array_length', from);
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
  /* v8 ignore next -- ?? fallback is defensive default */
    return sql ?? '';
  }

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let from = 0;
  let loc = findNextCall(sql, 'array_position', from);
  while (loc !== null) {
    const { nameStart, parenPos } = loc;
    const closeParen = findMatchingParen(sql, parenPos);
    if (closeParen === -1) {
      from = parenPos + 1;
      loc = findNextCall(sql, 'array_position', from);
      continue;
    }

    const argsStr = sql.slice(parenPos + 1, closeParen);
    const args = splitFuncArgs(argsStr);

    if (args.length < 2) {
      logger.warn({ args: argsStr }, 'array_position: insufficient arguments');
      from = closeParen + 1;
      loc = findNextCall(sql, 'array_position', from);
      continue;
    }

    const [arrExpr, elemExpr] = [args[0], args[1]];
    replacements.push({
      start: nameStart,
      end: closeParen + 1,
      replacement: `(SELECT MIN(json_each.key) + 1 FROM json_each(${arrExpr}) WHERE json_each.value = ${elemExpr})`,
    });
    from = closeParen + 1;
    loc = findNextCall(sql, 'array_position', from);
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
  /* v8 ignore next -- ?? fallback is defensive default */
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
