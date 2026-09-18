/**
 * ConnectionPoolManager — process-wide facade over a shared connection pool.
 *
 * The query router acquires connections per session/user through this manager.
 * It is a singleton so the pool is shared across the process; `acquire(user)`
 * leases a connection and `release(user, conn)` returns it.  The user key is
 * informational (used for observability) — the underlying pool is shared.
 *
 * @module pg-pool/ConnectionPoolManager
 */

import { ConnectionPool, type PoolConfig, type PoolStats } from './ConnectionPool';

/**
 * Singleton facade over a shared {@link ConnectionPool}.
 */
export class ConnectionPoolManager {
  private static instance: ConnectionPoolManager | null = null;

  private readonly pool: ConnectionPool;

  /** @internal Use {@link ConnectionPoolManager.getInstance}. */
  private constructor(config: PoolConfig<unknown>) {
    this.pool = new ConnectionPool(config);
  }

  /**
   * Return the process-wide singleton, provisioning it lazily with the given
   * config on first access.  Subsequent calls with a different config return
   * the already-initialized instance.
   */
  static getInstance(config?: PoolConfig<unknown>): ConnectionPoolManager {
    if (!ConnectionPoolManager.instance) {
      ConnectionPoolManager.instance = new ConnectionPoolManager(
        config ?? { factory: () => ({}), maxSize: 10, acquireTimeoutMs: 5000 },
      );
    }
    return ConnectionPoolManager.instance;
  }

  /** Reset the singleton (used to reconfigure/re-test the pool). */
  static reset(): void {
    if (ConnectionPoolManager.instance) {
      ConnectionPoolManager.instance.pool.drain();
    }
    ConnectionPoolManager.instance = null;
  }

  /** Lease a connection for the given user. */
  async acquire(_user: string): Promise<unknown> {
    return this.pool.acquire();
  }

  /** Return a leased connection to the pool. */
  async release(_user: string, conn: unknown): Promise<void> {
    this.pool.release(conn);
  }

  /** Aggregate pool statistics. */
  getStats(): PoolStats {
    return this.pool.getStats();
  }
}
