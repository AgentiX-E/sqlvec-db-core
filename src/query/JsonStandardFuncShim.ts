/**
 * JsonStandardFuncShim — SQL/JSON standard function compatibility shim
 *
 * Implements PostgreSQL-compatible SQL/JSON standard functions by
 * rewriting them to equivalent SQLite json_extract calls.
 *
 * Supported functions:
 *   - JSON_EXISTS(json, path)   → json_extract(json, path) IS NOT NULL
 *   - JSON_VALUE(json, path)    → json_extract(json, path)
 *   - JSON_QUERY(json, path)    → json_extract(json, path)
 *   - JSON_SCALAR(json)         → CASE WHEN json_type(json) IN ('array','object') THEN json ELSE json_extract(...) END
 *   - JSON_SERIALIZE(json)      → CAST(json AS TEXT)
 *
 * SQL/JSON standard uses $ path syntax (e.g., $.name, $[0]) which is
 * compatible with SQLite's json_extract path syntax.
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('JsonStandardFuncShim');

// ──────────────────────────────────────────────
//  Function rewrite registry
// ──────────────────────────────────────────────

/**
 * A single SQL/JSON standard function rewrite rule. `arity` is the number of
 * comma-separated arguments the function accepts (1 or 2); `render` builds the
 * SQLite-compatible replacement from the trimmed argument list.
 */
interface JsonStdRewriteRule {
  arity: 1 | 2;
  render(args: string[]): string;
}

/** Case-normalised name → rule. Longest names are tried first by the scanner. */
const JSON_STD_RULES: Record<string, JsonStdRewriteRule> = {
  JSON_EXISTS: {
    arity: 2,
    render: ([json, path]) => `(json_extract(${json}, ${path}) IS NOT NULL)`,
  },
  JSON_VALUE: {
    arity: 2,
    render: ([json, path]) => `json_extract(${json}, ${path})`,
  },
  JSON_QUERY: {
    arity: 2,
    render: ([json, path]) => `json_extract(${json}, ${path})`,
  },
  JSON_SCALAR: {
    arity: 1,
    render: ([json]) =>
      `(CASE WHEN json_type(${json}) IN ('array','object') THEN ${json} ELSE json_extract('{"val":'||${json}||'}','$.val') END)`,
  },
  JSON_SERIALIZE: {
    arity: 1,
    render: ([json]) => `CAST(${json} AS TEXT)`,
  },
};

/** Function names sorted longest-first so `JSON_*` matching is greedy and exact. */
const JSON_STD_NAMES = Object.keys(JSON_STD_RULES).sort((a, b) => b.length - a.length);

/**
 * Detect whether the given SQL contains any SQL/JSON standard function
 * (JSON_EXISTS, JSON_VALUE, JSON_QUERY, JSON_SCALAR, JSON_SERIALIZE, or the
 * JSON_OBJECT / JSON_ARRAY constructors) outside of string literals, quoted
 * identifiers, dollar-quoted strings, and comments.
 */
export function detectJsonStdFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  // Scalar/tuple functions (JSON_EXISTS/VALUE/QUERY/SCALAR/SERIALIZE).
  if (findNextJsonStdCall(sql, 0) !== -1) {
    return true;
  }
  // Constructors (JSON_OBJECT / JSON_ARRAY).
  return (
    findNextConstructorCall(sql, 'JSON_OBJECT', 0) !== null ||
    findNextConstructorCall(sql, 'JSON_ARRAY', 0) !== null
  );
}

/**
 * Rewrite SQL/JSON standard function calls to SQLite-compatible expressions.
 *
 * Rewrites:
 *   JSON_EXISTS(json, path)  → (json_extract(json, path) IS NOT NULL)
 *   JSON_VALUE(json, path)   → json_extract(json, path)
 *   JSON_QUERY(json, path)   → json_extract(json, path)
 *   JSON_SCALAR(json)        → CASE WHEN json_type(json) IN ('array','object') THEN json ELSE json_extract('{"val":'||json||'}','$.val') END
 *   JSON_SERIALIZE(json)     → CAST(json AS TEXT)
 *   JSON_OBJECT(...)         → json_object(key, val, ...)
 *   JSON_ARRAY(...)          → json_array(...)
 */
export function rewriteJsonStdFunc(sql: string): string {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return sql;
  }

  let result = sql;

  // Phase 1: rewrite the scalar/tuple functions via the scanner registry.
  result = rewriteScalarFuncs(result);
  if (result !== sql) {
    logger.debug(
      { original: sql, rewritten: result },
      'SQL/JSON standard functions rewritten',
    );
  }

  // Phase 2: JSON_OBJECT(...) → json_object(key, val, ...)
  result = rewriteJsonObjectCalls(result);

  // Phase 3: JSON_ARRAY(...) → json_array(...)
  result = rewriteJsonArrayCalls(result);

  return result;
}

// ──────────────────────────────────────────────
//  Scalar function scanner (JSON_EXISTS/VALUE/QUERY/SCALAR/SERIALIZE)
// ──────────────────────────────────────────────

/**
 * Locate the next SQL/JSON standard function call at or after `from`, returning
 * the starting index of the function name, or `-1` when none remain. Skips
 * string literals, quoted identifiers, dollar-quoted strings, and comments so
 * occurrences inside them are never mistaken for real function calls.
 */
function findNextJsonStdCall(sql: string, from: number): number {
  let i = from;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    const name = longestJsonStdNameAt(sql, i);
    if (name === null) {
      i++;
      continue;
    }

    // The name must be followed by an opening paren to be a call.
    let j = i + name.length;
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (j < sql.length && sql[j] === '(') {
      return i;
    }
    // Not a call (a column/index named like a function); advance past the name.
    i += name.length;
  }
  return -1;
}

/**
 * Return the longest JSON_STD rule name that begins at `pos` with a word
 * boundary on both sides, or `null` if none matches.
 */
function longestJsonStdNameAt(sql: string, pos: number): string | null {
  for (const name of JSON_STD_NAMES) {
    const end = pos + name.length;
    if (end > sql.length) continue;
    if (sql.slice(pos, end).toUpperCase() !== name) continue;
    // Word boundary before: preceded by a non-identifier char (or start).
    if (pos > 0 && isIdentChar(sql[pos - 1])) continue;
    // Word boundary after: followed by a non-identifier char (or end).
    if (end < sql.length && isIdentChar(sql[end])) continue;
    return name;
  }
  return null;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Rewrite every JSON_EXISTS/VALUE/QUERY/SCALAR/SERIALIZE call in `sql` using
 * literal-aware balanced-paren scanning.
 */
function rewriteScalarFuncs(sql: string): string {
  interface Replacement {
    start: number;
    end: number;
    text: string;
  }
  const replacements: Replacement[] = [];

  let from = 0;
  while (true) {
    const callStart = findNextJsonStdCall(sql, from);
    if (callStart === -1) break;

    const name = longestJsonStdNameAt(sql, callStart)!;
    const openIdx = callStart + name.length;
    // Skip whitespace between name and '(' (guaranteed by findNextJsonStdCall).
    let open = openIdx;
    while (open < sql.length && /\s/.test(sql[open])) open++;
    if (open >= sql.length || sql[open] !== '(') {
      from = openIdx;
      continue;
    }

    const close = findMatchingParen(sql, open);
    if (close === -1) {
      // Unbalanced call — leave the remainder untouched.
      break;
    }

    const rawArgs = sql.slice(open + 1, close);
    const rule = JSON_STD_RULES[name];

    const args =
      rule.arity === 1
        ? [rawArgs.trim()]
        : splitTopLevelCommas(rawArgs);

    if (args.length !== rule.arity) {
      from = close + 1;
      continue;
    }

    // Reject empty arguments (arity-1 with no content, or arity-2 with an
    // empty slot) — they are invalid calls and should be left alone.
    if (args.some((a) => a.length === 0)) {
      from = close + 1;
      continue;
    }

    replacements.push({ start: callStart, end: close + 1, text: rule.render(args) });
    from = close + 1;
  }

  if (replacements.length === 0) {
    return sql;
  }

  replacements.sort((a, b) => b.start - a.start);
  let result = sql;
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.text + result.slice(r.end);
  }
  return result;
}

// ──────────────────────────────────────────────
//  JSON_OBJECT / JSON_ARRAY helpers
// ──────────────────────────────────────────────

/**
 * Find the matching closing parenthesis for an opening paren at `startIdx`.
 * Skips string literals, quoted identifiers, dollar-quoted strings, and
 * comments via `skipSqlLiteral` so a `)` inside any of them does not terminate
 * the scan. Returns the index of the matching `)` or `-1` if unbalanced.
 */
function findMatchingParen(sql: string, startIdx: number): number {
  if (startIdx < 0 || startIdx >= sql.length || sql[startIdx] !== '(') {
    return -1;
  }
  let depth = 1;
  let i = startIdx + 1;
  while (i < sql.length) {
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
 * Split content by commas only at the top nesting level. Skips string
 * literals, quoted identifiers, dollar-quoted strings, and comments, and
 * tracks `(`/`[`/`{` depth so commas inside nested expressions are preserved.
 */
function splitTopLevelCommas(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  let i = 0;
  while (i < content.length) {
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

/**
 * Parse a single JSON_OBJECT pair into key and value.
 * Supports three syntax variants:
 *   1. KEY 'key' VALUE expr  (with KEY keyword)
 *   2. 'key' VALUE expr      (without KEY keyword)
 *   3. 'key': expr           (PG 16 colon syntax)
 *
 * Returns { key, value } or null if pair cannot be parsed (e.g., NULL key).
 */
function parseJsonObjectPair(pair: string): { key: string; value: string } | null {
  const trimmed = pair.trim();

  // Pattern 1: KEY 'key_string' VALUE expr
  const keyValueMatch = trimmed.match(/^KEY\s+'((?:[^'\\]|\\.)*)'\s+VALUE\s+(.*)$/i);
  if (keyValueMatch) {
    const key = `'${keyValueMatch[1]}'`;
    const value = keyValueMatch[2].trim();
    // NULL key: skip
    if (/^null$/i.test(key.replace(/'/g, ''))) return null;
    return { key, value };
  }

  // Pattern 2: 'key_string' VALUE expr (no KEY keyword)
  const noKeyMatch = trimmed.match(/^'((?:[^'\\]|\\.)*)'\s+VALUE\s+(.*)$/i);
  if (noKeyMatch) {
    const key = `'${noKeyMatch[1]}'`;
    const value = noKeyMatch[2].trim();
    return { key, value };
  }

  // Pattern 3: 'key_string': expr (colon syntax)
  const colonMatch = trimmed.match(/^'((?:[^'\\]|\\.)*)'\s*:\s*(.*)$/i);
  if (colonMatch) {
    const key = `'${colonMatch[1]}'`;
    const value = colonMatch[2].trim();
    return { key, value };
  }

  return null;
}

/**
 * Rewrite one JSON_OBJECT(...) call to json_object(key, val, ...).
 * Handles the outermost call only — called in a loop for nested calls.
 */
function rewriteOneJsonObject(
  sql: string,
  loc: { nameStart: number; openIdx: number },
): { result: string; nextFrom: number } {
  const { nameStart, openIdx } = loc;
  const closeParen = findMatchingParen(sql, openIdx);
  if (closeParen < 0) {
    // Unbalanced call: leave it untouched and advance past the name start so
    // the caller does not re-scan the same malformed construct forever.
    return { result: sql, nextFrom: nameStart + 1 };
  }

  // Extract content between parens
  const content = sql.slice(openIdx + 1, closeParen);
  const pairs = splitTopLevelCommas(content);
  const args: string[] = [];

  for (const pair of pairs) {
    const parsed = parseJsonObjectPair(pair);
    if (parsed) {
      args.push(parsed.key);
      args.push(parsed.value);
    }
    // NULL keys: simply skip the pair (no args added)
  }

  const rewritten = `json_object(${args.join(', ')})`;
  return {
    result: sql.slice(0, nameStart) + rewritten + sql.slice(closeParen + 1),
    // Advance just past the original name start so a nested JSON_OBJECT that
    // lives *inside* this call's arguments (now preserved verbatim in the
    // rewritten value) is still found by the next scan.
    nextFrom: nameStart + 1,
  };
}

/**
 * Rewrite all JSON_OBJECT(...) calls to json_object(key, val, ...), including
 * nested calls. The rewritten `json_object(` is lowercase so the case-sensitive
 * constructor scan does not re-match it. Advancing the cursor just past each
 * name start (rather than past the rewritten span) lets nested calls inside
 * arguments be discovered on the next pass while an unbalanced call is skipped
 * without causing an unbounded re-scan.
 */
function rewriteJsonObjectCalls(sql: string): string {
  let result = sql;
  let from = 0;
  while (true) {
    const loc = findNextConstructorCall(result, 'JSON_OBJECT', from);
    if (loc === null) break;
    const { result: next, nextFrom } = rewriteOneJsonObject(result, loc);
    result = next;
    from = nextFrom;
  }
  return result;
}

/**
 * Rewrite one JSON_ARRAY(...) call to json_array(...).
 * Simple pass-through of the inner content.
 */
function rewriteOneJsonArray(
  sql: string,
  loc: { nameStart: number; openIdx: number },
): { result: string; nextFrom: number } {
  const { nameStart, openIdx } = loc;
  const closeParen = findMatchingParen(sql, openIdx);
  if (closeParen < 0) {
    return { result: sql, nextFrom: nameStart + 1 };
  }

  const content = sql.slice(openIdx + 1, closeParen);
  const rewritten = `json_array(${content})`;
  return {
    result: sql.slice(0, nameStart) + rewritten + sql.slice(closeParen + 1),
    nextFrom: nameStart + 1,
  };
}

/**
 * Rewrite all JSON_ARRAY(...) calls to json_array(...), including nested calls.
 * See {@link rewriteJsonObjectCalls} for the cursor-driven strategy.
 */
function rewriteJsonArrayCalls(sql: string): string {
  let result = sql;
  let from = 0;
  while (true) {
    const loc = findNextConstructorCall(result, 'JSON_ARRAY', from);
    if (loc === null) break;
    const { result: next, nextFrom } = rewriteOneJsonArray(result, loc);
    result = next;
    from = nextFrom;
  }
  return result;
}

/**
 * Locate the next uppercase constructor call (JSON_OBJECT / JSON_ARRAY) at or
 * after `from`, outside of literals/comments, returning its name start index
 * and the index of its opening paren, or `null` when none remains. Matching is
 * case-sensitive so a previously rewritten lowercase `json_object(`/
 * `json_array(` is never re-matched.
 */
function findNextConstructorCall(
  sql: string,
  constructorName: 'JSON_OBJECT' | 'JSON_ARRAY',
  from: number,
): { nameStart: number; openIdx: number } | null {
  let i = from;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    if (sql.slice(i, i + constructorName.length) === constructorName) {
      // Word boundary before.
      if (i > 0 && isIdentChar(sql[i - 1])) {
        i++;
        continue;
      }
      // Find the opening paren after the name + optional whitespace.
      let open = i + constructorName.length;
      while (open < sql.length && /\s/.test(sql[open])) open++;
      if (open < sql.length && sql[open] === '(') {
        return { nameStart: i, openIdx: open };
      }
    }
    i++;
  }
  return null;
}
