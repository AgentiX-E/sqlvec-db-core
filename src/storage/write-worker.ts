/**
 * write-worker.ts — Dedicated worker thread for SQLite writes
 *
 * Supports single writes, batch writes, and group commit.
 * Group commit accumulates writes across multiple messages and flushes
 * them in a single BEGIN IMMEDIATE ... COMMIT transaction per shard,
 * sharing one fsync across many client COMMITs.
 *
 * Protocol:
 *   Single:  { taskId, shardId, sql }
 *   Batch:   { taskId, shardId, sqls: string[] }
 *   Response:{ taskId, changes, error? }
 *
 * Flush trigger: setImmediate (next microtask tick, ~0-1ms delay)
 * This allows multiple incoming messages to coalesce before the flush.
 *
 * The group-commit state machine is extracted into an exported `GroupCommit`
 * class so the core logic is unit-testable without spawning a real worker
 * thread. The worker bootstrap at the bottom only wires `parentPort` to it.
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

export interface WorkerInitData {
  shardPaths: Record<number, string>;
}

interface PendingTask {
  taskId: number;
  shardId: number;
  sqls: string[];  // single writes are stored as [sql]
}

export interface WriteMessage {
  taskId: number;
  shardId: number;
  sql?: string;
  sqls?: string[];
}

export interface WriteResponse {
  taskId: number;
  changes: number;
  error?: string;
  type?: 'ready';
}

/**
 * Group-commit queue. Accumulates writes per shard and flushes them in a single
 * BEGIN IMMEDIATE ... COMMIT transaction. Dependencies (the per-shard SQLite
 * connection lookup and the response poster) are injected so the class can be
 * unit-tested against a fake database.
 */
export class GroupCommit {
  private pendingByShard = new Map<number, PendingTask[]>();
  private flushScheduled = false;

  constructor(
    private readonly getConnection: (shardId: number) => Database.Database | undefined,
    private readonly post: (msg: WriteResponse) => void,
    private readonly flushImpl: typeof setImmediate = setImmediate,
  ) {}

  /** Queue a single write (or batch) for group commit. */
  enqueue(taskId: number, shardId: number, sqls: string[]): void {
    let queue = this.pendingByShard.get(shardId);
    if (!queue) {
      queue = [];
      this.pendingByShard.set(shardId, queue);
    }
    queue.push({ taskId, shardId, sqls });
    this.scheduleFlush();
  }

  /** Number of shards with queued (not yet flushed) writes. */
  get pendingShards(): number {
    return this.pendingByShard.size;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.flushImpl(() => {
      this.flushScheduled = false;
      this.flushAll();
    });
  }

  /** Flush all queued writes now (synchronous), one transaction per shard. */
  flushAll(): void {
    for (const [shardId, tasks] of this.pendingByShard) {
      if (tasks.length === 0) continue;
      // Remove the shard's queue entirely so pendingShards reflects the true
      // post-flush state (previously this set an empty array, leaking a key).
      this.pendingByShard.delete(shardId);

      const db = this.getConnection(shardId);
      if (!db) {
        for (const t of tasks) {
          this.post({ taskId: t.taskId, changes: 0, error: `Shard ${shardId} N/A` });
        }
        continue;
      }

      try {
        const allSqls: string[] = [];
        for (const t of tasks) {
          allSqls.push(...t.sqls);
        }
        const batch = allSqls.join(';\n');
        db.exec(`BEGIN IMMEDIATE;\n${batch};\nCOMMIT;`);

        for (const t of tasks) {
          this.post({ taskId: t.taskId, changes: t.sqls.length });
        }
  /* v8 ignore next -- catch is defensive fallback */
      } catch (err: any) {
        for (const t of tasks) {
          this.post({ taskId: t.taskId, changes: 0, error: err.message || String(err) });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
//  Worker bootstrap (runs only inside a worker thread)
// ─────────────────────────────────────────────────────────────

export function parseWriteMessage(raw: any): { sqls: string[] } | { error: string } {
  if (!raw || typeof raw.taskId !== 'number') {
    return { error: 'Missing taskId' };
  }
  if (raw.sqls && Array.isArray(raw.sqls) && raw.sqls.length > 0) {
    return { sqls: raw.sqls };
  }
  if (raw.sql) {
    return { sqls: [raw.sql] };
  }
  return { error: 'No sql or sqls' };
}

if (parentPort) {
  const initData = (workerData ?? {}) as WorkerInitData;
  const shardPaths = initData.shardPaths ?? {};

  // ── Persistent database connections ──
  const connections = new Map<number, Database.Database>();
  for (const [shardIdStr, dbPath] of Object.entries(shardPaths)) {
    const shardId = Number(shardIdStr);
    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 5000');
      connections.set(shardId, db);
  /* v8 ignore next -- catch is defensive fallback */
    } catch (err: any) {
      parentPort!.postMessage({
        taskId: -1,
        changes: 0,
        error: `Failed to open shard ${shardId}: ${err.message}`,
      });
    }
  }

  const commit = new GroupCommit(
    (shardId) => connections.get(shardId),
    (msg) => parentPort!.postMessage(msg),
  );

  // Signal ready
  parentPort!.postMessage({ type: 'ready' });

  parentPort!.on('message', (raw: any) => {
    if (!raw || typeof raw.taskId !== 'number') return;
    const parsed = parseWriteMessage(raw);
    if ('error' in parsed) {
      parentPort!.postMessage({ taskId: raw.taskId, changes: 0, error: parsed.error });
      return;
    }
    commit.enqueue(raw.taskId, raw.shardId, parsed.sqls);
  });

  // ── Cleanup ──
  process.on('exit', () => {
    for (const [, db] of connections) {
      try { db.close(); } catch { /* best-effort */ }
    }
    connections.clear();
  });
}
