/**
 * SqlVec DB — Core Types & Interfaces
 */

// ============================================================
// 1. Node & Cluster Topology
// ============================================================

export interface NodeDescriptor {
  nodeId: string;           // UUID
  host: string;
  port: number;
  dc: string;               // Datacenter identifier (e.g. "dc-east", "dc-west")
  role: NodeRole;
  shardRanges: ShardRange[];
  publicKey?: string;       // CURVE ZMQ public key
  heartbeatTs: number;      // Last heartbeat (epoch ms)
}

export enum NodeRole {
  LEADER = 'leader',
  FOLLOWER = 'follower',
  CANDIDATE = 'candidate',
  OBSERVER = 'observer',
}

export interface ShardRange {
  shardId: number;
  start: bigint;            // Inclusive hash range start
  end: bigint;              // Inclusive hash range end
  replicas: string[];       // Node IDs holding replicas
}

// ============================================================
// 2. Shard Management
// ============================================================

export interface ShardConfig {
  shardId: number;
  path: string;             // SQLite file path
  dbPath: string;           // SQLite file path
  vectorPath: string;       // sqlite-vec file path (or same as dbPath)
  readOnly: boolean;
}

export interface ShardStats {
  shardId: number;
  rowCount: number;
  dbSizeBytes: number;
  vectorIndexSizeBytes: number;
  lastWriteTs: number;
  isHealthy: boolean;
}

// ============================================================
// 3. Vector Configuration
// ============================================================

export interface VectorConfig {
  enabled: boolean;
  dimension: number;              // Vector dimension (default: 768)
  metric: VectorMetric;
  mode: VectorMode;
  bruteForceThreshold: number;    // Max rows for brute-force (default: 500000)
  indexType: VectorIndexType;
  indexParams: Record<string, number>;
}

export enum VectorMetric {
  COSINE = 'cosine',
  L2 = 'l2',
  IP = 'ip',                    // Inner product
}

export enum VectorMode {
  AUTO = 'auto',
  BRUTEFORCE = 'bruteforce',
  INDEXED = 'indexed',
  HNSW = 'hnsw',
  IVFPQ = 'ivfpq',
}

export enum VectorIndexType {
  HNSW = 'hnsw',
  IVF = 'ivf',
  FLAT = 'flat',
  IVFPQ = 'ivfpq',
}

// ============================================================
// 4. Vector Search
// ============================================================

export interface VectorSearchQuery {
  collection: string;            // Table or collection name
  queryVector: Float32Array;
  topK: number;
  filters?: VectorFilter[];
  metric?: VectorMetric;
}

export interface VectorFilter {
  column: string;
  op: VectorFilterOp;
  value: any;
}

export enum VectorFilterOp {
  EQ = '=',
  NEQ = '!=',
  LT = '<',
  LTE = '<=',
  GT = '>',
  GTE = '>=',
  IN = 'IN',
  LIKE = 'LIKE',
}

export interface VectorSearchResult {
  id: number;
  distance: number;
  metadata?: Record<string, any>;
}

export interface VectorSearchStats {
  mode: VectorMode;
  shardsSearched: number;
  totalCandidates: number;
  searchTimeMs: number;
  postFilterCount: number;
}

// ============================================================
// 5. SQL Query
// ============================================================

export interface SqlQuery {
  originalSql: string;
  rewrittenSql?: string;
  queryType: QueryType;
  hasVectorComponent: boolean;
  tables: string[];
  params?: any[];
}

export enum QueryType {
  SELECT = 'SELECT',
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE',
  CREATE_TABLE = 'CREATE_TABLE',
  CREATE_INDEX = 'CREATE_INDEX',
  ALTER = 'ALTER',
  DDL_OTHER = 'DDL_OTHER',
  VECTOR_SEARCH = 'VECTOR_SEARCH',
  VECTOR_INSERT = 'VECTOR_INSERT',
  UNKNOWN = 'UNKNOWN',
}

// ============================================================
// 6. Replication (EventBus)
// ============================================================

export type MessageType = 'data' | 'ack' | 'sync' | 'sync_reply' | 'ping' | 'pong' | 'election';

export interface TransportMessage {
  msgId: string;
  type: MessageType;
  srcNodeId: string;
  dstNodeId?: string;
  payload: Buffer | string;
  timestamp: number;
  ttl?: number;
  ackMsgId?: string;            // For 'ack' messages
}

// ============================================================
// HLC timestamp type
// ============================================================

export interface HLCTimestamp {
  wall: number;
  logical: number;
  nodeId: number;
}

export interface OutboxEntry {
  msgId: string;
  targetNodeId: string;
  type: string;
  payload: string;
  createdAt: number;
  delivered: boolean;
  deliveredAt?: number;
  acked: boolean;
  ackedAt?: number;
  hlc?: HLCTimestamp;  // optional HLC timestamp for LWW conflict resolution
}

export interface OutboxStats {
  totalPending: number;
  totalDelivered: number;
  totalAcked: number;
  avgDeliveryLatencyMs: number;
}

// ============================================================
// 7. Cluster Config
// ============================================================

export interface ClusterConfig {
  clusterName: string;
  nodeId: string;
  listenHost: string;
  pgPort: number;
  zmqPort: number;              // Inter‑node ZMQ port
  raftPort?: number;            // Optional: Raft consensus port
  datacenter: string;
  shardCount: number;
  replicationFactor: number;
  seedNodes: string[];          // Bootstrap peer addresses
  dataDir: string;
  password?: string;            // Optional: PG Wire password auth
  passwordHash?: string;        // SCRAM-SHA-256 hash (replaces plaintext password)
  authTimeoutMs?: number;       // Auth timeout ms (default: 60000, matching PG default)
  backupDir?: string;           // Backup directory path
  metricsPort?: number;         // Prometheus metrics HTTP port (default: 9464)
  metricsHost?: string;         // Prometheus metrics bind host (default: 127.0.0.1)
  /** Enables follower→leader auto-forward for writes via PG proxy (default: true). */
  autoForward?: boolean;
  /**
   * Explicit PG port mapping: one PG port per seed node entry, in the same order.
   * When provided, used by startConsensusLayer() to compute the raftIndex→PG port map,
   * instead of the fragile basePgPort derivation (which only works when PG ports
   * are sequentially assigned in seed-node order, e.g. for single-machine tests).
   *
   * Example: if seedNodes = ['127.0.0.1:33203','127.0.0.1:40739','127.0.0.1:34409']
   * and pgPorts = [36379, 41199, 41383], then raftIndex 1→36379, 2→41199, 3→41383.
   */
  pgPorts?: number[];
}

export interface TLSConfig {
  /** PEM-encoded certificate content (not file path) */
  cert: string;
  /** PEM-encoded private key content (not file path) */
  key: string;
  /** PEM-encoded CA certificate content (not file path) */
  ca: string;
  /**
   * Force mTLS for PG Wire protocol: require client certificate and reject
   * unauthorized connections. Default: true.
   */
  forceClientCert?: boolean;
}

export interface DatabaseConfig {
  cluster: ClusterConfig;
  vector: VectorConfig;
  replication: ReplicationConfig;
  storage: StorageConfig;
  raft: RaftSnapshotConfig;

  /** Enable single-node embedded mode (no Raft, no replication, 1 shard).
   *  When true, the database starts as a standalone SQLite instance
   *  without distributed consensus or replication overhead.
   *  Default: false. */
  singleNode?: boolean;

  /** Optional TLS configuration for mTLS transport.
   *  If omitted, falls back to SQLVEC_TLS_CERT/KEY/CA env vars. */
  tls?: TLSConfig;

  // New module configs
  logging?: {
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    logFile?: string;
    logFormat?: 'json' | 'pretty';
  };
  healthCheck?: {
    port: number;
    host: string;
  };
  auditLog?: {
    enabled: boolean;
    dbPath: string;
  };
  slowQuery?: {
    enabled: boolean;
    thresholdMs: number;
    dbPath: string;
  };
  statementTimeoutMs?: number;

  /** TDE (Transparent Data Encryption) configuration */
  tde?: TDEConfig;
}

export interface ReplicationConfig {
  enabled: boolean;
  tickMs: number;               // Replication tick interval (default: 500)
  batchSize: number;            // Max events per batch (default: 100)
  ackTimeoutMs: number;         // ACK timeout before retransmit (default: 5000)
  workerCount: number;          // 1 = single-process, >1 = multi-worker
  maxPending: number;           // Max in-flight events per peer
}

export interface StorageConfig {
  shardDir: string;
  walDir: string;
  outboxDir: string;
  lmdbMapSize: number;          // LMDB map size in bytes
  checkpointIntervalMs: number;
}

// ============================================================
// 8. PG Wire Protocol
// ============================================================

export interface PgSessionContext {
  sessionId: string;
  database: string;
  userName: string;
  startTime: number;
  authenticated: boolean;
  transactionStatus: 'idle' | 'in_transaction' | 'failed';
  state: PgSessionState;
  readyForQuery: boolean;
  portalName?: string;
  preparedStatementName?: string;
  params?: any[];
  /** Backend PID for BackendKeyData response (CancelRequest target) */
  backendPid: number;
  /** Secret key for CancelRequest authentication */
  secretKey: number;
}

export enum PgSessionState {
  IDLE = 'idle',
  IN_TRANSACTION = 'in_transaction',
  ERROR = 'error',
}

// ============================================================
// 9. Metrics & Observability
// ============================================================

export interface SystemMetrics {
  queriesPerSecond: number;
  vectorQueriesPerSecond: number;
  avgQueryLatencyMs: number;
  avgVectorLatencyMs: number;
  activeConnections: number;
  shardHealth: Map<number, boolean>;
  replicationLagMs: Map<string, number>;  // peerId → lag
  outboxDepth: number;
  memoryUsageMb: number;
  cpuUsagePercent: number;
}

// ============================================================
// 10. WorkerPool & CURVE
// ============================================================

/**
 * A peer node's connection info, derived from scanning the curveDir.
 */
export interface CurvePeerConfig {
  host: string;
  port: number;
  pubKeyPath?: string;       // Full path to {host}__{port}.pub
  pubKey: string;           // Cached contents of the .pub file
  dealerId: string;         // Unique identifier (host:port or host__port)
}

/**
 * Configuration for a forked OutboxWorker child process.
 */
export interface WorkerPoolConfig {
  workerCount: number;          // 0=disabled, 1=in-process, >1=fork
  nodeDC: string;
  tickMs: number;
  batchSize: number;
  backoff: {
    sameDC: number;
    crossDC: number;
    edge: number;
  };
  dataDir: string;              // Base data directory
  curveDir: string;             // Path to curve directory (peers/*.pub)
  listenerHost: string;         // This node's listen host
  listenerPort: number;         // This node's ZMQ port
  myPublicKey: string;          // This node's CURVE public key
  mySecretKey: string;          // This node's CURVE secret key
}

/**
 * Per-worker LMDB file config (derived from WorkerPoolConfig).
 */
export interface WorkerDbConfig {
  workerId: number;
  targetDCs: string[];
  outboxPath: string;           // LMDB file path for this worker
}

// ============================================================
// 11. Error Types
// ============================================================

// ============================================================
// 12. HNSW Index Configuration
// ============================================================

export interface ProductQuantizationConfig {
  enabled: boolean;
  m: number;              // Number of sub-vectors (default: 8 for 768-dim)
  k: number;              // Number of centroids per sub-space (default: 256)
  numCentroids: number;   // Total centroids = k * m (for test assertions)
  trainSampleSize: number; // Max vectors to sample for training (default: 10000)
}

export const DEFAULT_PQ_CONFIG: ProductQuantizationConfig = {
  enabled: false,
  m: 8,
  k: 256,
  numCentroids: 2048,    // 256 * 8
  trainSampleSize: 10000,
};

export interface HnswConfig {
  m: number;              // Number of connections per element (default 16)
  efConstruction: number; // Dynamic candidate list during construction (default 200)
  efSearch: number;       // Search depth (default 50)
  maxElements: number;    // Max vectors the index can hold (default 1_000_000)
  spaceName?: 'l2' | 'ip'; // hnswlib-node space name ('l2' for L2, 'ip' for cosine/IP)
}

// ============================================================
// 12. ZMQ Configuration (Backpressure)
// ============================================================

export interface ZmqConfig {
  /** High water mark (default 10000). Controls max in-flight messages. */
  hwm: number;
  /** ZMQ_RCVBUF size in bytes (0 = auto by OS). */
  receiveBuffer: number;
  /** ZMQ_SNDBUF size in bytes (0 = auto by OS). */
  sendBuffer: number;
}

// ============================================================
// 13. Circuit Breaker Configuration
// ============================================================

export interface CircuitBreakerConfig {
  /** Action timeout in ms (default: 5000). */
  timeout: number;
  /** Percentage of failures to open circuit (default: 50). */
  errorThresholdPercentage: number;
  /** Reset timeout in ms before half-open (default: 30000). */
  resetTimeout: number;
  /** Maximum number of half-open probe attempts before giving up. */
  maxFailures: number;
}

// ============================================================
// 14. Compression Configuration
// ============================================================

export interface CompressionConfig {
  /** Enable message compression. */
  enabled: boolean;
  /** Minimum message size in bytes to trigger compression (default: 1024). */
  threshold: number;
  /** Compression level (1-22, default: 3 for zstd). */
  level: number;
}

// ============================================================
// 19. Raft Membership & Joint Consensus (C2)
// ============================================================

export interface MembershipChange {
  changeId: string;
  type: 'add' | 'remove' | 'swap';
  nodeId: string;
  oldPeers: string[];
  newPeers: string[];
}

export enum RaftConsensusPhase {
  NORMAL = 'normal',
  TRANSITIONAL = 'transitional',  // Legacy alias — kept for backward compat
  C_JOINT = 'c_joint',           // Phase 1: both old and new configs active
  C_NEW = 'c_new',               // Phase 2: only new config active
}

/** Joint consensus transitional configuration state. */
export interface TransitionalConfig {
  /** Phase 1 — C_JOINT: old+new configs coexist. */
  oldPeers: number[];
  newPeers: number[];
  /** The log index at which the C_JOINT entry was committed.
   *  C_NEW transition triggers once this entry is committed in BOTH configs. */
  jointEntryIndex: number;
  /** The log index at which C_NEW config entry was committed.
   *  Once set, the transition is complete. */
  newEntryIndex: number;
  /** Epoch ms when transitional phase started. */
  startedAt: number;
  /** Timeout ms for the entire transition. */
  timeoutMs: number;
}

// ============================================================
// 20. Learner / Read Replica (C3)
// ============================================================

export interface LearnerInfo {
  nodeId: string;
  shardId: number;
  nextIndex: number;       // Next log index to send
  matchIndex: number;      // Last matched log index
  addedAt: number;         // Epoch ms when learner was added
  lastHeartbeat: number;   // Epoch ms of last contact
}

// ============================================================
// 21. Leader Transfer (C4)
// ============================================================

export interface LeaderTransferResult {
  success: boolean;
  newLeader: string | null;
  durationMs: number;
  error?: string;
}

// ============================================================
// 22. Pipeline Replication (C5)
// ============================================================

export interface PipelineConfig {
  /** Max entries per batch flush (default: 10). */
  batchSize: number;
  /** Max interval between flushes in ms (default: 50). */
  batchIntervalMs: number;
  /** Max pipeline queue depth before backpressure kicks in (default: 1000). */
  maxPipelineQueueSize?: number;
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  batchSize: 10,
  batchIntervalMs: 50,
  maxPipelineQueueSize: 1000,
};

export interface PipelinedEntry {
  index: number;
  term: number;
  data: string;
  flushed: boolean;
  acknowledged: boolean;
  sentAt: number;
}

export class SqlVecError extends Error {
  constructor(
    message: string,
    public code: SqlVecErrorCode,
    public details?: any,
  ) {
    super(message);
    this.name = 'SqlVecError';
  }
}

export enum SqlVecErrorCode {
  SHARD_UNAVAILABLE = 'SHARD_UNAVAILABLE',
  VECTOR_DIMENSION_MISMATCH = 'VECTOR_DIMENSION_MISMATCH',
  VECTOR_INDEX_NOT_FOUND = 'VECTOR_INDEX_NOT_FOUND',
  QUERY_ROUTING_FAILED = 'QUERY_ROUTING_FAILED',
  REPLICATION_TIMEOUT = 'REPLICATION_TIMEOUT',
  NODE_NOT_FOUND = 'NODE_NOT_FOUND',
  CONSENSUS_FAILED = 'CONSENSUS_FAILED',
  CONFIG_ERROR = 'CONFIG_ERROR',
  PROTOCOL_ERROR = 'PROTOCOL_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NOT_LEADER = 'NOT_LEADER',
  TRANSACTION_ERROR = 'TRANSACTION_ERROR',
}

// ============================================================
// 23. Flexible Quorum (E3)
// ============================================================

export interface FlexibleQuorumConfig {
  /** Number of acknowledgments needed for writes. Default: majority (Math.floor(n/2)+1). */
  writeQuorum: number;
  /** Number of acknowledgments needed for stale reads. Default: 1. */
  readQuorum: number;
  /** Number of acknowledgments needed for linearizable (commit) reads. Default: majority. */
  commitQuorum: number;
}

/**
 * Calculate majority quorum size for a given total node count.
 * Majority = floor(n/2) + 1
 */
export function majorityQuorum(total: number): number {
  return Math.floor(total / 2) + 1;
}

/**
 * Apply quorum config defaults for a given total node count:
 * - writeQuorum defaults to majority
 * - readQuorum defaults to 1
 * - commitQuorum defaults to majority
 */
export function resolveFlexibleQuorumConfig(
  config?: Partial<FlexibleQuorumConfig>,
  total: number = 5,
): FlexibleQuorumConfig {
  const majority = majorityQuorum(total);
  return {
    writeQuorum: config?.writeQuorum ?? majority,
    readQuorum: config?.readQuorum ?? 1,
    commitQuorum: config?.commitQuorum ?? majority,
  };
}

// ============================================================
// 12. Transaction Support (B4)
// ============================================================

/**
 * Serializable transaction isolation type.
 */
export enum TransactionIsolation {
  SERIALIZABLE = 'SERIALIZABLE',
  REPEATABLE_READ = 'REPEATABLE_READ',
  READ_COMMITTED = 'READ_COMMITTED',
  READ_UNCOMMITTED = 'READ_UNCOMMITTED',
}

// ============================================================
// 13. Sequence / AUTOINCREMENT (I2)
// ============================================================

/**
 * Sequence definition for SERIAL emulation.
 */
export interface SequenceDefinition {
  name: string;
  value: number;
  increment: number;
  minValue?: number;
  maxValue?: number;
  isCyclic?: boolean;
}

/**
 * System tables used for sequence tracking.
 */
export const SYSTEM_SEQUENCE_TABLE = '__sequences';
export const SYSTEM_SEQUENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS __sequences (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0,
  increment INTEGER NOT NULL DEFAULT 1,
  min_value INTEGER DEFAULT 1,
  max_value INTEGER,
  is_cyclic INTEGER DEFAULT 0
);

INSERT OR IGNORE INTO __sequences (name, value, increment)
VALUES ('_default_sequence', 0, 1);
`;

// ============================================================
// 11.5 Shared Transport (NodeTransport interface)
// ============================================================

/** Shared node-level transport interface used by all RaftAdapters */
export interface SharedTransport {
  /** Raft node ID of this node */
  nodeId: number;
  /** Send messages from a Raft group. All groups share one transport. */
  send(fromId: string, msgs: any[]): Promise<void>;
  /** Register a handler for incoming messages by shardId */
  onMessage(handler: (shardId: number, msg: any) => void): void;
  /** Remove message handler */
  offMessage(handler: (shardId: number, msg: any) => void): void;
  /**
   * Create a per-shard send wrapper that embeds shardId in outgoing messages.
   * Each RaftGroup gets its own wrapper via forShard(this.shardId).
   */
  forShard?(shardId: number): { send(fromId: string | number, msgs: any[]): Promise<void> };
}

// ============================================================
// 12. Raft Snapshot Config
// ============================================================

export interface RaftSnapshotConfig {
  /** Custom path for Raft log persistence (SQLite file). Falls back to default if unset. */
  storagePath?: string;
  /** Create snapshot every N committed entries. 0 = disabled. Default: 100. */
  snapshotInterval: number;
  /** Max log entries before forced compaction. 0 = no limit. */
  maxLogEntries: number;
}

/**
 * TDE (Transparent Data Encryption) configuration.
 *
 * When enabled (and TDE_MASTER_KEY env var is set), shard database files
 * are encrypted with full-file AES-256-GCM on close and decrypted on open.
 */
export interface TDEConfig {
  /** Enable full-file AES-256-GCM encryption on shard databases */
  enabled: boolean;
  /** Optional directory for temporary decrypted files (defaults to shardDir) */
  tempDir?: string;
}

// ============================================================
// 13. TLS / SCRAM / PgWire Auth
// ============================================================

export interface TlsConfig {
  /** Path to TLS certificate file (PEM). */
  cert: string;
  /** Path to TLS private key file (PEM). */
  key: string;
  /** Optional CA certificate for client certificate verification. */
  ca?: string;
  /** Request client certificate. Default: false. */
  requestCert?: boolean;
  /**
   * Force mTLS: require client certificate and reject unauthorized.
   * When true, sets requestCert=true and rejectUnauthorized=true on the TLS socket.
   * Default: true.
   */
  forceClientCert?: boolean;

  // ── TLS-01: Cipher suite & version configuration ──
  /** Minimum TLS version. Default: 'TLSv1.2'. */
  minVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  /** Maximum TLS version. Default: 'TLSv1.3'. */
  maxVersion?: 'TLSv1' | 'TLSv1.1' | 'TLSv1.2' | 'TLSv1.3';
  /**
   * Allowed cipher suites in OpenSSL format.
   * Default: Node.js default (strong ciphers only in TLSv1.3).
   * TLSv1.3 cipher suites are fixed by the protocol and cannot be overridden.
   * For TLSv1.2, recommended: HIGH:!aNULL:!eNULL:!EXPORT:!DES:!MD5:!PSK:!RC4
   */
  cipherSuites?: string;
  /**
   * ECDH curve name for ECDHE key exchange. Default: 'auto' (Node.js selects best).
   * Common values: 'prime256v1', 'secp384r1', 'X25519'.
   */
  ecdhCurve?: string;
  /**
   * Enable session resumption. Default: false.
   * Reduces handshake overhead for repeated connections.
   */
  sessionResumption?: boolean;
  /**
   * Session timeout in seconds for session resumption (default: 300 = 5 min).
   */
  sessionTimeout?: number;
}

// ============================================================
// 16. Shard Rebalancer (E1)
// ============================================================

export interface RebalanceConfig {
  /** Enable automatic rebalancing. Default: false. */
  enabled: boolean;
  /** Interval in ms between rebalance checks. Default: 60000. */
  intervalMs: number;
  /** Max difference in shard counts between most- and least-loaded node. Default: 2. */
  threshold: number;
}

// ============================================================
// 17. Graceful Shutdown (E2)
// ============================================================

export type ShutdownPhase =
  | 'idle'
  | 'stopping_connections'      // Phase 1: stop accepting new connections
  | 'draining_queries'           // Phase 2: drain in-flight queries
  | 'transferring_leadership'    // Phase 3: transfer Raft leadership
  | 'flushing_outbox'            // Phase 4: flush pending outbox entries
  | 'checkpoint_wal'             // Phase 4b: WAL checkpoint
  | 'stopping_data_bridge'       // Phase 4c: stop DataBridge
  | 'closing_connections'        // Phase 5: close remaining connections and cleanup
  | 'completed'
  | 'failed';

export interface ShutdownStatus {
  phase: ShutdownPhase;
  startedAt: number;
  completedAt?: number;
  error?: string;
  /** How long the phase took (ms). Only present for completed phases. */
  phaseDurationsMs?: Record<string, number>;
}

// ============================================================
// 18. Outbox Backpressure Configuration (H2)
// ============================================================

export interface OutboxBackpressureConfig {
  /** Free-space threshold as fraction of mapSize (default: 0.10 = 10%). */
  threshold: number;
  /** Low watermark as fraction of mapSize (default: 0.05 = 5%). Once drain brings free space above this, writes resume. */
  lowWatermark: number;
  /** Max time to wait for drain in ms (default: 30000). */
  drainTimeoutMs: number;
}

// ============================================================
// 18. Active Query / pg_stat_activity (Track G)
// ============================================================

/**
 * Schema for a currently executing query — mirrors pg_stat_activity.
 */
export interface ActiveQuery {
  queryId: string;
  sql: string;
  userId: string;
  database: string;
  state: 'active' | 'idle' | 'idle in transaction';
  queryStart: number;      // epoch ms
  clientAddr: string;
}

// ============================================================
// 19. Slow Query Config (Track G)
// ============================================================

export interface SlowQueryConfig {
  /** Threshold in ms above which a query is considered "slow". Default: 100. */
  thresholdMs: number;
  /** Max SQL length to log. Default: 200. */
  maxSqlLength: number;
  /** Log level for slow queries. Default: 'warn'. */
  logLevel: 'warn' | 'info' | 'debug';
}

export const DEFAULT_SLOW_QUERY_CONFIG: SlowQueryConfig = {
  thresholdMs: 500,
  maxSqlLength: 200,
  logLevel: 'warn',
};

// ============================================================
// 25. Gossip Failure Detection
// ============================================================

export interface GossipNode {
  nodeId: string;
  host: string;
  port: number;
  incarnation: number;
  state: GossipNodeState;
  lastContact: number;
  meta?: Record<string, string>;
}

export enum GossipNodeState {
  ALIVE = 'alive',
  SUSPECT = 'suspect',
  DEAD = 'dead',
}

export interface GossipConfig {
  /** Interval between gossip rounds in ms (default: 1000). */
  gossipIntervalMs: number;
  /** Number of nodes to ping per round (default: 3). */
  fanout: number;
  /** Max time in ms without contact before suspect (default: 5000). */
  suspectTimeoutMs: number;
  /** Max time in ms in suspect state before declaring dead (default: 15000). */
  deadTimeoutMs: number;
  /** Protocol type (default: 'swim'). */
  protocol: 'swim';
}

export const DEFAULT_GOSSIP_CONFIG: GossipConfig = {
  gossipIntervalMs: 1000,
  fanout: 3,
  suspectTimeoutMs: 5000,
  deadTimeoutMs: 15000,
  protocol: 'swim',
};

// ============================================================
// 26. Adaptive Election Timeout
// ============================================================

export interface AdaptiveElectionConfig {
  /** Base election tick count (default: 10). */
  baseElectionTick: number;
  /** Tick interval in ms (default: 100). */
  tickIntervalMs: number;
  /** Minimum election tick (default: 5). */
  minTick: number;
  /** Maximum election tick (default: 20). */
  maxTick: number;
  /** Number of RTT samples to keep for moving average (default: 10). */
  rttSampleWindow: number;
  /** How often to recalculate timeout in ms (default: 5000). */
  recalculationIntervalMs: number;
  /** Multiplier for RTT → election tick conversion (default: 5). */
  rttMultiplier: number;
}

export const DEFAULT_ADAPTIVE_ELECTION_CONFIG: AdaptiveElectionConfig = {
  baseElectionTick: 10,
  tickIntervalMs: 100,
  minTick: 5,
  maxTick: 20,
  rttSampleWindow: 10,
  recalculationIntervalMs: 5000,
  rttMultiplier: 5,
};

// ============================================================
// 27. InstallSnapshot RPC
// ============================================================

export interface InstallSnapshotRequest {
  /** Leader's term. */
  term: string;
  /** ID of the leader. */
  leaderId: string;
  /** The snapshot terminates all log entries up through this index. */
  lastIncludedIndex: string;
  /** Term of lastIncludedIndex. */
  lastIncludedTerm: string;
  /** Offset in bytes where this chunk starts. */
  offset: number;
  /** Raw snapshot data chunk. */
  data: Uint8Array;
  /** True if this is the last chunk. */
  done: boolean;
}

export interface InstallSnapshotResponse {
  /** Current term, for leader to update itself. */
  term: string;
}

// ============================================================
// 28. CDC (Change Data Capture)
// ============================================================

export interface ChangeRecord {
  shardId: number;
  table: string;
  operation: 'insert' | 'update' | 'delete';
  before?: Record<string, any>;
  after?: Record<string, any>;
  timestamp: string;
  seq: number;
  transactionId?: string;
}

export interface CDCConfig {
  /** Enable CDC capture (default: false). */
  enabled: boolean;
  /** Tables to capture (empty = all). */
  tables: string[];
  /** Output to EventBus (default: true). */
  outputEventBus: boolean;
  /** Max change records in buffer before flush (default: 100). */
  batchSize: number;
  /** Flush interval in ms (default: 1000). */
  flushIntervalMs: number;
}

// ============================================================
// 29. Replication Lag Monitor
// ============================================================

export interface ReplicaLagStats {
  shardId: number;
  nodeId: number;
  commitIndex: number;
  appliedIndex: number;
  lastLogIndex: number;
  outboxPending: number;
  outboxOldestMs: number;
  pipelineDepth: number;
  lagEntries: number;
  lagMs: number;
}

// ============================================================
// 30. Clock Error Compensation
// ============================================================

export interface ClockErrorStats {
  /** Expected max clock drift in ms (default: 200). */
  maxDriftMs: number;
  /** Current estimated drift from peers (ms). */
  estimatedDriftMs: number;
  /** Number of samples collected. */
  samples: number;
  /** Last synchronization timestamp. */
  lastSync: number;
}

// ============================================================
// 31. Rolling Upgrade
// ============================================================

export interface RollingUpgradeStatus {
  nodeId: string;
  phase: RollingUpgradePhase;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export enum RollingUpgradePhase {
  PENDING = 'pending',
  DRAINING = 'draining',
  LEADERSHIP_TRANSFER = 'leadership_transfer',
  UPGRADING = 'upgrading',
  REJOINING = 'rejoining',
  ROLLING_BACK = 'rolling_back',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

// ============================================================
// 32. Auto Replica Repair
// ============================================================

export interface AutoRepairConfig {
  /** Enable automatic repair (default: false). */
  enabled: boolean;
  /** Interval between consistency checks in ms (default: 60000). */
  checkIntervalMs: number;
  /** Max entries to repair in a single batch (default: 100). */
  batchSize: number;
}

export const DEFAULT_AUTO_REPAIR_CONFIG: AutoRepairConfig = {
  enabled: false,
  checkIntervalMs: 60000,
  batchSize: 100,
};

// ============================================================
// 33. Safe Scaling / Membership Change V2
// ============================================================

export interface ScaleRequest {
  operation: 'add' | 'remove';
  nodeId: string;
  nodeHost?: string;
  nodePort?: number;
  peerIds: string[];
}

export interface ScaleResult {
  success: boolean;
  error?: string;
  affectedGroups: number[];
  durationMs: number;
}

// ============================================================
// 34. Global Consistent Backup
// ============================================================

export interface GlobalBackupRequest {
  backupId: string;
  timestamp: number;
  shardIds: number[];
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  error?: string;
}

// ============================================================
// 35. Stream Mux Frame
// ============================================================

export interface StreamMuxFrame {
  streamId: number;
  flags: number; // 0x01=SYN, 0x02=ACK, 0x04=FIN, 0x08=RST
  shardId: number;
  payload: Buffer;
}
