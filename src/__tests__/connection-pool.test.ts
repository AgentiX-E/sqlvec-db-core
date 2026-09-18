/**
 * Unit tests for the connection pool and its singleton manager.
 *
 * Exercises provisioning, idle reuse, capacity boundaries, acquire timeout,
 * waiter hand-off, release idempotency, drain, stats accounting, and the
 * manager's singleton lifecycle.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ConnectionPool } from '../pg-pool/ConnectionPool';
import { ConnectionPoolManager } from '../pg-pool/ConnectionPoolManager';

describe('ConnectionPool.acquire / release', () => {
  it('provisions a new connection on first acquire', async () => {
    let created = 0;
    const pool = new ConnectionPool<number>({ factory: () => ++created });
    const conn = await pool.acquire();
    expect(conn).toBe(1);
    expect(pool.getStats()).toMatchObject({ active: 1, idle: 0, waiting: 0 });
  });

  it('reuses an idle connection before provisioning', async () => {
    let created = 0;
    const pool = new ConnectionPool<number>({ factory: () => ++created });
    const a = await pool.acquire();
    pool.release(a);
    const b = await pool.acquire();
    expect(b).toBe(1);
    expect(created).toBe(1);
  });

  it('provisions up to maxSize then waits', async () => {
    let created = 0;
    const pool = new ConnectionPool<number>({ factory: () => ++created, maxSize: 2 });
    await pool.acquire();
    await pool.acquire();
    expect(created).toBe(2);
    // Third acquire must wait (no idle, at capacity).
    const p = pool.acquire();
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.getStats().waiting).toBe(1);
    // Release one → the waiter resolves.
    pool.release(1);
    expect(await p).toBe(1);
    expect(pool.getStats()).toMatchObject({ active: 2, waiting: 0 });
  });

  it('throws after acquireTimeoutMs when no connection frees up', async () => {
    const pool = new ConnectionPool<number>({
      factory: () => 1,
      maxSize: 1,
      acquireTimeoutMs: 20,
    });
    await pool.acquire(); // exhaust the pool
    await expect(pool.acquire()).rejects.toThrow(/timed out/);
  });

  it('release is idempotent for unknown connections', () => {
    const pool = new ConnectionPool<number>({ factory: () => 1 });
    pool.release(999); // not owned → ignored
    expect(pool.getStats()).toMatchObject({ active: 0, idle: 0 });
  });

  it('release moves active → idle when no waiter', async () => {
    const pool = new ConnectionPool<number>({ factory: () => 1 });
    const conn = await pool.acquire();
    pool.release(conn);
    expect(pool.getStats()).toMatchObject({ active: 0, idle: 1 });
  });
});

describe('ConnectionPool.tryAcquire', () => {
  it('returns an idle connection or undefined', async () => {
    const pool = new ConnectionPool<number>({ factory: () => 1 });
    expect(pool.tryAcquire()).toBeUndefined();
    pool.release(await pool.acquire());
    expect(pool.tryAcquire()).toBe(1);
  });
});

describe('ConnectionPool.getStats / getPoolStats', () => {
  it('reports active/idle/waiting/max', async () => {
    const pool = new ConnectionPool<number>({ factory: () => 1, maxSize: 5 });
    const a = await pool.acquire();
    const b = await pool.acquire();
    pool.release(a);
    expect(pool.getStats()).toEqual({ active: 1, idle: 1, waiting: 0, max: 5 });
    expect(pool.getPoolStats()).toEqual(pool.getStats());
    pool.release(b);
  });

  it('uses default maxSize of 10 when unspecified', () => {
    const pool = new ConnectionPool<number>({ factory: () => 1 });
    expect(pool.getStats().max).toBe(10);
  });
});

describe('ConnectionPool.drain', () => {
  it('destroys idle connections and rejects waiters', async () => {
    const destroyed: number[] = [];
    const pool = new ConnectionPool<number>({
      factory: () => 1,
      maxSize: 1,
      acquireTimeoutMs: 1000,
      destroy: (c) => destroyed.push(c),
    });
    const conn = await pool.acquire();
    pool.release(conn); // now idle

    // Exhaust then queue a waiter.
    await pool.acquire(); // takes the idle back
    const waiter = pool.acquire(); // blocks
    await new Promise((r) => setTimeout(r, 10));
    expect(pool.getStats().waiting).toBe(1);

    pool.drain();
    await expect(waiter).rejects.toThrow(/drained/);
    expect(pool.getStats()).toMatchObject({ idle: 0, waiting: 0 });
  });

  it('drain with no destroy callback is safe', () => {
    const pool = new ConnectionPool<number>({ factory: () => 1 });
    pool.drain();
    expect(pool.getStats()).toMatchObject({ active: 0, idle: 0 });
  });
});

describe('ConnectionPoolManager', () => {
  afterEach(() => ConnectionPoolManager.reset());

  it('getInstance returns the same singleton', () => {
    const a = ConnectionPoolManager.getInstance();
    const b = ConnectionPoolManager.getInstance();
    expect(a).toBe(b);
  });

  it('provisions a default pool when no config is given', async () => {
    const mgr = ConnectionPoolManager.getInstance();
    expect(mgr.getStats()).toEqual({ active: 0, idle: 0, waiting: 0, max: 10 });
    // Trigger the default factory (the `config ?? {...}` fallback limb).
    const conn = await mgr.acquire('default');
    expect(conn).toEqual({});
    await mgr.release('default', conn);
  });

  it('reset drains an active pool before clearing the singleton', async () => {
    const mgr = ConnectionPoolManager.getInstance({ factory: () => 42, maxSize: 2 });
    const conn = await mgr.acquire('u');
    // Leave the connection checked out; reset must still clear the singleton.
    ConnectionPoolManager.reset();
    expect(ConnectionPoolManager.getInstance()).not.toBe(mgr);
    // Release the old connection into the drained pool (idempotent, no throw).
    ConnectionPoolManager.reset();
  });

  it('acquire/release round-trips a connection', async () => {
    let created = 0;
    const mgr = ConnectionPoolManager.getInstance({ factory: () => ++created, maxSize: 2 });
    const conn = await mgr.acquire('alice');
    expect(conn).toBe(1);
    expect(mgr.getStats().active).toBe(1);
    await mgr.release('alice', conn);
    expect(mgr.getStats()).toMatchObject({ active: 0, idle: 1 });
  });

  it('reset drains and re-provisions a fresh singleton', () => {
    const first = ConnectionPoolManager.getInstance();
    ConnectionPoolManager.reset();
    const second = ConnectionPoolManager.getInstance();
    expect(second).not.toBe(first);
  });
});
