/**
 * Unit tests for the GroupCommit state machine in write-worker.ts.
 *
 * GroupCommit accumulates per-shard writes and flushes them in a single
 * BEGIN IMMEDIATE ... COMMIT transaction. Its connection lookup and response
 * poster are injected, so these tests use a fake database and a synchronous
 * flush hook to exercise every branch deterministically without spawning a
 * real worker thread.
 */
import { describe, it, expect, vi } from 'vitest';
import { GroupCommit, parseWriteMessage } from '../storage/write-worker';

interface FakeDb {
  exec: (sql: string) => void;
  execCalls: string[];
}

function makeFakeDb(): FakeDb {
  const db: FakeDb = {
    execCalls: [],
    exec(sql: string) {
      db.execCalls.push(sql);
    },
  };
  return db;
}

describe('GroupCommit', () => {
  it('flushes a single write as one BEGIN IMMEDIATE transaction', () => {
    const db = makeFakeDb();
    const posted: any[] = [];
    const gc = new GroupCommit(
      () => db as any,
      (msg) => posted.push(msg),
      (cb) => cb(),
    );

    gc.enqueue(1, 0, ['INSERT INTO t VALUES (1)']);
    gc.flushAll();

    expect(db.execCalls).toHaveLength(1);
    expect(db.execCalls[0]).toContain('BEGIN IMMEDIATE');
    expect(db.execCalls[0]).toContain('INSERT INTO t VALUES (1)');
    expect(db.execCalls[0]).toContain('COMMIT');
    expect(posted).toEqual([{ taskId: 1, changes: 1 }]);
  });

  it('batch-flushes multiple writes for the same shard into one transaction', () => {
    const db = makeFakeDb();
    const posted: any[] = [];
    let scheduledCb: (() => void) | null = null;
    const gc = new GroupCommit(
      () => db as any,
      (msg) => posted.push(msg),
      (cb) => { scheduledCb = cb; },
    );

    gc.enqueue(1, 0, ['INSERT INTO t VALUES (1)']);
    gc.enqueue(2, 0, ['INSERT INTO t VALUES (2)']);

    expect(gc.pendingShards).toBe(1);
    scheduledCb!();
    expect(db.execCalls).toHaveLength(1);
    expect(posted).toEqual([
      { taskId: 1, changes: 1 },
      { taskId: 2, changes: 1 },
    ]);
  });

  it('flushes distinct shards in separate transactions', () => {
    const db0 = makeFakeDb();
    const db1 = makeFakeDb();
    const conns: Record<number, any> = { 0: db0, 1: db1 };
    const posted: any[] = [];
    let scheduledCb: (() => void) | null = null;
    const gc = new GroupCommit(
      (shardId) => conns[shardId],
      (msg) => posted.push(msg),
      (cb) => { scheduledCb = cb; },
    );

    gc.enqueue(1, 0, ['INSERT INTO a VALUES (1)']);
    gc.enqueue(2, 1, ['INSERT INTO b VALUES (2)']);

    expect(gc.pendingShards).toBe(2);
    scheduledCb!();
    expect(db0.execCalls).toHaveLength(1);
    expect(db1.execCalls).toHaveLength(1);
    expect(posted).toHaveLength(2);
  });

  it('posts an error when the shard connection is unavailable', () => {
    const posted: any[] = [];
    const gc = new GroupCommit(
      () => undefined,
      (msg) => posted.push(msg),
      (cb) => cb(),
    );

    gc.enqueue(1, 42, ['INSERT INTO t VALUES (1)']);
    gc.flushAll();

    expect(posted).toEqual([
      { taskId: 1, changes: 0, error: 'Shard 42 N/A' },
    ]);
  });

  it('posts per-task errors when the transaction throws', () => {
    const failingDb = {
      execCalls: [] as string[],
      exec() {
        throw new Error('disk full');
      },
    };
    const posted: any[] = [];
    const gc = new GroupCommit(
      () => failingDb as any,
      (msg) => posted.push(msg),
      (cb) => cb(),
    );

    gc.enqueue(1, 0, ['INSERT INTO t VALUES (1)']);
    gc.enqueue(2, 0, ['INSERT INTO t VALUES (2)']);
    gc.flushAll();

    expect(posted).toEqual([
      { taskId: 1, changes: 0, error: 'disk full' },
      { taskId: 2, changes: 0, error: 'disk full' },
    ]);
  });

  it('posts each task with its own changes count for a batch write', () => {
    const db = makeFakeDb();
    const posted: any[] = [];
    const gc = new GroupCommit(
      () => db as any,
      (msg) => posted.push(msg),
      (cb) => cb(),
    );

    // A batch write carries multiple sqls for a single taskId.
    gc.enqueue(7, 0, ['INSERT 1', 'INSERT 2', 'INSERT 3']);
    gc.flushAll();

    expect(posted).toEqual([{ taskId: 7, changes: 3 }]);
  });

  it('clears the pending queue after flush (no leaked empty-array key)', () => {
    const db = makeFakeDb();
    let scheduledCb: (() => void) | null = null;
    const gc = new GroupCommit(
      () => db as any,
      () => {},
      (cb) => { scheduledCb = cb; },
    );

    gc.enqueue(1, 0, ['INSERT INTO t VALUES (1)']);
    expect(gc.pendingShards).toBe(1);
    scheduledCb!();
    expect(gc.pendingShards).toBe(0);
  });

  it('schedules a flush once and coalesces multiple enqueues', () => {
    const db = makeFakeDb();
    let scheduledCb: (() => void) | null = null;
    const gc = new GroupCommit(
      () => db as any,
      () => {},
      (cb) => {
        // Capture rather than run immediately, to assert single scheduling.
        scheduledCb = cb;
      },
    );

    gc.enqueue(1, 0, ['INSERT 1']);
    gc.enqueue(2, 0, ['INSERT 2']);
    // The second enqueue must NOT schedule a second flush.
    expect(scheduledCb).toBeInstanceOf(Function);

    // Now run the captured flush callback.
    scheduledCb!();
    expect(gc.pendingShards).toBe(0);
    expect(db.execCalls).toHaveLength(1);
  });

  it('skips flush work when there are no pending shards', () => {
    const posted: any[] = [];
    const gc = new GroupCommit(
      () => makeFakeDb() as any,
      (msg) => posted.push(msg),
      (cb) => cb(),
    );

    gc.flushAll();
    expect(posted).toEqual([]);
  });
});

describe('parseWriteMessage', () => {
  it('rejects a missing or non-numeric taskId', () => {
    expect(parseWriteMessage(null)).toEqual({ error: 'Missing taskId' });
    expect(parseWriteMessage(undefined)).toEqual({ error: 'Missing taskId' });
    expect(parseWriteMessage({})).toEqual({ error: 'Missing taskId' });
    expect(parseWriteMessage({ taskId: 'x' })).toEqual({ error: 'Missing taskId' });
  });

  it('accepts a non-empty sqls array', () => {
    expect(parseWriteMessage({ taskId: 1, sqls: ['A', 'B'] })).toEqual({
      sqls: ['A', 'B'],
    });
  });

  it('falls back to a single sql string when sqls is empty', () => {
    expect(parseWriteMessage({ taskId: 1, sql: 'INSERT 1' })).toEqual({
      sqls: ['INSERT 1'],
    });
  });

  it('rejects an empty sqls array with no sql', () => {
    expect(parseWriteMessage({ taskId: 1, sqls: [] })).toEqual({
      error: 'No sql or sqls',
    });
    expect(parseWriteMessage({ taskId: 1 })).toEqual({ error: 'No sql or sqls' });
  });
});
