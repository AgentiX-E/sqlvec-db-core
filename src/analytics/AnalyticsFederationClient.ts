import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('AnalyticsFederationClient');

/**
 * AnalyticsFederationClient — unified entry point for distributed analytics
 *
 * Manages a priority-ordered pool of FederationStrategy instances and
 * automatically selects the best available strategy for each query.
 *
 * Architecture:
 *   - Strategies registered in priority order (lower = preferred)
 *   - `available()` result cached with 30s TTL per strategy
 *   - `warmup()` pre-checks all strategies in background
 *   - `executeDistributed(sql)` selects best strategy and runs query
 */
import type { DuckDBResult } from './DuckDBAnalyticsManager';
import type { DuckDBAnalyticsManager } from './DuckDBAnalyticsManager';
import type { FederationStrategy, HttpfsConfig, NodeTransportConfig } from './strategies/FederationStrategy';
import { LocalColumnarStrategy } from './strategies/LocalColumnarStrategy';
import { HttpfsStrategy } from './strategies/HttpfsStrategy';
import { NodeTransportStrategy } from './strategies/NodeTransportStrategy';

export interface AnalyticsFederationConfig {
  /** Enable local columnar strategy (default: true) */
  localColumnar?: boolean;

  /** Shared storage config (Layer 1, not yet implemented) */
  sharedStorage?: {
    enabled: boolean;
    mountPoint: string;
  };

  /** S3/httpfs Parquet config (Layer 2) */
  httpfs?: HttpfsConfig & { enabled: boolean };

  /** Remote node execution config (Layer 3) */
  nodeTransport?: NodeTransportConfig & { enabled: boolean };
}

export class AnalyticsFederationClient {
  private readonly strategies: FederationStrategy[] = [];
  private strategyCache = new Map<string, { available: boolean; at: number }>();
  private readonly CACHE_TTL = 30_000; // 30 seconds

  constructor(
    private readonly duckDB: DuckDBAnalyticsManager,
    config?: AnalyticsFederationConfig,
  ) {
    // Layer 0: local columnar (always available, lowest latency)
    if (!config || config.localColumnar !== false) {
      this.strategies.push(new LocalColumnarStrategy(duckDB));
    }

    // Layer 1: shared storage (ATTACH) — TODO
    // (requires NFS/EFS mount point, implementation pending)

    // Layer 2: httpfs Parquet
    if (config?.httpfs?.enabled) {
      const { enabled: _e, ...hfsConfig } = config.httpfs;
      this.strategies.push(new HttpfsStrategy(duckDB, hfsConfig));
    }

    // Layer 3: node transport (fallback)
    if (config?.nodeTransport?.enabled) {
      const { enabled: _e, ...ntConfig } = config.nodeTransport;
      this.strategies.push(new NodeTransportStrategy(duckDB, ntConfig));
    }

    // If no user strategies, fallback to local only
    if (this.strategies.length === 0) {
      this.strategies.push(new LocalColumnarStrategy(duckDB));
    }

    // Sort by priority (ascending)
    this.strategies.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Execute a query using the best available strategy.
   * Checks each strategy in priority order, testing availability.
   */
  async executeDistributed(sql: string): Promise<DuckDBResult> {
    const strategy = await this.findBestStrategy();
    if (!strategy) {
      throw new Error('No analytics federation strategy available');
    }
    console.debug('[FederationClient] Executing via strategy:', strategy.name);
    return strategy.execute(sql);
  }

  /**
   * Find the highest-priority strategy that is currently available.
   * Results are cached for CACHE_TTL to avoid repeated calls.
   */
  private async findBestStrategy(): Promise<FederationStrategy | null> {
    for (const strategy of this.strategies) {
      const cached = this.strategyCache.get(strategy.name);
      if (cached && (Date.now() - cached.at) < this.CACHE_TTL) {
        if (cached.available) return strategy;
        continue;
      }

      try {
        const available = await strategy.available();
        this.strategyCache.set(strategy.name, { available, at: Date.now() });
        if (available) return strategy;
      } catch (err) {
        logger.warn('[FederationClient] Strategy available() threw: %s %o', strategy.name, err);
        this.strategyCache.set(strategy.name, { available: false, at: Date.now() });
      }
    }
    return null;
  }

  /**
   * Pre-warm all strategies in background.
   * Call during startup/idle to avoid first-query latency.
   */
  async warmup(): Promise<void> {
    await Promise.all(
      this.strategies.map(async (s) => {
        try {
          const available = await s.available();
          this.strategyCache.set(s.name, { available, at: Date.now() });
          console.debug('[FederationClient] warmup complete:', s.name, available);
        } catch {
          // Silent — warmup failures are non-critical
        }
      }),
    );
  }

  /**
   * Force invalidate the strategy availability cache.
   * Useful after a network recovery or storage mount event.
   */
  invalidateCache(): void {
    this.strategyCache.clear();
  }

  /**
   * Register a table name with strategies that need it (e.g., HttpfsStrategy).
   * Called by DataBridge when new OLAP tables are created.
   */
  registerTable(tableName: string): void {
    for (const s of this.strategies) {
      if (s instanceof HttpfsStrategy) {
        s.registerTable(tableName);
      }
    }
  }

  /** Get the list of registered strategies (for diagnostics) */
  getStrategies(): ReadonlyArray<{ name: string; priority: number }> {
    return this.strategies.map(s => ({ name: s.name, priority: s.priority }));
  }

  /** Check if any strategy is available (lightweight) */
  async isDistributedAvailable(): Promise<boolean> {
    const strategy = await this.findBestStrategy();
    return strategy !== null;
  }
}
