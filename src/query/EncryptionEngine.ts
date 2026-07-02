/**
 * EncryptionEngine — Column-level encryption for SQLite.
 *
 * Provides transparent column-level encryption and decryption using AES-256-GCM.
 * Data is automatically encrypted on INSERT and decrypted on SELECT based on
 * registered encryption policies.
 *
 * ## Design
 *
 * Each encryption policy identifies a column by its qualified name
 * (`schema.table.column` or just `table.column`). When an INSERT or UPDATE
 * targets a protected column, the plaintext value is encrypted into a binary
 * buffer before storage. When a SELECT reads a protected column, the binary
 * buffer is decrypted back to plaintext.
 *
 * Each encrypted value is stored as:
 *   IV (12 bytes) + ciphertext + auth tag (16 bytes)
 *
 * ## Usage
 *
 * ```
 * const engine = new EncryptionEngine();
 * engine.createPolicy('ssn_policy', 'employees.ssn', 'aes-256-gcm');
 *
 * // INSERT with automatic encryption
 * const rewrittenInsert = engine.rewriteInsert(
 *   "INSERT INTO employees (name, ssn) VALUES ('John', '123-45-6789')"
 * );
 *
 * // SELECT with automatic decryption
 * const rewrittenSelect = engine.rewriteSelect(
 *   "SELECT name, ssn FROM employees"
 * );
 * ```
 *
 * ## Security notes
 *
 * - The master key is generated randomly on construction. For production use,
 *   it should be loaded from a secure key management system.
 * - AES-256-GCM provides authenticated encryption (confidentiality + integrity).
 * - Nonces (IVs) are generated using crypto.randomBytes() for each encryption.
 *
 * @module query/EncryptionEngine
 */

import * as crypto from 'crypto';
import { type CipherGCM, type DecipherGCM } from 'crypto';
import { PinoLogger } from '../monitoring/PinoLogger';

// ── Logger ───────────────────────────────────────────────────────


// ── Types ────────────────────────────────────────────────────────

export type EncryptionAlgorithm = 'aes-256-gcm' | 'aes-256-cbc' | 'aes-128-gcm';

export interface EncryptionPolicy {
  /** Policy name. */
  name: string;
  /** Qualified column name (e.g. 'employees.ssn', 'public.users.email'). */
  column: string;
  /** Encryption algorithm. */
  algorithm: EncryptionAlgorithm;
  /** Whether the policy is active. */
  enabled: boolean;
  /** Derived encryption key (from master key + column salt). */
  key: Buffer;
  /** Per-column salt for key derivation. */
  salt: Buffer;
}

// ── Constants ────────────────────────────────────────────────────

const IV_LENGTH = 12; // AES-GCM standard nonce size
const AUTH_TAG_LENGTH = 16; // GCM authentication tag
const KEY_LENGTHS: Record<EncryptionAlgorithm, number> = {
  'aes-256-gcm': 32,
  'aes-256-cbc': 32,
  'aes-128-gcm': 16,
};

// ── EncryptionEngine ─────────────────────────────────────────────

export class EncryptionEngine {
  private readonly logger = PinoLogger.forComponent('encryptionengine');

  private masterKey: Buffer;
  private policies: Map<string, EncryptionPolicy> = new Map();

  constructor(masterKey?: Buffer) {
    this.masterKey = masterKey || crypto.randomBytes(32);
    this.logger.info('EncryptionEngine initialized with %s master key',
      masterKey ? 'provided' : 'random');
  }

  // ── Policy management ──────────────────────────────────────────

  /**
   * Create a new encryption policy for a column.
   *
   * @param name      - Unique policy name.
   * @param column    - Qualified column name (e.g. 'table.column').
   * @param algorithm - Encryption algorithm (default: 'aes-256-gcm').
   */
  createPolicy(name: string, column: string, algorithm: EncryptionAlgorithm = 'aes-256-gcm'): void {
    const salt = crypto.randomBytes(16);
    const keyLength = KEY_LENGTHS[algorithm];
    const key = crypto.pbkdf2Sync(this.masterKey, salt, 100000, keyLength, 'sha256');

    const policy: EncryptionPolicy = {
      name,
      column,
      algorithm,
      enabled: true,
      key,
      salt,
    };

    this.policies.set(column, policy);

    this.logger.info({ name, column, algorithm }, 'Encryption policy created');
  }

  /**
   * Drop an encryption policy by name.
   *
   * @param name - Policy name to drop.
   */
  dropPolicy(name: string): void {
    for (const [key, policy] of this.policies) {
      if (policy.name === name) {
        this.policies.delete(key);
        this.logger.info({ name, column: policy.column }, 'Encryption policy dropped');
        return;
      }
    }
    this.logger.warn({ name }, 'Encryption policy not found');
  }

  /**
   * Drop a policy by column name.
   *
   * @param column - Column name to drop policy for.
   */
  dropPolicyByColumn(column: string): void {
    const policy = this.policies.get(column);
    if (policy) {
      this.policies.delete(column);
      this.logger.info({ column, name: policy.name }, 'Encryption policy dropped by column');
    }
  }

  /**
   * Enable or disable a policy.
   *
   * @param column  - Column name the policy covers.
   * @param enabled - Whether to enable.
   */
  setPolicyEnabled(column: string, enabled: boolean): void {
    const policy = this.policies.get(column);
    if (policy) {
      policy.enabled = enabled;
      this.logger.info({ column, enabled }, 'Encryption policy enabled state changed');
    }
  }

  /**
   * Get a policy by column name.
   *
   * @param column - Column name.
   * @returns The policy, or `undefined`.
   */
  getPolicy(column: string): EncryptionPolicy | undefined {
    return this.policies.get(column);
  }

  /**
   * Get all registered policies.
   */
  getAllPolicies(): EncryptionPolicy[] {
    return Array.from(this.policies.values());
  }

  /**
   * Check whether a column has an encryption policy.
   *
   * @param column - Column name.
   * @returns `true` if protected.
   */
  isProtected(column: string): boolean {
    const policy = this.policies.get(column);
    return policy !== undefined && policy.enabled;
  }

  // ── Core encryption / decryption ──────────────────────────────

  /**
   * Encrypt a plaintext value for a given column.
   *
   * Output format: IV (12 bytes) + ciphertext + authTag (16 bytes).
   *
   * @param column    - Column name (used to look up the encryption policy).
   * @param plaintext - Plaintext string to encrypt.
   * @returns Encrypted buffer: IV + ciphertext + authTag.
   * @throws {Error} If no policy exists for the column.
   */
  encrypt(column: string, plaintext: string): Buffer {
    const policy = this.policies.get(column);
    if (!policy || !policy.enabled) {
      throw new Error(`No active encryption policy for column: ${column}`);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(policy.algorithm, policy.key, iv) as CipherGCM;

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Format: IV (12) + ciphertext (variable) + authTag (16)
    return Buffer.concat([iv, encrypted, authTag]);
  }

  /**
   * Encrypt a single column value for a given table.column.
   * Convenience wrapper around encrypt().
   *
   * @param table  - Table name
   * @param column - Column name
   * @param value  - Plaintext value to encrypt
   * @returns Encrypted buffer
   */
  encryptColumn(table: string, column: string, value: any): Buffer {
    const qualifiedName = `${table}.${column}`;
    const strValue = value === null || value === undefined ? '' : String(value);
    return this.encrypt(qualifiedName, strValue);
  }

  /**
   * Decrypt a single column value for a given table.column.
   * Convenience wrapper around decrypt().
   *
   * @param table  - Table name
   * @param column - Column name
   * @param buffer - Encrypted buffer to decrypt
   * @returns Decrypted plaintext string
   */
  decryptColumn(table: string, column: string, buffer: Buffer): string {
    const qualifiedName = `${table}.${column}`;
    return this.decrypt(qualifiedName, buffer);
  }

  /**
   * Decrypt an encrypted buffer for a given column.
   *
   * Expects the format produced by `encrypt()`:
   *   IV (12 bytes) + ciphertext + authTag (16 bytes)
   *
   * @param column     - Column name (used to look up the encryption policy).
   * @param ciphertext - Encrypted buffer: IV + ciphertext + authTag.
   * @returns Decrypted plaintext string.
   * @throws {Error} If no policy exists, or if authentication fails.
   */
  decrypt(column: string, ciphertext: Buffer): string {
    const policy = this.policies.get(column);
    if (!policy || !policy.enabled) {
      throw new Error(`No active encryption policy for column: ${column}`);
    }

    if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error(`Ciphertext too short for column "${column}" (min ${IV_LENGTH + AUTH_TAG_LENGTH} bytes)`);
    }

    const iv = ciphertext.subarray(0, IV_LENGTH);
    const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
    const encrypted = ciphertext.subarray(IV_LENGTH, ciphertext.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv(policy.algorithm, policy.key, iv) as DecipherGCM;
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  }

  // ── SQL rewriting ─────────────────────────────────────────────

  /**
   * Rewrite an INSERT statement to encrypt protected columns.
   *
   * Replaces plaintext VALUES for protected columns with hex-encoded
   * encrypted buffers (X'...' syntax for SQLite).
   *
   * **Note:** This is a simplified rewrite that handles single-row
   * INSERT ... VALUES ... syntax with positional values. Complex
   * INSERT ... SELECT statements are not rewritten.
   *
   * @param sql - The INSERT SQL statement.
   * @returns The rewritten INSERT with encrypted values.
   */
  rewriteInsert(sql: string): string {
    const insertMatch = sql.match(
      /INSERT\s+INTO\s+([`"\w.]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    );
    if (!insertMatch) return sql;

    const [, table, columnsRaw, valuesRaw] = insertMatch;
    const columns = columnsRaw.split(',').map((c) => c.trim().replace(/[`"']/g, ''));
    const values = this.parseValueList(valuesRaw);

    let rewritten = false;
    const newValues = values.map((value, idx) => {
      const colName = columns[idx];
      if (!colName) return value;

      // Check the full qualified name and simple name.
      const qualifiedName = `${table}.${colName}`;
      const policy = this.policies.get(qualifiedName) || this.policies.get(colName);

      if (policy && policy.enabled) {
        rewritten = true;
        const plaintext = value.replace(/^['"]|['"]$/g, '');
        const encrypted = this.encrypt(qualifiedName, plaintext);
        // SQLite hex literal: X'...'
        return `X'${encrypted.toString('hex')}'`;
      }

      return value;
    });

    if (!rewritten) return sql;

    const result = `INSERT INTO ${table} (${columnsRaw}) VALUES (${newValues.join(', ')})`;

    this.logger.debug(
      { table, rewritten: true },
      'INSERT rewritten with encrypted columns',
    );

    return result;
  }

  /**
   * Rewrite a SELECT statement to decrypt protected columns.
   *
   * Wraps protected columns in a special function marker that the QueryRouter
   * uses to trigger decryption of returned values.
   *
   * **Note:** This is a simplified rewrite that marks columns for decryption
   * rather than performing inline decryption (SQLite cannot decrypt buffers
   * inline without a custom function).
   *
   * @param sql - The SELECT SQL statement.
   * @returns The rewritten SELECT with decryption markers.
   */
  rewriteSelect(sql: string): string {
    // Match SELECT clause column list.
    const selectMatch = sql.match(
      /SELECT\s+(.+?)\s+FROM\s+(`?[`"\w.]+)?/i,
    );
    if (!selectMatch) return sql;

    const [, selectColumns, fromTable] = selectMatch;
    const columns = selectColumns.split(',').map((c) => c.trim());

    let rewritten = false;
    const newColumns = columns.map((col) => {
      const colName = col.replace(/[`"']/g, '').split(/\s+/)[0]; // Handle aliases
      const qualifiedName = fromTable ? `${fromTable}.${colName}` : colName;
      const policy = this.policies.get(qualifiedName) || this.policies.get(colName);

      if (policy && policy.enabled && col.indexOf('_decrypt') === -1) {
        rewritten = true;
        // Mark for decryption — the QueryRouter will handle the actual
        // Buffer → string conversion after fetching the row.
        return `_decrypt(${col}) AS ${colName}`;
      }

      return col;
    });

    if (!rewritten) return sql;

    const result = sql.replace(selectColumns, newColumns.join(', '));

    this.logger.debug(
      { table: fromTable, rewritten: true },
      'SELECT rewritten with decryption markers',
    );

    return result;
  }

  /**
   * Decrypt any encrypted buffers in a result row.
   *
   * Called by the QueryRouter after fetching rows to convert encrypted
   * binary columns back to plaintext strings.
   *
   * @param row    - A result row (column name → value).
   * @param table  - The table name (for qualified policy lookup).
   * @returns The row with all protected columns decrypted in-place.
   */
  decryptRow(row: Record<string, any>, table: string): Record<string, any> {
    const result: Record<string, any> = { ...row };

    for (const colName of Object.keys(row)) {
      const qualifiedName = `${table}.${colName}`;
      const policy = this.policies.get(qualifiedName) || this.policies.get(colName);

      if (policy && policy.enabled && row[colName] instanceof Buffer) {
        try {
          result[colName] = this.decrypt(qualifiedName, row[colName]);
        } catch (err) {
          this.logger.warn(
            { colName, err },
            'Failed to decrypt column — returning raw buffer',
          );
          result[colName] = row[colName];
        }
      }
    }

    return result;
  }

  /**
   * Rotate the master key, re-encrypting all policies with new derived keys.
   *
   * @param newMasterKey - New master key.
   */
  rotateMasterKey(newMasterKey: Buffer): void {
    this.masterKey = newMasterKey;

    for (const [column, policy] of this.policies) {
      const keyLength = KEY_LENGTHS[policy.algorithm];
      policy.key = crypto.pbkdf2Sync(this.masterKey, policy.salt, 100000, keyLength, 'sha256');
    }

    this.logger.info('Master key rotated');
  }

  /**
   * Reset all state (for testing).
   */
  reset(): void {
    this.policies.clear();
    this.masterKey = crypto.randomBytes(32);
    this.logger.info('EncryptionEngine state reset');
  }

  // ── Private helpers ───────────────────────────────────────────

  /**
   * Parse a comma-separated value list, respecting quoted strings.
   */
  private parseValueList(valuesRaw: string): string[] {
    const values: string[] = [];
    let current = '';
    let depth = 0;
    let inQuote: string | null = null;

    for (const ch of valuesRaw) {
      if (inQuote) {
        current += ch;
        if (ch === inQuote) inQuote = null;
        continue;
      }

      if (ch === "'" || ch === '"') {
        inQuote = ch;
        current += ch;
        continue;
      }

      if (ch === '(') {
        depth++;
        current += ch;
      } else if (ch === ')') {
        depth--;
        current += ch;
      } else if (ch === ',' && depth === 0) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }

    const trimmed = current.trim();
    if (trimmed.length > 0) values.push(trimmed);

    return values;
  }
}
