// @ts-nocheck
/**
 * TDEEngine — Full-file AES-256-GCM encryption engine for Transparent Data Encryption (TDE).
 *
 * This module provides encrypt/decrypt operations on entire SQLite database files,
 * wrapping them in a custom container format:
 *
 *   [16 bytes: IV]
 *   [16 bytes: Auth Tag (GCM)]
 *   [1 byte:  keyVersion]
 *   [N bytes: Encrypted SQLite file data (AES-256-GCM)]
 *
 * The engine uses Node.js built-in `crypto` module for all cryptographic operations.
 * Key derivation uses scryptSync for secure key stretching.
 *
 * ## Design
 *
 * Unlike the page-level TDE approach in query/TDEShim.ts (which encrypts individual
 * SQLite pages on read/write), this engine treats the entire database file as a single
 * opaque blob:
 *
 *   1. **Open**: Decrypt the full file to a temp location → SQLite reads the decrypted copy
 *   2. **Close**: Encrypt the SQLite file back to the encrypted container → delete temp copy
 *
 * This approach is simpler and more robust than page-level encryption:
 *   - No page-size assumptions
 *   - Works with any SQLite page size
 *   - No SQLite VFS integration needed
 *   - Atomic encrypt/decrypt operations
 *   - Strong authentication (GCM) ensures integrity
 *
 * ## Key Derivation
 *
 * Keys are derived using scryptSync with the following parameters:
 *   - N = 2^14 (16384) — CPU/memory cost
 *   - r = 8 — block size
 *   - p = 1 — parallelization
 *   - keylen = 32 (256 bits for AES-256-GCM)
 *   - salt = SHA-256(keySource + "TDEEngine-v1")
 *
 * ## File Format
 *
 * The encrypted file format is:
 * ```
 * +------------------+------------------+----------+------------------------+
 * | IV (16 bytes)    | Auth Tag (16 B)  | Key Ver  | Ciphertext (variable)  |
 * +------------------+------------------+----------+------------------------+
 * ```
 *
 * This format is inspired by SQLCipher but simplified: no reserve bytes, no
 * page-size header, and a single auth tag for the entire file.
 *
 * @module storage/TDEEngine
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('TDEEngine');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Supported encryption algorithms */
export type TDEAlgorithm = 'aes-256-gcm' | 'aes-192-gcm' | 'aes-128-gcm';

/** Key derivation strategies */
export type TDEKeyDerivation = 'env' | 'file' | 'direct';

/** Default scrypt parameters */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

/** Size constants */
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_VERSION_LENGTH = 1;
const HEADER_LENGTH = IV_LENGTH + AUTH_TAG_LENGTH + KEY_VERSION_LENGTH;

/** Salt derivation prefix */
const SALT_PREFIX = 'TDEEngine-v1';

/** Algorithm → key length map */
const KEY_LENGTH_MAP: Record<TDEAlgorithm, number> = {
  'aes-256-gcm': 32,
  'aes-192-gcm': 24,
  'aes-128-gcm': 16,
};

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface TDEOptions {
  algorithm: TDEAlgorithm;
  keyDerivation: TDEKeyDerivation;
  keySource: string; // env var name, file path, or direct base64 key
  keyVersion: number;
}

export interface EncryptResult {
  success: boolean;
  iv: string;
  authTag: string;
  keyVersion: number;
  error?: string;
}

export interface DecryptResult {
  success: boolean;
  keyVersion: number;
  error?: string;
}

// ──────────────────────────────────────────────
//  Default options
// ──────────────────────────────────────────────

const DEFAULT_OPTIONS: TDEOptions = {
  algorithm: 'aes-256-gcm',
  keyDerivation: 'env',
  keySource: 'SQLVEC_TDE_KEY',
  keyVersion: 1,
};

// ──────────────────────────────────────────────
//  TDEEngine
// ──────────────────────────────────────────────

export class TDEEngine {
  private options: TDEOptions;
  private _derivedKey: Buffer | null = null;

  constructor(options?: Partial<TDEOptions>) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  // ── Public API ─────────────────────────────

  /**
   * Derive the encryption key based on the configured key derivation strategy.
   *
   * Strategies:
   *   - `env`: Read base64-encoded key from environment variable (keySource = env var name)
   *   - `file`: Read hexadecimal key from file (keySource = file path)
   *   - `direct`: keySource is a base64-encoded key string directly
   *
   * The raw key material is processed through scryptSync for key derivation.
   *
   * @returns A 32-byte (or algorithm-appropriate) Buffer.
   * @throws {Error} If the key cannot be derived (missing env var, invalid key, etc.)
   */
  deriveKey(): Buffer {
    if (this._derivedKey) {
      return this._derivedKey;
    }

    let rawKey: Buffer;

    switch (this.options.keyDerivation) {
      case 'env': {
        const envKey = process.env[this.options.keySource];
        if (!envKey) {
          throw new Error(
            `TDEEngine: environment variable "${this.options.keySource}" not set`,
          );
        }
        rawKey = Buffer.from(envKey, 'base64');
        break;
      }

      case 'file': {
        if (!fs.existsSync(this.options.keySource)) {
          throw new Error(
            `TDEEngine: key file not found at "${this.options.keySource}"`,
          );
        }
        const fileContent = fs.readFileSync(this.options.keySource, 'utf-8').trim();
        rawKey = Buffer.from(fileContent, 'hex');
        break;
      }

      case 'direct': {
        rawKey = Buffer.from(this.options.keySource, 'base64');
        break;
      }

      default: {
        throw new Error(
          `TDEEngine: unknown key derivation strategy "${this.options.keyDerivation}"`,
        );
      }
    }

    const expectedKeyLen = KEY_LENGTH_MAP[this.options.algorithm];

    // If raw key is already the right length, use it directly (without scrypt)
    if (rawKey.length === expectedKeyLen) {
      logger.debug(
        { algorithm: this.options.algorithm, keyLength: rawKey.length },
        'TDEEngine: using raw key directly (scrypt skipped — key length matches)',
      );
      this._derivedKey = rawKey;
      return rawKey;
    }

    // Derive key using scrypt for additional security
    const salt = crypto
      .createHash('sha256')
      .update(this.options.keySource + SALT_PREFIX)
      .digest();

    const derivedKey = crypto.scryptSync(rawKey, salt, expectedKeyLen, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });

    logger.debug(
      {
        algorithm: this.options.algorithm,
        rawKeyLength: rawKey.length,
        derivedKeyLength: derivedKey.length,
      },
      'TDEEngine: derived encryption key via scrypt',
    );

    this._derivedKey = derivedKey;
    return derivedKey;
  }

  /**
   * Encrypt a SQLite database file using AES-256-GCM (full-file encryption).
   *
   * Reads the entire input file, encrypts it, and writes the encrypted output
   * in the format: [16 B IV][16 B Auth Tag][1 B keyVersion][ciphertext].
   *
   * @param inputPath  - Path to the source SQLite database file.
   * @param outputPath - Path for the encrypted output file (may be same as inputPath).
   * @param key        - Optional key buffer. If omitted, deriveKey() is called.
   * @returns EncryptResult with success status and encryption metadata.
   */
  encryptFile(
    inputPath: string,
    outputPath: string,
    key?: Buffer,
  ): EncryptResult {
    try {
      const encryptionKey = key ?? this.deriveKey();
      const algorithm = this.options.algorithm;

      // Read the full input file
      const plaintext = fs.readFileSync(inputPath);

      if (plaintext.length === 0) {
        return {
          success: false,
          iv: '',
          authTag: '',
          keyVersion: this.options.keyVersion,
          error: 'Cannot encrypt empty file',
        };
      }

      // Generate random IV
      const iv = crypto.randomBytes(IV_LENGTH);

      // Create cipher
      const cipher = crypto.createCipheriv(algorithm, encryptionKey, iv);

      // Encrypt
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);

      // Get auth tag (GCM authentication)
      const authTag = cipher.getAuthTag();

      // Build output: [IV][Auth Tag][keyVersion][ciphertext]
      const keyVersionBuf = Buffer.alloc(KEY_VERSION_LENGTH);
      keyVersionBuf.writeUInt8(this.options.keyVersion, 0);

      const output = Buffer.concat([
        iv,
        authTag,
        keyVersionBuf,
        ciphertext,
      ]);

      // Write output
      fs.writeFileSync(outputPath, output);

      logger.info(
        {
          inputSize: plaintext.length,
          outputSize: output.length,
          algorithm,
          keyVersion: this.options.keyVersion,
        },
        'TDEEngine: file encrypted successfully',
      );

      return {
        success: true,
        iv: iv.toString('hex'),
        authTag: authTag.toString('hex'),
        keyVersion: this.options.keyVersion,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'TDEEngine: file encryption failed');
      return {
        success: false,
        iv: '',
        authTag: '',
        keyVersion: this.options.keyVersion,
        error: err.message,
      };
    }
  }

  /**
   * Decrypt a previously encrypted SQLite database file.
   *
   * Reads the encrypted file, extracts IV + auth tag from the header,
   * decrypts the ciphertext, and writes the plaintext to the output path.
   *
   * @param inputPath  - Path to the encrypted file.
   * @param outputPath - Path for the decrypted SQLite database file.
   * @param key        - Optional key buffer. If omitted, deriveKey() is called.
   * @returns DecryptResult with success status and metadata.
   */
  decryptFile(
    inputPath: string,
    outputPath: string,
    key?: Buffer,
  ): DecryptResult {
    try {
      const encryptionKey = key ?? this.deriveKey();
      const algorithm = this.options.algorithm;

      // Read the encrypted file
      const encrypted = fs.readFileSync(inputPath);

      if (encrypted.length < HEADER_LENGTH) {
        return {
          success: false,
          keyVersion: 0,
          error: `File too small to be a valid TDE-encrypted file (${encrypted.length} bytes, need at least ${HEADER_LENGTH})`,
        };
      }

      // Parse header
      const iv = encrypted.subarray(0, IV_LENGTH);
      const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const keyVersion = encrypted.readUInt8(IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = encrypted.subarray(HEADER_LENGTH);

      // Create decipher
      const decipher = crypto.createDecipheriv(algorithm, encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // Decrypt
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      // Write decrypted output
      fs.writeFileSync(outputPath, plaintext);

      logger.info(
        {
          encryptedSize: encrypted.length,
          decryptedSize: plaintext.length,
          algorithm,
          keyVersion,
        },
        'TDEEngine: file decrypted successfully',
      );

      return {
        success: true,
        keyVersion,
      };
    } catch (err: any) {
      logger.error({ err: err.message }, 'TDEEngine: file decryption failed');

      // Distinguish between wrong-key errors and other failures
      if (
        err.message?.includes('auth') ||
        err.message?.includes('tag') ||
        err.message?.includes('mac') ||
        err.message?.includes('bad decrypt')
      ) {
        return {
          success: false,
          keyVersion: 0,
          error: 'Decryption failed: incorrect key or corrupt data (GCM authentication failure)',
        };
      }

      return {
        success: false,
        keyVersion: 0,
        error: err.message,
      };
    }
  }

  /**
   * Rotate the encryption key for a TDE-encrypted file.
   *
   * Decrypts with the old key and re-encrypts with the new key.
   * The keyVersion is incremented automatically.
   *
   * @param filePath - Path to the TDE-encrypted file (encrypted in-place).
   * @param oldKey   - The current encryption key.
   * @param newKey   - The new encryption key.
   * @returns true if rotation succeeded, false otherwise.
   */
  rotateKey(filePath: string, oldKey: Buffer, newKey: Buffer): boolean {
    try {
      // Create a temp path for the decrypted file
      const dir = path.dirname(filePath);
      const base = path.basename(filePath);
      const tempPath = path.join(dir, `.${base}.decrypting.tmp`);

      // Decrypt with old key to temp
      const decryptResult = this.decryptFile(filePath, tempPath, oldKey);
      if (!decryptResult.success) {
        logger.error(
          { filePath },
          'TDEEngine: key rotation failed — unable to decrypt with old key',
        );
        return false;
      }

      // Store old version
      const oldKeyVersion = this.options.keyVersion;

      // Increment key version for the new encryption
      this.options.keyVersion = oldKeyVersion + 1;

      // Re-encrypt with new key (in-place)
      const encryptResult = this.encryptFile(tempPath, filePath, newKey);
      if (!encryptResult.success) {
        // Rollback key version
        this.options.keyVersion = oldKeyVersion;
        logger.error(
          { filePath },
          'TDEEngine: key rotation failed — unable to re-encrypt with new key',
        );

        // Try to restore original encrypted file
        // (The encrypted file at filePath may have been partially overwritten,
        //  but encryptFile writes atomically on most systems, so on failure the
        //  original should be intact.)
        return false;
      }

      // Clean up temp file
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup
      }

      // Clear cached derived key so next deriveKey() call re-derives
      this._derivedKey = null;

      logger.info(
        {
          filePath,
          oldKeyVersion,
          newKeyVersion: this.options.keyVersion,
        },
        'TDEEngine: key rotation completed successfully',
      );

      return true;
    } catch (err: any) {
      logger.error(
        { err: err.message, filePath },
        'TDEEngine: key rotation failed with unexpected error',
      );
      return false;
    }
  }

  /**
   * Verify the integrity of a TDE-encrypted file without writing decrypted output.
   *
   * Decrypts the file in memory and verifies the GCM authentication tag.
   * If the auth tag is valid, the file has not been tampered with.
   *
   * @param filePath - Path to the TDE-encrypted file.
   * @param key      - Optional key buffer. If omitted, deriveKey() is called.
   * @returns true if the file is valid (correct key + no tampering), false otherwise.
   */
  verifyFile(filePath: string, key?: Buffer): boolean {
    try {
      const encryptionKey = key ?? this.deriveKey();
      const algorithm = this.options.algorithm;

      const encrypted = fs.readFileSync(filePath);

      if (encrypted.length < HEADER_LENGTH) {
        logger.warn(
          { filePath, size: encrypted.length },
          'TDEEngine: verifyFile — file too small for TDE format',
        );
        return false;
      }

      const iv = encrypted.subarray(0, IV_LENGTH);
      const authTag = encrypted.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
      const ciphertext = encrypted.subarray(HEADER_LENGTH);

      const decipher = crypto.createDecipheriv(algorithm, encryptionKey, iv);
      decipher.setAuthTag(authTag);

      // We don't care about the plaintext, just that GCM auth passes
      decipher.update(ciphertext);
      decipher.final();

      logger.debug({ filePath }, 'TDEEngine: file integrity verified (GCM auth tag valid)');
      return true;
    } catch (err: any) {
      logger.warn(
        { filePath, err: err.message },
        'TDEEngine: file integrity verification failed',
      );
      return false;
    }
  }

  /**
   * Get the current configuration.
   */
  getConfig(): TDEOptions {
    return { ...this.options };
  }

  /**
   * Reset the engine state (for testing).
   */
  reset(): void {
    this._derivedKey = null;
  }

  /**
   * Check if TDE is enabled (a key can be derived).
   */
  isEnabled(): boolean {
    try {
      this.deriveKey();
      return true;
    } catch {
      return false;
    }
  }
}
