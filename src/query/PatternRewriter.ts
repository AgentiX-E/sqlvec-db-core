/**
 * PatternRewriter — Translates PostgreSQL-specific pattern matching operators
 * to SQLite-compatible equivalents.
 *
 * PostgreSQL supports several operators beyond the standard SQL LIKE:
 *
 * | PG Operator         | SQLite Translation                              |
 * |:--------------------|:------------------------------------------------|
 * | `ILIKE`             | `LOWER(col) LIKE LOWER(pattern)`               |
 * | `~~`                | `col LIKE pattern`                             |
 * | `~~*`               | `LOWER(col) LIKE LOWER(pattern)`               |
 * | `!~~`               | `NOT (col LIKE pattern)`                       |
 * | `!~~*`              | `NOT (LOWER(col) LIKE LOWER(pattern))`         |
 * | `SIMILAR TO`        | `LIKE` (simple) or `REGEXP` (complex patterns) |
 * | `~`                 | `col REGEXP pattern` (requires udf)            |
 * | `~*`                | `col REGEXP pattern` (case‑insensitive udf)    |
 * | `!~`                | `NOT (col REGEXP pattern)`                     |
 * | `!~*`               | `NOT (col REGEXP pattern)` (case‑insensitive)  |
 *
 * REGEXP operators embed a comment noting that the SQLite REGEXP function must
 * be registered at connection setup for the rewritten SQL to execute correctly.
 *
 * @module PatternRewriter
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PatternRewriter');

// ────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────

export interface PatternResult {
  /** (Potentially rewritten) SQLite-compatible SQL statement */
  sql: string;
  /** Whether any PG-specific pattern operator was detected and rewritten */
  rewritten: boolean;
  /** PG pattern operator types found in the original SQL */
  patterns: string[];
}

// ────────────────────────────────────────────────────────────
//  Constants
// ────────────────────────────────────────────────────────────

/**
 * Pattern operator descriptors ordered by length (longest first) for greedy
 * matching when multiple operators share a prefix.
 */
interface OpDef {
  symbol: string;
  op: string; // human‑readable tag tracked in PatternResult.patterns
}

const OP_DEFS: OpDef[] = [
  { symbol: '!~~*', op: '!~~*' },
  { symbol: '!~~',  op: '!~~' },
  { symbol: '~~*',  op: '~~*' },
  { symbol: '~~',   op: '~~' },
  { symbol: '!~*',  op: '!~*' },
  { symbol: '!~',   op: '!~' },
  { symbol: '~*',   op: '~*' },
  { symbol: '~',    op: '~' },
];

/**
 * Characters that are meta‑characters in SIMILAR TO and
 * should be preserved when converting to POSIX regex.
 */
const SIMILAR_META = new Set(['|', '*', '+', '?']);

// ────────────────────────────────────────────────────────────
//  Private helpers — detection
// ────────────────────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains any PG-specific pattern matching
 * operator outside of string literals.
 *
 * @param sql - A SQL query string
 * @returns `true` if any PG pattern operator is found
 *
 * @example
 * ```ts
 * detectPGPattern("WHERE name ILIKE '%abc%'");       // → true
 * detectPGPattern("WHERE name ~ '^foo'");            // → true
 * detectPGPattern("WHERE name LIKE '%abc%'");        // → false
 * ```
 */
export function detectPGPattern(sql: string): boolean {
  return findPatternRanges(sql).length > 0;
}

// ────────────────────────────────────────────────────────────
//  Private helpers — scan
// ────────────────────────────────────────────────────────────

/** A located pattern operator with its content ranges. */
interface PatternRange {
  /** Human‑readable tag (e.g. 'ILIKE', '~*') */
  tag: string;
  /** Character index where the LHS expression starts */
  lhsStart: number;
  /** Extracted LHS expression text (the expression before the operator) */
  lhsExpr: string;
  /** Character index where the operator text starts */
  opStart: number;
  /** Character index where the operator text ends (exclusive) */
  opEnd: number;
  /** Character index where the RHS pattern string starts (the opening quote) */
  rhsStart: number;
  /** Character index where the RHS pattern string ends (after closing quote) */
  rhsEnd: number;
  /** RHS pattern string content, with surrounding quotes */
  rhsPattern: string;
  /** RHS quote character used */
  rhsQuote: string;
  /** Optional ESCAPE clause (character, or empty string if absent) */
  escapeChar: string;
}

/**
 * Walk the SQL string character‑by‑character, tracking string literals,
 * and collect all PG pattern operator occurrences.
 */
function findPatternRanges(sql: string): PatternRange[] {
  const ranges: PatternRange[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    // ── Handle string literals – skip to end of string ──────────
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      i++;
      while (i < len) {
        if (sql[i] === quote) {
          // Check for doubled quote (escaped quote in some dialects)
          if (i + 1 < len && sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++; // past closing quote
          break;
        }
        i++;
      }
      continue;
    }

    // ── Check for `ILIKE` keyword ───────────────────────────────
    if (
      sql[i] === 'I' || sql[i] === 'i'
    ) {
      const ilikeMatch = sql.substring(i).match(/^ILIKE\b/i);
      if (ilikeMatch && isAtBoundary(sql, i)) {
        const opEnd = i + ilikeMatch[0].length;
        const range = extractRangeAround(sql, i, opEnd, 'ILIKE');
        if (range) {
          ranges.push(range);
          i = range.rhsEnd;
          continue;
        }
      }
    }

    // ── Check for `SIMILAR TO` keyword pair ─────────────────────
    if (
      sql[i] === 'S' || sql[i] === 's'
    ) {
      const simMatch = sql.substring(i).match(/^SIMILAR\s+TO\b/i);
      if (simMatch && isAtBoundary(sql, i)) {
        const opEnd = i + simMatch[0].length;
        const range = extractRangeAround(sql, i, opEnd, 'SIMILAR TO');
        if (range) {
          ranges.push(range);
          i = range.rhsEnd;
          continue;
        }
      }
    }

    // ── Check for operator symbols ──────────────────────────────
    let matched = false;
    for (const def of OP_DEFS) {
      const sym = def.symbol;
      if (sql.startsWith(sym, i) && isAtBoundary(sql, i)) {
        // Check that the character after the operator is whitespace or quote
        // to avoid false matches like `~a` in identifiers.
        const after = i + sym.length;
        if (after < len && !/\s|'|"/.test(sql[after])) {
          continue;
        }
        const opEnd = after;
        const range = extractRangeAround(sql, i, opEnd, def.op);
        if (range) {
          ranges.push(range);
          i = range.rhsEnd;
          matched = true;
          break;
        }
      }
    }

    if (matched) continue;

    // ── Skip comment lines ──────────────────────────────────────
    if (sql[i] === '-' && i + 1 < len && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }
    if (sql[i] === '/' && i + 1 < len && sql[i + 1] === '*') {
      i += 2;
      while (i + 1 < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    i++;
  }

  return ranges;
}

/**
 * Check whether `sql[pos]` is at a word boundary (start of string or
 * preceded by a non‑word/underscore character).
 */
function isAtBoundary(sql: string, pos: number): boolean {
  if (pos === 0) return true;
  const prev = sql[pos - 1];
  return /\W/.test(prev) && prev !== '_';
}

/**
 * Given the position of a pattern operator, walk backward to find the LHS
 * expression start and forward to find the RHS pattern string.
 *
 * Returns `null` if no valid RHS string literal follows the operator.
 */
function extractRangeAround(
  sql: string,
  opStart: number,
  opEnd: number,
  tag: string,
): PatternRange | null {
  // ── Find LHS expression start (walk backward) ─────────────────
  const lhsStart = findLeftExprStart(sql, opStart);
  const lhsExpr = sql.substring(lhsStart, opStart).trim();

  // ── Find RHS pattern string (walk forward) ────────────────────
  let pos = opEnd;

  // Skip whitespace
  while (pos < sql.length && /\s/.test(sql[pos])) pos++;

  if (pos >= sql.length) return null;
  if (sql[pos] !== "'" && sql[pos] !== '"') {
    // RHS must be a string literal — not a column ref or subquery
    logger.debug({ tag, position: opStart }, 'Pattern operator not followed by string literal; skipping');
    return null;
  }

  const quote = sql[pos];
  const rhsStart = pos;
  pos++; // move past opening quote

  // Find matching closing quote (handle doubled quotes within)
  while (pos < sql.length) {
    if (sql[pos] === quote) {
      if (pos + 1 < sql.length && sql[pos + 1] === quote) {
        pos += 2; // skip doubled quote
        continue;
      }
      pos++; // past closing quote
      break;
    }
    pos++;
  }

  const rhsEnd = pos;
  const rhsPattern = sql.substring(rhsStart, rhsEnd);

  // ── Check for optional ESCAPE clause ─────────────────────────
  let escapeChar = '';
  const afterRhs = sql.substring(rhsEnd).trimStart();
  const escMatch = afterRhs.match(/^ESCAPE\s+('.)'\s*/i);
  if (escMatch) {
    escapeChar = escMatch[1]; // the character between quotes
    // Adjust rhsEnd to include ESCAPE clause
    // (we'll handle this when building replacement)
  }

  return { tag, lhsStart, lhsExpr, opStart, opEnd, rhsStart, rhsEnd, rhsPattern, rhsQuote: quote, escapeChar };
}

/**
 * Walk backward from `opStart` to find where the LHS expression begins.
 *
 * Tracks parenthesis depth so that `func(a, b) ILIKE 'x'` correctly
 * identifies `func(a, b)` as the LHS.
 *
 * When depth reaches 0 and a non‑word boundary is encountered (after
 * skipping whitespace), that marks the start of the expression.
 */
function findLeftExprStart(sql: string, opStart: number): number {
  let i = opStart - 1;

  // Skip whitespace backward
  while (i >= 0 && /\s/.test(sql[i])) i--;

  // At this point `i` is at the last character of the LHS expression.
  // Walk backward tracking paren depth to find the expression start.
  // Going backward: ')' opens a group, '(' closes a group.
  let depth = 0;
  let inString = false;
  let stringChar = '';

  while (i >= 0) {
    const ch = sql[i];

    if (inString) {
      if (ch === stringChar) inString = false;
      i--;
      continue;
    }

    if (ch === "'" || ch === '"') {
      inString = true;
      stringChar = ch;
      i--;
      continue;
    }

    if (ch === ')') {
      depth++;
      i--;
      continue;
    }

    if (ch === '(') {
      if (depth === 0) {
        // We've gone past the opening paren without hitting depth 0 —
        // this means the LHS is `(expr)`, include the paren.
        // Actually we walked backward past `(`, meaning the expression
        // starts here. Return i as start.
        return i;
      }
      depth--;
      i--;
      continue;
    }

    if (depth === 0 && /\s/.test(ch)) {
      // At top-level depth, whitespace means we've reached the
      // boundary between the LHS and whatever precedes it.
      return i + 1;
    }

    i--;
  }

  // Reached start of SQL string
  return 0;
}

// ────────────────────────────────────────────────────────────
//  Private helpers — rewrite logic
// ────────────────────────────────────────────────────────────

/**
 * Convert a SIMILAR TO pattern to a POSIX ERE pattern.
 *
 * SIMILAR TO patterns support:
 *   - `%`  → any sequence (→ `.*`)
 *   - `_`  → any single char (→ `.`)
 *   - `|`  → alternation
 *   - `*`  → zero‑or‑more of preceding atom
 *   - `+`  → one‑or‑more of preceding atom
 *   - `?`  → zero‑or‑one of preceding atom
 *   - `[...]`  → character class (same as regex)
 *   - `[^...]` → negated character class
 *   - `()` → grouping
 *   - `\` → escape
 *
 * Characters that are literal in SIMILAR TO but meta in regex
 * (`.`, `^`, `$`, `{`, `}`) are backslash‑escaped.
 *
 * @param pattern - The SIMILAR TO pattern content (without surrounding quotes)
 * @param escapeChar - Optional user-specified escape character
 * @returns POSIX ERE-compatible pattern string
 */
function similarToRegex(pattern: string, escapeChar: string = '\\'): string {
  const out: string[] = [];
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    // ── Escape sequence ────────────────────────────────────────
    if (ch === escapeChar && i + 1 < len) {
      const next = pattern[i + 1];
      switch (next) {
        case '%':
        case '_':
          // Escaped wildcard → literal character
          out.push(next);
          break;
        default:
          // Pass through the escaped character; escape if it's regex meta
          out.push(regexEscapeLiteral(next));
      }
      i += 2;
      continue;
    }

    // ── LIKE wildcards ─────────────────────────────────────────
    if (ch === '%') {
      out.push('.*');
      i++;
      continue;
    }
    if (ch === '_') {
      out.push('.');
      i++;
      continue;
    }

    // ── SIMILAR TO / regex meta that mean the same thing ───────
    if (SIMILAR_META.has(ch) || ch === '(' || ch === ')') {
      out.push(ch);
      i++;
      continue;
    }

    // ── Character class — pass through directly ────────────────
    if (ch === '[') {
      // Find matching ']'
      let j = i + 1;
      if (j < len && pattern[j] === '^') j++; // negated class
      if (j < len && pattern[j] === ']') j++; // empty bracket
      while (j < len && pattern[j] !== ']') {
        if (pattern[j] === escapeChar && j + 1 < len) j++;
        j++;
      }
      if (j < len) {
        // Include the "]"
        j++;
        out.push(pattern.substring(i, j));
        i = j;
      } else {
        // Unmatched '[' — treat as literal
        out.push('\\[');
        i++;
      }
      continue;
    }

    // ── Literal characters that are regex meta ─────────────────
    out.push(regexEscapeLiteral(ch));
    i++;
  }

  return out.join('');
}

/**
 * Return a character escaped for POSIX ERE — escape meta-characters
 * that aren't part of LIKE/SIMILAR TO syntax.
 */
function regexEscapeLiteral(ch: string): string {
  // Characters that are literal in SIMILAR TO but meta in regex
  const regexMeta = new Set(['.', '^', '$', '{', '}', '\\', '[', ']', '|', '*', '+', '?', '(', ')']);
  if (regexMeta.has(ch)) {
    return '\\' + ch;
  }
  return ch;
}

/**
 * Determine if a SIMILAR TO pattern is "simple" enough for LIKE translation.
 * A simple pattern contains only `%`, `_`, and escaped literals — no `|`,
 * `*`, `+`, `?`, `(...)`, or `[...]`.
 */
function isSimpleSimilarToPattern(pattern: string, escapeChar: string): boolean {
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === escapeChar) {
      i += 2; // skip escaped char
      continue;
    }
    if (ch === '%' || ch === '_') {
      i++;
      continue;
    }
    if ('|*+?()[]'.includes(ch)) {
      return false;
    }
    i++;
  }
  return true;
}

/**
 * Build a replacement SQL snippet for a pattern operator occurrence.
 */
function buildReplacement(range: PatternRange): string {
  const { tag, lhsExpr, rhsPattern, escapeChar } = range;

  // The RHS pattern content (without surrounding quotes)
  const rawPattern = rhsPattern.substring(1, rhsPattern.length - 1);

  // Optional ESCAPE clause suffix
  const escSuffix = escapeChar ? ` ESCAPE '${escapeChar}'` : '';

  switch (tag) {
    // ── ILIKE / ~~* / !~~* → CASE‑FOLD LIKE ────────────────────
    case 'ILIKE': {
      return `LOWER(${lhsExpr}) LIKE LOWER(${rhsPattern})${escSuffix}`;
    }

    case '~~*': {
      return `LOWER(${lhsExpr}) LIKE LOWER(${rhsPattern})${escSuffix}`;
    }

    case '!~~*': {
      return `NOT (LOWER(${lhsExpr}) LIKE LOWER(${rhsPattern})${escSuffix})`;
    }

    // ── ~~ (plain LIKE) / !~~ (NOT LIKE) ──────────────────────
    case '~~': {
      return `${lhsExpr} LIKE ${rhsPattern}${escSuffix}`;
    }

    case '!~~': {
      return `NOT (${lhsExpr} LIKE ${rhsPattern}${escSuffix})`;
    }

    // ── SIMILAR TO → LIKE (simple) or REGEXP (complex) ─────────
    case 'SIMILAR TO': {
      const esc = escapeChar || '\\';
      if (isSimpleSimilarToPattern(rawPattern, esc)) {
        // Simple pattern — just use LIKE
        return `${lhsExpr} LIKE ${rhsPattern}${escSuffix}`;
      }
      // Complex pattern — convert to REGEXP
      const regexPattern = similarToRegex(rawPattern, esc);
      return `${lhsExpr} REGEXP '${regexPattern}' /* SIMILAR TO → REGEXP; ensure REGEXP function is registered */`;
    }

    // ── ~ (regex match) — needs REGEXP udf ─────────────────────
    case '~': {
      return `${lhsExpr} REGEXP ${rhsPattern} /* requires registered REGEXP function */`;
    }

    case '~*': {
      return `${lhsExpr} REGEXP ${rhsPattern} /* case‑insensitive REGEXP; requires registered REGEXP function */`;
    }

    case '!~': {
      return `NOT (${lhsExpr} REGEXP ${rhsPattern}) /* requires registered REGEXP function */`;
    }

    case '!~*': {
      return `NOT (${lhsExpr} REGEXP ${rhsPattern}) /* case‑insensitive REGEXP; requires registered REGEXP function */`;
    }

    default:
      // Unknown — return the original LHS + operator + RHS unchanged
      return `${lhsExpr} ${tag} ${rhsPattern}`;
  }
}

// ────────────────────────────────────────────────────────────
//  Public API — rewrite
// ────────────────────────────────────────────────────────────

/**
 * Rewrite PostgreSQL pattern matching operators to SQLite-compatible syntax.
 *
 * @param sql - A SQL query string that may contain PG pattern operators
 * @returns A `PatternResult` with the rewritten SQL, a flag indicating whether
 *   a rewrite occurred, and a list of detected pattern types.
 *
 * @example
 * ```ts
 * rewritePGPattern("SELECT * FROM t WHERE name ILIKE '%abc%'");
 * // → { sql: "SELECT * FROM t WHERE LOWER(name) LIKE LOWER('%abc%')",
 * //     rewritten: true,
 * //     patterns: ['ILIKE'] }
 *
 * rewritePGPattern("SELECT * FROM t WHERE val ~ '^foo'");
 * // → { sql: "SELECT * FROM t WHERE val REGEXP '^foo' ˝ requires REGEXP func ˝",
 * //     rewritten: true,
 * //     patterns: ['~'] }
 * ```
 */
export function rewritePGPattern(sql: string): PatternResult {
  const trimmed = sql.trim();

  // ── Detect all pattern operator occurrences ──────────────────
  const ranges = findPatternRanges(trimmed);

  if (ranges.length === 0) {
    return { sql: trimmed, rewritten: false, patterns: [] };
  }

  // ── Collect unique pattern tags ───────────────────────────────
  const uniquePatterns = [...new Set(ranges.map((r) => r.tag))];

  logger.info(
    { patterns: uniquePatterns, occurrences: ranges.length },
    'PatternRewriter: found PG pattern operators',
  );

  // ── Build the rewritten SQL ───────────────────────────────────
  const parts: string[] = [];
  let lastEnd = 0;

  for (const range of ranges) {
    // Collect any text that precedes this pattern occurrence
    if (range.lhsStart > lastEnd) {
      parts.push(trimmed.substring(lastEnd, range.lhsStart));
    }

    const replacement = buildReplacement(range);
    parts.push(replacement);

    // Set lastEnd to the end of the original RHS + any ESCAPE clause
    let rhsEnd = range.rhsEnd;
    const afterRhs = trimmed.substring(rhsEnd).trimStart();
    const escMatch = afterRhs.match(/^ESCAPE\s+('.)'\s*/i);
    if (escMatch) {
      rhsEnd += trimmed.substring(rhsEnd).length - afterRhs.length + escMatch[0].length;
    }

    lastEnd = rhsEnd;
  }

  // Append any remaining text after the last occurrence
  if (lastEnd < trimmed.length) {
    parts.push(trimmed.substring(lastEnd));
  }

  const result = parts.join('');

  logger.info(
    { patterns: uniquePatterns, originalLength: trimmed.length, resultLength: result.length },
    'PatternRewriter: rewrite complete',
  );

  return { sql: result, rewritten: true, patterns: uniquePatterns };
}

// ────────────────────────────────────────────────────────────
//  Public API — REGEXP registration
// ────────────────────────────────────────────────────────────

/**
 * Register a SQLite `REGEXP` function that uses JavaScript `RegExp` for
 * case‑sensitive matching.
 *
 * SQLite has a built‑in hook for `REGEXP` but ships with no default
 * implementation. This function registers one on the provided SQLite
 * database instance so that queries rewritten by `rewritePGPattern()`
 * (when they contain `~` / `~*` / `!~` / `!~*` operators) can execute
 * successfully.
 *
 * **Case sensitivity:**
 *   - `~`  (regex match) uses case‑sensitive matching
 *   - `~*` (case‑insensitive regex match) uses `/i` flag
 *
 * Both are controlled by the same `REGEXP` function; callers who need
 * case‑insensitive regex should pass the `/i` flag inline in their
 * pattern or rely on the dual‑function registration via
 * `registerRegexpFunction()` below.
 *
 * @param db - A better-sqlite3 or compatible SQLite database instance.
 *   Must expose a `function(name, argc, fn)` method for registering
 *   scalar functions.
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { registerRegexpFunction } from './PatternRewriter';
 *
 * const db = new Database(':memory:');
 * registerRegexpFunction(db);
 *
 * // Now queries like:
 * //   SELECT * FROM t WHERE name REGEXP '^foo'
 * // will execute correctly.
 * ```
 */
export function registerRegexpFunction(db: any): void {
  if (typeof db.function !== 'function') {
    logger.error(
      'Provided database instance does not expose a `.function()` method. ' +
      'REGEXP registration requires better-sqlite3 or a compatible binding.',
    );
    return;
  }

  // Case‑sensitive REGEXP (~)
  db.function('regexp', 2, (pattern: string, value: string) => {
    if (value == null) return 0;
    try {
      const re = new RegExp(pattern);
      return re.test(String(value)) ? 1 : 0;
    } catch (err) {
      logger.error({ err, pattern }, 'REGEXP evaluation error');
      return 0;
    }
  });

  logger.info('REGEXP function registered (case‑sensitive)');
}

/**
 * Register dual SQLite REGEXP functions — one case‑sensitive (`~`)
 * and one case‑insensitive (`~*` — registered as `regexp_isens`).
 *
 * The default `REGEXP` hook always calls the single‑argument version
 * `regexp(pattern, value)`. For case‑insensitive matching, operators
 * like `~*` can be rewritten to `REGEXP` with the `/i` flag baked into
 * the pattern. This function also registers `regexp_isens` for use by
 * custom SQL wrappers that prefer an explicit function name.
 *
 * @param db - A better-sqlite3 or compatible SQLite database instance
 *
 * @example
 * ```ts
 * import Database from 'better-sqlite3';
 * import { registerRegexpFunctionDual } from './PatternRewriter';
 *
 * const db = new Database(':memory:');
 * registerRegexpFunctionDual(db);
 * ```
 */
export function registerRegexpFunctionDual(db: any): void {
  if (typeof db.function !== 'function') {
    logger.error(
      'Provided database instance does not expose a `.function()` method.',
    );
    return;
  }

  // Case‑sensitive (for `~` and `!~` operators)
  db.function('regexp', 2, (pattern: string, value: string) => {
    if (value == null) return 0;
    try {
      const re = new RegExp(pattern);
      return re.test(String(value)) ? 1 : 0;
    } catch (err) {
      logger.error({ err, pattern }, 'REGEXP (case‑sensitive) evaluation error');
      return 0;
    }
  });

  // Case‑insensitive (for `~*` and `!~*` operators)
  db.function('regexp_isens', 2, (pattern: string, value: string) => {
    if (value == null) return 0;
    try {
      const re = new RegExp(pattern, 'i');
      return re.test(String(value)) ? 1 : 0;
    } catch (err) {
      logger.error({ err, pattern }, 'REGEXP (case‑insensitive) evaluation error');
      return 0;
    }
  });

  logger.info('Dual REGEXP functions registered (regexp, regexp_isens)');
}

// ────────────────────────────────────────────────────────────
//  Public API — batch rewrite (convenience)
// ────────────────────────────────────────────────────────────

/**
 * Convenience function that both rewrites PG patterns in a SQL string AND
 * registers REGEXP on the provided database in a single call.
 *
 * This is a shorthand for calling `rewritePGPattern(sql)` followed by
 * `registerRegexpFunction(db)` when the rewrite involves regex operators.
 *
 * @param sql - A SQL query string that may contain PG pattern operators
 * @param db - SQLite database instance
 * @returns A `PatternResult` with the rewritten SQL and detected patterns
 *
 * @example
 * ```ts
 * const { sql: rewritten } = rewriteAndRegister(
 *   "SELECT * FROM t WHERE name ~ '^foo'",
 *   db,
 * );
 * // rewritten === "SELECT * FROM t WHERE name REGEXP '^foo' ˝ requires REGEXP func ˝"
 * ```
 */
export function rewriteAndRegister(sql: string, db: any): PatternResult {
  const result = rewritePGPattern(sql);

  if (result.patterns.some((p) => p === '~' || p === '~*' || p === '!~' || p === '!~*')) {
    registerRegexpFunction(db);
  }

  return result;
}
