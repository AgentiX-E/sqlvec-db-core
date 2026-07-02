/**
 * SqlVec DB — Embedded HTAP Database Engine
 *
 * Minimal entry point for embedded (single-node) deployment.
 * Provides OLTP (SQLite) + OLAP (DuckDB) with 100ms DataBridge CDC sync.
 * No network, no auth, no consensus — pure in-process HTAP database.
 *
 * @module SqlVecDatabase
 */

import { ILogger } from './interfaces/logger';
import { IShardManager, IShardReplica } from './interfaces/storage';
import { IConsensusLayer } from './interfaces/consensus';
import { DatabaseConfig } from './types';

// Foundation
import { PinoLogger } from './logger/PinoLogger';

// Storage
import { ShardManager } from './storage/ShardManager';
import { ShardReplica } from './storage/ShardReplica';

// Analytics (DuckDB + DataBridge)
import { 
  DuckDBAnalyticsManager, 
  getDuckDBAnalyticsManager 
} from './analytics/DuckDBAnalyticsManager';
import { DataBridge, DEFAULT_DATA_BRIDGE_CONFIG } from './analytics/DataBridge';
import { OLAPSchemaManager } from './analytics/OLAPSchemaManager';

// Vector
import { VectorEngine } from './vector/VectorEngine';

// Query
import { QueryRouter } from './query/QueryRouter';

// TDE
import { TDEEngine } from './tde/TDEEngine-file';
import { TDEConfig } from './tde/TDEConfig';

export class SqlVecDatabase {
  private logger: ILogger;
  private config: DatabaseConfig;
  
  // Core subsystems
  private shardManager!: IShardManager;
  private shardReplicas: Map<number, IShardReplica> = new Map();
  private duckDBAnalytics!: DuckDBAnalyticsManager;
  private olapSchemaManager!: OLAPSchemaManager;
  private dataBridge!: DataBridge;
  private vectorEngine?: VectorEngine;
  private queryRouter!: QueryRouter;
  
  // Optional subsystems
  private tdeEngine?: TDEEngine;
  private tdeEnabled: boolean = false;

  constructor(config: DatabaseConfig) {
    this.config = config;
    this.logger = new PinoLogger({ name: 'sqlvec-db' });
    
    // Lazy-init subsystems in start()
  }

  /** Start the database engine */
  async start(): Promise<void> {
    this.logger.info('[SqlVec] Starting embedded HTAP engine...');

    // 1. Initialize TDE if enabled
    if (this.config.tde?.enabled) {
      await this.initTDE();
    }

    // 2. Initialize storage (OLTP engine — SQLite shards)
    await this.initStorage();

    // 3. Initialize analytics (OLAP engine — DuckDB + DataBridge CDC)
    await this.initAnalytics();

    // 4. Initialize vector engine (HNSW + brute-force)
    await this.initVector();

    // 5. Initialize query router
    await this.initQuery();

    this.logger.info('[SqlVec] Embedded HTAP engine started successfully');
  }

  /** Execute a SQL query */
  async query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    return this.queryRouter.execute(sql, params);
  }

  /** Stop the database engine */
  async stop(): Promise<void> {
    this.logger.info('[SqlVec] Stopping...');
    
    if (this.dataBridge) {
      await this.dataBridge.stop();
    }
    if (this.vectorEngine) {
      await this.vectorEngine.close();
    }
    if (this.duckDBAnalytics) {
      await this.duckDBAnalytics.close();
    }
    if (this.shardManager) {
      await this.shardManager.close();
    }
    
    this.logger.info('[SqlVec] Stopped');
  }

  // ── Private Init Methods ──

  private async initTDE(): Promise<void> {
    const tdeConfig = TDEConfig.loadFromEnv();
    if (tdeConfig.enabled && tdeConfig.key) {
      this.tdeEngine = new TDEEngine({
        algorithm: tdeConfig.algorithm,
        keyDerivation: 'direct',
        keySource: tdeConfig.key,
      });
      await this.tdeEngine.deriveKey();
      this.tdeEnabled = true;
      this.logger.info('[SqlVec] TDE encryption enabled');
    }
  }

  private async initStorage(): Promise<void> {
    const storageDir = this.config.dataDir || '/tmp/sqlvec-data';
    const shardCount = this.config.shardCount || 4;

    this.shardManager = new ShardManager({
      storageDir,
      vectorConfig: this.config.vector,
      tdeEnabled: this.tdeEnabled,
      tdeEngine: this.tdeEngine,
    });

    await this.shardManager.initialize(shardCount);

    // Track replicas
    for (const shardId of this.shardManager.getShardIds()) {
      const shard = this.shardManager.getShard(shardId);
      if (shard) this.shardReplicas.set(shardId, shard);
    }

    this.logger.info(`[SqlVec] Storage initialized: ${shardCount} shard(s)`);
  }

  private async initAnalytics(): Promise<void> {
    // DuckDB analytics engine
    this.duckDBAnalytics = getDuckDBAnalyticsManager(
      `${this.config.dataDir || '/tmp/sqlvec-data'}/duckdb_analytics.db`
    );
    await this.duckDBAnalytics.init();

    if (this.duckDBAnalytics.isAvailable) {
      await this.duckDBAnalytics.setMemoryLimit(2048);
      // Attach all shards
      for (const shardId of this.shardManager.getShardIds()) {
        const shard = this.shardManager.getShard(shardId);
        if (shard?.path) {
          await this.duckDBAnalytics.attachShard(shardId, shard.path);
        }
      }
    }

    // OLAP schema manager
    this.olapSchemaManager = new OLAPSchemaManager(this.duckDBAnalytics);

    // DataBridge: OLTP→OLAP real-time CDC (100ms tick)
    this.dataBridge = new DataBridge(
      this.duckDBAnalytics,
      this.olapSchemaManager,
      this.shardManager as any, // TODO: IShardManager→ShardManager cast during transition
      DEFAULT_DATA_BRIDGE_CONFIG
    );

    this.dataBridge.start().catch((err: Error) => {
      this.logger.error({ err: err.message }, '[SqlVec] DataBridge start failed');
    });

    this.logger.info(`[SqlVec] Analytics initialized (${this.duckDBAnalytics.availability})`);
  }

  private async initVector(): Promise<void> {
    if (this.config.vector?.enabled !== false) {
      this.vectorEngine = new VectorEngine(
        this.shardManager as any, // TODO: IShardManager cast during transition
        this.config.vector || { dimension: 768, mode: 'auto' as const }
      );
      await this.vectorEngine.initialize();
      this.logger.info('[SqlVec] Vector engine initialized');
    }
  }

  private async initQuery(): Promise<void> {
    this.queryRouter = new QueryRouter(
      this.shardManager as any, // TODO: cast during transition
      this.vectorEngine,
      this.config.vector || { dimension: 768, mode: 'auto' as const },
      undefined as any, // consensus = undefined for embedded
      this.config.vector, // double config — matching original signature
    );
    this.logger.info('[SqlVec] Query router initialized');
  }
}

export default SqlVecDatabase;
