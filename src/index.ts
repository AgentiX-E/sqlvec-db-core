/**
 * SqlVec DB — Core (Public API)
 *
 * @agentix-e/sqlvec-db-core
 * Embeddable HTAP database engine.
 */

// Main entry
export { SqlVecDatabase } from './SqlVecDatabase';

// Foundation
export { ILogger, NoOpLogger } from './interfaces/logger';
export { 
  IShardManager, IShardReplica, IShardSource,
  QueryResult, ApplyEntry, ShardStats 
} from './interfaces/storage';
export { IConsensusLayer, IClusterTopology } from './interfaces/consensus';
export { DatabaseConfig, FeatureFlags } from './types';

// Storage
export { ShardManager } from './storage/ShardManager';
export { ShardReplica } from './storage/ShardReplica';

// Analytics
export { DuckDBAnalyticsManager, getDuckDBAnalyticsManager } from './analytics/DuckDBAnalyticsManager';
export { DataBridge } from './analytics/DataBridge';

// Vector
export { VectorEngine } from './vector/VectorEngine';
