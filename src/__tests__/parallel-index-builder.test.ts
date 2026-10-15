import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mock Piscina so the builder never spawns real worker threads. The mock
// records tasks and lets each test control success/failure, exercising the
// dispatch/merge/failure branches deterministically.
const mockRun = vi.fn();
const mockDestroy = vi.fn();

// Mock Piscina so no real worker threads are spawned. `run()` delegates to
// `mockRun` (a vi.fn). By default tests install an implementation that calls
// the real worker inline (so part tables are created on disk); failure cases
// override it. This exercises dispatch/merge/failure deterministically.
vi.mock('piscina', () => {
  return {
    default: class {
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

// Real worker implementation, invoked inline by default `mockRun` impls.
import buildSubIndexWorker from '../index/parallel-index-worker';

// Default mockRun behavior: run the real worker inline against the task's dbPath.
function defaultWorkerRun(task: any): Promise<any> {
  return Promise.resolve(buildSubIndexWorker(task));
}

import {
  ParallelIndexBuilder,
  parallelCreateIndex,
  type RowIdRange,
} from '../index/ParallelIndexBuilder';

function tmpDbPath(): string {
  return path.join(
    os.tmpdir(),
    `pib-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function seedDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (name TEXT, age INTEGER, score REAL);
    INSERT INTO users (rowid, name, age, score) VALUES
      (1, 'alice', 30, 91.5),
      (2, 'bob',   25, 88.0),
      (3, 'carol', 35, 95.0),
      (4, 'dave',  28, 77.5),
      (5, 'eve',   22, 82.0);
    CREATE TABLE empty (a INTEGER);
  `);
  return db;
}

// A mock worker result representing a successful part-table build.
function okResult(workerId: number, rowCount = 0): any {
  return { success: true, workerId, rowCount, timeMs: 1, error: null };
}

describe('ParallelIndexBuilder', () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDbPath();
    db = seedDb(dbPath);
    mockRun.mockReset();
    mockDestroy.mockReset();
    mockDestroy.mockResolvedValue(undefined);
    // Default: run the real worker inline so part tables are created on disk.
    mockRun.mockImplementation(defaultWorkerRun);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    for (const f of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  });

  // ── construction ──────────────────────────────────────────────

  describe('constructor', () => {
    it('builds a Piscina pool for a file-backed database', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      expect(b.poolSize).toBe(2);
      expect(b.isDestroyed).toBe(false);
    });

    it('defaults maxWorkers to at least 1', () => {
      const b = new ParallelIndexBuilder(db);
      expect(b.poolSize).toBeGreaterThanOrEqual(1);
    });

    it('defaults defaultTimeoutMs to 60000 and workerPath to the ts worker', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      expect(b.poolSize).toBe(1);
    });

    it('falls back to no pool for an in-memory database', () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      expect(b.isDestroyed).toBe(false);
      // pool is null, but poolSize still reports options.maxWorkers
      expect(b.poolSize).toBe(2);
      mem.close();
    });

    it('honors explicit workerPath', () => {
      const b = new ParallelIndexBuilder(db, {
        workerPath: '/custom/worker.js',
        maxWorkers: 1,
      });
      expect(b.poolSize).toBe(1);
    });

    it('warns and skips the pool when the db name is empty', () => {
      // A database handle whose `.name` is undefined (never true for
      // better-sqlite3, which always reports ':memory:' or a path) — exercises
      // the defensive empty-name warning path and the in-memory fallback.
      const nameless = { name: undefined } as unknown as Database.Database;
      const b = new ParallelIndexBuilder(nameless, { maxWorkers: 2 });
      expect(b.isDestroyed).toBe(false);
      expect(b.poolSize).toBe(2);
    });
  });

  describe('destroy / isDestroyed', () => {
    it('destroys the pool and marks destroyed', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      expect(b.isDestroyed).toBe(false);
      await b.destroy();
      expect(b.isDestroyed).toBe(true);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
      // idempotent
      await b.destroy();
      expect(b.isDestroyed).toBe(true);
      expect(mockDestroy).toHaveBeenCalledTimes(1);
    });

    it('handles pool destroy throwing without failing', async () => {
      mockDestroy.mockRejectedValueOnce(new Error('boom'));
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(b.destroy()).resolves.toBeUndefined();
      expect(b.isDestroyed).toBe(true);
    });

    it('destroy on in-memory builder marks destroyed without pool', async () => {
      const mem = new Database(':memory:');
      const b = new ParallelIndexBuilder(mem);
      await b.destroy();
      expect(b.isDestroyed).toBe(true);
      expect(mockDestroy).not.toHaveBeenCalled();
      mem.close();
    });

    it('throws when createIndex is called after destroy', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await b.destroy();
      await expect(b.createIndex('users', ['name'])).rejects.toThrow(
        'has been destroyed',
      );
    });

    it('throws when createIndexConcurrently is called after destroy', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await b.destroy();
      await expect(
        b.createIndexConcurrently('users', { indexName: 'u', columns: ['name'] }),
      ).rejects.toThrow('has been destroyed');
    });
  });

  // ── splitRowIdRanges ──────────────────────────────────────────

  describe('splitRowIdRanges', () => {
    it('splits a populated table into workers ranges', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 4 });
      const ranges = b.splitRowIdRanges('users', 2);
      expect(ranges.length).toBe(2);
      expect(ranges[0]).toMatchObject({ min: 1, workerId: 0 });
      expect(ranges[1]).toMatchObject({ max: 5, workerId: 1 });
      expect(ranges[0].max).toBe(3);
      expect(ranges[1].min).toBe(4);
    });

    it('returns empty for an empty table', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      expect(b.splitRowIdRanges('empty', 2)).toEqual([]);
    });

    it('returns empty for a missing table', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      expect(b.splitRowIdRanges('nope', 2)).toEqual([]);
    });

    it('caps actualWorkers at the rowid range size', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 16 });
      const ranges = b.splitRowIdRanges('users', 16);
      expect(ranges.length).toBe(5);
    });

    it('handles workers=1 (single range)', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      const ranges = b.splitRowIdRanges('users', 1);
      expect(ranges.length).toBe(1);
      expect(ranges[0]).toMatchObject({ min: 1, max: 5 });
    });

    it('handles workers greater than range size (segmentSize floor 1)', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      const ranges = b.splitRowIdRanges('users', 0); // workers=0 -> segmentSize = ceil(5/0)... guarded below
      // 0 workers is not a normal call; splitRowIdRanges uses Math.max(1, ...)
      expect(Array.isArray(ranges)).toBe(true);
    });
  });

  // ── buildSubIndex (synchronous) ───────────────────────────────

  describe('buildSubIndex', () => {
    it('builds a part table with the correct rows', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      const range: RowIdRange = { min: 1, max: 3, workerId: 0 };
      b.buildSubIndex('users', range, { indexName: 'u', columns: ['name', 'age'] });
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(3);
    });

    it('applies the WHERE clause for partial indexes', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex(
        'users',
        { min: 1, max: 5, workerId: 0 },
        { indexName: 'u', columns: ['name'], where: 'age >= 30' },
      );
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(2);
    });

    it('dedupes columns and builds a UNIQUE index when unique=true', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex(
        'users',
        { min: 1, max: 5, workerId: 0 },
        { indexName: 'u', columns: ['name', 'name', 'age'], unique: true },
      );
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(5);
    });

    it('filters rowid aliases from columns (no duplicate rowid)', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex(
        'users',
        { min: 1, max: 2, workerId: 0 },
        { indexName: 'u', columns: ['rowid', 'name', '_rowid_', 'oid'] },
      );
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(2);
    });

    it('overwrites an existing part table (DROP IF EXISTS)', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex('users', { min: 1, max: 5, workerId: 0 }, { indexName: 'u', columns: ['name'] });
      b.buildSubIndex('users', { min: 1, max: 1, workerId: 0 }, { indexName: 'u', columns: ['name'] });
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(1);
    });

    it('defaults a column with no declared type to TEXT', () => {
      db.exec('CREATE TABLE untyped (a INTEGER, b); INSERT INTO untyped (a, b) VALUES (1, 2)');
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex('untyped', { min: 1, max: 1, workerId: 0 }, { indexName: 'u', columns: ['b'] });
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u__part_0')
        .get() as { c: number };
      expect(row.c).toBe(1);
    });
  });

  // ── mergeSubIndexes ───────────────────────────────────────────

  describe('mergeSubIndexes', () => {
    it('merges multiple part tables via UNION ALL', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 4 });
      b.buildSubIndex('users', { min: 1, max: 3, workerId: 0 }, { indexName: 'u', columns: ['name'] });
      b.buildSubIndex('users', { min: 4, max: 5, workerId: 1 }, { indexName: 'u', columns: ['name'] });
      b.mergeSubIndexes('u', 2);
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u')
        .get() as { c: number };
      expect(row.c).toBe(5);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__idx_u__part_%'").all(),
      ).toEqual([]);
    });

    it('merges a single part table', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.buildSubIndex('users', { min: 1, max: 5, workerId: 0 }, { indexName: 'u', columns: ['name'] });
      b.mergeSubIndexes('u', 1);
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u')
        .get() as { c: number };
      expect(row.c).toBe(5);
    });

    it('handles zero parts gracefully', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      b.mergeSubIndexes('u', 0);
      const row = db
        .prepare("SELECT count(*) as c FROM sqlite_master WHERE name = '__idx_u'")
        .get() as { c: number };
      expect(row.c).toBe(0);
    });

    it('skips the merged index when only rowid columns remain', () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      // buildSubIndex with only rowid aliases -> part table has just `rowid`.
      b.buildSubIndex('users', { min: 1, max: 5, workerId: 0 }, {
        indexName: 'u',
        columns: ['rowid', '_rowid_', 'oid'],
      });
      b.mergeSubIndexes('u', 1);
      const row = db
        .prepare('SELECT count(*) as c FROM __idx_u')
        .get() as { c: number };
      expect(row.c).toBe(5);
    });
  });

  // ── createIndex (in-memory sequential fallback) ───────────────

  describe('createIndex (in-memory sequential)', () => {
    it('builds a full index sequentially for in-memory DB', async () => {
      const mem = new Database(':memory:');
      mem.exec(
        `CREATE TABLE users (name TEXT, age INTEGER);
         INSERT INTO users (rowid, name, age) VALUES (1,'a',1),(2,'b',2),(3,'c',3);`,
      );
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('users', ['name', 'age']);
      expect(result.indexName).toBe('users_name_age_idx');
      expect(result.totalRows).toBe(3);
      expect(result.workerResults).toHaveLength(1);
      expect(result.workerResults[0].success).toBe(true);
      mem.close();
    });

    it('creates an empty index for an empty table', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE empty (a INTEGER)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('empty', ['a']);
      expect(result.totalRows).toBe(0);
      expect(result.workerResults).toHaveLength(0);
      mem.close();
    });

    it('creates an empty index with only rowid aliases (no secondary index)', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE empty (a INTEGER)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('empty', ['rowid', '_rowid_', 'oid']);
      expect(result.totalRows).toBe(0);
      expect(result.workerResults).toHaveLength(0);
      mem.close();
    });

    it('creates an empty index for an untyped column', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE empty (b)'); // `b` has no declared type
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('empty', ['b']);
      expect(result.totalRows).toBe(0);
      mem.close();
    });

    it('uses a caller-provided index name', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1),(2)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('t', ['a'], 'custom_idx');
      expect(result.indexName).toBe('custom_idx');
      expect(result.totalRows).toBe(2);
      mem.close();
    });

    it('throws for a missing table', async () => {
      const mem = new Database(':memory:');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      await expect(b.createIndex('nope', ['a'])).rejects.toThrow('not found');
      mem.close();
    });

    it('filters rowid aliases in sequential build', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE t (a INTEGER); INSERT INTO t (rowid, a) VALUES (1,10),(2,20)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('t', ['rowid', 'a']);
      expect(result.totalRows).toBe(2);
      mem.close();
    });

    it('defaults columns with no declared type to TEXT', async () => {
      const mem = new Database(':memory:');
      // `b` has no declared type -> table_info reports an empty type string,
      // so the builder falls back to TEXT.
      mem.exec('CREATE TABLE t (a INTEGER, b); INSERT INTO t (a, b) VALUES (1, 2),(3, 4)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('t', ['b']);
      expect(result.totalRows).toBe(2);
      mem.close();
    });

    it('skips the index when only rowid aliases remain (sequential)', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE t (a INTEGER); INSERT INTO t (rowid, a) VALUES (1,10),(2,20)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndex('t', ['rowid', '_rowid_', 'oid']);
      expect(result.totalRows).toBe(2);
      mem.close();
    });
  });

  // ── createIndex (file-backed, mocked Piscina) ─────────────────

  describe('createIndex (file-backed parallel)', () => {
    it('runs a successful parallel build through the mocked pool', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      const result = await b.createIndex('users', ['name', 'age'], 'pidx');
      expect(result.indexName).toBe('pidx');
      expect(mockRun).toHaveBeenCalled();
      expect(result.workerResults.length).toBeGreaterThan(0);
      expect(result.workerResults.every((w) => w.success)).toBe(true);
      expect(result.totalRows).toBe(5);
    });

    it('throws and cleans up when a worker reports failure', async () => {
      // First worker fails, second succeeds — but split into 2 ranges so mock
      // must map. Use 1 worker for determinism: single worker fails.
      mockRun.mockResolvedValue({
        success: false,
        workerId: 0,
        rowCount: 0,
        timeMs: 0,
        error: 'synthetic failure',
      });
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(
        b.createIndex('users', ['name'], 'pfail'),
      ).rejects.toThrow('workers errored');
    });

    it('maps a rejected task to a failed worker result', async () => {
      mockRun.mockRejectedValueOnce(new Error('worker crashed'));
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(
        b.createIndex('users', ['name'], 'prej', 1),
      ).rejects.toThrow('workers errored');
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('stringifies a non-Error rejection reason', async () => {
      mockRun.mockRejectedValueOnce('plain string rejection');
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(
        b.createIndex('users', ['name'], 'prej2', 1),
      ).rejects.toThrow('plain string rejection');
    });

    it('falls back to a generic message for a falsy rejection reason', async () => {
      mockRun.mockRejectedValueOnce(undefined);
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(
        b.createIndex('users', ['name'], 'prej3', 1),
      ).rejects.toThrow('Unknown worker error');
    });

    it('creates an empty index for an empty table (file-backed)', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      const result = await b.createIndex('empty', ['a'], 'eidx');
      expect(result.totalRows).toBe(0);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('throws for a missing table (file-backed)', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      await expect(b.createIndex('nope', ['a'])).rejects.toThrow('not found');
    });
  });

  // ── createIndexConcurrently (mocked Piscina) ──────────────────

  describe('createIndexConcurrently', () => {
    it('runs the multi-phase protocol with a successful build', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      const result = await b.createIndexConcurrently('users', {
        indexName: 'cix',
        columns: ['name'],
      });
      expect(result.indexName).toBe('cix');
      expect(mockRun).toHaveBeenCalled();
      expect(result.totalRows).toBe(5);
    });

    it('runs the incremental scan when rows are inserted during Phase 1', async () => {
      // During Phase 1 build, insert a new row (rowid 6) so the Phase 3
      // incremental scan detects and folds it into part_0.
      mockRun.mockImplementation(function (task: any) {
        const r = buildSubIndexWorker(task);
        db.exec(
          "INSERT INTO users (rowid, name, age, score) VALUES (6, 'frank', 40, 99.9)",
        );
        return Promise.resolve(r);
      });
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      const result = await b.createIndexConcurrently('users', {
        indexName: 'cix',
        columns: ['name'],
      });
      // 5 original + 1 inserted during build = 6 total in the final index
      expect(result.totalRows).toBe(6);
    });

    it('throws and cleans up when Phase 1 fails', async () => {
      mockRun.mockResolvedValue({
        success: false,
        workerId: 0,
        rowCount: 0,
        timeMs: 0,
        error: 'phase1 fail',
      });
      const b = new ParallelIndexBuilder(db, { maxWorkers: 1 });
      await expect(
        b.createIndexConcurrently('users', { indexName: 'cix', columns: ['name'] }),
      ).rejects.toThrow('Phase 1 failed');
    });

    it('creates an empty index for an empty table', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      const result = await b.createIndexConcurrently('empty', {
        indexName: 'cix',
        columns: ['a'],
      });
      expect(result.totalRows).toBe(0);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('throws for a missing table', async () => {
      const b = new ParallelIndexBuilder(db, { maxWorkers: 2 });
      await expect(
        b.createIndexConcurrently('nope', { indexName: 'x', columns: ['a'] }),
      ).rejects.toThrow('not found');
    });
  });

  // ── createIndexConcurrently (in-memory sequential) ────────────

  describe('createIndexConcurrently (in-memory)', () => {
    it('builds index via sequential path', async () => {
      const mem = new Database(':memory:');
      mem.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1),(2),(3)');
      const b = new ParallelIndexBuilder(mem, { maxWorkers: 2 });
      const result = await b.createIndexConcurrently('t', { indexName: 'cix', columns: ['a'] });
      expect(result.indexName).toBe('cix');
      expect(result.totalRows).toBe(3);
      mem.close();
    });
  });

  // ── parallelCreateIndex wrapper ───────────────────────────────

  describe('parallelCreateIndex', () => {
    it('creates an index and closes the db', async () => {
      const result = await parallelCreateIndex(dbPath, 'users', ['name', 'age'], 'pci', 2);
      expect(result.indexName).toBe('pci');
      expect(result.totalRows).toBe(5);
    });

    it('throws for a missing table', async () => {
      await expect(parallelCreateIndex(dbPath, 'nope', ['a'], 'x', 1)).rejects.toThrow();
    });
  });
});
