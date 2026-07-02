/**
 * SqlVec DB — Core Storage Interfaces
 *
 * These interfaces define the contract between the storage layer and all
 * consumers (QueryRouter, DataBridge, VectorEngine, etc). All packages
 * depend on these interfaces, never on concrete implementations.
 *
 * @module interfaces/storage
 */

import type Database from 'better-sqlite3';

// ── Query Result Types ──

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  columns?: string[];
  queryTimeMs?: number;
  engine?: string;
}

// ── Apply Entry ──

export interface ApplyEntry {
  msgId: string;
  type: 'upsert' | 'delete' | 'ddl' | 'exec';
  data: Record<string, unknown> & {
    sql?: string;
    table?: string;
    __batch?: boolean;
    entries?: ApplyEntry[];
    __table?: string;
    __delete?: boolean;
    __update?: boolean;
  };
  shardId?: number;
  raftIndex?: number;
  raftTerm?: number;
  _batchable?: boolean;
}

export interface ShardStats {
  shardId: number;
  path: string;
  tableCount: number;
  totalRows: number;
  sizeBytes: number;
  walSizeBytes: number;
  readerCount: number;
  checkpointCount: number;
  vectorEnabled: boolean;
}

export interface ShardConfig {
  shardId: number;
  storageDir: string;
  vectorConfig?: {
    enabled: boolean;
    dimension?: number;
  };
}

export interface ShardRouteResult {
  shardId: number;
  allShards: boolean;
}

// ── Core Storage Interfaces ──

/**
 * Single shard's storage. One SQLite file per shard.
 */
export interface IShardReplica {
  readonly shardId: number;
  readonly path: string;
  readonly db: Database.Database;

  /** Execute SQL on this shard (read) */
  query(sql: string, params?: unknown[]): Record<string, unknown>[];

  /** Execute SQL on this shard (read, single row) */
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;

  /** Apply a write entry (from Raft log or direct) */
  apply(entry: ApplyEntry): boolean;

  /** Apply from EventBus fallback path */
  applyFromEventBus(entry: ApplyEntry): boolean;

  /** Get shard statistics */
  getStats(): ShardStats;

  /** Bootstrap shard with initial schema */
  bootstrap(schemaSql: string): void;

  /** Close and release resources */
  close(): Promise<void>;
}

/**
 * Manages all shards. The central storage coordinator.
 */
export interface IShardManager {
  /** Initialize shards */
  initialize(shardCount: number, bootstrapSql?: string): Promise<void>;

  /** Load existing shards from disk */
  loadExisting(): Promise<void>;

  /** Create a new shard */
  createShard(shardId: number, bootstrapSql?: string): Promise<IShardReplica>;

  /** Get a shard by ID */
  getShard(shardId: number): IShardReplica | undefined;

  /** List all shards */
  listShards(): IShardReplica[];

  /** Get shard IDs */
  getShardIds(): number[];

  /** Execute SQL on all shards (write) */
  execAll(sql: string): Promise<void>;

  /** Execute SQL on a specific shard (write) */
  execShard(shardId: number, sql: string): Promise<{ changes: number }>;

  /** Execute batch SQL on a shard */
  execBatchOnShard(shardId: number, sqls: string[]): Promise<{ changes: number }>;

  /** Query across all shards (read, scatter-gather) */
  queryAll(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;

  /** Query a specific shard (read) */
  queryShard(shardId: number, sql: string, params?: unknown[]): Record<string, unknown>[];

  /** Deterministic hash-based shard routing */
  getShardIdForKey(key: string): number;

  /** Pick a reader for parallel reads (WAL reader pool) */
  pickReader(shard: IShardReplica): Database.Database;

  /** Close all shards */
  close(): Promise<void>;
}

/**
 * Source of shards for CDC/analytics operations.
 * Abstracts away whether shards are local or remote.
 */
export interface IShardSource {
  listShards(): IShardReplica[];
  getShard(shardId: number): IShardReplica | undefined;
}
