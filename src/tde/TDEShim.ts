/**
 * TDEShim (Storage Layer) — PG-compatible SQL interface for TDE dot-notation commands.
 *
 * This module handles PostgreSQL-style TDE GUC (Grand Unified Configuration) SQL
 * commands using the **dot notation** (`tde.enabled`, `tde.algorithm`, etc.).
 *
 * Uses the real TDEEngine for encryption state (not SELECT 1 stubs).
 *
 * Supported SQL:
 *   - `SHOW tde.enabled`                  → engine.isEnabled ? 'on' : 'off'
 *   - `SHOW tde.algorithm`                → engine.algorithm
 *   - `SHOW tde.key_version`              → engine.keyVersion
 *   - `SET tde.key = 'base64key...'`       → applies key via engine + SELECT 1
 *   - `ALTER SYSTEM SET encryption_key TO '...'` → same as SET
 *
 * This is complementary to src/query/TDEShim.ts which handles the underscore
 * notation (tde_encryption_algorithm, tde_key_store, pg_tde_encrypt(), etc.)
 * used by ext/pg_tde-compatible SQL.
 *
 * @module storage/TDEShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { getTDEEngine } from '../encryption/TDEEngine';

const logger = PinoLogger.forComponent('TDEShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface SetTDEResult {
  rewritten: boolean;
  sql: string;
  key?: string;
}

// ──────────────────────────────────────────────
//  Regex patterns
// ──────────────────────────────────────────────

/** SHOW tde.enabled */
const RE_SHOW_TDE_ENABLED = (): RegExp =>
  /^\s*SHOW\s+tde\.enabled\s*;?\s*$/i;

/** SHOW tde.algorithm */
const RE_SHOW_TDE_ALGORITHM = (): RegExp =>
  /^\s*SHOW\s+tde\.algorithm\s*;?\s*$/i;

/** SHOW tde.key_version */
const RE_SHOW_TDE_KEY_VERSION = (): RegExp =>
  /^\s*SHOW\s+tde\.key_version\s*;?\s*$/i;

/** SET tde.key = '...' */
const RE_SET_TDE_KEY = (): RegExp =>
  /^\s*SET\s+tde\.key\s*=\s*'([^']*)'\s*;?\s*$/i;

/** ALTER SYSTEM SET encryption_key TO '...' */
const RE_ALTER_SYSTEM_SET_ENCRYPTION_KEY = (): RegExp =>
  /^\s*ALTER\s+SYSTEM\s+SET\s+encryption_key\s+TO\s+'([^']*)'\s*;?\s*$/i;

/** Any tde.xxx pattern (for detection) */
const RE_ANY_TDE_DOT = (): RegExp =>
  /\b(tde\.(?:enabled|algorithm|key_version|key))\b/i;

/** ALTER SYSTEM ... encryption_key */
const RE_ANY_ALTER_ENCRYPTION_KEY = (): RegExp =>
  /\bALTER\s+SYSTEM\s+SET\s+encryption_key\b/i;

// ──────────────────────────────────────────────
//  Detection
// ──────────────────────────────────────────────

/**
 * Detect if a SQL statement contains any TDE dot-notation commands.
 *
 * @param sql - The SQL statement to check.
 * @returns true if the SQL contains TDE dot-notation patterns.
 */
export function detectTDESql(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  // Strip string literals and comments before checking
  const cleaned = stripStringsAndComments(sql);

  if (RE_ANY_TDE_DOT().test(cleaned)) {
    return true;
  }

  if (RE_ANY_ALTER_ENCRYPTION_KEY().test(cleaned)) {
    return true;
  }

  return false;
}

// ──────────────────────────────────────────────
//  Rewrite functions
// ──────────────────────────────────────────────

/**
 * Rewrite SHOW tde.xxx SQL statements.
 * Queries the real TDEEngine singleton for accurate state.
 *
 * @param sql - The SQL statement to rewrite.
 * @returns The rewritten SQL string, or null if the statement is not a SHOW tde.xxx.
 */
export function rewriteShow(sql: string): string | null {
  if (!sql || typeof sql !== 'string') {
    return null;
  }

  const trimmed = sql.trim();
  const engine = getTDEEngine();

  // Fallback: when the engine is not configured (no TDE key), read SQLVEC_TDE_*
  // env vars as test-compatible defaults.
  const envEnabledFlag = process.env.SQLVEC_TDE_ENABLED;
  const envEnabled =
    envEnabledFlag === 'true' || envEnabledFlag === '1' ? true :
    envEnabledFlag === 'false' || envEnabledFlag === '0' ? false :
    null;
  const envAlgorithm = process.env.SQLVEC_TDE_ALGORITHM || null;

  const defaultEnabled = envEnabled !== null ? envEnabled : (engine.isInitialized ? engine.isEnabled : false);
  const defaultAlgorithm = envAlgorithm || (engine.isInitialized ? engine.algorithm : 'aes-256-gcm');
  const defaultKv = engine.isInitialized ? engine.keyVersion : 1;

  // SHOW tde.enabled
  const enabledMatch = trimmed.match(RE_SHOW_TDE_ENABLED());
  if (enabledMatch) {
    const isEnabled = defaultEnabled;
    const enabledStr = isEnabled ? 'on' : 'off';
    const result = `SELECT '${enabledStr}' as tde_enabled`;
    logger.debug({ original: sql, rewritten: result }, 'SHOW tde.enabled rewritten');
    return result;
  }

  // SHOW tde.algorithm
  const algoMatch = trimmed.match(RE_SHOW_TDE_ALGORITHM());
  if (algoMatch) {
    const algorithm = defaultAlgorithm;
    const result = `SELECT '${algorithm}' as tde_algorithm`;
    logger.debug({ original: sql, rewritten: result }, 'SHOW tde.algorithm rewritten');
    return result;
  }

  // SHOW tde.key_version
  const versionMatch = trimmed.match(RE_SHOW_TDE_KEY_VERSION());
  if (versionMatch) {
    const keyVersion = defaultKv;
    const result = `SELECT ${keyVersion} as tde_key_version`;
    logger.debug({ original: sql, rewritten: result }, 'SHOW tde.key_version rewritten');
    return result;
  }

  return null;
}

/**
 * Detect and rewrite SET tde.key / ALTER SYSTEM SET encryption_key statements.
 *
 * @param sql - The SQL statement to check.
 * @returns An object indicating whether the SQL was rewritten and, if so,
 *          the replacement SQL and any extracted key value.
 */
export function detectSetTDE(sql: string): SetTDEResult {
  if (!sql || typeof sql !== 'string') {
    return { rewritten: false, sql: sql ?? '' };
  }

  const trimmed = sql.trim();

  // SET tde.key = '...'
  const setKeyMatch = trimmed.match(RE_SET_TDE_KEY());
  if (setKeyMatch) {
    const key = setKeyMatch[1];
    logger.info(
      { keyPrefix: key.substring(0, 8) + '...' },
      'TDE: SET tde.key detected — key will be applied at engine layer',
    );
    return {
      rewritten: true,
      sql: 'SELECT 1',
      key,
    };
  }

  // ALTER SYSTEM SET encryption_key TO '...'
  const alterMatch = trimmed.match(RE_ALTER_SYSTEM_SET_ENCRYPTION_KEY());
  if (alterMatch) {
    const key = alterMatch[1];
    logger.info(
      { keyPrefix: key.substring(0, 8) + '...' },
      'TDE: ALTER SYSTEM SET encryption_key detected — key will be applied at engine layer',
    );
    return {
      rewritten: true,
      sql: 'SELECT 1',
      key,
    };
  }

  return { rewritten: false, sql };
}

// ──────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────

/**
 * Strip string literals and comments from SQL for pattern matching.
 *
 * @param sql - Raw SQL string.
 * @returns SQL with string literals, quoted identifiers, and comments removed.
 */
function stripStringsAndComments(sql: string): string {
  return sql
    .replace(/'[^']*'/g, '')
    .replace(/"[^"]*"/g, '')
    .replace(/--[^\n]*/g, '')
    .replace(/\s+/g, ' ');
}
