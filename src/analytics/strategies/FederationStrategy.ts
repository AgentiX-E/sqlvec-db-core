/**
 * FederationStrategy — interface for analytics federation strategies
 *
 * Each strategy encapsulates a way to execute OLAP queries across shards:
 * - LOCAL: local columnar tables (lowest latency)
 * - ATTACH_SHARED: ATTACH shared storage (NFS/EFS)
 * - HTTPFS_PARQUET: Parquet via S3/MinIO
 * - NODE_XPORT: forward to remote nodes (fallback)
 *
 * Strategies are ordered by priority (lower = preferred).
 */
import type { DuckDBResult } from '../DuckDBAnalyticsManager';

export interface FederationStrategy {
  /** Unique strategy name (used for caching and diagnostics) */
  readonly name: string;

  /** Priority: lower = preferred (0 = highest)
   *  LOCAL=0, ATTACH_SHARED=10, HTTPFS=20, NODE_XPORT=30 */
  readonly priority: number;

  /** Check whether this strategy can be used right now */
  available(): Promise<boolean>;

  /** Execute an analytics SQL query through this strategy */
  execute(sql: string): Promise<DuckDBResult>;
}

/** Result from a single remote node in NodeTransportStrategy */
export interface RemoteQueryResult {
  nodeId: string;
  columns: Array<{ name: string; type: string }>;
  rows: Record<string, unknown>[];
  error?: string;
}

/** Configuration for S3/MinIO httpfs strategy */
export interface HttpfsConfig {
  endpoint: string;          // s3://bucket/prefix
  region: string;
  accessKey: string;
  secretKey: string;
  s3Endpoint?: string;       // custom endpoint (MinIO etc.)
}

/** Configuration for remote node execution */
export interface NodeTransportConfig {
  /** How to contact remote nodes (host:port list) */
  peers: string[];
  /** Timeout per remote query (ms) */
  queryTimeoutMs?: number;
}
