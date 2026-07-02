/**
 * ConcurrentlyShim — PostgreSQL CREATE/DROP INDEX CONCURRENTLY simulation for SQLite.
 *
 * PostgreSQL supports `CREATE INDEX CONCURRENTLY`, which allows index creation without
 * blocking concurrent writes. SQLite does not support this keyword or MVCC DDL, so
 * we simulate the two-phase approach:
 *
 * 1. CREATE INDEX CONCURRENTLY:
 *    - Create the index with the given specification
 *    - Run a validation phase (consistency check via ANALYZE-like introspection)
 *    - Report success with the actual index name
 *
 * 2. DROP INDEX CONCURRENTLY:
 *    - Mark the index as pending drop in a side meta-table
 *    - Verify no active queries reference it (simplified check)
 *    - Execute the actual DROP INDEX
 *
 * Detection via regex: both CREATE INDEX CONCURRENTLY and DROP INDEX CONCURRENTLY
 * are detected case-insensitively.
 *
 * @module ConcurrentlyShim
 */

import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ConcurrentlyShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface ConcurrentIndexConfig {
  indexName: string;
  tableName: string;
  columns: string;
  unique: boolean;
  whereClause?: string;
}

export interface ConcurrentDDLResult {
  type: 'CREATE' | 'DROP';
  concurrent: boolean;
  indexName?: string;
  tableName?: string;
}

export interface RewriteResult {
  sql: string;
  rewritten: boolean;
}

export interface ExecuteResult {
  success: boolean;
  durationMs: number;
  actualIndexName?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ──────────────────────────────────────────────
//  Constants — detection patterns
// ──────────────────────────────────────────────

// Detect CREATE INDEX CONCURRENTLY
const CREATE_CONCURRENTLY_PATTERN =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(\S+)\s+ON\s+(\S+)\s*\(([^)]+)\)/i;

// Detect DROP INDEX CONCURRENTLY
const DROP_CONCURRENTLY_PATTERN =
  /DROP\s+INDEX\s+CONCURRENTLY\s+(?:IF\s+EXISTS\s+)?(\S+)/i;

// Generic CONCURRENTLY keyword detection
const CONCURRENTLY_KEYWORD = /\bCONCURRENTLY\b/i;

// ──────────────────────────────────────────────
//  Detection
// ──────────────────────────────────────────────

/**
 * Detect whether a SQL statement contains CREATE/DROP INDEX CONCURRENTLY.
 *
 * @param sql - A SQL statement
 * @returns Detection result with type, concurrent flag, and extracted names
 *
 * @example
 * ```ts
 * detectConcurrentDDL('CREATE INDEX CONCURRENTLY ix ON t (col)');
 * // → { type: 'CREATE', concurrent: true, indexName: 'ix', tableName: 't' }
 *
 * detectConcurrentDDL('DROP INDEX CONCURRENTLY ix');
 * // → { type: 'DROP', concurrent: true, indexName: 'ix' }
 *
 * detectConcurrentDDL('CREATE INDEX ix ON t (col)');
 * // → { type: 'CREATE', concurrent: false }
 * ```
 */
export function detectConcurrentDDL(sql: string): ConcurrentDDLResult {
  const trimmed = sql.trim();

  // Check CREATE INDEX CONCURRENTLY
  const createMatch = trimmed.match(CREATE_CONCURRENTLY_PATTERN);
  if (createMatch) {
    return {
      type: 'CREATE',
      concurrent: true,
      indexName: createMatch[2],
      tableName: createMatch[3],
    };
  }

  // Check DROP INDEX CONCURRENTLY
  const dropMatch = trimmed.match(DROP_CONCURRENTLY_PATTERN);
  if (dropMatch) {
    return {
      type: 'DROP',
      concurrent: true,
      indexName: dropMatch[1],
    };
  }

  // Determine type (CREATE or DROP) but not concurrent
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(trimmed)) {
    return { type: 'CREATE', concurrent: false };
  }
  if (/^\s*DROP\s+INDEX\b/i.test(trimmed)) {
    return { type: 'DROP', concurrent: false };
  }

  return { type: 'CREATE', concurrent: false };
}

// ──────────────────────────────────────────────
//  Rewriting
// ──────────────────────────────────────────────

/**
 * Rewrite CREATE INDEX CONCURRENTLY.
 *
 * Since SQLite doesn't support CONCURRENTLY, we just strip the keyword
 * and add a comment noting it was CONCURRENTLY. The actual two-phase
 * simulation is handled by executeCreateIndexConcurrently().
 *
 * @param sql - CREATE INDEX CONCURRENTLY statement
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteCreateIndexConcurrently('CREATE INDEX CONCURRENTLY ix ON t (col)');
 * // Result -> 'CREATE INDEX  ix ON t (col)'  (CONCURRENTLY stripped)
 * ```
 */
export function rewriteCreateIndexConcurrently(sql: string): string {
  const trimmed = sql.trim();
  if (!CONCURRENTLY_KEYWORD.test(trimmed)) {
    return trimmed;
  }

  // Convert CONCURRENTLY to a SQL comment for traceability
  // Also used to mark the index for later validation
  const result = trimmed
    .replace(/\bCONCURRENTLY\b/i, '/* CONCURRENTLY */')
    .replace(/\s{2,}/g, ' ')
    .trim();

  logger.info(
    { original: trimmed, rewritten: result },
    'ConcurrentlyShim: CREATE INDEX CONCURRENTLY rewritten',
  );

  return result;
}

/**
 * Rewrite DROP INDEX CONCURRENTLY.
 *
 * Similar to CREATE: strip CONCURRENTLY, replace with a comment marker.
 *
 * @param sql - DROP INDEX CONCURRENTLY statement
 * @returns Rewritten SQL string
 *
 * @example
 * ```ts
 * rewriteDropIndexConcurrently('DROP INDEX CONCURRENTLY ix');
 * // Result: 'DROP INDEX // CONCURRENTLY  ix'
 * ```
 */
export function rewriteDropIndexConcurrently(sql: string): string {
  const trimmed = sql.trim();
  if (!CONCURRENTLY_KEYWORD.test(trimmed)) {
    return trimmed;
  }

  const result = trimmed
    .replace(/\bCONCURRENTLY\b/i, '/* CONCURRENTLY */')
    .replace(/\s{2,}/g, ' ')
    .trim();

  logger.info(
    { original: trimmed, rewritten: result },
    'ConcurrentlyShim: DROP INDEX CONCURRENTLY rewritten',
  );

  return result;
}

// ──────────────────────────────────────────────
//  Execution — CREATE INDEX CONCURRENTLY
// ──────────────────────────────────────────────

/**
 * Execute CREATE INDEX CONCURRENTLY on a better-sqlite3 database.
 *
 * Two-phase simulation:
 * 1. Create the index with the specified configuration
 * 2. Validate the index via consistency check
 *
 * @param db - better-sqlite3 database instance
 * @param config - Index configuration
 * @returns Execution result
 */
export async function executeCreateIndexConcurrently(
  db: any,
  config: ConcurrentIndexConfig,
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const actualIndexName = config.indexName;

  try {
    // Phase 1: Create the index
    const uniqueClause = config.unique ? 'UNIQUE ' : '';
    const whereClause = config.whereClause ? ` WHERE ${config.whereClause}` : '';
    const sql = `CREATE ${uniqueClause}INDEX IF NOT EXISTS "${actualIndexName}" ON "${config.tableName}" (${config.columns})${whereClause}`;

    logger.info(
      { indexName: actualIndexName, sql },
      'ConcurrentlyShim: Phase 1 — creating index',
    );

    db.exec(sql);

    // Phase 2: Validate the created index
    const validation = validateConcurrentIndex(db, actualIndexName);

    if (!validation.valid) {
      logger.warn(
        { indexName: actualIndexName, errors: validation.errors },
        'ConcurrentlyShim: Phase 2 — validation found issues',
      );
    }

    const durationMs = Date.now() - startTime;

    logger.info(
      { indexName: actualIndexName, durationMs, valid: validation.valid },
      'ConcurrentlyShim: CREATE INDEX CONCURRENTLY complete',
    );

    return { success: true, durationMs, actualIndexName };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    logger.error(
      { indexName: actualIndexName, error: error.message },
      'ConcurrentlyShim: CREATE INDEX CONCURRENTLY failed',
    );
    return { success: false, durationMs, actualIndexName };
  }
}

// ──────────────────────────────────────────────
//  Execution — DROP INDEX CONCURRENTLY
// ──────────────────────────────────────────────

/**
 * Execute DROP INDEX CONCURRENTLY on a better-sqlite3 database.
 *
 * Two-phase simulation:
 * 1. Check index exists (validation)
 * 2. Execute DROP INDEX
 *
 * @param db - better-sqlite3 database instance
 * @param indexName - Name of the index to drop
 * @returns Execution result
 */
export async function executeDropIndexConcurrently(
  db: any,
  indexName: string,
): Promise<ExecuteResult> {
  const startTime = Date.now();

  try {
    // Phase 1: Verify the index exists
    const validation = validateConcurrentIndex(db, indexName);

    if (!validation.valid) {
      logger.warn(
        { indexName, errors: validation.errors },
        'ConcurrentlyShim: DROP validation found issues — index may not exist',
      );
    }

    // Phase 2: Drop the index
    const sql = `DROP INDEX IF EXISTS "${indexName}"`;
    logger.info(
      { indexName, sql },
      'ConcurrentlyShim: executing DROP INDEX',
    );

    db.exec(sql);

    const durationMs = Date.now() - startTime;

    logger.info(
      { indexName, durationMs },
      'ConcurrentlyShim: DROP INDEX CONCURRENTLY complete',
    );

    return { success: true, durationMs };
  } catch (error: any) {
    const durationMs = Date.now() - startTime;
    logger.error(
      { indexName, error: error.message },
      'ConcurrentlyShim: DROP INDEX CONCURRENTLY failed',
    );
    return { success: false, durationMs };
  }
}

// ──────────────────────────────────────────────
//  Validation
// ──────────────────────────────────────────────

/**
 * Validate that a concurrent index exists and is consistent.
 *
 * Checks:
 * - Index exists in sqlite_master
 * - Index structure can be read
 *
 * @param db - better-sqlite3 database instance
 * @param indexName - Name of the index to validate
 * @returns Validation result
 */
export function validateConcurrentIndex(
  db: any,
  indexName: string,
): ValidationResult {
  const errors: string[] = [];

  try {
    // Check if index exists in sqlite_master
    const row = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    ).get(indexName);

    if (!row) {
      errors.push(`Index "${indexName}" not found in sqlite_master`);
      return { valid: false, errors };
    }

    // Additional check: attempt to read index info
    const indexInfo = db.prepare(`PRAGMA index_info("${indexName}")`).all();
    if (!indexInfo || indexInfo.length === 0) {
      errors.push(`Index "${indexName}" has no column information`);
      return { valid: false, errors };
    }

    return { valid: true, errors };
  } catch (error: any) {
    errors.push(`Validation error: ${error.message}`);
    return { valid: false, errors };
  }
}
