/**
 * SqlVecConfig — Configuration loading and validation
 *
 * Supports loading from:
 * - JSON/YAML config file
 * - Environment variables
 * - Command-line args
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  DatabaseConfig,
  ClusterConfig,
  VectorConfig,
  ReplicationConfig,
  StorageConfig,
  RaftSnapshotConfig,
  VectorMode,
  VectorMetric,
  VectorIndexType,
  TDEConfig,
  SqlVecError,
  SqlVecErrorCode,
} from '../types';

export function loadConfig(configPath?: string): DatabaseConfig {
  let raw: any;
  if (configPath && fs.existsSync(configPath)) {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } else {
    raw = rawDefaults();
  }
  // Apply env var overrides on top of defaults or JSON values
  applyEnvOverrides(raw);

  return parseConfig(raw);
}

function rawDefaults(): any {
  return {
    cluster: {
      clusterName: process.env.SQLVEC_CLUSTER_NAME || 'sqlvec-default',
      nodeId: process.env.SQLVEC_NODE_ID || generateNodeId(),
      listenHost: process.env.SQLVEC_LISTEN_HOST || '0.0.0.0',
      pgPort: parseInt(process.env.SQLVEC_PG_PORT || '5432', 10),
      zmqPort: parseInt(process.env.SQLVEC_ZMQ_PORT || '5555', 10),
      datacenter: process.env.SQLVEC_DC || 'dc-default',
      shardCount: parseInt(process.env.SQLVEC_SHARD_COUNT || '4', 10),
      replicationFactor: parseInt(process.env.SQLVEC_REPLICATION_FACTOR || '2', 10),
      seedNodes: (process.env.SQLVEC_SEED_NODES || '').split(',').filter(Boolean),
      dataDir: process.env.SQLVEC_DATA_DIR || './data',
      metricsPort: parseInt(process.env.SQLVEC_METRICS_PORT || '9464', 10),
      metricsHost: process.env.SQLVEC_METRICS_HOST || '127.0.0.1',
      autoForward: process.env.SQLVEC_AUTO_FORWARD !== 'false',
    },
    vector: {
      enabled: process.env.SQLVEC_VECTOR_ENABLED !== 'false',
      dimension: parseInt(process.env.SQLVEC_VECTOR_DIMENSION || '768', 10),
      metric: (process.env.SQLVEC_VECTOR_METRIC || 'cosine') as VectorMetric,
      mode: (process.env.SQLVEC_VECTOR_MODE || 'auto') as VectorMode,
      bruteForceThreshold: parseInt(process.env.SQLVEC_VECTOR_THRESHOLD || '500000', 10),
      indexType: (process.env.SQLVEC_INDEX_TYPE || 'hnsw') as VectorIndexType,
      indexParams: {},
    },
    replication: {
      enabled: process.env.SQLVEC_REPLICATION_ENABLED !== 'false',
      tickMs: parseInt(process.env.SQLVEC_TICK_MS || '500', 10),
      batchSize: parseInt(process.env.SQLVEC_BATCH_SIZE || '100', 10),
      ackTimeoutMs: parseInt(process.env.SQLVEC_ACK_TIMEOUT_MS || '5000', 10),
      workerCount: parseInt(process.env.SQLVEC_WORKER_COUNT || '1', 10),
      maxPending: parseInt(process.env.SQLVEC_MAX_PENDING || '1000', 10),
    },
    storage: {
      shardDir: process.env.SQLVEC_SHARD_DIR || './data/shards',
      walDir: process.env.SQLVEC_WAL_DIR || './data/wal',
      outboxDir: process.env.SQLVEC_OUTBOX_DIR || './data/outbox',
      lmdbMapSize: parseInt(process.env.SQLVEC_LMDB_MAP_SIZE || '1073741824', 10),
      checkpointIntervalMs: parseInt(process.env.SQLVEC_CHECKPOINT_MS || '60000', 10),
    },
    raft: {
      storagePath: process.env.SQLVEC_RAFT_STORAGE_PATH || undefined,
      snapshotInterval: parseInt(process.env.SQLVEC_RAFT_SNAPSHOT_INTERVAL || '100', 10),
      maxLogEntries: parseInt(process.env.SQLVEC_RAFT_MAX_LOG_ENTRIES || '0', 10),
    },
    tde: {
      enabled: process.env.TDE_ENABLED === 'true',
    },
  };
}

function applyEnvOverrides(raw: any): void {
  const envMap: Record<string, [string, string, 'string' | 'number' | 'boolean']> = {
    SQLVEC_NODE_ID: ['cluster', 'nodeId', 'string'],
    SQLVEC_DC: ['cluster', 'datacenter', 'string'],
    SQLVEC_PASSWORD: ['cluster', 'password', 'string'],
    SQLVEC_PG_PORT: ['cluster', 'pgPort', 'number'],
    SQLVEC_ZMQ_PORT: ['cluster', 'zmqPort', 'number'],
    SQLVEC_SHARD_COUNT: ['cluster', 'shardCount', 'number'],
    SQLVEC_REPLICATION_FACTOR: ['cluster', 'replicationFactor', 'number'],
    SQLVEC_LISTEN_HOST: ['cluster', 'listenHost', 'string'],
    SQLVEC_RAFT_PORT: ['cluster', 'raftPort', 'number'],
    SQLVEC_METRICS_PORT: ['cluster', 'metricsPort', 'number'],
    SQLVEC_METRICS_HOST: ['cluster', 'metricsHost', 'string'],
    SQLVEC_VECTOR_DIMENSION: ['vector', 'dimension', 'number'],
    SQLVEC_VECTOR_METRIC: ['vector', 'metric', 'string'],
    SQLVEC_VECTOR_THRESHOLD: ['vector', 'bruteForceThreshold', 'number'],
    SQLVEC_TICK_MS: ['replication', 'tickMs', 'number'],
    SQLVEC_BATCH_SIZE: ['replication', 'batchSize', 'number'],
    SQLVEC_RAFT_STORAGE_PATH: ['raft', 'storagePath', 'string'],
    SQLVEC_RAFT_SNAPSHOT_INTERVAL: ['raft', 'snapshotInterval', 'number'],
    SQLVEC_RAFT_MAX_LOG_ENTRIES: ['raft', 'maxLogEntries', 'number'],
    TDE_ENABLED: ['tde', 'enabled', 'boolean'],
  };

  for (const [envKey, [section, field, type]] of Object.entries(envMap)) {
    const envVal = process.env[envKey];
    if (envVal !== undefined) {
      if (!raw[section]) raw[section] = {};
      if (type === 'number') {
        raw[section][field] = parseInt(envVal, 10);
      } else if (type === 'boolean') {
        raw[section][field] = envVal === 'true';
      } else {
        raw[section][field] = envVal;
      }
    }
  }
}

function parseConfig(raw: any): DatabaseConfig {
  const cluster: ClusterConfig = {
    clusterName: raw.cluster?.clusterName || 'sqlvec-default',
    nodeId: raw.cluster?.nodeId || generateNodeId(),
    listenHost: raw.cluster?.listenHost || '0.0.0.0',
    pgPort: raw.cluster?.pgPort || 5432,
    zmqPort: raw.cluster?.zmqPort || 5555,
    raftPort: raw.cluster?.raftPort,
    datacenter: raw.cluster?.datacenter || 'dc-default',
    password: raw.cluster?.password || undefined,
    shardCount: raw.cluster?.shardCount || 4,
    replicationFactor: raw.cluster?.replicationFactor || 2,
    seedNodes: raw.cluster?.seedNodes || [],
    dataDir: raw.cluster?.dataDir || './data',
    metricsPort: raw.cluster?.metricsPort ?? 9464,
    metricsHost: raw.cluster?.metricsHost ?? '127.0.0.1',
    autoForward: raw.cluster?.autoForward !== false,
    authTimeoutMs: raw.cluster?.authTimeoutMs ?? 60000,
  };

  const vector: VectorConfig = {
    enabled: raw.vector?.enabled !== false,
    dimension: raw.vector?.dimension || 768,
    metric: raw.vector?.metric || VectorMetric.COSINE,
    mode: raw.vector?.mode || VectorMode.AUTO,
    bruteForceThreshold: raw.vector?.bruteForceThreshold || 500000,
    indexType: raw.vector?.indexType || VectorIndexType.HNSW,
    indexParams: raw.vector?.indexParams || {},
  };

  const replication: ReplicationConfig = {
    enabled: raw.replication?.enabled !== false,
    tickMs: raw.replication?.tickMs || 500,
    batchSize: raw.replication?.batchSize || 100,
    ackTimeoutMs: raw.replication?.ackTimeoutMs || 5000,
    workerCount: raw.replication?.workerCount || 1,
    maxPending: raw.replication?.maxPending || 1000,
  };

  const storage: StorageConfig = {
    shardDir: raw.storage?.shardDir || path.join(cluster.dataDir, 'shards'),
    walDir: raw.storage?.walDir || path.join(cluster.dataDir, 'wal'),
    outboxDir: raw.storage?.outboxDir || path.join(cluster.dataDir, 'outbox'),
    lmdbMapSize: raw.storage?.lmdbMapSize || 1073741824,
    checkpointIntervalMs: raw.storage?.checkpointIntervalMs || 60000,
  };

  const raft: RaftSnapshotConfig = {
    storagePath: raw.raft?.storagePath || undefined,
    snapshotInterval: typeof raw.raft?.snapshotInterval === 'number'
      ? raw.raft.snapshotInterval
      : 100,
    maxLogEntries: typeof raw.raft?.maxLogEntries === 'number'
      ? raw.raft.maxLogEntries
      : 0,
  };

  const tde = {
    enabled: raw.tde?.enabled === true,
  };

  return { cluster, vector, replication, storage, raft, tde };
}

function generateNodeId(): string {
  const crypto = require('crypto');
  return `node_${crypto.randomBytes(8).toString('hex')}`;
}
