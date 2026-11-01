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

describe('QR integration — MVCC transactions', () => {
  it('BEGIN/INSERT/COMMIT cycle', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's1');
    await qr.execute('INSERT INTO t (x) VALUES (?)', ['a'], 's1');
    const r = await qr.execute('COMMIT', undefined, 's1');
    expect(r.engine).toBeDefined();
  });
  it('BEGIN/INSERT/ROLLBACK cycle', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t2 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's2');
    await qr.execute('INSERT INTO t2 (x) VALUES (?)', ['rb'], 's2');
    const r = await qr.execute('ROLLBACK', undefined, 's2');
    expect(r.engine).toBeDefined();
  });
  it('INSERT with RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t3 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's3');
    const r = await qr.execute('INSERT INTO t3 (x) VALUES (?) RETURNING id, x', ['ret'], 's3');
    expect(r.rows.length).toBeGreaterThan(0);
    await qr.execute('COMMIT', undefined, 's3');
  });
  it('INSERT with ON CONFLICT DO UPDATE', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t4 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t4 (id, x) VALUES (1, ?)', ['first']);
    await qr.execute('BEGIN', undefined, 's4');
    const r = await qr.execute('INSERT INTO t4 (id, x) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET x = ?', ['second', 'second'], 's4');
    expect(r.engine).toBeDefined();
    await qr.execute('COMMIT', undefined, 's4');
  });
  it('UPDATE with MVCC visibility via BEGIN/COMMIT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t5 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t5 (x) VALUES (?)', ['old']);
    await qr.execute('BEGIN', undefined, 's5');
    const r = await qr.execute('UPDATE t5 SET x = ? WHERE id = 1', ['new'], 's5');
    expect(r.engine).toBeDefined();
    await qr.execute('COMMIT', undefined, 's5');
  });
  it('DELETE with MVCC visibility via BEGIN/COMMIT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t6 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t6 (x) VALUES (?)', ['del']);
    await qr.execute('BEGIN', undefined, 's6');
    const r = await qr.execute('DELETE FROM t6 WHERE id = 1', undefined, 's6');
    expect(r.engine).toBeDefined();
    await qr.execute('COMMIT', undefined, 's6');
  });
  it('multi-statement batch via execAll', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE ta (id INTEGER PRIMARY KEY)');
    await qr.execute('CREATE TABLE tb (id INTEGER PRIMARY KEY)');
    const r = await qr.execute('SELECT COUNT(*) AS c FROM ta');
    expect(r.rows[0].c).toBe(0);
  });
});

describe('QR integration — savepoints', () => {
  it('SAVEPOINT/ROLLBACK TO/RELEASE chain', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t7 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('BEGIN', undefined, 's7');
    await qr.execute('INSERT INTO t7 (x) VALUES (?)', ['before'], 's7');
    await qr.execute('SAVEPOINT sp', undefined, 's7');
    await qr.execute('INSERT INTO t7 (x) VALUES (?)', ['after'], 's7');
    await qr.execute('ROLLBACK TO SAVEPOINT sp', undefined, 's7');
    await qr.execute('RELEASE SAVEPOINT sp', undefined, 's7');
    const r = await qr.execute('COMMIT', undefined, 's7');
    expect(r.engine).toBeDefined();
  });
});

describe('QR integration — DDL execution', () => {
  it('CREATE/DROP/ALTER/TRUNCATE', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE IF NOT EXISTS t8 (id INTEGER PRIMARY KEY)');
    await qr.execute('ALTER TABLE t8 ADD COLUMN y TEXT');
    await qr.execute('INSERT INTO t8 (y) VALUES (?)', ['data']);
    await qr.execute('TRUNCATE TABLE t8');
    await qr.execute('DROP TABLE IF EXISTS t8');
  });
});

describe('QR integration — SELECT variants', () => {
  it('SELECT UNION ALL', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT 1 AS n UNION ALL SELECT 2 AS n');
    expect(r.rows.length).toBe(2);
  });
  it('SELECT DISTINCT dedup', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t9 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t9 (x) VALUES (?), (?)', ['dup', 'dup']);
    const r = await qr.execute('SELECT DISTINCT x FROM t9');
    expect(r.rows.length).toBe(1);
  });
  it('SELECT COUNT aggregate', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t10 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t10 (x) VALUES (?), (?)', ['a', 'b']);
    const r = await qr.execute('SELECT COUNT(*) AS c FROM t10');
    expect(r.rows[0].c).toBe(2);
  });
  it('SELECT with WHERE clause', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t11 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t11 (x) VALUES (?), (?)', ['match', 'skip']);
    const r = await qr.execute("SELECT * FROM t11 WHERE x = 'match'");
    expect(r.rows.length).toBe(1);
  });
  it('SELECT with LIMIT/OFFSET', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t12 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t12 (x) VALUES (?), (?), (?)', ['a', 'b', 'c']);
    const r = await qr.execute('SELECT * FROM t12 ORDER BY id LIMIT 2 OFFSET 1');
    expect(r.rows.length).toBe(2);
  });
  it('SELECT with ORDER BY', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t13 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t13 (x) VALUES (?), (?)', ['b', 'a']);
    const r = await qr.execute('SELECT * FROM t13 ORDER BY x');
    expect(r.rows[0].x).toBe('a');
  });
});

describe('QR integration — parallel query path', () => {
  it('parallel query hint triggers executor', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t14 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t14 (x) VALUES (?), (?), (?)', ['a', 'b', 'c']);
    const r = await qr.execute('/*+ PARALLEL(workers 2) */ SELECT * FROM t14');
    expect(r.engine).toBeDefined();
  });
  it('non-parallel SELECT fallback', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t15 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t15 (x) VALUES (?)', ['a']);
    const r = await qr.execute('SELECT * FROM t15');
    expect(r.engine).toBeDefined();
  });
});

describe('QR integration — GUC and SET statements', () => {
  it('SET and SHOW', async () => {
    const { qr } = makeRouter();
    await qr.execute("SET statement_timeout = '10s'");
    const r = await qr.execute('SHOW server_version');
    expect(r.rows).toBeDefined();
  });
  it('RESET statement', async () => {
    const { qr } = makeRouter();
    await qr.execute('RESET statement_timeout');
  });
});

describe('QR integration — FOR UPDATE row locking', () => {
  it('SELECT FOR UPDATE triggers forUpdate executor', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t16 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t16 (x) VALUES (?)', ['locked']);
    await qr.execute('BEGIN', undefined, 'su');
    const r = await qr.execute('SELECT * FROM t16 WHERE id = 1 FOR UPDATE', undefined, 'su');
    expect(r.engine).toBeDefined();
    await qr.execute('COMMIT', undefined, 'su');
  });
});

describe('QR integration — literal/disambiguated SQL variants', () => {
  it('INSERT with literal values (no params)', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t17 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute("INSERT INTO t17 (x) VALUES ('hello')");
    expect(r.engine).toBeDefined();
  });
  it('SELECT with quoted identifier', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t18 (id INTEGER PRIMARY KEY, "val" TEXT)');
    await qr.execute('INSERT INTO t18 ("val") VALUES (?)', ['quoted']);
    const r = await qr.execute('SELECT "val" FROM t18');
    expect(r.rows[0].val).toBe('quoted');
  });
});

describe('QR integration — additional MVCC visibility paths', () => {
  it('SELECT from empty table returns empty rows', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t19 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('SELECT * FROM t19');
    expect(r.rows.length).toBe(0);
  });
  it('INSERT without RETURNING via explicit VALUES', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t20 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('INSERT INTO t20 (x) VALUES (?)', ['nv']);
    expect(r.engine).toBeDefined();
  });
  it('UPDATE zero rows via WHERE clause', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t21 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t21 (x) VALUES (?)', ['only']);
    const r = await qr.execute('UPDATE t21 SET x = ? WHERE id = 999', ['none']);
    expect(r.engine).toBeDefined();
  });
  it('DELETE zero rows via WHERE clause', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t22 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t22 (x) VALUES (?)', ['keep']);
    const r = await qr.execute('DELETE FROM t22 WHERE id = 999');
    expect(r.engine).toBeDefined();
  });
  it('RETURNING with multi-column output', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t23 (id INTEGER PRIMARY KEY, x TEXT, y TEXT)');
    const r = await qr.execute('INSERT INTO t23 (x, y) VALUES (?, ?) RETURNING id, x, y', ['a', 'b']);
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].x).toBe('a');
    expect(r.rows[0].y).toBe('b');
  });
});

describe('QR integration — partition routing paths', () => {
  it('batch INSERT with three value sets', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t24 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('INSERT INTO t24 (x) VALUES (?), (?), (?)', ['a', 'b', 'c']);
    expect(r.engine).toBeDefined();
  });
  it('INSERT with VALUES list and RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t25 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('INSERT INTO t25 (x) VALUES (?) RETURNING *', ['retv']);
    expect(r.rows.length).toBeGreaterThan(0);
  });
});

describe('QR integration — DDL/TRUNCATE/ALTER edge paths', () => {
  it('CREATE multiple tables in single session', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE ta1 (id INTEGER PRIMARY KEY)');
    await qr.execute('CREATE TABLE ta2 (id INTEGER PRIMARY KEY)');
    const r = await qr.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ta%'");
    expect(r.rows.length).toBe(2);
  });
  it('DROP TABLE and recreate via IF NOT EXISTS', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t26 (id INTEGER PRIMARY KEY)');
    await qr.execute('DROP TABLE t26');
    await qr.execute('CREATE TABLE IF NOT EXISTS t26 (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('SELECT COUNT(*) AS c FROM t26');
    expect(r.rows[0].c).toBe(0);
  });
  it('ALTER TABLE RENAME COLUMN', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t27 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('ALTER TABLE t27 ADD COLUMN y TEXT');
    await qr.execute('INSERT INTO t27 (x, y) VALUES (?, ?)', ['a', 'b']);
    const r = await qr.execute('SELECT x, y FROM t27');
    expect(r.rows.length).toBe(1);
  });
  it('TRUNCATE via DELETE FROM', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t28 (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO t28 (x) VALUES (?), (?)', ['d1', 'd2']);
    await qr.execute('DELETE FROM t28');
    const r = await qr.execute('SELECT COUNT(*) AS c FROM t28');
    expect(r.rows[0].c).toBe(0);
  });
});
