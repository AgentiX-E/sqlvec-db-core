// @ts-nocheck
/**
 * CertMapShim — PostgreSQL certificate/user mapping compatibility shim for SQLite.
 *
 * PostgreSQL supports certificate-based authentication and user-to-foreign-server
 * mapping via `CREATE USER MAPPING`, `ALTER USER MAPPING`, and `DROP USER MAPPING`
 * statements. These are used for:
 *
 *   - Mapping a local user to credentials on a foreign data wrapper (FDW) server
 *   - Managing EXTERNAL SECURITY / certificate-based authentication on functions
 *
 * SQLite has no concept of users, roles, FDW servers, or certificate mappings. Any
 * user mapping DDL encountered by sqlvec-db would fail at parse time.
 *
 * ## Strategy
 *
 * In the query preprocessing pipeline, detect user mapping DDL statements and:
 *
 *   - **CREATE USER MAPPING FOR ... OPTIONS (cert '...')**: Parse the certificate
 *     Common Name and database user, store the mapping in {@link CertMappingStore},
 *     then rewrite to `SELECT 1`.
 *   - **DROP USER MAPPING**: Remove the stored mapping via {@link CertMappingStore},
 *     then rewrite to `SELECT 1`.
 *   - **All other user mapping statements**: Rewrite to `SELECT 1` (preserving
 *     original pass-through behavior).
 *
 * | Input                                                      | Output       | rewritten | cert-mapping side-effect |
 * |------------------------------------------------------------|--------------|-----------|--------------------------|
 * | `CREATE USER MAPPING FOR user SERVER srv OPTIONS (cert 'X')` | `SELECT 1`   | true      | setMapping(X, user)      |
 * | `ALTER USER MAPPING FOR user SERVER srv OPTIONS (cert 'X')`  | `SELECT 1`   | true      | setMapping(X, user)      |
 * | `DROP USER MAPPING FOR user SERVER srv`                     | `SELECT 1`   | true      | removeMapping(user)      |
 * | `CREATE USER MAPPING FOR CURRENT_USER SERVER srv ...`       | `SELECT 1`   | true      | (no mapping)             |
 * | `CREATE TABLE t (id int);`                                  | (pass-through)| false    | —                        |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-user-mapping SQL
 * - Handles optional whitespace, newlines, and trailing semicolons
 * - Handles optional clauses (IF NOT EXISTS, IF EXISTS, CURRENT_USER, CURRENT_ROLE)
 * - PinoLogger integration for debugging and audit trails
 *
 * @module CertMapShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import { create as getCertStore } from '../auth/CertMappingStore';

const logger = PinoLogger.forComponent('CertMapShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface CertMapResult {
  /** Rewritten SQL (bare "SELECT 1" if user mapping detected, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as a user mapping statement and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Recognized user mapping DDL statement prefixes (case-insensitive).
 *
 * Full syntax reference (PostgreSQL):
 *
 * ```
 * CREATE USER MAPPING [IF NOT EXISTS] FOR { user_name | USER | CURRENT_USER | CURRENT_ROLE | PUBLIC }
 *   SERVER server_name [OPTIONS ( option 'value' [, ... ] )]
 *
 * ALTER USER MAPPING FOR { user_name | USER | CURRENT_USER | CURRENT_ROLE | PUBLIC }
 *   SERVER server_name OPTIONS ( [ADD | SET | DROP] option ['value'] [, ... ] )
 *
 * DROP USER MAPPING [IF EXISTS] FOR { user_name | USER | CURRENT_USER | CURRENT_ROLE | PUBLIC }
 *   SERVER server_name
 * ```
 */
const USER_MAPPING_PREFIXES = [
  'CREATE\\s+USER\\s+MAPPING',
  'ALTER\\s+USER\\s+MAPPING',
  'DROP\\s+USER\\s+MAPPING',
] as const;

/**
 * Compiled regex for detecting any user mapping DDL statement.
 *
 * The pattern:
 *   - Matches statement boundaries (start of string or after whitespace/newline)
 *   - Is case-insensitive
 *   - Requires the full prefix (`CREATE USER MAPPING` / `ALTER USER MAPPING` / `DROP USER MAPPING`)
 *   - Does not match other identifiers that happen to contain these words
 *
 * Matches:
 *   - CREATE USER MAPPING FOR ...
 *   - ALTER USER MAPPING FOR ...
 *   - DROP USER MAPPING FOR ...
 *   - create user mapping for ...
 *   - CREATE USER MAPPING IF NOT EXISTS FOR ...
 *   - DROP USER MAPPING IF EXISTS FOR ...
 *
 * Does NOT match:
 *   - MY_CREATE_USER_MAPPING(...)          -- wrapped in another identifier
 *   - 'CREATE USER MAPPING FOR user ...'   -- inside a string literal
 *   - CREATE TABLE user_mapping (id int)   -- different statement
 */
// eslint-disable-next-line require-unicode-regexp
const USER_MAPPING_STMT = new RegExp(
  `^(?:\\s*)(${USER_MAPPING_PREFIXES.join('|')})(?:\\s|$)`,
  'im',
);

/**
 * Regex to extract the FOR user and cert option value from CREATE/ALTER USER MAPPING.
 *
 * Captures:
 *   1 — the database user name (after FOR)
 *   2 — the certificate Common Name (inside OPTIONS (cert '...'))
 *
 * Handles:
 *   - `CREATE USER MAPPING FOR "user" SERVER "srv" OPTIONS (cert 'cn')`
 *   - `CREATE USER MAPPING IF NOT EXISTS FOR user SERVER srv OPTIONS (cert 'cn')`
 *   - `ALTER USER MAPPING FOR user SERVER srv OPTIONS (ADD cert 'cn')`
 */
// eslint-disable-next-line require-unicode-regexp
const CREATE_ALTER_CERT_RE = /(?:CREATE|ALTER)\s+USER\s+MAPPING(?:\s+IF\s+NOT\s+EXISTS)?\s+FOR\s+"?([^\s"]+)"?\s+SERVER\s+"?([^\s"]+)"?(?:\s+OPTIONS\s*\(\s*(?:ADD|SET|DROP)?\s*cert\s+'([^']+)')/im;

/**
 * Regex to extract the FOR user from DROP USER MAPPING.
 *
 * Captures:
 *   1 — the database user name (after FOR)
 */
// eslint-disable-next-line require-unicode-regexp
const DROP_USER_RE = /DROP\s+USER\s+MAPPING(?:\s+IF\s+EXISTS)?\s+FOR\s+"?([^\s"]+)"?\s+SERVER\s+"?([^\s"]+)"?/im;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a PostgreSQL user mapping DDL statement
 * (CREATE / ALTER / DROP USER MAPPING).
 *
 * This uses regex matching with a look-ahead for the user mapping keyword pattern,
 * performing a case-insensitive search for known statement prefixes.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a user mapping DDL statement
 *
 * @example
 * ```ts
 * detectCertMap('CREATE USER MAPPING FOR alice SERVER pg_remote OPTIONS (user $$alice$$)');   // true
 * detectCertMap('ALTER USER MAPPING FOR bob SERVER srv OPTIONS (SET password $$new_pwd$$)'); // true
 * detectCertMap('DROP USER MAPPING FOR CURRENT_USER SERVER srv');                            // true
 * detectCertMap('SELECT 1;');                                                                // false
 * detectCertMap('CREATE TABLE t (id int);');                                                  // false
 * ```
 */
export function detectCertMap(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return USER_MAPPING_STMT.test(sql.trim());
}

/**
 * Rewrite a PostgreSQL user mapping DDL statement to a SQLite-compatible no-op,
 * with side-effects to update the certificate mapping store.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. If the SQL does **not** start with a recognized user mapping DDL prefix
 *    (`CREATE USER MAPPING`, `ALTER USER MAPPING`, or `DROP USER MAPPING`),
 *    return unchanged with `rewritten: false`.
 * 3. If the SQL is a user mapping DDL statement:
 *    a. For `CREATE/ALTER USER MAPPING ... OPTIONS (cert '...')`:
 *       Parse the FOR user and cert value, call
 *       {@link CertMappingStore.setMapping}(certCN, dbUser).
 *    b. For `DROP USER MAPPING FOR user SERVER ...`:
 *       Parse the FOR user and call
 *       {@link CertMappingStore.removeMapping}(certCN).
 *    c. Replace the entire SQL with `SELECT 1` and return `rewritten: true`.
 *
 * The rewrite is conservative: it only triggers when the statement *begins*
 * with one of the known user mapping prefixes. This avoids false positives
 * on embedded references or identifiers that happen to contain these words.
 *
 * @param sql   The raw SQL string to process
 * @returns     A {@link CertMapResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteCertMap('CREATE USER MAPPING FOR alice SERVER remote_srv OPTIONS (cert $$my-cert-cn$$);');
 * // → { sql: 'SELECT 1', rewritten: true }
 * // Side-effect: CertMappingStore.setMapping('my-cert-cn', 'alice')
 *
 * rewriteCertMap('DROP USER MAPPING FOR alice SERVER remote_srv;');
 * // → { sql: 'SELECT 1', rewritten: true }
 * // Side-effect: CertMappingStore.removeMapping('alice')
 *
 * rewriteCertMap('SELECT 1;');
 * // → { sql: 'SELECT 1;', rewritten: false }
 * ```
 */
export function rewriteCertMap(sql: string): CertMapResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Does this statement look like a user mapping DDL? ──

  if (!USER_MAPPING_STMT.test(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Confirm the full prefix is at the statement start ──

  // eslint-disable-next-line require-unicode-regexp
  const PREFIX_PATTERN = new RegExp(
    `^\\s*(${USER_MAPPING_PREFIXES.join('|')})\\b`,
    'ims',
  );

  // Step 1 (`USER_MAPPING_STMT`) guarantees the statement starts with one of the
  // known prefixes followed by whitespace/end-of-line.  Because `\s` always forms
  // a word boundary after the trailing `G`, `PREFIX_PATTERN` (which uses `\b`)
  // necessarily matches too, so `match` can never be null here.
  const match = trimmed.match(PREFIX_PATTERN)!;
  const prefix = match[1].toUpperCase();
  const isCreateOrAlter = prefix.startsWith('CREATE') || prefix.startsWith('ALTER');

  // ── Step 3: Parse cert mapping and update the store ───────────

  if (isCreateOrAlter) {
    const parsed = parseCreateAlterCertMapping(trimmed);
    if (parsed) {
      const store = getCertStore();
      store.setMapping(parsed.certCN, parsed.dbUser);
      logger.info(
        { dbUser: parsed.dbUser, certCN: parsed.certCN, server: parsed.server },
        'Cert mapping stored from CREATE/ALTER USER MAPPING',
      );
    } else {
      logger.debug(
        { sql: trimmed, statementType: prefix },
        'CREATE/ALTER USER MAPPING detected but no cert option found — storing skipped',
      );
    }
  } else {
    // Reaching this branch implies `isCreateOrAlter` is false; since `prefix` is
    // necessarily one of CREATE/ALTER/DROP USER MAPPING, it must be DROP.
    const parsed = parseDropCertMapping(trimmed);
    if (parsed) {
      const store = getCertStore();
      store.removeMappingByDbUser(parsed.dbUser);
      logger.info(
        { dbUser: parsed.dbUser, server: parsed.server },
        'Cert mapping removed from DROP USER MAPPING',
      );
    } else {
      logger.debug(
        { sql: trimmed, statementType: prefix },
        'DROP USER MAPPING detected but could not parse user — removal skipped',
      );
    }
  }

  // ── Step 4: Rewrite to no-op SELECT 1 ─────────────────────────

  logger.debug(
    { sql: trimmed, statementType: prefix },
    'PostgreSQL user mapping DDL detected — rewriting to SELECT 1',
  );

  return {
    sql: 'SELECT 1',
    rewritten: true,
  };
}

// ──────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────

interface ParsedCreateAlterMapping {
  dbUser: string;
  server: string;
  certCN: string;
}

interface ParsedDropMapping {
  dbUser: string;
  server: string;
}

/**
 * Parse a CREATE/ALTER USER MAPPING statement to extract the FOR user,
 * server name, and cert option value.
 *
 * @example
 * ```ts
 * parseCreateAlterCertMapping(
 *   "CREATE USER MAPPING FOR alice SERVER pg_remote OPTIONS (cert 'my-cert-cn')"
 * )
 * // → { dbUser: 'alice', server: 'pg_remote', certCN: 'my-cert-cn' }
 *
 * parseCreateAlterCertMapping(
 *   "CREATE USER MAPPING IF NOT EXISTS FOR bob SERVER srv OPTIONS (cert 'bob-cert')"
 * )
 * // → { dbUser: 'bob', server: 'srv', certCN: 'bob-cert' }
 *
 * parseCreateAlterCertMapping(
 *   "CREATE USER MAPPING FOR alice SERVER srv OPTIONS (user 'alice')"
 * )
 * // → null  (no cert option)
 * ```
 */
function parseCreateAlterCertMapping(sql: string): ParsedCreateAlterMapping | null {
  const m = sql.match(CREATE_ALTER_CERT_RE);
  if (!m) {
    return null;
  }

  return {
    dbUser: m[1],
    server: m[2],
    certCN: m[3],
  };
}

/**
 * Parse a DROP USER MAPPING statement to extract the FOR user and server name.
 *
 * @example
 * ```ts
 * parseDropCertMapping("DROP USER MAPPING FOR alice SERVER pg_remote")
 * // → { dbUser: 'alice', server: 'pg_remote' }
 *
 * parseDropCertMapping("DROP USER MAPPING IF EXISTS FOR bob SERVER srv")
 * // → { dbUser: 'bob', server: 'srv' }
 *
 * parseDropCertMapping("SELECT 1")
 * // → null
 * ```
 */
function parseDropCertMapping(sql: string): ParsedDropMapping | null {
  const m = sql.match(DROP_USER_RE);
  if (!m) {
    return null;
  }

  return {
    dbUser: m[1],
    server: m[2],
  };
}
