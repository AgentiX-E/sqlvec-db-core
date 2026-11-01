import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';

function makeRouter(): { qr: QueryRouter; db: Database.Database } {
  const db = new Database(':memory:');
  const sm: any = {
    getAllShards: () => new Map([[0, { db, vectorIndex: null, readers: [] }]]),
    getShard: (n: number) => (n === 0 ? { db, vectorIndex: null, readers: [] } : undefined),
    execShard: async (_n: number, sql: string) => { db.exec(sql); return { changes: 0 }; },
    queryShard: (_n: number, sql: string, params?: any[]) => db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1, getShardIdForKey: () => 0, getShardIds: () => [0],
    execAll: async (sql: string) => { db.exec(sql); return { changes: 0 }; },
    queryAll: async () => [], getStats: () => [],
    execAllBatch: async (sqls: string[]) => { db.exec(sqls.join(';\n')); return { changes: 0 }; },
    execBatchOnShard: async (_n: number, sqls: string[]) => { db.exec(sqls.join(';\n')); return { changes: 0 }; },
    rotateAllKeys: () => [{ success: true }],
  };
  const config: any = { enabled: true, dimension: 768, mode: 'auto' as any, metric: 0, indexType: 0, indexParams: {}, bruteForceThreshold: 1000 };
  return { qr: new QueryRouter(sm, {} as any, config), db };
}

describe('QR integration', () => {
  it('BEGIN/INSERT/COMMIT cycle', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's1');
    await qr.execute('INSERT INTO t (x) VALUES (?)', ['a'], 's1');
    const r = await qr.execute('COMMIT', undefined, 's1');
    expect(r.engine).toBeDefined();
  });
  it('INSERT with RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t2 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('INSERT INTO t2 (x) VALUES (?) RETURNING id, x', ['ret']);
    expect(r.rows.length).toBeGreaterThan(0);
  });
  it('INSERT with ON CONFLICT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t3 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t3 (id, x) VALUES (1, ?)', ['first']);
    const r = await qr.execute('INSERT INTO t3 (id, x) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET x = ?', ['second', 'second']);
    expect(r.engine).toBeDefined();
  });
  it('UPDATE/DELETE with MVCC', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t4 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t4 (x) VALUES (?)', ['old']);
    await qr.execute('BEGIN', undefined, 's4');
    const r1 = await qr.execute('UPDATE t4 SET x = ? WHERE id = 1', ['new'], 's4');
    expect(r1.engine).toBeDefined();
    const r2 = await qr.execute('DELETE FROM t4 WHERE id = 1', undefined, 's4');
    expect(r2.engine).toBeDefined();
    await qr.execute('ROLLBACK', undefined, 's4');
  });
  it('SAVEPOINT/ROLLBACK TO/RELEASE', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t5 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's5');
    await qr.execute('INSERT INTO t5 (x) VALUES (?)', ['before'], 's5');
    await qr.execute('SAVEPOINT sp', undefined, 's5');
    await qr.execute('INSERT INTO t5 (x) VALUES (?)', ['after'], 's5');
    await qr.execute('ROLLBACK TO SAVEPOINT sp', undefined, 's5');
    await qr.execute('RELEASE SAVEPOINT sp', undefined, 's5');
    const r = await qr.execute('COMMIT', undefined, 's5');
    expect(r.engine).toBeDefined();
  });
  it('DDL: CREATE/DROP/ALTER/TRUNCATE', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE IF NOT EXISTS t6 (id INTEGER PRIMARY KEY)');
    await qr.execute('ALTER TABLE t6 ADD COLUMN y TEXT');
    await qr.execute('INSERT INTO t6 (y) VALUES (?)', ['data']);
    await qr.execute('TRUNCATE TABLE t6');
    await qr.execute('DROP TABLE IF EXISTS t6');
  });
  it('SELECT with UNION ALL', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT 1 AS n UNION ALL SELECT 2 AS n');
    expect(r.rows.length).toBe(2);
  });
  it('parallel query hint', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t7 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('/*+ PARALLEL(workers 2) */ SELECT * FROM t7');
    expect(r.engine).toBeDefined();
  });
  it('SELECT DISTINCT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t8 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t8 (x) VALUES (?), (?)', ['dup', 'dup']);
    const r = await qr.execute('SELECT DISTINCT x FROM t8');
    expect(r.rows.length).toBe(1);
  });
  it('SET/SHOW statements', async () => {
    const { qr } = makeRouter();
    await qr.execute("SET statement_timeout = '10s'");
    const r = await qr.execute('SHOW server_version');
    expect(r.rows).toBeDefined();
  });
});
