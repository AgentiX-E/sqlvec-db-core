import { describe, it, expect, vi } from 'vitest';
import { GroupCommit } from '../storage/write-worker';

/**
 * Unit tests for the GroupCommit state machine extracted from write-worker.ts.
 * A fake `getConnection` + `post` spy drive the flush logic without a real
 * SQLite connection or worker thread.
 */

type FakeDb = {
  exec: ReturnType<typeof vi.fn>;
};

function makeQueue(getConnection: (shardId: number) => any) {
  const posted: any[] = [];
  const post = (msg: any) => posted.push(msg);
  const queue = new GroupCommit(getConnection, post);
  return { queue, posted, post };
}

describe('GroupCommit', () => {
  it('queues writes and flushes them grouped by shard', () => {
    const exec = vi.fn();
    const { queue, posted, post } = makeQueue((shardId) => ({ exec }) as any);

    queue.enqueue(1, 0, ['INSERT INTO t VALUES (1)']);
    queue.enqueue(2, 1, ['INSERT INTO t VALUES (2)']);
    queue.flushAll();

    // Each shard flushed in its own transaction.
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls[0][0]).toContain('BEGIN IMMEDIATE');
    expect(exec.mock.calls[0][0]).toContain('INSERT INTO t VALUES (1)');
    expect(exec.mock.calls[1][0]).toContain('INSERT INTO t VALUES (2)');

    // Each task acknowledged with its SQL count.
    expect(posted).toEqual([
      { taskId: 1, changes: 1 },
      { taskId: 2, changes: 1 },
    ]);
  });

  it('coalesces multiple writes to the same shard into one transaction', () => {
    const exec = vi.fn();
    const { queue, posted } = makeQueue(() => ({ exec }) as any);

    queue.enqueue(1, 0, ['A']);
    queue.enqueue(2, 0, ['B', 'C']);
    queue.enqueue(3, 0, ['D']);
    queue.flushAll();

    // A single shard → a single transaction containing all three tasks' SQL.
    expect(exec).toHaveBeenCalledTimes(1);
    const batch = exec.mock.calls[0][0];
    expect(batch).toContain('A');
    expect(batch).toContain('B');
    expect(batch).toContain('C');
    expect(batch).toContain('D');
    expect(posted).toEqual([
      { taskId: 1, changes: 1 },
      { taskId: 2, changes: 2 },
      { taskId: 3, changes: 1 },
    ]);
  });

  it('reports an error for a shard with no connection', () => {
    const { queue, posted } = makeQueue(() => undefined);

    queue.enqueue(9, 7, ['X']);
    queue.flushAll();

    expect(posted).toEqual([
      { taskId: 9, changes: 0, error: 'Shard 7 N/A' },
    ]);
  });

  it('rejects every task in a shard batch when the transaction throws', () => {
    const exec = vi.fn(() => {
      throw new Error('SQLITE_BUSY');
    });
    const { queue, posted } = makeQueue(() => ({ exec }) as any);

    queue.enqueue(1, 0, ['A']);
    queue.enqueue(2, 0, ['B']);
    queue.flushAll();

    expect(posted).toEqual([
      { taskId: 1, changes: 0, error: 'SQLITE_BUSY' },
      { taskId: 2, changes: 0, error: 'SQLITE_BUSY' },
    ]);
  });

  it('does not flush a shard with zero queued writes', () => {
    const exec = vi.fn();
    const { queue } = makeQueue(() => ({ exec }) as any);
    queue.flushAll();
    expect(exec).not.toHaveBeenCalled();
  });

  it('schedules a flush only once for multiple enqueues', () => {
    const exec = vi.fn();
    const { queue } = makeQueue(() => ({ exec }) as any);

    const scheduled: Function[] = [];
    const flushImpl = ((fn: Function) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;

    const posted: any[] = [];
    const q2 = new GroupCommit(() => ({ exec }) as any, (m) => posted.push(m), flushImpl);

    q2.enqueue(1, 0, ['A']);
    q2.enqueue(2, 0, ['B']);
    q2.enqueue(3, 1, ['C']);

    // Only one flush callback should have been scheduled despite 3 enqueues.
    expect(scheduled).toHaveLength(1);

    // Manually invoke the scheduled flush and verify it drained both shards.
    scheduled[0]();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('clears queued tasks after a successful flush', () => {
    const exec = vi.fn();
    const { queue, posted } = makeQueue(() => ({ exec }) as any);

    queue.enqueue(1, 0, ['A']);
    queue.flushAll();
    expect(queue.pendingShards).toBe(0);

    // A second flush is a no-op.
    queue.flushAll();
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
