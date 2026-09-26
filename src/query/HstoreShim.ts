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

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

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
/**
 * Unescape a PG hstore quoted string: `\"` → `"` and `\\` → `\`.
 */
function unescapeHstore(s: string): string {
  return s.replace(/\\(["\\])/g, '$1');
}

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
      key = unescapeHstore(trimmed.slice(keyStart, i));
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
      value = unescapeHstore(trimmed.slice(valStart, i));
      if (i < len) i++; // skip closing quote
    } else if (i < len && /^NULL\b/i.test(trimmed.slice(i))) {
      value = null;
      i += 4;
    } else {
      const valStart = i;
      while (i < len && trimmed[i] !== ',' && trimmed[i] !== ' ') i++;
      value = trimmed.slice(valStart, i).trim();
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
  // Object.keys already yields only own enumerable string keys; coerce
  // undefined values to null (JSON has no undefined representation).
  const clean: Record<string, string | null> = {};
  for (const key of Object.keys(obj)) {
    clean[key] = obj[key] === undefined ? null : obj[key];
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

  return findHstoreArrow(sql) !== null;
}

/**
 * Find the next hstore `->` operator occurrence (expression `->` followed by
 * a string literal), skipping string literals, quoted identifiers,
 * dollar-quoted strings, and comments. Returns the index of the `->` arrow,
 * or `null` when no operator is present.
 *
 * The `->>` JSON text accessor is not a match: when the arrow is immediately
 * followed by another `>`, or preceded by `-`, it is skipped.
 */
function findHstoreArrow(sql: string): { arrowIndex: number } | null {
  for (let i = 0; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    if (sql[i] !== '-' || sql[i + 1] !== '>') continue;

    // Skip JSON `->>` text accessor: `->` followed by `>`.
    if (sql[i + 2] === '>') continue;

    // The arrow must be preceded by a valid expression character (not a bare
    // `-` start, e.g. a subtraction or another operator).
    if (i === 0) continue;

    // Arrow must be followed (after optional whitespace) by a single-quoted
    // string literal.
    let j = i + 2;
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql[j] !== "'") continue;

    return { arrowIndex: i };
  }
  return null;
}

/**
 * Given `pos` pointing at a closing quote (`'`, `"`, or `` ` ``), return the
 * index just before the *opening* quote of the same string/identifier. Handles
 * doubled-quote escapes (e.g. `''` inside a string, `""` inside an identifier
 * and ```` ``` ```` inside a backtick identifier). Used while scanning an
 * expression backward so a `)` inside a literal does not affect paren depth.
 */
function skipStringBackward(sql: string, pos: number): number {
  const quote = sql[pos];
  let i = pos - 1;
  while (i >= 0) {
    if (sql[i] === quote) {
      if (i - 1 >= 0 && sql[i - 1] === quote) { i -= 2; continue; } // doubled escape
      return i - 1;
    }
    i--;
  }
  return -1;
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

  // Collect replacements (arrow index + full span + rewritten text).
  const replacements: Array<{
    start: number;
    end: number;
    replacement: string;
  }> = [];

  for (let i = 0; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    if (sql[i] !== '-' || sql[i + 1] !== '>') continue;
    if (sql[i + 2] === '>') continue; // ->> JSON text accessor
    if (i === 0) continue;

    // The string literal on the right (after optional whitespace).
    let j = i + 2;
    while (j < sql.length && /\s/.test(sql[j])) j++;
    if (sql[j] !== "'") continue;

    // Read the full single-quoted string literal (honoring '' escapes).
    const literalStart = j;
    let k = j + 1;
    while (k < sql.length) {
      if (sql[k] === "'") {
        if (sql[k + 1] === "'") { k += 2; continue; }
        break;
      }
      k++;
    }
    // k is the closing quote index; the literal spans [literalStart, k].
    const literalEnd = k + 1;
    const key = sql.slice(literalStart + 1, k).replace(/''/g, "'");

    // Walk left from the arrow to isolate the left-hand expression. The LHS
    // ends just before the arrow. It is one of:
    //   - `ident` or `a.b.c` (dotted qualified name)
    //   - `func(...)` or `( ... )` (a parenthesised expression / call)
    let exprStart = i - 1;
    while (exprStart >= 0 && /\s/.test(sql[exprStart])) exprStart--;

    let cursor = exprStart;
    if (cursor >= 0 && sql[cursor] === ')') {
      // Back-scan the balanced parenthesised suffix, skipping string literals
      // and quoted identifiers so `)` inside them do not affect nesting.
      let depth = 0;
      while (cursor >= 0) {
        const ch = sql[cursor];
        if (ch === "'" || ch === '"' || ch === '`') {
          cursor = skipStringBackward(sql, cursor);
          continue;
        }
        if (ch === ')') { depth++; cursor--; continue; }
        if (ch === '(') {
          depth--;
          cursor--;
          if (depth <= 0) break;
          continue;
        }
        if (depth > 0) { cursor--; continue; }
        break;
      }
      // Continue over an optional function name preceding the `(`.
      while (cursor >= 0 && /[A-Za-z0-9_]/.test(sql[cursor])) cursor--;
    } else if (cursor >= 0 && (sql[cursor] === '"' || sql[cursor] === '`')) {
      // Quoted identifier (double-quote or backtick). Step back to just
      // before the opening quote, then continue over any dotted prefix.
      cursor = skipStringBackward(sql, cursor);
      while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    } else {
      // Plain identifier or dotted qualified name.
      while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    }

    const lhs = sql.slice(cursor + 1, i).trim();
    if (!lhs) continue;

    const escapedKey = key.replace(/'/g, "''");
    const replacement = `hstore_get(${lhs}, '${escapedKey}')`;
    replacements.push({
      start: cursor + 1,
      end: literalEnd,
      replacement,
    });
  }

  if (replacements.length === 0) {
    return { sql, rewritten: false };
  }

  // Apply replacements right-to-left to preserve offsets.
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
 * Note: `?` is also used as a JSON operator and in placeholders. The scanner
 * only treats a `?` as an hstore operator when a string literal (or, for
 * `?|`/`?&`, an `ARRAY[...]`) immediately follows.
 */

/**
 * Detect whether the given SQL contains hstore `?`, `?|`, or `?&` operators.
 */
export function detectHstoreKeyOperators(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;

  return findHstoreKeyOperatorAt(sql, 0) !== null;
}

interface HstoreKeyOccurrence {
  /** Index of the `?` character. */
  qIndex: number;
  /** Operator kind: `?`, `?|`, or `?&`. */
  op: '?' | '?|' | '?&';
  /** Byte offset of the operator's LHS expression start. */
  lhsStart: number;
  /** Full end offset (after the RHS string literal or array). */
  end: number;
  /** The key (single) or comma-joined keys (for any/all). */
  keys: string;
}

/**
 * Find the next hstore `?`/`?|`/`?&` operator, skipping string literals,
 * quoted identifiers, dollar-quoted strings, and comments, and treating the
 * RHS as either a single-quoted string (`?`) or `ARRAY[...]` (`?|`/`?&`).
 * Returns `null` when no operator is found.
 */
function findHstoreKeyOperatorAt(sql: string, start: number): HstoreKeyOccurrence | null {
  for (let i = start; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    if (sql[i] !== '?') continue;

    const op = sql[i + 1] === '|' ? '?|' : sql[i + 1] === '&' ? '?&' : '?';
    const afterOp = i + (op === '?' ? 1 : 2);

    // Skip whitespace, then parse the RHS.
    let j = afterOp;
    while (j < sql.length && /\s/.test(sql[j])) j++;

    let keys: string;
    let end: number;
    if (op === '?') {
      // `?` accepts only a single-quoted string literal.
      if (sql[j] !== "'") continue;
      let k = j + 1;
      while (k < sql.length) {
        if (sql[k] === "'") {
          if (sql[k + 1] === "'") { k += 2; continue; }
          break;
        }
        k++;
      }
      keys = sql.slice(j + 1, k).replace(/''/g, "'");
      end = k + 1;
    } else {
      // `?|` and `?&` accept only an `ARRAY[...]` literal.
      if (!/^ARRAY\b/i.test(sql.slice(j))) continue;
      let a = j + 5;
      while (a < sql.length && /\s/.test(sql[a])) a++;
      if (sql[a] !== '[') continue;
      const close = findArrayClose(sql, a);
      if (close === -1) continue;
      keys = extractStringArrayValues(sql.slice(a + 1, close)).join(',');
      end = close + 1;
    }

    // LHS expression: step back over whitespace, then a quoted identifier,
    // a balanced parenthesised call, or a plain/dotted identifier.
    let lhsStart = i - 1;
    while (lhsStart >= 0 && /\s/.test(sql[lhsStart])) lhsStart--;

    let cursor = lhsStart;
    if (cursor >= 0 && sql[cursor] === ')') {
      let depth = 0;
      while (cursor >= 0) {
        const ch = sql[cursor];
        if (ch === "'" || ch === '"' || ch === '`') { cursor = skipStringBackward(sql, cursor); continue; }
        if (ch === ')') { depth++; cursor--; continue; }
        if (ch === '(') { depth--; cursor--; if (depth <= 0) break; continue; }
        if (depth > 0) { cursor--; continue; }
        break;
      }
      while (cursor >= 0 && /[A-Za-z0-9_]/.test(sql[cursor])) cursor--;
    } else if (cursor >= 0 && (sql[cursor] === '"' || sql[cursor] === '`')) {
      cursor = skipStringBackward(sql, cursor);
      while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    } else {
      while (cursor >= 0 && /[A-Za-z0-9_.]/.test(sql[cursor])) cursor--;
    }

    const lhs = sql.slice(cursor + 1, i).trim();
    if (!lhs) continue;

    return { qIndex: i, op, lhsStart: cursor + 1, end, keys };
  }
  return null;
}

/**
 * Find the index of the `]` closing an array literal starting at `openIdx`
 * (the `[`), skipping string literals inside the array.
 */
function findArrayClose(sql: string, openIdx: number): number {
  for (let i = openIdx + 1; i < sql.length; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    if (sql[i] === ']') return i;
  }
  return -1;
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

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];
  let occ = findHstoreKeyOperatorAt(sql, 0);
  while (occ) {
    const lhs = sql.slice(occ.lhsStart, occ.qIndex).trim();
    const escapedKeys = occ.keys.replace(/'/g, "''");
    const fn = occ.op === '?' ? 'hstore_exists' : occ.op === '?|' ? 'hstore_exists_any' : 'hstore_exists_all';
    replacements.push({
      start: occ.lhsStart,
      end: occ.end,
      replacement: `${fn}(${lhs}, '${escapedKeys}')`,
    });
    occ = findHstoreKeyOperatorAt(sql, occ.end);
  }

  if (replacements.length === 0) {
    return { sql, rewritten: false };
  }

  // Apply replacements right-to-left to preserve offsets.
  const parts: string[] = [];
  let lastEnd = sql.length;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    if (r.end > lastEnd) {
      logger.warn({ replacement: r }, 'Overlapping hstore key replacement — skipping');
      continue;
    }
    parts.push(sql.slice(r.end, lastEnd));
    parts.push(r.replacement);
    lastEnd = r.start;
  }
  parts.push(sql.slice(0, lastEnd));
  const result = parts.reverse().join('');

  logger.debug({ before: sql, after: result }, 'Hstore key operators rewritten');

  return { sql: result, rewritten: true };
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
