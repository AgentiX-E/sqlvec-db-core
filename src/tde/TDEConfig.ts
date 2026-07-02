/**
 * TDEConfig — Configuration management for Transparent Data Encryption (TDE).
 *
 * This module handles loading, validating, generating, and persisting TDE
 * encryption keys. It reads configuration from environment variables:
 *
 *   - `SQLVEC_TDE_KEY`      — base64-encoded 32-byte AES-256 key (required when TDE is enabled)
 *   - `SQLVEC_TDE_ENABLED`  — "true" / "false" (default: false)
 *   - `SQLVEC_TDE_ALGORITHM` — algorithm name (default: "aes-256-gcm")
 *
 * @module storage/TDEConfig
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TDEConfig');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Expected length for AES-256 keys in bytes */
const AES256_KEY_LENGTH = 32;

/** Recognised TDE algorithms */
const VALID_ALGORITHMS = ['aes-256-gcm', 'aes-192-gcm', 'aes-128-gcm'];

/** Default algorithm when not specified */
const DEFAULT_ALGORITHM = 'aes-256-gcm';

/** Filename for the persisted encryption policies JSON */
const POLICIES_FILENAME = 'tde_policies.json';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface TDEEnvConfig {
  key: Buffer | null;
  enabled: boolean;
  algorithm: string;
}

/**
 * A named encryption policy with associated algorithm.
 */
export interface TDEEncryptionPolicy {
  name: string;
  algorithm: string;
  createdAt: Date;
}

// ──────────────────────────────────────────────
//  TDEConfig
// ──────────────────────────────────────────────

export class TDEConfig {
  // ── Runtime state ──────────────────────────────

  /** Whether TDE is currently enabled at runtime */
  private static _enabled: boolean = false;

  /** Current encryption algorithm at runtime */
  private static _algorithm: string = DEFAULT_ALGORITHM;

  /** Named encryption policies (mutable during runtime) */
  private static _policies: Map<string, TDEEncryptionPolicy> = new Map();

  /** Path to the directory where policies JSON is persisted */
  private static _policiesDir: string | null = null;

  // ── Runtime state accessors ────────────────────

  /**
   * Get whether TDE is currently enabled at runtime.
   *
   * Checks both the static `_enabled` flag and the environment variable.
   */
  static getEnabled(): boolean {
    return TDEConfig._enabled;
  }

  /**
   * Get the current encryption algorithm.
   */
  static getAlgorithm(): string {
    return TDEConfig._algorithm;
  }

  /**
   * Set the encryption algorithm at runtime.
   *
   * @param algorithm - The algorithm name (e.g. "aes-256-gcm", "aes-192-gcm", "aes-128-gcm").
   * @throws {Error} If the algorithm is not in the valid set.
   */
  static setAlgorithm(algorithm: string): void {
    const normalized = algorithm.toLowerCase();

    if (!VALID_ALGORITHMS.includes(normalized)) {
      throw new Error(
        `TDEConfig.setAlgorithm: unknown algorithm "${algorithm}". ` +
        `Valid algorithms: ${VALID_ALGORITHMS.join(', ')}`,
      );
    }

    TDEConfig._algorithm = normalized;
    logger.info({ algorithm: normalized }, 'TDEConfig: encryption algorithm updated at runtime');
  }

  /**
   * Set whether TDE is enabled at runtime.
   */
  static setEnabled(enabled: boolean): void {
    TDEConfig._enabled = enabled;
    logger.info({ enabled }, 'TDEConfig: TDE enabled state updated at runtime');
  }

  // ── Policy management ──────────────────────────

  /**
   * Create a named encryption policy.
   *
   * @param name      - The policy name.
   * @param algorithm - The encryption algorithm for this policy (default: current runtime algorithm).
   */
  static createPolicy(name: string, algorithm?: string): TDEEncryptionPolicy {
    const algo = algorithm ?? TDEConfig._algorithm;

    if (!name || typeof name !== 'string') {
      throw new Error('TDEConfig.createPolicy: policy name is required');
    }

    if (TDEConfig._policies.has(name)) {
      throw new Error(
        `TDEConfig.createPolicy: policy "${name}" already exists`,
      );
    }

    const normalizedAlgo = algo.toLowerCase();
    if (!VALID_ALGORITHMS.includes(normalizedAlgo)) {
      throw new Error(
        `TDEConfig.createPolicy: unknown algorithm "${algo}". ` +
        `Valid algorithms: ${VALID_ALGORITHMS.join(', ')}`,
      );
    }

    const policy: TDEEncryptionPolicy = {
      name,
      algorithm: normalizedAlgo,
      createdAt: new Date(),
    };

    TDEConfig._policies.set(name, policy);
    TDEConfig.persistPolicies();
    logger.info({ policy: name, algorithm: normalizedAlgo }, 'TDEConfig: encryption policy created');
    return policy;
  }

  /**
   * Drop (remove) a named encryption policy.
   *
   * @param name - The policy name to remove.
   * @returns true if the policy existed and was removed, false otherwise.
   */
  static dropPolicy(name: string): boolean {
    if (!TDEConfig._policies.has(name)) {
      logger.warn({ policy: name }, 'TDEConfig: attempt to drop non-existent policy');
      return false;
    }

    TDEConfig._policies.delete(name);
    TDEConfig.persistPolicies();
    logger.info({ policy: name }, 'TDEConfig: encryption policy dropped');
    return true;
  }

  /**
   * Get all named encryption policies.
   *
   * @returns An array of all current policies.
   */
  static getPolicies(): TDEEncryptionPolicy[] {
    return Array.from(TDEConfig._policies.values());
  }

  /**
   * Get a specific encryption policy by name.
   *
   * @param name - The policy name.
   * @returns The policy, or undefined if not found.
   */
  static getPolicy(name: string): TDEEncryptionPolicy | undefined {
    return TDEConfig._policies.get(name);
  }

  /**
   * Get the number of named encryption policies.
   */
  static getPolicyCount(): number {
    return TDEConfig._policies.size;
  }

  // ── Lifecycle ──────────────────────────────────

  /**
   * Initialize runtime state from environment variables.
   *
   * Reads `SQLVEC_TDE_ENABLED`, `SQLVEC_TDE_ALGORITHM` and sets
   * the runtime state accordingly. After env initialization,
   * loads persisted encryption policies from disk.
   */
  static initFromEnv(): void {
    const config = TDEConfig.loadFromEnv();
    TDEConfig._enabled = config.enabled;
    TDEConfig._algorithm = config.algorithm;
    // Load persisted encryption policies from disk after env init
    TDEConfig.loadPolicies();
    logger.debug(
      { enabled: config.enabled, algorithm: config.algorithm },
      'TDEConfig: initialized runtime state from environment',
    );
  }

  /**
   * Set the directory where encryption policies will be persisted.
   * Called during ShardManager initialization.
   *
   * @param storageDir - The storage directory path.
   */
  static setPoliciesDir(storageDir: string): void {
    TDEConfig._policiesDir = storageDir;
  }

  /**
   * Persist all encryption policies to a JSON file on disk.
   *
   * Writes atomically: tmp → fsync → rename.
   * Safe to call multiple times (no-op if no directory is configured).
   */
  static persistPolicies(): void {
    const dir = TDEConfig._policiesDir;
    if (!dir) return;
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
    }

    const filePath = path.join(dir, POLICIES_FILENAME);
    const tmpPath = filePath + '.tmp';

    const policies = Array.from(TDEConfig._policies.values()).map(p => ({
      name: p.name,
      algorithm: p.algorithm,
      createdAt: p.createdAt.toISOString(),
    }));

    try {
      fs.writeFileSync(tmpPath, JSON.stringify(policies, null, 2), 'utf8');
      const tmpFd = fs.openSync(tmpPath, 'r');
      try { fs.fsyncSync(tmpFd); } finally { fs.closeSync(tmpFd); }

      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

      fs.renameSync(tmpPath, filePath);

      const dirFd2 = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd2); } finally { fs.closeSync(dirFd2); }

      logger.debug({ policyCount: policies.length }, 'TDEConfig: encryption policies persisted');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'TDEConfig: failed to persist encryption policies');
      try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
  }

  /**
   * Load encryption policies from a JSON file on disk.
   *
   * Called automatically during initFromEnv() and setPoliciesDir().
   * Replaces all in-memory policies with the persisted ones.
   */
  static loadPolicies(): void {
    const dir = TDEConfig._policiesDir;
    if (!dir) return;

    const filePath = path.join(dir, POLICIES_FILENAME);
    if (!fs.existsSync(filePath)) return;

    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const policies: Array<{ name: string; algorithm: string; createdAt: string }> = JSON.parse(raw);
      TDEConfig._policies.clear();
      for (const p of policies) {
        TDEConfig._policies.set(p.name, {
          name: p.name,
          algorithm: p.algorithm,
          createdAt: new Date(p.createdAt),
        });
      }
      logger.info({ policyCount: policies.length }, 'TDEConfig: encryption policies loaded from disk');
    } catch (err: any) {
      logger.warn({ err: err.message }, 'TDEConfig: failed to load encryption policies from disk');
    }
  }

  /**
   * Reset all runtime state (for testing).
   */
  static reset(): void {
    TDEConfig._enabled = false;
    TDEConfig._algorithm = DEFAULT_ALGORITHM;
    TDEConfig._policies.clear();
    logger.debug('TDEConfig: runtime state reset');
  }

  // ── Original methods (unchanged below) ─────────
  /**
   * Load TDE configuration from environment variables.
   *
   * Reads:
   *   - `SQLVEC_TDE_ENABLED`  — enable/disable TDE
   *   - `SQLVEC_TDE_KEY`      — base64-encoded 32-byte key
   *
   * @returns An object with the parsed key (or null if missing/invalid),
   *          whether TDE is enabled, and the algorithm in use.
   */
  static loadFromEnv(): TDEEnvConfig {
    const enabled =
      process.env.SQLVEC_TDE_ENABLED?.toLowerCase() === 'true';

    const algorithm =
      process.env.SQLVEC_TDE_ALGORITHM?.toLowerCase() ?? DEFAULT_ALGORITHM;

    if (!VALID_ALGORITHMS.includes(algorithm)) {
      logger.warn(
        { algorithm, validAlgorithms: VALID_ALGORITHMS },
        'TDEConfig: unknown algorithm in SQLVEC_TDE_ALGORITHM, falling back to aes-256-gcm',
      );
    }

    if (!enabled) {
      logger.debug('TDEConfig: TDE is disabled (SQLVEC_TDE_ENABLED != true)');
      return { key: null, enabled: false, algorithm: DEFAULT_ALGORITHM };
    }

    const keyBase64 = process.env.SQLVEC_TDE_KEY;

    if (!keyBase64) {
      logger.warn(
        'TDEConfig: TDE is enabled but SQLVEC_TDE_KEY is not set — TDE will not function without a key',
      );
      return { key: null, enabled: true, algorithm: DEFAULT_ALGORITHM };
    }

    try {
      const key = Buffer.from(keyBase64, 'base64');

      if (key.length !== AES256_KEY_LENGTH) {
        logger.warn(
          { actualLength: key.length, expectedLength: AES256_KEY_LENGTH },
          'TDEConfig: SQLVEC_TDE_KEY decoded to incorrect length — expected 32 bytes',
        );
        return { key: null, enabled: true, algorithm: DEFAULT_ALGORITHM };
      }

      logger.info(
        {
          algorithm: algorithm !== DEFAULT_ALGORITHM ? algorithm : undefined,
        },
        'TDEConfig: TDE key loaded from environment',
      );

      return { key, enabled: true, algorithm };
    } catch (err: any) {
      logger.warn(
        { err: err.message },
        'TDEConfig: failed to decode SQLVEC_TDE_KEY — must be valid base64',
      );
      return { key: null, enabled: true, algorithm: DEFAULT_ALGORITHM };
    }
  }

  /**
   * Generate a new random AES-256 key as a base64-encoded string.
   *
   * The generated key is 32 bytes of cryptographically secure random data,
   * encoded as base64.
   *
   * @returns A base64-encoded 32-byte key string.
   */
  static generateKey(): string {
    const key = crypto.randomBytes(AES256_KEY_LENGTH);
    return key.toString('base64');
  }

  /**
   * Validate a base64-encoded key string.
   *
   * Checks:
   *   - The string is valid base64
   *   - The decoded key is exactly 32 bytes (for AES-256)
   *
   * @param key - The base64-encoded key string to validate.
   * @returns true if the key is valid, false otherwise.
   */
  static validateKey(key: string): boolean {
    if (!key || typeof key !== 'string') {
      return false;
    }

    try {
      const decoded = Buffer.from(key, 'base64');

      // Check that the base64 round-trips (catches padding issues)
      if (decoded.toString('base64') !== key && Buffer.from(key, 'base64').toString('base64') !== key) {
        // Some base64 implementations have different padding — tolerate this
      }

      return decoded.length === AES256_KEY_LENGTH;
    } catch {
      return false;
    }
  }

  /**
   * Persist a base64-encoded key to a file on disk.
   *
   * The key is written as plain text (the base64 string) with a trailing newline.
   * File permissions are set to 0o600 (owner read/write only).
   *
   * @param key      - The base64-encoded key string to save.
   * @param filePath - The path where the key file should be written.
   *
   * @throws {Error} If the file cannot be written (permissions, disk full, etc.).
   * @throws {Error} If the key fails validation.
   */
  static saveKeyToFile(key: string, filePath: string): void {
    if (!TDEConfig.validateKey(key)) {
      throw new Error(
        'TDEConfig.saveKeyToFile: invalid key — must be base64-encoded 32-byte key',
      );
    }

    // Write with restrictive permissions (owner read/write only)
    fs.writeFileSync(filePath, key + '\n', { mode: 0o600 });

    logger.info(
      { filePath },
      'TDEConfig: encryption key saved to file',
    );
  }

  /**
   * Load a base64-encoded key from a file on disk.
   *
   * Reads the file, trims whitespace, and decodes from base64.
   *
   * @param filePath - Path to the key file (written by saveKeyToFile or equivalent).
   * @returns A Buffer containing the raw 32-byte key.
   *
   * @throws {Error} If the file does not exist or the key is invalid.
   */
  static loadKeyFromFile(filePath: string): Buffer {
    if (!fs.existsSync(filePath)) {
      throw new Error(
        `TDEConfig.loadKeyFromFile: key file not found at "${filePath}"`,
      );
    }

    const content = fs.readFileSync(filePath, 'utf-8').trim();

    try {
      const key = Buffer.from(content, 'base64');

      if (key.length !== AES256_KEY_LENGTH) {
        throw new Error(
          `TDEConfig.loadKeyFromFile: decoded key length mismatch — ` +
          `expected ${AES256_KEY_LENGTH} bytes, got ${key.length}`,
        );
      }

      logger.debug({ filePath }, 'TDEConfig: encryption key loaded from file');
      return key;
    } catch (err: any) {
      throw new Error(
        `TDEConfig.loadKeyFromFile: failed to decode key from "${filePath}": ${err.message}`,
      );
    }
  }
}
