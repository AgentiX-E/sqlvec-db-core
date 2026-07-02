/**
 * AutovacuumDaemon — Background VACUUM & ANALYZE scheduler for SQLite.
 *
 * Mirrors PostgreSQL's autovacuum behavior:
 * - Periodically checks for tables needing VACUUM (dead tuple threshold)
 * - Periodically checks for tables needing ANALYZE (modify threshold)
 * - Maintains a configurable worker pool (maxConcurrent = maxWorkers)
 * - Tracks approximate dead tuple counts via mutation callbacks
 *
 * The daemon is designed to be wired into QueryRouter and uses
 * OpsCommands for the actual SQLite VACUUM/ANALYZE execution.
 *
 * ## Threshold formula (PG-compatible):
 * - n_dead_tup > autovacuum_vacuum_threshold + autovacuum_vacuum_scale_factor * n_live_tup
 * - n_mod_since_analyze > autovacuum_analyze_threshold + autovacuum_analyze_scale_factor * n_live_tup
 *
 * ## SQLite specifics:
 * - ANALYZE is followed by `PRAGMA optimize` for statistics updates
 * - Full VACUUM is used sparingly (only when freezeMaxAge is exceeded)
 * - Normal VACUUM uses incremental_vacuum + PRAGMA optimize
 *
 * @module AutovacuumDaemon
 */

import { PinoLogger } from '../monitoring/PinoLogger';
import { OpsCommands } from '../ops/OpsCommands';
import { MvccVacuum } from './MvccVacuum';
import type Database from 'better-sqlite3';
import type { MVCCExecutor } from './MVCCExecutor';

// ──────────────────────────────────────────────
//  Types & Defaults
// ──────────────────────────────────────────────

export interface AutovacuumConfig {
  /** Enable background autovacuum daemon (default: true) */
  enabled: boolean;
  /** Minimum number of dead tuples before VACUUM (PG: autovacuum_vacuum_threshold) */
  vacuumThreshold: number;
  /** Scale factor for dead tuple threshold (PG: autovacuum_vacuum_scale_factor) */
  vacuumScaleFactor: number;
  /** Minimum number of tuple modifications before ANALYZE (PG: autovacuum_analyze_threshold) */
  analyzeThreshold: number;
  /** Scale factor for analyze threshold (PG: autovacuum_analyze_scale_factor) */
  analyzeScaleFactor: number;
  /** Maximum concurrent VACUUM worker processes (PG: autovacuum_max_workers) */
  maxWorkers: number;
  /** How often to check for vacuum-worthy tables, in ms (default: 60000) */
  checkIntervalMs: number;
  /** Vacuum cost limit (PG: autovacuum_vacuum_cost_limit), used to throttle */
  vacuumCostLimit: number;
  /** Max age before forcing full VACUUM FREEZE (PG: autovacuum_freeze_max_age) */
  freezeMaxAge: number;
}

export const DEFAULT_AUTOVACUUM_CONFIG: AutovacuumConfig = {
  enabled: true,
  vacuumThreshold: 50,
  vacuumScaleFactor: 0.2,
  analyzeThreshold: 50,
  analyzeScaleFactor: 0.1,
  maxWorkers: 3,
  checkIntervalMs: 60000,
  vacuumCostLimit: 200,
  freezeMaxAge: 200000,
};

/**
 * Per-table statistics tracked by the autovacuum daemon.
 */
export interface TableStats {
  /** Table name */
  tableName: string;
  /** Estimated number of live tuples */
  nLiveTup: number;
  /** Estimated number of dead (deleted/updated) tuples */
  nDeadTup: number;
  /** Number of modifications since last ANALYZE */
  nModSinceAnalyze: number;
  /** Timestamp of last VACUUM (epoch ms) */
  lastVacuumTime: number;
  /** Timestamp of last ANALYZE (epoch ms) */
  lastAnalyzeTime: number;
  /** Schema name (defaults to 'public') */
  schemaName: string;
}

// ──────────────────────────────────────────────
//  AutovacuumDaemon
// ──────────────────────────────────────────────

export class AutovacuumDaemon {
  private config: AutovacuumConfig;
  private logger: PinoLogger;
  private ops: OpsCommands;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Per-table statistics */
  private tableStats: Map<string, TableStats> = new Map();

  /** Active worker count (running VACUUM/ANALYZE operations) */
  private activeWorkers: number = 0;

  /** Whether the daemon is currently running the check cycle */
  private cycleInProgress: boolean = false;

  /** Map of shard database connections (shardId -> Database) */
  private shardDbs: Map<number, Database.Database> = new Map();

  /** MvccVacuum for MVCC-aware space reclamation */
  private mvccVacuum: MvccVacuum | null = null;

  /** Cycle counter for periodic maintenance tasks */
  private cycleCount: number = 0;

  /** WAL size threshold in bytes before triggering PASSIVE checkpoint (default: 64 MB) */
  private readonly walSizeThreshold: number = 64 * 1024 * 1024;

  constructor(config?: Partial<AutovacuumConfig>) {
    this.config = { ...DEFAULT_AUTOVACUUM_CONFIG, ...config };
    this.logger = PinoLogger.forComponent('AutovacuumDaemon');
    this.ops = new OpsCommands({
      vacuumEnabled: true,
      analyzeEnabled: true,
      reindexEnabled: false,
      autoVacuumEnabled: true,
      autoVacuumThreshold: 20,
    });
  }

  // ──────────────────────────────────────────────
  //  Lifecycle
  // ──────────────────────────────────────────────

  /**
   * Register shard databases for VACUUM/ANALYZE operations.
   */
  registerShardDb(shardId: number, db: Database.Database): void {
    this.shardDbs.set(shardId, db);
    this.ops.registerShardDb(shardId, db);
    this.logger.debug({ shardId }, 'Shard registered with autovacuum daemon');
  }

  /**
   * Set the MVCC Executor for MVCC-aware vacuum operations.
   * MvccVacuum is initialized lazily — only on first use or call.
   */
  setMvccExecutor(executor: MVCCExecutor): void {
    this.mvccVacuum = new MvccVacuum(
      this.shardDbs,
      () => executor.getCurrentXid(),
      () => executor.computeOldestActiveXid(),
      { verbose: false },
    );
    this.logger.debug('MvccVacuum initialized for autovacuum daemon');
  }

  /**
   * Unregister a shard database.
   */
  unregisterShardDb(shardId: number): void {
    this.shardDbs.delete(shardId);
    this.ops.unregisterShardDb(shardId);
    this.logger.debug({ shardId }, 'Shard unregistered from autovacuum daemon');
  }

  /**
   * Start the autovacuum daemon background timer.
   * Safe to call multiple times (only starts once).
   */
  start(): void {
    if (this.intervalHandle !== null) {
      this.logger.warn('Autovacuum daemon already started');
      return;
    }

    if (!this.config.enabled) {
      this.logger.info('Autovacuum daemon is disabled — not starting');
      return;
    }

    this.logger.info(
      { checkIntervalMs: this.config.checkIntervalMs },
      'Starting autovacuum daemon',
    );

    this.intervalHandle = setInterval(() => {
      this.runCheckCycle().catch((err) => {
        this.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Autovacuum check cycle failed',
        );
      });
    }, this.config.checkIntervalMs);

    // Run first check after a short delay (1 second) so system stabilizes
    setTimeout(() => {
      this.runCheckCycle().catch((err) => {
        this.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Autovacuum initial check cycle failed',
        );
      });
    }, 1000);

    this.logger.info('Autovacuum daemon started');
  }

  /**
   * Stop the autovacuum daemon and clear the background timer.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.logger.info('Autovacuum daemon stopped');
    }
  }

  /**
   * Restart the daemon (useful after config changes).
   */
  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * Dispose the daemon — stop timer and clear all state.
   */
  dispose(): void {
    this.stop();
    this.tableStats.clear();
    this.activeWorkers = 0;
    this.shardDbs.clear();
  }

  // ──────────────────────────────────────────────
  //  Dead tuple detection
  // ──────────────────────────────────────────────

  /**
   * Estimate dead tuples using SQLite PRAGMA page_count + freelist_count.
   *
   * Methodology:
   *   - Total pages = PRAGMA page_count
   *   - Free pages = PRAGMA freelist_count
   *   - Total rows = SUM(COUNT(*) from all user tables)
   *   - Estimated max rows = (totalPages - freePages) * avgRowsPerPage
   *   - Dead tuples ≈ max(0, estimatedMaxRows - totalLiveRows)
   *
   * This provides a rough real-world estimate that supplements the
   * mutation tracking in notifyMutation().
   *
   * Returns a Map<tableName, deadTupleCount> for all tracked tables.
   */
  detectDeadTuples(): Map<string, number> {
    const deadTuples = new Map<string, number>();

    for (const [shardId, db] of this.shardDbs) {
      try {
        const pageCount = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? 0;
        const pageSize = (db.prepare('PRAGMA page_size').get() as any)?.page_size ?? 4096;
        const freelistCount = (db.prepare('PRAGMA freelist_count').get() as any)?.freelist_count ?? 0;
        const usablePages = Math.max(1, pageCount - freelistCount);

        // Get all user tables with row counts
        const tables = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__'"
        ).all() as { name: string }[];

        for (const tbl of tables) {
          const cnt = (db.prepare(`SELECT COUNT(*) as cnt FROM "${tbl.name}"`).get() as any)?.cnt ?? 0;

          // Estimate avg row size (rough: pageSize ≈ 4KB, avg row ~100 bytes, ~40 rows/page)
          // More precise: estimate from sqlite_master column count
          const colCount = (db.prepare(
            `SELECT COUNT(*) as cnt FROM pragma_table_info('${tbl.name.replace(/'/g, "''")}')`
          ).get() as any)?.cnt ?? 1;
          const estRowSize = Math.max(32, colCount * 8 + 16); // ~8 bytes per column + overhead
          const rowsPerPage = Math.max(1, Math.floor(pageSize / estRowSize));
          const maxRowsOnDisk = usablePages * rowsPerPage;

          // Estimated dead tuples
          const deadEstimate = Math.max(0, maxRowsOnDisk - cnt);

          // Compare with existing tracked dead tuple count and take the max
          const key = `public.${tbl.name}`;
          const existing = this.tableStats.get(key);
          const notificationDead = existing?.nDeadTup ?? 0;
          deadTuples.set(tbl.name, Math.max(notificationDead, deadEstimate));

          this.logger.debug(
            { table: tbl.name, liveRows: cnt, maxRowsOnDisk, deadEstimate, notificationDead },
            'Dead tuple detection via PRAGMA',
          );
        }
      } catch (err) {
        this.logger.error({ shardId, error: String(err) }, 'Dead tuple detection error');
      }
    }

    return deadTuples;
  }

  /**
   * Apply dead tuple detection results to tracked table stats.
   * Call periodically (e.g. every N check cycles) to improve accuracy.
   */
  applyDeadTupleDetection(): void {
    const deadTuples = this.detectDeadTuples();

    for (const [tableName, deadCount] of deadTuples) {
      const key = `public.${tableName}`;
      const existing = this.tableStats.get(key);
      if (existing) {
        // Take the maximum of notification-based and PRAGMA-based estimates
        existing.nDeadTup = Math.max(existing.nDeadTup, deadCount);
      } else {
        this.tableStats.set(key, this.createInitialStats(tableName, 'public'));
        const stats = this.tableStats.get(key)!;
        stats.nDeadTup = deadCount;
        // Also fetch live count
        try {
          for (const db of this.shardDbs.values()) {
            const cnt = (db.prepare(`SELECT COUNT(*) as cnt FROM "${tableName}"`).get() as any)?.cnt ?? 0;
            stats.nLiveTup = cnt;
            break;
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ──────────────────────────────────────────────
  //  Mutation Tracking
  // ──────────────────────────────────────────────

  /**
   * Notify the daemon that a mutation (INSERT/UPDATE/DELETE) occurred on a table.
   * This updates the internal dead tuple counters for threshold evaluation.
   *
   * @param tableName  The name of the table that was mutated
   * @param mutationType 'INSERT' | 'UPDATE' | 'DELETE'
   * @param schemaName Optional schema name (defaults to 'public')
   */
  notifyMutation(
    tableName: string,
    mutationType: 'INSERT' | 'UPDATE' | 'DELETE',
    schemaName: string = 'public',
  ): void {
    const key = this.statsKey(schemaName, tableName);

    let stats = this.tableStats.get(key);
    if (!stats) {
      stats = this.createInitialStats(tableName, schemaName);
      this.tableStats.set(key, stats);
    }

    // Track live and dead tuple estimates
    switch (mutationType) {
      case 'INSERT':
        stats.nLiveTup += 1;
        break;
      case 'UPDATE':
        // UPDATE creates a dead tuple (old version) and a live tuple (new version)
        stats.nDeadTup += 1;
        break;
      case 'DELETE':
        if (stats.nLiveTup > 0) {
          stats.nLiveTup -= 1;
        }
        stats.nDeadTup += 1;
        break;
    }

    // Track modifications since last analyze (all mutations count)
    stats.nModSinceAnalyze += 1;
  }

  /**
   * Reset statistics for a specific table (called after manual VACUUM/ANALYZE).
   */
  resetTableStats(tableName: string, schemaName: string = 'public'): void {
    const key = this.statsKey(schemaName, tableName);
    const existing = this.tableStats.get(key);
    if (existing) {
      existing.nDeadTup = 0;
      existing.lastVacuumTime = Date.now();
    }
  }

  /**
   * Mark a table as analyzed (reset modify counter and update timestamp).
   */
  markTableAnalyzed(tableName: string, schemaName: string = 'public'): void {
    const key = this.statsKey(schemaName, tableName);
    const existing = this.tableStats.get(key);
    if (existing) {
      existing.nModSinceAnalyze = 0;
      existing.lastAnalyzeTime = Date.now();
    }
  }

  /**
   * Initialize or update a table's live tuple count from the database.
   */
  syncTableLiveTup(tableName: string, nLiveTup: number, schemaName: string = 'public'): void {
    const key = this.statsKey(schemaName, tableName);
    let stats = this.tableStats.get(key);
    if (!stats) {
      stats = this.createInitialStats(tableName, schemaName);
      this.tableStats.set(key, stats);
    }
    stats.nLiveTup = nLiveTup;
  }

  // ──────────────────────────────────────────────
  //  Stats Queries
  // ──────────────────────────────────────────────

  /**
   * Get the current per-table statistics snapshot.
   */
  getTableStats(): ReadonlyMap<string, Readonly<TableStats>> {
    return this.tableStats;
  }

  /**
   * Get stats for a specific table.
   */
  getTableStat(tableName: string, schemaName: string = 'public'): Readonly<TableStats> | undefined {
    return this.tableStats.get(this.statsKey(schemaName, tableName));
  }

  /**
   * Get the number of currently active background workers.
   */
  getActiveWorkerCount(): number {
    return this.activeWorkers;
  }

  // ──────────────────────────────────────────────
  //  Configuration
  // ──────────────────────────────────────────────

  /**
   * Get current configuration (read-only snapshot).
   */
  getConfig(): Readonly<AutovacuumConfig> {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime.
   * Pass `undefined` to keep existing value for each field.
   */
  updateConfig(partial: Partial<AutovacuumConfig>): void {
    const oldEnabled = this.config.enabled;
    Object.assign(this.config, partial);

    // If enabled state changed, restart
    if (partial.enabled !== undefined && partial.enabled !== oldEnabled) {
      if (partial.enabled) {
        this.restart();
      } else {
        this.stop();
      }
      return;
    }

    // If interval changed, restart
    if (partial.checkIntervalMs !== undefined && this.intervalHandle) {
      this.restart();
    }

    this.logger.info({ config: this.config }, 'Autovacuum config updated');
  }

  /**
   * Check if the daemon is currently running.
   */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  // ──────────────────────────────────────────────
  //  Internal: Check Cycle
  // ──────────────────────────────────────────────

  /**
   * Main check cycle — evaluates all tracked tables and schedules
   * VACUUM/ANALYZE as needed.
   */
  private async runCheckCycle(): Promise<void> {
    if (this.cycleInProgress) {
      this.logger.debug('Autovacuum check cycle already in progress — skipping');
      return;
    }

    if (this.activeWorkers >= this.config.maxWorkers) {
      this.logger.debug(
        { activeWorkers: this.activeWorkers, maxWorkers: this.config.maxWorkers },
        'All autovacuum workers busy — skipping cycle',
      );
      return;
    }

    this.cycleInProgress = true;
    this.cycleCount++;

    try {
      // 0. SQLite-level maintenance (every cycle: PRAGMA optimize + WAL size check)
      if (this.shardDbs.size > 0) {
        await this.runMaintenance();
      }

      // 1. Refresh live tuple counts from database (query live rows for tracked tables)
      await this.refreshLiveTuples();

      // 1b. Apply PRAGMA-based dead tuple detection (every 5 cycles)
      const cycleCounter = this.tableStats.size > 0 ? Math.random() : 0; // ~20% chance per cycle
      if (cycleCounter < 0.2 * this.tableStats.size) {
        this.applyDeadTupleDetection();
      }

      // 2. Evaluate each table for VACUUM
      await this.evaluateVacuumNeeds();

      // 3. Evaluate each table for ANALYZE
      await this.evaluateAnalyzeNeeds();

      // 4. Check for freeze-worthy tables
      await this.evaluateFreezeNeeds();
    } finally {
      this.cycleInProgress = false;
    }
  }

  /**
   * Refresh live tuple counts from actual DB row counts.
   * This ensures accuracy when external mutations happen.
   */
  private async refreshLiveTuples(): Promise<void> {
    for (const db of this.shardDbs.values()) {
      try {
        const rows = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__'",
        ).all() as { name: string }[];

        for (const row of rows) {
          const countRow = db.prepare(
            `SELECT COUNT(*) as cnt FROM "${row.name}"`,
          ).get() as { cnt: number };

          if (countRow) {
            this.syncTableLiveTup(row.name, countRow.cnt);
          }
        }
      } catch {
        // Ignore errors for individual tables (e.g. virtual tables)
      }
    }
  }

  /**
   * Evaluate which tables need VACUUM using the PG threshold formula:
   *   n_dead_tup > vacuumThreshold + vacuumScaleFactor * n_live_tup
   */
  private async evaluateVacuumNeeds(): Promise<void> {
    if (this.shardDbs.size === 0) return;

    const threshold = this.config.vacuumThreshold;
    const scaleFactor = this.config.vacuumScaleFactor;

    for (const [key, stats] of this.tableStats) {
      if (this.activeWorkers >= this.config.maxWorkers) {
        this.logger.debug('Max workers reached — stopping VACUUM evaluation');
        return;
      }

      const vacuumTarget = threshold + scaleFactor * stats.nLiveTup;
      if (stats.nDeadTup <= vacuumTarget) {
        continue; // Not enough dead tuples yet
      }

      this.logger.info(
        {
          table: stats.tableName,
          nDeadTup: stats.nDeadTup,
          threshold: Math.round(vacuumTarget),
          nLiveTup: stats.nLiveTup,
        },
        'Autovacuum: VACUUM triggered by dead tuple threshold',
      );

      await this.runVacuum(stats);
    }
  }

  /**
   * Evaluate which tables need ANALYZE using the PG threshold formula:
   *   n_mod_since_analyze > analyzeThreshold + analyzeScaleFactor * n_live_tup
   */
  private async evaluateAnalyzeNeeds(): Promise<void> {
    if (this.shardDbs.size === 0) return;

    const threshold = this.config.analyzeThreshold;
    const scaleFactor = this.config.analyzeScaleFactor;

    for (const [key, stats] of this.tableStats) {
      if (this.activeWorkers >= this.config.maxWorkers) {
        this.logger.debug('Max workers reached — stopping ANALYZE evaluation');
        return;
      }

      const analyzeTarget = threshold + scaleFactor * stats.nLiveTup;
      if (stats.nModSinceAnalyze <= analyzeTarget) {
        continue; // Not enough modifications since last analyze
      }

      this.logger.info(
        {
          table: stats.tableName,
          nModSinceAnalyze: stats.nModSinceAnalyze,
          threshold: Math.round(analyzeTarget),
          nLiveTup: stats.nLiveTup,
        },
        'Autovacuum: ANALYZE triggered by modification threshold',
      );

      await this.runAnalyze(stats);
    }
  }

  /**
   * Evaluate tables that need a full VACUUM (freeze) because their
   * dead tuples have been accumulating for too long.
   *
   * Full VACUUM rewrites the entire SQLite database file, so we
   * use it sparingly — only when freezeMaxAge is exceeded.
   */
  private async evaluateFreezeNeeds(): Promise<void> {
    if (this.shardDbs.size === 0) return;
    const now = Date.now();
    const maxAgeMs = this.config.freezeMaxAge; // In PG this is XID-based, we use wall clock

    for (const [key, stats] of this.tableStats) {
      if (this.activeWorkers >= this.config.maxWorkers) return;

      const ageSinceLastVacuum = now - stats.lastVacuumTime;

      // Convert freezeMaxAge (XID count) to approximate time:
      // Use freezeMaxAge * checkIntervalMs as an estimate of "how long
      // since last VACUUM in wall-clock time"
      const effectiveFreezeAge = this.config.freezeMaxAge * this.config.checkIntervalMs;

      if (ageSinceLastVacuum > effectiveFreezeAge && stats.nDeadTup > 0) {
        this.logger.info(
          {
            table: stats.tableName,
            ageMs: ageSinceLastVacuum,
            freezeThresholdMs: effectiveFreezeAge,
            nDeadTup: stats.nDeadTup,
          },
          'Autovacuum: full VACUUM (freeze) triggered by table age',
        );

        await this.runVacuum(stats, true);
      }
    }
  }

  // ──────────────────────────────────────────────
  //  Maintenance: SQLite-level housekeeping
  // ──────────────────────────────────────────────

  /**
   * Run lightweight SQLite-level maintenance tasks:
   * 1. PRAGMA optimize every cycle (updates query planner stats with no lock)
   * 2. WAL size check + PASSIVE checkpoint every 5 cycles
   */
  private async runMaintenance(): Promise<void> {
    const cycleMod5 = this.cycleCount % 5 === 0;

    for (const [shardId, db] of this.shardDbs) {
      try {
        db.exec('PRAGMA optimize;');
      } catch {
        // PRAGMA optimize failure is non-fatal
      }

      if (cycleMod5) {
        try {
          const dbPath = db.name;
          if (dbPath && dbPath !== ':memory:') {
            const walPath = dbPath + '-wal';
            let walSize = 0;
            try {
              const { statSync } = await import('node:fs');
              const stat = statSync(walPath);
              walSize = stat.size;
            } catch {
              // WAL file may not exist yet
            }

            if (walSize > this.walSizeThreshold) {
              this.logger.info(
                { shardId, walSizeMB: Math.round(walSize / 1024 / 1024), thresholdMB: 64 },
                'WAL exceeds threshold — triggering PASSIVE checkpoint',
              );
              db.exec('PRAGMA wal_checkpoint(PASSIVE);');
            }
          }
        } catch {
          // WAL maintenance failure is non-fatal
        }
      }
    }
  }

  // ──────────────────────────────────────────────
  //  Internal: Executors
  // ──────────────────────────────────────────────

  /**
   * Run VACUUM on a table (all shards) — 3-phase MVCC-aware process.
   *
   * Phase 1: FREEZE — Mark old dead tuples with _xmax = XID_FROZEN
   * Phase 2: HARD DELETE — Remove frozen rows past defer cleanup age
   * Phase 3: COMPACT — Reclaim space (full VACUUM or incremental)
   */
  private async runVacuum(stats: TableStats, full: boolean = false): Promise<void> {
    this.activeWorkers++;

    try {
      // Phase 1 + Phase 2: MVCC-aware dead tuple cleanup
      if (this.mvccVacuum) {
        const mvccStats = this.mvccVacuum.vacuumWithOptions({ full, tableName: stats.tableName });

        let totalFrozen = 0;
        let totalDeleted = 0;
        for (const s of mvccStats) {
          totalFrozen += s.phase1Frozen;
          totalDeleted += s.phase2Deleted;
        }

        if (totalFrozen > 0 || totalDeleted > 0) {
          this.logger.info(
            { table: stats.tableName, frozen: totalFrozen, deleted: totalDeleted },
            'MVCC vacuum: Phase 1+2 completed',
          );
        }
      }

      // Phase 3: SQLite-level space reclamation
      for (const shardId of this.shardDbs.keys()) {
        const result = this.ops.vacuum(shardId, stats.tableName, full);

        if (!result.success) {
          this.logger.warn(
            { shardId, table: stats.tableName, message: result.message },
            'Autovacuum VACUUM failed on shard',
          );
        }
      }

      // Reset stats after successful VACUUM
      this.resetTableStats(stats.tableName, stats.schemaName);

      this.logger.info(
        { table: stats.tableName, full, shards: this.shardDbs.size },
        'Autovacuum VACUUM completed',
      );
    } catch (err) {
      this.logger.error(
        { table: stats.tableName, error: err instanceof Error ? err.message : String(err) },
        'Autovacuum VACUUM error',
      );
    } finally {
      this.activeWorkers--;
    }
  }

  /**
   * Run ANALYZE on a table (all shards), then run PRAGMA optimize.
   */
  private async runAnalyze(stats: TableStats): Promise<void> {
    this.activeWorkers++;

    try {
      for (const shardId of this.shardDbs.keys()) {
        const db = this.shardDbs.get(shardId);
        if (!db) continue;

        // Run ANALYZE
        const result = this.ops.analyze(shardId, stats.tableName);

        if (!result.success) {
          this.logger.warn(
            { shardId, table: stats.tableName, message: result.message },
            'Autovacuum ANALYZE failed on shard',
          );
        }

        // Run PRAGMA optimize after analyze (SQLite-specific statistics update)
        try {
          if (db) {
            db.exec('PRAGMA optimize;');
          }
        } catch (pragmaErr) {
          this.logger.debug({ error: String(pragmaErr) }, 'PRAGMA optimize failed (non-fatal)');
        }
      }

      // Mark table as analyzed
      this.markTableAnalyzed(stats.tableName, stats.schemaName);

      this.logger.info(
        { table: stats.tableName, shards: this.shardDbs.size },
        'Autovacuum ANALYZE completed',
      );
    } catch (err) {
      this.logger.error(
        { table: stats.tableName, error: err instanceof Error ? err.message : String(err) },
        'Autovacuum ANALYZE error',
      );
    } finally {
      this.activeWorkers--;
    }
  }

  // ──────────────────────────────────────────────
  //  Helpers
  // ──────────────────────────────────────────────

  private statsKey(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  private createInitialStats(tableName: string, schemaName: string): TableStats {
    return {
      tableName,
      schemaName,
      nLiveTup: 0,
      nDeadTup: 0,
      nModSinceAnalyze: 0,
      lastVacuumTime: Date.now(),
      lastAnalyzeTime: Date.now(),
    };
  }
}
