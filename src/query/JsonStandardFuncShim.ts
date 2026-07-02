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

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('JsonStandardFuncShim');

// ──────────────────────────────────────────────
//  Regex patterns
// ──────────────────────────────────────────────

/**
 * Detects the JSON_EXISTS(json, path) function with optional whitespace.
 */
const JSON_EXISTS_PATTERN = /\bJSON_EXISTS\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;

/**
 * Detects the JSON_VALUE(json, path) function.
 */
const JSON_VALUE_PATTERN = /\bJSON_VALUE\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;

/**
 * Detects the JSON_QUERY(json, path) function.
 */
const JSON_QUERY_PATTERN = /\bJSON_QUERY\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/i;

/**
 * Detects the JSON_SCALAR(json) function.
 */
const JSON_SCALAR_PATTERN = /\bJSON_SCALAR\s*\(\s*([^)]+)\s*\)/i;

/**
 * Detects the JSON_SERIALIZE(json) function.
 */
const JSON_SERIALIZE_PATTERN = /\bJSON_SERIALIZE\s*\(\s*([^)]+)\s*\)/i;

/**
 * Detects JSON_OBJECT(KEY 'k' VALUE v, ...)  — SQL standard JSON constructor
 */
const JSON_OBJECT_RE = /\bJSON_OBJECT\s*\(/i;

/**
 * Detects JSON_ARRAY(v1, v2, ...) — SQL standard JSON array constructor
 */
const JSON_ARRAY_RE = /\bJSON_ARRAY\s*\(/i;

/**
 * Combined pattern to detect ANY SQL/JSON standard function.
 */
const ANY_JSON_STD_PATTERN = /\bJSON_(?:EXISTS|VALUE|QUERY|SCALAR|SERIALIZE|OBJECT|ARRAY)\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any SQL/JSON standard functions
 * (JSON_EXISTS, JSON_VALUE, JSON_QUERY, JSON_SCALAR, JSON_SERIALIZE).
 */
export function detectJsonStdFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return ANY_JSON_STD_PATTERN.test(sql);
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
 */
export function rewriteJsonStdFunc(sql: string): string {
  if (!detectJsonStdFunc(sql)) {
    return sql;
  }

  let rewrittenSql = sql;

  // 1. JSON_EXISTS(json, path) → (json_extract(json, path) IS NOT NULL)
  rewrittenSql = rewrittenSql.replace(
    JSON_EXISTS_PATTERN,
    (match, jsonExpr: string, pathExpr: string) => {
      const json = jsonExpr.trim();
      const path = pathExpr.trim();
      return `(json_extract(${json}, ${path}) IS NOT NULL)`;
    },
  );

  // 2. JSON_VALUE(json, path) → json_extract(json, path)
  rewrittenSql = rewrittenSql.replace(
    JSON_VALUE_PATTERN,
    (match, jsonExpr: string, pathExpr: string) => {
      const json = jsonExpr.trim();
      const path = pathExpr.trim();
      return `json_extract(${json}, ${path})`;
    },
  );

  // 3. JSON_QUERY(json, path) → json_extract(json, path)
  rewrittenSql = rewrittenSql.replace(
    JSON_QUERY_PATTERN,
    (match, jsonExpr: string, pathExpr: string) => {
      const json = jsonExpr.trim();
      const path = pathExpr.trim();
      return `json_extract(${json}, ${path})`;
    },
  );

  // 4. JSON_SCALAR(json) → CASE WHEN json_type(json) IN ('array','object') THEN json ELSE json_extract('{"val":'||json||'}','$.val') END
  rewrittenSql = rewrittenSql.replace(
    JSON_SCALAR_PATTERN,
    (match, jsonExpr: string) => {
      const json = jsonExpr.trim();
      return `(CASE WHEN json_type(${json}) IN ('array','object') THEN ${json} ELSE json_extract('{"val":'||${json}||'}','$.val') END)`;
    },
  );

  // 5. JSON_SERIALIZE(json) → CAST(json AS TEXT)
  rewrittenSql = rewrittenSql.replace(
    JSON_SERIALIZE_PATTERN,
    (match, jsonExpr: string) => {
      const json = jsonExpr.trim();
      return `CAST(${json} AS TEXT)`;
    },
  );

  // ──────────────────────────────────────────────
  //  JSON_OBJECT rewrite
  // ──────────────────────────────────────────────

  rewrittenSql = rewriteJsonObjectCalls(rewrittenSql);

  // ──────────────────────────────────────────────
  //  JSON_ARRAY rewrite
  // ──────────────────────────────────────────────

  rewrittenSql = rewriteJsonArrayCalls(rewrittenSql);

  if (rewrittenSql !== sql) {
    logger.debug(
      { original: sql, rewritten: rewrittenSql },
      'SQL/JSON standard functions rewritten',
    );
  }

  return rewrittenSql;
}

// ──────────────────────────────────────────────
//  JSON_OBJECT / JSON_ARRAY helpers
// ──────────────────────────────────────────────

/**
 * Find the matching closing parenthesis for an opening paren at startIdx.
 * Handles nested parens and single-quoted string literals.
 */
function findMatchingParen(sql: string, startIdx: number): number {
  let depth = 1;
  let inStr = false;
  // Start AFTER the opening paren so we don't double-count it
  let i = startIdx + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (inStr) {
      if (ch === "'") inStr = false;
    } else {
      if (ch === "'") inStr = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 * Split content by commas only at the top nesting level.
 * Respects single-quoted strings and nested parens/brackets/braces.
 */
function splitTopLevelCommas(content: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inStr) {
      if (ch === "'") inStr = false;
    } else {
      if (ch === "'") inStr = true;
      else if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(content.slice(start, i).trim());
        start = i + 1;
      }
    }
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
function rewriteOneJsonObject(sql: string): string {
  const match = sql.match(JSON_OBJECT_REWRITE_RE);
  if (!match) return sql;

  const fnCallStart = match.index!;
  const fnNameLen = match[0].length;
  // Find the opening '(' — after JSON_OBJECT + optional whitespace
  const parenIdx = fnCallStart + fnNameLen - 1; // position of '('

  const closeParen = findMatchingParen(sql, parenIdx);
  if (closeParen < 0) return sql;

  // Extract content between parens
  const content = sql.slice(parenIdx + 1, closeParen);
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
  return sql.slice(0, fnCallStart) + rewritten + sql.slice(closeParen + 1);
}

/**
 * Rewrite all JSON_OBJECT(...) calls to json_object(key, val, ...).
 * Handles nested calls by iterating until no more matches.
 * Uses case-sensitive matching to avoid re-matching rewritten lowercase json_object(.
 */
const JSON_OBJECT_REWRITE_RE = /\bJSON_OBJECT\s*\(/;

function rewriteJsonObjectCalls(sql: string): string {
  let result = sql;
  let iterations = 0;
  const MAX_ITERATIONS = 100;
  while (JSON_OBJECT_REWRITE_RE.test(result) && iterations < MAX_ITERATIONS) {
    result = rewriteOneJsonObject(result);
    iterations++;
  }
  return result;
}

/**
 * Rewrite one JSON_ARRAY(...) call to json_array(...).
 * Simple pass-through of the inner content.
 */
function rewriteOneJsonArray(sql: string): string {
  const match = sql.match(JSON_ARRAY_RE);
  if (!match) return sql;

  const fnCallStart = match.index!;
  const fnNameLen = match[0].length;
  const parenIdx = fnCallStart + fnNameLen - 1; // position of '('

  const closeParen = findMatchingParen(sql, parenIdx);
  if (closeParen < 0) return sql;

  const content = sql.slice(parenIdx + 1, closeParen);
  const rewritten = `json_array(${content})`;
  return sql.slice(0, fnCallStart) + rewritten + sql.slice(closeParen + 1);
}

/**
 * Rewrite all JSON_ARRAY(...) calls to json_array(...).
 * Handles nested calls by iterating until no more matches.
 * Uses case-sensitive matching to avoid re-matching rewritten lowercase json_array(.
 */
const JSON_ARRAY_REWRITE_RE = /\bJSON_ARRAY\s*\(/;

function rewriteJsonArrayCalls(sql: string): string {
  let result = sql;
  let iterations = 0;
  const MAX_ITERATIONS = 100;
  while (JSON_ARRAY_REWRITE_RE.test(result) && iterations < MAX_ITERATIONS) {
    result = rewriteOneJsonArray(result);
    iterations++;
  }
  return result;
}
