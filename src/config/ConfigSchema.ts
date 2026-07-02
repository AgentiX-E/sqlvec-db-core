/**
 * ConfigSchema — Zod schemas for SqlVec DB configuration
 *
 * Mirrors all config interfaces from src/core/types.ts with validation.
 * Zod is an optional dependency — validation warnings are non-fatal.
 */

import { z } from 'zod';

// ============================================================
// Node & Cluster Topology
// ============================================================

export const NodeRoleSchema = z.enum(['leader', 'follower', 'candidate', 'observer']);

export const ShardRangeSchema = z.object({
  shardId: z.number().int().min(0),
  start: z.union([z.number(), z.bigint()]),
  end: z.union([z.number(), z.bigint()]),
  replicas: z.array(z.string()),
});

export const NodeDescriptorSchema = z.object({
  nodeId: z.string().uuid(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  dc: z.string().default('dc-default'),
  role: NodeRoleSchema.default('follower'),
  shardRanges: z.array(ShardRangeSchema).default([]),
  publicKey: z.string().optional(),
  heartbeatTs: z.number().default(0),
});

// ============================================================
// Shard Configuration
// ============================================================

export const ShardConfigSchema = z.object({
  shardId: z.number().int().min(0),
  path: z.string().min(1),
  dbPath: z.string().min(1),
  vectorPath: z.string().min(1),
  readOnly: z.boolean().default(false),
});

// ============================================================
// Vector Configuration
// ============================================================

export const VectorMetricSchema = z.enum(['cosine', 'l2', 'ip']);
export const VectorModeSchema = z.enum(['auto', 'bruteforce', 'indexed', 'hnsw']);
export const VectorIndexTypeSchema = z.enum(['hnsw', 'ivf', 'flat']);

export const VectorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dimension: z.number().int().min(1).max(65536).default(768),
  metric: VectorMetricSchema.default('cosine'),
  mode: VectorModeSchema.default('auto'),
  bruteForceThreshold: z.number().int().min(0).default(500000),
  indexType: VectorIndexTypeSchema.default('hnsw'),
  indexParams: z.record(z.string(), z.number()).default({}),
});

// ============================================================
// Replication Configuration
// ============================================================

export const ReplicationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tickMs: z.number().int().min(1).max(60000).default(500),
  batchSize: z.number().int().min(1).max(10000).default(100),
  ackTimeoutMs: z.number().int().min(100).max(300000).default(5000),
  workerCount: z.number().int().min(0).max(64).default(1),
  maxPending: z.number().int().min(1).max(100000).default(1000),
});

// ============================================================
// Storage Configuration
// ============================================================

export const StorageConfigSchema = z.object({
  shardDir: z.string().min(1).default('./data/shards'),
  walDir: z.string().min(1).default('./data/wal'),
  outboxDir: z.string().min(1).default('./data/outbox'),
  lmdbMapSize: z.number().int().min(65536).default(1073741824),
  checkpointIntervalMs: z.number().int().min(1000).max(3600000).default(60000),
});

// ============================================================
// Cluster Configuration
// ============================================================

export const ClusterConfigSchema = z.object({
  clusterName: z.string().min(1).default('sqlvec-default'),
  nodeId: z.string().min(1),
  listenHost: z.string().min(1).default('0.0.0.0'),
  pgPort: z.number().int().min(1).max(65535).default(5432),
  zmqPort: z.number().int().min(1).max(65535).default(5555),
  raftPort: z.number().int().min(1).max(65535).optional(),
  datacenter: z.string().min(1).default('dc-default'),
  shardCount: z.number().int().min(1).max(1024).default(4),
  replicationFactor: z.number().int().min(1).max(16).default(2),
  seedNodes: z.array(z.string()).default([]),
  dataDir: z.string().min(1).default('./data'),
  password: z.string().optional(),
  passwordHash: z.string().optional(),                         // SCRAM-SHA-256 hash (replaces plaintext password)
  authTimeoutMs: z.number().int().min(1000).default(60000),   // Auth timeout ms (default: 60s, matching PG)
  backupDir: z.string().optional(),                           // Backup directory path
  metricsPort: z.number().int().min(1).max(65535).default(9464),
  metricsHost: z.string().min(1).default('127.0.0.1'),
});

// ============================================================
// HNSW Configuration
// ============================================================

export const HnswConfigSchema = z.object({
  m: z.number().int().min(2).max(100).default(16),
  efConstruction: z.number().int().min(1).max(1000).default(200),
  efSearch: z.number().int().min(1).max(10000).default(50),
  maxElements: z.number().int().min(1).max(100_000_000).default(1_000_000),
});

// ============================================================
// Product Quantization Configuration
// ============================================================

export const ProductQuantizationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  m: z.number().int().min(1).max(128).default(8),
  k: z.number().int().min(1).max(65536).default(256),
  numCentroids: z.number().int().min(1).default(2048),
  trainSampleSize: z.number().int().min(1).default(10000),
});

// ============================================================
// Raft Snapshot Configuration
// ============================================================

export const RaftSnapshotConfigSchema = z.object({
  snapshotInterval: z.number().int().min(0).default(100),
  maxLogEntries: z.number().int().min(0).default(10000),
  storagePath: z.string().optional(),
});

// ============================================================
// Outbox Backpressure Configuration (H2)
// ============================================================

export const OutboxBackpressureConfigSchema = z.object({
  threshold: z.number().min(0).max(1).default(0.1),
  lowWatermark: z.number().min(0).max(1).default(0.05),
  drainTimeoutMs: z.number().int().min(100).default(30000),
});

// ============================================================
// Monitoring Configuration
// ============================================================

export const MonitoringConfigSchema = z.object({
  metricsPort: z.number().int().min(1).max(65535).optional(),
  slowQueryThresholdMs: z.number().int().min(0).default(100),
  activeQueryMaxAgeMs: z.number().int().min(1000).default(300000),
});

// ============================================================
// Graceful Shutdown Configuration (E2)
// ============================================================

export const GracefulShutdownConfigSchema = z.object({
  drainTimeoutMs: z.number().int().min(100).default(30000),
  flushTimeoutMs: z.number().int().min(100).default(15000),
});

// ============================================================
// Flexible Quorum Configuration (E3)
// ============================================================

export const FlexibleQuorumConfigSchema = z.object({
  writeQuorum: z.number().int().min(1).default(3),
  readQuorum: z.number().int().min(1).default(1),
  commitQuorum: z.number().int().min(1).default(3),
});

// ============================================================
// ZMQ Configuration
// ============================================================

export const ZmqConfigSchema = z.object({
  hwm: z.number().int().min(0).default(10000),
  receiveBuffer: z.number().int().min(0).default(0),
  sendBuffer: z.number().int().min(0).default(0),
});

// ============================================================
// Circuit Breaker Configuration
// ============================================================

export const CircuitBreakerConfigSchema = z.object({
  timeout: z.number().int().min(1).max(60000).default(5000),
  errorThresholdPercentage: z.number().min(0).max(100).default(50),
  resetTimeout: z.number().int().min(1).max(300000).default(30000),
  maxFailures: z.number().int().min(1).default(5),
});

// ============================================================
// Pipeline Configuration (C5)
// ============================================================

export const PipelineConfigSchema = z.object({
  batchSize: z.number().int().min(1).max(1000).default(10),
  batchIntervalMs: z.number().int().min(1).max(10000).default(50),
});

// ============================================================
// Compression Configuration
// ============================================================

export const CompressionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  threshold: z.number().int().min(0).default(1024),
  level: z.number().int().min(1).max(22).default(3),
});

// ============================================================
// TLS Configuration
// ============================================================

export const TlsConfigSchema = z.object({
  cert: z.string().min(1),
  key: z.string().min(1),
  ca: z.string().optional(),
  requestCert: z.boolean().default(false),
});

// ============================================================
// Slow Query Configuration
// ============================================================

export const SlowQueryConfigSchema = z.object({
  thresholdMs: z.number().int().min(0).default(100),
  maxSqlLength: z.number().int().min(1).default(200),
  logLevel: z.enum(['warn', 'info', 'debug']).default('warn'),
});

// ============================================================
// Shard Rebalance Configuration (E1)
// ============================================================

export const RebalanceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  intervalMs: z.number().int().min(1000).default(60000),
  threshold: z.number().int().min(1).default(2),
});

// ============================================================
// Top-Level: SqlVec Config (DatabaseConfig mirror)
// ============================================================

/**
 * Schema that mirrors the DatabaseConfig interface from types.ts.
 * This is the main config object loaded by SqlVecConfig.loadConfig().
 */
export const SqlVecConfigSchema = z.object({
  cluster: ClusterConfigSchema,
  vector: VectorConfigSchema,
  replication: ReplicationConfigSchema,
  storage: StorageConfigSchema,
  raft: RaftSnapshotConfigSchema.optional().default({
    snapshotInterval: 100,
    maxLogEntries: 0,
  }),

  // Pino Logger
  logging: z.object({
    logLevel: z.enum(['trace','debug','info','warn','error','fatal']).default('info').describe('Minimum log level'),
    logFile: z.string().optional().describe('Optional log file path'),
    logFormat: z.enum(['json', 'pretty']).optional().describe('Log format override'),
  }).optional(),

  // Health check
  healthCheck: z.object({
    port: z.number().default(9090).describe('Health check HTTP port'),
    host: z.string().default('127.0.0.1').describe('Health check listen host'),
  }).optional(),

  // Audit log
  auditLog: z.object({
    enabled: z.boolean().default(false).describe('Enable audit logging'),
    dbPath: z.string().default('./data/audit.db').describe('Audit log database path'),
  }).optional(),

  // Slow query
  slowQuery: z.object({
    enabled: z.boolean().default(true).describe('Enable slow query recording'),
    thresholdMs: z.number().default(500).describe('Slow query threshold in ms'),
    dbPath: z.string().default('./data/slow_queries.db').describe('Slow query database path'),
  }).optional(),

  // Statement timeout
  statementTimeoutMs: z.number().default(0).describe('Statement timeout in ms (0 = no limit)'),
});

/**
 * Inferred type from SqlVecConfigSchema.
 */
export type SqlVecConfigInferred = z.infer<typeof SqlVecConfigSchema>;

/**
 * Schema for validating raw (pre-parse) config input.
 */
export const SqlVecRawConfigSchema = z.object({
  cluster: z.object({
    clusterName: z.string().optional(),
    nodeId: z.string().optional(),
    listenHost: z.string().optional(),
    pgPort: z.union([z.number(), z.string()]).optional(),
    zmqPort: z.union([z.number(), z.string()]).optional(),
    raftPort: z.union([z.number(), z.string()]).optional(),
    datacenter: z.string().optional(),
    password: z.string().optional(),
    passwordHash: z.string().optional(),
    authTimeoutMs: z.union([z.number(), z.string()]).optional(),
    backupDir: z.string().optional(),
    shardCount: z.union([z.number(), z.string()]).optional(),
    replicationFactor: z.union([z.number(), z.string()]).optional(),
    seedNodes: z.array(z.string()).optional(),
    dataDir: z.string().optional(),
    metricsPort: z.union([z.number(), z.string()]).optional(),
    metricsHost: z.string().optional(),
  }).optional().default({}),
  vector: z.object({
    enabled: z.boolean().optional(),
    dimension: z.union([z.number(), z.string()]).optional(),
    metric: z.string().optional(),
    mode: z.string().optional(),
    bruteForceThreshold: z.union([z.number(), z.string()]).optional(),
    indexType: z.string().optional(),
    indexParams: z.record(z.string(), z.number()).optional(),
  }).optional().default({}),
  replication: z.object({
    enabled: z.boolean().optional(),
    tickMs: z.union([z.number(), z.string()]).optional(),
    batchSize: z.union([z.number(), z.string()]).optional(),
    ackTimeoutMs: z.union([z.number(), z.string()]).optional(),
    workerCount: z.union([z.number(), z.string()]).optional(),
    maxPending: z.union([z.number(), z.string()]).optional(),
  }).optional().default({}),
  storage: z.object({
    shardDir: z.string().optional(),
    walDir: z.string().optional(),
    outboxDir: z.string().optional(),
    lmdbMapSize: z.union([z.number(), z.string()]).optional(),
    checkpointIntervalMs: z.union([z.number(), z.string()]).optional(),
  }).optional().default({}),
  raft: z.object({
    storagePath: z.string().optional(),
    snapshotInterval: z.union([z.number(), z.string()]).optional(),
    maxLogEntries: z.union([z.number(), z.string()]).optional(),
  }).optional().default({}),

  // Pino Logger (raw)
  logging: z.object({
    logLevel: z.string().optional(),
    logFile: z.string().optional(),
    logFormat: z.string().optional(),
  }).optional().default({}),

  // Health check (raw)
  healthCheck: z.object({
    port: z.union([z.number(), z.string()]).optional(),
    host: z.string().optional(),
  }).optional().default({}),

  // Audit log (raw)
  auditLog: z.object({
    enabled: z.boolean().optional(),
    dbPath: z.string().optional(),
  }).optional().default({}),

  // Slow query (raw)
  slowQuery: z.object({
    enabled: z.boolean().optional(),
    thresholdMs: z.union([z.number(), z.string()]).optional(),
    dbPath: z.string().optional(),
  }).optional().default({}),

  // Statement timeout (raw)
  statementTimeoutMs: z.union([z.number(), z.string()]).optional(),
});
