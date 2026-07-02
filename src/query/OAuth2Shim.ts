/**
 * OAuth2Shim — PostgreSQL OAuth2 configuration compatibility shim for SQLite.
 *
 * PostgreSQL extensions and tools (e.g. pgaudit, pgaudit-oauth2) support
 * OAuth2 configuration via GUC (Grand Unified Configuration) parameters
 * and ALTER ROLE statements. SQLite has no equivalent OAuth2 infrastructure,
 * so these statements must be detected and rewritten to SQLite-compatible
 * no-ops or mock responses.
 *
 * ## Supported patterns
 *
 * ### SET variants (all rewritten to `SELECT 1`):
 * ```sql
 * SET oauth2.enabled = on;
 * SET oauth2.enabled = off;
 * SET oauth2.provider = '...';
 * SET oauth2.client_id = '...';
 * SET oauth2.client_secret = '...';
 * SET oauth2.issuer = '...';
 * SET oauth2.redirect_uri = '...';
 * ```
 *
 * ### ALTER ROLE variants (all rewritten to `SELECT 1`):
 * ```sql
 * ALTER ROLE <role> SET oauth2_id = '...';
 * ```
 *
 * ### SHOW variants (return mock values):
 * ```sql
 * SHOW oauth2.enabled;
 * SHOW oauth2.provider;
 * SHOW oauth2.client_id;
 * SHOW oauth2.client_secret;
 * SHOW oauth2.issuer;
 * SHOW oauth2.redirect_uri;
 * SHOW oauth2.*;
 * ```
 *
 * ## OAuth2 parameters
 *
 * | Parameter         | Type     | SHOW mock value          |
 * |:------------------|:---------|:-------------------------|
 * | `oauth2.enabled`  | boolean  | `off`                    |
 * | `oauth2.provider` | string   | `mock`                   |
 * | `oauth2.client_id`| string   | `mock`                   |
 * | `oauth2.client_secret`| string| `mock`                   |
 * | `oauth2.issuer`   | string   | `http://mock-issuer`     |
 * | `oauth2.redirect_uri`| string | `http://mock-redirect`   |
 *
 * ## Strategy
 * 1. Detect SET/SHOW/ALTER ROLE statements referencing oauth2 parameters
 *    via case-insensitive regex
 * 2. Extract the specific oauth2 parameter name
 * 3. Rewrite SET → `SELECT 1` (no-op), ALTER ROLE → `SELECT 1` (no-op),
 *    SHOW → `SELECT '<mock>' AS <param>` (informational)
 * 4. All other SQL → Passthrough (unchanged)
 *
 * ## Key guarantees
 * - All handled output is valid SQL that SqlVec can execute
 * - No false positives on SQL containing 'oauth2' in identifiers, strings,
 *   or comments
 * - Detection is case-insensitive
 * - PinoLogger integration for debugging and audit trails
 *
 * @module OAuth2Shim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('OAuth2Shim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface OAuth2Result {
  /** Rewritten SQL (original SQL if not rewritten) */
  sql: string;
  /** Whether an OAuth2 statement was detected and processed */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants – OAuth2 parameter list
// ──────────────────────────────────────────────

/** All recognised OAuth2 configuration parameter suffixes. */
const OAUTH2_PARAMETERS = [
  'enabled',
  'provider',
  'client_id',
  'client_secret',
  'issuer',
  'redirect_uri',
] as const;

type OAuth2Parameter = (typeof OAUTH2_PARAMETERS)[number];

/**
 * Mock values returned for `SHOW oauth2.<param>` queries.
 * These indicate that SqlVec does not support OAuth2.
 */
const SHOW_MOCK_VALUES: Record<OAuth2Parameter, string> = {
  enabled: 'off',
  provider: 'mock',
  client_id: 'mock',
  client_secret: 'mock',
  issuer: 'http://mock-issuer',
  redirect_uri: 'http://mock-redirect',
};

// ──────────────────────────────────────────────
//  Constants – Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches a SET statement for an oauth2.X parameter.
 *
 * Groups:
 *   1 – The parameter suffix (e.g. `enabled`, `client_id`)
 *   2 – The value part after = or TO
 *
 * Covers:
 *   SET oauth2.enabled = on
 *   SET oauth2.provider = '...'
 *   SET oauth2.client_id = '...'
 *   SET oauth2.redirect_uri = '...'
 *   SET SESSION oauth2.enabled = on
 *   SET LOCAL oauth2.client_id = '...'
 */
const OAUTH2_SET_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?oauth2\.([a-z_]+)\s*(?:[=:]\s*|\s+TO\s+)(.+?)\s*;?\s*$/i;

/**
 * Matches an ALTER ROLE ... SET oauth2_id = '...' statement.
 *
 * Groups:
 *   1 – The role name (any identifier, possibly quoted)
 *   2 – The oauth2_id value
 *
 * Covers:
 *   ALTER ROLE myrole SET oauth2_id = 'abc123'
 *   ALTER ROLE "My Role" SET oauth2_id = 'abc123'
 *   ALTER ROLE myrole SET oauth2_id TO 'abc123'
 *   ALTER ROLE myrole IN DATABASE mydb SET oauth2_id = 'abc123'
 */
const OAUTH2_ALTER_ROLE_PATTERN = /^\s*ALTER\s+ROLE\s+(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)\s+(?:IN\s+DATABASE\s+(?:"[^"]*"|[A-Za-z_][A-Za-z0-9_]*)\s+)?SET\s+oauth2_id\s*(?:[=:]\s*|\s+TO\s+)(.+?)\s*;?\s*$/i;

/**
 * Matches a SHOW statement for an oauth2.X parameter or all oauth2 parameters.
 *
 * Groups:
 *   1 – The parameter suffix (e.g. `enabled`, `client_id`), or `*` for all
 *
 * Covers:
 *   SHOW oauth2.enabled
 *   SHOW oauth2.client_id
 *   SHOW oauth2.*
 */
const OAUTH2_SHOW_PATTERN = /^\s*SHOW\s+oauth2\.([a-z_*]+)\s*;?\s*$/i;

/**
 * Fast prefix check — detects if the SQL statement starts with
 * SET, SHOW, or ALTER ROLE, indicating further inspection is needed.
 */
const OAUTH2_FAST_PREFIX_PATTERN = /^\s*(?:SET\s+|SHOW\s+oauth2\.|ALTER\s+ROLE\s+)/i;

/**
 * Secondary filter — confirms the statement references `oauth2.` or `oauth2_id`.
 */
const OAUTH2_REFERENCE_PATTERN = /oauth2\.(?:[a-z_*]+)\b|oauth2_id\b/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string references OAuth2 configuration.
 *
 * Performs a two-phase check:
 * 1. Fast prefix filter for SET/SHOW/ALTER ROLE statements
 * 2. Regex check for `oauth2.<param>` or `oauth2_id` references
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is an OAuth2 configuration statement
 *
 * @example
 * ```ts
 * detectOAuth2("SET oauth2.enabled = on");          // true
 * detectOAuth2("SHOW oauth2.provider");             // true
 * detectOAuth2("ALTER ROLE app SET oauth2_id = 'x'"); // true
 * detectOAuth2("SELECT * FROM users");              // false
 * ```
 */
export function detectOAuth2(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check before attempting expensive regex
  if (!OAUTH2_FAST_PREFIX_PATTERN.test(trimmed)) {
    return false;
  }

  // Confirm the statement actually references oauth2
  if (!OAUTH2_REFERENCE_PATTERN.test(trimmed)) {
    return false;
  }

  // Full pattern match — one of the specific patterns must succeed
  return (
    OAUTH2_SET_PATTERN.test(trimmed) ||
    OAUTH2_ALTER_ROLE_PATTERN.test(trimmed) ||
    OAUTH2_SHOW_PATTERN.test(trimmed)
  );
}

/**
 * Rewrite an OAuth2 configuration SQL statement to a SQLite-compatible form.
 *
 * **Processing rules:**
 * | Input                                              | Output                                              | rewritten |
 * |:---------------------------------------------------|:----------------------------------------------------|:----------|
 * | `SET oauth2.enabled = on`                          | `SELECT 1`                                          | `true`    |
 * | `SET oauth2.provider = '...'`                      | `SELECT 1`                                          | `true`    |
 * | `SET oauth2.client_id = '...'`                     | `SELECT 1`                                          | `true`    |
 * | `SET oauth2.client_secret = '...'`                 | `SELECT 1`                                          | `true`    |
 * | `SET oauth2.issuer = '...'`                        | `SELECT 1`                                          | `true`    |
 * | `SET oauth2.redirect_uri = '...'`                  | `SELECT 1`                                          | `true`    |
 * | `ALTER ROLE r SET oauth2_id = '...'`               | `SELECT 1`                                          | `true`    |
 * | `SHOW oauth2.enabled`                              | `SELECT 'off' AS "oauth2.enabled"`                  | `true`    |
 * | `SHOW oauth2.provider`                             | `SELECT 'mock' AS "oauth2.provider"`                | `true`    |
 * | `SHOW oauth2.client_id`                            | `SELECT 'mock' AS "oauth2.client_id"`               | `true`    |
 * | `SHOW oauth2.*`                                    | `SELECT 'off' AS "oauth2.enabled", ...`             | `true`    |
 * | Non-OAuth2 SQL                                     | Original SQL passed through                         | `false`   |
 *
 * @param sql   The raw SQL string to process
 * @returns     An OAuth2Result indicating the rewriting outcome
 *
 * @example
 * ```ts
 * rewriteOAuth2("SET oauth2.enabled = on");
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteOAuth2("SHOW oauth2.enabled");
 * // → { sql: 'SELECT \'off\' AS "oauth2.enabled"', rewritten: true }
 *
 * rewriteOAuth2("SELECT 1");
 * // → { sql: 'SELECT 1', rewritten: false }
 * ```
 */
export function rewriteOAuth2(sql: string): OAuth2Result {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Try SET oauth2.X pattern ─────────────────────────────────

  const setMatch = trimmed.match(OAUTH2_SET_PATTERN);
  if (setMatch) {
    const paramName = setMatch[1].toLowerCase();
    const value = setMatch[2].trim();

    logger.debug(
      { sql: trimmed, parameter: `oauth2.${paramName}`, value },
      'SET oauth2.* detected — rewriting to SELECT 1',
    );

    SecurityNoticeCollector.add('oauth2', 'OAuth2 is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Try ALTER ROLE ... SET oauth2_id pattern ─────────────────

  const alterMatch = trimmed.match(OAUTH2_ALTER_ROLE_PATTERN);
  if (alterMatch) {
    const oauth2IdValue = alterMatch[1].trim();

    logger.debug(
      { sql: trimmed, oauth2Id: oauth2IdValue },
      'ALTER ROLE ... SET oauth2_id detected — rewriting to SELECT 1',
    );

    SecurityNoticeCollector.add('oauth2', 'OAuth2 is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Try SHOW oauth2.X pattern ────────────────────────────────

  const showMatch = trimmed.match(OAUTH2_SHOW_PATTERN);
  if (showMatch) {
    const paramOrStar = showMatch[1].toLowerCase();

    if (paramOrStar === '*') {
      // SHOW oauth2.* — return all parameters with mock values
      const columns = OAUTH2_PARAMETERS.map((p) => {
        return `'${SHOW_MOCK_VALUES[p]}' AS "oauth2.${p}"`;
      });
      const resultSql = `SELECT ${columns.join(', ')}`;
      logger.debug(
        { sql: trimmed },
        'SHOW oauth2.* detected — rewriting to mock SELECT',
      );
      SecurityNoticeCollector.add('oauth2', 'OAuth2 is not implemented by this database vendor');
      return {
        sql: resultSql,
        rewritten: true,
      };
    }

    // SHOW oauth2.<specific_param> — validate and return single mock value
    if (isOAuth2Parameter(paramOrStar)) {
      const mockValue = SHOW_MOCK_VALUES[paramOrStar];
      const resultSql = `SELECT '${mockValue}' AS "oauth2.${paramOrStar}"`;
      logger.debug(
        { sql: trimmed, parameter: `oauth2.${paramOrStar}`, mockValue },
        'SHOW oauth2.* detected — rewriting to mock SELECT',
      );
      SecurityNoticeCollector.add('oauth2', 'OAuth2 is not implemented by this database vendor');
      return {
        sql: resultSql,
        rewritten: true,
      };
    }

    // Unknown oauth2 parameter — treat as no-op but log a warning
    logger.warn(
      { sql: trimmed, unknownParameter: paramOrStar },
      'Unknown oauth2 parameter shown — rewriting to SELECT NULL',
    );
    SecurityNoticeCollector.add('oauth2', 'OAuth2 is not implemented by this database vendor');
    return {
      sql: `SELECT NULL AS "oauth2.${paramOrStar}"`,
      rewritten: true,
    };
  }

  // ── Not an OAuth2 statement — passthrough ─────────────────────

  return {
    sql: trimmed,
    rewritten: false,
  };
}

// ──────────────────────────────────────────────
//  Internal helpers (exported for testing)
// ──────────────────────────────────────────────

/**
 * Type guard to check if a string is a recognised OAuth2 parameter name.
 *
 * @internal Exported for unit testing only.
 *
 * @param s   The string to check
 * @returns   `true` if `s` is a valid OAuth2 parameter suffix
 */
export function _isOAuth2Parameter(s: string): s is OAuth2Parameter {
  return isOAuth2Parameter(s);
}

/** @internal Alias for type narrowing. */
function isOAuth2Parameter(s: string): s is OAuth2Parameter {
  return (OAUTH2_PARAMETERS as readonly string[]).includes(s);
}

/**
 * Return the list of recognised OAuth2 parameter suffixes.
 *
 * @internal Exported for unit testing only.
 */
export function _getOAuth2Parameters(): readonly string[] {
  return OAUTH2_PARAMETERS;
}

/**
 * Return the mock value table for SHOW responses.
 *
 * @internal Exported for unit testing only.
 */
export function _getShowMockValues(): Record<OAuth2Parameter, string> {
  return { ...SHOW_MOCK_VALUES };
}
