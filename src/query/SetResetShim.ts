/**
 * SetResetShim — Detects and handles PostgreSQL SET/RESET statements for SQLite compatibility.
 *
 * PostgreSQL SET/RESET statements adjust session or local runtime configuration.
 * SQLite has no equivalent runtime configuration mechanism, so these statements
 * are either silently ignored (no-op) or, where applicable, mapped to the
 * existing SqlVec infrastructure.
 *
 * ## Supported patterns
 *
 * ### SET variants (all treated as no-op by default):
 * ```sql
 * SET statement_timeout = '5min';       -- parameter = value
 * SET SESSION statement_timeout = '10s';  -- SESSION keyword prefix
 * SET LOCAL timezone = 'UTC';            -- LOCAL keyword prefix
 * SET search_path TO my_schema, public;  -- parameter TO value list
 * SET TIME ZONE 'UTC';                   -- special TIME ZONE variant
 * SET NAMES 'UTF8';                      -- special NAMES variant
 * ```
 *
 * ### RESET variants (all treated as no-op):
 * ```sql
 * RESET statement_timeout;              -- reset specific parameter
 * RESET ALL;                            -- reset all parameters
 * RESET SESSION statement_timeout;      -- with SESSION prefix
 * RESET LOCAL timezone;                 -- with LOCAL prefix
 * ```
 *
 * ## Strategy
 * 1. Detect SET/RESET statements via case-insensitive regex
 * 2. Extract parameter name for potential future mapping
 * 3. Return no-op result (empty SQL string) for all variants
 *
 * ## Mappable parameters (future work)
 * - `statement_timeout` → maps to SqlVec's QueryTimeout infrastructure
 * - `timezone` → reserved for future timezone support
 * - `search_path` → reserved for future schema resolution
 *
 * ## Key guarantees
 * - All handled output is valid (empty string = skipped execution)
 * - No false positives on SQL containing 'SET' as identifier or in strings
 * - Detection is conservative: only top-level SET/RESET statements
 * - PinoLogger integration for debugging and audit trails
 */

import { PinoLogger } from '../logger/PinoLogger';
import { GucSystem } from '../core/GucSystem';

const logger = PinoLogger.forComponent('SetResetShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SetResetResult {
  /** Rewritten SQL (empty string for no-op, original if not handled) */
  sql: string;
  /** Whether a SET/RESET was detected and processed */
  rewritten: boolean;
  /** Whether the statement was safely ignored (no-op) */
  noop: boolean;
  /** Extracted parameter name, if applicable */
  parameter?: string;
  /** Extracted parameter value, if applicable */
  value?: string;
}

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a top-level SET statement.
 * Captures: (full match prefix) (SESSION|LOCAL|TEMP|TEMPORARY)? (parameter name) (rest including value)
 *
 * Groups:
 *   1 – SESSION | LOCAL | TEMP | TEMPORARY (optional)
 *   2 – Parameter name (identifier)
 *   3 – The value part after = or TO
 *
 * Covers:
 *   SET parameter = value
 *   SET SESSION parameter = value
 *   SET LOCAL parameter = value
 *   SET parameter TO value
 *   SET SESSION parameter TO value
 *   SET TIME ZONE '...'
 *   SET NAMES '...'
 */
const SET_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?(?:TIME\s+ZONE|NAMES\s+)?([A-Za-z_][A-Za-z0-9_]*)?(?:\s*[=:]\s*|\s+TO\s+)(.+?)\s*;?\s*$/i;

/**
 * Simplified pattern for SET without value (less common, e.g. SET enable_seqscan)
 */
const SET_BOOLEAN_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+|TEMP(?:ORARY)?\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|$)\s*$/i;

/**
 * Pattern for SET TIME ZONE (special syntax)
 *   SET TIME ZONE 'UTC';
 *   SET TIME ZONE LOCAL;
 */
const SET_TIMEZONE_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?TIME\s+ZONE\s+(.+?)\s*;?\s*$/i;

/**
 * Matches SET NAMES 'encoding' (PG special syntax).
 * Per PG spec, SET NAMES is equivalent to SET client_encoding.
 *
 * Groups:
 *   1 – The encoding value (e.g. 'UTF8', 'SJIS')
 *
 * Covers:
 *   SET NAMES 'UTF8'
 *   SET SESSION NAMES 'UTF8'
 *   SET LOCAL NAMES 'UTF8'
 */
const SET_NAMES_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?NAMES\s+(.+?)\s*;?\s*$/i;

/**
 * Matches a top-level RESET statement.
 * Groups:
 *   1 – SESSION | LOCAL (optional)
 *   2 – Parameter name (identifier) or ALL
 *
 * Covers:
 *   RESET parameter;
 *   RESET ALL;
 *   RESET SESSION parameter;
 *   RESET LOCAL parameter;
 */
const RESET_PATTERN = /^\s*RESET\s+(?:SESSION\s+|LOCAL\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*;?\s*$/i;

/**
 * Matches RESET ALL (special case for broader match)
 */
const RESET_ALL_PATTERN = /^\s*RESET\s+(?:SESSION\s+|LOCAL\s+)?ALL\s*;?\s*$/i;

/**
 * Top-level detection patterns — check if SQL *looks like* a SET or RESET
 * at the start of the statement (non-whitespace, case-insensitive).
 * We keep these separate from the parse patterns to allow for
 * future expansion.
 */
const SET_START_PATTERN = /^\s*SET\s+/i;
const RESET_START_PATTERN = /^\s*RESET\s+/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a SET or RESET statement.
 *
 * Performs a case-insensitive check for SET/RESET as the first keyword
 * in the statement. This is intentionally broad to catch all PG variants.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a SET or RESET statement
 *
 * @example
 * ```ts
 * detectSetReset('SET statement_timeout = \'5min\'');     // true
 * detectSetReset('RESET ALL;');                            // true
 * detectSetReset('SELECT * FROM users');                   // false
 * ```
 */
export function detectSetReset(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check before attempting regex
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('SET ') &&
    !upper.startsWith('SET;') &&
    !upper.startsWith('RESET ')
  ) {
    return false;
  }

  // Confirm with regex — catches SESSION/LOCAL prefixes after SET/RESET
  return (
    SET_START_PATTERN.test(trimmed) || RESET_START_PATTERN.test(trimmed)
  );
}

/**
 * Handle a SET or RESET SQL statement.
 *
 * For SQLite compatibility, most PostgreSQL SET/RESET statements are
 * treated as no-ops (safely ignored). Notable exceptions:
 *   - `SET/RESET statement_timeout` is wired into GucSystem (noop: false)
 *   - `SET NAMES` and `SET/RESET client_encoding` are stored in GucSystem
 *
 * **Processing rules:**
 * | Input                           | Output                          | noop |
 * |---------------------------------|--------------------------------|------|
 * | `SET statement_timeout = val`   | `{ sql: '', noop: false }`     | no*  |
 * | `RESET statement_timeout`       | `{ sql: '', noop: false }`     | no*  |
 * | `SET parameter = value`         | `{ sql: '', noop: true }`      | yes  |
 * | `SET parameter TO value`        | `{ sql: '', noop: true }`      | yes  |
 * | `SET SESSION parameter = value` | `{ sql: '', noop: true }`      | yes  |
 * | `SET LOCAL parameter = value`   | `{ sql: '', noop: true }`      | yes  |
 * | `SET TIME ZONE 'UTC'`           | `{ sql: '', noop: true }`      | yes  |
 * | `RESET parameter`               | `{ sql: '', noop: true }`      | yes  |
 * | `RESET ALL`                     | `{ sql: '', noop: true }`      | yes  |
 * | Non-SET/RESET SQL               | `{ sql: <original>, noop: false, rewritten: false }` | no |
 *   * statement_timeout is actively handled — value stored in GucSystem
 *
 * @param sql   The raw SQL string to process
 * @returns     A SetResetResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = handleSetReset("SET statement_timeout = '5min'");
 * // → { sql: '', rewritten: true, noop: false, parameter: 'statement_timeout', value: "'5min'" }
 *
 * const result = handleSetReset("RESET statement_timeout");
 * // → { sql: '', rewritten: true, noop: false, parameter: 'statement_timeout' }
 *
 * const result = handleSetReset("RESET ALL;");
 * // → { sql: '', rewritten: true, noop: true, parameter: 'ALL' }
 * ```
 */
export function handleSetReset(sql: string): SetResetResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
      noop: false,
    };
  }

  const trimmed = sql.trim();

  // ── Check RESET patterns first ─────────────────────────

  // RESET ALL (special case — no parameter name, just 'ALL')
  const resetAllMatch = trimmed.match(RESET_ALL_PATTERN);
  if (resetAllMatch) {
    logger.debug({ sql: trimmed }, 'RESET ALL detected — treating as no-op');
    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: 'ALL',
    };
  }

  // RESET parameter (with optional SESSION/LOCAL)
  const resetMatch = trimmed.match(RESET_PATTERN);
  if (resetMatch) {
    const paramName = resetMatch[1];
    const paramLower = paramName.toLowerCase();

    // Wire statement_timeout reset into GucSystem — it's actively handled, not a no-op
    if (paramLower === 'statement_timeout') {
      try {
        GucSystem.getDefaultInstance().registry.reset('statement_timeout');
      } catch {
        // GucSystem not available, silently ignore
      }
      logger.debug({ sql: trimmed }, 'RESET statement_timeout — restored default in GucSystem');
      return {
        sql: '',
        rewritten: true,
        noop: false,
        parameter: paramName,
      };
    }

    logger.debug({ sql: trimmed, parameter: paramName }, 'RESET detected — treating as no-op');

    // Store in GucSystem for known parameters
    if (paramLower === 'client_encoding') {
      try {
        GucSystem.getDefaultInstance().registry.reset('client_encoding');
      } catch {
        // GucSystem not available, silently ignore
      }
    }

    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: paramName,
    };
  }

  // ── Check SET patterns ─────────────────────────────────

  // SET TIME ZONE (special syntax: SET TIME ZONE value)
  const tzMatch = trimmed.match(SET_TIMEZONE_PATTERN);
  if (tzMatch) {
    const value = tzMatch[1].trim();
    logger.debug({ sql: trimmed, value }, 'SET TIME ZONE detected — treating as no-op');
    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: 'timezone',
      value,
    };
  }

  // SET NAMES 'encoding' (special syntax — per PG spec, equivalent to SET client_encoding)
  const namesMatch = trimmed.match(SET_NAMES_PATTERN);
  if (namesMatch) {
    const rawValue = namesMatch[1].trim();
    const cleanedValue = rawValue.replace(/^['"]|['"]$/g, '');
    logger.debug({ sql: trimmed, value: cleanedValue }, 'SET NAMES detected — storing as client_encoding in GucSystem');
    try {
      GucSystem.getDefaultInstance().registry.set('client_encoding', cleanedValue);
    } catch {
      // GucSystem not available, silently ignore
    }
    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: 'client_encoding',
      value: cleanedValue,
    };
  }

  // SET parameter = value / SET parameter TO value
  const setMatch = trimmed.match(SET_PATTERN);
  if (setMatch) {
    const paramName = setMatch[1] ?? null;
    const value = setMatch[2]?.trim() ?? '';

    // Wire known GUC parameters that require active handling (not just no-op storage)

    // statement_timeout is actively handled: parse PG time interval, store in GucSystem
    if (paramName && paramName.toLowerCase() === 'statement_timeout' && value) {
      const msValue = parsePgTimeInterval(value);
      if (!isNaN(msValue)) {
        try {
          GucSystem.getDefaultInstance().handleSet('statement_timeout', String(msValue));
        } catch {
          // GucSystem not available, silently ignore
        }
      }
      logger.debug(
        { sql: trimmed, value, ms: msValue },
        'SET statement_timeout — stored in GucSystem',
      );
      return {
        sql: '',
        rewritten: true,
        noop: false,
        parameter: 'statement_timeout',
        value,
      };
    }

    logger.debug(
      { sql: trimmed, parameter: paramName, value },
      'SET detected — treating as no-op',
    );

    // Store known GUC parameters in GucSystem for pg_settings compatibility
    if (paramName && typeof paramName === 'string') {
      const paramLower = paramName.toLowerCase();
      if (paramLower === 'client_encoding' && value) {
        const cleanedValue = value.replace(/^['"]|['"]$/g, '');
        try {
          GucSystem.getDefaultInstance().registry.set('client_encoding', cleanedValue);
        } catch {
          // GucSystem not available, silently ignore
        }
      }
    }

    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: paramName ?? undefined,
      value: value || undefined,
    };
  }

  // SET boolean param (SET enable_seqscan without value)
  const setBoolMatch = trimmed.match(SET_BOOLEAN_PATTERN);
  if (setBoolMatch) {
    const paramName = setBoolMatch[1];
    logger.debug({ sql: trimmed, parameter: paramName }, 'SET (boolean) detected — treating as no-op');
    return {
      sql: '',
      rewritten: true,
      noop: true,
      parameter: paramName,
      value: 'on', // PG default for SET without value
    };
  }

  // ── Not a SET/RESET statement ───────────────────────────

  return {
    sql: trimmed,
    rewritten: false,
    noop: false,
  };
}

/**
 * Extract the parameter name from a SET or RESET SQL statement.
 *
 * Returns the first identifier after SET/RESET (and optional SESSION/LOCAL).
 * For `RESET ALL`, returns `'ALL'`.
 *
 * @param sql   The raw SQL string
 * @returns     The parameter name, or `null` if not a SET/RESET statement
 *              or if the parameter name cannot be extracted
 *
 * @example
 * ```ts
 * extractSetParameter("SET statement_timeout = '5min'");   // 'statement_timeout'
 * extractSetParameter("RESET statement_timeout");           // 'statement_timeout'
 * extractSetParameter("RESET ALL");                         // 'ALL'
 * extractSetParameter("SELECT 1");                          // null
 * ```
 */
export function extractSetParameter(sql: string): string | null {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return null;
  }

  const trimmed = sql.trim();

  // Try RESET patterns first
  const resetAllMatch = trimmed.match(RESET_ALL_PATTERN);
  if (resetAllMatch) {
    return 'ALL';
  }

  const resetMatch = trimmed.match(RESET_PATTERN);
  if (resetMatch) {
    return resetMatch[1];
  }

  // Try SET TIME ZONE
  const tzMatch = trimmed.match(SET_TIMEZONE_PATTERN);
  if (tzMatch) {
    return 'timezone';
  }

  // Try SET NAMES
  const namesMatch = trimmed.match(SET_NAMES_PATTERN);
  if (namesMatch) {
    return 'client_encoding';
  }

  // Try SET parameter = value
  const setMatch = trimmed.match(SET_PATTERN);
  if (setMatch && setMatch[1]) {
    return setMatch[1];
  }

  // Try SET boolean
  const setBoolMatch = trimmed.match(SET_BOOLEAN_PATTERN);
  if (setBoolMatch) {
    return setBoolMatch[1];
  }

  return null;
}

// ──────────────────────────────────────────────
//  Internal helpers (exported for testing)
// ──────────────────────────────────────────────

/**
 * Check if a string starts with SET or RESET followed by whitespace.
 * Case-insensitive. Used internally by detectSetReset for fast filtering.
 *
 * @internal Exported for unit testing only.
 */
export function _isSetOrResetStart(s: string): boolean {
  return SET_START_PATTERN.test(s) || RESET_START_PATTERN.test(s);
}

// ──────────────────────────────────────────────
//  ALTER DEFAULT PRIVILEGES detection
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement is ALTER DEFAULT PRIVILEGES.
 *
 * This statement is not a SET/RESET — it's handled by DefaultPrivilegeManager.
 * This function allows the caller to detect and route accordingly.
 *
 * @example
 * ```ts
 * detectAlterDefaultPrivileges("ALTER DEFAULT PRIVILEGES FOR ROLE r GRANT SELECT ON TABLES TO g");
 * // → true
 * ```
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is ALTER DEFAULT PRIVILEGES
 */
export function detectAlterDefaultPrivileges(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }
  return /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\s/i.test(sql.trim());
}

/**
 * Handle an ALTER DEFAULT PRIVILEGES SQL statement.
 *
 * This returns a result indicating the statement was detected but needs
 * to be handled by DefaultPrivilegeManager for full processing.
 * The SetResetShim itself does not process ALTER DEFAULT PRIVILEGES.
 *
 * @param sql   The raw SQL string to process
 * @returns     A SetResetResult indicating the handling outcome
 */
export function handleAlterDefaultPrivileges(sql: string): SetResetResult {
  if (!detectAlterDefaultPrivileges(sql)) {
    return { sql, rewritten: false, noop: false };
  }

  logger.debug({ sql: sql.trim() }, 'ALTER DEFAULT PRIVILEGES detected — deferring to DefaultPrivilegeManager');

  // Return the SQL as-is with rewritten=false so the caller knows to
  // route this to DefaultPrivilegeManager instead of executing it
  return {
    sql: sql.trim(),
    rewritten: false,
    noop: true,
    parameter: 'default_privileges',
  };
}

// ══════════════════════════════════════════════
//  PG time interval parsing
// ══════════════════════════════════════════════

/**
 * Parse a PostgreSQL time interval string to milliseconds.
 *
 * Supports the following formats:
 *   - Bare number: '5000' → 5000 (treated as raw ms)
 *   - '5min' → 300000
 *   - '10s' → 10000
 *   - '30s' → 30000
 *   - '1h' → 3600000
 *   - '100ms' → 100
 *   - '0' → 0 (disabled)
 *
 * Values may be surrounded by single or double quotes (e.g. "'5min'").
 *
 * @param value  Raw value string, possibly quoted
 * @returns      Milliseconds, or NaN if the format is not parseable
 *
 * @example
 * ```ts
 * parsePgTimeInterval("'5min'")   // 300000
 * parsePgTimeInterval('10s')      // 10000
 * parsePgTimeInterval('0')        // 0
 * parsePgTimeInterval('invalid')  // NaN
 * ```
 */
export function parsePgTimeInterval(value: string): number {
  const cleaned = stripQuotes(value);

  // Try bare integer (e.g. '0', '5000') — treat as raw ms
  const rawInt = parseInt(cleaned, 10);
  if (!isNaN(rawInt) && String(rawInt) === cleaned) {
    return rawInt;
  }

  // Try suffix pattern: number + (ms|s|min|h)
  const match = cleaned.match(/^(\d+(?:\.\d+)?)\s*(ms|s|min|h)$/i);
  if (match) {
    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    switch (unit) {
      case 'ms':  return Math.round(num);
      case 's':   return Math.round(num * 1000);
      case 'min': return Math.round(num * 60000);
      case 'h':   return Math.round(num * 3600000);
    }
  }

  return NaN;
}

/**
 * Strip surrounding single or double quotes from a string.
 * Returns the trimmed, unquoted string.
 */
function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).trim();
  }
  return s;
}

// ══════════════════════════════════════════════
//  ALTER SYSTEM SET detection
// ══════════════════════════════════════════════

const ALTER_SYSTEM_SET_RE = /^\s*ALTER\s+SYSTEM\s+SET\s+(\w+)\s*=\s*/i;

/**
 * Detect whether a SQL statement is a general ALTER SYSTEM SET.
 * Returns true for non-MFA, non-encryption ALTER SYSTEM SET.
 */
export function detectAlterSystemSet(sql: string): boolean {
  if (typeof sql !== 'string') return false;
  const trimmed = sql.trim();
  // Skip MFA and encryption shims (handled elsewhere)
  if (/ALTER\s+SYSTEM\s+SET\s+mfa\./i.test(trimmed)) return false;
  if (/ALTER\s+SYSTEM\s+SET\s+encryption\./i.test(trimmed)) return false;
  return ALTER_SYSTEM_SET_RE.test(trimmed);
}

/**
 * Handle a generic ALTER SYSTEM SET statement.
 * Stores the GUC parameter-value pair in GucSystem.
 */
export function handleAlterSystemSet(sql: string): SetResetResult {
  if (!detectAlterSystemSet(sql)) {
    return { sql, rewritten: false, noop: false };
  }
  // Parse "ALTER SYSTEM SET param = value [;]"
  const match = sql.trim().match(/ALTER\s+SYSTEM\s+SET\s+(\w+)\s*=\s*(.+)/i);
  if (match) {
    const param = match[1].toLowerCase();
    let value = match[2].trim().replace(/';?\s*$/, '').replace(/^'/, '').trim();
    try {
      GucSystem.getDefaultInstance().registry.set(param, value);
    } catch {
      // GucSystem not available, silently ignore
    }
    logger.debug({ param, value }, 'ALTER SYSTEM SET stored in GucSystem');
  }
  return { sql: '', rewritten: true, noop: true, parameter: match?.[1] ?? 'unknown' };
}
