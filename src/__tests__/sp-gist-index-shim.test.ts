/**
 * sp-gist-index-shim.test.ts — Coverage tests for SpGistIndexShim
 * (SP-GiST index compatibility shim + quadtree spatial index).
 */

import { describe, it, expect } from 'vitest';
import {
  detectSpGistIndex,
  rewriteSpGistIndex,
  SpGistSpatialIndex,
  SpGistPartition,
} from '../query/SpGistIndexShim';

// ── Fake better-sqlite3 database ─────────────────────────────────

interface FakeRow {
  partition_id?: string;
  depth?: number;
  xmin?: number;
  ymin?: number;
  xmax?: number;
  ymax?: number;
  cnt?: number;
}

function fakeDb(rows: Record<string, FakeRow[]> = {}) {
  const execCalls: string[] = [];
  const runCalls: Array<{ sql: string; args: unknown[] }> = [];

  return {
    execCalls,
    runCalls,
    exec(sql: string) {
      execCalls.push(sql);
    },
    prepare(sql: string) {
      return {
        get(...args: unknown[]) {
          // Match rows by a simple heuristic: use the first arg if numeric-ish
          // is not needed here — tests drive rows directly via markers below.
          return fakeDb.lastGet;
        },
        all(...args: unknown[]) {
          return fakeDb.lastAll;
        },
        run(...args: unknown[]) {
          runCalls.push({ sql, args });
          return { changes: 1 };
        },
      };
    },
  };
}

describe('detectSpGistIndex', () => {
  it('returns false for non-string/empty', () => {
    expect(detectSpGistIndex(undefined as unknown as string)).toBe(false);
    expect(detectSpGistIndex('')).toBe(false);
    expect(detectSpGistIndex('   ')).toBe(false);
  });

  it('detects USING spgist case-insensitively', () => {
    expect(detectSpGistIndex('CREATE INDEX idx ON t USING spgist (col)')).toBe(true);
    expect(detectSpGistIndex('CREATE INDEX idx ON t USING SPGIST (col)')).toBe(true);
    expect(detectSpGistIndex('CREATE INDEX idx ON t USING SpGiSt (col)')).toBe(true);
  });

  it('returns false for other index methods', () => {
    expect(detectSpGistIndex('CREATE INDEX idx ON t USING btree (col)')).toBe(false);
    expect(detectSpGistIndex('CREATE INDEX idx ON t USING gin (col)')).toBe(false);
    expect(detectSpGistIndex('SELECT 1')).toBe(false);
  });
});

describe('rewriteSpGistIndex', () => {
  it('returns rewritten:false for non-string/empty', () => {
    expect(rewriteSpGistIndex(undefined as unknown as string)).toEqual({
      sql: '',
      rewritten: false,
    });
    expect(rewriteSpGistIndex('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites USING spgist → USING btree', () => {
    const r = rewriteSpGistIndex('CREATE INDEX idx ON t USING spgist (col)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX idx ON t USING btree (col)');
  });

  it('preserves USING casing and rewrites SPGIST', () => {
    const r = rewriteSpGistIndex('CREATE INDEX idx ON t USING SPGIST (col)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX idx ON t USING btree (col)');
  });

  it('passes through non-spgist SQL unchanged', () => {
    expect(rewriteSpGistIndex('CREATE INDEX idx ON t USING btree (col)')).toEqual({
      sql: 'CREATE INDEX idx ON t USING btree (col)',
      rewritten: false,
    });
    expect(rewriteSpGistIndex('SELECT 1')).toEqual({
      sql: 'SELECT 1',
      rewritten: false,
    });
  });
});

describe('SpGistSpatialIndex', () => {
  function makeDb(q: {
    get?: (sql: string, ...args: unknown[]) => unknown;
    all?: (sql: string, ...args: unknown[]) => unknown[];
  } = {}) {
    const execCalls: string[] = [];
    const runCalls: Array<{ sql: string; args: unknown[] }> = [];
    return {
      execCalls,
      runCalls,
      exec(sql: string) {
        execCalls.push(sql);
      },
      prepare(sql: string) {
        const self = this;
        return {
          get(...args: unknown[]) {
            return q.get ? q.get(sql, ...args) : undefined;
          },
          all(...args: unknown[]) {
            return q.all ? q.all(sql, ...args) : [];
          },
          run(...args: unknown[]) {
            runCalls.push({ sql, args });
            return { changes: 1 };
          },
        };
      },
    };
  }

  it('constructs with defaults', () => {
    const idx = new SpGistSpatialIndex('t', 'geom');
    expect(idx.table).toBe('t');
    expect(idx.column).toBe('geom');
    expect(idx.getPartitionTable()).toBe('__spgist_partitions_t');
    expect(idx.getMaxPointsPerPartition()).toBe(4);
    expect(idx.getAllPartitions()).toEqual([]);
  });

  it('constructs with custom max points', () => {
    const idx = new SpGistSpatialIndex('t', 'geom', 10);
    expect(idx.getMaxPointsPerPartition()).toBe(10);
  });

  it('creates partition table', () => {
    const db = makeDb();
    const idx = new SpGistSpatialIndex('t', 'geom');
    idx.createPartitionTable(db);
    expect(db.execCalls.length).toBe(1);
    expect(db.execCalls[0]).toContain('CREATE TABLE IF NOT EXISTS __spgist_partitions_t');
  });

  it('addPoint creates root partition when no partition exists', () => {
    const db = makeDb({ all: () => [] });
    const idx = new SpGistSpatialIndex('t', 'geom');
    idx.addPoint(db, 1, 10, 10);
    // Root partition should now be cached
    const parts = idx.getAllPartitions();
    expect(parts.length).toBe(1);
    expect(parts[0].partitionId).toBe('root');
    expect(parts[0].depth).toBe(0);
  });

  it('countPointsInPartition returns 0 when partition not found', () => {
    const db = makeDb({ get: () => undefined, all: () => [] });
    const idx = new SpGistSpatialIndex('t', 'geom');
    // Access the private method via a cast to trigger the not-found branch
    const result = (idx as unknown as {
      countPointsInPartition: (db: unknown, rowId: number, pid: string, x: number, y: number) => number;
    }).countPointsInPartition.call(idx, db, 1, 'missing', 0, 0);
    expect(result).toBe(0);
  });

  it('countPointsInPartition returns count when partition found via db (cache miss)', () => {
    // First call: partitions cache is empty, so `this.partitions.get` misses,
    // then db.prepare(...).get(pid) returns a part, and COUNT(*) returns cnt.
    const db = makeDb({
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return { cnt: 7 };
        if (sql.includes('WHERE partition_id')) return { partition_id: 'root', depth: 0 };
        return undefined;
      },
      all: () => [],
    });
    const idx = new SpGistSpatialIndex('t', 'geom');
    const method = (idx as unknown as {
      countPointsInPartition: (db: unknown, rowId: number, pid: string, x: number, y: number) => number;
    }).countPointsInPartition;
    expect(method.call(idx, db, 1, 'root', 0, 0)).toBe(7);
  });

  it('addPoint splits root partition when count exceeds maxPoints', () => {
    // Drive: first findContainingPartition returns [] -> else branch -> createRoot.
    // Then the second findContainingPartition returns root -> count>=maxPoints -> split.
    let findCalls = 0;
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('WHERE xmin <=')) {
          const call = findCalls++;
          // First call (before root): empty -> triggers createRoot.
          // Second call (after root): return the root row.
          if (call === 0) return [];
          return [{ partition_id: 'root', depth: 0, xmin: -1000000, ymin: -1000000, xmax: 1000000, ymax: 1000000 }];
        }
        return [];
      },
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return { cnt: 10 };
        return undefined;
      },
    });
    const idx = new SpGistSpatialIndex('t', 'geom', 1);
    idx.addPoint(db, 1, 0, 0);
    // Root now exists plus 4 split quadrants
    expect(idx.getAllPartitions().length).toBe(5);
    expect(idx.getAllPartitions().map((p) => p.partitionId)).toContain('root_nw');
    expect(idx.getAllPartitions().map((p) => p.partitionId)).toContain('root_se');
  });

  it('addPoint keeps root when count is below maxPoints (no split)', () => {
    // else branch -> createRoot -> root found -> count < maxPoints -> no split.
    let findCalls = 0;
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('WHERE xmin <=')) {
          const call = findCalls++;
          if (call === 0) return [];
          return [{ partition_id: 'root', depth: 0, xmin: -1000000, ymin: -1000000, xmax: 1000000, ymax: 1000000 }];
        }
        return [];
      },
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return { cnt: 0 };
        return undefined;
      },
    });
    const idx = new SpGistSpatialIndex('t', 'geom', 4);
    idx.addPoint(db, 1, 0, 0);
    // Only the root partition, no quadrants.
    expect(idx.getAllPartitions().length).toBe(1);
  });

  it('addPoint finds existing partition and does not split (count below threshold)', () => {
    // if (partition) true branch -> count < maxPoints -> no split.
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('WHERE xmin <=')) {
          return [{ partition_id: 'root', depth: 0, xmin: -1000000, ymin: -1000000, xmax: 1000000, ymax: 1000000 }];
        }
        return [];
      },
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return { cnt: 1 };
        return undefined;
      },
    });
    const idx = new SpGistSpatialIndex('t', 'geom', 4);
    idx.addPoint(db, 1, 5, 5);
    expect(idx.getAllPartitions().length).toBe(1);
  });

  it('addPoint finds existing partition and splits (count at threshold)', () => {
    // if (partition) true branch -> count >= maxPoints -> split.
    const db = makeDb({
      all: (sql) => {
        if (sql.includes('WHERE xmin <=')) {
          return [{ partition_id: 'root', depth: 0, xmin: -1000000, ymin: -1000000, xmax: 1000000, ymax: 1000000 }];
        }
        return [];
      },
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return { cnt: 4 };
        return undefined;
      },
    });
    const idx = new SpGistSpatialIndex('t', 'geom', 4);
    idx.addPoint(db, 1, 5, 5);
    expect(idx.getAllPartitions().length).toBe(5);
  });

  it('countPointsInPartition returns 0 when COUNT(*) has no cnt', () => {
    // `info?.cnt ?? 0` — the `?? 0` fallback when cnt is null/undefined.
    const db = makeDb({
      get: (sql) => {
        if (sql.includes('SELECT COUNT(*)')) return {};
        if (sql.includes('WHERE partition_id')) return { partition_id: 'root', depth: 0 };
        return undefined;
      },
      all: () => [],
    });
    const idx = new SpGistSpatialIndex('t', 'geom');
    const method = (idx as unknown as {
      countPointsInPartition: (db: unknown, rowId: number, pid: string, x: number, y: number) => number;
    }).countPointsInPartition;
    expect(method.call(idx, db, 1, 'root', 0, 0)).toBe(0);
  });

  it('findPartitions ignores non-containing sibling (&& chain short-circuit)', () => {
    // Two partitions where `other.depth > row.depth` is true but `other.xmin`
    // is outside the row's bounds, so the `&&` chain short-circuits to false.
    const rows = [
      { partition_id: 'root', depth: 0, xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
      { partition_id: 'root_ne', depth: 1, xmin: 50, ymin: 50, xmax: 60, ymax: 60 },
    ];
    const db = makeDb({ all: () => rows });
    const idx = new SpGistSpatialIndex('t', 'geom');
    const leaves = idx.findPartitions(db, 0, 0, 5);
    // root_ne is deeper but not contained (xmin 50 > row.xmax 10),
    // so root has no child -> both are leaves.
    expect(leaves.length).toBe(2);
  });

  it('findPartitions filters non-leaf parents (hasChild true branch)', () => {
    // 1 root (depth 0) + 4 children (depth 1). The root has children, so it is
    // filtered out; the 4 leaves are returned.
    const rows = [
      { partition_id: 'root', depth: 0, xmin: -10, ymin: -10, xmax: 10, ymax: 10 },
      { partition_id: 'root_nw', depth: 1, xmin: -10, ymin: -10, xmax: 0, ymax: 0 },
      { partition_id: 'root_ne', depth: 1, xmin: 0, ymin: -10, xmax: 10, ymax: 0 },
      { partition_id: 'root_sw', depth: 1, xmin: -10, ymin: 0, xmax: 0, ymax: 10 },
      { partition_id: 'root_se', depth: 1, xmin: 0, ymin: 0, xmax: 10, ymax: 10 },
    ];
    const db = makeDb({ all: () => rows });
    const idx = new SpGistSpatialIndex('t', 'geom');
    const leaves = idx.findPartitions(db, 0, 0, 0);
    expect(leaves.length).toBe(4);
    expect(leaves.every((p) => p.depth === 1)).toBe(true);
  });

  it('findAllOverlapping maps all rows', () => {
    const rows = [
      { partition_id: 'root', depth: 0, xmin: -10, ymin: -10, xmax: 10, ymax: 10 },
      { partition_id: 'root_nw', depth: 1, xmin: -10, ymin: -10, xmax: 0, ymax: 0 },
    ];
    const db = makeDb({ all: () => rows });
    const idx = new SpGistSpatialIndex('t', 'geom');
    const all = idx.findAllOverlapping(db, -10, -10, 10, 10);
    expect(all.length).toBe(2);
    expect(all[0].partitionId).toBe('root');
    expect(all[1].partitionId).toBe('root_nw');
  });

  it('clearCache empties in-memory partitions', () => {
    const db = makeDb({ all: () => [] });
    const idx = new SpGistSpatialIndex('t', 'geom');
    idx.addPoint(db, 1, 0, 0);
    expect(idx.getAllPartitions().length).toBeGreaterThan(0);
    idx.clearCache();
    expect(idx.getAllPartitions()).toEqual([]);
  });
});
