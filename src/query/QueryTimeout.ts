/**
 * QueryTimeout — Statement timeout control with AbortController
 *
 * Provides a configurable timeout wrapper for query execution.
 * On timeout, throws a PG-style error with SQLSTATE 57014 (query_canceled).
 *
 * Config:
 *   statementTimeoutMs — max execution time in ms (0 = no limit, default)
 *
 * Usage (after integration into SqlPlanner/QueryRouter):
 *   const timeout = new QueryTimeout({ statementTimeoutMs: 5000 });
 *   const result = await timeout.execute(() => db.query(sql, params));
 *
 * The wrapper uses AbortController to signal cancellation.
 * The actual query implementation should check the abortSignal when possible.
 */

// ============================================================
//  Types
// ============================================================

export interface TimeoutConfig {
  /** Max execution time in ms. 0 = no limit. Default: 0 */
  statementTimeoutMs: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  statementTimeoutMs: 0,
};

export interface TimeoutStats {
  totalExecutions: number;
  timedOutCount: number;
  lastTimeoutAt: number | null;
}

/**
 * PG-style error for query cancellation (SQLSTATE 57014).
 */
export class QueryCanceledError extends Error {
  public code: string;
  public severity: string;
  public sqlState: string;

  constructor(message: string = 'query canceled due to statement timeout') {
    super(message);
    this.name = 'QueryCanceledError';
    this.code = 'QUERY_CANCELED';
    this.severity = 'ERROR';
    this.sqlState = '57014'; // PG SQLSTATE for query_canceled
  }
}

// ============================================================
//  QueryTimeout
// ============================================================

export class QueryTimeout {
  private config: TimeoutConfig;
  /**
   * The currently active execution context, if a query is in flight.
   * Kept as an instance field so `cancel()` and `isRunning()` can observe the
   * latest invocation. Each `execute()` call creates its own local controller
   * and timer to avoid cross-talk between overlapping executions; this field
   * merely points at the most recent one.
   */
  private active: {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  // Stats
  private stats: TimeoutStats = {
    totalExecutions: 0,
    timedOutCount: 0,
    lastTimeoutAt: null,
  };

  constructor(config?: Partial<TimeoutConfig>) {
    this.config = { ...DEFAULT_TIMEOUT_CONFIG, ...config };
  }

  /**
   * Update timeout configuration at runtime.
   */
  updateConfig(config: Partial<TimeoutConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current timeout configuration.
   */
  getConfig(): Readonly<TimeoutConfig> {
    return { ...this.config };
  }

  /**
   * Execute a query function with timeout protection.
   *
   * @param fn - Async function to execute
   * @returns Result of the function
   * @throws QueryCanceledError if the timeout is exceeded
   */
  async execute<T>(fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    this.stats.totalExecutions++;

    const timeoutMs = this.config.statementTimeoutMs;
    if (timeoutMs <= 0) {
      // No timeout — execute directly
      return fn(undefined);
    }

    // Local, per-execution controller and timer so overlapping executions
    // never clobber each other's cancellation state.
    const controller = new AbortController();
    const signal = controller.signal;
    const ctx = { controller, timer: null as ReturnType<typeof setTimeout> | null };
    this.active = ctx;

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      ctx.timer = setTimeout(() => {
        this.stats.timedOutCount++;
        this.stats.lastTimeoutAt = Date.now();
        controller.abort();

        // Simulate setitimer(ITIMER_REAL) behavior: deliver a single SIGALRM
        // In PG, statement_timeout sends SIGALRM which cancels the query.
        reject(
          new QueryCanceledError(
            `canceling statement due to statement timeout (${timeoutMs}ms)`,
          ),
        );
      }, timeoutMs);

      // Execute the function
      const promise = (async () => {
        try {
          return await fn(signal);
        } catch (err: any) {
          // If the error is an AbortError, convert to QueryCanceledError.
          // Do NOT increment the counters here: the abort was already counted
          // by the timeout callback or cancel(), which is the only way this
          // controller's signal becomes aborted. Re-counting would double the
          // timedOutCount for a single cancellation.
          if (
            err &&
            (err.name === 'AbortError' ||
              err.code === 'ABORT_ERR' ||
              err.message?.includes('abort'))
          ) {
            throw new QueryCanceledError(
              `canceling statement due to statement timeout (${timeoutMs}ms)`,
            );
          }
          throw err;
        }
      })();

      promise
        .then((result) => {
          this.clearActive(ctx);
          resolve(result);
        })
        .catch((err) => {
          this.clearActive(ctx);
          reject(err);
        });
    });
  }

  /**
   * Cancel the currently running query, if any.
   * Can be called externally to cancel an in-flight query.
   */
  cancel(): void {
    const cur = this.active;
    if (!cur) return;
    cur.controller.abort();
    this.stats.timedOutCount++;
    this.stats.lastTimeoutAt = Date.now();
    this.clearActive(cur);
  }

  /**
   * Check if there's a query currently being tracked.
   */
  isRunning(): boolean {
    return this.active !== null;
  }

  /**
   * Get execution statistics.
   */
  getStats(): Readonly<TimeoutStats> {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = {
      totalExecutions: 0,
      timedOutCount: 0,
      lastTimeoutAt: null,
    };
  }

  /**
   * Clear and release the given active execution context, if it is still the
   * current one. Aborts the controller only when explicitly canceling (the
   * abort is performed by `cancel()` before calling this); on normal
   * completion we merely clear the timer and detach.
   */
  private clearActive(ctx: { controller: AbortController; timer: ReturnType<typeof setTimeout> | null }): void {
    if (ctx.timer !== null) {
      clearTimeout(ctx.timer);
      ctx.timer = null;
    }
    if (this.active === ctx) {
      this.active = null;
    }
  }
}

/**
 * Create a timeout wrapper for a specific timeout value.
 * Convenience function for one-off usage.
 */
export function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const timeout = new QueryTimeout({ statementTimeoutMs: timeoutMs });
  return timeout.execute(fn);
}
