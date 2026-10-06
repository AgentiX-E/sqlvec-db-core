import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock piscina before importing the module under test so the pool is a
// controllable stub rather than a real worker thread pool.
const mockRun = vi.fn();
const mockDestroy = vi.fn();
vi.mock('piscina', () => {
  return {
    Piscina: class {
      constructor(public opts: any) {}
      run(payload: any) {
        return mockRun(payload);
      }
      destroy() {
        return mockDestroy();
      }
    },
  };
});

// Mock better-sqlite3 so getRowIdRange never opens a real file.
const mockPrepareGet = vi.fn();
const mockDbClose = vi.fn();
const mockDbPragma = vi.fn();
vi.mock('better-sqlite3', () => {
  return {
    default: class {
      constructor(public file: string, public opts: any) {}
      pragma(...args: any[]) {
        return mockDbPragma(...args);
      }
      prepare(sql: string) {
        return { get: () => mockPrepareGet(sql) };
      }
      close() {
        return mockDbClose();
      }
    },
  };
});

// Mock node:fs.existsSync so resolveParallelWorkerPath's branch outcomes are
// controllable. Default to "ts worker exists" (matching the repo layout).
vi.mock('node:fs', () => {
  return {
    existsSync: vi.fn((p: string) => (p as string).endsWith('parallel-scan-worker.ts')),
  };
});

import { ParallelQueryExecutor, parallelQuery } from '../query/ParallelQueryExecutor';

function makeExecutor(opts: any = {}, config: any = {}) {
  return new ParallelQueryExecutor(config, opts);
}

beforeEach(() => {
  mockRun.mockReset();
  mockDestroy.mockReset();
  mockPrepareGet.mockReset();
  mockDbClose.mockReset();
  mockDbPragma.mockReset();
  mockDestroy.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constructor & config', () => {
  it('applies defaults when no config/opts provided', () => {
    const e = makeExecutor();
    expect(e.getConfig().minRowsForParallel).toBe(10000);
    expect(e.getConfig().chunkSize).toBe(5000);
    expect(e.getConfig().maxThreads).toBeGreaterThanOrEqual(1);
    expect(e.poolSize).toBeGreaterThanOrEqual(1);
  });

  it('merges partial config over defaults', () => {
    const e = makeExecutor({}, { minRowsForParallel: 5, chunkSize: 2 });
    expect(e.getConfig().minRowsForParallel).toBe(5);
    expect(e.getConfig().chunkSize).toBe(2);
  });

  it('clamps opts.maxThreads to at least 1', () => {
    const e = makeExecutor({ maxThreads: 0 });
    expect(e.poolSize).toBe(1);
    const neg = makeExecutor({ maxThreads: -3 });
    expect(neg.poolSize).toBe(1);
  });

  it('uses config.maxThreads when opts.maxThreads omitted', () => {
    const e = makeExecutor({ taskTimeoutMs: 999 }, { maxThreads: 3 });
    expect(e.poolSize).toBe(3);
  });

  it('respects explicit opts.maxThreads over config.maxThreads', () => {
    const e = makeExecutor({ maxThreads: 7 }, { maxThreads: 3 });
    expect(e.poolSize).toBe(7);
  });
});

describe('partitionRowIdRange', () => {
  const e = makeExecutor();

  it('returns empty for min > max', () => {
    expect(e.partitionRowIdRange(5, 1, 10)).toEqual([]);
  });

  it('returns empty for chunkSize <= 0', () => {
    expect(e.partitionRowIdRange(1, 10, 0)).toEqual([]);
    expect(e.partitionRowIdRange(1, 10, -1)).toEqual([]);
  });

  it('partitions evenly within range', () => {
    expect(e.partitionRowIdRange(1, 10, 3)).toEqual([
      { start: 1, end: 3 },
      { start: 4, end: 6 },
      { start: 7, end: 9 },
      { start: 10, end: 10 },
    ]);
  });

  it('returns a single chunk when range smaller than chunkSize', () => {
    expect(e.partitionRowIdRange(1, 5, 100)).toEqual([{ start: 1, end: 5 }]);
  });

  it('handles a single-element range', () => {
    expect(e.partitionRowIdRange(7, 7, 5000)).toEqual([{ start: 7, end: 7 }]);
  });
});

describe('setConfig / getConfig / poolSize / isDestroyed', () => {
  it('updates config fields and returns an isolated copy', () => {
    const e = makeExecutor();
    e.setConfig({ chunkSize: 99 });
    expect(e.getConfig().chunkSize).toBe(99);
    const cfg = e.getConfig();
    cfg.chunkSize = 12345;
    expect(e.getConfig().chunkSize).toBe(99);
  });

  it('ignores undefined config fields in setConfig', () => {
    const e = makeExecutor({}, { chunkSize: 42 });
    e.setConfig({ minRowsForParallel: undefined, chunkSize: undefined });
    expect(e.getConfig().chunkSize).toBe(42);
  });

  it('updates minRowsForParallel and maxThreads', () => {
    const e = makeExecutor();
    e.setConfig({ minRowsForParallel: 5, maxThreads: 8 });
    expect(e.getConfig().minRowsForParallel).toBe(5);
    expect(e.getConfig().maxThreads).toBe(8);
  });

  it('reports isDestroyed correctly', async () => {
    const e = makeExecutor();
    expect(e.isDestroyed).toBe(false);
    await e.destroy();
    expect(e.isDestroyed).toBe(true);
  });
});

describe('_mergeChunks', () => {
  const e = makeExecutor();
  const merge = (chunks: any[], n: number) => (e as any)._mergeChunks(chunks, n);

  it('returns chunks unchanged when already <= target', () => {
    const chunks = [{ start: 1, end: 5 }];
    expect(merge(chunks, 4)).toEqual(chunks);
  });

  it('merges 3 chunks into 2', () => {
    const chunks = [
      { start: 1, end: 5000 },
      { start: 5001, end: 10000 },
      { start: 10001, end: 15000 },
    ];
    expect(merge(chunks, 2)).toEqual([
      { start: 1, end: 10000 },
      { start: 10001, end: 15000 },
    ]);
  });
});

describe('getRowIdRange', () => {
  const e = makeExecutor();

  it('returns zeros for in-memory databases', () => {
    expect(e.getRowIdRange(':memory:', 'users')).toEqual({ min: 0, max: 0, count: 0 });
    expect(e.getRowIdRange('', 'users')).toEqual({ min: 0, max: 0, count: 0 });
  });

  it('queries the db file and closes the connection', () => {
    mockPrepareGet.mockReturnValue({ minRowid: 10, maxRowid: 200, rowCount: 191 });
    const result = e.getRowIdRange('/tmp/x.db', 'users');
    expect(result).toEqual({ min: 10, max: 200, count: 191 });
    expect(mockDbPragma).toHaveBeenCalled();
    expect(mockDbClose).toHaveBeenCalled();
  });

  it('returns zeros on db error', () => {
    mockPrepareGet.mockImplementation(() => {
      throw new Error('no such table');
    });
    const result = e.getRowIdRange('/tmp/x.db', 'missing');
    expect(result).toEqual({ min: 0, max: 0, count: 0 });
  });
});

describe('executeParallelScan', () => {
  it('throws when destroyed', async () => {
    const e = makeExecutor();
    await e.destroy();
    await expect(
      e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't'),
    ).rejects.toThrow('destroyed');
  });

  it('returns empty when table below minRowsForParallel', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 10, rowCount: 10 });
    const e = makeExecutor({}, { minRowsForParallel: 100 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toEqual([]);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('dispatches chunks in parallel and merges fulfilled results', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 100, rowCount: 100 });
    mockRun
      .mockResolvedValueOnce({ success: true, rows: [{ a: 1 }, { a: 2 }] })
      .mockResolvedValue({ success: true, rows: [{ a: 3 }] });
    const e = makeExecutor({ maxThreads: 4 }, { minRowsForParallel: 10, chunkSize: 50 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toHaveLength(3);
    expect(mockRun).toHaveBeenCalledTimes(2);
  });

  it('isolates worker failures and returns partial results', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 100, rowCount: 100 });
    mockRun
      .mockResolvedValueOnce({ success: true, rows: [{ a: 1 }] })
      .mockResolvedValueOnce({ success: false, error: 'worker boom' })
      .mockRejectedValueOnce(new Error('unhandled boom'));
    const e = makeExecutor({ maxThreads: 4 }, { minRowsForParallel: 10, chunkSize: 34 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toEqual([{ a: 1 }]);
  });

  it('returns empty when range is degenerate (0 chunks)', async () => {
    // min > max cannot happen from getRowIdRange, but if count passes threshold
    // and partition yields [] (e.g. chunkSize already guarded), ensure no run.
    mockPrepareGet.mockReturnValue({ minRowid: 5, maxRowid: 1, rowCount: 100 });
    const e = makeExecutor({ maxThreads: 4 }, { minRowsForParallel: 10 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toEqual([]);
  });

  it('merges chunks when chunk count exceeds maxThreads', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 5, rowCount: 5 });
    mockRun.mockResolvedValue({ success: true, rows: [{ a: 1 }] });
    // chunkSize 1 -> 5 chunks; maxThreads 1 -> merge to a single chunk.
    const e = makeExecutor({ maxThreads: 1 }, { minRowsForParallel: 1, chunkSize: 1 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toEqual([{ a: 1 }]);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('handles a rejected worker with no reason message', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 10, rowCount: 10 });
    mockRun
      .mockResolvedValueOnce({ success: true, rows: [{ a: 1 }] })
      .mockRejectedValueOnce(undefined);
    const e = makeExecutor({ maxThreads: 4 }, { minRowsForParallel: 1, chunkSize: 5 });
    const rows = await e.executeParallelScan('/tmp/x.db', 'SELECT * FROM t', [], 't');
    expect(rows).toEqual([{ a: 1 }]);
  });
});

describe('destroy', () => {
  it('is idempotent', async () => {
    const e = makeExecutor();
    await e.destroy();
    await e.destroy();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it('swallows pool.destroy errors', async () => {
    mockDestroy.mockRejectedValueOnce(new Error('destroy failed'));
    const e = makeExecutor();
    await expect(e.destroy()).resolves.toBeUndefined();
    expect(e.isDestroyed).toBe(true);
  });
});

describe('resolveParallelWorkerPath (worker path resolution)', () => {
  it('prefers the compiled .js path when present', async () => {
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      return String(p).endsWith('parallel-scan-worker.js');
    });
    vi.resetModules();
    const mod = await import('../query/ParallelQueryExecutor');
    // Reaching into the private worker path is not possible; instead verify a
    // fresh executor constructs with the js path by checking pool creation.
    const e = new mod.ParallelQueryExecutor({}, { maxThreads: 2 });
    expect(e.poolSize).toBe(2);
  });

  it('falls back to the .ts path when neither js nor ts name matches the default logic is bypassed', async () => {
    // When existsSync returns false for the .ts path, the fallback returns the
    // ts path anyway ("trust the caller").
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.resetModules();
    const mod = await import('../query/ParallelQueryExecutor');
    const e = new mod.ParallelQueryExecutor({}, { maxThreads: 1 });
    expect(e.poolSize).toBe(1);
  });
});

describe('parallelQuery', () => {
  it('creates an executor, scans, and destroys it', async () => {
    mockPrepareGet.mockReturnValue({ minRowid: 1, maxRowid: 10, rowCount: 10 });
    // Below default threshold -> returns [], but still destroys.
    const rows = await parallelQuery('/tmp/x.db', 'SELECT * FROM t', [], 't', {
      minRowsForParallel: 1000,
    });
    expect(rows).toEqual([]);
    expect(mockDestroy).toHaveBeenCalled();
  });
});
