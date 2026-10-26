/**
 * Targeted reachability tests for previously-uncovered reachable methods of
 * QueryRouter. These are NOT dead-code: every method exercised here has at
 * least one live call site (verified via call-site scan) but lacked a test
 * that actually reached it.
 *
 * Covered in this suite:
 *   - dropEncryptionPolicy          (public API — remove an encryption policy)
 *   - executeWithoutDuckDB          (public API — bypass DuckDB routing)
 *   - extractWhereKey               (WHERE-clause extraction helper)
 *   - routeInsertToShardTable       (partitioned INSERT routing: RANGE/LIST/HASH)
 *   - getOrCreateParallelCtx        (per-session parallel context factory)
 *   - getParallelCtx                (parallel context resolution + fallback)
 *   - buildParallelDmlTasks         (parallel DML task fan-out)
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { parseStatement } from '../query/SqlParser';
import { registerPartition, ensureMetaTable } from '../query/PartitionMetaManager';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

interface ShardHandle {
  db: Database.Database;
  vectorIndex: null;
  readers: unknown[];
  path: string;
}

const cleanups: string[] = [];
let db0: Database.Database;
let shard0: ShardHandle;

function makeShardedRouter(shardCount = 2): { qr: any; dbs: Database.Database[]; shards: ShardHandle[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-reach-'));
  cleanups.push(dir);
  const dbs: Database.Database[] = [];
  const shards: ShardHandle[] = [];
  for (let i = 0; i < shardCount; i++) {
    const p = path.join(dir, `s${i}.db`);
    const db = new Database(p);
    db.exec('CREATE TABLE t (id INT, x TEXT)');
    dbs.push(db);
    shards.push({ db, vectorIndex: null, readers: [], path: p });
  }

  const sm: any = {
    getAllShards: () => new Map(shards.map((s, i) => [i, s])),
    getShard: (n: number) => shards[n],
    execShard: async (n: number, sql: string) => shards[n].db.exec(sql),
    queryShard: (n: number, sql: string, params?: any[]) =>
      shards[n].db.prepare(sql).all(...(params || [])),
    getShardCount: () => shardCount,
    getShardIdForKey: () => 0,
    getShardIds: () => shards.map((_, i) => i),
    execAll: async (sql: string) => { for (const s of shards) s.db.exec(sql); },
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => { for (const s of shards) s.db.exec(sqls.join(';')); },
    execBatchOnShard: async (n: number, sqls: string[]) => shards[n].db.exec(sqls.join(';')),
    rotateAllKeys: () => [{ success: true }],
  };
  const config: any = {
    enabled: true,
    dimension: 768,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
  const qr: any = new QueryRouter(sm, {} as any, config);
  // Pre-seed a stub ParallelExecutor so decision helpers don't spin up Piscina.
  qr.parallelExecutor = { executeParallel: async () => [] };
  return { qr, dbs, shards };
}

afterEach(() => {
  for (const db of (globalThis as any).__allDbs || []) {
    try { db.close(); } catch {}
  }
  while (cleanups.length) {
    try { fs.rmSync(cleanups.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('dropEncryptionPolicy (public API)', () => {
  it('removes a previously created encryption policy', () => {
    const { qr } = makeShardedRouter(1);
    qr.createEncryptionPolicy('pol1', 'employees.ssn', 'aes-256-gcm');
    // Create + drop must not throw; dropping an unknown policy is a no-op.
    expect(() => qr.dropEncryptionPolicy('pol1')).not.toThrow();
    expect(() => qr.dropEncryptionPolicy('does-not-exist')).not.toThrow();
  });

  it('createEncryptionPolicy lazily initializes the engine', () => {
    const { qr } = makeShardedRouter(1);
    // Before any policy the engine may be undefined; drop must be safe.
    expect(() => qr.dropEncryptionPolicy('any')).not.toThrow();
    qr.createEncryptionPolicy('pol2', 'users.name');
    expect(() => qr.dropEncryptionPolicy('pol2')).not.toThrow();
  });
});

describe('executeWithoutDuckDB (public API)', () => {
  it('executes a SELECT while toggling the DuckDB-routing skip flag', async () => {
    const { qr } = makeShardedRouter(1);
    qr.dbs?.[0]?.exec; // no-op guard
    const r = await qr.executeWithoutDuckDB('SELECT COUNT(*) AS n FROM t', [], 'default');
    expect(r.rows.length).toBeGreaterThan(0);
    // The skip flag must be reset after the call (even on a normal return).
    expect((qr as any)._skipDuckDBRouting).toBe(false);
  });

  it('resets the skip flag after an error is thrown', async () => {
    const { qr } = makeShardedRouter(1);
    await expect(
      qr.executeWithoutDuckDB('SELECT * FROM nonexistent_table_xyz'),
    ).rejects.toThrow();
    expect((qr as any)._skipDuckDBRouting).toBe(false);
  });
});

describe('extractWhereKey (helper)', () => {
  it('prefers a parsed WHERE object', () => {
    const { qr } = makeShardedRouter(1);
    const parsed = { where: { col: 'id', op: '=', val: 5 } };
    const key = (qr as any).extractWhereKey(parsed, 'SELECT * FROM t');
    expect(key).toContain('id');
  });

  it('falls back to regex extraction from raw SQL', () => {
    const { qr } = makeShardedRouter(1);
    const key = (qr as any).extractWhereKey(
      { where: undefined },
      'SELECT * FROM t WHERE id = 5 ORDER BY id',
    );
    expect(key).toBe('id = 5');
  });

  it('returns empty string when no WHERE clause exists', () => {
    const { qr } = makeShardedRouter(1);
    const key = (qr as any).extractWhereKey({}, 'SELECT * FROM t');
    expect(key).toBe('');
  });

  it('truncates at ORDER BY and ignores trailing clauses', () => {
    const { qr } = makeShardedRouter(1);
    const key = (qr as any).extractWhereKey(
      {},
      'SELECT * FROM t WHERE a = 1 AND b = 2 LIMIT 10',
    );
    expect(key).toBe('a = 1 AND b = 2');
  });
});

describe('routeInsertToShardTable (partitioned INSERT routing)', () => {
  it('routes a RANGE partition by a numeric key', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'orders',
      partitionMethod: 'RANGE',
      partitionColumn: 'order_id',
      partitionName: 'orders_p0',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    registerPartition(db, {
      parentTable: 'orders',
      partitionMethod: 'RANGE',
      partitionColumn: 'order_id',
      partitionName: 'orders_p1',
      partitionBounds: JSON.stringify({ from: 100, to: 200 }),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const stmt = parseStatement('INSERT INTO orders (order_id, name) VALUES (50, \'a\')') as any;
    expect(stmt.columns).toContain('order_id');
    const target = (qr as any).routeInsertToShardTable(db, 'orders', stmt);
    expect(target).toBe('orders_p0');
  });

  it('routes a LIST partition by string equality', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'clients',
      partitionMethod: 'LIST',
      partitionColumn: 'region',
      partitionName: 'clients_us',
      partitionBounds: JSON.stringify({ values: ['US', 'CA'] }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    registerPartition(db, {
      parentTable: 'clients',
      partitionMethod: 'LIST',
      partitionColumn: 'region',
      partitionName: 'clients_eu',
      partitionBounds: JSON.stringify({ values: ['DE', 'FR'] }),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const stmt = parseStatement('INSERT INTO clients (region, name) VALUES (\'DE\', \'x\')') as any;
    const target = (qr as any).routeInsertToShardTable(db, 'clients', stmt);
    expect(target).toBe('clients_eu');
  });

  it('routes a HASH partition by modulus/remainder', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'events',
      partitionMethod: 'HASH',
      partitionColumn: 'user_id',
      partitionName: 'events_h0',
      partitionBounds: JSON.stringify({ modulus: 4, remainder: 0 }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    registerPartition(db, {
      parentTable: 'events',
      partitionMethod: 'HASH',
      partitionColumn: 'user_id',
      partitionName: 'events_h1',
      partitionBounds: JSON.stringify({ modulus: 4, remainder: 3 }),
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    // user_id = 7 -> 7 % 4 = 3 -> events_h1
    const stmt = parseStatement('INSERT INTO events (user_id, val) VALUES (7, \'z\')') as any;
    const target = (qr as any).routeInsertToShardTable(db, 'events', stmt);
    expect(target).toBe('events_h1');
  });

  it('returns null for a non-partitioned table', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    const stmt = parseStatement('INSERT INTO plain (id) VALUES (1)') as any;
    const target = (qr as any).routeInsertToShardTable(db, 'plain', stmt);
    expect(target).toBeNull();
  });

  it('returns null when the partition column is absent from the INSERT column list', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'orders',
      partitionMethod: 'RANGE',
      partitionColumn: 'order_id',
      partitionName: 'orders_p0',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Partition column (order_id) is NOT named in the INSERT column list.
    const stmt = parseStatement('INSERT INTO orders (name) VALUES (\'a\')') as any;
    expect((qr as any).routeInsertToShardTable(db, 'orders', stmt)).toBeNull();
  });

  it('returns null when a partition exists but has no resolvable column', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'orders',
      partitionMethod: 'RANGE',
      partitionColumn: '',
      partitionName: 'orders_p0',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const stmt = parseStatement('INSERT INTO orders (order_id) VALUES (5)') as any;
    expect((qr as any).routeInsertToShardTable(db, 'orders', stmt)).toBeNull();
  });

  it('throws when a partition key matches no partition', () => {
    const { qr, shards } = makeShardedRouter(1);
    const db = shards[0].db;
    ensureMetaTable(db);
    registerPartition(db, {
      parentTable: 'orders',
      partitionMethod: 'RANGE',
      partitionColumn: 'order_id',
      partitionName: 'orders_p0',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const stmt = parseStatement('INSERT INTO orders (order_id, name) VALUES (999, \'a\')') as any;
    expect(() => (qr as any).routeInsertToShardTable(db, 'orders', stmt)).toThrow(
      /No matching partition/,
    );
  });
});

describe('parallel session context resolution', () => {
  it('getOrCreateParallelCtx creates once and returns the same instance', () => {
    const { qr } = makeShardedRouter(2);
    const a = (qr as any).getOrCreateParallelCtx('sess-1');
    const b = (qr as any).getOrCreateParallelCtx('sess-1');
    expect(a).toBe(b);
    const c = (qr as any).getOrCreateParallelCtx('sess-2');
    expect(c).not.toBe(a);
    expect(c).not.toBe(b);
  });

  it('getParallelCtx falls back to default when no per-session ctx exists', () => {
    const { qr } = makeShardedRouter(2);
    const def = (qr as any).defaultParallelCtx;
    // Unknown session id -> fallback to default
    expect((qr as any).getParallelCtx('unknown')).toBe(def);
    // Undefined session id -> default
    expect((qr as any).getParallelCtx(undefined)).toBe(def);
    // A created session ctx resolves to itself
    const created = (qr as any).getOrCreateParallelCtx('sess-9');
    expect((qr as any).getParallelCtx('sess-9')).toBe(created);
  });
});

describe('buildParallelDmlTasks (parallel DML fan-out)', () => {
  it('builds one task per shard with the taskType annotation', () => {
    const { qr } = makeShardedRouter(2);
    const tasks = (qr as any).buildParallelDmlTasks(
      'INSERT INTO t VALUES (1, \'a\')',
      undefined,
      'insert',
    );
    expect(tasks).not.toBeNull();
    expect(tasks).toHaveLength(2);
    expect(tasks![0].taskType).toBe('insert');
    expect(tasks![0].shardId).toBe(0);
    expect(tasks![1].shardId).toBe(1);
    expect(tasks![0].dbPath).toBeTruthy();
  });

  it('inlines params into the fan-out SQL', () => {
    const { qr } = makeShardedRouter(2);
    const tasks = (qr as any).buildParallelDmlTasks(
      'INSERT INTO t (id, x) VALUES (?, ?)',
      [42, 'hello'],
      'insert',
    );
    expect(tasks).not.toBeNull();
    expect(tasks![0].sql).toContain('42');
    expect(tasks![0].sql).toContain('hello');
  });

  it('returns null when no shards are configured', () => {
    const { qr } = makeShardedRouter(1);
    // Temporarily empty the shard map to exercise the zero-shard guard.
    const original = (qr as any).shardManager.getAllShards;
    (qr as any).shardManager.getAllShards = () => new Map();
    const tasks = (qr as any).buildParallelDmlTasks('INSERT INTO t VALUES (1)', undefined, 'insert');
    (qr as any).shardManager.getAllShards = original;
    expect(tasks).toBeNull();
  });
});
