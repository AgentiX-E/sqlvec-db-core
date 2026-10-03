/**
 * PartitionMetaManager — Persistent partition metadata management.
 *
 * Stores partition definitions in a SQLite `__partition_meta` table for
 * durable metadata across restarts. Supports RANGE, LIST, and HASH
 * partition methods.
 *
 * Each row in __partition_meta describes one shard/partition of a parent table:
 *   - parent_table: the logical partitioned table name
 *   - partition_method: RANGE | LIST | HASH
 *   - partition_column: the partition key column(s), comma-separated
 *   - partition_name: the actual shard table name
 *   - partition_bounds: JSON-serialized bounds describing what values this shard holds
 *   - created_at: ISO timestamp of registration
 *
 * @module query/PartitionMetaManager
 */

import { PinoLogger } from '../logger/PinoLogger';
import type Database from 'better-sqlite3';

const logger = PinoLogger.forComponent('PartitionMetaManager');

// ── Types ────────────────────────────────────────────────────────

export type PartitionMethod = 'RANGE' | 'LIST' | 'HASH';

export interface PartitionMeta {
  /** The logical partitioned table name */
  parentTable: string;
  /** Partition method: RANGE, LIST, or HASH */
  partitionMethod: PartitionMethod;
  /** Partition key column name (or comma-separated for multi-column) */
  partitionColumn: string;
  /** The actual shard/partition table name */
  partitionName: string;
  /** JSON-serialized bounds (e.g., '{"from":1,"to":1000}' for RANGE) */
  partitionBounds: string;
  /** ISO timestamp of creation */
  createdAt: string;
}

export interface RangeBounds {
  from: any;
  to: any;
}

export interface ListBounds {
  values: any[];
}

export interface HashBounds {
  modulus: number;
  remainder: number;
}

/**
 * Parse serialized bounds into a structured object.
 */
export function parseBounds(bounds: string): RangeBounds | ListBounds | HashBounds {
  return JSON.parse(bounds);
}

/**
 * Stringify structured bounds to JSON.
 */
export function stringifyBounds(bounds: RangeBounds | ListBounds | HashBounds): string {
  return JSON.stringify(bounds);
}

// ── Meta table management ─────────────────────────────────────────

/**
 * Ensure the `__partition_meta` system table exists.
 * Creates it if not present.
 *
 * @param db  A better-sqlite3 Database instance (typically shard 0).
 */
export function ensureMetaTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS __partition_meta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_table TEXT NOT NULL,
      partition_method TEXT NOT NULL CHECK(partition_method IN ('RANGE','LIST','HASH')),
      partition_column TEXT NOT NULL,
      partition_name TEXT NOT NULL,
      partition_bounds TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(parent_table, partition_name)
    )
  `);
  logger.debug('__partition_meta table ensured');
}

/**
 * Register a new partition shard in the metadata table.
 *
 * @param db    A better-sqlite3 Database instance.
 * @param meta  The partition metadata to register.
 */
export function registerPartition(db: Database.Database, meta: PartitionMeta): void {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO __partition_meta
      (parent_table, partition_method, partition_column, partition_name, partition_bounds, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    meta.parentTable,
    meta.partitionMethod,
    meta.partitionColumn,
    meta.partitionName,
    meta.partitionBounds,
    meta.createdAt || new Date().toISOString(),
  );
  logger.info(
    { parentTable: meta.parentTable, partitionName: meta.partitionName, method: meta.partitionMethod },
    'Partition registered in __partition_meta',
  );
}

/**
 * Remove a partition shard from the metadata table.
 *
 * @param db             A better-sqlite3 Database instance.
 * @param parentTable    The logical partitioned table name.
 * @param partitionName  The shard table name to unregister.
 */
export function unregisterPartition(
  db: Database.Database,
  parentTable: string,
  partitionName: string,
): void {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    DELETE FROM __partition_meta
    WHERE parent_table = ? AND partition_name = ?
  `);
  const result = stmt.run(parentTable, partitionName);
  logger.info(
    { parentTable, partitionName, changes: result.changes },
    'Partition unregistered from __partition_meta',
  );
}

/**
 * Get all partition shards for a given parent table, ordered by creation time.
 *
 * @param db           A better-sqlite3 Database instance.
 * @param parentTable  The logical partitioned table name.
 * @returns An array of PartitionMeta objects.
 */
export function getPartitionsForTable(
  db: Database.Database,
  parentTable: string,
): PartitionMeta[] {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    SELECT parent_table, partition_method, partition_column, partition_name,
           partition_bounds, created_at
    FROM __partition_meta
    WHERE parent_table = ?
    ORDER BY created_at ASC
  `);
  const rows = stmt.all(parentTable) as any[];
  return rows.map((row) => ({
    // The SELECT above aliases each column to its snake_case name, so the row
    // objects reliably carry snake_case keys; map them onto the camelCase API.
    parentTable: row.parent_table,
    partitionMethod: row.partition_method,
    partitionColumn: row.partition_column,
    partitionName: row.partition_name,
    partitionBounds: row.partition_bounds,
    createdAt: row.created_at,
  })) as PartitionMeta[];
}

/**
 * Drop all partition shards for a given parent table (cleanup on DROP TABLE).
 *
 * @param db           A better-sqlite3 Database instance.
 * @param parentTable  The logical partitioned table name.
 */
export function dropAllPartitionsForTable(
  db: Database.Database,
  parentTable: string,
): void {
  ensureMetaTable(db);
  const partitions = getPartitionsForTable(db, parentTable);
  for (const part of partitions) {
    try {
      db.exec(`DROP TABLE IF EXISTS "${part.partitionName}"`);
      logger.info({ partitionName: part.partitionName }, 'Dropped shard table');
    } catch (err: any) {
      logger.warn({ partitionName: part.partitionName, err: err.message }, 'Failed to drop shard table');
    }
  }
  const stmt = db.prepare(`DELETE FROM __partition_meta WHERE parent_table = ?`);
  const result = stmt.run(parentTable);
  logger.info({ parentTable, deleted: result.changes }, 'All partitions cleaned up for table');
}

/**
 * Check if a table has partitions registered.
 *
 * @param db           A better-sqlite3 Database instance.
 * @param parentTable  The table name to check.
 * @returns True if the table has registered partitions.
 */
export function hasPartitions(db: Database.Database, parentTable: string): boolean {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    SELECT COUNT(*) AS cnt FROM __partition_meta WHERE parent_table = ?
  `);
  // COUNT(*) always yields exactly one row, so the result is never undefined.
  const row = stmt.get(parentTable) as { cnt: number };
  return row.cnt > 0;
}

/**
 * Get the partition method for a given parent table (if partitioned).
 *
 * @param db           A better-sqlite3 Database instance.
 * @param parentTable  The table name to check.
 * @returns The partition method or null if not partitioned.
 */
export function getPartitionMethod(
  db: Database.Database,
  parentTable: string,
): PartitionMethod | null {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    SELECT DISTINCT partition_method FROM __partition_meta WHERE parent_table = ?
  `);
  const row = stmt.get(parentTable) as { partition_method: string } | undefined;
  if (!row) return null;
  return row.partition_method as PartitionMethod;
}

/**
 * Get the partition column for a given parent table.
 *
 * @param db           A better-sqlite3 Database instance.
 * @param parentTable  The table name to check.
 * @returns The partition column name or null.
 */
export function getPartitionColumn(
  db: Database.Database,
  parentTable: string,
): string | null {
  ensureMetaTable(db);
  const stmt = db.prepare(`
    SELECT DISTINCT partition_column FROM __partition_meta WHERE parent_table = ?
  `);
  const row = stmt.get(parentTable) as { partition_column: string } | undefined;
  return row?.partition_column ?? null;
}
