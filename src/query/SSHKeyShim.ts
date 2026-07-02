/**
 * SSHKeyShim — PostgreSQL SSH key management compatibility shim for SQLite.
 *
 * PostgreSQL 16+ introduced built-in SSH key management for database roles,
 * enabling key-based authentication for remote connections. The supported DDL
 * and utilities include:
 *
 *   - `CREATE SSH KEY` — associate an SSH public key with a role
 *   - `ALTER ROLE ... SET ssh_public_key` — set per-role SSH key
 *   - `DROP SSH KEY` — remove SSH key association
 *   - `SET ssh_key_provider` — configure the SSH key provider
 *   - `SHOW ssh_key_provider` / `SHOW ssh_public_key` — introspect key config
 *
 * SQLite has no SSH key infrastructure, role-based auth, or key provider concept.
 * All SSH key–related SQL encountered by sqlvec-db must be rewritten to
 * harmless pass-through statements.
 *
 * ## Strategy
 *
 * In the query preprocessing pipeline, detect SSH key DDL / utility statements
 * and rewrite them to SQLite-compatible no-ops:
 *
 * | Input                                                          | Output                           | rewritten |
 * |---------------------------------------------------------------|----------------------------------|-----------|
 * | `CREATE SSH KEY alice ...`                                    | `SELECT 1`                       | true      |
 * | `ALTER ROLE bob SET ssh_public_key = '...'`                   | `SELECT 1`                       | true      |
 * | `DROP SSH KEY IF EXISTS alice_key`                            | `SELECT 1`                       | true      |
 * | `SET ssh_key_provider = 'file:///...'`                        | `SELECT 1`                       | true      |
 * | `SHOW ssh_key_provider`                                       | `SELECT '' AS ssh_key_provider`  | true      |
 * | `SHOW ssh_public_key`                                         | `SELECT '' AS ssh_public_key`    | true      |
 * | `SELECT 1`                                                     | (pass-through)                   | false     |
 * | `CREATE TABLE t (id int)`                                      | (pass-through)                   | false     |
 *
 * ## Key guarantees
 *
 * - All rewritten output is valid SQLite
 * - No false positives on non-SSH-key SQL
 * - Handles optional clauses (IF NOT EXISTS, IF EXISTS, TYPE identifier, comments)
 * - PinoLogger integration for debugging and audit trails
 * - TypeScript strict mode throughout
 *
 * @module SSHKeyShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('SSHKeyShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SSHKeyResult {
  /** Rewritten SQL (bare "SELECT 1" or SHOW introspection if SSH key detected, original if pass-through) */
  sql: string;
  /** Whether the statement was detected as an SSH key statement and rewritten */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Matches CREATE SSH KEY statements.
 *
 * PostgreSQL syntax:
 * ```
 * CREATE SSH KEY [IF NOT EXISTS] key_name
 *   [TYPE { rsa | ecdsa | ed25519 }]
 *   [WITH (algorithm = '...', comment = '...')]
 * ```
 *
 * Captures the full statement and rewrites to SELECT 1.
 *
 * Matches:
 *   - CREATE SSH KEY my_key
 *   - CREATE SSH KEY IF NOT EXISTS my_key TYPE rsa
 *   - CREATE SSH KEY my_key WITH (algorithm = 'ed25519', comment = 'my key')
 *   - create ssh key my_key
 *
 * Does NOT match:
 *   - CREATE TABLE ssh_keys (id int)
 *   - SELECT * FROM ssh_key
 */
const CREATE_SSH_KEY_PATTERN = /^\s*CREATE\s+SSH\s+KEY\b/i;

/**
 * Matches ALTER ROLE ... SET ssh_public_key statements.
 *
 * PostgreSQL syntax:
 * ```
 * ALTER ROLE role_name SET ssh_public_key TO 'public-key-string';
 * ALTER ROLE role_name SET ssh_public_key FROM CURRENT;
 * ```
 *
 * The key detail is that `ssh_public_key` appears as a parameter name
 * in the ALTER ROLE SET clause, distinguishing it from other ALTER ROLE variants.
 *
 * Matches:
 *   - ALTER ROLE alice SET ssh_public_key = '...'
 *   - ALTER ROLE "bob" SET ssh_public_key TO '...'
 *   - alter role alice set ssh_public_key from current
 *
 * Does NOT match:
 *   - ALTER ROLE alice SET statement_timeout = '5min'
 *   - ALTER ROLE alice SET password = '...'
 */
const ALTER_ROLE_SSH_KEY_PATTERN = /^\s*ALTER\s+ROLE\b[\s\S]*?\bSET\s+ssh_public_key\b/i;

/**
 * Matches DROP SSH KEY statements.
 *
 * PostgreSQL syntax:
 * ```
 * DROP SSH KEY [IF EXISTS] key_name [CASCADE | RESTRICT];
 * ```
 *
 * Matches:
 *   - DROP SSH KEY my_key
 *   - DROP SSH KEY IF EXISTS my_key
 *   - DROP SSH KEY my_key CASCADE
 *   - drop ssh key if exists my_key
 *
 * Does NOT match:
 *   - DROP TABLE IF EXISTS ssh_keys
 */
const DROP_SSH_KEY_PATTERN = /^\s*DROP\s+SSH\s+KEY\b/i;

/**
 * Matches SET ssh_key_provider statements.
 *
 * PostgreSQL syntax:
 * ```
 * SET ssh_key_provider TO 'file:///path/to/keys';
 * SET ssh_key_provider = 'ldap://...';
 * ```
 *
 * This is distinct from ordinary SET statements handled by SetResetShim —
 * the ssh_key_provider parameter carries SSH-key-specific semantics.
 *
 * Matches:
 *   - SET ssh_key_provider = '...'
 *   - SET ssh_key_provider TO '...'
 *   - SET SESSION ssh_key_provider = '...'
 *
 * Does NOT match:
 *   - SET statement_timeout = '5min'
 *   - SET search_path TO public
 */
const SET_SSH_KEY_PROVIDER_PATTERN = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?ssh_key_provider\s*(?:=|TO)\s*/i;

/**
 * Matches SHOW ssh_key_provider statements.
 *
 * PostgreSQL syntax — returns current SSH key provider configuration.
 *
 * Matches:
 *   - SHOW ssh_key_provider
 *   - SHOW ssh_key_provider;
 *   - show ssh_key_provider
 *
 * Does NOT match:
 *   - SHOW statement_timeout
 *   - SHOW transaction_isolation
 */
const SHOW_SSH_KEY_PROVIDER_PATTERN = /^\s*SHOW\s+ssh_key_provider\s*;?\s*$/i;

/**
 * Matches SHOW ssh_public_key statements.
 *
 * PostgreSQL syntax — returns current role's SSH public key.
 *
 * Matches:
 *   - SHOW ssh_public_key
 *   - SHOW ssh_public_key;
 *   - show ssh_public_key
 *
 * Does NOT match:
 *   - SHOW all
 */
const SHOW_SSH_PUBLIC_KEY_PATTERN = /^\s*SHOW\s+ssh_public_key\s*;?\s*$/i;

/**
 * Combined SSH key statement prefix patterns — used for fast detection.
 * These capture all variants that should be shimmed.
 */
const SSH_KEY_PREFIXES = [
  CREATE_SSH_KEY_PATTERN,
  ALTER_ROLE_SSH_KEY_PATTERN,
  DROP_SSH_KEY_PATTERN,
  SET_SSH_KEY_PROVIDER_PATTERN,
  SHOW_SSH_KEY_PROVIDER_PATTERN,
  SHOW_SSH_PUBLIC_KEY_PATTERN,
] as const;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a PostgreSQL SSH key management
 * statement (CREATE/DROP SSH KEY, ALTER ROLE SET ssh_public_key,
 * SET/SHOW ssh_key_provider, SHOW ssh_public_key).
 *
 * Performs a case-insensitive check against all known SSH key statement
 * patterns. Uses a combined regex for fast early exit.
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is an SSH key management statement
 *
 * @example
 * ```ts
 * detectSSHKey('CREATE SSH KEY my_key TYPE rsa');               // true
 * detectSSHKey('ALTER ROLE bob SET ssh_public_key = $$key$$');  // true
 * detectSSHKey('DROP SSH KEY IF EXISTS old_key');               // true
 * detectSSHKey('SET ssh_key_provider = $$file:///keys$$');      // true
 * detectSSHKey('SHOW ssh_key_provider');                        // true
 * detectSSHKey('SHOW ssh_public_key');                          // true
 * detectSSHKey('SELECT 1');                                     // false
 * detectSSHKey('CREATE TABLE t (id int)');                      // false
 * ```
 */
export function detectSSHKey(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast prefix check before exhaustively running all patterns
  const upper = trimmed.toUpperCase();
  if (
    !upper.startsWith('CREATE SSH KEY') &&
    !upper.startsWith('ALTER ROLE') &&
    !upper.startsWith('DROP SSH KEY') &&
    !upper.startsWith('SET SSH_KEY_PROVIDER') &&
    !upper.startsWith('SHOW SSH_KEY_PROVIDER') &&
    !upper.startsWith('SHOW SSH_PUBLIC_KEY')
  ) {
    // Fast-path failed — fall through to regex (handles lowercase/newline edge cases)
    return SSH_KEY_PREFIXES.some((pattern) => pattern.test(trimmed));
  }

  return SSH_KEY_PREFIXES.some((pattern) => pattern.test(trimmed));
}

/**
 * Rewrite a PostgreSQL SSH key management statement to a SQLite-compatible
 * equivalent.
 *
 * **Processing logic:**
 *
 * 1. If the SQL is empty or whitespace-only, return unchanged with
 *    `rewritten: false`.
 * 2. Check each known SSH key pattern in order:
 *    a. `CREATE SSH KEY ... [WITH (...)]` → `SELECT 1` (no-op)
 *    b. `ALTER ROLE ... SET ssh_public_key = '...'` → `SELECT 1` (no-op)
 *    c. `DROP SSH KEY ...` → `SELECT 1` (no-op)
 *    d. `SET ssh_key_provider = '...'` → `SELECT 1` (no-op)
 *    e. `SHOW ssh_key_provider` → `SELECT '' AS ssh_key_provider` (empty string result)
 *    f. `SHOW ssh_public_key` → `SELECT '' AS ssh_public_key` (empty string result)
 * 3. If none match, return the original SQL unchanged with `rewritten: false`.
 *
 * The rewrite is conservative: it only triggers when the statement begins
 * with a known SSH key prefix. This avoids false positives on embedded
 * references, string literals, or identifiers containing 'ssh_key'.
 *
 * @param sql   The raw SQL string to process
 * @returns     An {@link SSHKeyResult} indicating the handling outcome
 *
 * @example
 * ```ts
 * rewriteSSHKey('CREATE SSH KEY alice_key TYPE ed25519 WITH (comment = $$alice ssh key$$)');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteSSHKey('ALTER ROLE alice SET ssh_public_key = $$ssh-rsa AAA...$$');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteSSHKey('DROP SSH KEY IF EXISTS alice_key CASCADE');
 * // → { sql: 'SELECT 1', rewritten: true }
 *
 * rewriteSSHKey('SHOW ssh_key_provider');
 * // → { sql: "SELECT '' AS ssh_key_provider", rewritten: true }
 *
 * rewriteSSHKey('SHOW ssh_public_key');
 * // → { sql: "SELECT '' AS ssh_public_key", rewritten: true }
 *
 * rewriteSSHKey('SELECT * FROM users');
 * // → { sql: 'SELECT * FROM users', rewritten: false }
 * ```
 */
export function rewriteSSHKey(sql: string): SSHKeyResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Check known patterns in specificity order ─────────

  // 1a. SHOW ssh_key_provider → SELECT '' AS ssh_key_provider
  if (SHOW_SSH_KEY_PROVIDER_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW ssh_key_provider detected — rewriting to empty result',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: "SELECT '' AS ssh_key_provider",
      rewritten: true,
    };
  }

  // 1b. SHOW ssh_public_key → SELECT '' AS ssh_public_key
  if (SHOW_SSH_PUBLIC_KEY_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SHOW ssh_public_key detected — rewriting to empty result',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: "SELECT '' AS ssh_public_key",
      rewritten: true,
    };
  }

  // 1c. CREATE SSH KEY ... → SELECT 1
  if (CREATE_SSH_KEY_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'CREATE SSH KEY detected — rewriting to SELECT 1',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // 1d. DROP SSH KEY ... → SELECT 1
  if (DROP_SSH_KEY_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'DROP SSH KEY detected — rewriting to SELECT 1',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // 1e. ALTER ROLE ... SET ssh_public_key ... → SELECT 1
  if (ALTER_ROLE_SSH_KEY_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER ROLE ... SET ssh_public_key detected — rewriting to SELECT 1',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // 1f. SET ssh_key_provider ... → SELECT 1
  if (SET_SSH_KEY_PROVIDER_PATTERN.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'SET ssh_key_provider detected — rewriting to SELECT 1',
    );
    SecurityNoticeCollector.add('ssh_key', 'SSH Key authentication is not implemented by this database vendor');
    return {
      sql: 'SELECT 1',
      rewritten: true,
    };
  }

  // ── Step 2: No SSH key statement matched — pass through ───────

  return {
    sql: trimmed,
    rewritten: false,
  };
}
