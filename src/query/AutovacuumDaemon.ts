/**
 * AutovacuumDaemon — a background maintenance worker that mirrors PostgreSQL's
 * autovacuum subsystem for the MVCC storage layer.
 *
 * The daemon periodically scans every registered shard, tracks dead-tuple
 * pressure, and triggers a {@link MvccVacuum} pass when a shard exceeds its
 * configured threshold.  It also coordinates with the VACUUM shim through
 * {@link setVacuumMutationHook}, so a manual `VACUUM` resets the internal
 * dead-tuple counter for the affected table (preventing a redundant autovacuum
 * pass immediately afterwards).
 *
 * The class is deliberately self-contained: real MVCC vacuum work is delegated
 * to the injected executor (typically an {@link MvccVacuum}), while this class
 * owns the scheduling, per-shard accounting, and lifecycle.
 *
 * @module query/AutovacuumDaemon
 */

import { PinoLogger } from '../logger/PinoLogger';
import { setVacuumMutationHook } from './VacuumShim';

const logger = PinoLogger.forComponent('AutovacuumDaemon');

/** Configuration for {@link AutovacuumDaemon}. */
export interface AutovacuumConfig {
  /** Whether autovacuum is enabled. @default true */
  enabled: boolean;
  /** Interval between maintenance checks, in milliseconds. @default 60000 */
  checkIntervalMs: number;
  /**
   * Minimum number of dead tuples a shard must accumulate before a vacuum is
   * triggered. @default 50
   */
  vacuumThreshold: number;
  /**
   * Minimum number of inserts a shard must accumulate before an analyze is
   * triggered. @default 50
   */
  analyzeThreshold: number;
  /**
   * Soft cap on the number of shards processed per cycle; remaining shards are
   * deferred to the next cycle. @default 16
   */
  maxShardsPerCycle: number;
}

/** Default autovacuum configuration. */
export const DEFAULT_AUTOVACUUM_CONFIG: AutovacuumConfig = {
  enabled: true,
  checkIntervalMs: 60000,
  vacuumThreshold: 50,
  analyzeThreshold: 50,
  maxShardsPerCycle: 16,
};

/** A single shard's maintenance accounting. */
interface ShardState {
  shardId: string;
  /** Accumulated dead-tuple estimate since the last vacuum. */
  deadTuples: number;
  /** Accumulated insert estimate since the last analyze. */
  insertsSinceAnalyze: number;
  /** Epoch milliseconds of the last vacuum pass, or `null`. */
  lastVacuumAt: number | null;
  /** Epoch milliseconds of the last analyze pass, or `null`. */
  lastAnalyzeAt: number | null;
}

/**
 * The MVCC vacuum executor contract.  {@link MvccVacuum} satisfies this; the
 * interface decouples the daemon from the concrete implementation for tests.
 */
export interface AutovacuumExecutor {
  vacuumWithOptions(opts?: { full?: boolean; tableName?: string }): unknown;
}

/**
 * The background autovacuum worker.
 */
export class AutovacuumDaemon {
  private readonly config: AutovacuumConfig;

  private readonly shards = new Map<string, ShardState>();
  private executor: AutovacuumExecutor | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(config: Partial<AutovacuumConfig> = {}) {
    this.config = { ...DEFAULT_AUTOVACUUM_CONFIG, ...config };
  }

  /**
   * Register a shard for maintenance tracking.
   *
   * The `db` argument is accepted for API compatibility with
   * `QueryRouter.initAutovacuum`; actual vacuum work is performed by the
   * injected executor against its own shard-connection map.
   *
   * @param shardId - Shard identifier.
   * @param db - The shard's database handle (retained for introspection).
   */
  registerShardDb(shardId: string, db: unknown): void {
    if (!this.shards.has(shardId)) {
      this.shards.set(shardId, {
        shardId,
        deadTuples: 0,
        insertsSinceAnalyze: 0,
        lastVacuumAt: null,
        lastAnalyzeAt: null,
      });
    }
    logger.debug({ shardId, hasDb: db != null }, 'Registered shard for autovacuum');
  }

  /**
   * Set the MVCC executor used for real vacuum passes.
   *
   * @param executor - The vacuum executor (e.g. an {@link MvccVacuum}).
   */
  setMvccExecutor(executor: AutovacuumExecutor): void {
    this.executor = executor;
  }

  /** Whether the daemon is currently running. */
  get isRunning(): boolean {
    return this.started;
  }

  /** Number of shards currently tracked. */
  get trackedShardCount(): number {
    return this.shards.size;
  }

  /**
   * Start the periodic maintenance loop.
   *
   * Safe to call after {@link stop}; a new timer is created only if one is not
   * already active.
   */
  start(): void {
    if (this.started) return;
    if (!this.config.enabled) return;

    // Register the VACUUM hook so manual VACUUM resets dead-tuple counters.
    setVacuumMutationHook((tableName?: string) => this.onManualVacuum(tableName));

    this.started = true;
    this.timer = setInterval(() => {
      this.runCycle();
    }, this.config.checkIntervalMs);

    // Do not keep the process alive solely for autovacuum.  Node's setInterval
    // always returns a Timeout with `unref`, so this is safe without a guard.
    this.timer.unref();

    logger.info({ checkIntervalMs: this.config.checkIntervalMs }, 'Autovacuum daemon started');
  }

  /**
   * Stop the periodic maintenance loop and detach the VACUUM hook.
   */
  stop(): void {
    if (!this.started) return;
    // A started daemon always has a live timer (set synchronously in start()).
    clearInterval(this.timer!);
    this.timer = null;
    this.started = false;
    setVacuumMutationHook(null);
    logger.info('Autovacuum daemon stopped');
  }

  /**
   * Run a single maintenance cycle synchronously (also invoked by the timer).
   *
   * @returns The number of shards that triggered a vacuum pass this cycle.
   */
  runCycle(): number {
    if (!this.started) return 0;

    let vacuumed = 0;
    let processed = 0;

    for (const state of this.shards.values()) {
      if (processed >= this.config.maxShardsPerCycle) break;

      processed += 1;

      const needsVacuum = state.deadTuples >= this.config.vacuumThreshold;
      const needsAnalyze = state.insertsSinceAnalyze >= this.config.analyzeThreshold;

      if (needsVacuum) {
        if (this.vacuumShard(state)) {
          vacuumed += 1;
        }
      } else if (needsAnalyze && this.executor !== null) {
        // Analyze-only pass (no freeze) for insert-heavy shards.
        this.analyzeShard(state);
      }
    }

    if (vacuumed > 0) {
      logger.info({ vacuumed, processed }, 'Autovacuum cycle completed');
    }
    return vacuumed;
  }

  /**
   * Trigger a vacuum pass against a shard's executor.
   *
   * @returns `true` if a vacuum pass was actually run, `false` if it was
   *          skipped because no executor is configured.
   */
  private vacuumShard(state: ShardState): boolean {
    if (this.executor === null) {
      logger.warn({ shardId: state.shardId }, 'No MVCC executor set — skipping autovacuum');
      return false;
    }
    state.deadTuples = 0;
    state.lastVacuumAt = Date.now();
    // A plain (non-FULL, non-freeze) pass is the autovacuum default.
    this.executor.vacuumWithOptions({ full: false });
    return true;
  }

  /** Trigger an analyze-only pass against a shard's executor. */
  private analyzeShard(state: ShardState): void {
    state.insertsSinceAnalyze = 0;
    state.lastAnalyzeAt = Date.now();
    this.executor!.vacuumWithOptions({ full: false });
  }

  /**
   * Called (via the VACUUM shim hook) when a manual `VACUUM` statement is
   * processed, so the affected shard's dead-tuple counter can be reset.
   *
   * @param tableName - Table targeted by the manual VACUUM (may be undefined).
   */
  private onManualVacuum(tableName?: string): void {
    // A table-targeted VACUUM only resets that table's accounting; since
    // shard-level counters aggregate per shard, a manual VACUUM conservatively
    // resets every tracked shard (exact for the common single-shard case).
    for (const state of this.shards.values()) {
      state.deadTuples = 0;
    }
    logger.debug({ tableName }, 'Manual VACUUM reset autovacuum counters');
  }

  /**
   * Record estimated dead tuples for a shard (used by mutation tracking to
   * surface pressure to the daemon).
   *
   * @param shardId - Shard identifier.
   * @param count - Estimated dead tuples to add.
   */
  recordDeadTuples(shardId: string, count: number): void {
    const state = this.shards.get(shardId);
    if (state) {
      state.deadTuples += count;
    }
  }

  /**
   * Record estimated inserts for a shard (drives analyze scheduling).
   *
   * @param shardId - Shard identifier.
   * @param count - Estimated inserts to add.
   */
  recordInserts(shardId: string, count: number): void {
    const state = this.shards.get(shardId);
    if (state) {
      state.insertsSinceAnalyze += count;
    }
  }

  /** Snapshot of a shard's current autovacuum accounting (for introspection). */
  getShardState(shardId: string): Readonly<ShardState> | undefined {
    const state = this.shards.get(shardId);
    return state ? { ...state } : undefined;
  }
}
