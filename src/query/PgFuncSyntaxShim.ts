/**
 * PgFuncSyntaxShim — Rewrites PostgreSQL's keyword-style function calls into
 * the comma-separated form understood by SQLite's registered UDFs.
 *
 * PostgreSQL allows several scalar functions to be called with keyword
 * separators instead of commas:
 *
 *   extract(part FROM source)          → extract(part, source)
 *   substring(str FROM start)          → substring(str, start)
 *   substring(str FROM start FOR len)  → substring(str, start, len)
 *   substring(str FROM pat FOR esc)    → substring(str, pat, esc)
 *   position(needle IN haystack)       → position(needle, haystack)
 *
 * SQLite's grammar rejects `FROM`/`IN`/`FOR` in these positions (`near "FROM":
 * syntax error`, or `IN` parses as a subquery), even though the corresponding
 * UDFs (extract, substring, position) are already registered. This shim only
 * rewrites the interior of those specific function calls, leaving every real
 * `FROM`/`IN` clause (e.g. `SELECT ... FROM t WHERE x IN (...)`) untouched.
 *
 * @module PgFuncSyntaxShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PgFuncSyntaxShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PgFuncSyntaxResult {
  /** Rewritten SQL (standard comma-separated function calls). */
  sql: string;
  /** Whether any keyword-style function call was rewritten. */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Find the matching closing parenthesis after `open` (the '(' that follows the
 * function name), skipping nested parentheses and respecting quoted literals
 * so a `)` inside a string is not treated as the terminator.
 */
function matchParen(sql: string, open: number): number {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingle) {
      if (ch === "'" && sql[i - 1] !== '\\') inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && sql[i - 1] !== '\\') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Rewrite a single keyword-style function call interior, replacing keyword
 * separators with commas. Returns the new interior or null if unchanged.
 */
function rewriteInterior(funcName: string, interior: string): string | null {
  const lower = funcName.toLowerCase();
  if (lower === 'extract') {
    const m = interior.match(/^([^,]+?)\s+FROM\s+(.+)$/is);
    if (m) {
      // `extract(part FROM src)` → `extract('part', src)`. The field is a PG
      // keyword (year/month/day/…) not a column, so quote it unless it is
      // already a quoted literal (e.g. extract('year' FROM x)).
      let part = m[1].trim();
      if (!/^'.*'$/.test(part)) part = `'${part}'`;
      return `${part}, ${m[2].trim()}`;
    }
  }
  if (lower === 'substring') {
    const m = interior.match(/^([^,]+?)\s+FROM\s+(.+)$/is);
    if (m) {
      const left = m[1].trim();
      const rest = m[2];
      const forMatch = rest.match(/^(.+?)\s+FOR\s+(.+)$/is);
      if (forMatch) {
        return `${left}, ${forMatch[1].trim()}, ${forMatch[2].trim()}`;
      }
      return `${left}, ${rest.trim()}`;
    }
  }
  if (lower === 'position') {
    const m = interior.match(/^([^,]+?)\s+IN\s+(.+)$/is);
    if (m) return `${m[1].trim()}, ${m[2].trim()}`;
  }
  return null;
}

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/** Regex locating a keyword-style function name immediately before `(`. */
const FUNC_CALL_RE = /\b(extract|substring|position)\s*\(/gi;

/**
 * Detect whether `sql` contains a keyword-style (FROM/IN/FOR) call for
 * extract/substring/position that needs rewriting.
 */
export function detectPgFuncSyntax(sql: string): boolean {
  if (!sql || typeof sql !== 'string') return false;
  return /\b(extract|substring|position)\s*\(\s*[^,()]*\s+(FROM|IN|FOR)\b/i.test(sql);
}

/**
 * Rewrite PG keyword-style calls for extract/substring/position into comma
 * form. Each full call (name + parentheses) is replaced atomically via an
 * explicit slice so the original interior is removed cleanly.
 */
export function rewritePgFuncSyntax(sql: string): PgFuncSyntaxResult {
  if (!sql || typeof sql !== 'string') return { sql, rewritten: false };

  let out = sql;
  let any = false;

  FUNC_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  // Rewrite right-to-left so earlier slice indices stay stable.
  const edits: Array<{ start: number; end: number; text: string }> = [];
  while ((m = FUNC_CALL_RE.exec(sql)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(sql, open);
    if (close === -1) continue;
    const interior = sql.slice(open + 1, close);
    const replacement = rewriteInterior(m[1], interior);
    if (replacement === null) continue;
    // Replace the whole call `name(...)` with `name(<rewritten>)`.
    edits.push({
      start: m.index,
      end: close + 1,
      text: `${m[1]}(${replacement})`,
    });
  }

  if (edits.length > 0) {
    any = true;
    // Apply edits from the last index backwards to keep offsets valid.
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    logger.debug('Rewrote PG keyword-style function calls');
  }

  return { sql: out, rewritten: any };
}
