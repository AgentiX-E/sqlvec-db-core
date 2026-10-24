import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for WriteWorkerPool. The real worker_threads.Worker is mocked so we
 * can drive every code path (ready signal, task result/error round-trip, worker
 * error/exit handling, uninitialized throws, postMessage failure) without
 * spawning an actual child process.
 */

const mock = vi.hoisted(() => {
  const instances: any[] = [];
  class MockWorker {
    handlers: Record<string, Function[]> = {};
    terminated = false;
    posted: any[] = [];
    constructor(public script: string, public options: any) {
      instances.push(this);
    }
    on(evt: string, fn: Function) {
      (this.handlers[evt] ??= []).push(fn);
      return this;
    }
    postMessage(msg: any) {
      this.posted.push(msg);
    }
    terminate() {
      this.terminated = true;
      return Promise.resolve(0);
    }
    emit(evt: string, ...args: any[]) {
      for (const fn of this.handlers[evt] ?? []) fn(...args);
    }
  }
  return { instances, MockWorker };
});

vi.mock('worker_threads', () => ({
  Worker: mock.MockWorker,
}));

import { WriteWorkerPool } from '../storage/WriteWorkerPool';

const mockWorkerInstances = mock.instances;

describe('WriteWorkerPool', () => {
  beforeEach(() => {
    mockWorkerInstances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const shardPaths = { 0: '/tmp/shard0.db', 1: '/tmp/shard1.db' };

  it('initialized getter is false before initialize', () => {
    const pool = new WriteWorkerPool();
    expect(pool.initialized).toBe(false);
  });

  it('initialize spawns a worker and resolves on ready', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    expect(w).toBeTruthy();
    expect(w.script).toContain('write-worker.js');
    expect(w.options.workerData.shardPaths).toEqual(shardPaths);

    w.emit('message', { type: 'ready' });
    await initP;
    expect(pool.initialized).toBe(true);
  });

  it('initialize is idempotent (second call is a no-op)', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    mockWorkerInstances[0].emit('message', { type: 'ready' });
    await initP;

    await pool.initialize(shardPaths); // second call — already initialized
    expect(mockWorkerInstances).toHaveLength(1);
  });

  it('initialize rejects on timeout', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    vi.advanceTimersByTime(10_001);
    await expect(initP).rejects.toThrow(/timed out/i);
  });

  it('exec posts a single-write task and resolves with changes', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    const execP = pool.exec(0, 'UPDATE t SET x = 1');
    expect(w.posted).toEqual([{ taskId: 1, shardId: 0, sql: 'UPDATE t SET x = 1' }]);
    w.emit('message', { taskId: 1, changes: 5 });
    await expect(execP).resolves.toEqual({ changes: 5 });
  });

  it('exec rejects when worker reports an error', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    const execP = pool.exec(0, 'BAD SQL');
    w.emit('message', { taskId: 1, changes: 0, error: 'no such table' });
    await expect(execP).rejects.toThrow('no such table');
  });

  it('exec throws when not initialized', async () => {
    const pool = new WriteWorkerPool();
    await expect(pool.exec(0, 'X')).rejects.toThrow(/not initialized/i);
  });

  it('execBatch returns zero changes for an empty batch', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    mockWorkerInstances[0].emit('message', { type: 'ready' });
    await initP;
    await expect(pool.execBatch(0, [])).resolves.toEqual({ changes: 0 });
  });

  it('execBatch posts all SQLs as a single task', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    const batchP = pool.execBatch(1, ['A', 'B', 'C']);
    expect(w.posted).toEqual([{ taskId: 1, shardId: 1, sqls: ['A', 'B', 'C'] }]);
    w.emit('message', { taskId: 1, changes: 3 });
    await expect(batchP).resolves.toEqual({ changes: 3 });
  });

  it('rejects pending tasks on worker error', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    const execP = pool.exec(0, 'X');
    w.emit('error', new Error('worker crashed'));
    await expect(execP).rejects.toThrow('worker crashed');
    expect(pool.initialized).toBe(false);
  });

  it('rejects pending tasks on non-zero exit', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    const execP = pool.exec(0, 'X');
    w.emit('exit', 1);
    await expect(execP).rejects.toThrow(/exited with code 1/i);
  });

  it('rejects pending tasks when postMessage throws', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    w.postMessage = () => {
      throw new Error('send failed');
    };
    await expect(pool.exec(0, 'X')).rejects.toThrow(/Failed to send task/i);
  });

  it('close terminates the worker and clears state', async () => {
    const pool = new WriteWorkerPool();
    const initP = pool.initialize(shardPaths);
    const w = mockWorkerInstances[0];
    w.emit('message', { type: 'ready' });
    await initP;

    await pool.close();
    expect(w.terminated).toBe(true);
    expect(pool.initialized).toBe(false);
  });

  it('close is safe when never initialized', async () => {
    const pool = new WriteWorkerPool();
    await expect(pool.close()).resolves.toBeUndefined();
  });
});
