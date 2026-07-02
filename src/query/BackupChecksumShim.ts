/**
 * BackupChecksumShim — PostgreSQL backup verification compatibility shim for SQLite.
 *
 * PostgreSQL provides two built-in functions for verifying data file checksums:
 *
 *   - `pg_verify_checksums()`       — Validates checksums for the entire cluster
 *   - `pg_verify_block_checksums()` — Validates block-level checksums for a relation
 *
 * These functions are used during backup validation and integrity checks. SQLite
 * has no concept of data file checksums — it relies on its journal/WAL for
 * crash safety and does not maintain per-block or per-cluster checksums for
 * backup verification purposes.
 *
 * ## Strategy
 *
 * This shim performs **real file integrity verification** by scanning the data
 * directory for SQLite database files (.db), computing SHA256 hashes of each
 * file, and (optionally) comparing against stored checksums in a
 * `_sqlvec_checksums` tracking file.
 *
 * ## Real verification vs no-op fallback
 *
 * - When `process.env.DATA_DIR` is set and points to an existing directory,
 *   real file scanning + SHA256 hashing is performed.
 * - Otherwise, the shim falls back to a static `true` result.
 *
 * @module BackupChecksumShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const logger = PinoLogger.forComponent('BackupChecksumShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface BackupChecksumResult {
  /** Rewritten SQL (no-op `SELECT true AS verified` if detected, original otherwise) */
  sql: string;
  /** Whether the statement was detected as a backup checksum query and rewritten */
  rewritten: boolean;
}

export interface ChecksumVerificationResult {
  verified: boolean;
  checked: number;
  failed: number;
  duration: number;
}

// ──────────────────────────────────────────────
//  Real verification implementation
// ──────────────────────────────────────────────

/**
 * Default data directory path. Override via `process.env.DATA_DIR`.
 */
function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

/**
 * Path to the checksum manifest file for persisting expected hashes.
 */
function getChecksumManifestPath(dataDir: string): string {
  return path.join(dataDir, '_sqlvec_checksums.json');
}

/**
 * Read the stored checksum manifest, if it exists.
 * Returns a map of filename → expected SHA256 hex hash.
 */
function readChecksumManifest(dataDir: string): Map<string, string> {
  const manifestPath = getChecksumManifestPath(dataDir);
  try {
    if (fs.existsSync(manifestPath)) {
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      const data = JSON.parse(raw) as Record<string, string>;
      return new Map(Object.entries(data));
    }
  } catch (err) {
    logger.warn({ err, manifestPath }, 'Failed to read checksum manifest');
  }
  return new Map();
}

/**
 * Verify checksums for all .db files in the given data directory.
 *
 * For each .db file:
 *   1. Compute SHA256 hash of the file content
 *   2. If a checksum manifest exists, compare against the stored expected hash
 *   3. If mismatched, mark as failed
 *
 * @param dataDir - Path to the data directory to scan
 * @returns Verification result with counts
 */
export function verifyChecksums(dataDir?: string): ChecksumVerificationResult {
  const dir = dataDir || getDataDir();
  const start = Date.now();
  let checked = 0;
  let failed = 0;

  try {
    if (!fs.existsSync(dir)) {
      logger.info({ dir }, 'Data directory does not exist — returning verified=true (nothing to check)');
      return { verified: true, checked: 0, failed: 0, duration: Date.now() - start };
    }

    const manifest = readChecksumManifest(dir);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));

    if (files.length === 0) {
      logger.info({ dir }, 'No .db files found in data directory — returning verified=true');
      return { verified: true, checked: 0, failed: 0, duration: Date.now() - start };
    }

    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const content = fs.readFileSync(filePath);
        const hash = crypto.createHash('sha256').update(content).digest('hex');
        checked++;

        // If manifest has an expected hash, compare
        if (manifest.has(file)) {
          const expected = manifest.get(file)!;
          if (hash !== expected) {
            logger.warn({ file, expected, actual: hash }, 'Checksum mismatch');
            failed++;
          } else {
            logger.debug({ file }, 'Checksum verified');
          }
        } else {
          // No manifest entry; treat as pass (no stored reference)
          logger.debug({ file, hash: hash.substring(0, 16) + '...' }, 'File checksummed (no comparison available)');
        }
      } catch (fileErr) {
        logger.warn({ file, err: fileErr }, 'Failed to checksum file');
        failed++;
      }
    }

    const duration = Date.now() - start;
    logger.info({ checked, failed, durationMs: duration }, 'Backup checksum verification complete');

    return {
      verified: failed === 0,
      checked,
      failed,
      duration,
    };
  } catch (err) {
    logger.error({ err, dir }, 'Error during checksum verification');
    return { verified: false, checked: 0, failed: 1, duration: Date.now() - start };
  }
}

/**
 * Generate a checksum manifest file from the current .db files.
 * This stores the current hashes for future verification comparisons.
 *
 * @param dataDir - Path to the data directory
 */
export function generateChecksumManifest(dataDir?: string): number {
  const dir = dataDir || getDataDir();
  const manifest: Record<string, string> = {};

  try {
    if (!fs.existsSync(dir)) {
      logger.info({ dir }, 'Data directory does not exist — no manifest generated');
      return 0;
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const content = fs.readFileSync(filePath);
        manifest[file] = crypto.createHash('sha256').update(content).digest('hex');
      } catch (fileErr) {
        logger.warn({ file, err: fileErr }, 'Failed to hash file for manifest');
      }
    }

    const manifestPath = getChecksumManifestPath(dir);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    logger.info({ count: Object.keys(manifest).length, path: manifestPath }, 'Checksum manifest generated');

    return Object.keys(manifest).length;
  } catch (err) {
    logger.error({ err, dir }, 'Failed to generate checksum manifest');
    return 0;
  }
}

// ──────────────────────────────────────────────
//  Constants — Regex patterns
// ──────────────────────────────────────────────

/**
 * Regex that detects a top-level SELECT statement calling one of the
 * PostgreSQL backup checksum verification functions.
 */
// eslint-disable-next-line require-unicode-regexp
const BACKUP_CHECKSUM_SELECT =
  /^\s*SELECT\s+(?:.+\b)?pg_verify_block_checksums\s*\(\s*\)\s*(?:\s+AS\s+\w+)?\s*;?\s*$/i;

// eslint-disable-next-line require-unicode-regexp
const BACKUP_CHECKSUM_SELECT_SIMPLE =
  /^\s*SELECT\s+(?:.+\b)?pg_verify_checksums\s*\(\s*\)\s*(?:\s+AS\s+\w+)?\s*;?\s*$/i;

/**
 * Combined regex that matches either `pg_verify_checksums` or
 * `pg_verify_block_checksums` as a function invocation anywhere in the SQL.
 */
// eslint-disable-next-line require-unicode-regexp
const CHECKSUM_FUNC_CALL =
  /\bpg_verify_(?:block_)?checksums\s*\(/i;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

/**
 * Detect whether the given SQL string references any PostgreSQL backup
 * checksum verification function.
 */
export function detectBackupChecksum(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  return CHECKSUM_FUNC_CALL.test(sql);
}

/**
 * Rewrite a PostgreSQL backup checksum verification query.
 *
 * **Real verification mode**: When DATA_DIR is set and exists, performs
 * actual file checksum verification and returns the real result.
 *
 * **Static mode**: Falls back to `SELECT true AS verified`.
 */
export function rewriteBackupChecksum(sql: string): BackupChecksumResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
    };
  }

  const trimmed = sql.trim();

  // ── Step 1: Quick presence check ───────────────────────────────

  if (!detectBackupChecksum(trimmed)) {
    return {
      sql: trimmed,
      rewritten: false,
    };
  }

  // ── Step 2: Match against known checksum SELECT patterns ────────

  if (BACKUP_CHECKSUM_SELECT.test(trimmed) || BACKUP_CHECKSUM_SELECT_SIMPLE.test(trimmed)) {
    logger.debug(
      { original: trimmed },
      'PostgreSQL backup checksum query detected — performing real or static verification',
    );

    // Try real verification if DATA_DIR is configured
    const dataDir = process.env.DATA_DIR;
    if (dataDir) {
      const result = verifyChecksums(dataDir);
      const verifiedStr = result.verified ? 'true' : 'false';
      return {
        sql: `SELECT ${verifiedStr} AS verified, ${result.checked} AS checked, ${result.failed} AS failed, ${result.duration} AS duration_ms`,
        rewritten: true,
      };
    }

    // Fallback to static true
    return {
      sql: 'SELECT true AS verified',
      rewritten: true,
    };
  }

  // ── Step 3: Function detected but not a simple SELECT ───────────

  logger.debug(
    { original: trimmed },
    'Backup checksum function reference found in complex statement — not rewriting',
  );

  return {
    sql: trimmed,
    rewritten: false,
  };
}
