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

import { PinoLogger } from '../monitoring/PinoLogger';

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
 * Detects a CREATE TABLE statement that contains a LIKE clause inside
 * its column definition list.
 *
 * Cases matched (whitespace-tolerant):
 *   CREATE TABLE t (LIKE src)
 *   CREATE TABLE t (col1 INT, LIKE src)
 *   CREATE TABLE IF NOT EXISTS t (LIKE src INCLUDING ALL)
 *   CREATE TEMP TABLE t (LIKE src)
 *   CREATE TEMPORARY TABLE t (LIKE src)
 *
 * The regex checks for:
 *   1. `CREATE TABLE` at the start (optional IF NOT EXISTS, TEMP/TEMPORARY)
 *   2. A valid table name (unquoted or double-quoted identifier)
 *   3. An opening `(`
 *   4. The `LIKE` keyword somewhere inside the parens
 *
 * False-positive risk is minimal because `LIKE` as a keyword inside a
 * CREATE TABLE column list is a PG-only construct. Columns with `LIKE`
 * in a DEFAULT expression (e.g., `col TEXT DEFAULT ('LIKE this')`) are
 * possible but extremely rare in practice.
 */
const CREATE_TABLE_LIKE_DETECT_RE =
  /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]+")(?:\s*\.\s*(?:[A-Za-z_][A-Za-z0-9_]*|"[^"]+"))?\s*\([^)]*\bLIKE\s+/i;

/**
 * Matches a single LIKE clause inside a CREATE TABLE column definition.
 *
 * This is used to:
 *   1. Extract the source table name (capture group 1).
 *   2. Remove LIKE clauses when rewriting a mixed column list.
 *
 * The clause format:
 *   LIKE source_table [INCLUDING|EXCLUDING DEFAULTS|CONSTRAINTS|INDEXES|STORAGE|COMMENTS|ALL] ...
 *
 * The `INCLUDING` / `EXCLUDING` keywords can repeat with different options.
 *
 * Capture groups:
 *   [1] Source table name (may be double-quoted), e.g. `users`, `"My Table"`, `public.users`
 */
const LIKE_CLAUSE_RE =
  /\bLIKE\s+((?:"[^"]+")|(?:[A-Za-z_][A-Za-z0-9_.]*))\s*(?:(?:INCLUDING|EXCLUDING)\s+(?:DEFAULTS|CONSTRAINTS|INDEXES|STORAGE|COMMENTS|ALL)\s*)*/gi;

/**
 * Simplified regex to extract the source table name from the first LIKE clause.
 *
 * Capture group 1 – Source table name (may be double-quoted).
 */
const LIKE_TABLE_NAME_SIMPLE_RE = /\bLIKE\s+((?:"[^"]+")|(?:[A-Za-z_][A-Za-z0-9_.]*))/i;

/**
 * Matches a LIKE clause with its preceding comma and surrounding whitespace.
 * Used to strip LIKE elements from a mixed column definition list while
 * preserving the comma separation between remaining custom columns.
 *
 * This ensures that `col1 INT, LIKE src, col2 TEXT` correctly becomes
 * `col1 INT, col2 TEXT`.
 */
const LIKE_CLAUSE_WITH_COMMA_RE =
  /\s*,\s*\bLIKE\s+((?:"[^"]+")|(?:[A-Za-z_][A-Za-z0-9_.]*))\s*(?:(?:INCLUDING|EXCLUDING)\s+(?:DEFAULTS|CONSTRAINTS|INDEXES|STORAGE|COMMENTS|ALL)\s*)*/gi;

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
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return CREATE_TABLE_LIKE_DETECT_RE.test(sql.trim());
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

  // ── Early exit: no LIKE clause found ──────────────────────────
  if (!detectCreateTableLike(trimmed)) {
    return { sql: trimmed, rewritten: false };
  }

  // ── Extract source table name from the first LIKE clause ──────

  const sourceTable = extractLikeTableName(trimmed);

  // Safety check: if detection passed but extraction failed, pass through.
  // This shouldn't happen in practice but guards against regex edge cases.
  if (sourceTable === null) {
    logger.warn(
      { sql: trimmed },
      'detectCreateTableLike() returned true but extractLikeTableName() returned null; passing through',
    );
    return { sql: trimmed, rewritten: false };
  }

  // ── Determine the LIMIT clause strategy ───────────────────────

  // When INCLUDING/EXCLUDING options are present, use LIMIT 0 to signal
  // that structure-related options were involved in the original syntax.
  const hasOptions = INCLUDING_OPTIONS_RE.test(trimmed);
  const zeroRowsClause = hasOptions ? 'LIMIT 0' : 'WHERE 1=0';

  // ── Extract the column definition content between parens ──────

  const parenResult = extractParenContent(trimmed);

  if (parenResult === null) {
    // Malformed SQL — unbalanced or missing parens. Pass through.
    logger.warn({ sql: trimmed }, 'Could not find balanced parentheses; passing through');
    return { sql: trimmed, rewritten: false };
  }

  const columnContent = parenResult.colContent.trim();

  // ── Determine if this is a pure-LIKE or mixed column list ─────

  const isPureLike = isOnlyLikeClauses(columnContent);

  // ── Apply the rewrite ─────────────────────────────────────────

  let result: string;

  if (isPureLike) {
    // ── Pure LIKE case ──────────────────────────────────────────
    //
    // The entire column definition block is one or more LIKE clauses.
    // Replace `(...)` with `AS SELECT * FROM source_table WHERE 1=0`.
    //
    // Examples:
    //   CREATE TABLE t (LIKE users)
    //     → CREATE TABLE t AS SELECT * FROM users WHERE 1=0
    //
    //   CREATE TABLE t (LIKE users INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
    //     → CREATE TABLE t AS SELECT * FROM users LIMIT 0

    result = `${parenResult.beforeOpen} AS SELECT * FROM ${sourceTable} ${zeroRowsClause}`;
  } else {
    // ── Mixed case ──────────────────────────────────────────────
    //
    // Custom column definitions exist alongside LIKE clause(s).
    // Strip all LIKE clauses from the column list and rebuild.
    //
    // Examples:
    //   CREATE TABLE t (col1 INT, LIKE users)
    //     → CREATE TABLE t (col1 INT)
    //
    //   CREATE TABLE t (col1 INT, LIKE a, col2 TEXT, LIKE b)
    //     → CREATE TABLE t (col1 INT, col2 TEXT)

    let cleanedCols = columnContent
      .replace(LIKE_CLAUSE_WITH_COMMA_RE, '') // Remove `, LIKE src ...`
      .replace(LIKE_CLAUSE_RE, '')            // Remove any remaining bare `LIKE src ...`
      .trim();

    // Clean up any dangling commas or double commas
    cleanedCols = cleanedCols
      .replace(/,\s*,/g, ',')   // Double comma → single comma
      .replace(/^\s*,/, '')     // Leading comma → removed
      .replace(/,\s*$/, '')     // Trailing comma → removed
      .trim();

    result = `${parenResult.beforeOpen} (${cleanedCols})`;
  }

  // Strip trailing semicolons for cleanliness
  result = result.replace(TRAILING_SEMICOLON_RE, '');

  // ── Log and return ────────────────────────────────────────────

  const hasChanged = result !== trimmed.replace(TRAILING_SEMICOLON_RE, '');

  if (hasChanged) {
    logger.debug(
      { before: trimmed, after: result, sourceTable, isPureLike, hasOptions },
      'CREATE TABLE LIKE syntax rewritten for SQLite compatibility',
    );
  }

  return {
    sql: result,
    rewritten: hasChanged,
  };
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
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }

  const match = sql.trim().match(LIKE_TABLE_NAME_SIMPLE_RE);

  if (!match || !match[1]) {
    return null;
  }

  // Strip double quotes if present (quoted identifier), preserving
  // schema-qualified names like "schema"."table" or public.users
  const raw = match[1];
  return raw.replace(/^"|"$/g, '');
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
  const openIdx = sql.indexOf('(');

  if (openIdx === -1) {
    return null;
  }

  let depth = 0;
  let closeIdx = -1;

  for (let i = openIdx; i < sql.length; i++) {
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
  const withoutLike = columnContent
    .replace(LIKE_CLAUSE_RE, '')   // Remove LIKE clauses
    .replace(/\s*,\s*/g, '')       // Remove commas
    .trim();

  return withoutLike.length === 0;
}
