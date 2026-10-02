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
import { skipSqlLiteral } from './SqlLiteralScanner';

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
 * The two functions that are rewritten to SQLite-native `substr`.
 *
 * PostgreSQL semantics for `n`:
 *   - left(str, n):  n >= 0 → first n chars;  n < 0 → all but last |n| chars.
 *   - right(str, n): n >= 0 → last n chars;   n < 0 → all but first |n| chars.
 *
 * `substr` itself has no left/right notion, so we express each with a CASE so
 * that negative `n` (including a negative *expression*) never produces an
 * accidental `--` comment or a wrong slice. `n` is wrapped in parentheses in
 * every branch so an expression like `f(x)` or `-n` cannot break the syntax.
 */
const REWRITABLE_FUNCTIONS: Record<string, (args: string[]) => string> = {
  left: (args) =>
    `CASE WHEN (${args[1]}) >= 0 THEN substr(${args[0]}, 1, (${args[1]})) ` +
    `ELSE substr(${args[0]}, 1, length(${args[0]}) + (${args[1]})) END`,
  right: (args) =>
    `CASE WHEN (${args[1]}) >= 0 THEN substr(${args[0]}, -(${args[1]})) ` +
    `ELSE substr(${args[0]}, 1 - (${args[1]})) END`,
};

/**
 * Whether `ch` is a word character that may continue an identifier.
 */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Determine the function name (lowercased) if `sql[i]` begins a (possibly
 * schema-qualified) call to one of the known string functions.
 *
 * Accepts `fn(` and `schema.fn(`. Returns the function name, the index of the
 * start of the *whole token* (including any schema qualifier, so it can be
 * replaced cleanly), and the index of the opening parenthesis — or `null`
 * when the token is not a known function.
 */
function matchStringFunc(
  sql: string,
  i: number,
): { fn: string; tokenStart: number; nameStart: number; openParen: number } | null {
  // Skip a schema qualifier: `schema.fn(`.
  const tokenStart = i;
  let j = i;
  while (j < sql.length && isIdentChar(sql[j])) j++;
  let nameStart = tokenStart;
  let nameEnd = j;
  if (j < sql.length && sql[j] === '.') {
    // A dotted qualifier — the real function name follows.
    let k = j + 1;
    if (k >= sql.length || !isIdentChar(sql[k])) return null;
    nameStart = k;
    while (k < sql.length && isIdentChar(sql[k])) k++;
    nameEnd = k;
  }

  const name = sql.slice(nameStart, nameEnd).toLowerCase();
  if (!STRING_FUNCTIONS.includes(name)) return null;

  // Require an opening parenthesis (allowing whitespace).
  let p = nameEnd;
  while (p < sql.length && /\s/.test(sql[p])) p++;
  if (p >= sql.length || sql[p] !== '(') return null;

  return { fn: name, tokenStart, nameStart, openParen: p };
}

/**
 * Find the closing parenthesis for the `(` at `openParen`, skipping nested
 * parentheses and any literal/comment spans. Returns `-1` when unbalanced.
 */
function findMatchingParen(sql: string, openParen: number): number {
  let depth = 0;
  let i = openParen;
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
 * Split the argument list inside a call's parentheses into top-level arguments,
 * honoring commas only at nesting depth 0 and skipping literals/comments.
 */
function splitTopLevelArgs(sql: string, openParen: number, closeParen: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = openParen + 1;
  let i = start;
  while (i < closeParen) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1 && skipped <= closeParen) {
      i = skipped;
      continue;
    }
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(sql.slice(start, i).trim());
      start = i + 1;
    }
    i++;
  }
  args.push(sql.slice(start, closeParen).trim());
  return args;
}

/**
 * Detect whether a SQL statement contains PostgreSQL-specific string functions.
 *
 * @param sql - Raw SQL string
 * @returns True if any PG string function is detected
 */
export function detectStringFunc(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) return false;
  const found = firstStringFuncCall(sql);
  return found !== null;
}

/**
 * Find the first (possibly schema-qualified) call to a known string function,
 * skipping literals and comments. Returns `{ fn, openParen }` or `null`.
 */
function firstStringFuncCall(sql: string): { fn: string; tokenStart: number; nameStart: number; openParen: number } | null {
  let i = 0;
  while (i < sql.length) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    // Only consider positions that begin an identifier *and* are not the tail
    // of a dotted expression (`schema.fn` or `t..fn`). A dotted qualifier is
    // handled by `matchStringFunc` from the start of the whole token, so we
    // skip the `fn` half when the preceding char is `.`.
    if (isIdentChar(sql[i]) && (i === 0 || (!isIdentChar(sql[i - 1]) && sql[i - 1] !== '.'))) {
      const m = matchStringFunc(sql, i);
      if (m !== null) return m;
    }
    i++;
  }
  return null;
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
  if (typeof sql !== 'string' || sql.trim().length === 0) return sql;

  // Scan left-to-right, rewriting only `left`/`right` (which map to native
  // `substr`). All other functions are resolved by custom SQLite functions and
  // are left verbatim. Literals and comments are skipped so their contents are
  // never corrupted.
  let working = sql;
  let i = 0;
  let rewritten = false;

  while (i < working.length) {
    const skipped = skipSqlLiteral(working, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    if (!isIdentChar(working[i]) || (i > 0 && (isIdentChar(working[i - 1]) || working[i - 1] === '.'))) {
      i++;
      continue;
    }

    const m = matchStringFunc(working, i);
    if (m === null) {
      i++;
      continue;
    }
    if (!(m.fn in REWRITABLE_FUNCTIONS)) {
      // Not a rewritable function — advance past the whole call.
      const close = findMatchingParen(working, m.openParen);
      i = close === -1 ? i + 1 : close + 1;
      continue;
    }

    const close = findMatchingParen(working, m.openParen);
    if (close === -1) {
      // Unbalanced call — leave untouched and keep scanning past the paren.
      i = m.openParen + 1;
      continue;
    }
    const args = splitTopLevelArgs(working, m.openParen, close);
    if (args.length !== REWRITABLE_ARG_COUNT[m.fn]) {
      // Wrong arity — leave the call verbatim.
      i = close + 1;
      continue;
    }
    if (args.some((a) => a.length === 0)) {
      // An empty argument (e.g. `left(a, )`) is not a valid call — leave it.
      i = close + 1;
      continue;
    }

    const replacement = REWRITABLE_FUNCTIONS[m.fn](args);
    // Replace from the start of the whole token (dropping any schema
    // qualifier, since `substr`/`CASE` are native and need no qualifier).
    working = working.slice(0, m.tokenStart) + replacement + working.slice(close + 1);
    rewritten = true;
    i = m.tokenStart + replacement.length;
  }

  if (rewritten) {
    logger.debug({ before: sql, after: working }, 'String functions rewritten');
  }

  return working;
}

/** Expected argument count for each rewritable string function. */
const REWRITABLE_ARG_COUNT: Record<string, number> = {
  left: 2,
  right: 2,
};

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
