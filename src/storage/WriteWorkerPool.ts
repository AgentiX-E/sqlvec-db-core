/**
 * WriteWorkerPool — Offloads all SQLite write operations to a dedicated worker thread
 *
 * Benefits:
 *   - Main thread event loop stays responsive during writes
 *   - Writer thread maintains persistent SQLite connections (no open/close per write)
 *   - WAL mode allows concurrent reads from main thread's reader pool
 *
 * Usage:
 *   const pool = new WriteWorkerPool();
 *   await pool.initialize(shardPaths);          // spawns worker, opens DBs
 *   await pool.exec(shardId, 'UPDATE ...');     // non-blocking
 *   await pool.close();                          // terminates worker
 */

import { Worker } from 'worker_threads';
import path from 'path';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('WriteWorkerPool');

export interface WriteResult {
  changes: number;
}

export class WriteWorkerPool {
  private worker: Worker | null = null;
  private nextTaskId = 0;
  private pending = new Map<number, { resolve: (r: WriteResult) => void; reject: (e: Error) => void }>();
  private _initialized = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Spawn a dedicated worker thread and open persistent DB connections.
   * Resolves when the worker signals it's ready.
   */
  async initialize(shardPaths: Record<number, string>): Promise<void> {
    if (this._initialized) {
      logger.warn('WriteWorkerPool already initialized');
      return;
    }

    // Locate the worker script relative to the compiled dist directory
    const workerScript = path.join(__dirname, 'write-worker.js');

    this.worker = new Worker(workerScript, {
      workerData: { shardPaths, walEnabled: true },
    });

    // Set up message handler — resolves/rejects pending tasks
    this.worker.on('message', (msg: any) => {
      if (!msg || typeof msg !== 'object') return;

      // 'ready' signal from the worker
      if (msg.type === 'ready') {
        this._initialized = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        logger.info('WriteWorkerPool ready');
        return;
      }

      // Task result
      if (typeof msg.taskId === 'number') {
        const pending = this.pending.get(msg.taskId);
        if (pending) {
          this.pending.delete(msg.taskId);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve({ changes: msg.changes ?? 0 });
          }
        }
        return;
      }
    });

    // Handle worker errors — reject all pending tasks
    this.worker.on('error', (err) => {
      logger.error({ err: err.message }, 'WriteWorkerPool worker error');
      this._initialized = false;
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    // Handle unexpected worker exit
    this.worker.on('exit', (code) => {
      logger.warn({ exitCode: code }, 'WriteWorkerPool worker exited');
      this._initialized = false;
      if (code !== 0) {
        for (const [, p] of this.pending) {
          p.reject(new Error(`WriteWorker exited with code ${code}`));
        }
        this.pending.clear();
      }
    });

    // Wait for the 'ready' signal
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      // Timeout after 10 seconds
      const timeout = setTimeout(() => {
        if (!this._initialized) {
          this.readyResolve = null;
          reject(new Error('WriteWorkerPool initialization timed out'));
        }
      }, 10_000);
      
      // Wrap resolve to clear timeout
      const origResolve = resolve;
      this.readyResolve = () => {
        clearTimeout(timeout);
        origResolve();
        this.readyResolve = null;
      };
    });

    await this.readyPromise;
  }

  /**
   * Execute a write SQL on the specified shard via the worker thread.
   * Returns a WriteResult with the number of changed rows.
   * Throws if the worker encounters an error.
   */
  async exec(shardId: number, sql: string): Promise<WriteResult> {
    if (!this.worker || !this._initialized) {
      throw new Error('WriteWorkerPool not initialized');
    }

    const taskId = ++this.nextTaskId;

    return new Promise<WriteResult>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
      
      try {
        this.worker!.postMessage({ taskId, shardId, sql });
      } catch (err: any) {
        this.pending.delete(taskId);
        reject(new Error(`WriteWorker: Failed to send task: ${err.message}`));
      }
    });
  }

  /**
   * Execute multiple SQLs on the specified shard in a single transaction.
   * All SQLs are wrapped in BEGIN IMMEDIATE ... COMMIT on the worker side.
   * This is more efficient than N individual exec() calls because:
   *   1. One IPC round-trip instead of N
   *   2. One SQLite transaction instead of N auto-commits
   *   3. Reduced fsync overhead
   */
  async execBatch(shardId: number, sqls: string[]): Promise<WriteResult> {
    if (!this.worker || !this._initialized) {
      throw new Error('WriteWorkerPool not initialized');
    }
    if (sqls.length === 0) {
      return { changes: 0 };
    }

    const taskId = ++this.nextTaskId;

    return new Promise<WriteResult>((resolve, reject) => {
      this.pending.set(taskId, { resolve, reject });
      
      try {
        this.worker!.postMessage({ taskId, shardId, sqls });
      } catch (err: any) {
        this.pending.delete(taskId);
        reject(new Error(`WriteWorker: Failed to send batch: ${err.message}`));
      }
    });
  }

  /**
   * Terminate the worker thread and release connections.
   */
  async close(): Promise<void> {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this._initialized = false;
    this.pending.clear();
    logger.info('WriteWorkerPool closed');
  }
}

