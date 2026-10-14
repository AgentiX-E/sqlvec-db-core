import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Piscina } from 'piscina';

// Mock Piscina so tests never spawn real worker threads.
const mockRun = vi.fn();
vi.mock('piscina', () => {
  return {
    Piscina: class {
      filename: string;
      maxThreads: number;
      constructor(opts: any) {
        this.filename = opts.filename;
        this.maxThreads = opts.maxThreads;
      }
      run(task: any) {
        return mockRun(task);
      }
      async destroy() {}
    },
  };
});

import {
  ParallelExecutor,
  type ParallelTaskResult,
} from '../query/ParallelExecutor';

function makeResult(overrides: Partial<ParallelTaskResult> = {}): ParallelTaskResult {
  return {
    rows: [],
    rowCount: 0,
    shardId: 0,
    queryTimeMs: 0,
    error: null,
    ...overrides,
  };
}

describe('ParallelExecutor.shouldUseParallel (static)', () => {
  it('returns false when shardCount < 2', () => {
    expect(ParallelExecutor.shouldUseParallel('SELECT 1', { minRows: 99999, shardCount: 1 })).toBe(false);
    expect(ParallelExecutor.shouldUseParallel('SELECT 1', { minRows: 99999, shardCount: 0 })).toBe(false);
  });

  it('returns true for a pg parallel hint', () => {
    expect(ParallelExecutor.shouldUseParallel('/*+ PARALLEL(4) */ SELECT * FROM t', { minRows: 0, shardCount: 2 })).toBe(true);
  });

  it('returns true for SET parallel_workers', () => {
    expect(ParallelExecutor.shouldUseParallel('SET parallel_workers = 4', { minRows: 0, shardCount: 2 })).toBe(true);
  });

  it('returns true for SET pgParallelWorkers', () => {
    expect(ParallelExecutor.shouldUseParallel('SET pgParallelWorkers=2', { minRows: 0, shardCount: 4 })).toBe(true);
  });

  it('returns false for small minRows without hint', () => {
    expect(ParallelExecutor.shouldUseParallel('SELECT * FROM t', { minRows: 100, shardCount: 4 })).toBe(false);
  });

  it('returns true for large minRows without hint', () => {
    expect(ParallelExecutor.shouldUseParallel('SELECT * FROM t', { minRows: 20000, shardCount: 4 })).toBe(true);
  });

  it('returns false at exactly minRows 10000 without hint', () => {
    expect(ParallelExecutor.shouldUseParallel('SELECT * FROM t', { minRows: 10000, shardCount: 4 })).toBe(false);
  });
});

describe('ParallelExecutor instance shouldUseParallel', () => {
  it('uses configured minRows default when config omitted', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    ex.setParallelConfig({ minRows: 5, maxWorkers: 2 });
    // query has hint -> true regardless
    expect(ex.shouldUseParallel('/*+ PARALLEL(2) */ SELECT 1')).toBe(true);
    // no hint, minRows=5 -> 5 > 10000 false
    expect(ex.shouldUseParallel('SELECT 1')).toBe(false);
    ex.destroy();
  });

  it('uses caller minRows when provided', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    expect(ex.shouldUseParallel('SELECT 1', { minRows: 20000 })).toBe(true);
    expect(ex.shouldUseParallel('SELECT 1', { minRows: 100, shardCount: 4 })).toBe(false);
    ex.destroy();
  });
});

describe('ParallelExecutor.effectiveWorkers (static)', () => {
  it('caps at shard count', () => {
    expect(ParallelExecutor.effectiveWorkers(8, 3)).toBe(3);
    expect(ParallelExecutor.effectiveWorkers(2, 5)).toBe(2);
    expect(ParallelExecutor.effectiveWorkers(0, 5)).toBe(0);
  });
});

describe('ParallelExecutor.mergeDmlResults (static)', () => {
  it('sums changes and takes min lastInsertRowid for insert', () => {
    const results = [
      makeResult({ changes: 3, lastInsertRowid: 100 }),
      makeResult({ changes: 2, lastInsertRowid: 50 }),
    ];
    expect(ParallelExecutor.mergeDmlResults(results, 'insert')).toEqual({
      totalChanges: 5,
      lastInsertRowid: 50,
      errorCount: 0,
    });
  });

  it('skips errored results and counts them', () => {
    const results = [
      makeResult({ changes: 3 }),
      makeResult({ error: 'boom' }),
      makeResult({ changes: 1 }),
    ];
    expect(ParallelExecutor.mergeDmlResults(results, 'update')).toEqual({
      totalChanges: 4,
      lastInsertRowid: undefined,
      errorCount: 1,
    });
  });

  it('does not compute lastInsertRowid for non-insert types', () => {
    const results = [makeResult({ changes: 5, lastInsertRowid: 7 })];
    expect(ParallelExecutor.mergeDmlResults(results, 'delete')).toEqual({
      totalChanges: 5,
      lastInsertRowid: undefined,
      errorCount: 0,
    });
  });

  it('treats undefined changes as 0', () => {
    const results = [makeResult({}), makeResult({ changes: 2 })];
    expect(ParallelExecutor.mergeDmlResults(results, 'update')).toEqual({
      totalChanges: 2,
      lastInsertRowid: undefined,
      errorCount: 0,
    });
  });

  it('handles empty results', () => {
    expect(ParallelExecutor.mergeDmlResults([], 'insert')).toEqual({
      totalChanges: 0,
      lastInsertRowid: undefined,
      errorCount: 0,
    });
  });

  it('keeps the minimum lastInsertRowid across non-decreasing inserts', () => {
    const results = [
      makeResult({ changes: 1, lastInsertRowid: 100 }),
      makeResult({ changes: 1, lastInsertRowid: 200 }),
      makeResult({ changes: 1, lastInsertRowid: 150 }),
    ];
    expect(ParallelExecutor.mergeDmlResults(results, 'insert')).toEqual({
      totalChanges: 3,
      lastInsertRowid: 100,
      errorCount: 0,
    });
  });

  it('skips lastInsertRowid when undefined in mixed inserts', () => {
    const results = [
      makeResult({ changes: 1 }), // no lastInsertRowid
      makeResult({ changes: 1, lastInsertRowid: 42 }),
    ];
    expect(ParallelExecutor.mergeDmlResults(results, 'insert')).toEqual({
      totalChanges: 2,
      lastInsertRowid: 42,
      errorCount: 0,
    });
  });
});

describe('ParallelExecutor config', () => {
  it('defaults minRows 10000 and maxWorkers 4', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    expect(ex.getParallelConfig()).toEqual({ minRows: 10000, maxWorkers: 4 });
    ex.destroy();
  });

  it('sets minRows and maxWorkers', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    ex.setParallelConfig({ minRows: 5000, maxWorkers: 8 });
    expect(ex.getParallelConfig()).toEqual({ minRows: 5000, maxWorkers: 8 });
    ex.destroy();
  });

  it('throws on negative minRows', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    expect(() => ex.setParallelConfig({ minRows: -1 })).toThrow(/non-negative/);
    ex.destroy();
  });

  it('throws on maxWorkers < 1', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    expect(() => ex.setParallelConfig({ maxWorkers: 0 })).toThrow(/at least 1/);
    ex.destroy();
  });

  it('warns (but accepts) maxWorkers > 64', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    ex.setParallelConfig({ maxWorkers: 100 });
    expect(ex.getParallelConfig().maxWorkers).toBe(100);
    ex.destroy();
  });

  it('partial config only updates provided fields', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    ex.setParallelConfig({ minRows: 3 });
    expect(ex.getParallelConfig()).toEqual({ minRows: 3, maxWorkers: 4 });
    ex.destroy();
  });

  it('returns a defensive copy', () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    const c = ex.getParallelConfig();
    c.minRows = 999;
    expect(ex.getParallelConfig().minRows).toBe(10000);
    ex.destroy();
  });
});

describe('ParallelExecutor lifecycle', () => {
  it('reports pool size', () => {
    const ex = new ParallelExecutor({ maxThreads: 6 });
    expect(ex.poolSize).toBe(6);
    ex.destroy();
  });

  it('defaults maxThreads to cpu count', () => {
    const ex = new ParallelExecutor({});
    expect(ex.poolSize).toBeGreaterThanOrEqual(1);
    ex.destroy();
  });

  it('isDestroyed false before destroy, true after', async () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    expect(ex.isDestroyed).toBe(false);
    await ex.destroy();
    expect(ex.isDestroyed).toBe(true);
  });

  it('destroy is idempotent', async () => {
    const ex = new ParallelExecutor({ maxThreads: 1 });
    await ex.destroy();
    await ex.destroy();
    expect(ex.isDestroyed).toBe(true);
  });
});

describe('ParallelExecutor.executeParallel', () => {
  let ex: ParallelExecutor;
  beforeEach(() => {
    mockRun.mockReset();
    ex = new ParallelExecutor({ maxThreads: 2 });
  });
  afterEach(async () => { await ex.destroy(); });

  it('returns empty array for empty tasks', async () => {
    expect(await ex.executeParallel([])).toEqual([]);
  });

  it('throws when destroyed', async () => {
    await ex.destroy();
    await expect(ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/x' }]))
      .rejects.toThrow(/destroyed/);
  });

  it('runs tasks and preserves order', async () => {
    mockRun
      .mockResolvedValueOnce(makeResult({ shardId: 0, rowCount: 1 }))
      .mockResolvedValueOnce(makeResult({ shardId: 1, rowCount: 2 }));
    const results = await ex.executeParallel([
      { sql: 'SELECT 1', shardId: 0, dbPath: '/a' },
      { sql: 'SELECT 2', shardId: 1, dbPath: '/b' },
    ]);
    expect(results.map(r => r.shardId)).toEqual([0, 1]);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('wraps a rejected worker into an error result', async () => {
    mockRun.mockResolvedValueOnce(makeResult({ shardId: 0 }))
      .mockRejectedValueOnce(new Error('worker blew up'));
    const results = await ex.executeParallel([
      { sql: 'SELECT 1', shardId: 0, dbPath: '/a' },
      { sql: 'SELECT 2', shardId: 1, dbPath: '/b' },
    ]);
    expect(results[0].error).toBeNull();
    expect(results[1].error).toBe('worker blew up');
    expect(results[1].rows).toEqual([]);
  });

  it('wraps a non-Error rejection reason', async () => {
    mockRun.mockRejectedValueOnce('some string reason');
    const results = await ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/a' }]);
    expect(results[0].error).toBe('some string reason');
  });

  it('falls back to generic message when rejection reason.message is falsy', async () => {
    mockRun.mockRejectedValueOnce({ message: '' });
    const results = await ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/a' }]);
    expect(results[0].error).toBe('Unknown worker error');
  });

  it('falls back to generic message when rejection reason is a plain object without message', async () => {
    mockRun.mockRejectedValueOnce({ foo: 'bar' });
    const results = await ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/a' }]);
    expect(results[0].error).toBe('Unknown worker error');
  });

  it('uses rejection reason.message when it is a non-empty string', async () => {
    mockRun.mockRejectedValueOnce({ message: 'real error text' });
    const results = await ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/a' }]);
    expect(results[0].error).toBe('real error text');
  });

  it('passes default timeoutMs and taskType to worker', async () => {
    mockRun.mockResolvedValue(makeResult({}));
    await ex.executeParallel([{ sql: 'SELECT 1', shardId: 0, dbPath: '/a' }]);
    const task = mockRun.mock.calls[0][0];
    expect(task.timeoutMs).toBe(30000);
    expect(task.taskType).toBe('select');
    expect(task.sql).toBe('SELECT 1');
  });
});

describe('ParallelExecutor.scanTableIntraParallel', () => {
  let ex: ParallelExecutor;
  beforeEach(() => {
    mockRun.mockReset();
    ex = new ParallelExecutor({ maxThreads: 2 });
  });
  afterEach(async () => { await ex.destroy(); });

  it('throws when destroyed', async () => {
    await ex.destroy();
    await expect(ex.scanTableIntraParallel({ tableName: 't', dbPath: '/x' }))
      .rejects.toThrow(/destroyed/);
  });

  it('uses caller-supplied rowidRange without hitting the database', async () => {
    mockRun.mockResolvedValue(makeResult({ rows: [{ id: 1 }], rowCount: 1 }));
    const results = await ex.scanTableIntraParallel({
      tableName: 't',
      dbPath: '/x',
      rowidRange: { min: 1, max: 10 },
      numWorkers: 2,
    });
    expect(mockRun).toHaveBeenCalledTimes(2);
    // segment 0: min 1, max ... , segment 1: last segment max 10
    const t0 = mockRun.mock.calls[0][0];
    const t1 = mockRun.mock.calls[1][0];
    expect(t0.scanMode).toBe('intra-table');
    expect(t0.rowidRange.min).toBe(1);
    expect(t1.rowidRange.max).toBe(10);
    expect(t1.rowidRange.min).toBeGreaterThan(t0.rowidRange.min);
    expect(results).toHaveLength(2);
  });

  it('caps workers to the rowid range size', async () => {
    mockRun.mockResolvedValue(makeResult({}));
    // range size 2, but request 10 workers -> actualWorkers = 2
    await ex.scanTableIntraParallel({
      tableName: 't',
      dbPath: '/x',
      rowidRange: { min: 1, max: 2 },
      numWorkers: 10,
    });
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('single-row range dispatches one worker', async () => {
    mockRun.mockResolvedValue(makeResult({}));
    await ex.scanTableIntraParallel({
      tableName: 't',
      dbPath: '/x',
      rowidRange: { min: 5, max: 5 },
      numWorkers: 4,
    });
    expect(mockRun).toHaveBeenCalledTimes(1);
    const t = mockRun.mock.calls[0][0];
    expect(t.rowidRange).toEqual({ min: 5, max: 5 });
  });

  it('queries the database for rowid range when not supplied', async () => {
    const Database = await import('better-sqlite3');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
    const dbPath = path.join(dir, 't.sqlite');
    const db = new Database.default(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.exec("INSERT INTO t (v) VALUES ('a'),('b'),('c'),('d'),('e')");
    db.close();

    mockRun.mockResolvedValue(makeResult({}));
    await ex.scanTableIntraParallel({ tableName: 't', dbPath, numWorkers: 2 });

    // two workers dispatched, segment 0 starts at min rowid 1, last segment ends at 5
    expect(mockRun).toHaveBeenCalledTimes(2);
    const t0 = mockRun.mock.calls[0][0];
    const t1 = mockRun.mock.calls[1][0];
    expect(t0.rowidRange.min).toBe(1);
    expect(t1.rowidRange.max).toBe(5);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for an empty table (null min/max rowid)', async () => {
    const Database = await import('better-sqlite3');
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
    const dbPath = path.join(dir, 'empty.sqlite');
    const db = new Database.default(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.close();

    const results = await ex.scanTableIntraParallel({ tableName: 't', dbPath, numWorkers: 4 });
    expect(results).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to a single error result when the database query fails', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-'));
    const dbPath = path.join(dir, 'nonexistent.sqlite'); // never created

    const results = await ex.scanTableIntraParallel({ tableName: 't', dbPath, numWorkers: 2 });
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain('Failed to query rowid range');
    expect(mockRun).not.toHaveBeenCalled();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
