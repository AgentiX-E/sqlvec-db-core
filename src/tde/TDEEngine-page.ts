/**
 * TDEEngine — Transparent Data Encryption engine using AES-256-GCM.
 *
 * Provides actual page-level encryption/decryption for SQLite databases.
 * Designed to intercept writes/reads at the storage layer.
 *
 * ## Design
 *
 * - Uses AES-256-GCM with a 256-bit key + 96-bit IV + 128-bit auth tag
 * - Page-level: each 4KB SQLite page is encrypted independently
 * - Key wrapping via KEK (Key Encryption Key) for master key protection
 * - Key derivation via crypto.scryptSync(password, salt, 32)
 *
 * ## Usage
 *
 * ```ts
 * const engine = new TDEEngine();
 * await engine.init('my-strong-password');
 *
 * const pageBuf = fs.readFileSync('page.bin');
 * const encBuf = engine.encryptPage(pageBuf, pageNum);
 * const decBuf = engine.decryptPage(encBuf, pageNum);
 * ```
 *
 * @module encryption/TDEEngine
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('TDEEngine');

// ── Constants ────────────────────────────────────────────────────

/** AES-256-GCM key size in bytes. */
const KEY_SIZE = 32;

/** AES-GCM IV size in bytes. */
const IV_SIZE = 12;

/** AES-GCM auth tag size in bytes. */
const TAG_SIZE = 16;

/** SQLite default page size (4096 bytes). */
const SQLITE_PAGE_SIZE = 4096;

/** AES-GCM cipher algorithm string. */
const CIPHER_ALGO = 'aes-256-gcm';

/** KEK salt length in bytes. */
const KEK_SALT_SIZE = 16;

/** KEK scrypt parameters: N (CPU/memory cost). */
const KEK_SCRYPT_N = 2 ** 14; // 16384

/** KEK scrypt parameters: r (block size). */
const KEK_SCRYPT_R = 8;

/** KEK scrypt parameters: p (parallelization). */
const KEK_SCRYPT_P = 1;

/** Version byte for wrapped key format. */
const WRAPPED_KEY_VERSION = 1;

// ── Types ────────────────────────────────────────────────────────

export interface TDEEngineConfig {
  /** Path to store the wrapped master key (optional). */
  keyPath?: string;

  /** AES-GCM IV generation: 'random' (default) or 'counter'. */
  ivMode?: 'random' | 'counter';

  /** Whether TDE is enabled. */
  enabled?: boolean;

  /** The encryption algorithm identifier (for SHOW commands). */
  algorithm?: string;
}

export interface WrappedKeyHeader {
  version: number;
  kekSalt: Buffer;
  kekIV: Buffer;
  wrappedKey: Buffer;
  tag: Buffer;
}

export interface TDEPageHeader {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

// ── TDEEngine Class ──────────────────────────────────────────────

export class TDEEngine {
  private masterKey: Buffer | null = null;
  private config: Required<TDEEngineConfig>;
  private _initialized = false;
  private _keyVersion = 1;

  // ── Test injection ─────────────────────────────────────────────
  /** For testing: inject a known master key. */
  public setTestKey(key: Buffer): void {
    this.masterKey = key;
    this._initialized = true;
  }

  constructor(config?: TDEEngineConfig) {
    this.config = {
      keyPath: config?.keyPath ?? './data/tde-master.key.wrapped',
      ivMode: config?.ivMode ?? 'random',
      enabled: config?.enabled ?? false,
      algorithm: config?.algorithm ?? 'aes-256-gcm',
    };
  }

  // ── Initialisation ─────────────────────────────────────────────

  /**
   * Initialise the TDE engine.
   *
   * Two modes:
   * 1. New key: If no wrapped key file exists, create a new 256-bit master key,
   *    wrap it with KEK derived from `password`, and persist.
   * 2. Existing key: Load the wrapped key file, unwrap using KEK from password.
   *
   * @param password - The passphrase to protect the master key.
   */
  async init(password: string): Promise<void> {
    if (this._initialized) return;

    const keyPath = this.config.keyPath;
    const dir = path.dirname(keyPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(keyPath)) {
      // Load existing wrapped master key
      const wrappedData = fs.readFileSync(keyPath);
      this.masterKey = this.unwrapMasterKey(wrappedData, password);
      logger.info('TDE master key loaded from %s', keyPath);
    } else {
      // Generate new master key
      this.masterKey = crypto.randomBytes(KEY_SIZE);
      const wrapped = this.wrapMasterKey(this.masterKey, password);
      fs.writeFileSync(keyPath, wrapped);
      fs.chmodSync(keyPath, 0o600);
      logger.info('TDE master key generated and wrapped to %s', keyPath);
    }

    this._initialized = true;
    logger.info('TDEEngine initialised (algorithm=%s, keyPath=%s)', this.config.algorithm, keyPath);
  }

  // ── Page encryption ────────────────────────────────────────────

  /**
   * Encrypt a single SQLite page.
   *
   * @param plaintext - Raw page data (typically 4096 bytes).
   * @param pageNum   - Page number (used as AAD for integrity).
   * @returns Encrypted page: [IV (12) || TAG (16) || CIPHERTEXT (4096)]
   */
  encryptPage(plaintext: Buffer, pageNum: number): Buffer {
    if (!this._initialized || !this.masterKey) {
      throw new Error('TDEEngine not initialised');
    }

    const iv = crypto.randomBytes(IV_SIZE);
    const aad = this.buildAAD(pageNum, iv);

    const cipher = crypto.createCipheriv(CIPHER_ALGO, this.masterKey, iv);
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Output: IV (12 bytes) || TAG (16 bytes) || CIPHERTEXT (4096 bytes)
    return Buffer.concat([iv, tag, encrypted]);
  }

  /**
   * Decrypt a single SQLite page.
   *
   * @param encrypted - Encrypted page: [IV (12) || TAG (16) || CIPHERTEXT (4096)]
   * @param pageNum   - Page number (must match encryption).
   * @returns Decrypted page data (4096 bytes).
   * @throws If authentication fails (tampered data or wrong key).
   */
  decryptPage(encrypted: Buffer, pageNum: number): Buffer {
    if (!this._initialized || !this.masterKey) {
      throw new Error('TDEEngine not initialised');
    }

    if (encrypted.length < IV_SIZE + TAG_SIZE) {
      throw new Error('Invalid encrypted page: too short');
    }

    const iv = encrypted.subarray(0, IV_SIZE);
    const tag = encrypted.subarray(IV_SIZE, IV_SIZE + TAG_SIZE);
    const ciphertext = encrypted.subarray(IV_SIZE + TAG_SIZE);

    const aad = this.buildAAD(pageNum, iv);

    const decipher = crypto.createDecipheriv(CIPHER_ALGO, this.masterKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err: any) {
      logger.error({ pageNum, err: err.message }, 'TDE page decryption failed — possible key mismatch or tampered data');
      throw new Error(`TDE decryption failed for page ${pageNum}: ${err.message}`);
    }
  }

  /**
   * Encrypt a buffer for general-purpose usage (e.g., WAL pages).
   *
   * @param plaintext - Arbitrary data to encrypt.
   * @param context   - AAD context string (e.g. 'wal-page-42').
   * @returns Encrypted buffer: [IV (12) || TAG (16) || CIPHERTEXT].
   */
  encrypt(plaintext: Buffer, context?: string): Buffer {
    if (!this._initialized || !this.masterKey) {
      throw new Error('TDEEngine not initialised');
    }

    const iv = crypto.randomBytes(IV_SIZE);
    const aad = context ? Buffer.from(context, 'utf-8') : Buffer.alloc(0);

    const cipher = crypto.createCipheriv(CIPHER_ALGO, this.masterKey, iv);
    cipher.setAAD(aad);

    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([iv, tag, encrypted]);
  }

  /**
   * Decrypt a buffer previously encrypted with `encrypt()`.
   *
   * @param encrypted - Buffer: [IV (12) || TAG (16) || CIPHERTEXT].
   * @param context   - AAD context string (must match encryption).
   * @returns Decrypted plaintext.
   */
  decrypt(encrypted: Buffer, context?: string): Buffer {
    if (!this._initialized || !this.masterKey) {
      throw new Error('TDEEngine not initialised');
    }

    if (encrypted.length < IV_SIZE + TAG_SIZE) {
      throw new Error('Invalid encrypted data: too short');
    }

    const iv = encrypted.subarray(0, IV_SIZE);
    const tag = encrypted.subarray(IV_SIZE, IV_SIZE + TAG_SIZE);
    const ciphertext = encrypted.subarray(IV_SIZE + TAG_SIZE);
    const aad = context ? Buffer.from(context, 'utf-8') : Buffer.alloc(0);

    const decipher = crypto.createDecipheriv(CIPHER_ALGO, this.masterKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err: any) {
      throw new Error(`TDE decrypt failed: ${err.message}`);
    }
  }

  // ── Key management ─────────────────────────────────────────────

  /**
   * Rotate the master key: generate new key, re-wrap.
   *
   * @param password - Current passphrase (to unwrap old key).
   * @param newPassword - Optional new passphrase (defaults to same).
   */
  rotateKey(password: string, newPassword?: string): void {
    if (!this._initialized) {
      throw new Error('TDEEngine not initialised');
    }

    const newPwd = newPassword ?? password;
    const oldKey = this.masterKey;

    // Generate new master key
    this.masterKey = crypto.randomBytes(KEY_SIZE);
    this._keyVersion++;

    // Persist wrapped key
    const wrapped = this.wrapMasterKey(this.masterKey, newPwd);
    fs.writeFileSync(this.config.keyPath, wrapped);
    fs.chmodSync(this.config.keyPath, 0o600);

    logger.info({ newVersion: this._keyVersion }, 'TDE master key rotated');

    // Note: old data encrypted with old key cannot be read with new key.
    // In production, you would re-encrypt all pages or keep old key versions.
  }

  /**
   * Get the key version.
   */
  get keyVersion(): number {
    return this._keyVersion;
  }

  /**
   * Check if the engine is initialised with a master key.
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the configured algorithm name.
   */
  get algorithm(): string {
    return this.config.algorithm;
  }

  /**
   * Check whether TDE is enabled.
   */
  get isEnabled(): boolean {
    return this.config.enabled && this._initialized;
  }

  /**
   * Enable or disable TDE.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  // ── KEK wrapping / unwrapping ──────────────────────────────────

  /**
   * Wrap a master key with a KEK derived from a password.
   *
   * Format:
   *   [VERSION:1][KEK_SALT:16][KEK_IV:12][WRAPPED_KEY:32][TAG:16]
   *   = 77 bytes total
   *
   * @param masterKey - Raw 32-byte master key.
   * @param password  - Passphrase to protect the key.
   * @returns Wrapped key buffer.
   */
  wrapMasterKey(masterKey: Buffer, password: string): Buffer {
    const kekSalt = crypto.randomBytes(KEK_SALT_SIZE);
    const kek = crypto.scryptSync(password, kekSalt, KEY_SIZE, {
      N: KEK_SCRYPT_N,
      r: KEK_SCRYPT_R,
      p: KEK_SCRYPT_P,
    });

    const iv = crypto.randomBytes(IV_SIZE);
    const cipher = crypto.createCipheriv(CIPHER_ALGO, kek, iv);
    const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    const tag = cipher.getAuthTag();

    const header = Buffer.alloc(1);
    header.writeUInt8(WRAPPED_KEY_VERSION);

    return Buffer.concat([header, kekSalt, iv, encrypted, tag]);
  }

  /**
   * Unwrap a master key that was wrapped with `wrapMasterKey()`.
   *
   * @param wrappedData - The wrapped key buffer (77 bytes).
   * @param password    - Passphrase used to wrap the key.
   * @returns Raw 32-byte master key.
   * @throws If the password is wrong or data is tampered.
   */
  unwrapMasterKey(wrappedData: Buffer, password: string): Buffer {
    if (wrappedData.length < 1 + KEK_SALT_SIZE + IV_SIZE + KEY_SIZE + TAG_SIZE) {
      throw new Error('Invalid wrapped key data: too short');
    }

    let offset = 0;
    const version = wrappedData.readUInt8(offset); offset += 1;

    if (version !== WRAPPED_KEY_VERSION) {
      throw new Error(`Unsupported wrapped key version: ${version}`);
    }

    const kekSalt = wrappedData.subarray(offset, offset + KEK_SALT_SIZE); offset += KEK_SALT_SIZE;
    const iv = wrappedData.subarray(offset, offset + IV_SIZE); offset += IV_SIZE;
    const encrypted = wrappedData.subarray(offset, offset + KEY_SIZE); offset += KEY_SIZE;
    const tag = wrappedData.subarray(offset, offset + TAG_SIZE);

    const kek = crypto.scryptSync(password, kekSalt, KEY_SIZE, {
      N: KEK_SCRYPT_N,
      r: KEK_SCRYPT_R,
      p: KEK_SCRYPT_P,
    });

    const decipher = crypto.createDecipheriv(CIPHER_ALGO, kek, iv);
    decipher.setAuthTag(tag);

    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return plaintext;
  }

  // ── Internal helpers ───────────────────────────────────────────

  /**
   * Build AAD (Additional Authenticated Data) for a page.
   * Includes the page number and a magic constant to prevent cross-page substitution.
   */
  private buildAAD(pageNum: number, iv: Buffer): Buffer {
    const pageBuf = Buffer.alloc(8);
    pageBuf.writeBigUint64BE(BigInt(pageNum));
    const magic = Buffer.from('TDE1', 'utf-8');
    return Buffer.concat([magic, pageBuf, iv]);
  }
}

// ── Singleton ────────────────────────────────────────────────────

let _instance: TDEEngine | null = null;

/**
 * Get the global TDEEngine singleton.
 */
export function getTDEEngine(config?: TDEEngineConfig): TDEEngine {
  if (!_instance) {
    _instance = new TDEEngine(config);
  }
  return _instance;
}

/**
 * Reset the global TDEEngine singleton (for testing).
 */
export function resetTDEEngine(): void {
  _instance = null;
}
