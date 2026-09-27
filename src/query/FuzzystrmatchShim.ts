// @ts-nocheck
/**
 * FuzzystrmatchShim — PostgreSQL fuzzystrmatch extension compatibility shim for SQLite.
 *
 * PostgreSQL provides the fuzzystrmatch extension with functions for fuzzy string
 * matching and phonetic algorithms:
 *
 *   - levenshtein(a, b)         → Levenshtein distance (edit distance)
 *   - metaphone(word, len?)     → Metaphone phonetic code
 *   - soundex(word)             → Soundex phonetic code
 *   - difference(a, b)          → Soundex difference (0-4, 4=most similar)
 *   - double_metaphone(word)    → Double Metaphone primary & secondary codes
 *   - dice_coefficient(a, b)    → Dice/Sørensen–Dice coefficient
 *
 * SQLite has no equivalent built-in functions. This shim implements them all
 * using the `natural` npm package's distance and phonetics modules.
 *
 * Strategy:
 *   - Provide pure-JS implementations via the `natural` package
 *   - Expose detect/rewrite patterns for SQL-level interception
 *   - Register function metadata for pg_proc catalog compatibility
 *
 * Dependencies:
 *   natural: npm package for LevenshteinDistance, DiceCoefficient, Metaphone,
 *            SoundEx, and DoubleMetaphone implementations.
 *
 * @module query/FuzzystrmatchShim
 */

import natural from 'natural';
import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('FuzzystrmatchShim');

// ── Singleton instances ──────────────────────────────────────────

/** Reusable SoundEx instance for soundex() and difference() */
const soundex = new natural.SoundEx();

/** Reusable Metaphone instance */
const metaphone = new natural.Metaphone();

/** Reusable Double Metaphone instance */
const doubleMetaphone = new natural.DoubleMetaphone();

// ── Individual function implementations ──────────────────────────

/**
 * Compute the Levenshtein distance between two strings.
 *
 * PostgreSQL signature:
 *   levenshtein(a text, b text) → integer
 *
 * Returns the minimum number of single-character edits (insertions, deletions,
 * or substitutions) required to change string `a` into string `b`.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance (0 = identical; >= 1 otherwise)
 */
export function levenshtein(a: string, b: string): number {
  return natural.LevenshteinDistance(a, b);
}

/**
 * Compute the Metaphone phonetic code for a word.
 *
 * PostgreSQL signature:
 *   metaphone(word text, max_output_length integer) → text
 *
 * Metaphone is an improved phonetic algorithm that encodes words by their
 * English pronunciation. The optional maxOutputLength truncates the result.
 *
 * @param word - Input word
 * @param maxOutputLength - Optional maximum length of the output code
 * @returns Uppercase Metaphone code string
 */
export function metaphoneFn(word: string, maxOutputLength?: number): string {
  return metaphone.process(word, maxOutputLength);
}

/**
 * Compute the Soundex code for a word.
 *
 * PostgreSQL signature:
 *   soundex(word text) → text
 *
 * Soundex is a phonetic algorithm that encodes words by their English
 * pronunciation. The result is always 4 characters (letter + 3 digits).
 *
 * @param word - Input word
 * @returns 4-character Soundex code (e.g., 'H400' for 'hello')
 */
export function soundexFn(word: string): string {
  return soundex.process(word);
}

/**
 * Compute the Double Metaphone codes for a word.
 *
 * PostgreSQL signature:
 *   double_metaphone(word text) → text[]
 *
 * Double Metaphone returns an array of two codes: a primary and a secondary.
 * The secondary code may be empty if it's identical to the primary.
 *
 * @param word - Input word
 * @returns Array of two strings: [primary_code, secondary_code]
 */
export function doubleMetaphoneFn(word: string): string[] {
  // natural's DoubleMetaphone.process() returns [primary, secondary]
  return doubleMetaphone.process(word);
}

/**
 * Compute the Soundex difference between two strings.
 *
 * PostgreSQL signature:
 *   difference(a text, b text) → integer
 *
 * Compares the Soundex codes of `a` and `b` character by character.
 * Returns 0 if no characters match, 4 if all match.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Integer from 0 (no match) to 4 (exact match)
 */
export function difference(a: string, b: string): number {
  const codeA = soundex.process(a);
  const codeB = soundex.process(b);

  // Compare characters — Soundex codes are always 4 characters
  let matches = 0;
  for (let i = 0; i < Math.min(codeA.length, codeB.length); i++) {
    if (codeA[i] === codeB[i]) {
      matches++;
    }
  }
  return matches;
}

/**
 * Compute the Dice coefficient (Sørensen–Dice coefficient) between two strings.
 *
 * PostgreSQL signature:
 *   dice_coefficient(a text, b text) → float8
 *
 * Measures similarity based on bigram overlap. Returns a value between 0.0
 * (no common bigrams) and 1.0 (identical bigram sets).
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score from 0.0 to 1.0
 */
export function diceCoefficient(a: string, b: string): number {
  // natural.DiceCoefficient returns NaN when either input is empty (no
  // bigrams), and `null`/NaN for some degenerate cases. PostgreSQL's
  // dice_coefficient returns 0.0 for empty inputs, so we normalize here.
  const result = natural.DiceCoefficient(a, b);
  return result == null || Number.isNaN(result) ? 0 : result;
}

// ── SQL-level detection and rewriting ────────────────────────────

/**
 * Patterns for detecting fuzzystrmatch function calls in SQL text.
 *
 * These match both:
 *   - direct calls:  SELECT levenshtein('cat', 'dog')
 *   - qualified calls: SELECT public.levenshtein('cat', 'dog')
 */
const FUZZY_FUNCTIONS = [
  'levenshtein',
  'metaphone',
  'soundex',
  'difference',
  'double_metaphone',
  'dice_coefficient',
];

/**
 * Detect whether a SQL statement contains fuzzystrmatch function calls.
 *
 * This is a literal-aware scan: string literals, quoted identifiers,
 * dollar-quoted strings, and comments are skipped, so a word like
 * `levenshtein` appearing inside a string or comment is NOT reported.
 * The function name must be followed by an opening parenthesis (a call),
 * and must be preceded by a non-identifier character (so `dicecoefficient`
 * does not match `dice_coefficient`, and `mylevenshtein` does not match
 * `levenshtein`).
 *
 * @param sql - Raw SQL string
 * @returns true if any fuzzystrmatch function is detected as a real call
 */
export function detectFuzzyMatch(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;

  const len = sql.length;
  for (let i = 0; i < len; i++) {
    const skip = skipSqlLiteral(sql, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }

    const c = sql[i];
    // Function names begin with a letter or underscore.
    if (!/[A-Za-z_]/.test(c)) continue;

    // A function name must be a whole identifier: the character before it
    // must not be an identifier character (word boundary).
    if (i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1])) continue;

    let matched = false;
    for (const fn of FUZZY_FUNCTIONS) {
      if (sql.startsWith(fn, i)) {
        matched = true;
        break;
      }
    }
    if (!matched) continue;

    // Skip past the identifier (including any underscores).
    let j = i;
    while (j < len && /[A-Za-z0-9_]/.test(sql[j])) j++;

    // Require an opening parenthesis (a function call), allowing whitespace.
    let k = j;
    while (k < len && /\s/.test(sql[k])) k++;
    if (k < len && sql[k] === '(') {
      return true;
    }

    i = j - 1;
  }

  return false;
}

// ── Catalog registration ─────────────────────────────────────────

/**
 * Metadata for each fuzzystrmatch function for pg_proc catalog registration.
 */
export interface FunctionMeta {
  /** Function name as exposed to SQL */
  name: string;
  /** Argument count (0 = variadic) */
  argCount: number;
  /** Comma-separated argument types */
  argTypes: string;
  /** Return type */
  returnType: string;
  /** Brief description */
  description: string;
}

/**
 * Full list of fuzzystrmatch functions with metadata.
 * Can be registered in pg_proc so they appear in `SELECT * FROM pg_proc`.
 */
export const FUZZYSTRMATCH_FUNCTIONS: FunctionMeta[] = [
  {
    name: 'levenshtein',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'integer',
    description: 'Levenshtein distance between two strings',
  },
  {
    name: 'metaphone',
    argCount: 2,
    argTypes: 'text, integer',
    returnType: 'text',
    description: 'Metaphone phonetic code',
  },
  {
    name: 'soundex',
    argCount: 1,
    argTypes: 'text',
    returnType: 'text',
    description: 'Soundex phonetic code',
  },
  {
    name: 'difference',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'integer',
    description: 'Soundex difference (0-4)',
  },
  {
    name: 'double_metaphone',
    argCount: 1,
    argTypes: 'text',
    returnType: 'text[]',
    description: 'Double Metaphone codes',
  },
  {
    name: 'dice_coefficient',
    argCount: 2,
    argTypes: 'text, text',
    returnType: 'float8',
    description: 'Dice coefficient (0.0-1.0)',
  },
];

/**
 * Convenience object mapping function name → our exported implementation.
 * Useful for dynamic dispatch when intercepting SQL function calls.
 */
export const FUZZYSTRMATCH_FN_MAP: Record<string, (...args: any[]) => any> = {
  levenshtein,
  metaphone: metaphoneFn,
  soundex: soundexFn,
  difference,
  double_metaphone: doubleMetaphoneFn,
  dice_coefficient: diceCoefficient,
};

// ── Custom SQLite function registration ─────────────────────────

/**
 * Register all fuzzystrmatch functions as custom SQLite functions.
 *
 * After calling this, SQL can call `levenshtein(...)`, `soundex(...)`,
 * `metaphone(...)`, `difference(...)`, `double_metaphone(...)`, and
 * `dice_coefficient(...)` directly.
 *
 * @param db - A better-sqlite3 or compatible SQLite database instance
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { registerFuzzyFunctions } from './FuzzystrmatchShim';
 *
 * const db = new Database(':memory:');
 * registerFuzzyFunctions(db);
 *
 * db.prepare("SELECT levenshtein('kitten', 'sitting')").get(); // → 3
 * ```
 */
export function registerFuzzyFunctions(db: any): void {
  if (typeof db?.function !== 'function') {
    logger.warn(
      'No `.function()` method on database — cannot register fuzzy functions. ' +
      'Requires better-sqlite3 v11+ or compatible binding.',
    );
    return;
  }

  const opts = { deterministic: true } as const;

  db.function('levenshtein', opts, (a: any, b: any, ins?: any, del?: any, sub?: any) => {
    // Dispatch: 2-arg standard distance or 5-arg custom-cost distance.
    // PostgreSQL exposes exactly two signatures — levenshtein(text, text)
    // and levenshtein(text, text, int, int, int) — so we branch on whether
    // any cost argument was supplied rather than on their individual values.
    if (ins == null && del == null && sub == null) {
      return levenshtein(String(a ?? ''), String(b ?? ''));
    }
    return levenshteinCustom(String(a ?? ''), String(b ?? ''), ins, del, sub);
  });

  db.function('metaphone', opts, (word: any, maxLen?: any) => {
    return metaphoneFn(String(word ?? ''), maxLen != null ? Number(maxLen) : undefined);
  });

  db.function('soundex', opts, (word: any) => {
    return soundexFn(String(word ?? ''));
  });

  db.function('difference', opts, (a: any, b: any) => {
    return difference(String(a ?? ''), String(b ?? ''));
  });

  db.function('double_metaphone', opts, (word: any) => {
    return doubleMetaphoneFn(String(word ?? ''));
  });

  db.function('dice_coefficient', opts, (a: any, b: any) => {
    return diceCoefficient(String(a ?? ''), String(b ?? ''));
  });

  logger.info('Fuzzy match functions registered: levenshtein, metaphone, soundex, difference, double_metaphone, dice_coefficient');
}

/**
 * Custom-cost Levenshtein (ins/del/sub) — pure JS implementation.
 * This is not exported via `natural`, so we implement it here.
 */
function levenshteinCustom(a: string, b: string, ins: number, del: number, sub: number): number {
  // PostgreSQL's 5-arg signature defaults each weight to 1 when omitted;
  // normalize a missing (null/undefined) weight to its standard cost so a
  // partial-cost invocation never produces NaN.
  const wIns = ins == null ? 1 : Number(ins);
  const wDel = del == null ? 1 : Number(del);
  const wSub = sub == null ? 1 : Number(sub);

  const m = a.length;
  const n = b.length;

  // Ensure we iterate over the shorter dimension for memory efficiency
  if (m < n) {
    return levenshteinCustom(b, a, wDel, wIns, wSub);
  }

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  for (let j = 0; j <= n; j++) {
    prev[j] = j * wIns;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i * wDel;
    for (let j = 1; j <= n; j++) {
      const costDel = prev[j] + wDel;
      const costIns = curr[j - 1] + wIns;
      const costSub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : wSub);
      curr[j] = Math.min(costDel, costIns, costSub);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

// ── SQL Rewrite ──────────────────────────────────────────────────

/**
 * Result of a fuzzy match rewrite attempt.
 */
export interface FuzzyMatchRewriteResult {
  /** Whether any fuzzystrmatch functions were found and rewritten */
  found: boolean;
  /** The rewritten SQL (same as input if not found) */
  rewritten: string;
}

/**
 * Rewrite a SQL string containing fuzzy match function calls.
 * Since fuzzy functions are registered as custom SQLite functions,
 * this is typically a no-op pass-through. Future use cases include
 * name mangling for compatibility.
 *
 * @param sql - Raw SQL string
 * @returns Rewrite result
 */
export function rewriteFuzzyMatch(sql: string): FuzzyMatchRewriteResult {
  if (!detectFuzzyMatch(sql)) {
    return { found: false, rewritten: sql };
  }
  // Actually try to rewrite — currently no rewrite needed because
  // functions are registered with exact PG names. This function exists
  // for the detect/rewrite pipeline consistency.
  return { found: true, rewritten: sql };
}

// ── Logger ───────────────────────────────────────────────────────

export { logger };
