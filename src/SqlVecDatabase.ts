import { ILogger, NoOpLogger } from './interfaces/logger';
import { DatabaseConfig } from './types/types-raw';
import { PinoLogger } from './logger/PinoLogger';
import { ShardManager } from './storage/ShardManager';
import { DuckDBAnalyticsManager, getDuckDBAnalyticsManager } from './analytics/DuckDBAnalyticsManager';
import { DataBridge, DEFAULT_DATA_BRIDGE_CONFIG } from './analytics/DataBridge';
import { OLAPSchemaManager } from './analytics/OLAPSchemaManager';
import { VectorEngine } from './vector/VectorEngine';
import { QueryRouter } from './query/QueryRouter';
import { TDEEngine } from './tde/TDEEngine-file';
import { TDEConfig } from './tde/TDEConfig';

export class SqlVecDatabase {
  private logger: ILogger;
  private config: any;
  private shardManager: any;
  private duckDBAnalytics: any;
  private dataBridge: any;
  private vectorEngine: any;
  private queryRouter: any;

  constructor(config: any) {
    this.config = config;
    this.logger = new PinoLogger({ name: 'sqlvec-db' });
  }

  async start(): Promise<void> {
    this.logger.info('[SqlVec] Starting embedded HTAP engine...');
    
    const dataDir = this.config.dataDir || this.config.cluster?.dataDir || '/tmp/sqlvec-data';
    const shardCount = this.config.shardCount || 4;

    if (this.config.tde?.enabled) await this.initTDE();
    
    this.shardManager = new ShardManager(dataDir, this.config.vector || {});
    await this.shardManager.initialize(shardCount);
    
    this.duckDBAnalytics = getDuckDBAnalyticsManager(`${dataDir}/duckdb_analytics.db`);
    await this.duckDBAnalytics.init();
    if (this.duckDBAnalytics.isAvailable) await this.duckDBAnalytics.setMemoryLimit(2048);
    
    const olapSchemaManager = new OLAPSchemaManager(this.duckDBAnalytics);
    this.dataBridge = new DataBridge(this.duckDBAnalytics, olapSchemaManager, this.shardManager, DEFAULT_DATA_BRIDGE_CONFIG);
    this.dataBridge.start().catch((e: any) => this.logger.error({ err: e?.message }, 'DataBridge start failed'));
    
    if (this.config.vector?.enabled !== false) {
      this.vectorEngine = new VectorEngine(this.shardManager, this.config.vector || { dimension: 768, mode: 'auto' as any }, dataDir);
      await this.vectorEngine.initialize();
    }
    
    this.queryRouter = new QueryRouter(this.shardManager, this.vectorEngine, this.config.vector || { dimension: 768, mode: 'auto' });
    this.logger.info('[SqlVec] Started');
  }

  async query(sql: string, params?: any[]): Promise<any> { return this.queryRouter.execute(sql, params); }
  async stop(): Promise<void> {
    this.dataBridge?.stop(); this.vectorEngine?.close(); 
    this.duckDBAnalytics?.close(); this.shardManager?.close();
  }
  private async initTDE(): Promise<void> { /* stub */ }
}
export default SqlVecDatabase;
