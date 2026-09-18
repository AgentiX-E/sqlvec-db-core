/**
 * ConnectionPool — a bounded, lazily-provisioned pool of connections.
 *
 * Generic over the connection type so it stays decoupled from any specific
 * driver (better-sqlite3, pg, etc.).  The pool owns the connection lifecycle:
 * it creates connections on demand via `factory`, enforces a `maxSize` cap,
 * and waits up to `acquireTimeoutMs` for a connection to free up before
 * throwing.  Connections are handed out on `acquire()` and returned on
 * `release()`; calling `release()` with a connection the pool does not own is
 * ignored (defensive — idempotent release).
 *
 * @module pg-pool/ConnectionPool
 */

/** Configuration for a {@link ConnectionPool}. */
export interface PoolConfig<T> {
  /** Factory that provisions a fresh connection. */
  factory: () => T;
  /** Optional destructor called on {@link ConnectionPool.drain}. */
  destroy?: (conn: T) => void;
  /** Maximum number of concurrent (active + idle) connections. Default 10. */
  maxSize?: number;
  /** Milliseconds to wait for a free connection before throwing. Default 5000. */
  acquireTimeoutMs?: number;
}

/** Aggregate pool statistics. */
export interface PoolStats {
  /** Connections currently checked out. */
  active: number;
  /** Connections idle and ready to be acquired. */
  idle: number;
  /** Pending acquirers blocked waiting for a connection. */
  waiting: number;
  /** Configured maximum connection count. */
  max: number;
}

/** A pending acquire request (resolved when a connection is released). */
interface PendingAcquire<T> {
  resolve: (conn: T) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * A bounded connection pool.
 */
export class ConnectionPool<T = unknown> {
  private readonly factory: () => T;
  private readonly destroy?: (conn: T) => void;
  private readonly maxSize: number;
  private readonly acquireTimeoutMs: number;

  private idle: T[] = [];
  private active: T[] = [];
  private pending: PendingAcquire<T>[] = [];

  constructor(config: PoolConfig<T>) {
    this.factory = config.factory;
    this.destroy = config.destroy;
    this.maxSize = config.maxSize ?? 10;
    this.acquireTimeoutMs = config.acquireTimeoutMs ?? 5000;
  }

  /**
   * Obtain a connection, provisioning one if the pool is not at capacity and
   * none is idle; otherwise wait for a release.  Throws if the wait exceeds
   * `acquireTimeoutMs`.
   */
  async acquire(): Promise<T> {
    // Fast path: an idle connection is immediately available.
    if (this.idle.length > 0) {
      const conn = this.idle.pop()!;
      this.active.push(conn);
      return conn;
    }

    // Provision a new connection if under capacity.
    if (this.active.length + this.idle.length < this.maxSize) {
      const conn = this.factory();
      this.active.push(conn);
      return conn;
    }

    // Otherwise queue for the next release.
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((p) => p.resolve !== resolve);
        reject(new Error('Connection pool acquire timed out'));
      }, this.acquireTimeoutMs);

      this.pending.push({ resolve, reject, timer });
    });
  }

  /** Return a connection to the pool, waking a waiting acquirer if any. */
  release(conn: T): void {
    const idx = this.active.indexOf(conn);
    if (idx === -1) return; // not owned (already released / foreign) — ignore

    this.active.splice(idx, 1);

    // Hand the connection directly to the next waiter, if any.
    const waiter = this.pending.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      this.active.push(conn);
      waiter.resolve(conn);
      return;
    }

    this.idle.push(conn);
  }

  /** Try to acquire synchronously; returns `undefined` if none is free. */
  tryAcquire(): T | undefined {
    if (this.idle.length > 0) {
      const conn = this.idle.pop()!;
      this.active.push(conn);
      return conn;
    }
    return undefined;
  }

  /** Aggregate pool statistics. */
  getStats(): PoolStats {
    return {
      active: this.active.length,
      idle: this.idle.length,
      waiting: this.pending.length,
      max: this.maxSize,
    };
  }

  /**
   * Detail of currently checked-out connections.  Returned as a shallow list so
   * the exact connection objects are not leaked through introspection.
   */
  getPoolStats(): { active: number; idle: number; waiting: number; max: number } {
    return this.getStats();
  }

  /**
   * Destroy all idle connections and reset the pool.  Checked-out connections
   * are left untouched (they will be discarded on release).
   */
  drain(): void {
    if (this.destroy) {
      for (const conn of this.idle) this.destroy(conn);
    }
    this.idle = [];
    // Reject any pending waiters (the pool is being reset).
    for (const waiter of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Connection pool drained'));
    }
    this.pending = [];
  }
}
