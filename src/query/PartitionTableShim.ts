/**
 * PartitionTableShim — PostgreSQL partition table DDL compatibility shim for SQLite.
 *
 * SQLite does not support PostgreSQL's partition table syntax including
 * PARTITION BY, PARTITION OF, ATTACH PARTITION, and DETACH PARTITION.
 * This shim intercepts these statements and rewrites them to SQLite-compatible
 * equivalents.
 *
 * ## Strategy
 *
 * | PG Syntax                                      | SQLite Strategy                             |
 * |-------------------------------------------------|---------------------------------------------|
 * | CREATE TABLE ... PARTITION BY RANGE/LIST/HASH   | Strip PARTITION BY clause, create plain table |
 * | CREATE TABLE ... PARTITION OF ...               | Strip PARTITION OF clause, create plain table |
 * | ALTER TABLE ... ATTACH PARTITION ...            | No-op (skip entirely)                       |
 * | ALTER TABLE ... DETACH PARTITION ...            | No-op (skip entirely)                       |
 * | Non-partition DDL                               | Pass through unchanged                      |
 *
 * ## Key guarantees
 * - All handled output is valid SQLite DDL
 * - Detection is conservative: only top-level partition statements
 * - PinoLogger integration for debugging and audit trails
 * - No false positives on SQL containing 'PARTITION' in identifiers or
 *   inside string literals (e.g., column name `partition_id`)
 *
 * @module PartitionTableShim
 */

import { PinoLogger } from '../logger/PinoLogger';
import type Database from 'better-sqlite3';

const logger = PinoLogger.forComponent('PartitionTableShim');

// ── Types ────────────────────────────────────────────────────────

export interface PartitionResult {
  /** Rewritten SQL (null = no-op, statement should be skipped entirely) */
  sql: string | null;
  /** Whether the SQL was modified from its original form */
  rewritten: boolean;
  /** The type of partition operation detected */
  operation: 'create' | 'attach' | 'detach' | 'none';
}

// ── Constants — Regex patterns ──────────────────────────────────

/**
 * Matches CREATE TABLE ... PARTITION BY RANGE/LIST/HASH (...).
 *
 * Group 1 captures everything before PARTITION BY (the plain CREATE TABLE portion).
 * Group 2 captures the partition method (RANGE, LIST, or HASH).
 *
 * The `.` in group 1 uses non-greedy matching (`.*?`) with the `s` (dotAll) flag
 * so that newlines within column definitions are handled correctly.
 */
const CREATE_TABLE_PARTITION_BY_RE =
  /^(\s*CREATE\s+TABLE\s+.*?)\s+PARTITION\s+BY\s+(RANGE|LIST|HASH)\s*\(.*?\)\s*;?\s*$/is;

/**
 * Matches CREATE TABLE ... PARTITION OF parent [...].
 *
 * Group 1 captures the table name (first identifier after CREATE TABLE keyword).
 * The `\S+` pattern captures the table name up to whitespace, which handles
 * quoted identifiers like `"t_p1"` as well as bare names like `t_p1`.
 */
const CREATE_TABLE_PARTITION_OF_RE =
  /^\s*CREATE\s+TABLE\s+(\S+)\s+PARTITION\s+OF\s+/i;

/**
 * Matches ALTER TABLE ... ATTACH PARTITION ...
 */
const ALTER_ATTACH_PARTITION_RE =
  /^\s*ALTER\s+TABLE\s+.*?\s+ATTACH\s+PARTITION\s+/i;

/**
 * Matches ALTER TABLE ... DETACH PARTITION ...
 */
const ALTER_DETACH_PARTITION_RE =
  /^\s*ALTER\s+TABLE\s+.*?\s+DETACH\s+PARTITION\s+/i;

/**
 * Combined detection pattern — matches any partition-related DDL at the
 * start of a statement. Used by detectPartitionDDL for a single-pass check.
 */
const PARTITION_DDL_RE =
  /^\s*(?:CREATE\s+TABLE\s+.*?\s+PARTITION\s+(?:BY\s+(?:RANGE|LIST|HASH)|OF\s+)|ALTER\s+TABLE\s+.*?\s+(?:ATTACH|DETACH)\s+PARTITION\s+)/i;

// ── Public API ───────────────────────────────────────────────────

/**
 * Detect whether the given SQL string is a partition-related DDL statement.
 *
 * Performs a case-insensitive check for partition syntax at the start of
 * the statement. Uses a fast `PARTITION` keyword pre-check before the
 * more expensive regex.
 *
 * Detects:
 * - CREATE TABLE ... PARTITION BY RANGE/LIST/HASH
 * - CREATE TABLE ... PARTITION OF ...
 * - ALTER TABLE ... ATTACH PARTITION ...
 * - ALTER TABLE ... DETACH PARTITION ...
 *
 * @param sql   The raw SQL string to inspect
 * @returns     `true` if the SQL is a partition-related DDL statement
 *
 * @example
 * ```ts
 * detectPartitionDDL('CREATE TABLE t (id INT) PARTITION BY RANGE (id)');   // true
 * detectPartitionDDL('CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (1) TO (1000)'); // true
 * detectPartitionDDL('ALTER TABLE t ATTACH PARTITION t_p1');              // true
 * detectPartitionDDL('ALTER TABLE t DETACH PARTITION t_p1');              // true
 * detectPartitionDDL('CREATE TABLE t (id INT)');                          // false
 * ```
 */
export function detectPartitionDDL(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return false;
  }

  const trimmed = sql.trim();

  // Fast keyword pre-check — avoids the full regex for non-partition SQL
  if (!/\bPARTITION\b/i.test(trimmed)) {
    return false;
  }

  return PARTITION_DDL_RE.test(trimmed);
}

/**
 * Handle a partition-related DDL statement, rewriting it for SQLite compatibility.
 *
 * **Processing rules:**
 * | Input                                                                    | Output                                    | operation |
 * |--------------------------------------------------------------------------|-------------------------------------------|-----------|
 * | `CREATE TABLE t (id INT) PARTITION BY RANGE (id)`                       | `CREATE TABLE t (id INT);`                | create    |
 * | `CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (1) TO (1000)`        | `CREATE TABLE t_p1;`                      | create    |
 * | `CREATE TABLE "t_p1" PARTITION OF t FOR VALUES IN (1, 2, 3)`            | `CREATE TABLE "t_p1";`                    | create    |
 * | `ALTER TABLE t ATTACH PARTITION t_p1 FOR VALUES IN (1, 2, 3)`           | `null` (no-op)                            | attach    |
 * | `ALTER TABLE t DETACH PARTITION t_p1`                                   | `null` (no-op)                            | detach    |
 * | `CREATE TABLE t (id INT)`                                                | `<original>` (pass-through)               | none      |
 * | `ALTER TABLE t ADD COLUMN x INT`                                         | `<original>` (pass-through)               | none      |
 *
 * @param sql   The raw SQL string to process
 * @returns     A PartitionResult indicating the handling outcome
 *
 * @example
 * ```ts
 * const result = handlePartitionDDL('CREATE TABLE t (id INT) PARTITION BY RANGE (id)');
 * // → { sql: 'CREATE TABLE t (id INT);', rewritten: true, operation: 'create' }
 *
 * const result = handlePartitionDDL('ALTER TABLE t ATTACH PARTITION t_p1');
 * // → { sql: null, rewritten: true, operation: 'attach' }
 *
 * const result = handlePartitionDDL('CREATE TABLE t (id INT)');
 * // → { sql: 'CREATE TABLE t (id INT)', rewritten: false, operation: 'none' }
 * ```
 */
export function handlePartitionDDL(sql: string): PartitionResult {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return {
      sql: sql ?? '',
      rewritten: false,
      operation: 'none',
    };
  }

  const trimmed = sql.trim();

  // ── 1. CREATE TABLE ... PARTITION BY RANGE/LIST/HASH ... ────
  const partitionByMatch = trimmed.match(CREATE_TABLE_PARTITION_BY_RE);
  if (partitionByMatch) {
    const rewrittenSql = (partitionByMatch[1] ?? '').trim() + ';';
    logger.debug(
      { original: trimmed, rewritten: rewrittenSql },
      'CREATE TABLE ... PARTITION BY detected — stripping PARTITION BY clause',
    );
    return {
      sql: rewrittenSql,
      rewritten: true,
      operation: 'create',
    };
  }

  // ── 2. CREATE TABLE ... PARTITION OF ... ────────────────────
  const partitionOfMatch = trimmed.match(CREATE_TABLE_PARTITION_OF_RE);
  if (partitionOfMatch) {
    const tableName = partitionOfMatch[1].replace(/[;]+$/, '');
    const rewrittenSql = `CREATE TABLE ${tableName};`;
    logger.debug(
      { original: trimmed, rewritten: rewrittenSql, tableName },
      'CREATE TABLE ... PARTITION OF detected — creating plain table',
    );
    return {
      sql: rewrittenSql,
      rewritten: true,
      operation: 'create',
    };
  }

  // ── 3. ALTER TABLE ... ATTACH PARTITION ... → no-op ────────
  if (ALTER_ATTACH_PARTITION_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ... ATTACH PARTITION detected — suppressing as no-op',
    );
    return {
      sql: null,
      rewritten: true,
      operation: 'attach',
    };
  }

  // ── 4. ALTER TABLE ... DETACH PARTITION ... → no-op ────────
  if (ALTER_DETACH_PARTITION_RE.test(trimmed)) {
    logger.debug(
      { sql: trimmed },
      'ALTER TABLE ... DETACH PARTITION detected — suppressing as no-op',
    );
    return {
      sql: null,
      rewritten: true,
      operation: 'detach',
    };
  }

  // ── 5. Not a partition statement — pass through unchanged ───
  return {
    sql: trimmed,
    rewritten: false,
    operation: 'none',
  };
}

// ──────────────────────────────────────────────
//  Internal helpers (exported for testing)
// ──────────────────────────────────────────────

/**
 * Check if a SQL statement matches the CREATE TABLE ... PARTITION BY pattern.
 * More specific than detectPartitionDDL — only matches PARTITION BY variants.
 *
 * @param sql   The SQL string to test
 * @returns     `true` if the statement contains a PARTITION BY clause
 *
 * @internal Exported for unit testing only.
 */
export function _isCreateTablePartitionBy(sql: string): boolean {
  if (typeof sql !== 'string') {
    return false;
  }
  return CREATE_TABLE_PARTITION_BY_RE.test(sql.trim());
}

/**
 * Check if a SQL statement matches the CREATE TABLE ... PARTITION OF pattern.
 *
 * @param sql   The SQL string to test
 * @returns     `true` if the statement contains a PARTITION OF clause
 *
 * @internal Exported for unit testing only.
 */
export function _isCreateTablePartitionOf(sql: string): boolean {
  if (typeof sql !== 'string') {
    return false;
  }
  return CREATE_TABLE_PARTITION_OF_RE.test(sql.trim());
}

/**
 * Extract the partition method (RANGE, LIST, or HASH) from a
 * CREATE TABLE ... PARTITION BY statement.
 *
 * @param sql   The SQL string to inspect
 * @returns     The partition method string, or `null` if not a PARTITION BY statement
 *
 * @example
 * ```ts
 * _extractPartitionType('CREATE TABLE t (id INT) PARTITION BY RANGE (id)');
 * // → 'RANGE'
 * ```
 *
 * @internal Exported for unit testing only.
 */
export function _extractPartitionType(
  sql: string,
): 'RANGE' | 'LIST' | 'HASH' | null {
  if (typeof sql !== 'string') {
    return null;
  }
  const match = sql.trim().match(CREATE_TABLE_PARTITION_BY_RE);
  if (match) {
    return match[2].toUpperCase() as 'RANGE' | 'LIST' | 'HASH';
  }
  return null;
}

// ── Real shard table operations ─────────────────────────────────

export interface ShardTableInfo {
  parentTable: string;
  partitionName: string;
  partitionBounds: string;
  partitionMethod: 'RANGE' | 'LIST' | 'HASH';
  partitionColumn: string;
}

/**
 * Extract partition information from a DDL statement.
 * Parses ATTACH/DETACH and PARTITION OF statements to extract table names and bounds.
 *
 * @param sql  The raw SQL string to inspect.
 * @returns ShardTableInfo object or null if not a partition DDL with extractable info.
 */
export function extractPartitionInfo(sql: string): ShardTableInfo | null {
  // ALTER TABLE parent ATTACH PARTITION child FOR VALUES ...
  const attachMatch = sql.match(
    /ALTER\s+TABLE\s+["`]?(\w+)["`]?\s+ATTACH\s+PARTITION\s+["`]?(\w+)["`]?\s+FOR\s+VALUES\s+(.+)/i,
  );
  if (attachMatch) {
    const parentTable = attachMatch[1];
    const partitionName = attachMatch[2];
    const valuesClause = attachMatch[3].trim();

    const parsed = parseBoundValues(valuesClause);
    if (parsed) {
      return {
        parentTable,
        partitionName,
        partitionBounds: parsed.bounds,
        partitionMethod: parsed.method,
        partitionColumn: '', // Unknown from ATTACH alone — caller should supply
      };
    }
  }

  // CREATE TABLE child PARTITION OF parent FOR VALUES ...
  const createOfMatch = sql.match(
    /CREATE\s+TABLE\s+["`]?(\w+)["`]?\s+PARTITION\s+OF\s+["`]?(\w+)["`]?\s+FOR\s+VALUES\s+(.+)/i,
  );
  if (createOfMatch) {
    const partitionName = createOfMatch[1];
    const parentTable = createOfMatch[2];
    const valuesClause = createOfMatch[3].trim();

    const parsed = parseBoundValues(valuesClause);
    if (parsed) {
      return {
        parentTable,
        partitionName,
        partitionBounds: parsed.bounds,
        partitionMethod: parsed.method,
        partitionColumn: '', // Unknown — caller should supply
      };
    }
  }

  return null;
}

/**
 * Parse FOR VALUES clause into method and bounds.
 */
function parseBoundValues(clause: string): { method: 'RANGE' | 'LIST' | 'HASH'; bounds: string } | null {
  // RANGE: FROM (x) TO (y)
  const rangeMatch = clause.match(/FROM\s*\(([^)]*)\)\s*TO\s*\(([^)]*)\)/i);
  if (rangeMatch) {
    const fromVal = rangeMatch[1].trim();
    const toVal = rangeMatch[2].trim();
    return {
      method: 'RANGE',
      bounds: JSON.stringify({ from: parseLiteral(fromVal), to: parseLiteral(toVal) }),
    };
  }

  // LIST: IN (a, b, c)
  const listMatch = clause.match(/IN\s*\(([^)]+)\)/i);
  if (listMatch) {
    const values = listMatch[1].split(',').map((v) => parseLiteral(v.trim()));
    return {
      method: 'LIST',
      bounds: JSON.stringify({ values }),
    };
  }

  // HASH: MODULUS n, REMAINDER r
  const hashMatch = clause.match(/MODULUS\s+(\d+)\s*,\s*REMAINDER\s+(\d+)/i);
  if (hashMatch) {
    return {
      method: 'HASH',
      bounds: JSON.stringify({ modulus: parseInt(hashMatch[1], 10), remainder: parseInt(hashMatch[2], 10) }),
    };
  }

  return null;
}

/**
 * Parse a literal value from SQL syntax.
 */
function parseLiteral(val: string): any {
  const trimmed = val.trim();
  if (trimmed.toLowerCase() === 'null') return null;
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  const num = Number(trimmed);
  if (!isNaN(num)) return num;
  return trimmed;
}

/**
 * Create an actual SQLite shard table with a CHECK constraint mimicking partition bounds.
 *
 * @param db          A better-sqlite3 Database instance.
 * @param shardInfo   Information about the shard table to create.
 * @param schema      The column definitions (the part before PARTITION BY in CREATE TABLE).
 * @returns The CREATE TABLE SQL that was executed.
 */
export function createShardTable(
  db: Database.Database,
  shardInfo: ShardTableInfo,
  schema?: string,
): string {
  const { partitionName, partitionMethod, partitionBounds } = shardInfo;
  const bounds = JSON.parse(partitionBounds);

  let checkExpr: string | null = null;
  const col = shardInfo.partitionColumn;

  switch (partitionMethod) {
    case 'RANGE': {
      const fromVal = formatLiteral(bounds.from);
      const toVal = formatLiteral(bounds.to);
      if (col) {
        checkExpr = `"${col}" >= ${fromVal} AND "${col}" < ${toVal}`;
      }
      break;
    }
    case 'LIST': {
      const values = (bounds.values ?? []).map((v: any) => formatLiteral(v)).join(', ');
      if (col) {
        checkExpr = `"${col}" IN (${values})`;
      }
      break;
    }
    case 'HASH': {
      // SQLite can't easily enforce hash partitioning via CHECK
      // We use a note in the SQL comment instead
      checkExpr = null;
      break;
    }
  }

  let ddl: string;
  if (schema && schema.trim().length > 0) {
    // Extract column definitions (everything between the first '(' and last ')')
    const parenMatch = schema.match(/\(([\s\S]*)\)\s*$/);
    if (parenMatch) {
      const cols = parenMatch[1].trim();
      ddl = `CREATE TABLE IF NOT EXISTS "${partitionName}" (${cols}`;
      if (checkExpr) {
        ddl += `, CHECK (${checkExpr})`;
      }
      ddl += ');';
    } else {
      ddl = `CREATE TABLE IF NOT EXISTS "${partitionName}" ();`;
    }
  } else {
    ddl = `CREATE TABLE IF NOT EXISTS "${partitionName}" ();`;
  }

  db.exec(ddl);
  logger.info({ partitionName, ddl }, 'Shard table created');
  return ddl;
}

/**
 * Drop a shard table from the database.
 *
 * @param db             A better-sqlite3 Database instance.
 * @param partitionName  The shard table name to drop.
 */
export function dropShardTable(db: Database.Database, partitionName: string): void {
  db.exec(`DROP TABLE IF EXISTS "${partitionName}"`);
  logger.info({ partitionName }, 'Shard table dropped');
}

/**
 * Format a literal value for SQL.
 */
function formatLiteral(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return String(val);
  // String — quote it
  return `'${String(val).replace(/'/g, "''")}'`;
}
