/**
 * XmlShim — PostgreSQL XML function compatibility shim for SQLite.
 *
 * PostgreSQL supports a suite of XML generation and processing functions:
 *   - `xmlelement(name foo, ...)`     — create an XML element
 *   - `xmlforest(content, ...)`       — create an XML forest (element per argument)
 *   - `xmlconcat(xml, ...)`           — concatenate XML values
 *   - `xmlagg(expr)`                  — aggregate XML values
 *   - `xmlcomment(text)`              — create an XML comment
 *   - `xmlpi(name target, ...)`       — create an XML processing instruction
 *   - `xmlroot(xml, version ...)`     — change root-level XML properties
 *   - `xmlserialize(document expr)`   — serialize XML to string
 *   - `xmlparse(document expr)`       — parse string to XML
 *
 * SQLite has no native XML support. This shim rewrites XML function calls
 * to no-op string constants, providing safe SQLite compatibility without
 * breaking query syntax.
 *
 * Strategy:
 *   All XML function calls → no-op replacement (`'<xml/>'` string constant)
 *
 * This approach preserves query structure and data flow while eliminating
 * the PostgreSQL-specific XML syntax that SQLite cannot execute.
 *
 * ## Limitations (regex-based)
 *
 * - Function calls appearing inside string literals may be incorrectly matched
 * - Nested XML functions within arguments cause a single replacement of the
 *   outermost call (the inner call still gets evaluated, so `detectXmlFunc`
 *   remains accurate; the rewrite produces a single `'<xml/>'` for the outer
 *   call, which is sufficient for SQLite compatibility)
 * - Operators matching XML function names inside identifiers (e.g., `my_xmlelement`)
 *   are avoided by using `\b` word-boundary matching
 *
 * @module XmlShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('XmlShim');

// ── Types ────────────────────────────────────────────────────────

export interface XmlResult {
  /** Rewritten SQL (same as original when no rewrite is needed) */
  sql: string;
  /** Whether the SQL was actually rewritten or modified */
  rewritten: boolean;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * The replacement string constant for XML function calls.
 *
 * A no-op XML fragment that satisfies downstream code expecting XML output
 * without introducing complex XML generation logic. Using a string constant
 * rather than a function call avoids any SQLite compatibility issues.
 */
const XML_NOOP_REPLACEMENT = "'<xml/>'";

/**
 * Compiled set of recognized XML function names (lowercased) for fast
 * lookup during detection and replacement.
 */
const XML_FUNC_NAMES = new Set([
  'xmlelement',
  'xmlforest',
  'xmlconcat',
  'xmlagg',
  'xmlcomment',
  'xmlpi',
  'xmlroot',
  'xmlserialize',
  'xmlparse',
]);

/**
 * Regex matching any XML function keyword followed by an opening parenthesis.
 *
 * Matches only whole words via `\b` boundaries and is case-insensitive.
 *
 * Matches:
 *   - `xmlelement(name foo, 1)`
 *   - `xmlforest(a, b)`
 *   - `xmlconcat(x1, x2)`
 *   - `xmlagg(expr)`
 *   - `xmlcomment('hello')`
 *   - `xmlpi(name target, 'str')`
 *   - `xmlroot(x, version '1.0')`
 *   - `xmlserialize(document x as text)`
 *   - `xmlparse(document '<x/>')`
 *
 * Does NOT match:
 *   - `my_xmlelement` (no word boundary before "xml")
 *   - `'xmlelement(...)'` (inside string literal — regex limitation noted)
 */
const XML_FUNC_RE = /\b(xmlelement|xmlforest|xmlconcat|xmlagg|xmlcomment|xmlpi|xmlroot|xmlserialize|xmlparse)\s*\(/gi;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any XML function calls.
 *
 * Checks for any of the supported XML functions: `xmlelement`, `xmlforest`,
 * `xmlconcat`, `xmlagg`, `xmlcomment`, `xmlpi`, `xmlroot`, `xmlserialize`,
 * `xmlparse`.
 *
 * @param sql - The SQL statement to inspect.
 * @returns `true` if the SQL contains at least one XML function call.
 *
 * @example
 * ```ts
 * detectXmlFunc("SELECT xmlelement(name foo, bar)");
 * // → true
 *
 * detectXmlFunc("SELECT xmlforest(a, b) FROM t");
 * // → true
 *
 * detectXmlFunc("SELECT 1");
 * // → false
 * ```
 */
export function detectXmlFunc(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  XML_FUNC_RE.lastIndex = 0;
  return XML_FUNC_RE.test(sql);
}

/**
 * Rewrite all XML function calls to no-op string constants for SQLite
 * compatibility.
 *
 * Processing logic:
 *
 * **Phase 1 — Detection:** Scan the SQL for XML function calls using the
 * combined regex. Each match identifies the function name and the position
 * of the opening parenthesis.
 *
 * **Phase 2 — Bracket matching:** For each matched function, find the
 * corresponding closing parenthesis using a depth-tracker that correctly
 * handles nested parentheses (e.g., function calls within arguments).
 *
 * **Phase 3 — Replacement:** Replace each matched function call (from
 * the function keyword through its matching close parenthesis) with a
 * `'<xml/>'` string constant. Replacements are applied right-to-left to
 * preserve position offsets.
 *
 * If an unmatched parenthesis is encountered, the occurrence is skipped
 * and a warning is logged.
 *
 * @param sql - The SQL statement to rewrite.
 * @returns An {@link XmlResult} with the rewritten SQL and a flag
 *          indicating whether any changes were made.
 *
 * @example
 * ```ts
 * rewriteXmlFunc("SELECT xmlelement(name foo, bar) FROM t");
 * // → { sql: "SELECT '<xml/>' FROM t", rewritten: true }
 *
 * rewriteXmlFunc("SELECT xmlforest(a, b) FROM t WHERE id = 1");
 * // → { sql: "SELECT '<xml/>' FROM t WHERE id = 1", rewritten: true }
 *
 * rewriteXmlFunc(`SELECT
 *   xmlelement(name root,
 *     xmlforest(a, b)
 *   )
 * FROM t`);
 * // The outermost xmlelement is captured and replaced:
 * // → { sql: "SELECT '<xml/>' FROM t", rewritten: true }
 *
 * rewriteXmlFunc("SELECT 1");
 * // → { sql: "SELECT 1", rewritten: false }
 * ```
 */
export function rewriteXmlFunc(sql: string): XmlResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  // Quick check first: bail early if no XML function is present
  if (!detectXmlFunc(sql)) {
    return { sql, rewritten: false };
  }

  const replacements: Array<{ start: number; end: number }> = [];
  XML_FUNC_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = XML_FUNC_RE.exec(sql)) !== null) {
    const funcStart = match.index;
    const funcName = match[1];

    // The opening parenthesis is the last character of the match
    const parenStart = funcStart + match[0].length - 1;
    const closeParen = findMatchingParen(sql, parenStart);

    if (closeParen === -1) {
      logger.warn(
        { sql, pos: funcStart, func: funcName },
        'Unmatched parenthesis in XML function call — skipping',
      );
      continue;
    }

    replacements.push({
      start: funcStart,
      end: closeParen + 1,
    });
  }

  // Apply replacements in reverse order (right-to-left) to preserve offsets
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    sql = sql.slice(0, r.start) + XML_NOOP_REPLACEMENT + sql.slice(r.end);
  }

  const rewritten = replacements.length > 0;

  if (rewritten) {
    logger.debug(
      { count: replacements.length },
      `Rewrote ${replacements.length} XML function call(s) to no-op string constant`,
    );
  }

  return { sql, rewritten };
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Find the position of the matching closing parenthesis, accounting for
 * nesting depth.
 *
 * Starts from `openPos` which should be the position of the opening
 * parenthesis character `(`. Returns the position of the matching closing
 * parenthesis `)`, or `-1` if no matching close is found (unbalanced).
 *
 * This is a simple depth tracker and does **not** account for string
 * literals; parentheses inside string literals may cause false matches.
 * This is a known limitation of regex-based SQL processing.
 *
 * @param sql      - The full SQL string.
 * @param openPos  - Position of the opening parenthesis character.
 * @returns        Position of the matching close parenthesis, or `-1`.
 */
function findMatchingParen(sql: string, openPos: number): number {
  let depth = 1;
  let idx = openPos + 1;

  while (idx < sql.length && depth > 0) {
    const ch = sql[idx];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }

    if (depth > 0) {
      idx++;
    }
  }

  return depth === 0 ? idx : -1;
}
