/**
 * SchemaVersionShim — PostgreSQL schema version management compatibility shim for SQLite.
 *
 * PostgreSQL supports several methods for tracking schema versions:
 *
 *   - `pg_stat_file('/path/to/file')` — inspect file modification times
 *   - `pg_schema_version` (custom function) — query schema version
 *   - `information_schema.schemata` — list all schemas in the database
 *   - Direct `SELECT version FROM schema_version` — application-level version table
 *
 * SQLite has no equivalent of these. The pg_stat_file function does not exist,
 * information_schema.schemata is not available, and schema_version is a reserved
 * SQLite table (for internal PRAGMA schema_version) rather than a user table.
 *
 * ## Strategy
 *
 * In the query preprocessing pipeline, detect schema-version-related SQL and
 * rewrite it to a compatible result:
 *
 * | Input                                                              | Output                                                       | rewritten |
 * |--------------------------------------------------------------------|--------------------------------------------------------------|-----------|
 * | `SELECT * FROM information_schema.schemata`                        | `SELECT 'public' as schema_name`                             | true      |
 * | `SELECT version FROM schema_version`                               | `SELECT 1 as version`                                        | true      |
 * | `SELECT pg_stat_file('some/path')`                                 | `SELECT 1234 as size, ... as access, ... as modification, ... as change, 0 as isdir` | true |
 * | `SELECT * FROM pg_stat_file('/etc/passwd')`                        | `SELECT ... WHERE 0` (empty — blocked by DATA_DIR check)     | true      |
 * | `SELECT pg_schema_version()`                                       | `SELECT 1 as version`                                        | true      |
 * | `SELECT current_schema_version()`                                  | `SELECT 1 as version`                                        | true      |
 * | `SELECT 1;`                                                         | (pass-through)                                               | false     |
 * | `CREATE TABLE t (id int);`                                          | (pass-through)                                               | false     |
 * | `SELECT * FROM pg_stat_activity;`                                   | (pass-through)                                               | false     |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on SQL referencing user tables named `version` or `file`
 * - Schema-version queries are detected by matching the full table source/function pattern
 * - PinoLogger integration for debugging and audit trails
 *
 * @module SchemaVersionShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import * as fs from 'node:fs';
import * as path from 'node:path';

const logger = PinoLogger.forComponent('SchemaVersionShim');

/** DATA_DIR for pg_stat_file path resolution — defaults to ./data */
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve('./data');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SchemaVersionResult {
  /** Rewritten SQL (shim query if schema version detected, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as schema-version-related and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Resolve and validate a file path for pg_stat_file.
 * Ensures the resolved path is within DATA_DIR for security.
 * Returns null if the path is unsafe or cannot be resolved.
 */
function resolveSafePath(filePath: string): string | null {
  try {
    const resolved = path.resolve(DATA_DIR, filePath);
    // Security check: must be under DATA_DIR
    if (!resolved.startsWith(DATA_DIR + path.sep) && resolved !== DATA_DIR) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Format a Date as ISO-8601 timestamp string for pg_stat_file output.
 */
function formatTimestamp(d: Date): string {
  // PG pg_stat_file returns timestamps like '2024-01-15 10:30:45.123456+08'
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  const ms = String(d.getMilliseconds()).padStart(6, '0');
  const offset = -d.getTimezoneOffset();
  const tzSign = offset >= 0 ? '+' : '-';
  const tzHours = pad(Math.floor(Math.abs(offset) / 60));
  const tzMins = pad(Math.abs(offset) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${ms}${tzSign}${tzHours}:${tzMins}`;
}

/**
 * Build a SQL SELECT query returning pg_stat_file-compatible columns
 * from an fs.Stats object.
 *
 * Returns 6 columns: size, access, modification, change, isdir
 */
function buildPgStatFileSql(stats: fs.Stats): string {
  const size = stats.size;
  const access = formatTimestamp(stats.atime);
  const modification = formatTimestamp(stats.mtime);
  const change = formatTimestamp(stats.ctime);
  const isdir = stats.isDirectory() ? 1 : 0;
  return `SELECT ${size} as size, '${access}' as access, '${modification}' as modification, '${change}' as change, ${isdir} as isdir`;
}

/**
 * Matches SELECT ... FROM information_schema.schemata (with optional
 * table alias and optional WHERE / ORDER BY / LIMIT clauses).
 *
 * Pattern breakdown:
 *   ^\s*SELECT\s+     — statement must start with SELECT
 *   .*?                — any select list (columns, functions, etc.)
 *   \bFROM\s+          — FROM keyword
 *   information_schema\.schemata\b  — the target table
 *
 * Case-insensitive, multiline, handles leading whitespace.
 */
const INFO_SCHEMA_SCHEMATA_RE =
  /^\s*SELECT\b[\s\S]*?\bFROM\s+information_schema\.schemata\b/im;

/**
 * Matches SELECT ... FROM schema_version (bare table reference).
 *
 * This handles queries of the form:
 *   SELECT version FROM schema_version
 *   SELECT * FROM schema_version
 *   SELECT schema_version FROM schema_version
 *
 * Uses word boundary after `schema_version` to avoid matching
 * `schema_versions` or `schema_version_history`.
 */
const SCHEMA_VERSION_TABLE_RE =
  /^\s*SELECT\b[\s\S]*?\bFROM\s+schema_version\b/im;

/**
 * Matches calls to pg_stat_file(...).
 *
 * Pattern:
 *   pg_stat_file\s*\(  — function name + opening paren
 *   [^)]*              — arguments (any characters except closing paren)
 *   \)                 — closing paren
 *
 * Handles both:
 *   SELECT pg_stat_file('file')
 *   SELECT * FROM pg_stat_file('/path')
 */
const PG_STAT_FILE_RE = /pg_stat_file\s*\([^)]*\)/i;

/**
 * Matches calls to pg_schema_version() or current_schema_version().
 *
 * Pattern covers:
 *   pg_schema_version()          — standard PG custom function
 *   current_schema_version()     — common variant
 *   pg_schema_version(1)         — with optional argument
 *
 * Word boundaries ensure we don't match table columns named
 * similarly (e.g., `SELECT pg_schema_version_column FROM t`).
 */
const SCHEMA_VERSION_FUNC_RE =
  /\b(?:pg_schema_version|current_schema_version)\s*\([^)]*\)/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string contains a PostgreSQL schema version
 * management query that would fail or behave incorrectly in SQLite.
 *
 * Triggers on:
 *   - Queries against `information_schema.schemata`
 *   - Queries against a table named `schema_version`
 *   - Calls to `pg_stat_file(...)`
 *   - Calls to `pg_schema_version(...)` or `current_schema_version(...)`
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a schema-version-related query
 *
 * @example
 * ```ts
 * detectSchemaVersion("SELECT * FROM information_schema.schemata");               // true
 * detectSchemaVersion("SELECT version FROM schema_version");                      // true
 * detectSchemaVersion("SELECT pg_stat_file('data/pg_version')");                  // true
 * detectSchemaVersion("SELECT pg_schema_version()");                              // true
 * detectSchemaVersion("SELECT current_schema_version()");                         // true
 * detectSchemaVersion("SELECT 1");                                                // false
 * detectSchemaVersion("SELECT * FROM pg_stat_activity");                          // false
 * ```
 */
export function detectSchemaVersion(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast path: must start with SELECT or contain function call
  const startsWithSelect = /^\s*SELECT\b/i.test(trimmed);

  // ── Check 1: SELECT ... FROM information_schema.schemata ──
  if (startsWithSelect && INFO_SCHEMA_SCHEMATA_RE.test(trimmed)) {
    return true;
  }

  // ── Check 2: SELECT ... FROM schema_version ──
  if (startsWithSelect && SCHEMA_VERSION_TABLE_RE.test(trimmed)) {
    return true;
  }

  // ── Check 3: pg_stat_file(...) function call ──
  if (PG_STAT_FILE_RE.test(trimmed)) {
    return true;
  }

  // ── Check 4: pg_schema_version() or current_schema_version() function call ──
  if (SCHEMA_VERSION_FUNC_RE.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Rewrite a PostgreSQL schema version management query to a SQLite-compatible
 * result.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. If the SQL does **not** match any schema-version pattern, return unchanged
 *    with `rewritten: false`.
 * 3. If the SQL matches a known pattern, replace with a compatible result query:
 *    - `information_schema.schemata`  → `SELECT 'public' as schema_name`
 *    - `schema_version` table        → `SELECT 1 as version`
 *    - `pg_stat_file(...)`           → real fs.statSync call with 6 columns (size, access, modification, change, isdir)
 *    - `pg_schema_version`/`current_schema_version`  → `SELECT 1 as version`
 *
 * Priority order (evaluated top-to-bottom, first match wins):
 *   1. information_schema.schemata
 *   2. schema_version table
 *   3. pg_stat_file
 *   4. pg_schema_version / current_schema_version
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link SchemaVersionResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteSchemaVersion("SELECT * FROM information_schema.schemata");
 * // → { sql: "SELECT 'public' as schema_name", rewritten: true }
 *
 * rewriteSchemaVersion("SELECT version FROM schema_version");
 * // → { sql: 'SELECT 1 as version', rewritten: true }
 *
 * rewriteSchemaVersion("SELECT pg_stat_file('data/version')");
 * // → { sql: "SELECT '' as file", rewritten: true }
 *
 * rewriteSchemaVersion("SELECT 1;");
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteSchemaVersion(sql: string): SchemaVersionResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Must start with SELECT to be a candidate ──
  const startsWithSelect = /^\s*SELECT\b/i.test(trimmed);

  // ── Step 2: Check patterns in priority order ──

  // Priority 1: information_schema.schemata
  if (startsWithSelect && INFO_SCHEMA_SCHEMATA_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'information_schema.schemata detected — rewriting to constant result',
    );
    return {
      sql: "SELECT 'public' as schema_name",
      rewritten: true,
    };
  }

  // Priority 2: schema_version table
  if (startsWithSelect && SCHEMA_VERSION_TABLE_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'schema_version table query detected — rewriting to constant result',
    );
    return {
      sql: 'SELECT 1 as version',
      rewritten: true,
    };
  }

  // Priority 3: pg_stat_file(...) — real file stat
  if (PG_STAT_FILE_RE.test(trimmed)) {
    // Extract the first string argument from pg_stat_file('path') or pg_stat_file("path")
    const argMatch = trimmed.match(/pg_stat_file\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
    if (argMatch && argMatch[1]) {
      const filePath = argMatch[1];
      const resolvedPath = resolveSafePath(filePath);
      if (resolvedPath) {
        try {
          const stats = fs.statSync(resolvedPath);
          const realSql = buildPgStatFileSql(stats);
          logger.debug(
            { original: trimmed, resolvedPath, filePath },
            'pg_stat_file() — returning real file metadata',
          );
          return {
            sql: realSql,
            rewritten: true,
          };
        } catch (err: any) {
          // File not found or permission denied → empty result (PG behaviour)
          if (err.code === 'ENOENT' || err.code === 'EACCES') {
            logger.debug(
              { original: trimmed, resolvedPath, errCode: err.code },
              'pg_stat_file() — file not found, returning empty result',
            );
            return {
              sql: "SELECT 0 as size, '' as access, '' as modification, '' as change, 0 as isdir WHERE 0",
              rewritten: true,
            };
          }
          // Other errors → also empty result
          logger.warn(
            { original: trimmed, resolvedPath, errCode: err.code },
            'pg_stat_file() — stat error, returning empty result',
          );
          return {
            sql: "SELECT 0 as size, '' as access, '' as modification, '' as change, 0 as isdir WHERE 0",
            rewritten: true,
          };
        }
      }
    }
    // Could not parse path or path outside DATA_DIR → empty result
    logger.debug(
      { original: trimmed },
      'pg_stat_file() — path invalid or outside DATA_DIR, returning empty result',
    );
    return {
      sql: "SELECT 0 as size, '' as access, '' as modification, '' as change, 0 as isdir WHERE 0",
      rewritten: true,
    };
  }

  // Priority 4: pg_schema_version() / current_schema_version()
  if (SCHEMA_VERSION_FUNC_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'schema version function call detected — rewriting to constant result',
    );
    return {
      sql: 'SELECT 1 as version',
      rewritten: true,
    };
  }

  // ── Step 3: No schema-version pattern matched — pass through ──
  return {
    sql: trimmed,
    rewritten: false,
  };
}
