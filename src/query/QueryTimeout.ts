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

import { SqlVecError, SqlVecErrorCode } from '../core/types';

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
  private abortController: AbortController | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

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

    // Create a new AbortController for this execution
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    return new Promise<T>((resolve, reject) => {
      // Set up timeout
      this.timeoutHandle = setTimeout(() => {
        this.stats.timedOutCount++;
        this.stats.lastTimeoutAt = Date.now();
        this.abortController?.abort();

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
          // If the error is an AbortError, convert to QueryCanceledError
          if (
            err &&
            (err.name === 'AbortError' ||
              err.code === 'ABORT_ERR' ||
              err.message?.includes('abort'))
          ) {
            this.stats.timedOutCount++;
            this.stats.lastTimeoutAt = Date.now();
            throw new QueryCanceledError(
              `canceling statement due to statement timeout (${timeoutMs}ms)`,
            );
          }
          throw err;
        }
      })();

      promise
        .then((result) => {
          this.clearTimeout();
          resolve(result);
        })
        .catch((err) => {
          this.clearTimeout();
          reject(err);
        });
    });
  }

  /**
   * Cancel the currently running query, if any.
   * Can be called externally to cancel an in-flight query.
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.stats.timedOutCount++;
      this.stats.lastTimeoutAt = Date.now();
    }
    this.clearTimeout();
  }

  /**
   * Check if there's a query currently being tracked.
   */
  isRunning(): boolean {
    return this.timeoutHandle !== null;
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
   * Clear the timeout handle without canceling the query.
   * Used when the query completes before the timeout.
   */
  private clearTimeout(): void {
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    this.abortController = null;
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
