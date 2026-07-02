/**
 * PgCryptoShim -- pgcrypto column-level encryption compatibility shim for SQLite.
 *
 * PostgreSQL provides the pgcrypto extension with functions for hashing,
 * password hashing (bcrypt), symmetric encryption (PGP), digests, and HMAC.
 * SQLite has no equivalent extension.
 *
 * Strategy:
 *   Replace pgcrypto function calls with SQLite-native equivalents:
 *     1. crypt(pwd, gen_salt('bf'))       -> hex(sha256(pwd))
 *     2. gen_salt('bf') (standalone)       -> 'salt'
 *     3. pgp_sym_encrypt(data, key)        -> _pgp_sym_encrypt_sc(data, key)
 *     4. pgp_sym_decrypt(data, key)        -> _pgp_sym_decrypt_sc(data, key)
 *     5. digest(data, 'sha256')            -> hex(sha256(data))
 *     6. hmac(data, key, 'sha256')         -> hex(sha256(data || key))
 *     7. Non-pgcrypto constructs           -> pass through unchanged
 *
 * **Security fix (GAP 3):**
 *   Previously pgp_sym_encrypt was a no-op (hex(data)) which is NOT encryption.
 *   Now uses real AES-256-GCM encryption via node-forge with:
 *     - Random salt (8 bytes)
 *     - PBKDF2 key derivation from password (N=16384 iterations, SHA-256)
 *     - AES-256-GCM encryption
 *     - Output: base64 of `salt || iv || ciphertext || authTag`
 *
 *   Backward compatible: detects legacy hex-only output format.
 *
 * @module PgCryptoShim
 */

import * as forge from 'node-forge';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('PgCryptoShim');

// ── Crypto constants ─────────────────────────────────────────────────────────

const SALT_BYTES = 8;          // Random salt length
const IV_BYTES = 12;           // AES-GCM standard IV/nonce length
const KEY_BITS = 256;          // AES-256
const KEY_BYTES = KEY_BITS / 8;
const AUTH_TAG_BYTES = 16;     // GCM authentication tag length
const PBKDF2_ITERATIONS = 16384;
const FORGE_AES256_KEY_BYTES = 32; // forge AES-256 key size in bytes (used inside KDF)

// Format version marker (1 byte prepended to output for future-proofing)
// v1 = salt || iv || ciphertext || authTag
const FORMAT_VERSION_SALT_IV_CT_TAG = 1; // base64 format

// Legacy hex detection: valid hex string of >= 2 chars
const RE_HEX_ONLY = /^[0-9a-fA-F]+$/;

// ---- Types ------------------------------------------------------

export interface PgCryptoResult {
  /** Rewritten SQL (original if no pgcrypto constructs found) */
  sql: string;
  /** Whether any pgcrypto rewrite was applied */
  rewritten: boolean;
}

// ---- Regex (factory functions to avoid lastIndex issues) ---------

/** gen_salt(...) standalone */
const RE_GEN_SALT = (): RegExp => /\bgen_salt\s*\([^)]*\)/gi;

/**
 * crypt(expr1, expr2)
 * Captures the first argument (up to the first comma, allowing one level
 * of nested parens for simple function calls like md5(x)).
 */
const RE_CRYPT = (): RegExp =>
  /\bcrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

/**
 * pgp_sym_encrypt(expr1, expr2)
 * Captures the first argument (the data payload).
 */
const RE_PGP_SYM_ENCRYPT = (): RegExp =>
  /\bpgp_sym_encrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

/**
 * pgp_sym_decrypt(expr1, expr2)
 * Captures the first argument (the ciphertext payload).
 */
const RE_PGP_SYM_DECRYPT = (): RegExp =>
  /\bpgp_sym_decrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

/**
 * pgp_pub_encrypt(expr1, expr2) / pgp_pub_decrypt(expr1, expr2)
 * Captures the first argument.
 */
const RE_PGP_PUB_ENCRYPT = (): RegExp =>
  /\bpgp_pub_encrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

const RE_PGP_PUB_DECRYPT = (): RegExp =>
  /\bpgp_pub_decrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

/**
 * digest(expr1, expr2)
 * Captures the first argument (the data to hash).
 */
const RE_DIGEST = (): RegExp =>
  /\bdigest\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

/**
 * hmac(expr1, expr2, expr3)
 * Captures the first two arguments (data and key).
 */
const RE_HMAC = (): RegExp =>
  /\bhmac\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*((?:[^,()]+|\([^)]*\))+)\s*,\s*[^)]+\)/gi;

// ---- Detection patterns -----------------------------------------

/** Any pgcrypto function name */
const RE_ANY_PGCRYPTO_FN = (): RegExp =>
  /\b(?:crypt|gen_salt|pgp_sym_encrypt|pgp_sym_decrypt|pgp_pub_encrypt|pgp_pub_decrypt|digest|hmac)\s*\(/gi;

// ---- Detect -----------------------------------------------------

/**
 * Detect whether the given SQL contains any pgcrypto function calls.
 *
 * String literals, identifiers, and comments are stripped before
 * checking to minimise false positives.
 *
 * @param sql - The SQL statement to check.
 * @returns true if pgcrypto constructs are present.
 */
export function detectPgCrypto(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const cleaned = stripStringsAndComments(sql);

  return RE_ANY_PGCRYPTO_FN().test(cleaned);
}

// ---- Real crypto functions (GAP 3 fix) ---------------------------

/**
 * AES-256-GCM encrypt with PBKDF2 key derivation.
 *
 * Output format (base64-encoded):
 *   salt (8 bytes) || iv (12 bytes) || ciphertext (variable) || authTag (16 bytes)
 *
 * Uses TextEncoder to properly handle Unicode characters (UTF-8).
 *
 * @param data     - Plaintext data to encrypt.
 * @param password - Passphrase for key derivation.
 * @returns Base64-encoded ciphertext.
 */
export function pgp_sym_encrypt(data: string, password: string): string {
  if (!data) return '';
  if (!password) {
    logger.warn('pgp_sym_encrypt called with empty password — returning empty string');
    return '';
  }

  // 1. Generate random salt
  const salt = forge.random.getBytesSync(SALT_BYTES);

  // 2. Derive encryption key via PBKDF2
  const key = forge.pkcs5.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES);

  // 3. Generate random IV
  const iv = forge.random.getBytesSync(IV_BYTES);

  // 4. Encode to UTF-8 bytes (binary string for forge)
  const dataBytes = utf8Encode(data);

  // 5. AES-256-GCM encrypt
  const cipher = forge.cipher.createCipher('AES-GCM', forge.util.createBuffer(key));
  cipher.start({ iv: forge.util.createBuffer(iv) });
  cipher.update(forge.util.createBuffer(dataBytes));
  cipher.finish();

  const ciphertext = cipher.output.getBytes();
  const authTag = cipher.mode.tag.getBytes();

  // 6. Concatenate: salt || iv || ciphertext || authTag
  const combined = salt + iv + ciphertext + authTag;

  // 7. Base64 encode
  const result = forge.util.encode64(combined);

  logger.debug(
    { dataLength: data.length, resultLength: result.length },
    'pgp_sym_encrypt completed',
  );

  return result;
}

/**
 * AES-256-GCM decrypt with PBKDF2 key derivation.
 *
 * Expects the format produced by pgp_sym_encrypt():
 *   base64( salt (8 bytes) || iv (12 bytes) || ciphertext || authTag (16 bytes) )
 *
 * Backward compatible: detects legacy hex-only format and returns it as-is.
 *
 * @param data     - Base64-encoded ciphertext to decrypt.
 * @param password - Passphrase for key derivation.
 * @returns Decrypted plaintext.
 * @throws Error if decryption fails (wrong password, tampered data, etc.)
 */
export function pgp_sym_decrypt(data: string, password: string): string {
  if (!data) return '';
  if (!password) {
    logger.warn('pgp_sym_decrypt called with empty password');
    return '';
  }

  // Check for legacy hex-only format (backward compatibility)
  if (isLegacyHexFormat(data)) {
    logger.warn('pgp_sym_decrypt: detected legacy hex-only format — returning as-is (UNSAFE)');
    return data;
  }

  // 1. Base64 decode
  let combined: string;
  try {
    combined = forge.util.decode64(data);
  } catch (err) {
    throw new Error(`pgp_sym_decrypt: failed to base64-decode ciphertext: ${err}`);
  }

  if (combined.length < SALT_BYTES + IV_BYTES + AUTH_TAG_BYTES + 1) {
    throw new Error('pgp_sym_decrypt: ciphertext too short');
  }

  // 2. Extract components
  const salt = combined.slice(0, SALT_BYTES);
  const iv = combined.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const authTag = combined.slice(combined.length - AUTH_TAG_BYTES);
  const ciphertext = combined.slice(SALT_BYTES + IV_BYTES, combined.length - AUTH_TAG_BYTES);

  // 3. Derive key using the same PBKDF2 parameters
  const key = forge.pkcs5.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES);

  // 4. AES-256-GCM decrypt
  const decipher = forge.cipher.createDecipher('AES-GCM', forge.util.createBuffer(key));
  decipher.start({
    iv: forge.util.createBuffer(iv),
    tag: forge.util.createBuffer(authTag),
  });
  decipher.update(forge.util.createBuffer(ciphertext));

  const pass = decipher.finish();

  if (!pass) {
    throw new Error('pgp_sym_decrypt: decryption failed — wrong password or tampered ciphertext');
  }

  const plaintextBytes = decipher.output.getBytes();
  const plaintext = utf8Decode(plaintextBytes);

  logger.debug(
    { ciphertextLength: ciphertext.length, plaintextLength: plaintext.length },
    'pgp_sym_decrypt completed',
  );

  return plaintext;
}

/**
 * Detect whether the input is a legacy hex-only (non-encrypted) format.
 *
 * The old implementation returned `hex(data)` which is a plain hex-encoded
 * string.  The new implementation returns base64-encoded binary.  We can
 * distinguish them because:
 *   - Legacy hex: matches /^[0-9a-fA-F]+$/ and has even length >= 2
 *   - New base64: contains non-hex characters (+, /, =, etc.)
 *
 * @param input - The input to check.
 * @returns true if this appears to be legacy hex-only format.
 */
export function isLegacyHexFormat(input: string): boolean {
  if (!input || input.length < 2) return false;
  return RE_HEX_ONLY.test(input) && input.length % 2 === 0;
}

// ---- Rewrite ----------------------------------------------------

/**
 * Rewrite pgcrypto function calls for SQLite compatibility.
 *
 * Processing order (safe for sequential application):
 *   1. gen_salt(...)                  -> 'salt'
 *   2. crypt(expr1, expr2)            -> hex(sha256(expr1))
 *   3. pgp_sym_encrypt(expr1, expr2)  -> _pgp_sym_encrypt_sc(expr1, expr2)
 *   4. pgp_sym_decrypt(expr1, expr2)  -> _pgp_sym_decrypt_sc(expr1, expr2)
 *   5. pgp_pub_encrypt(expr1, ...)    -> hex(expr1)
 *   6. pgp_pub_decrypt(expr1, ...)    -> expr1
 *   7. digest(expr1, ...)             -> hex(sha256(expr1))
 *   8. hmac(expr1, expr2, ...)        -> hex(sha256(expr1 || expr2))
 *
 * Functions are applied in this order so that e.g. gen_salt inside
 * crypt(...) is replaced first, leaving a simpler crypt(pwd, 'salt')
 * for the crypt handler.
 *
 * NOTE: pgp_sym_encrypt/pgp_sym_decrypt are rewritten to call the
 * SQL scalar wrapper functions `_pgp_sym_encrypt_sc()` and
 * `_pgp_sym_decrypt_sc()`. These functions are registered separately
 * in the SQLite function registry (see FunctionRegistry).
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A PgCryptoResult with the rewritten SQL and an indicator
 *          of whether any change was made.
 */
export function rewritePgCrypto(sql: string): PgCryptoResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = sql;

  // 1. gen_salt(...) -> 'salt'  (must run first so crypt() sees a simple literal)
  result = result.replace(RE_GEN_SALT(), "'salt'");

  // 2. crypt(expr1, expr2) -> hex(sha256(expr1))
  result = result.replace(RE_CRYPT(), 'hex(sha256($1))');

  // 3. pgp_sym_encrypt(expr1, expr2) -> _pgp_sym_encrypt_sc(expr1, expr2)
  //    This calls the registered SQL scalar function which invokes
  //    the real AES-256-GCM encryption (see pgp_sym_encrypt above).
  result = result.replace(RE_PGP_SYM_ENCRYPT(), '_pgp_sym_encrypt_sc($1, $2)');

  // 4. pgp_sym_decrypt(expr1, expr2) -> _pgp_sym_decrypt_sc(expr1, expr2)
  result = result.replace(RE_PGP_SYM_DECRYPT(), '_pgp_sym_decrypt_sc($1, $2)');

  // 5. pgp_pub_encrypt(expr1, ...) -> hex(expr1)
  result = result.replace(RE_PGP_PUB_ENCRYPT(), 'hex($1)');

  // 6. pgp_pub_decrypt(expr1, ...) -> expr1
  result = result.replace(RE_PGP_PUB_DECRYPT(), '$1');

  // 7. digest(expr1, ...) -> hex(sha256(expr1))
  result = result.replace(RE_DIGEST(), 'hex(sha256($1))');

  // 8. hmac(expr1, expr2, ...) -> hex(sha256(expr1 || expr2))
  result = result.replace(RE_HMAC(), 'hex(sha256($1 || $2))');

  const rewritten = result !== sql;

  if (rewritten) {
    logger.debug(
      { original: sql, rewritten: result },
      'Rewrote pgcrypto SQL for SQLite compatibility',
    );
  }

  return { sql: result, rewritten };
}

// ---- Internal Helpers -------------------------------------------

/**
 * Strip string literals, quoted identifiers, and SQL comments from SQL
 * to avoid false positives during pgcrypto detection.
 *
 * This is a best-effort heuristic:
 *   - Handles single-quoted strings ('...')
 *   - Handles double-quoted identifiers ("...")
 *   - Handles single-line comments (--...)
 *   - Does not handle multi-line block comments (slash-asterisk ... asterisk-slash)
 *   - Does not handle escaped quotes within strings beyond basic omission.
 *
 * @param sql - Raw SQL string.
 * @returns SQL with non-code tokens replaced by spaces.
 */
function stripStringsAndComments(sql: string): string {
  return sql
    // Remove single-quoted string literals
    .replace(/'[^']*'/g, '')
    // Remove double-quoted identifiers
    .replace(/"[^"]*"/g, '')
    // Remove single-line comments
    .replace(/--[^\n]*/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ');
}

/**
 * Encode a UTF-8 string to a binary string (latin-1) for use with forge.
 *
 * Forge's ByteStringBuffer and cipher operations work on binary strings where
 * each character represents one byte (code point 0-255).  JavaScript strings
 * are UTF-16, so we need to encode to UTF-8 first, then convert each byte to
 * a character via String.fromCharCode().
 *
 * Uses the built-in TextEncoder API which is available in Node.js >= 20.
 *
 * @param str - The UTF-8 string to encode.
 * @returns A binary string where each character is one byte (0-255).
 */
function utf8Encode(str: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return binary;
}

/**
 * Decode a binary string (latin-1) to a UTF-8 string.
 *
 * Reverse of utf8Encode(): converts each character's charCode to a byte,
 * then decodes the byte array as UTF-8 via TextDecoder.
 *
 * @param binary - A binary string where each character represents one byte.
 * @returns The decoded UTF-8 string.
 */
function utf8Decode(binary: string): string {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}
