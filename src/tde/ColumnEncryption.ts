/**
 * ColumnEncryption — Column-level encryption key management.
 *
 * Manages column encryption keys stored in an SQLite `__column_encryption_keys`
 * table. All keys are encrypted at rest using a master key (AES-256-GCM).
 *
 * ## Design
 *
 * Each column encryption key (CEK) is:
 *   - Generated via `crypto.randomBytes(32)` (AES-256 key)
 *   - Encrypted with the master key using AES-256-GCM + random IV
 *   - Stored in the `__column_encryption_keys` table as: `IV (12) + ciphertext + authTag (16)`
 *
 * The `CREATE COLUMN ENCRYPTION KEY` DDL is parsed and mapped into an in-memory
 * key registration plus (optionally) a persistent row in the key table.
 *
 * ## Usage
 *
 * ```ts
 * const ce = new ColumnEncryption(masterKey);
 *
 * // Create a column encryption key
 * ce.createColumnEncryptionKey('my_cek', 'aes-256-gcm');
 *
 * // Encrypt/decrypt values for a specific column
 * const encrypted = ce.encryptValue('my_cek', 'sensitive data');
 * const decrypted = ce.decryptValue('my_cek', encrypted);
 *
 * // Rotate a key
 * ce.rotateKey('my_cek');
 *
 * // Persist keys to an SQLite database
 * await ce.persistKeys(db);
 * await ce.loadKeys(db);
 * ```
 *
 * @module encryption/ColumnEncryption
 */

import * as crypto from 'node:crypto';
import { PinoLogger } from '../logger/PinoLogger';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CekAlgorithm = 'aes-256-gcm' | 'aes-256-cbc';

export interface ColumnEncryptionKey {
  /** Logical name of the key (as referenced by ENCRYPTED WITH). */
  name: string;
  /** Encryption algorithm. */
  algorithm: CekAlgorithm;
  /** The raw AES key material (32 bytes for AES-256). */
  key: Buffer;
  /** When this key was created. */
  createdAt: Date;
  /** Key version (increments on rotation). */
  version: number;
}

export interface CreateColumnEncryptionKeyResult {
  /** The key name. */
  keyName: string;
  /** Whether the key was newly created. */
  created: boolean;
  /** The key algorithm. */
  algorithm: string;
  /** Key version. */
  version: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTHS: Record<CekAlgorithm, number> = {
  'aes-256-gcm': 32,
  'aes-256-cbc': 32,
};

const CEK_ALGORITHMS: CekAlgorithm[] = ['aes-256-gcm', 'aes-256-cbc'];

// SQL for the `__column_encryption_keys` table.
const CREATE_KEYS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS __column_encryption_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_name TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL,
  encrypted_key BLOB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// ── ColumnEncryption ──────────────────────────────────────────────────────────

export class ColumnEncryption {
  private readonly logger = PinoLogger.forComponent('ColumnEncryption');

  /** Master key used to encrypt/decrypt stored CEKs. */
  private masterKey: Buffer;

  /** In-memory map: key name → ColumnEncryptionKey. */
  private keys: Map<string, ColumnEncryptionKey> = new Map();

  /**
   * @param masterKey  32-byte master key. If omitted, generated randomly.
   */
  constructor(masterKey?: Buffer) {
    this.masterKey = masterKey ?? crypto.randomBytes(32);
    this.logger.info(
      { keyLength: this.masterKey.length },
      'ColumnEncryption initialized',
    );
  }

  // ── SQL table management ─────────────────────────────────────────────────────

  /**
   * Return the DDL needed to create the `__column_encryption_keys` table.
   * Applications should run this once on startup.
   */
  static getCreateKeysTableSql(): string {
    return CREATE_KEYS_TABLE_SQL;
  }

  // ── Key management ───────────────────────────────────────────────────────────

  /**
   * Create a column encryption key.
   *
   * Simulates: `CREATE COLUMN ENCRYPTION KEY <name> WITH ALGORITHM = '<algorithm>'`
   *
   * @param name      Logical key name (e.g. 'ssn_cek', 'email_cek').
   * @param algorithm Encryption algorithm (default: 'aes-256-gcm').
   * @returns Result indicating whether the key was created.
   * @throws If the algorithm is unsupported.
   */
  createColumnEncryptionKey(
    name: string,
    algorithm: CekAlgorithm = 'aes-256-gcm',
  ): CreateColumnEncryptionKeyResult {
    if (!CEK_ALGORITHMS.includes(algorithm)) {
      throw new Error(`Unsupported CEK algorithm: ${algorithm}. Supported: ${CEK_ALGORITHMS.join(', ')}`);
    }

    if (this.keys.has(name)) {
      this.logger.warn({ keyName: name }, 'Column encryption key already exists — returning existing');
      const existing = this.keys.get(name)!;
      return {
        keyName: name,
        created: false,
        algorithm: existing.algorithm,
        version: existing.version,
      };
    }

    const keyLength = KEY_LENGTHS[algorithm];
    const key = crypto.randomBytes(keyLength);
    const now = new Date();

    const cek: ColumnEncryptionKey = {
      name,
      algorithm,
      key,
      createdAt: now,
      version: 1,
    };

    this.keys.set(name, cek);
    this.logger.info({ keyName: name, algorithm, version: 1 }, 'Column encryption key created');

    return { keyName: name, created: true, algorithm, version: 1 };
  }

  /**
   * Drop a column encryption key.
   *
   * @param name Key name.
   * @returns `true` if the key was found and removed.
   */
  dropColumnEncryptionKey(name: string): boolean {
    const removed = this.keys.delete(name);
    if (removed) {
      this.logger.info({ keyName: name }, 'Column encryption key dropped');
    } else {
      this.logger.warn({ keyName: name }, 'Column encryption key not found');
    }
    return removed;
  }

  /**
   * Rotate a column encryption key — generates a new key and increments the version.
   *
   * @param name Key name.
   * @returns The new key version, or -1 if the key was not found.
   */
  rotateKey(name: string): number {
    const existing = this.keys.get(name);
    if (!existing) {
      this.logger.warn({ keyName: name }, 'Cannot rotate: key not found');
      return -1;
    }

    const keyLength = KEY_LENGTHS[existing.algorithm];
    existing.key = crypto.randomBytes(keyLength);
    existing.version++;
    existing.createdAt = new Date();

    this.logger.info(
      { keyName: name, newVersion: existing.version },
      'Column encryption key rotated',
    );

    return existing.version;
  }

  /**
   * Get a column encryption key by name.
   */
  getKey(name: string): ColumnEncryptionKey | undefined {
    return this.keys.get(name);
  }

  /**
   * Get all registered column encryption keys.
   */
  getAllKeys(): ColumnEncryptionKey[] {
    return Array.from(this.keys.values());
  }

  /**
   * Check if a key exists.
   */
  hasKey(name: string): boolean {
    return this.keys.has(name);
  }

  // ── Encrypt / decrypt with CEK ──────────────────────────────────────────────

  /**
   * Encrypt a plaintext value using the named column encryption key.
   *
   * @param keyName   Name of the CEK to use.
   * @param plaintext Plaintext string to encrypt.
   * @returns Buffer: IV (12) + ciphertext + authTag (16).
   * @throws If the key does not exist.
   */
  encryptValue(keyName: string, plaintext: string): Buffer {
    const cek = this.keys.get(keyName);
    if (!cek) {
      throw new Error(`Column encryption key not found: ${keyName}`);
    }

    if (cek.algorithm === 'aes-256-gcm') {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv('aes-256-gcm', cek.key, iv);
      const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf-8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      return Buffer.concat([iv, encrypted, authTag]);
    }

    // aes-256-cbc
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', cek.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, encrypted]);
  }

  /**
   * Decrypt a value using the named column encryption key.
   *
   * Expects the format produced by `encryptValue()`.
   *
   * @param keyName    Name of the CEK to use.
   * @param ciphertext Encrypted buffer: IV + ciphertext [+ authTag for GCM].
   * @returns Decrypted plaintext string.
   * @throws If the key does not exist, or authentication fails (GCM).
   */
  decryptValue(keyName: string, ciphertext: Buffer): string {
    const cek = this.keys.get(keyName);
    if (!cek) {
      throw new Error(`Column encryption key not found: ${keyName}`);
    }

    if (cek.algorithm === 'aes-256-gcm') {
      if (ciphertext.length < IV_LENGTH + AUTH_TAG_LENGTH) {
        throw new Error(`Ciphertext too short for GCM (min ${IV_LENGTH + AUTH_TAG_LENGTH} bytes)`);
      }
      const iv = ciphertext.subarray(0, IV_LENGTH);
      const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH);
      const encrypted = ciphertext.subarray(IV_LENGTH, ciphertext.length - AUTH_TAG_LENGTH);

      const decipher = crypto.createDecipheriv('aes-256-gcm', cek.key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
      return decrypted.toString('utf-8');
    }

    // aes-256-cbc (no auth tag — just IV + ciphertext)
    const iv = ciphertext.subarray(0, 16);
    const encrypted = ciphertext.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', cek.key, iv);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf-8');
  }

  // ── SEC009: Column-name-based encrypt/decrypt ──────────────────────────────

  /** Registered column → key name mappings. */
  private columnKeyMap: Map<string, string> = new Map();

  /**
   * Register a column-to-key mapping.
   *
   * @param tableName - The table containing the column.
   * @param columnName - The column to encrypt.
   * @param keyName - The CEK name to use for this column.
   */
  registerColumnMapping(tableName: string, columnName: string, keyName: string): void {
    const key = `${tableName}.${columnName}`;
    this.columnKeyMap.set(key, keyName);
    this.logger.info({ tableName, columnName, keyName }, 'Column encryption mapping registered');
  }

  /**
   * Unregister a column-to-key mapping.
   */
  unregisterColumnMapping(tableName: string, columnName: string): boolean {
    const key = `${tableName}.${columnName}`;
    return this.columnKeyMap.delete(key);
  }

  /**
   * Get the encryption key name for a column, if registered.
   */
  getColumnKey(tableName: string, columnName: string): string | undefined {
    return this.columnKeyMap.get(`${tableName}.${columnName}`);
  }

  /**
   * Get all registered column mappings.
   */
  getAllColumnMappings(): Array<{ tableName: string; columnName: string; keyName: string }> {
    const results: Array<{ tableName: string; columnName: string; keyName: string }> = [];
    for (const [key, keyName] of this.columnKeyMap) {
      const dotIdx = key.indexOf('.');
      if (dotIdx >= 0) {
        results.push({
          tableName: key.substring(0, dotIdx),
          columnName: key.substring(dotIdx + 1),
          keyName,
        });
      }
    }
    return results;
  }

  /**
   * Encrypt a value using the key mapped to the given table.column.
   *
   * @param tableName - The table name.
   * @param columnName - The column name.
   * @param plaintext - The value to encrypt.
   * @returns Encrypted buffer.
   * @throws If no key is mapped to this column.
   */
  encryptColumn(tableName: string, columnName: string, plaintext: string): Buffer {
    const keyName = this.getColumnKey(tableName, columnName);
    if (!keyName) {
      throw new Error(`No encryption key mapped for column ${tableName}.${columnName}`);
    }
    return this.encryptValue(keyName, plaintext);
  }

  /**
   * Decrypt a value using the key mapped to the given table.column.
   *
   * @param tableName - The table name.
   * @param columnName - The column name.
   * @param ciphertext - The encrypted buffer.
   * @returns Decrypted plaintext string.
   * @throws If no key is mapped to this column.
   */
  decryptColumn(tableName: string, columnName: string, ciphertext: Buffer): string {
    const keyName = this.getColumnKey(tableName, columnName);
    if (!keyName) {
      throw new Error(`No encryption key mapped for column ${tableName}.${columnName}`);
    }
    return this.decryptValue(keyName, ciphertext);
  }

  /**
   * Helper: register a column mapping AND create the key if it doesn't exist.
   *
   * @param tableName - The table containing the column.
   * @param columnName - The column to encrypt.
   * @param keyName - The CEK name (will be created if missing).
   * @param algorithm - Encryption algorithm (default: aes-256-gcm).
   */
  setupColumnEncryption(
    tableName: string,
    columnName: string,
    keyName: string,
    algorithm: CekAlgorithm = 'aes-256-gcm',
  ): void {
    if (!this.hasKey(keyName)) {
      this.createColumnEncryptionKey(keyName, algorithm);
    }
    this.registerColumnMapping(tableName, columnName, keyName);
  }

  // ── Master-key wrapping for stored CEKs ──────────────────────────────────────

  /**
   * Encrypt the raw CEK for storage (wraps with master key).
   *
   * @param name Key name.
   * @returns Encrypted CEK blob: IV (12) + ciphertext + authTag (16).
   * @throws If the key does not exist.
   */
  wrapKey(name: string): Buffer {
    const cek = this.keys.get(name);
    if (!cek) {
      throw new Error(`Column encryption key not found: ${name}`);
    }

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    // Store algorithm + version + key material
    const plaintext = Buffer.concat([
      Buffer.from(cek.algorithm, 'utf-8'),
      Buffer.from([0]), // null delimiter
      Buffer.from([cek.version]),
      cek.key,
    ]);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, authTag]);
  }

  /**
   * Unwrap a previously wrapped CEK blob.
   *
   * @param name        Key name.
   * @param wrappedBlob Blob: IV (12) + ciphertext + authTag (16).
   * @returns The unwrapped ColumnEncryptionKey.
   */
  unwrapKey(name: string, wrappedBlob: Buffer): ColumnEncryptionKey {
    const iv = wrappedBlob.subarray(0, IV_LENGTH);
    const authTag = wrappedBlob.subarray(wrappedBlob.length - AUTH_TAG_LENGTH);
    const encrypted = wrappedBlob.subarray(IV_LENGTH, wrappedBlob.length - AUTH_TAG_LENGTH);

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    // Parse: algorithm\0\version\0 + key
    // Find first null byte to extract algorithm
    const nullIdx = plaintext.indexOf(0);
    if (nullIdx < 1) {
      throw new Error('Invalid wrapped key format: could not parse algorithm');
    }
    const algorithmBuf = plaintext.subarray(0, nullIdx);
    const algorithm = algorithmBuf.toString('utf-8') as CekAlgorithm;
    const version = plaintext[nullIdx + 1]!;
    const key = plaintext.subarray(nullIdx + 2);

    if (key.length !== 32) {
      throw new Error(`Invalid key length in wrapped blob: ${key.length}`);
    }

    const cek: ColumnEncryptionKey = {
      name,
      algorithm,
      key,
      createdAt: new Date(),
      version,
    };

    this.keys.set(name, cek);
    return cek;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Persist all in-memory keys to an SQLite database.
   * Each key is wrapped (encrypted with master key) before storage.
   *
   * @param db An object with an `exec` method (BetterSqlite3 or `node:sqlite`).
   */
  async persistKeys(db: { exec: (sql: string, ...params: any[]) => any; prepare?: (sql: string) => any }): Promise<void> {
    // Ensure the table exists
    if (typeof db.exec === 'function') {
      await db.exec(CREATE_KEYS_TABLE_SQL);
    }

    for (const [name, cek] of this.keys) {
      const wrapped = this.wrapKey(name);

      try {
        // Upsert: insert or update on conflict
        if (typeof db.prepare === 'function') {
          const stmt = db.prepare(
            `INSERT OR REPLACE INTO __column_encryption_keys (key_name, algorithm, encrypted_key, version, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          );
          await stmt.run(name, cek.algorithm, wrapped, cek.version, cek.createdAt.toISOString());
        } else {
          await db.exec(
            `INSERT OR REPLACE INTO __column_encryption_keys (key_name, algorithm, encrypted_key, version, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            name,
            cek.algorithm,
            wrapped,
            cek.version,
            cek.createdAt.toISOString(),
          );
        }
      } catch (err: any) {
        this.logger.error({ keyName: name, err: err.message }, 'Failed to persist key');
      }
    }

    this.logger.info({ keyCount: this.keys.size }, 'Column encryption keys persisted');
  }

  /**
   * Load keys from an SQLite database into memory.
   *
   * @param db An object with a `query` or `prepare` / `all` method.
   */
  async loadKeys(db: { query?: (sql: string, ...params: any[]) => any[]; prepare?: (sql: string) => { all: (...params: any[]) => any[]; get: (...params: any[]) => any } }): Promise<number> {
    let rows: any[];
    try {
      if (typeof db.prepare === 'function') {
        const stmt = db.prepare('SELECT key_name, algorithm, encrypted_key, version FROM __column_encryption_keys');
        rows = await stmt.all();
      } else if (typeof db.query === 'function') {
        rows = await db.query('SELECT key_name, algorithm, encrypted_key, version FROM __column_encryption_keys');
      } else {
        throw new Error('Database does not support query or prepare');
      }
    } catch {
      // Table may not exist yet
      return 0;
    }

    let loaded = 0;
    for (const row of rows) {
      try {
        this.unwrapKey(row.key_name, row.encrypted_key);
        loaded++;
      } catch (err: any) {
        this.logger.error({ keyName: row.key_name, err: err.message }, 'Failed to load key');
      }
    }

    this.logger.info({ loaded }, 'Column encryption keys loaded');
    return loaded;
  }

  // ── DDL parsing ─────────────────────────────────────────────────────────────

  /**
   * Parse and execute a `CREATE COLUMN ENCRYPTION KEY` DDL statement.
   *
   * Supported syntax:
   * ```
   * CREATE COLUMN ENCRYPTION KEY <name>
   *   WITH ALGORITHM = '<algorithm>'
   * ```
   *
   * `ALGORITHM` defaults to `aes-256-gcm` if omitted.
   *
   * @param sql The DDL statement.
   * @returns Result of the key creation, or `null` if the SQL is not a CEK DDL.
   */
  parseAndCreateKey(sql: string): CreateColumnEncryptionKeyResult | null {
    // eslint-disable-next-line require-unicode-regexp
    const match = sql.match(
      /^\s*CREATE\s+COLUMN\s+ENCRYPTION\s+KEY\s+([`"']?)(\w+)\1(?:\s+WITH\s+ALGORITHM\s*=\s*['"]?(\w+(?:-\w+)*)['"]?)?\s*;?\s*$/i,
    );
    if (!match) return null;

    const keyName = match[2]!;
    const algorithm = (match[3] ?? 'aes-256-gcm') as CekAlgorithm;
    return this.createColumnEncryptionKey(keyName, algorithm);
  }

  // ── ENCRYPTED WITH column syntax ────────────────────────────────────────────

  /**
   * Parse a column definition that includes `ENCRYPTED WITH (<key_name>)`.
   *
   * Supported syntax (inside a CREATE TABLE):
   * ```
   * <column_name> <type> ENCRYPTED WITH (<key_name>)
   * ```
   *
   * @param columnDef The full column definition string.
   * @returns The CEK name if found, or `null`.
   */
  static parseEncryptedWith(columnDef: string): string | null {
    // eslint-disable-next-line require-unicode-regexp
    const match = columnDef.match(
      /ENCRYPTED\s+WITH\s*\(\s*([`"']?)(\w+)\1\s*\)/i,
    );
    return match ? match[2]! : null;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Reset all in-memory state (for testing).
   */
  reset(): void {
    this.keys.clear();
    this.columnKeyMap.clear();
    this.masterKey = crypto.randomBytes(32);
    this.logger.info('ColumnEncryption state reset');
  }

  /**
   * Get the number of registered keys.
   */
  get keyCount(): number {
    return this.keys.size;
  }
}
