/**
 * EncryptionPolicyShim — PostgreSQL encryption policy compatibility shim for SQLite.
 *
 * PostgreSQL (Enterprise/商业版) supports column-level encryption policies that
 * allow transparent encryption and decryption of column data using a defined
 * encryption key and algorithm.
 *
 * This shim wires PG encryption policy SQL commands to the real TDE (Transparent
 * Data Encryption) infrastructure in TDEConfig and TDEEngine.
 *
 * Supported encryption policy statements and their mapping:
 *
 * | Input                                                                  | Output                    | Rewritten |
 * |------------------------------------------------------------------------|---------------------------|-----------|
 * | `CREATE ENCRYPTION POLICY name AS (col type) USING 'encrypt(col,key)'` | (stores in TDEConfig)     | true      |
 * | `ALTER ENCRYPTION POLICY name SET (encryption_algorithm = 'AES256')`   | (updates TDEConfig)       | true      |
 * | `DROP ENCRYPTION POLICY name`                                          | (removes from TDEConfig)  | true      |
 * | `SET encryption_policy.default = 'name'`                               | (updates TDEConfig)        | true      |
 * | `SHOW encryption_policy.default`                                       | (reads from TDEConfig)    | true      |
 * | `SET encryption_policy.auto_rotate = on` / `= off`                     | `SELECT 1` (no-op)        | true      |
 * | `SHOW encryption_policy.auto_rotate`                                   | `SELECT 'off'`            | true      |
 * | `ALTER SYSTEM SET encryption.*`                                         | (updates TDEConfig)       | true      |
 * | Non-encryption-policy SQL                                              | (passthrough)             | false     |
 *
 * ## Edge-case handling
 *
 * - **Case-insensitive matching**: All patterns are matched case-insensitively.
 * - **Nested keywords**: The token `ENCRYPTION POLICY` appearing inside string
 *   literals or identifiers is not treated as an encryption policy statement.
 * - **Trailing semicolons**: Preserved in passthrough; stripped on rewrite.
 * - **SHOW variants**: Both `SHOW encryption_policy.default` and `SHOW
 *   encryption_policy.auto_rotate` are handled.
 * - **ALTER SYSTEM**: Catches any `ALTER SYSTEM SET encryption.*` pattern.
 * - **Unknown encryption syntax**: Conservatively passthroughs unchanged.
 *
 * @module EncryptionPolicyShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { TDEConfig } from '../storage/TDEConfig';
import { SecurityNoticeCollector } from './SecurityNoticeCollector';

const logger = PinoLogger.forComponent('EncryptionPolicyShim');

// ── Types ──────────────────────────────────────────────────────

export interface EncryptionPolicyResult {
  /**
   * Rewritten SQL (SELECT statement if the shim produces a SQL result,
   * null if the command was handled at the engine layer without SQL execution).
   */
  sql: string | null;
  /** Whether the statement was detected as an encryption policy operation */
  rewritten: boolean;
  /** Human-readable label of the matched encryption policy category */
  category?: string;
}

// ── Regex Patterns ─────────────────────────────────────────────

/**
 * 1. CREATE ENCRYPTION POLICY name AS (col type) USING '...'
 *    Also matches: CREATE ENCRYPTION POLICY name WITH (encryption_algorithm = 'AES256')
 */
const CREATE_ENCRYPTION_POLICY_RE =
  /^\s*CREATE\s+ENCRYPTION\s+POLICY\s+(\S+)/i;

/**
 * 2. ALTER ENCRYPTION POLICY name SET (...)
 */
const ALTER_ENCRYPTION_POLICY_RE =
  /^\s*ALTER\s+ENCRYPTION\s+POLICY\s+(\S+)\s+SET\s*\(?\s*encryption_algorithm\s*=\s*'?([^')\s;]+)'?\s*\)?\s*;?\s*$/i;

/**
 * 3. DROP ENCRYPTION POLICY name
 */
const DROP_ENCRYPTION_POLICY_RE =
  /^\s*DROP\s+ENCRYPTION\s+POLICY\s+(\S+)/i;

/**
 * 4. SET encryption_policy.default = 'name'
 */
const SET_ENCRYPTION_POLICY_DEFAULT_RE =
  /^\s*SET\s+encryption_policy\.default\s*=\s*'([^']*)'/i;

/**
 * 5. SHOW encryption_policy.default
 */
const SHOW_ENCRYPTION_POLICY_DEFAULT_RE =
  /^\s*SHOW\s+encryption_policy\.default\s*;?\s*$/i;

/**
 * 6. SET encryption_policy.auto_rotate = on/off
 */
const SET_ENCRYPTION_POLICY_AUTO_ROTATE_RE =
  /^\s*SET\s+encryption_policy\.auto_rotate\s*=\s*/i;

/**
 * 7. SHOW encryption_policy.auto_rotate
 */
const SHOW_ENCRYPTION_POLICY_AUTO_ROTATE_RE =
  /^\s*SHOW\s+encryption_policy\.auto_rotate\s*;?\s*$/i;

/**
 * 8. ALTER SYSTEM SET encryption.<key> = '<value>'
 */
const ALTER_SYSTEM_SET_ENCRYPTION_RE =
  /^\s*ALTER\s+SYSTEM\s+SET\s+encryption\.(\w+)\s*=\s*'?([^';\s]+)'?\s*;?\s*$/i;

/**
 * 9. ALTER ENCRYPTION POLICY name — generic (for non-SET variants)
 */
const ALTER_ENCRYPTION_POLICY_GENERIC_RE =
  /^\s*ALTER\s+ENCRYPTION\s+POLICY\s+\S+/i;

// ── Helpers ────────────────────────────────────────────────────

/**
 * Strip the trailing semicolon and whitespace from a SQL statement.
 */
function stripSemicolon(sql: string): string {
  return sql.replace(/;+\s*$/, '');
}

/**
 * Extract the algorithm from a CREATE ENCRYPTION POLICY statement.
 *
 * Looks for patterns like:
 *   - USING 'encrypt(col, key)'
 *   - WITH (encryption_algorithm = 'AES256')
 *   - (encryption_algorithm = 'aes-256-gcm')
 *
 * @returns The extracted algorithm name, or undefined if not found.
 */
function extractAlgorithmFromCreate(sql: string): string | undefined {
  // Try WITH (encryption_algorithm = 'xxx')
  const withMatch = sql.match(/encryption_algorithm\s*=\s*'([^']+)'/i);
  if (withMatch) {
    return withMatch[1];
  }

  // Try parenthesized: (encryption_algorithm = 'xxx')
  const parenMatch = sql.match(/\(\s*encryption_algorithm\s*=\s*'([^']+)'\s*\)/i);
  if (parenMatch) {
    return parenMatch[1];
  }

  // Try USING 'encrypt(col, key)' — default to aes-256-gcm
  const usingMatch = sql.match(/USING\s+'[^']*'/i);
  if (usingMatch) {
    return 'aes-256-gcm';
  }

  return undefined;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Detect whether a SQL statement is an encryption policy operation.
 *
 * Evaluates the input against all known encryption policy patterns and
 * returns `true` if any match is found.
 *
 * @param sql - The SQL statement to inspect (may include trailing semicolon)
 * @returns `true` if the statement appears to be an encryption policy operation
 *
 * @example
 * ```typescript
 * detectEncryptionPolicy('CREATE ENCRYPTION POLICY my_policy AS (ssn text) USING ...');
 * // → true
 * ```
 */
export function detectEncryptionPolicy(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const trimmed = sql.trim();
  const matched =
    CREATE_ENCRYPTION_POLICY_RE.test(trimmed) ||
    ALTER_ENCRYPTION_POLICY_GENERIC_RE.test(trimmed) ||
    DROP_ENCRYPTION_POLICY_RE.test(trimmed) ||
    SET_ENCRYPTION_POLICY_DEFAULT_RE.test(trimmed) ||
    SHOW_ENCRYPTION_POLICY_DEFAULT_RE.test(trimmed) ||
    SET_ENCRYPTION_POLICY_AUTO_ROTATE_RE.test(trimmed) ||
    SHOW_ENCRYPTION_POLICY_AUTO_ROTATE_RE.test(trimmed) ||
    ALTER_SYSTEM_SET_ENCRYPTION_RE.test(trimmed);

  return matched;
}

/**
 * Rewrite an encryption policy SQL statement into a SQLite-compatible form.
 *
 * Commands that modify TDE state (CREATE, DROP, SET, ALTER SYSTEM) are handled
 * at the engine layer via TDEConfig — they return `{ sql: null, rewritten: true }`
 * to indicate no SQL needs to be executed.
 *
 * SHOW commands read real state from TDEConfig and return appropriate SELECT
 * statements. Non-encryption-policy SQL passes through unchanged.
 *
 * @param sql - The SQL statement to rewrite
 * @returns An `EncryptionPolicyResult` with the (possibly rewritten) SQL
 *
 * @example
 * ```typescript
 * rewriteEncryptionPolicy('SHOW encryption_policy.default');
 * // → { sql: "SELECT 'aes-256-gcm' as encryption_policy_default", rewritten: true, category: 'show_default' }
 * ```
 */
export function rewriteEncryptionPolicy(sql: string): EncryptionPolicyResult {
  if (!sql || typeof sql !== 'string') {
    return { sql, rewritten: false };
  }

  const trimmed = sql.trim();

  // ── SHOW encryption_policy.auto_rotate → SELECT 'off' ──────────
  if (SHOW_ENCRYPTION_POLICY_AUTO_ROTATE_RE.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'Encryption policy SHOW auto_rotate → SELECT \'off\'');
    return { sql: "SELECT 'off'", rewritten: true, category: 'show_auto_rotate' };
  }

  // ── SHOW encryption_policy.default ─────────────────────────────
  // Reads from TDEConfig runtime state
  if (SHOW_ENCRYPTION_POLICY_DEFAULT_RE.test(trimmed)) {
    const enabled = TDEConfig.getEnabled();
    let policyValue: string;

    if (enabled) {
      const algorithm = TDEConfig.getAlgorithm();
      policyValue = algorithm;
    } else {
      policyValue = 'none';
    }

    logger.debug(
      { sql: trimmed, enabled, algorithm: policyValue },
      'Encryption policy SHOW default → reading from TDEConfig',
    );
    return {
      sql: `SELECT '${policyValue}' as encryption_policy_default`,
      rewritten: true,
      category: 'show_default',
    };
  }

  // ── DROP ENCRYPTION POLICY name → removes from TDEConfig ──────
  const dropMatch = trimmed.match(DROP_ENCRYPTION_POLICY_RE);
  if (dropMatch) {
    const policyName = dropMatch[1];
    const removed = TDEConfig.dropPolicy(policyName);
    logger.debug(
      { sql: trimmed, policyName, removed },
      'Encryption policy DROP → removed from TDEConfig',
    );
    return { sql: null, rewritten: true, category: 'drop' };
  }

  // ── SET encryption_policy.default = 'name' → updates TDEConfig ─
  const setDefaultMatch = trimmed.match(SET_ENCRYPTION_POLICY_DEFAULT_RE);
  if (setDefaultMatch) {
    const policyName = setDefaultMatch[1];

    // Look up the policy and set its algorithm as the default
    const policy = TDEConfig.getPolicy(policyName);
    if (policy) {
      TDEConfig.setAlgorithm(policy.algorithm);
      TDEConfig.setEnabled(true);
      logger.debug(
        { sql: trimmed, policyName, algorithm: policy.algorithm },
        'Encryption policy SET default → matched to existing policy, updated TDEConfig',
      );
    } else {
      // Policy doesn't exist — just enable TDE with current algorithm
      TDEConfig.setEnabled(true);
      logger.debug(
        { sql: trimmed, policyName },
        'Encryption policy SET default → policy not found, enabled TDE with current algorithm',
      );
    }

    return { sql: null, rewritten: true, category: 'set' };
  }

  // ── SET encryption_policy.auto_rotate → SELECT 1 ──────────────
  if (SET_ENCRYPTION_POLICY_AUTO_ROTATE_RE.test(trimmed)) {
    logger.debug({ sql: trimmed }, 'Encryption policy SET auto_rotate → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true, category: 'set' };
  }

  // ── ALTER SYSTEM SET encryption.<key> = '<value>' ─────────────
  const alterSystemMatch = trimmed.match(ALTER_SYSTEM_SET_ENCRYPTION_RE);
  if (alterSystemMatch) {
    const key = alterSystemMatch[1].toLowerCase();
    const value = alterSystemMatch[2];

    if (key === 'encryption_algorithm' || key === 'algorithm') {
      try {
        TDEConfig.setAlgorithm(value);
        TDEConfig.setEnabled(true);
        logger.debug(
          { sql: trimmed, algorithm: value },
          'ALTER SYSTEM SET encryption.algorithm → updated TDEConfig',
        );
      } catch (err: any) {
        logger.warn(
          { sql: trimmed, key, value, err: err.message },
          'ALTER SYSTEM SET encryption.algorithm → invalid algorithm, falling back',
        );
        // Return a SELECT 1 to indicate no-op rather than erroring
        return { sql: 'SELECT 1', rewritten: true, category: 'alter_system' };
      }
    } else {
      logger.debug(
        { sql: trimmed, key, value },
        'ALTER SYSTEM SET encryption.* → unknown key, no-op',
      );
    }

    return { sql: null, rewritten: true, category: 'alter_system' };
  }

  // ── CREATE ENCRYPTION POLICY name → stores in TDEConfig ───────
  const createMatch = trimmed.match(CREATE_ENCRYPTION_POLICY_RE);
  if (createMatch) {
    const policyName = createMatch[1];
    const algorithm = extractAlgorithmFromCreate(trimmed);

    try {
      TDEConfig.createPolicy(policyName, algorithm);
      TDEConfig.setEnabled(true);
      logger.debug(
        { sql: trimmed, policyName, algorithm: algorithm ?? 'default' },
        'Encryption policy CREATE → stored in TDEConfig',
      );
    } catch (err: any) {
      logger.warn(
        { sql: trimmed, policyName, err: err.message },
        'Encryption policy CREATE → failed to create policy, falling back to no-op',
      );
      // Return SELECT 1 rather than erroring
      return { sql: 'SELECT 1', rewritten: true, category: 'ddl' };
    }

    return { sql: null, rewritten: true, category: 'ddl' };
  }

  // ── ALTER ENCRYPTION POLICY name → updates in TDEConfig ───────
  if (ALTER_ENCRYPTION_POLICY_GENERIC_RE.test(trimmed)) {
    // Try to extract algorithm from ALTER statement
    const alterMatch = trimmed.match(ALTER_ENCRYPTION_POLICY_RE);
    if (alterMatch) {
      const policyName = alterMatch[1];
      const algorithm = alterMatch[2];

      try {
        // Check if policy exists
        const existing = TDEConfig.getPolicy(policyName);
        if (existing) {
          // Remove and recreate with new algorithm
          TDEConfig.dropPolicy(policyName);
          TDEConfig.createPolicy(policyName, algorithm);
        } else {
          // Create as new policy
          TDEConfig.createPolicy(policyName, algorithm);
        }
        TDEConfig.setEnabled(true);
        logger.debug(
          { sql: trimmed, policyName, algorithm },
          'Encryption policy ALTER → updated in TDEConfig',
        );
        return { sql: null, rewritten: true, category: 'ddl' };
      } catch (err: any) {
        logger.warn(
          { sql: trimmed, policyName, err: err.message },
          'Encryption policy ALTER → failed, falling back to no-op',
        );
        return { sql: 'SELECT 1', rewritten: true, category: 'ddl' };
      }
    }

    // Generic ALTER without recognizable SET (e.g. ALTER ENCRYPTION POLICY name OWNER TO ...)
    logger.debug({ sql: trimmed }, 'Encryption policy ALTER (generic) → SELECT 1');
    return { sql: 'SELECT 1', rewritten: true, category: 'ddl' };
  }

  // ── Not an encryption policy statement — pass through ──────────
  return { sql: stripSemicolon(trimmed) + ';', rewritten: false };
}
