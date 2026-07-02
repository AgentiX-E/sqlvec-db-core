/**
 * StringFuncShim — PostgreSQL string function compatibility shim for SQLite.
 *
 * PostgreSQL supports many string functions that SQLite lacks natively:
 *
 *   | PG Function               | Equivalent / Rewrite                          |
 *   |---------------------------|-----------------------------------------------|
 *   | split_part(str,d,n)       | custom SQLite function                        |
 *   | repeat(str, n)            | custom SQLite function                        |
 *   | lpad(str, len, fill)      | custom SQLite function                        |
 *   | rpad(str, len, fill)      | custom SQLite function                        |
 *   | left(str, n)              | substr(str, 1, n) — SQL rewrite              |
 *   | right(str, n)             | substr(str, -n, n) — SQL rewrite             |
 *   | translate(str, from, to)  | custom SQLite function                        |
 *   | reverse(str)              | custom SQLite function                        |
 *
 * Strategy:
 *   - left / right: straightforward SQL rewrite to substr()
 *   - All others: register as custom SQLite functions via db.function()
 *   - Provide detect/rewrite at the SQL level to handle the full set
 *
 * @module query/StringFuncShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('StringFuncShim');

// ── Pure JS implementations ──────────────────────────────────────

/**
 * split_part(str, delim, n) — split string and return the nth part (1-indexed).
 *
 * PostgreSQL signature:
 *   split_part(string text, delimiter text, field integer) → text
 *
 * @param str - Input string
 * @param delim - Delimiter string
 * @param n - 1-based field index (must be >= 1)
 * @returns The nth field, or empty string if out of range
 */
export function splitPart(str: string, delim: string, n: number): string {
  if (n < 1) return '';
  const parts = String(str).split(String(delim));
  return parts[n - 1] ?? '';
}

/**
 * repeat(str, n) — repeat string n times.
 *
 * PostgreSQL signature:
 *   repeat(string text, number integer) → text
 *
 * @param str - String to repeat
 * @param n - Number of repetitions
 * @returns Repeated string, or empty string if n <= 0
 */
export function repeatStr(str: string, n: number): string {
  const count = Math.max(0, Math.floor(Number(n) || 0));
  return String(str).repeat(count);
}

/**
 * lpad(str, len, fill) — left-pad string to specified length.
 *
 * PostgreSQL signature:
 *   lpad(string text, length integer [, fill text]) → text
 *
 * Default fill is a single space (' ').
 *
 * @param str - Input string
 * @param len - Target length
 * @param fill - Fill string (default: ' ')
 * @returns Left-padded string
 */
export function lpad(str: string, len: number, fill: string = ' '): string {
  const s = String(str);
  const targetLen = Math.max(0, Math.floor(Number(len) || 0));
  if (s.length >= targetLen) return s;
  const padLen = targetLen - s.length;
  const fillStr = String(fill);
  if (fillStr.length === 0) return s;
  const repeats = Math.ceil(padLen / fillStr.length);
  return fillStr.repeat(repeats).slice(0, padLen) + s;
}

/**
 * rpad(str, len, fill) — right-pad string to specified length.
 *
 * PostgreSQL signature:
 *   rpad(string text, length integer [, fill text]) → text
 *
 * Default fill is a single space (' ').
 *
 * @param str - Input string
 * @param len - Target length
 * @param fill - Fill string (default: ' ')
 * @returns Right-padded string
 */
export function rpad(str: string, len: number, fill: string = ' '): string {
  const s = String(str);
  const targetLen = Math.max(0, Math.floor(Number(len) || 0));
  if (s.length >= targetLen) return s;
  const padLen = targetLen - s.length;
  const fillStr = String(fill);
  if (fillStr.length === 0) return s;
  const repeats = Math.ceil(padLen / fillStr.length);
  return s + fillStr.repeat(repeats).slice(0, padLen);
}

/**
 * left(str, n) — return first n characters.
 *
 * PostgreSQL signature:
 *   left(string text, n integer) → text
 *
 * If n is negative, all but the last |n| characters are returned.
 *
 * @param str - Input string
 * @param n - Number of characters (negative = trim from right)
 * @returns Left portion of the string
 */
export function leftStr(str: string, n: number): string {
  const s = String(str);
  const count = Number(n) || 0;
  if (count >= 0) return s.slice(0, count);
  // Negative n: all but last |n| characters
  return s.slice(0, Math.max(0, s.length + count));
}

/**
 * right(str, n) — return last n characters.
 *
 * PostgreSQL signature:
 *   right(string text, n integer) → text
 *
 * If n is negative, all but the first |n| characters are returned.
 *
 * @param str - Input string
 * @param n - Number of characters (negative = trim from left)
 * @returns Right portion of the string
 */
export function rightStr(str: string, n: number): string {
  const s = String(str);
  const count = Number(n) || 0;
  if (count > 0) return s.slice(-count);
  if (count === 0) return '';
  // Negative n: all but first |n| characters
  return s.slice(Math.min(s.length, Math.abs(count)));
}

/**
 * translate(str, from, to) — character-by-character replacement.
 *
 * PostgreSQL signature:
 *   translate(string text, from text, to text) → text
 *
 * Replaces each character in `str` that appears in `from` with the
 * corresponding character in `to`. Characters in `from` without a
 * corresponding character in `to` are removed.
 *
 * @param str - Input string
 * @param from - Characters to replace
 * @param to - Replacement characters
 * @returns Translated string
 */
export function translate(str: string, from: string, to: string): string {
  const s = String(str);
  const f = String(from);
  const t = String(to);
  if (f.length === 0) return s;

  const map = new Map<string, string>();
  for (let i = 0; i < f.length; i++) {
    map.set(f[i], i < t.length ? t[i] : '');
  }

  let result = '';
  for (const ch of s) {
    if (map.has(ch)) {
      result += map.get(ch);
    } else {
      result += ch;
    }
  }
  return result;
}

/**
 * reverse(str) — reverse a string.
 *
 * PostgreSQL signature:
 *   reverse(text) → text
 *
 * @param str - Input string
 * @returns Reversed string
 */
export function reverseStr(str: string): string {
  return String(str).split('').reverse().join('');
}

// ── Non‑generic levenshtein (custom-cost variant) ────────────────

/**
 * levenshtein(a, b, ins?, del?, sub?) — Levenshtein edit distance.
 *
 * PostgreSQL signatures:
 *   levenshtein(a text, b text) → integer
 *   levenshtein(a text, b text, ins int, del int, sub int) → integer
 *
 * When the 3 optional cost parameters are provided, they set the cost
 * of insert, delete, and substitute operations respectively.
 *
 * @param a - First string
 * @param b - Second string
 * @param ins - Insert cost (default: 1)
 * @param del - Delete cost (default: 1)
 * @param sub - Substitute cost (default: 1)
 * @returns Edit distance
 */
export function levenshteinCustom(
  a: string,
  b: string,
  ins?: number,
  del?: number,
  sub?: number,
): number {
  const strA = String(a ?? '');
  const strB = String(b ?? '');
  const costIns = ins != null ? Number(ins) : 1;
  const costDel = del != null ? Number(del) : 1;
  const costSub = sub != null ? Number(sub) : 1;

  const m = strA.length;
  const n = strB.length;

  // Always use the shorter string as the column dimension for O(min(m,n)) memory
  // When swapping, also swap ins and del costs (insert into shorter = delete from longer)
  if (m < n) {
    return levenshteinCustom(strB, strA, costDel, costIns, costSub);
  }

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j * costIns;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i * costDel;
    for (let j = 1; j <= n; j++) {
      const del = prev[j] + costDel;
      const ins = curr[j - 1] + costIns;
      const sub = prev[j - 1] + (strA[i - 1] === strB[j - 1] ? 0 : costSub);
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── SQL‑level detection ─────────────────────────────────────────

const STRING_FUNCTIONS = [
  'split_part',
  'repeat',
  'lpad',
  'rpad',
  'left',
  'right',
  'translate',
  'reverse',
];

/**
 * Regex to detect any of the PG string function calls in SQL.
 * Matches both `function(...)` and `schema.function(...)` patterns.
 */
const STRING_FUNC_RE = new RegExp(
  `\\b(?:\\w+\\.)?(${STRING_FUNCTIONS.map(escapeFnName).join('|')})\\s*\\(`,
  'gi',
);

/** Escape a function name so it works in a regex alternation. */
function escapeFnName(fn: string): string {
  return fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Detect whether a SQL statement contains PostgreSQL-specific string functions.
 *
 * @param sql - Raw SQL string
 * @returns True if any PG string function is detected
 */
export function detectStringFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  STRING_FUNC_RE.lastIndex = 0;
  return STRING_FUNC_RE.test(sql);
}

// ── SQL rewrite ─────────────────────────────────────────────────

/**
 * Rewrite a SQL string, replacing PG string function calls with either
 * SQLite-native syntax (left → substr, right → substr) or leaving
 * custom-registered functions as-is (they'll be resolved by SQLite).
 *
 * The `rewrite` function is optional — if custom SQLite functions are
 * registered (via `registerStringFunctions`), most calls work without
 * any rewrite. This function handles:
 *
 *   - `left(str, n)`    → `substr(str, 1, n)`  (SQLite built-in)
 *   - `right(str, n)`   → `substr(str, -n, n)` (SQLite built-in)
 *
 * @param sql - Raw SQL string
 * @returns Rewritten SQL string
 */
export function rewriteStringFunc(sql: string): string {
  if (!detectStringFunc(sql)) return sql;

  let working = sql;
  let rewritten = false;

  // ── left(str, n) → substr(str, 1, n) ──
  // Match pattern: left( ... , ... ) — handles nested parens
  working = working.replace(
    /\bleft\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/gi,
    (_match: string, str: string, n: string) => {
      rewritten = true;
      return `substr(${str.trim()}, 1, ${n.trim()})`;
    },
  );

  // ── right(str, n) → substr(str, -n, n) ──
  working = working.replace(
    /\bright\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/gi,
    (_match: string, str: string, n: string) => {
      rewritten = true;
      return `substr(${str.trim()}, -${n.trim()}, ${n.trim()})`;
    },
  );

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'String functions rewritten');
  }

  return working;
}

// ── Custom SQLite function registration ─────────────────────────

/**
 * Register all PG string functions as custom SQLite functions.
 *
 * After calling this, SQL can use `split_part(...)`, `repeat(...)`,
 * `lpad(...)`, `rpad(...)`, `left(...)`, `right(...)`, `translate(...)`,
 * and `reverse(...)` directly.
 *
 * @param db - A better-sqlite3 or compatible SQLite database instance
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { registerStringFunctions } from './StringFuncShim';
 *
 * const db = new Database(':memory:');
 * registerStringFunctions(db);
 *
 * // Now you can call PG string functions
 * db.prepare("SELECT split_part('a,b,c', ',', 2)").get(); // → 'b'
 * db.prepare("SELECT repeat('ha', 3)").get();             // → 'hahaha'
 * ```
 */
export function registerStringFunctions(db: any): void {
  if (typeof db?.function !== 'function') {
    logger.warn(
      'No `.function()` method on database — cannot register string functions. ' +
      'Requires better-sqlite3 v11+ or compatible binding.',
    );
    return;
  }

  const opts = { deterministic: true } as const;

  db.function('split_part', opts, splitPart);
  db.function('repeat', opts, repeatStr);
  db.function('lpad', opts, lpad);
  db.function('rpad', opts, rpad);
  db.function('left', opts, leftStr);
  db.function('right', opts, rightStr);
  db.function('translate', opts, translate);
  db.function('reverse', opts, reverseStr);

  logger.info('String functions registered: split_part, repeat, lpad, rpad, left, right, translate, reverse');
}

// ── Metadata catalog ────────────────────────────────────────────

export interface StringFuncMeta {
  name: string;
  argCount: number;
  argTypes: string;
  returnType: string;
  description: string;
}

export const STRING_FUNCTIONS_META: StringFuncMeta[] = [
  {
    name: 'split_part',
    argCount: 3,
    argTypes: 'text, text, integer',
    returnType: 'text',
    description: 'Split string on delimiter and return nth field',
  },
  {
    name: 'repeat',
    argCount: 2,
    argTypes: 'text, integer',
    returnType: 'text',
    description: 'Repeat string n times',
  },
  {
    name: 'lpad',
    argCount: 3,
    argTypes: 'text, integer, text',
    returnType: 'text',
    description: 'Left-pad string to specified length',
  },
  {
    name: 'rpad',
    argCount: 3,
    argTypes: 'text, integer, text',
    returnType: 'text',
    description: 'Right-pad string to specified length',
  },
  {
    name: 'left',
    argCount: 2,
    argTypes: 'text, integer',
    returnType: 'text',
    description: 'Extract first n characters',
  },
  {
    name: 'right',
    argCount: 2,
    argTypes: 'text, integer',
    returnType: 'text',
    description: 'Extract last n characters',
  },
  {
    name: 'translate',
    argCount: 3,
    argTypes: 'text, text, text',
    returnType: 'text',
    description: 'Character-by-character replacement',
  },
  {
    name: 'reverse',
    argCount: 1,
    argTypes: 'text',
    returnType: 'text',
    description: 'Reverse a string',
  },
];

export function detectAndRewriteStringFunc(sql: string): { sql: string; rewritten: boolean } {
  if (!detectStringFunc(sql)) {
    return { sql, rewritten: false };
  }
  const rewritten = rewriteStringFunc(sql);
  return { sql: rewritten, rewritten: rewritten !== sql };
}
