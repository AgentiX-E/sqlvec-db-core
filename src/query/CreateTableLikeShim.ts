/**
 * CreateTableLikeShim — PostgreSQL CREATE TABLE ... LIKE compatibility shim for SQLite.
 *
 * PostgreSQL supports `CREATE TABLE t (LIKE source_table [INCLUDING ...])` to copy
 * a table's column structure from an existing table. SQLite has no equivalent syntax.
 *
 * ## Syntax Mapping
 *
 * | PG Syntax                                                | Rewritten SQL (SQLite)                       |
 * |:---------------------------------------------------------|:---------------------------------------------|
 * | `CREATE TABLE t (LIKE src)`                              | `CREATE TABLE t AS SELECT * FROM src WHERE 1=0` |
 * | `CREATE TABLE t (LIKE src INCLUDING ALL)`                | `CREATE TABLE t AS SELECT * FROM src LIMIT 0`   |
 * | `CREATE TABLE t (LIKE src INCLUDING DEFAULTS)`           | `CREATE TABLE t AS SELECT * FROM src LIMIT 0`   |
 * | `CREATE TABLE t (col1 INT, LIKE src)`                    | `CREATE TABLE t (col1 INT)`                    |
 * | `SELECT * FROM users`                                    | (pass-through, unchanged)                      |
 *
 * ## Strategy
 *
 * ### Pure LIKE (entire column list is one or more LIKE clauses)
 * Replace the entire `(LIKE source [...] )` with `AS SELECT * FROM source WHERE 1=0`.
 * When INCLUDING options are present, use `LIMIT 0` instead of `WHERE 1=0` to signal
 * that structure-carrying options were requested.
 *
 * ### Mixed (custom columns + LIKE clause)
 * Strip the LIKE clause(s) from the column definition list, keeping custom columns
 * intact. This is a conservative downgrade — the LIKE clause is dropped because SQLite
 * cannot express it, but user-defined columns are preserved.
 *
 * ### No LIKE found
 * Pass the SQL through unchanged.
 *
 * ### Multiple source tables (e.g. `(LIKE a, LIKE b)`)
 * When multiple LIKE clauses reference different source tables, only the first source
 * table is used for the AS SELECT rewrite in the pure case. In the mixed case, all
 * LIKE clauses are removed from the column list.
 *
 * ## Edge Cases
 * - Quoted table names (double-quoted identifiers) are handled.
 * - Schema-qualified names (`schema.table`) are preserved.
 * - Quoted source table names have their quotes stripped for the AS SELECT target.
 * - `CREATE TABLE IF NOT EXISTS` and `CREATE TEMP TABLE` prefix handling.
 * - Trailing semicolons are stripped on output for cleanliness.
 * - Non-CREATE-TABLE SQL passes through unchanged.
 *
 * @module CreateTableLikeShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { skipSqlLiteral } from './SqlLiteralScanner';

const logger = PinoLogger.forComponent('CreateTableLikeShim');

// ── Types ────────────────────────────────────────────────────────

export interface CreateTableLikeResult {
  /** Rewritten SQL (unchanged if no LIKE clause found) */
  sql: string;
  /** Whether a CREATE TABLE LIKE pattern was detected and rewritten */
  rewritten: boolean;
}

// ── Constants — Regex Patterns ──────────────────────────────────

/**
 * Detects whether any INCLUDING or EXCLUDING options are present in the LIKE clause.
 * Used to decide between `WHERE 1=0` and `LIMIT 0`.
 */
const INCLUDING_OPTIONS_RE = /\b(?:INCLUDING|EXCLUDING)\s+(?:DEFAULTS|CONSTRAINTS|INDEXES|STORAGE|COMMENTS|ALL)\b/i;

/**
 * Strips trailing semicolons and excess whitespace from the end of SQL.
 */
const TRAILING_SEMICOLON_RE = /\s*;+\s*$/;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL CREATE TABLE
 * with a LIKE clause.
 *
 * This is a lightweight boolean check — it does not validate the full SQL syntax
 * or confirm the statement is syntactically valid.
 *
 * @param sql - The raw SQL string to inspect.
 * @returns `true` if a CREATE TABLE LIKE pattern is detected.
 *
 * @example
 * ```ts
 * detectCreateTableLike('CREATE TABLE t (LIKE users)');                         // true
 * detectCreateTableLike('CREATE TABLE t (LIKE users INCLUDING ALL)');           // true
 * detectCreateTableLike('CREATE TABLE t (col1 INT, LIKE users)');               // true
 * detectCreateTableLike('CREATE TABLE t (col1 INT NOT NULL)');                   // false
 * detectCreateTableLike('SELECT * FROM users WHERE name LIKE \'%foo%\'');         // false
 * ```
 */
export function detectCreateTableLike(sql: string): boolean {
  return analyzeCreateTableLike(sql) !== null;
}

/**
 * Structural analysis of a `CREATE TABLE ... LIKE` statement.
 *
 * Returns `null` when the input is not a CREATE TABLE statement containing a
 * LIKE clause. Otherwise returns the source table name (with quoting preserved)
 * and whether INCLUDING/EXCLUDING options are present.
 */
interface LikeAnalysis {
  /** Source table name with quoting preserved (e.g. `users`, `"My Table"`). */
  sourceTable: string;
  /** True when INCLUDING/EXCLUDING options are present. */
  hasOptions: boolean;
  /** The string before the opening paren (e.g. `CREATE TABLE t`). */
  beforeOpen: string;
  /** Raw content between the outermost parens. */
  colContent: string;
  /** True when the column list is entirely LIKE clauses (no custom columns). */
  isPureLike: boolean;
}

function analyzeCreateTableLike(sql: string): LikeAnalysis | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }
  const trimmed = sql.trim();

  // Must start with CREATE [TEMP|TEMPORARY] TABLE [IF NOT EXISTS].
  const headMatch = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(
    trimmed,
  );
  if (headMatch === null) {
    return null;
  }

  // Extract the outermost parenthesized column list (literal-aware).
  const paren = extractParenContent(trimmed);
  if (paren === null) {
    return null;
  }

  // Locate the first LIKE clause within the column content, ignoring literals.
  const like = findLikeClause(paren.colContent);
  if (like === null) {
    return null;
  }

  const hasOptions = INCLUDING_OPTIONS_RE.test(paren.colContent);
  const isPureLike = isOnlyLikeClauses(paren.colContent);

  return {
    sourceTable: like.sourceTable,
    hasOptions,
    beforeOpen: paren.beforeOpen,
    colContent: paren.colContent,
    isPureLike,
  };
}

/**
 * Rewrite a PostgreSQL `CREATE TABLE ... LIKE` statement into SQLite-compatible SQL.
 *
 * ## Processing Rules
 *
 * | Input                                                    | Output                                       | `rewritten` |
 * |:---------------------------------------------------------|:---------------------------------------------|:-----------:|
 * | `CREATE TABLE t (LIKE src)`                              | `CREATE TABLE t AS SELECT * FROM src WHERE 1=0` | `true`    |
 * | `CREATE TABLE t (LIKE src INCLUDING ALL)`                | `CREATE TABLE t AS SELECT * FROM src LIMIT 0`   | `true`    |
 * | `CREATE TABLE t (col1 INT, LIKE src)`                    | `CREATE TABLE t (col1 INT)`                  | `true`      |
 * | `CREATE TABLE t (col1 INT, LIKE src, col2 TEXT)`         | `CREATE TABLE t (col1 INT, col2 TEXT)`       | `true`      |
 * | `CREATE TABLE t (col1 INT)` (no LIKE)                    | `CREATE TABLE t (col1 INT)`                  | `false`     |
 * | `SELECT * FROM users`                                    | `SELECT * FROM users`                        | `false`     |
 * | Empty/null input                                         | `{ sql: '', rewritten: false }`              | `false`     |
 *
 * ## Implementation Details
 *
 * ### Pure LIKE Case
 * When the column definition list consists entirely of LIKE clause(s), the
 * entire `(LIKE ...)` block is replaced with an `AS SELECT * FROM source ...`
 * clause. This creates an empty table with the same column structure as the
 * source.
 *
 * - Without INCLUDING options → `WHERE 1=0` (zero rows, structure only)
 * - With INCLUDING options   → `LIMIT 0` (zero rows, signals structure intent)
 *
 * ### Mixed Case
 * When custom column definitions appear alongside LIKE clause(s), the LIKE
 * clauses are stripped out. This is a conservative degradation — the custom
 * columns are preserved, but the structure from the source table is lost.
 *
 * @param sql - The raw SQL string to process.
 * @returns A `CreateTableLikeResult` with the rewritten SQL and
 *          whether any transformation was applied.
 *
 * @example
 * ```ts
 * rewriteCreateTableLike('CREATE TABLE t (LIKE users)');
 * // → { sql: 'CREATE TABLE t AS SELECT * FROM users WHERE 1=0', rewritten: true }
 *
 * rewriteCreateTableLike('CREATE TABLE t (LIKE users INCLUDING ALL)');
 * // → { sql: 'CREATE TABLE t AS SELECT * FROM users LIMIT 0', rewritten: true }
 *
 * rewriteCreateTableLike('CREATE TABLE t (col1 INT, LIKE users)');
 * // → { sql: 'CREATE TABLE t (col1 INT)', rewritten: true }
 *
 * rewriteCreateTableLike('CREATE TABLE t (col1 INT)');
 * // → { sql: 'CREATE TABLE t (col1 INT)', rewritten: false }
 * ```
 */
export function rewriteCreateTableLike(sql: string): CreateTableLikeResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql: '', rewritten: false };
  }

  const trimmed = sql.trim();

  const analysis = analyzeCreateTableLike(trimmed);
  if (analysis === null) {
    return { sql: trimmed, rewritten: false };
  }

  const { sourceTable, hasOptions, beforeOpen, colContent, isPureLike } = analysis;
  const zeroRowsClause = hasOptions ? 'LIMIT 0' : 'WHERE 1=0';

  let result: string;

  if (isPureLike) {
    // Pure LIKE case: replace the entire column block with an AS SELECT.
    result = `${beforeOpen} AS SELECT * FROM ${sourceTable} ${zeroRowsClause}`;
  } else {
    // Mixed case: strip all LIKE clauses, preserving custom columns.
    const cleanedCols = stripLikeClauses(colContent);
    result = `${beforeOpen} (${cleanedCols})`;
  }

  // Strip trailing semicolons for cleanliness.
  result = result.replace(TRAILING_SEMICOLON_RE, '');

  const hasChanged = result !== trimmed.replace(TRAILING_SEMICOLON_RE, '');

  if (hasChanged) {
    logger.debug(
      { before: trimmed, after: result, sourceTable, isPureLike, hasOptions },
      'CREATE TABLE LIKE syntax rewritten for SQLite compatibility',
    );
  }

  return { sql: result, rewritten: hasChanged };
}

/**
 * Strip all LIKE clauses from a column definition list (mixed case), returning
 * the remaining custom-column text with comma artifacts cleaned up.
 *
 * @param colContent - Raw text between the outermost parens.
 * @returns The column content with LIKE clauses removed.
 */
function stripLikeClauses(colContent: string): string {
  // Remove each LIKE clause (with its preceding comma when applicable) by
  // scanning left-to-right and skipping literal spans.
  const spans: Array<{ start: number; end: number }> = [];
  const len = colContent.length;
  let i = 0;

  while (i < len) {
    const skipped = skipSqlLiteral(colContent, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    // Detect a LIKE clause at `i`.
    if (/\bLIKE\b/i.test(colContent.slice(i, i + 4)) && isWordBoundaryStart(colContent, i)) {
      let clauseEnd = scanLikeClauseEnd(colContent, i);
      if (clauseEnd === -1) {
        // A `LIKE` keyword with no parseable source name is still a LIKE
        // fragment; treat just the keyword as the removable span so it does
        // not linger as a stray identifier.
        clauseEnd = i + 'LIKE'.length;
      }

      // Extend the span backwards over a preceding comma.
      let start = i;
      let j = i;
      while (j > 0 && /\s/.test(colContent[j - 1])) j--;
      if (j > 0 && colContent[j - 1] === ',') {
        start = j - 1;
      }

      spans.push({ start, end: clauseEnd });
      i = clauseEnd;
      continue;
    }

    i++;
  }

  // Apply spans right-to-left.
  let out = colContent;
  for (const s of spans.slice().sort((a, b) => b.start - a.start)) {
    out = out.slice(0, s.start) + out.slice(s.end);
  }

  // Clean up dangling/double commas and normalize comma spacing.
  return out
    .replace(/,\s*,/g, ',')
    .replace(/^\s*,/, '')
    .replace(/,\s*$/, '')
    .replace(/\s*,\s*/g, ', ')
    .trim();
}

/** True when `at` is a valid start-of-word boundary for the LIKE keyword. */
function isWordBoundaryStart(sql: string, at: number): boolean {
  return at === 0 || !/[A-Za-z0-9_$]/.test(sql[at - 1]);
}

/**
 * Scan a `LIKE source [options...]` clause beginning at `start` (which points
 * at the `L` of LIKE). Returns the index just past the clause, or `-1` when the
 * clause cannot be parsed.
 */
function scanLikeClauseEnd(sql: string, start: number): number {
  let i = start + 'LIKE'.length;

  const skipWs = () => {
    while (i < sql.length && /\s/.test(sql[i])) i++;
  };

  // Source table name: quoted identifier or qualified dotted name. Reuse the
  // same reader as findLikeClause so extraction and stripping stay consistent.
  const read = readSourceTableName(sql, i);
  if (read === null) return -1;
  i = read.end;

  // Optionally consume INCLUDING/EXCLUDING <option> sequences.
  for (;;) {
    skipWs();
    const opt = /^(INCLUDING|EXCLUDING)\s+(DEFAULTS|CONSTRAINTS|INDEXES|STORAGE|COMMENTS|ALL)\b/i.exec(
      sql.slice(i),
    );
    if (opt === null) break;
    i += opt[0].length;
  }

  return i;
}

/**
 * Extract the source table name from the LIKE clause in a CREATE TABLE statement.
 *
 * Returns the first table name referenced in a LIKE clause. If the name is
 * double-quoted, the quotes are stripped from the returned value.
 *
 * @param sql - The SQL string to examine.
 * @returns The source table name, or `null` if no LIKE clause is found.
 *
 * @example
 * ```ts
 * extractLikeTableName('CREATE TABLE t (LIKE users)');           // 'users'
 * extractLikeTableName('CREATE TABLE t (LIKE "My Table")');     // 'My Table'
 * extractLikeTableName('CREATE TABLE t (LIKE public.users)');   // 'public.users'
 * extractLikeTableName('CREATE TABLE t (col1 INT)');            // null
 * ```
 */
export function extractLikeTableName(sql: string): string | null {
  const analysis = analyzeCreateTableLike(sql);
  return analysis === null ? null : analysis.sourceTable;
}

// ── Internal Helpers ─────────────────────────────────────────────

/**
 * Extract content between the outermost matching parentheses.
 *
 * Simple paren-counting parser that handles sql-level nesting. Does not
 * account for string literals that contain parens — this is acceptable
 * for CREATE TABLE column lists where the `( ... )` block around column
 * definitions is the outermost pair and the content inside has matching
 * depth (e.g. DEFAULT expressions, CHECK constraints).
 *
 * @param sql - The full SQL string containing parenthesized content.
 * @returns Object with `beforeOpen`, `colContent`, and `afterClose` strings,
 *          or `null` if parentheses are unbalanced or absent.
 */
function extractParenContent(
  sql: string,
): { beforeOpen: string; colContent: string; afterClose: string } | null {
  // Locate the first opening paren outside any literal/comment.
  let openIdx = -1;
  let pos = 0;
  while (pos < sql.length) {
    const skipped = skipSqlLiteral(sql, pos);
    if (skipped !== -1) {
      pos = skipped;
      continue;
    }
    if (sql[pos] === '(') {
      openIdx = pos;
      break;
    }
    pos++;
  }
  if (openIdx === -1) {
    return null;
  }

  let depth = 0;
  let closeIdx = -1;

  for (let i = openIdx; i < sql.length; ) {
    const skipped = skipSqlLiteral(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const ch = sql[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
    i++;
  }

  if (closeIdx === -1) {
    return null; // Unbalanced parens
  }

  return {
    beforeOpen: sql.substring(0, openIdx).trim(),
    colContent: sql.substring(openIdx + 1, closeIdx),
    afterClose: sql.substring(closeIdx + 1),
  };
}

/**
 * Check whether the given column definition content consists entirely
 * of LIKE clauses (no custom column definitions).
 *
 * This works by stripping all LIKE clauses from the content. If nothing
 * meaningful remains (or only commas/whitespace), the content is pure LIKE.
 *
 * @param columnContent - The raw string between the outermost parentheses.
 * @returns `true` if the content is only LIKE clauses.
 *
 * @example
 * ```ts
 * isOnlyLikeClauses('LIKE users');                    // true
 * isOnlyLikeClauses('LIKE users, LIKE profiles');    // true
 * isOnlyLikeClauses('col1 INT, LIKE users');          // false
 * isOnlyLikeClauses('col1 INT NOT NULL');             // false
 * ```
 */
function isOnlyLikeClauses(columnContent: string): boolean {
  const stripped = stripLikeClauses(columnContent);
  // After removing LIKE clauses, only commas/whitespace remain → pure LIKE.
  return stripped.replace(/\s*,\s*/g, '').trim().length === 0;
}

/**
 * Locate the first LIKE clause in column-list content, returning its source
 * table name (quoting preserved). Returns `null` when no LIKE clause is found.
 */
function findLikeClause(content: string): { sourceTable: string } | null {
  const len = content.length;
  let i = 0;
  while (i < len) {
    const skipped = skipSqlLiteral(content, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }

    if (
      /^LIKE\b/i.test(content.slice(i, i + 4)) &&
      isWordBoundaryStart(content, i)
    ) {
      const read = readSourceTableName(content, i + 'LIKE'.length);
      if (read === null) return null;
      return { sourceTable: read.name };
    }

    i++;
  }
  return null;
}

/**
 * Read a (possibly schema-qualified, possibly quoted) source table name
 * starting at `pos` (just past the LIKE keyword). Returns the verbatim name
 * (quoting preserved) plus the index just past the name, or `null` when no
 * valid name follows.
 */
function readSourceTableName(
  content: string,
  pos: number,
): { name: string; end: number } | null {
  const len = content.length;
  let i = pos;
  while (i < len && /\s/.test(content[i])) i++;
  if (i >= len) return null;

  const start = i;
  if (content[i] === '"') {
    const close = findQuotedIdentifierEnd(content, i);
    if (close === -1) return null;
    i = close;
  } else {
    const ident = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(content.slice(i));
    if (ident === null) return null;
    i += ident[0].length;
  }

  // Consume a dotted chain of quoted/unquoted identifiers (`a.b`, `"a"."b"`).
  // A trailing `.` with no following identifier makes the whole name invalid.
  for (;;) {
    let j = i;
    while (j < len && /\s/.test(content[j])) j++;
    if (j >= len || content[j] !== '.') break;
    j++; // consume '.'
    while (j < len && /\s/.test(content[j])) j++;
    if (j >= len) return null; // dangling dot
    if (content[j] === '"') {
      const close = findQuotedIdentifierEnd(content, j);
      if (close === -1) return null;
      i = close;
    } else if (/[A-Za-z_]/.test(content[j])) {
      const ident = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(content.slice(j));
      if (ident === null) return null;
      i = j + ident[0].length;
    } else {
      return null;
    }
  }

  return { name: content.slice(start, i), end: i };
}

/** Index just past the closing double-quote of a quoted identifier (V.. V""). */
function findQuotedIdentifierEnd(sql: string, open: number): number {
  let i = open + 1;
  while (i < sql.length) {
    if (sql[i] === '"') {
      if (i + 1 < sql.length && sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return -1;
}
