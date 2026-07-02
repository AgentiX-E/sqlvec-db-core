/**
 * HstoreShim — PostgreSQL hstore compatibility shim
 *
 * Provides:
 * 1. JS implementations of PG hstore functions (akeys, avals, each, etc.)
 * 2. SQL text rewriting for the `->` hstore operator
 * 3. SQL text rewriting for `?`, `?|`, `?&` hstore operators
 * 4. PG hstore format ↔ JSON conversion
 *
 * ## Internal storage format
 *
 * hstore data is stored as valid JSON internally:
 *   - PG hstore:  `"key1"=>"value1", "key2"=>"value2"`
 *   - JSON (internal): `{"key1": "value1", "key2": "value2"}`
 *
 * The shim functions auto-detect the input format:
 *   - Strings starting with `{` are treated as JSON
 *   - All others are parsed as PG hstore format
 *
 * ## DDL compatibility
 *
 * When `hstore` appears as a column type in DDL, the SystemTypeRegistry
 * aliases it to `text` via: `'hstore': 'text'`
 *
 * ## Function shims
 *
 * | Function                           | Description                       |
 * |------------------------------------|-----------------------------------|
 * | `hstore_to_json(hstore)`           | Convert hstore to JSON string     |
 * | `akeys(hstore)`                    | Return array of keys              |
 * | `avals(hstore)`                    | Return array of values            |
 * | `each(hstore)`                     | Return array of {key, value}      |
 * | `exist(hstore, key)`               | Check if key exists               |
 * | `defined(hstore, key)`             | Check if key defined and not null |
 * | `delete(hstore, key)`              | Remove key, return modified hstore|
 * | `hstore_concat(a, b)`              | Merge two hstore values           |
 * | `hstore_exists(hs, key)`           | `?` operator: has key             |
 * | `hstore_exists_any(hs, keys)`      | `?|` operator: has any key        |
 * | `hstore_exists_all(hs, keys)`      | `?&` operator: has all keys       |
 * | `populate_record(hs, base)`        | Populate a record from hstore     |
 *
 * ## Operator to function translation
 *
 * | PG operator | Rewritten to                  |
 * |-------------|-------------------------------|
 * | `col->'key'`  | `hstore_get(col, 'key')`      |
 * | `hs ? 'key'`  | `hstore_exists(hs, 'key')`    |
 * | `hs ?| ARRAY['a','b']` | `hstore_exists_any(hs, 'a,b')` |
 * | `hs ?& ARRAY['a','b']` | `hstore_exists_all(hs, 'a,b')` |
 *
 * @module HstoreShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('HstoreShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface HstoreRewriteResult {
  /** Rewritten SQL (original if no hstore operator detected) */
  sql: string;
  /** Whether any hstore operator was detected and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  PG hstore format parser
// ──────────────────────────────────────────────

/**
 * The PG hstore literal format is:
 *   `"key1"=>"value1", "key2"=>"value2"`
 *   or simpler: `key1=>value1, key2=>value2`
 *   NULL values: `"key1"=>NULL`
 *
 * This parser converts PG hstore text to a JS object.
 */
function parsePgHstore(text: string): Record<string, string | null> {
  const result: Record<string, string | null> = {};
  const trimmed = text.trim();

  if (!trimmed || trimmed === '' || trimmed === '""=>""') {
    return result;
  }

  // Parse key=>value pairs
  // Each pair is separated by comma. Keys and values may be double-quoted.
  // We use a simple state machine to handle quoted values containing commas/=>.

  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    // Skip leading whitespace and commas
    while (i < len && (trimmed[i] === ' ' || trimmed[i] === ',')) i++;
    if (i >= len) break;

    // Parse key
    let key: string;
    if (trimmed[i] === '"') {
      i++; // skip opening quote
      const keyStart = i;
      while (i < len && trimmed[i] !== '"') {
        if (trimmed[i] === '\\') i++; // skip escaped char
        i++;
      }
      key = trimmed.slice(keyStart, i);
      if (i < len) i++; // skip closing quote
    } else {
      const keyStart = i;
      while (i < len && trimmed[i] !== '=' && trimmed[i] !== ',' && trimmed[i] !== ' ') i++;
      key = trimmed.slice(keyStart, i).trim();
    }

    // Skip '=>'
    while (i < len && trimmed[i] === ' ') i++;
    if (i < len && trimmed[i] === '=') i++;
    if (i < len && trimmed[i] === '>') i++;
    while (i < len && trimmed[i] === ' ') i++;

    // Parse value
    let value: string | null;
    if (i < len && trimmed[i] === '"') {
      i++; // skip opening quote
      const valStart = i;
      while (i < len && trimmed[i] !== '"') {
        if (trimmed[i] === '\\') i++;
        i++;
      }
      value = trimmed.slice(valStart, i);
      if (i < len) i++; // skip closing quote
    } else if (i < len && trimmed.toUpperCase().startsWith('NULL', i)) {
      value = null;
      i += 4;
    } else {
      const valStart = i;
      while (i < len && trimmed[i] !== ',' && trimmed[i] !== ' ') i++;
      value = trimmed.slice(valStart, i).trim();
      if (value.toUpperCase() === 'NULL') value = null;
    }

    // Store the parsed key-value pair
    result[key] = value;
  }

  return result;
}

/**
 * Detect whether the input is JSON (starts with `{`) or PG hstore format.
 */
function isJsonFormat(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return text.trim().startsWith('{');
}

/**
 * Parse hstore text to a JS object.
 * Auto-detects JSON vs PG hstore format.
 */
export function parseHstoreToObject(text: string | null): Record<string, string | null> {
  if (text === null || text === undefined || text === '') {
    return {};
  }

  if (isJsonFormat(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // Fall through to PG parser
    }
  }

  return parsePgHstore(text);
}

/**
 * Convert a JS object back to JSON hstore string.
 */
export function objectToHstoreJson(obj: Record<string, string | null>): string {
  // Remove any undefined/symbol keys, keep only string keys
  const clean: Record<string, string | null> = {};
  for (const key of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      clean[key] = obj[key] === undefined ? null : obj[key];
    }
  }
  return JSON.stringify(clean);
}

// ──────────────────────────────────────────────
//  Hstore function shims
// ──────────────────────────────────────────────

export class HstoreShim {
  // ── hstore_to_json ──

  /**
   * hstore_to_json(hstore_text) → JSON string
   *
   * Converts hstore to its JSON representation.
   * If the input is already valid JSON, returns it as-is.
   * If in PG hstore format, parses and re-serializes as JSON.
   *
   * @example
   * ```ts
   * hstoreToJson('"a"=>"1"')          // '{"a":"1"}'
   * hstoreToJson('{"a":"1"}')         // '{"a":"1"}'
   * hstoreToJson('"a"=>"1","b"=>"2"') // '{"a":"1","b":"2"}'
   * ```
   */
  static hstoreToJson(hstoreText: string): string {
    const obj = parseHstoreToObject(hstoreText);
    return objectToHstoreJson(obj);
  }

  // ── akeys ──

  /**
   * akeys(hstore_text) → string[]
   *
   * Returns an array of all keys in the hstore.
   *
   * @example
   * ```ts
   * akeys('"a"=>"1","b"=>"2"') // ['a', 'b']
   * akeys('{}')                // []
   * akeys('')                  // []
   * ```
   */
  static akeys(hstoreText: string): string[] {
    const obj = parseHstoreToObject(hstoreText);
    return Object.keys(obj);
  }

  // ── avals ──

  /**
   * avals(hstore_text) → string[]
   *
   * Returns an array of all values in the hstore.
   * NULL values are included as null.
   *
   * @example
   * ```ts
   * avals('"a"=>"1","b"=>"2"') // ['1', '2']
   * avals('"a"=>NULL')         // [null]
   * avals('')                  // []
   * ```
   */
  static avals(hstoreText: string): (string | null)[] {
    const obj = parseHstoreToObject(hstoreText);
    return Object.values(obj);
  }

  // ── each ──

  /**
   * each(hstore_text) → {key: string, value: string}[]
   *
   * Returns an array of key-value pair objects for each entry in the hstore.
   *
   * @example
   * ```ts
   * each('"a"=>"1","b"=>"2"')
   * // [{key: 'a', value: '1'}, {key: 'b', value: '2'}]
   * ```
   */
  static each(hstoreText: string): Array<{ key: string; value: string | null }> {
    const obj = parseHstoreToObject(hstoreText);
    return Object.entries(obj).map(([key, value]) => ({ key, value }));
  }

  // ── exist ──

  /**
   * exist(hstore_text, key) → boolean
   *
   * Checks whether the hstore contains the specified key,
   * regardless of whether the value is NULL.
   *
   * @example
   * ```ts
   * exist('"a"=>"1"', 'a')  // true
   * exist('"a"=>"1"', 'b')  // false
   * exist('"a"=>NULL', 'a') // true (key exists, value is null)
   * ```
   */
  static exist(hstoreText: string, key: string): boolean {
    const obj = parseHstoreToObject(hstoreText);
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  // ── defined ──

  /**
   * defined(hstore_text, key) → boolean
   *
   * Checks whether the hstore contains the specified key
   * AND the value is not NULL.
   *
   * @example
   * ```ts
   * defined('"a"=>"1"', 'a')  // true
   * defined('"a"=>NULL', 'a') // false
   * defined('"a"=>"1"', 'b')  // false
   * ```
   */
  static defined(hstoreText: string, key: string): boolean {
    const obj = parseHstoreToObject(hstoreText);
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return false;
    return obj[key] !== null;
  }

  // ── delete ──

  /**
   * delete(hstore_text, key) → string
   *
   * Removes the specified key from the hstore and returns the
   * modified hstore as a JSON string.
   *
   * @example
   * ```ts
   * delete('"a"=>"1","b"=>"2"', 'a')
   * // '{"b":"2"}'
   * delete('"a"=>"1"', 'a')
   * // '{}'
   * ```
   */
  static delete(hstoreText: string, key: string): string {
    const obj = parseHstoreToObject(hstoreText);
    delete obj[key];
    return objectToHstoreJson(obj);
  }

  // ── hstore_concat ──

  /**
   * hstore_concat(a, b) → string
   *
   * Merges two hstore values.
   * Keys from `b` overwrite keys from `a`.
   *
   * @example
   * ```ts
   * concat('"a"=>"1"', '"b"=>"2"')
   * // '{"a":"1","b":"2"}'
   * concat('"a"=>"1"', '"a"=>"new"')
   * // '{"a":"new"}'
   * ```
   */
  static concat(a: string, b: string): string {
    const objA = parseHstoreToObject(a);
    const objB = parseHstoreToObject(b);
    const merged = { ...objA, ...objB };
    return objectToHstoreJson(merged);
  }

  // ── hstore_to_matrix ──

  /**
   * hstore_to_matrix(hstore_text) → [key, value][]
   *
   * Returns a 2D array of [key, value] pairs.
   *
   * @example
   * ```ts
   * hstoreToMatrix('"a"=>"1","b"=>"2"')
   * // [['a', '1'], ['b', '2']]
   * ```
   */
  static hstoreToMatrix(hstoreText: string): Array<[string, string | null]> {
    const obj = parseHstoreToObject(hstoreText);
    return Object.entries(obj);
  }

  // ── tconvert ──

  /**
   * tconvert(hstore_text) → string
   *
   * Converts hstore to PostgreSQL hstore literal format.
   * Inverse of parsing — converts JSON representation back to PG format.
   *
   * @example
   * ```ts
   * tconvert('{"a":"1","b":"2"}')
   * // '"a"=>"1", "b"=>"2"'
   * ```
   */
  static tconvert(hstoreText: string): string {
    const obj = parseHstoreToObject(hstoreText);
    const pairs = Object.entries(obj)
      .map(([key, value]) => {
        if (value === null) return `"${key}"=>NULL`;
        return `"${key}"=>"${value}"`;
      });
    return pairs.join(', ');
  }

  // ── hstore_exists (`?` operator) ──

  /**
   * hstore_exists(hstore_text, key) → boolean
   *
   * Implements the `?` operator: check if the hstore contains the key.
   * Alias for exist() — returns true if the key exists (even with NULL value).
   *
   * @example
   * ```ts
   * hstore_exists('"a"=>"1"', 'a')  // true
   * hstore_exists('"a"=>"1"', 'b')  // false
   * ```
   */
  static hstoreExists(hstoreText: string, key: string): boolean {
    return HstoreShim.exist(hstoreText, key);
  }

  // ── hstore_exists_any (`?|` operator) ──

  /**
   * hstore_exists_any(hstore_text, keys) → boolean
   *
   * Implements the `?|` operator: returns true if the hstore contains
   * ANY of the specified keys.
   *
   * `keys` can be a comma-separated string or a JS array.
   *
   * @example
   * ```ts
   * hstore_exists_any('"a"=>"1","b"=>"2"', ['a', 'c'])  // true (has a)
   * hstore_exists_any('"a"=>"1"', ['x', 'y'])            // false
   * ```
   */
  static hstoreExistsAny(hstoreText: string, keys: string | string[]): boolean {
    const obj = parseHstoreToObject(hstoreText);
    const keyList = Array.isArray(keys) ? keys : keys.split(',').map(k => k.trim()).filter(Boolean);
    return keyList.some(key => Object.prototype.hasOwnProperty.call(obj, key));
  }

  // ── hstore_exists_all (`?&` operator) ──

  /**
   * hstore_exists_all(hstore_text, keys) → boolean
   *
   * Implements the `?&` operator: returns true if the hstore contains
   * ALL of the specified keys.
   *
   * `keys` can be a comma-separated string or a JS array.
   *
   * @example
   * ```ts
   * hstore_exists_all('"a"=>"1","b"=>"2"', ['a', 'b'])  // true
   * hstore_exists_all('"a"=>"1"', ['a', 'b'])            // false (no b)
   * ```
   */
  static hstoreExistsAll(hstoreText: string, keys: string | string[]): boolean {
    const obj = parseHstoreToObject(hstoreText);
    const keyList = Array.isArray(keys) ? keys : keys.split(',').map(k => k.trim()).filter(Boolean);
    return keyList.every(key => Object.prototype.hasOwnProperty.call(obj, key));
  }

  // ── populate_record ──

  /**
   * populate_record(hstore_text, base_record) → string
   *
   * Populates a record's fields from the hstore key-value pairs.
   *
   * In PG, this takes a composite type and fills matching fields from
   * the hstore.  In this shim, we return a JSON representation of the
   * merged data since SQLite does not have composite types.
   *
   * The `base_record` is ignored in this simplified implementation;
   * we return the hstore data as a JSON string (the caller must interpret it).
   *
   * @example
   * ```ts
   * populate_record('{"a":"1","b":"2"}', '{}')
   * // '{"a":"1","b":"2"}'
   * ```
   */
  static populateRecord(hstoreText: string, _baseRecord?: string): string {
    const obj = parseHstoreToObject(hstoreText);
    // If base record is provided and is JSON, merge
    if (_baseRecord) {
      try {
        const base = JSON.parse(_baseRecord);
        const merged = { ...base, ...obj };
        return objectToHstoreJson(merged);
      } catch {
        // Not parseable as JSON, just return the hstore data
        return objectToHstoreJson(obj);
      }
    }
    return objectToHstoreJson(obj);
  }
}

// ──────────────────────────────────────────────
//  SQL-level operator rewriting
// ──────────────────────────────────────────────

/**
 * Regex matching the hstore `->` operator pattern:
 *   `expression -> 'string_literal'`
 *
 * This handles:
 *   - `col -> 'key'`
 *   - `tablename.col -> 'key'`
 *   - `schema.tablename.col -> 'key'`
 *   - `func(col) -> 'key'`
 *
 * Uses `\b` word boundary before `->` and ensures the right side
 * is a single-quoted string literal.
 */
// Note: The PG hstore `->` operator is the same syntax as JSON `->`.
// In the context of this shim, we assume hstore columns.
// The rewrite converts `expr -> 'key'` to `hstore_get_value(expr, 'key')`.
// eslint-disable-next-line require-unicode-regexp
const HSTORE_OP_REGEX = /([\w.()"'`]+)\s*->\s*'([^']*)'/gi;

/**
 * Detect whether the given SQL contains the `->` hstore operator syntax.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL contains `->` operator with string literal
 *
 * @example
 * ```ts
 * detectHstoreOperator('SELECT col -> \'key\' FROM t'); // true
 * detectHstoreOperator('SELECT col->>\'key\' FROM t');   // false (->> not ->)
 * detectHstoreOperator('SELECT 1');                       // false
 * ```
 */
export function detectHstoreOperator(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  // Make sure we don't match ->> (JSON text accessor)
  // eslint-disable-next-line require-unicode-regexp
  const opRegex = /([\w.()"'`]+)\s*->\s*'([^']*)'/gi;
  let match: RegExpExecArray | null;
  while ((match = opRegex.exec(sql)) !== null) {
    // Check this isn't a ->> pattern
    const beforeOp = sql.slice(Math.max(0, match.index - 1), match.index);
    if (beforeOp === '>') continue; // This is ->> not ->
    return true;
  }
  return false;
}

/**
 * Rewrite the hstore `->` operator to a SQLite-compatible expression.
 *
 * The rewrite converts:
 *   `col -> 'key'` → `hstore_get(col, 'key')`
 *
 * Where `hstore_get` is a registered JS function that extracts the value
 * from the hstore JSON text.
 *
 * Processing logic:
 * 1. Scans the SQL for `expr -> 'key'` patterns
 * 2. Replaces each occurrence right-to-left (to preserve offsets)
 * 3. Returns the rewritten SQL with a `rewritten` flag
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link HstoreRewriteResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteHstoreOperator('SELECT col -> \'a\' FROM t')
 * // → { sql: 'SELECT hstore_get(col, \'a\') FROM t', rewritten: true }
 *
 * rewriteHstoreOperator('SELECT 1')
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteHstoreOperator(sql: string): HstoreRewriteResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  // Collect replacements in reverse order
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
  }> = [];

  // eslint-disable-next-line require-unicode-regexp
  const opRegex = /([\w.()"'`]+)\s*->\s+'([^']*)'/gi;
  let match: RegExpExecArray | null;

  while ((match = opRegex.exec(sql)) !== null) {
    const fullMatch = match[0];
    const expr = match[1].trim();
    const key = match[2];

    // Skip if this is actually ->> (JSON text accessor)
    const beforeOp = sql.slice(Math.max(0, match.index - 1), match.index);
    if (beforeOp === '>') continue;

    const replacement = `hstore_get(${expr}, '${key}')`;

    replacements.push({
      start: match.index,
      end: match.index + fullMatch.length,
      replacement,
    });
  }

  if (replacements.length === 0) {
    return { sql, rewritten: false };
  }

  // Apply replacements right-to-left
  const parts: string[] = [];
  let lastEnd = sql.length;

  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    if (r.end > lastEnd) {
      logger.warn({ replacement: r }, 'Overlapping hstore replacement — skipping');
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
    'Hstore operator rewritten',
  );

  return {
    sql: result,
    rewritten: true,
  };
}

// ──────────────────────────────────────────────
//  SQL rewriting for `?`, `?|`, `?&` operators
// ──────────────────────────────────────────────

/**
 * Regex matching the hstore `?` operator:
 *   `expr ? 'key'`
 *
 * The `?` operator checks if a key exists in the hstore.
 * Handles: col ? 'key', tablename.col ? 'key'
 *
 * Note: `?` is also used as a JSON operator and in placeholders.
 * We use a conservative regex that requires an identifier on the left
 * side and a string literal on the right side.
 */
// eslint-disable-next-line require-unicode-regexp
const HSTORE_HAS_KEY_REGEX = /([\w.()"`]+)\s+\?\s+'([^']*)'/gi;

/**
 * Regex matching the hstore `?|` operator:
 *   `expr ?| ARRAY['a','b']`
 *
 * The `?|` operator checks if ANY of the specified keys exist.
 */
// eslint-disable-next-line require-unicode-regexp
const HSTORE_HAS_ANY_REGEX = /([\w.()"`]+)\s+\?\|\s+(?:ARRAY\s*)?\[([^\]]*)\]/gi;

/**
 * Regex matching the hstore `?&` operator:
 *   `expr ?& ARRAY['a','b']`
 *
 * The `?&` operator checks if ALL of the specified keys exist.
 */
// eslint-disable-next-line require-unicode-regexp
const HSTORE_HAS_ALL_REGEX = /([\w.()"`]+)\s+\?&\s+(?:ARRAY\s*)?\[([^\]]*)\]/gi;

/**
 * Detect whether the given SQL contains hstore `?`, `?|`, or `?&` operators.
 */
export function detectHstoreKeyOperators(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;

  HSTORE_HAS_KEY_REGEX.lastIndex = 0;
  if (HSTORE_HAS_KEY_REGEX.test(sql)) return true;

  HSTORE_HAS_ANY_REGEX.lastIndex = 0;
  if (HSTORE_HAS_ANY_REGEX.test(sql)) return true;

  HSTORE_HAS_ALL_REGEX.lastIndex = 0;
  if (HSTORE_HAS_ALL_REGEX.test(sql)) return true;

  return false;
}

/**
 * Rewrite hstore `?`, `?|`, `?&` operators to function calls.
 *
 * Rewrites:
 *   `col ? 'key'`            → `hstore_exists(col, 'key')`
 *   `col ?| ARRAY['a','b']`  → `hstore_exists_any(col, 'a,b')`
 *   `col ?& ARRAY['a','b']`  → `hstore_exists_all(col, 'a,b')`
 */
export function rewriteHstoreKeyOperators(sql: string): HstoreRewriteResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = sql;
  let rewritten = false;

  // 1. Rewrite `?` operator: col ? 'key' → hstore_exists(col, 'key')
  result = result.replace(HSTORE_HAS_KEY_REGEX, (_match, expr, key) => {
    rewritten = true;
    return `hstore_exists(${expr.trim()}, '${key}')`;
  });

  // 2. Rewrite `?|` operator: col ?| ARRAY['a','b'] → hstore_exists_any(col, 'a,b')
  result = result.replace(HSTORE_HAS_ANY_REGEX, (_match, expr, keysContent) => {
    rewritten = true;
    // Extract string literals from the array content: 'a','b' → a,b
    const keys = extractStringArrayValues(keysContent).join(',');
    return `hstore_exists_any(${expr.trim()}, '${keys}')`;
  });

  // 3. Rewrite `?&` operator: col ?& ARRAY['a','b'] → hstore_exists_all(col, 'a,b')
  result = result.replace(HSTORE_HAS_ALL_REGEX, (_match, expr, keysContent) => {
    rewritten = true;
    const keys = extractStringArrayValues(keysContent).join(',');
    return `hstore_exists_all(${expr.trim()}, '${keys}')`;
  });

  if (rewritten) {
    logger.debug({ before: sql, after: result }, 'Hstore key operators rewritten');
  }

  return { sql: result, rewritten };
}

/**
 * Extract string values from an array literal content.
 * Input: `'a','b','c'` → Output: `['a', 'b', 'c']`
 */
function extractStringArrayValues(content: string): string[] {
  const values: string[] = [];
  // eslint-disable-next-line require-unicode-regexp
  const re = /'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    values.push(match[1]);
  }
  return values;
}

/**
 * Full SQL processing pipeline for hstore compatibility.
 *
 * Applies all hstore rewrites in one pass:
 * 1. Rewrites `col -> 'key'` operator expressions
 * 2. Rewrites `?`, `?|`, `?&` key operators
 *
 * @param sql   The raw SQL string to process
 * @returns     The fully rewritten SQL
 */
export function processHstoreSql(sql: string): string {
  const opResult = rewriteHstoreOperator(sql);
  const keyResult = rewriteHstoreKeyOperators(opResult.sql);
  return keyResult.sql;
}
