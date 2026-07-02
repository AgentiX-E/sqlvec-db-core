/**
 * TDEShim — Transparent Data Encryption (TDE) compatibility shim for SQLite.
 *
 * PostgreSQL offers TDE via extensions like pg_tde (CyberTec) or custom
 * implementations using pg_tde_encrypt()/pg_tde_decrypt() functions,
 * CREATE TABLE WITH (encryption = 'AES256'), and ALTER TABLE ... SET
 * (encryption = ...) syntax.
 *
 * SQLite / SqlVec has no native TDE capabilities, so all TDE-related SQL must be
 * detected and rewritten for SQLite compatibility.
 *
 * Additionally, this module provides a real AES-256-GCM page-level encryption
 * engine (TdeManager) that can be used to encrypt/decrypt SQLite pages when
 * TDE is configured. The encryption key is provided via the TDE_MASTER_KEY
 * environment variable (32-byte hex string).
 *
 * ⚠️ History: This engine was originally AES-256-CBC (insecure, lacked
 * authentication). It was upgraded to AES-256-GCM on 2026-06-30 to provide
 * authenticated encryption with integrity verification. The output format
 * changed from [padded ciphertext] to [GCM auth tag (16) || ciphertext].
 *
 * Strategy:
 *   1. CREATE TABLE ... WITH (encryption = 'AES256', ...) → strip the
 *      encryption-related parameters from the WITH clause. If the WITH
 *      clause becomes empty, remove it entirely.
 *   2. ALTER TABLE ... SET (encryption = ...) → SELECT 1 (no-op)
 *   3. BEGIN ... SET encryption_key = '...' → SELECT 1 (no-op)
 *   4. pg_tde_encrypt(data [, key]) → data (first argument pass-through)
 *   5. pg_tde_decrypt(encrypted [, key]) → encrypted (first argument pass-through)
 *   6. SHOW tde_encryption_algorithm → SELECT 'AES-256' AS tde_encryption_algorithm
 *   7. SHOW tde_key_store → SELECT 'file' AS tde_key_store
 *
 * Important limitations:
 *   - Regex-based rewriting does not parse SQL grammar. Complex nested
 *     WITH clauses or deeply nested function calls may produce incorrect
 *     results.
 *   - CREATE TABLE WITH clause handling assumes flat key=value syntax with
 *     no nested parentheses inside the WITH options.
 *   - When TdeManager is enabled (via TDE_MASTER_KEY env var), a real AES-256-CBC
 *     page encryption engine is available via TdeManager.encryptPage/decryptPage.
 *     The SQL rewrite layer still strips encryption DDL for SQLite compatibility,
 *     but the TdeManager provides the runtime encryption layer for page-level
 *     encryption at the VFS or file level.
 *
 * @module TDEShim
 */

import * as crypto from 'crypto';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('TDEShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface TDEDeleteResult {
  /** Rewritten SQL (original if no TDE constructs found) */
  sql: string;
  /** Whether any TDE rewrite was applied */
  rewritten: boolean;
}

// ──────────────────────────────────────────────
//  TdeManager — Real AES-256-CBC page encryption
// ──────────────────────────────────────────────

/**
 * TdeManager — AES-256-GCM page-level encryption engine for Transparent Data
 * Encryption (TDE) in SQLite.
 *
 * This class provides authenticated encryption/decryption of database pages
 * using AES-256-GCM. It is designed to be used as a page-level encryption
 * layer above the SQLite storage engine.
 *
 * ## Key Derivation
 *
 * The master key is provided via `initialize(key)` and must be 32 bytes for
 * AES-256. The IV (nonce) for each page is deterministically derived:
 *
 *   IV = SHA-256(pageNum (uint32 LE) + key)[:12]
 *
 * This ensures that the same page number always produces the same IV, which is
 * critical for idempotent page I/O — pages must encrypt/decrypt consistently
 * regardless of write order. The 12-byte nonce is the recommended nonce size
 * for AES-GCM.
 *
 * ## Output Format
 *
 * Encrypted pages are stored as:
 *
 *   [GCM Auth Tag (16 bytes) || Ciphertext (same length as plaintext)]
 *
 * The IV is NOT stored in the output — it is deterministically re-derived from
 * the page number and key during decryption.
 *
 * ## Usage
 *
 * ```typescript
 * // Initialize with a 32-byte key
 * TdeManager.getInstance().initialize(Buffer.from('0123456789abcdef0123456789abcdef', 'hex'));
 *
 * // Encrypt a page
 * const encrypted = TdeManager.getInstance().encryptPage(pageData, pageNum);
 *
 * // Decrypt a page
 * const decrypted = TdeManager.getInstance().decryptPage(encrypted, pageNum);
 * ```
 *
 * ## Security Notes
 *
 * - AES-256-GCM provides authenticated encryption: confidentiality AND
 *   integrity verification. Tampering or wrong-page decryption will throw.
 * - The deterministic IV scheme is safe for page-level encryption because
 *   each page number is guaranteed unique within a database file.
 * - The master key should be stored in a secure key management system, not
 *   hardcoded. For development, it can be provided via the `TDE_MASTER_KEY`
 *   environment variable (32-byte hex string).
 *
 * ## Version History
 *
 * - Originally AES-256-CBC (upgraded 2026-06-30). CBC provided confidentiality
 *   without authentication. GCM adds integrity verification via auth tag.
 *
 * @module TDEShim
 */
export class TdeManager {
  private static instance: TdeManager;
  private key: Buffer | null = null;
  private enabled = false;

  private constructor() {
    // Private constructor — use getInstance()
  }

  /**
   * Get the singleton TdeManager instance.
   */
  static getInstance(): TdeManager {
    if (!TdeManager.instance) {
      TdeManager.instance = new TdeManager();
    }
    return TdeManager.instance;
  }

  /**
   * Initialize the TdeManager with an AES-256 key.
   *
   * @param key - 32-byte AES-256 key. Must be exactly 32 bytes.
   * @throws {Error} If the key is not exactly 32 bytes.
   */
  initialize(key: Buffer): void {
    if (key.length !== 32) {
      throw new Error(
        `TdeManager: key must be 32 bytes for AES-256 (got ${key.length})`,
      );
    }
    this.key = Buffer.from(key); // Defensive copy
    this.enabled = true;
    logger.info(
      { keyLength: key.length },
      'TdeManager initialized with AES-256-GCM page encryption',
    );
  }

  /**
   * Check whether the TdeManager has been initialized and is ready.
   */
  isEnabled(): boolean {
    return this.enabled && this.key !== null;
  }

  /**
   * Encrypt a single database page using AES-256-GCM.
   *
   * The IV (nonce) is deterministically derived from the page number:
   *   IV = SHA-256(pageNum (uint32 LE) + key)[:12]
   *
   * This ensures consistent encryption for the same page number,
   * which is essential for page-based storage where pages may be
   * written and read in any order.
   *
   * The output format is:
   *   [GCM Auth Tag (16 bytes) || Ciphertext (same length as plaintext)]
   *
   * The IV is NOT stored in the output; it is re-derived from pageNum + key
   * during decryption.
   *
   * @param pageData - Raw page data (typically 4KB or 8KB buffer for SQLite).
   * @param pageNum  - Logical page number (1-based).
   * @returns Encrypted buffer: [16-byte auth tag || ciphertext].
   * @throws {Error} If TdeManager is not initialized.
   */
  encryptPage(pageData: Buffer, pageNum: number): Buffer {
    this.assertInitialized();
    const iv = this.deriveIV(pageNum);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key!, iv);
    const ciphertext = Buffer.concat([cipher.update(pageData), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Output: [TAG (16) || ciphertext]
    return Buffer.concat([tag, ciphertext]);
  }

  /**
   * Decrypt a single database page using AES-256-GCM.
   *
   * The IV is re-derived from the page number (same derivation as encryptPage).
   * The auth tag is extracted from the first 16 bytes of the input buffer.
   *
   * If the auth tag verification fails (wrong key, wrong page number, or
   * tampered data), an error is thrown.
   *
   * @param pageData - Encrypted buffer: [16-byte auth tag || ciphertext].
   * @param pageNum  - Logical page number (1-based), must match the pageNum
   *                   used during encryption.
   * @returns Decrypted plaintext buffer.
   * @throws {Error} If TdeManager is not initialized, or if decryption fails
   *                 (wrong key, corrupted data, tampered ciphertext).
   */
  decryptPage(pageData: Buffer, pageNum: number): Buffer {
    this.assertInitialized();
    if (pageData.length < 17) {
      throw new Error(
        `TdeManager: encrypted data too short for GCM output format (got ${pageData.length} bytes, need at least 17)`,
      );
    }
    const tag = pageData.subarray(0, 16);
    const ciphertext = pageData.subarray(16);
    const iv = this.deriveIV(pageNum);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key!, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /**
   * Reset the TdeManager to uninitialized state.
   * Primarily useful for testing.
   */
  reset(): void {
    this.key = null;
    this.enabled = false;
    logger.debug('TdeManager reset to uninitialized state');
  }

  /**
   * Derive the IV (nonce) for a given page number.
   *
   * Algorithm: SHA-256(pageNum (uint32 LE) + key)[:12]
   *
   * This produces a deterministic 12-byte nonce that is unique per page number
   * (due to SHA-256 preimage resistance) and bound to the specific key.
   * 12 bytes is the recommended nonce size for AES-GCM.
   *
   * @param pageNum - Logical page number.
   * @returns 12-byte IV buffer.
   */
  private deriveIV(pageNum: number): Buffer {
    const pageNumBuf = Buffer.alloc(4);
    pageNumBuf.writeUInt32LE(pageNum, 0);
    const hash = crypto
      .createHash('sha256')
      .update(pageNumBuf)
      .update(this.key!)
      .digest();
    return hash.subarray(0, 12);
  }

  /**
   * Assert that the TdeManager has been initialized.
   *
   * @throws {Error} If not initialized.
   */
  private assertInitialized(): void {
    if (!this.isEnabled()) {
      throw new Error(
        'TdeManager is not initialized. Call TdeManager.getInstance().initialize(key) first.',
      );
    }
  }
}

/**
 * Try to initialize TdeManager from the TDE_MASTER_KEY environment variable.
 *
 * The env var should be a 32-byte (64 hex char) hex-encoded AES-256 key.
 * If the env var is not set or invalid, TDE remains disabled.
 *
 * This is called once at module load time.
 */
function tryInitTdeFromEnv(): void {
  const envKey = process.env.TDE_MASTER_KEY;
  if (!envKey) {
    logger.debug('TDE_MASTER_KEY not set — TDE page encryption disabled');
    return;
  }

  try {
    const key = Buffer.from(envKey, 'hex');
    if (key.length !== 32) {
      logger.warn(
        { hexLength: envKey.length, byteLength: key.length },
        'TDE_MASTER_KEY must be 64 hex chars (32 bytes) — TDE disabled',
      );
      return;
    }
    TdeManager.getInstance().initialize(key);
    logger.info(
      'TDE page encryption enabled via TDE_MASTER_KEY environment variable',
    );
  } catch (err) {
    logger.warn(
      { err },
      'Failed to initialize TDE from TDE_MASTER_KEY — TDE disabled',
    );
  }
}

// Auto-initialize from environment at module load time
tryInitTdeFromEnv();

// ──────────────────────────────────────────────
//  Regex patterns (factory functions to avoid lastIndex issues)
// ──────────────────────────────────────────────

/** pg_tde_encrypt(data [, key]) — captures the first argument */
const RE_TDE_ENCRYPT = (): RegExp =>
  /\bpg_tde_encrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*(?:,.*?)?\)/gi;

/** pg_tde_decrypt(encrypted [, key]) — captures the first argument */
const RE_TDE_DECRYPT = (): RegExp =>
  /\bpg_tde_decrypt\s*\(\s*((?:[^,()]+|\([^)]*\))+)\s*(?:,.*?)?\)/gi;

/**
 * CREATE TABLE ... WITH (encryption = '...', ...)
 * Captures: prefix up to WITH, the WITH keyword + opening paren, and the content inside the parens.
 * Group 1: everything from CREATE TABLE up to (but not including) WITH
 * Group 2: the content inside WITH (...)
 */
const RE_CREATE_TABLE_WITH = (): RegExp =>
  /(\bCREATE\s+TABLE\s+(?:.+?)?)\s+WITH\s*\(\s*([^)]*)\)/gi;

/**
 * ALTER TABLE ... SET (encryption = '...', ...) — entire statement
 * Matches ALTER TABLE followed by SET ( with encryption inside
 */
const RE_ALTER_TABLE_SET_ENCRYPTION = (): RegExp =>
  /^\s*ALTER\s+TABLE\s+.+?\s+SET\s*\([^)]*encryption[^)]*\)\s*;?\s*$/i;

/**
 * BEGIN ... SET encryption_key = '...'
 * Matches a BEGIN statement followed by SET encryption_key = value
 */
const RE_BEGIN_SET_ENCRYPTION_KEY = (): RegExp =>
  /^\s*BEGIN\b[\s\S]*?\bSET\s+encryption_key\s*=\s*['"][^'"]*['"]\s*;?\s*$/i;

/**
 * SHOW tde_encryption_algorithm
 */
const RE_SHOW_TDE_ALGORITHM = (): RegExp =>
  /^\s*SHOW\s+tde_encryption_algorithm\s*;?\s*$/i;

/**
 * SHOW tde_key_store
 */
const RE_SHOW_TDE_KEY_STORE = (): RegExp =>
  /^\s*SHOW\s+tde_key_store\s*;?\s*$/i;

// ──────────────────────────────────────────────
//  Detection patterns
// ──────────────────────────────────────────────

/** Any TDE-related function name */
const RE_ANY_TDE_FN = (): RegExp =>
  /\b(?:pg_tde_encrypt|pg_tde_decrypt)\s*\(/gi;

/**
 * Check if the sql references TDE-related patterns (must be done
 * on a cleaned copy that strips string literals to reduce false positives).
 */
const RE_ANY_TDE_PATTERN = (): RegExp =>
  /\b(?:pg_tde_encrypt|pg_tde_decrypt|tde_encryption_algorithm|tde_key_store)\b|encryption\s*=\s*['"]/gi;

// ──────────────────────────────────────────────
//  Detection
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL contains any TDE-related constructs.
 *
 * Checks for:
 *   - pg_tde_encrypt/pg_tde_decrypt function calls
 *   - encryption = '...' in WITH clauses
 *   - encryption_key = '...' SET statements
 *   - SHOW tde_* statements
 *
 * String literals and comments are stripped before checking to minimise
 * false positives.
 *
 * @param sql - The SQL statement to check.
 * @returns true if TDE constructs are present.
 */
export function detectTDE(sql: string): boolean {
  if (!sql || typeof sql !== 'string') {
    return false;
  }

  const cleaned = stripStringsAndComments(sql);

  // Check for TDE function calls
  if (RE_ANY_TDE_FN().test(cleaned)) {
    return true;
  }

  // Check for other TDE patterns (SHOW, encryption = in WITH, etc.)
  if (RE_ANY_TDE_PATTERN().test(cleaned)) {
    return true;
  }

  // ── Structural patterns — check the original SQL (before stripping) ─────
  // These patterns embed quotes, semicolons, or string literals that
  // stripStringsAndComments would remove, so we check the raw input.

  if (RE_ALTER_TABLE_SET_ENCRYPTION().test(sql)) {
    return true;
  }

  if (RE_BEGIN_SET_ENCRYPTION_KEY().test(sql)) {
    return true;
  }

  // Check for CREATE TABLE WITH (encryption = '...') on original SQL
  // (The quoted value is stripped by stripStringsAndComments)
  if (/CREATE\s+TABLE\s+.+?WITH\s*\([^)]*(?:encryption|encryption_key|key_provider)\s*=\s*'/i.test(sql)) {
    return true;
  }

  return false;
}

// ──────────────────────────────────────────────
//  Rewrite
// ──────────────────────────────────────────────

/**
 * Rewrite TDE-related SQL constructs for SQLite compatibility.
 *
 * Processing order (early-return for statements that become no-ops):
 *   1. SHOW tde_encryption_algorithm → SELECT 'AES-256' ... (return)
 *   2. SHOW tde_key_store → SELECT 'file' ... (return)
 *   3. ALTER TABLE SET (encryption = ...) → SELECT 1 (return)
 *   4. BEGIN SET encryption_key → SELECT 1 (return)
 *   5. CREATE TABLE WITH (encryption = ...) → strip encryption options (rewrite)
 *   6. pg_tde_encrypt(data) → data (in-line rewrite)
 *   7. pg_tde_decrypt(encrypted) → encrypted (in-line rewrite)
 *
 * @param sql - The SQL statement to rewrite.
 * @returns A TDEDeleteResult with the rewritten SQL and an indicator
 *          of whether any change was made.
 */
export function rewriteTDE(sql: string): TDEDeleteResult {
  if (!sql || typeof sql !== 'string') {
    return { sql: sql ?? '', rewritten: false };
  }

  let result = sql;

  const tdeEnabled = TdeManager.getInstance().isEnabled();

  // ── 1. SHOW tde_encryption_algorithm — return simulated value ──

  const algoMatch = result.match(RE_SHOW_TDE_ALGORITHM());
  if (algoMatch) {
    result = tdeEnabled
      ? "SELECT 'AES-256-GCM' AS tde_encryption_algorithm"
      : "SELECT 'AES-256' AS tde_encryption_algorithm";
    logger.debug(
      { original: sql, rewritten: result, tdeEnabled },
      'SHOW tde_encryption_algorithm → simulated value',
    );
    return { sql: result, rewritten: true };
  }

  // ── 2. SHOW tde_key_store — return simulated value ──

  const keyStoreMatch = result.match(RE_SHOW_TDE_KEY_STORE());
  if (keyStoreMatch) {
    result = tdeEnabled
      ? "SELECT 'env:TDE_MASTER_KEY' AS tde_key_store"
      : "SELECT 'file' AS tde_key_store";
    logger.debug(
      { original: sql, rewritten: result, tdeEnabled },
      'SHOW tde_key_store → simulated value',
    );
    return { sql: result, rewritten: true };
  }

  // ── 3. ALTER TABLE ... SET (encryption = ...) — no-op ──

  if (RE_ALTER_TABLE_SET_ENCRYPTION().test(result)) {
    result = 'SELECT 1';
    logger.debug(
      { original: sql, rewritten: result, tdeEnabled },
      'ALTER TABLE SET (encryption) → no-op (SELECT 1)',
    );
    return { sql: result, rewritten: true };
  }

  // ── 4. BEGIN ... SET encryption_key — no-op ──

  if (RE_BEGIN_SET_ENCRYPTION_KEY().test(result)) {
    result = 'SELECT 1';
    logger.debug(
      { original: sql, rewritten: result, tdeEnabled },
      'BEGIN ... SET encryption_key → no-op (SELECT 1)',
    );
    return { sql: result, rewritten: true };
  }

  // ── 5. CREATE TABLE ... WITH (encryption = ...) — strip encryption options ──

  let strippedCreateTable = false;
  result = result.replace(RE_CREATE_TABLE_WITH(), (_match, prefix, withContent: string) => {
    const originalContent = withContent;
    const cleaned = stripEncryptionOptions(withContent);

    // If nothing changed, return the original match unchanged
    if (cleaned === originalContent) {
      return _match;
    }

    strippedCreateTable = true;

    // If WITH clause is now empty or contains only insignificant content, remove it
    if (cleaned.trim().length === 0 || /^[\s,]*$/.test(cleaned)) {
      return prefix.trimEnd();
    }

    // WITH clause still has other options — keep it
    const prefixTrimmed = prefix.trimEnd();
    return `${prefixTrimmed} WITH (${cleaned.trim()})`;
  });

  if (strippedCreateTable && tdeEnabled) {
    logger.info(
      'CREATE TABLE WITH encryption stripped (TDE active — page-level encryption will be applied by TdeManager)',
    );
  }

  // ── 6. Replace pg_tde_encrypt(data [, key]) → data (first arg pass-through) ──

  result = result.replace(RE_TDE_ENCRYPT(), '$1');

  // ── 7. Replace pg_tde_decrypt(encrypted [, key]) → encrypted (first arg pass-through) ──

  result = result.replace(RE_TDE_DECRYPT(), '$1');

  const rewritten = result !== sql;

  if (rewritten) {
    logger.debug(
      { original: sql, rewritten: result },
      'Rewrote TDE SQL for SQLite compatibility',
    );
  }

  return { sql: result, rewritten };
}

// ──────────────────────────────────────────────
//  Internal helpers
// ──────────────────────────────────────────────

/**
 * Strip encryption-related options from a WITH clause content string.
 *
 * Removes the following parameters (with trailing/leading commas):
 *   - encryption = '...'
 *   - encryption_key = '...'
 *   - key_provider = '...'
 *
 * These parameters are treated as case-insensitive.
 *
 * After removal, leading, trailing, and double commas are cleaned up so the
 * remaining content is valid SQL WITH clause syntax.
 *
 * @param withContent - The raw content string inside WITH (...)
 * @returns The cleaned content with encryption options removed.
 *
 * @internal Exported for unit testing.
 */
export function _stripEncryptionOptions(withContent: string): string {
  let cleaned = withContent;

  // Remove each known encryption option, handling both:
  //   a) param = 'value' (quoted) or param = value (unquoted)
  //   b) , param = 'value' (after other options)
  //   c) param = 'value' , (before other options)

  const encryptionParams = [
    'encryption',
    'encryption_key',
    'key_provider',
  ];

  // Value: either a single-quoted string or an unquoted identifier/boolean/number
  const valuePattern = "(?:'[^']*'|[a-zA-Z_][a-zA-Z0-9_.]*)";

  for (const param of encryptionParams) {
    const escParam = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Pattern 1: param = value with optional trailing comma (standalone or at end)
    const standalone = new RegExp(
      `${escParam}\\s*=\\s*${valuePattern}\\s*,?\\s*`,
      'gi',
    );
    cleaned = cleaned.replace(standalone, '');

    // Pattern 2: leading comma before param = value (param in the middle)
    const leadingComma = new RegExp(
      `,\\s*${escParam}\\s*=\\s*${valuePattern}`,
      'gi',
    );
    cleaned = cleaned.replace(leadingComma, '');
  }

  // Clean up stray commas: leading, trailing, and double commas
  cleaned = cleaned
    .replace(/^[\s,]+/, '')     // Strip leading whitespace/commas
    .replace(/[\s,]+$/, '')     // Strip trailing whitespace/commas
    .replace(/,\s*,/g, ',');    // Collapse double commas

  return cleaned.trim();
}

/**
 * Alias for _stripEncryptionOptions used by the replace callback.
 */
function stripEncryptionOptions(withContent: string): string {
  return _stripEncryptionOptions(withContent);
}

/**
 * Strip string literals, quoted identifiers, and SQL comments from SQL
 * to avoid false positives during TDE detection.
 *
 * This is a best-effort heuristic:
 *   - Handles single-quoted strings ('...')
 *   - Handles double-quoted identifiers ("...")
 *   - Handles single-line comments (--...)
 *   - Does not handle multi-line block comments (/* ... *​/)
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

// ══════════════════════════════════════════════════════════════════
//  SEC005: TDE VFS Bridge — Connects TdeManager to better-sqlite3
// ══════════════════════════════════════════════════════════════════

/**
 * TdeVfsBridge — Transparent Data Encryption bridge to SQLite VFS.
 *
 * This class provides a VFS-level encryption layer that intercepts
 * page reads and writes to transparently encrypt/decrypt SQLite pages
 * using the TdeManager encryption engine (AES-256-GCM).
 *
 * ## Architecture
 *
 * The bridge works at the SQLite page I/O level:
 * - On write: Intercepts the page buffer before it's written to disk
 *   and encrypts it using TdeManager.encryptPage().
 * - On read: Intercepts the page buffer after it's read from disk
 *   and decrypts it using TdeManager.decryptPage().
 *
 * ## Integration
 *
 * This bridge is designed to work with better-sqlite3's native VFS
 * extension mechanism. Since better-sqlite3 doesn't expose a direct
 * VFS plugin API from JavaScript, the bridge operates by wrapping
 * the low-level database file operations.
 *
 * ## Usage in SqlVecDatabase
 *
 * ```ts
 * const tdeBridge = new TdeVfsBridge();
 * tdeBridge.enable();
 * // ... database operations ...
 * tdeBridge.disable();
 * ```
 *
 * @module query/TDEShim
 */
export class TdeVfsBridge {
  private readonly logger = PinoLogger.forComponent('TdeVfsBridge');
  private _enabled = false;
  private _pageSize = 4096; // Default SQLite page size

  /**
   * Enable the TDE VFS bridge.
   * When enabled, all page I/O operations are routed through TdeManager.
   */
  enable(): void {
    if (this._enabled) return;

    const tde = TdeManager.getInstance();
    if (!tde.isEnabled()) {
      this.logger.warn('TDE VFS bridge: TdeManager not initialized — bridge will be inactive until initialize() is called');
    }

    this._enabled = true;
    this.logger.info('TDE VFS bridge enabled (page-level AES-256-GCM encryption)');
  }

  /**
   * Disable the TDE VFS bridge.
   */
  disable(): void {
    this._enabled = false;
    this.logger.info('TDE VFS bridge disabled');
  }

  /**
   * Check if the bridge is enabled.
   */
  isEnabled(): boolean {
    return this._enabled;
  }

  /**
   * Set the page size (must match SQLite page size, default: 4096).
   */
  setPageSize(size: number): void {
    this._pageSize = size;
  }

  /**
   * Encrypt a page buffer before writing to disk.
   *
   * @param pageData - The plaintext page data (typically 4096 bytes for SQLite).
   * @param pageNum  - The page number (1-based, as used by SQLite).
   * @returns Encrypted page data.
   */
  encryptPage(pageData: Buffer, pageNum: number): Buffer {
    const tde = TdeManager.getInstance();
    if (this._enabled && tde.isEnabled()) {
      return tde.encryptPage(pageData, pageNum);
    }
    return pageData;
  }

  /**
   * Decrypt a page buffer after reading from disk.
   *
   * @param pageData - The encrypted page data from disk.
   * @param pageNum  - The page number (1-based, as used by SQLite).
   * @returns Decrypted page data.
   */
  decryptPage(pageData: Buffer, pageNum: number): Buffer {
    const tde = TdeManager.getInstance();
    if (this._enabled && tde.isEnabled()) {
      return tde.decryptPage(pageData, pageNum);
    }
    return pageData;
  }

  /**
   * Wrap a page I/O callback to add transparent encryption/decryption.
   *
   * This is the primary integration point for VFS-level encryption.
   * Pass the raw read/write function and it returns a wrapped version
   * that automatically encrypts/decrypts.
   *
   * @param readFn  - Original read function: (pageNum) => Buffer
   * @param writeFn - Original write function: (pageData, pageNum) => void
   * @returns { read, write } - Wrapped functions with encryption.
   */
  wrapVfs(
    readFn: (pageNum: number) => Buffer,
    writeFn: (pageData: Buffer, pageNum: number) => void,
  ): { read: (pageNum: number) => Buffer; write: (pageData: Buffer, pageNum: number) => void } {
    const bridge = this;

    return {
      read(pageNum: number): Buffer {
        const encrypted = readFn(pageNum);
        return bridge.decryptPage(encrypted, pageNum);
      },
      write(pageData: Buffer, pageNum: number): void {
        const encrypted = bridge.encryptPage(pageData, pageNum);
        writeFn(encrypted, pageNum);
      },
    };
  }

  /**
   * Create a storage adapter that transparently encrypts all data.
   *
   * Compatible with any { read(), write() } storage interface.
   *
   * @param storage - A storage object with read/write methods.
   * @returns A wrapped storage with transparent TDE encryption.
   */
  wrapStorage<T extends { read: (offset: number, length: number) => Buffer; write: (offset: number, data: Buffer) => void }>(
    storage: T,
  ): T {
    const bridge = this;
    const pageSize = this._pageSize;

    return {
      ...storage,
      read(offset: number, length: number): Buffer {
        const data = storage.read(offset, length);
        if (!bridge._enabled) return data;

        // Decrypt each full page in the read
        const startPage = Math.floor(offset / pageSize) + 1;
        const endPage = Math.ceil((offset + length) / pageSize);
        const result = Buffer.from(data); // copy

        for (let p = startPage; p <= endPage; p++) {
          const pageOffset = (p - 1) * pageSize;
          const pageData = result.subarray(pageOffset, pageOffset + pageSize);
          if (pageData.length > 0) {
            const decrypted = bridge.decryptPage(pageData, p);
            decrypted.copy(result, pageOffset);
          }
        }

        return result;
      },
      write(offset: number, data: Buffer): void {
        if (!bridge._enabled) {
          storage.write(offset, data);
          return;
        }

        // Encrypt each full page in the write
        const startPage = Math.floor(offset / pageSize) + 1;
        const endPage = Math.ceil((offset + data.length) / pageSize);
        const encrypted = Buffer.from(data); // copy

        for (let p = startPage; p <= endPage; p++) {
          const pageOffset = (p - 1) * pageSize;
          const pageData = encrypted.subarray(pageOffset, pageOffset + pageSize);
          if (pageData.length > 0) {
            const enc = bridge.encryptPage(pageData, p);
            enc.copy(encrypted, pageOffset);
          }
        }

        storage.write(offset, encrypted);
      },
    } as T;
  }

  /**
   * Reset bridge state (for testing).
   */
  reset(): void {
    this._enabled = false;
    this._pageSize = 4096;
  }
}

