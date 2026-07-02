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
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';

interface WorkerInitData {
  shardPaths: Record<number, string>;
}

interface PendingTask {
  taskId: number;
  shardId: number;
  sqls: string[];  // single writes are stored as [sql]
}

// ── Persistent database connections ──
const connections = new Map<number, Database.Database>();
const initData = workerData as WorkerInitData;

for (const [shardIdStr, dbPath] of Object.entries(initData.shardPaths)) {
  const shardId = Number(shardIdStr);
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    connections.set(shardId, db);
  } catch (err: any) {
    parentPort!.postMessage({
      taskId: -1,
      changes: 0,
      error: `Failed to open shard ${shardId}: ${err.message}`,
    });
  }
}

// Signal ready
parentPort!.postMessage({ type: 'ready' });

// ── Group commit state ──
const pendingByShard = new Map<number, PendingTask[]>();
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  // setImmediate runs after all pending I/O callbacks, allowing
  // multiple postMessage events to accumulate before flush.
  setImmediate(() => {
    flushScheduled = false;
    flushAll();
  });
}

function flushAll(): void {
  for (const [shardId, tasks] of pendingByShard) {
    if (tasks.length === 0) continue;
    pendingByShard.set(shardId, []);

    const db = connections.get(shardId);
    if (!db) {
      for (const t of tasks) {
        parentPort!.postMessage({ taskId: t.taskId, changes: 0, error: `Shard ${shardId} N/A` });
      }
      continue;
    }

    try {
      // Collect all SQLs from all pending tasks
      const allSqls: string[] = [];
      for (const t of tasks) {
        allSqls.push(...t.sqls);
      }

      // Execute in single transaction
      const batch = allSqls.join(';\n');
      db.exec(`BEGIN IMMEDIATE;\n${batch};\nCOMMIT;`);

      // All tasks succeeded
      for (const t of tasks) {
        parentPort!.postMessage({ taskId: t.taskId, changes: t.sqls.length });
      }
    } catch (err: any) {
      // Transaction failed — all tasks in this batch failed
      for (const t of tasks) {
        parentPort!.postMessage({ taskId: t.taskId, changes: 0, error: err.message || String(err) });
      }
    }
  }
}

// ── Message handler ──
parentPort!.on('message', (raw: any) => {
  if (!raw || typeof raw.taskId !== 'number') return;

  const shardId = raw.shardId;

  let sqls: string[];
  if (raw.sqls && Array.isArray(raw.sqls) && raw.sqls.length > 0) {
    sqls = raw.sqls;
  } else if (raw.sql) {
    sqls = [raw.sql];
  } else {
    parentPort!.postMessage({ taskId: raw.taskId, changes: 0, error: 'No sql or sqls' });
    return;
  }

  // Queue for group commit
  let queue = pendingByShard.get(shardId);
  if (!queue) { queue = []; pendingByShard.set(shardId, queue); }
  queue.push({ taskId: raw.taskId, shardId, sqls });

  scheduleFlush();
});

// ── Cleanup ──
process.on('exit', () => {
  for (const [, db] of connections) {
    try { db.close(); } catch { /* best-effort */ }
  }
  connections.clear();
});