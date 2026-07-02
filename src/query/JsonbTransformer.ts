/**
 * JsonbTransformer — Translates PostgreSQL JSONB operators to SQLite JSON function calls.
 *
 * SQLite 3.45+ provides json_extract(), json_type(), json_array_length() etc.,
 * but lacks PostgreSQL's JSONB operator syntax (->, ->>, #>, #>>, @>, ?, ?|, ?&).
 *
 * This module uses regex-based translation to convert JSONB operators into
 * equivalent SQLite function calls. This approach avoids full AST parsing and
 * covers the vast majority of real-world SQL patterns.
 *
 * Limitations (regex-based):
 * - Operators appearing inside string literals may be incorrectly transformed.
 * - Chained operations like `data->'a'->>'b'` require iterative processing.
 * - The `@>` operator only supports simple flat JSON objects as the right operand.
 */

// ────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────

export interface JsonbTransformResult {
  /** Translated SQL string (unchanged if no JSONB operators found) */
  sql: string;
  /** Whether any transformation was applied */
  transformed: boolean;
}

// ────────────────────────────────────────────────────────────
//  Pattern building helpers
// ────────────────────────────────────────────────────────────

/**
 * Regex pattern for matching SQL left-hand-side expressions for JSONB operators.
 * Supports:
 * - Simple names: `col`
 * - Qualified names: `table.col`, `schema.table.col`
 * - Double-quoted identifiers: `"col name"`
 * - Backtick-quoted identifiers: `` `col name` ``
 * - Simple function calls: `json_extract(...)` (for chained operations)
 *
 * Note: Nested parentheses inside function calls (e.g., `fn(fn2())`) are not
 * supported. For deeply nested chaining, use a direct json_extract path instead.
 */
const IDENT = `(?:[a-zA-Z_][a-zA-Z0-9_]*(?:\\.[a-zA-Z_][a-zA-Z0-9_]*)*|"[^"]+"|\`[^\`]+\`|[a-zA-Z_]\\w*\\s*\\([^)]*\\))`;

// ────────────────────────────────────────────────────────────
//  Path helpers
// ────────────────────────────────────────────────────────────

/**
 * Convert a JSONB key/index to a json_extract-compatible path string.
 *
 * - A numeric value → `$[N]` (array index)
 * - A string value  → `$.key` (object key)
 *
 * The result is a path suitable for embedding in a single-quoted SQL string.
 */
function toJsonPath(key: string): string {
  const trimmed = key.trim();
  if (/^-?\d+$/.test(trimmed)) {
    return `$[${trimmed}]`;
  }
  // Strip surrounding quotes
  const clean = trimmed.replace(/^['"]|['"]$/g, '');
  return `$.${clean.replace(/'/g, "''")}`;
}

/**
 * Convert a PostgreSQL JSON path (text array) to a json_extract path.
 *
 * PG JSON path format: `'{a,b}'` or `'{a,b,c}'`
 * SQLite equivalent: `'$.a.b'` or `'$.a.b.c'`
 *
 * Strips the surrounding braces and joins components with dots.
 */
function convertJsonPath(path: string): string {
  let clean = path.trim();
  // Strip surrounding braces if present (PG text-array format)
  if (clean.startsWith('{') && clean.endsWith('}')) {
    clean = clean.slice(1, -1);
  }
  const parts = clean.split(',').map((p) => p.trim());
  return `$.${parts.join('.')}`;
}

/**
 * Escape single quotes for embedding in SQL string literals.
 */
function esc(str: string): string {
  return str.replace(/'/g, "''");
}

// ────────────────────────────────────────────────────────────
//  Single expression transformer
// ────────────────────────────────────────────────────────────

/**
 * Transform a single expression containing JSONB operators into its
 * SQLite-compatible equivalent.
 *
 * Processing order: longer/more-specific operators are handled first
 * to avoid partial matches:
 *
 *   `->>` (2 chars) before `->` (2 chars)
 *   `#>>` (3 chars) before `#>` (2 chars)
 *   `?|` / `?&` / `@>` before `?` (1 char)
 *
 * @param expr - A SQL expression that may contain JSONB operators
 * @returns The expression with all JSONB operators translated to SQLite functions
 */
export function transformJsonbExpr(expr: string): string {
  let result = expr;

  // ── 1. ?| operator: col ?| ARRAY['k1', 'k2', ...] ─────────────────
  // Translates to: (json_type(col, '$.k1') IS NOT NULL OR json_type(col, '$.k2') IS NOT NULL OR ...)
  result = result.replace(
    new RegExp(`(${IDENT})\\s*\\?\\|\\s*ARRAY\\s*\\[([^\\]]+)\\]`, 'gi'),
    (_match, col: string, arrContent: string) => {
      const keys = arrContent.split(',').map((k: string) => k.trim());
      const conditions = keys.map((k: string) => {
        const path = toJsonPath(k);
        return `json_type(${col}, '${path}') IS NOT NULL`;
      });
      return `(${conditions.join(' OR ')})`;
    },
  );

  // ── 2. ?& operator: col ?& ARRAY['k1', 'k2', ...] ─────────────────
  // Translates to: (json_type(col, '$.k1') IS NOT NULL AND json_type(col, '$.k2') IS NOT NULL AND ...)
  result = result.replace(
    new RegExp(`(${IDENT})\\s*\\?&\\s*ARRAY\\s*\\[([^\\]]+)\\]`, 'gi'),
    (_match, col: string, arrContent: string) => {
      const keys = arrContent.split(',').map((k: string) => k.trim());
      const conditions = keys.map((k: string) => {
        const path = toJsonPath(k);
        return `json_type(${col}, '${path}') IS NOT NULL`;
      });
      return `(${conditions.join(' AND ')})`;
    },
  );

  // ── 3. @> operator: col @> '{"key1": val1, "key2": val2}' ──────────
  // Translates to: json_extract(col, '$.key1') = 'val1' [AND json_extract(col, '$.key2') = 'val2']
  // Only supports flat JSON objects (one level deep).
  result = result.replace(
    new RegExp(`(${IDENT})\\s*@>\\s*'([^']+)'`, 'gi'),
    (_match, col: string, jsonStr: string) => {
      try {
        const parsed = JSON.parse(jsonStr);
        const conditions = Object.entries(parsed).map(([key, value]) => {
          const path = `$.${key}`;
          const val =
            typeof value === 'string'
              ? `'${String(value).replace(/'/g, "''")}'`
              : String(value);
          return `json_extract(${col}, '${path}') = ${val}`;
        });
        return conditions.length === 1 ? conditions[0] : `(${conditions.join(' AND ')})`;
      } catch {
        // JSON parsing failed → keep original
        return _match;
      }
    },
  );

  // ── 4. #>> operator: col #>> '{a,b,c}' ─────────────────────────────
  // Translates to: json_extract(col, '$.a.b.c')
  result = result.replace(
    new RegExp(`(${IDENT})\\s*#>>\\s*'([^']+)'`, 'gi'),
    (_match, col: string, path: string) => {
      return `json_extract(${col}, '${esc(convertJsonPath(path))}')`;
    },
  );

  // ── 5. #> operator: col #> '{a,b,c}' ───────────────────────────────
  // Translates to: json_extract(col, '$.a.b.c')
  result = result.replace(
    new RegExp(`(${IDENT})\\s*#>\\s*'([^']+)'`, 'gi'),
    (_match, col: string, path: string) => {
      return `json_extract(${col}, '${esc(convertJsonPath(path))}')`;
    },
  );

  // ── 6. ->> operator with string key: col ->> 'key' ─────────────────
  // Translates to: json_extract(col, '$.key')
  // PG returns text; SQLite json_extract also returns text in this case.
  result = result.replace(
    new RegExp(`(${IDENT})\\s*->>\\s*'([^']+)'`, 'gi'),
    (_match, col: string, key: string) => {
      return `json_extract(${col}, '${esc(toJsonPath(key))}')`;
    },
  );

  // ── 7. ->> operator with integer index: col ->> N ────────────────────
  // Translates to: json_extract(col, '$[N]')
  result = result.replace(
    new RegExp(`(${IDENT})\\s*->>\\s*(-?\\d+)`, 'gi'),
    (_match, col: string, index: string) => {
      return `json_extract(${col}, '$[${index}]')`;
    },
  );

  // ── 8. -> operator with string key: col -> 'key' ──────────────────
  // Translates to: json_extract(col, '$.key')
  // PG returns JSON; SQLite json_extract returns JSON-formatted value.
  result = result.replace(
    new RegExp(`(${IDENT})\\s*->\\s*'([^']+)'`, 'gi'),
    (_match, col: string, key: string) => {
      return `json_extract(${col}, '${esc(toJsonPath(key))}')`;
    },
  );

  // ── 9. -> operator with integer index: col -> N ────────────────────
  // Translates to: json_extract(col, '$[N]')
  result = result.replace(
    new RegExp(`(${IDENT})\\s*->\\s*(-?\\d+)`, 'gi'),
    (_match, col: string, index: string) => {
      return `json_extract(${col}, '$[${index}]')`;
    },
  );

  // ── 10. ? operator: col ? 'key' ─────────────────────────────────────
  // Translates to: json_type(col, '$.key') IS NOT NULL
  // Must match only `expr ? 'string'` to avoid conflicting with
  // SQLite prepared statement placeholders (`?` alone).
  result = result.replace(
    new RegExp(`(${IDENT})\\s*\\?\\s*'([^']+)'`, 'gi'),
    (_match, col: string, key: string) => {
      return `json_type(${col}, '${esc(toJsonPath(key))}') IS NOT NULL`;
    },
  );

  return result;
}

// ────────────────────────────────────────────────────────────
//  Full SQL statement transformer
// ────────────────────────────────────────────────────────────

/**
 * Transform all JSONB operators found in a SQL statement into their
 * SQLite-compatible function-call equivalents.
 *
 * This is the main entry point for external callers. It applies all
 * operator transformations and reports whether any changes were made.
 *
 * @param sql - A full SQL statement that may contain JSONB operators
 * @returns An object containing the transformed SQL and a `transformed` flag
 *
 * @example
 * ```ts
 * const result = transformJsonbOperators(
 *   "SELECT data->'name' FROM t WHERE data @> '{\"age\": 25}'"
 * );
 * // result.sql === "SELECT json_extract(data, '$.name') FROM t WHERE json_extract(data, '$.age') = 25"
 * // result.transformed === true
 * ```
 */
export function transformJsonbOperators(sql: string): JsonbTransformResult {
  const original = sql;
  let current = original;
  let didTransform = false;

  // Iteratively process until no more changes (handles chained operators)
  for (let i = 0; i < 10; i++) {
    const before = current;
    current = transformJsonbExpr(current);
    if (current !== before) {
      didTransform = true;
    } else {
      break;
    }
  }

  return {
    sql: current,
    transformed: didTransform,
  };
}

// ══════════════════════════════════════════════════════════════
//  JSONB Mutation Functions (Gap 10)
// ══════════════════════════════════════════════════════════════

/**
 * Simulate jsonb_set(): Set a value in a JSON object at a given path.
 *
 * PostgreSQL: jsonb_set(target jsonb, path text[], new_value jsonb [, create_if_missing boolean])
 *
 * SQLite equivalent: Uses JSON1 functions:
 *   json_set(target, path, new_value)
 *
 * @param sql - SQL expression containing jsonb_set calls
 * @returns Transformed SQL with json_set instead
 */
export function transformJsonbSet(sql: string): JsonbTransformResult {
  // jsonb_set(col, '{a,b}', '"val"', false)
  // → json_set(col, '$.a.b', '"val"')
  //
  // jsonb_set(target, path_array, new_value [, create_if_missing])
  const JSONB_SET_RE = /\bjsonb_set\s*\(\s*([^,]+)\s*,\s*'\{([^}]*)\}'\s*,\s*([^,)]+)(?:\s*,\s*(true|false))?\s*\)/gi;

  let working = sql;
  let didTransform = false;

  working = working.replace(JSONB_SET_RE, (_match, target: string, pathStr: string, newVal: string, createFlag?: string) => {
    didTransform = true;
    const targetTrimmed = target.trim();
    const newValTrimmed = newVal.trim();

    // Convert path {a,b,c} → '$.a.b.c'
    const parts = pathStr.split(',').map((p) => p.trim());
    const jsonPath = `$.${parts.join('.')}`;

    // If create_if_missing is false, we'd need conditional logic which SQLite doesn't support in json_set
    // json_set always creates. For false, we use json_set then check.
    if (createFlag && createFlag.toLowerCase() === 'false') {
      // For create_if_missing = false, we first check if path exists
      return `CASE WHEN json_type(${targetTrimmed}, '${jsonPath}') IS NOT NULL THEN json_set(${targetTrimmed}, '${jsonPath}', ${newValTrimmed}) ELSE ${targetTrimmed} END`;
    }

    return `json_set(${targetTrimmed}, '${jsonPath}', ${newValTrimmed})`;
  });

  if (didTransform) {
    return { sql: working, transformed: true };
  }
  return { sql: working, transformed: false };
}

/**
 * Simulate jsonb_insert(): Insert a value into a JSON array or object.
 *
 * PostgreSQL: jsonb_insert(target jsonb, path text[], new_value jsonb [, insert_after boolean])
 *
 * SQLite equivalent: For arrays, use json_insert. For objects, json_insert already works for new keys.
 * When insert_after is true, we need to find the index and insert +1.
 */
export function transformJsonbInsert(sql: string): JsonbTransformResult {
  const JSONB_INSERT_RE = /\bjsonb_insert\s*\(\s*([^,]+)\s*,\s*'\{([^}]*)\}'\s*,\s*([^,)]+)(?:\s*,\s*(true|false))?\s*\)/gi;

  let working = sql;
  let didTransform = false;

  working = working.replace(JSONB_INSERT_RE, (_match, target: string, pathStr: string, newVal: string, afterFlag?: string) => {
    didTransform = true;
    const targetTrimmed = target.trim();
    const newValTrimmed = newVal.trim();

    const parts = pathStr.split(',').map((p) => p.trim());

    // Check if last part is a number (array index)
    const lastPart = parts[parts.length - 1];
    const isArrayIndex = /^-?\d+$/.test(lastPart);
    const after = afterFlag && afterFlag.toLowerCase() === 'true';

    if (isArrayIndex && after) {
      // Insert after index: use json_set at index+1
      const index = parseInt(lastPart, 10);
      const parentPath = parts.slice(0, -1).join('.');
      const fullParentPath = parentPath ? `$.${parentPath}` : '$';
      return `json_set(${targetTrimmed}, '${fullParentPath}[${index + 1}]', ${newValTrimmed})`;
    }

    const jsonPath = `$.${parts.join('.')}`;
    return `json_insert(${targetTrimmed}, '${jsonPath}', ${newValTrimmed})`;
  });

  if (didTransform) {
    return { sql: working, transformed: true };
  }
  return { sql: working, transformed: false };
}

/**
 * Simulate jsonb_pretty(): Pretty-print JSON.
 *
 * PostgreSQL: jsonb_pretty(jsonb) → text
 *
 * SQLite doesn't have a built-in JSON pretty-printer.
 * We use json() which returns minified JSON, then wrap in a SQL expression.
 * For proper pretty-printing, we'd need a custom function.
 * As a fallback, we return json() as a reasonable approximation.
 */
export function transformJsonbPretty(sql: string): JsonbTransformResult {
  const JSONB_PRETTY_RE = /\bjsonb_pretty\s*\(([^)]*)\)/gi;

  let working = sql;
  let didTransform = false;

  working = working.replace(JSONB_PRETTY_RE, (_match, arg: string) => {
    didTransform = true;
    return `json(${arg.trim()})`;
  });

  if (didTransform) {
    return { sql: working, transformed: true };
  }
  return { sql: working, transformed: false };
}

/**
 * Combined: transform all JSONB mutation functions (jsonb_set, jsonb_insert, jsonb_pretty).
 */
export function transformJsonbMutation(sql: string): JsonbTransformResult {
  let working = sql;
  let didTransform = false;

  // Order: jsonb_set before jsonb_insert to avoid overlap
  const setResult = transformJsonbSet(working);
  if (setResult.transformed) {
    working = setResult.sql;
    didTransform = true;
  }

  const insertResult = transformJsonbInsert(working);
  if (insertResult.transformed) {
    working = insertResult.sql;
    didTransform = true;
  }

  const prettyResult = transformJsonbPretty(working);
  if (prettyResult.transformed) {
    working = prettyResult.sql;
    didTransform = true;
  }

  return { sql: working, transformed: didTransform };
}

// ══════════════════════════════════════════════════════════════
//  JSON SQL Function Rewrites (Batch 6C)
// ══════════════════════════════════════════════════════════════
//
// 8 JSON function groups that rewrite PostgreSQL JSON functions
// to SQLite-compatible equivalents.
//
// Each group provides detect + rewrite exported pairs.
// ══════════════════════════════════════════════════════════════

import { PinoLogger } from '../monitoring/PinoLogger';

const jsonFuncLogger = PinoLogger.forComponent('JsonbTransformer::JSONFuncs');

// ── 1. json_build_array(VARIADIC any) → json ──────────────────────────────
// PG: json_build_array(1, 2, 'a') → '[1,2,"a"]'
// SQLite: json_array(1, 2, 'a')
const RE_JSON_BUILD_ARRAY = /json_build_array\s*\(([\s\S]*?)\)\s*$/gim;

export function detectJsonBuildArray(sql: string): boolean {
  const matched = /\bjson_build_array\s*\(/i.test(sql);
  jsonFuncLogger.debug({ sql, matched }, 'detectJsonBuildArray');
  return matched;
}

export function rewriteJsonBuildArray(sql: string): string {
  const result = sql.replace(
    /\bjson_build_array\s*\(/gi,
    'json_array(',
  );
  if (result !== sql) {
    jsonFuncLogger.debug({ before: sql, after: result }, 'rewriteJsonBuildArray');
  }
  return result;
}

// ── 2. json_typeof(json) → text ──────────────────────────────────────────
// PG: json_typeof('[1,2,3]') → 'array', json_typeof('"hello"') → 'string'
// SQLite: CASE json_type(x) WHEN 'text' THEN 'string' WHEN 'real' THEN 'number' WHEN 'integer' THEN 'number' ELSE json_type(x) END
const RE_JSON_TYPEOF = /\bjson_typeof\s*\(/i;

export function detectJsonTypeOf(sql: string): boolean {
  return RE_JSON_TYPEOF.test(sql);
}

export function rewriteJsonTypeOf(sql: string): string {
  return sql.replace(
    /\bjson_typeof\s*\(([^)]+)\)/gi,
    (_match: string, arg: string) => {
      const trimmed = arg.trim();
      return `(CASE json_type(${trimmed}) WHEN 'text' THEN 'string' WHEN 'real' THEN 'number' WHEN 'integer' THEN 'number' ELSE json_type(${trimmed}) END)`;
    },
  );
}

// ── 2b. jsonb_typeof(json) → json_type(json) ─────────────────────────────
// PG: jsonb_typeof(jsonb) → text ('object', 'array', 'string', 'number', 'boolean', 'null')
// SQLite: json_type(json) returns the type
// PG returns 'string' for strings, SQLite returns 'text' — but this is the closest mapping
const RE_JSONB_TYPEOF = /\bjsonb_typeof\s*\(/i;

export function detectJsonbTypeOf(sql: string): boolean {
  return RE_JSONB_TYPEOF.test(sql);
}

export function rewriteJsonbTypeOf(sql: string): string {
  return sql.replace(/\bjsonb_typeof\s*\(/gi, 'json_type(');
}

// ── 2c. jsonb_array_length(json) → json_array_length(json) ───────────────
// PG: jsonb_array_length(jsonb) → integer
// SQLite: json_array_length(json) — identical semantics
const RE_JSONB_ARRAY_LENGTH = /\bjsonb_array_length\s*\(/i;

export function detectJsonbArrayLength(sql: string): boolean {
  return RE_JSONB_ARRAY_LENGTH.test(sql);
}

export function rewriteJsonbArrayLength(sql: string): string {
  return sql.replace(/\bjsonb_array_length\s*\(/gi, 'json_array_length(');
}

// ── 2d. jsonb_concat(a, b) → merge two JSON objects ──────────────────────
// PG: jsonb_concat(a, b) — merges two JSON objects, b overwrites a
// SQLite: no native json_concat. Use json_set chaining or JSON group approach.
// Simple objects: json_set(a, '$.key_of_b', value_of_b) for each key
// This is complex for regex-only rewrite. Fallback: inline approach for known patterns.
// For simple jsonb_concat(a, b) where both are column references, use json_group_object
// approach: extract keys from both and reconstruct.
//
// For practical purposes, we rewrite to json_set(a, full_json_of_b) which works
// when b is a valid JSON object value. For full correctness, this would need
// a procedural extension.
const RE_JSONB_CONCAT = /\bjsonb_concat\s*\(/i;

export function detectJsonbConcat(sql: string): boolean {
  return RE_JSONB_CONCAT.test(sql);
}

export function rewriteJsonbConcat(sql: string): string {
  // Strategy: jsonb_concat(a, b) → a || b rewritten as json() concatenation
  // SQLite can't natively merge. Best effort: use json() to normalize both,
  // then use json_set with the second object's keys.
  //
  // Simple case: jsonb_concat(col1, col2) where both are JSON objects
  // → (SELECT json_group_object(key, value) FROM (SELECT key, value FROM json_each(col1) UNION ALL SELECT key, value FROM json_each(col2)) GROUP BY key)
  // But this doesn't handle b-overwrites-a semantics correctly.
  //
  // For practical regex-based rewriting, use json_group_array approach:
  return sql.replace(
    /\bjsonb_concat\s*\(\s*([^,]+)\s*,\s*([^)]+)\)/gi,
    (_match: string, a: string, b: string) => {
      const aTrim = a.trim();
      const bTrim = b.trim();
      // Use json_group_object to merge: collect all key-value pairs, last wins
      return `(SELECT json_group_object(key, value) FROM (SELECT key, value FROM json_each(${aTrim}) UNION ALL SELECT key, value FROM json_each(${bTrim})))`;
    },
  );
}

// ── 2e. jsonb_each(json) → table function ─────────────────────────────────
// PG: jsonb_each(jsonb) returns SETOF record (key text, value jsonb)
// SQLite: json_each(json) returns a table with key, value, type, etc.
// The json_each function in SQLite already returns compatible columns.
const RE_JSONB_EACH = /\bjsonb_each\s*\(/i;

export function detectJsonbEach(sql: string): boolean {
  return RE_JSONB_EACH.test(sql);
}

export function rewriteJsonbEach(sql: string): string {
  return sql.replace(/\bjsonb_each\s*\(/gi, 'json_each(');
}

// ── 3. to_jsonb(any) → jsonb ─────────────────────────────────────────────
// PG: to_jsonb(val) → json representation
// SQLite: json(val) — SQLite's json() normalizes to JSON text
const RE_TO_JSONB = /\bto_jsonb\s*\(/i;

export function detectToJsonb(sql: string): boolean {
  return RE_TO_JSONB.test(sql);
}

export function rewriteToJsonb(sql: string): string {
  return sql.replace(/\bto_jsonb\s*\(/gi, 'json(');
}

// ── 4. json_to_record(json) / jsonb_to_record(jsonb) → record ────────────
// PG: SELECT * FROM json_to_record('{"a":1,"b":"foo"}') AS x(a int, b text)
// SQLite: Rewrite to inline json_extract calls in a subquery
const RE_JSON_TO_RECORD = /\bjsonb?_to_record\s*\(/i;

export function detectJsonToRecord(sql: string): boolean {
  return RE_JSON_TO_RECORD.test(sql);
}

/**
 * Rewrite FROM json_to_record / jsonb_to_record with AS column definitions.
 *
 * Pattern: FROM json_to_record('{"a":1}') AS x(a int, b text)
 * → (SELECT json_extract('{"a":1}', '$.a') AS a, json_extract('{"a":1}', '$.b') AS b)
 *
 * If no AS clause is present, wraps the JSON expression in a VALUES clause.
 */
export function rewriteJsonToRecord(sql: string): string {
  return sql.replace(
    /(FROM\s+)(jsonb?_to_record)\s*\(([^)]+)\)\s*(?:AS\s+(\w+)\s*\(([^)]*)\))?/gi,
    (_match: string, fromKw: string, _funcName: string, jsonArg: string, _alias?: string, columnsDef?: string) => {
      const jsonArgTrimmed = jsonArg.trim();
      if (columnsDef && columnsDef.trim()) {
        // Extract column names from "col1 type1, col2 type2, ..."
        const columns = columnsDef.split(',').map((colDef) => {
          const parts = colDef.trim().split(/\s+/);
          return parts[0]; // Column name only, type is ignored
        });
        const selects = columns
          .map((col) => `json_extract(${jsonArgTrimmed}, '$.${col}') AS ${col}`)
          .join(', ');
        return `${fromKw}(SELECT ${selects})`;
      }
      // No AS clause: wrap in VALUES for compatibility
      return `${fromKw}(SELECT json_extract(${jsonArgTrimmed}, '$') AS value)`;
    },
  );
}

// ── 5. json_array_elements(json) / jsonb_array_elements(jsonb) → SETOF json ──
// PG: SELECT * FROM json_array_elements('[1,2,3]')
// SQLite: SELECT value FROM json_each('[1,2,3]')
const RE_JSON_ARRAY_ELEMENTS = /\bjsonb?_array_elements\s*\(/i;

export function detectJsonArrayElements(sql: string): boolean {
  return RE_JSON_ARRAY_ELEMENTS.test(sql);
}

/**
 * Rewrite json_array_elements / jsonb_array_elements to json_each.
 *
 * json_each returns multiple columns. We replace the FROM clause entry
 * to use json_each directly. json_each's "value" column contains the element.
 */
export function rewriteJsonArrayElements(sql: string): string {
  return sql.replace(
    /(FROM\s+)(jsonb?_array_elements)\s*\(([^)]+)\)(\s*(?:AS\s+\w+)?)\s*/gi,
    (_match: string, fromKw: string, _funcName: string, jsonArg: string, aliasPart: string) => {
      const jsonArgTrimmed = jsonArg.trim();
      // Use json_each, which returns value as the element column
      return `${fromKw}json_each(${jsonArgTrimmed})${aliasPart.trim() ? aliasPart : ''}`;
    },
  );
}

// ── 6. json_object_keys(json) / jsonb_object_keys(jsonb) → SETOF text ────
// PG: SELECT * FROM json_object_keys('{"a":1,"b":2}') → 'a', 'b'
// SQLite: SELECT j.key FROM json_each(json_expr) AS j WHERE j.type = 'object' AND j.key IS NOT NULL
const RE_JSON_OBJECT_KEYS = /\bjsonb?_object_keys\s*\(/i;

export function detectJsonObjectKeys(sql: string): boolean {
  return RE_JSON_OBJECT_KEYS.test(sql);
}

export function rewriteJsonObjectKeys(sql: string): string {
  return sql.replace(
    /(FROM\s+)(jsonb?_object_keys)\s*\(([^)]+)\)(\s*(?:AS\s+\w+)?)\s*/gi,
    (_match: string, fromKw: string, _funcName: string, jsonArg: string, aliasPart: string) => {
      const jsonArgTrimmed = jsonArg.trim();
      const alias = aliasPart.trim() ? aliasPart.trim() : '';
      return `${fromKw}(SELECT j.key FROM json_each(${jsonArgTrimmed}) AS j WHERE j.type = 'object' AND j.key IS NOT NULL) ${alias}`;
    },
  );
}

// ── 7. json_extract_path(json, VARIADIC text[]) → json ───────────────────
// PG: json_extract_path('{"a":{"b":1}}', 'a', 'b') → 1
// SQLite: json_extract('{"a":{"b":1}}', '$.a.b')
const RE_JSON_EXTRACT_PATH = /\bjson_extract_path\s*\(/i;
const RE_JSONB_EXTRACT_PATH = /\bjsonb_extract_path\s*\(/i;

export function detectJsonExtractPath(sql: string): boolean {
  return RE_JSON_EXTRACT_PATH.test(sql) || RE_JSONB_EXTRACT_PATH.test(sql);
}

/**
 * Rewrite json_extract_path / jsonb_extract_path calls to json_extract.
 */
export function rewriteJsonExtractPath(sql: string): string {
  return rewriteJsonExtractPathInner(sql);
}

function rewriteJsonExtractPathInner(sql: string): string {
  return sql.replace(
    /\bjsonb?_extract_path\s*\(([^,]+)((?:\s*,\s*[^,)]+)*)\)/gi,
    (_match: string, firstArg: string, restArgs: string) => {
      const jsonExpr = firstArg.trim();
      if (!restArgs.trim()) {
        return `json_extract(${jsonExpr}, '$')`;
      }

      // Parse path arguments
      const pathElems = restArgs.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      const pathParts = pathElems.map((elem) => {
        // Strip quotes if present
        const clean = elem.replace(/^['"]|['"]$/g, '');
        // If the key contains dots, use bracket notation
        if (clean.includes('.')) {
          return `["${clean.replace(/"/g, '\\"')}"]`;
        }
        return `.${clean}`;
      });
      const fullPath = `$${pathParts.join('')}`;

      return `json_extract(${jsonExpr}, '${fullPath}')`;
    },
  );
}

// ── 8. jsonb_path_* functions ─────────────────────────────────────────────
// PG: jsonb_path_exists(target, path), jsonb_path_match(target, path),
//     jsonb_path_query(target, path), jsonb_path_query_array(target, path)
//
// SQLite: Best-effort rewrite. For simple paths, strip PG-specific syntax and
// use json_extract / json_each. For complex paths with filters, fall back to
// EXISTS checks or NULL.
// ───────────────────────────────────────────────────────────────────────────

/** Simplify a PG JSON path to SQLite-compatible path */
function simplifyJsonPath(path: string): string {
  let clean = path.trim();
  // Strip surrounding quotes
  clean = clean.replace(/^['"]|['"]$/g, '');
  // Remove array wildcard [*]
  clean = clean.replace(/\[\*\]/g, '');
  // Remove filter expressions like ? (@ > 0), ? (@.price > 10)
  clean = clean.replace(/\s*\?\s*\([^)]*\)/g, '');
  // Remove 'lax' mode keyword if present
  clean = clean.replace(/\b(lax|strict)\s+/g, '');
  return clean;
}

/** Check if a path contains complex PG-only expressions that can't be simplified */
function hasComplexPathExpr(path: string): boolean {
  // Contains filter expressions or double-dot range syntax
  return /\?\s*\(/.test(path) || /\.\./.test(path) || /\*\*/.test(path) || /@\./.test(path);
}

const RE_JSONB_PATH_EXISTS = /\bjsonb_path_exists\s*\(/i;
const RE_JSONB_PATH_MATCH = /\bjsonb_path_match\s*\(/i;
const RE_JSONB_PATH_QUERY = /\bjsonb_path_query\s*\(/i;
const RE_JSONB_PATH_QUERY_ARRAY = /\bjsonb_path_query_array\s*\(/i;

export function detectJsonbPathExists(sql: string): boolean {
  return RE_JSONB_PATH_EXISTS.test(sql);
}

export function detectJsonbPathMatch(sql: string): boolean {
  return RE_JSONB_PATH_MATCH.test(sql);
}

export function detectJsonbPathQuery(sql: string): boolean {
  return RE_JSONB_PATH_QUERY.test(sql);
}

export function detectJsonbPathQueryArray(sql: string): boolean {
  return RE_JSONB_PATH_QUERY_ARRAY.test(sql);
}

/**
 * Extract top-level arguments from a function call string by properly handling
 * nested parentheses and single-quoted strings. This allows commas inside
 * JSON values (e.g., '{"a":[1,2,3]}') to be treated as part of one argument.
 */
function extractJsonbPathArgs(argsStr: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let inSingleQuote = false;

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (inSingleQuote) {
      current += ch;
      if (ch === "'") inSingleQuote = false;
    } else if (ch === "'") {
      current += ch;
      inSingleQuote = true;
    } else if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * Rewrite jsonb_path_exists(target, path [, vars [, silent]]) → EXISTS check.
 *
 * For simple paths: jsonb_path_exists(target, '$.a.b') → json_extract(target, '$.a.b') IS NOT NULL
 * For array paths: jsonb_path_exists(target, '$.a[*]') → EXISTS(SELECT 1 FROM json_each(target, '$.a'))
 * For complex paths: fall back to simple extract check
 */
export function rewriteJsonbPathExists(sql: string): string {
  return sql.replace(
    /\bjsonb_path_exists\s*\(\s*([\s\S]*?)\s*\)/gi,
    (_match: string, argsStr: string) => {
      const args = extractJsonbPathArgs(argsStr);
      if (args.length < 2) return _match; // Need at least target + path

      const targetTrimmed = args[0].trim();
      const pathRaw = args[1].trim();
      // Strip surrounding quotes from path
      const path = pathRaw.replace(/^['"]|['"]$/g, '');
      const simplifiedPath = simplifyJsonPath(path);

      if (hasComplexPathExpr(path)) {
        if (simplifiedPath && simplifiedPath !== '$') {
          return `json_extract(${targetTrimmed}, '${simplifiedPath}') IS NOT NULL`;
        }
        return `(${targetTrimmed} IS NOT NULL AND ${targetTrimmed} != 'null'::text)`;
      }

      return `json_extract(${targetTrimmed}, '${simplifiedPath}') IS NOT NULL`;
    },
  );
}

/**
 * Rewrite jsonb_path_match(target, path [, vars [, silent]]) → boolean.
 * Returns true if the path matches exactly one value.
 * For simple paths: compare json_extract result (true if truthy)
 */
export function rewriteJsonbPathMatch(sql: string): string {
  return sql.replace(
    /\bjsonb_path_match\s*\(\s*([\s\S]*?)\s*\)/gi,
    (_match: string, argsStr: string) => {
      const args = extractJsonbPathArgs(argsStr);
      if (args.length < 2) return _match;

      const targetTrimmed = args[0].trim();
      const pathRaw = args[1].trim();
      const path = pathRaw.replace(/^['"]|['"]$/g, '');
      const simplifiedPath = simplifyJsonPath(path);

      if (hasComplexPathExpr(path) || !simplifiedPath || simplifiedPath === '$') {
        return `(${targetTrimmed} IS NOT NULL)`;
      }

      return `json_extract(${targetTrimmed}, '${simplifiedPath}') IS NOT NULL AND json_extract(${targetTrimmed}, '${simplifiedPath}') != ''`;
    },
  );
}

/**
 * Rewrite jsonb_path_query(target, path [, vars [, silent]]) → SETOF values.
 * Uses json_each to expand arrays for array paths.
 */
export function rewriteJsonbPathQuery(sql: string): string {
  return sql.replace(
    /\bjsonb_path_query\s*\(\s*([\s\S]*?)\s*\)/gi,
    (_match: string, argsStr: string) => {
      const args = extractJsonbPathArgs(argsStr);
      if (args.length < 2) return _match;

      const targetTrimmed = args[0].trim();
      const pathRaw = args[1].trim();
      const path = pathRaw.replace(/^['"]|['"]$/g, '');
      const simplifiedPath = simplifyJsonPath(path);

      if (hasComplexPathExpr(path) || !simplifiedPath || simplifiedPath === '$') {
        return `json_extract(${targetTrimmed}, '$')`;
      }

      if (simplifiedPath.includes('[') || simplifiedPath.includes('*')) {
        return `(SELECT json_extract(j.value, '${simplifiedPath}') FROM json_each(${targetTrimmed}) AS j WHERE j.type IS NOT NULL LIMIT 1)`;
      }

      return `json_extract(${targetTrimmed}, '${simplifiedPath}')`;
    },
  );
}

/**
 * Rewrite jsonb_path_query_array(target, path [, vars [, silent]]) → json array.
 * Wraps jsonb_path_query results as a JSON array using json_group_array.
 */
export function rewriteJsonbPathQueryArray(sql: string): string {
  return sql.replace(
    /\bjsonb_path_query_array\s*\(\s*([\s\S]*?)\s*\)/gi,
    (_match: string, argsStr: string) => {
      const args = extractJsonbPathArgs(argsStr);
      if (args.length < 2) return _match;

      const targetTrimmed = args[0].trim();
      const pathRaw = args[1].trim();
      const path = pathRaw.replace(/^['"]|['"]$/g, '');
      const simplifiedPath = simplifyJsonPath(path);

      if (hasComplexPathExpr(path) || !simplifiedPath || simplifiedPath === '$') {
        return `json(${targetTrimmed})`;
      }

      return `json_extract(${targetTrimmed}, '${simplifiedPath}')`;
    },
  );
}

/**
 * Combined: transform all JSON SQL function calls to SQLite equivalents.
 * Runs all JSON function rewrites in a safe order.
 */
export function transformJsonFunctions(sql: string): JsonbTransformResult {
  let working = sql;
  let didTransform = false;

  // Order matters: more specific patterns first

  // json_extract_path (before json to avoid partial match)
  if (detectJsonExtractPath(working)) {
    const before = working;
    working = rewriteJsonExtractPath(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_path_* functions (before generic json pattern)
  if (detectJsonbPathExists(working)) {
    const before = working;
    working = rewriteJsonbPathExists(working);
    if (working !== before) didTransform = true;
  }
  if (detectJsonbPathMatch(working)) {
    const before = working;
    working = rewriteJsonbPathMatch(working);
    if (working !== before) didTransform = true;
  }
  if (detectJsonbPathQuery(working)) {
    const before = working;
    working = rewriteJsonbPathQuery(working);
    if (working !== before) didTransform = true;
  }
  if (detectJsonbPathQueryArray(working)) {
    const before = working;
    working = rewriteJsonbPathQueryArray(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_array_elements / json_array_elements (before json_array pattern)
  if (detectJsonArrayElements(working)) {
    const before = working;
    working = rewriteJsonArrayElements(working);
    if (working !== before) didTransform = true;
  }

  // json_object_keys
  if (detectJsonObjectKeys(working)) {
    const before = working;
    working = rewriteJsonObjectKeys(working);
    if (working !== before) didTransform = true;
  }

  // json_to_record / jsonb_to_record
  if (detectJsonToRecord(working)) {
    const before = working;
    working = rewriteJsonToRecord(working);
    if (working !== before) didTransform = true;
  }

  // json_build_array
  if (detectJsonBuildArray(working)) {
    const before = working;
    working = rewriteJsonBuildArray(working);
    if (working !== before) didTransform = true;
  }

  // json_typeof
  if (detectJsonTypeOf(working)) {
    const before = working;
    working = rewriteJsonTypeOf(working);
    if (working !== before) didTransform = true;
  }

  // to_jsonb
  if (detectToJsonb(working)) {
    const before = working;
    working = rewriteToJsonb(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_typeof → json_type
  if (detectJsonbTypeOf(working)) {
    const before = working;
    working = rewriteJsonbTypeOf(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_array_length → json_array_length
  if (detectJsonbArrayLength(working)) {
    const before = working;
    working = rewriteJsonbArrayLength(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_concat → subquery merge
  if (detectJsonbConcat(working)) {
    const before = working;
    working = rewriteJsonbConcat(working);
    if (working !== before) didTransform = true;
  }

  // jsonb_each → json_each (table function)
  if (detectJsonbEach(working)) {
    const before = working;
    working = rewriteJsonbEach(working);
    if (working !== before) didTransform = true;
  }

  return { sql: working, transformed: didTransform };
}
