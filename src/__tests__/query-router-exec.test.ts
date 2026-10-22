import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

/**
 * QueryRouter end-to-end execution tests backed by a real in-memory SQLite
 * database. Unlike the mocked-ShardManager tests, these exercise the actual
 * DDL/DML fast paths (`execInsertFast`, `execSelectFast`, `executeDDLParsed`,
 * `applyBatch`, and MVCC rewriting) against a live database so that real
 * write/read round-trips, constraint handling, and table lifecycle behavior
 * are covered.
 */

interface RouterHarness {
  qr: QueryRouter;
  db: Database.Database;
}

function makeRouter(): RouterHarness {
  const db = new Database(':memory:');
  const exec = (s: string) => db.exec(s);
  const sm: any = {
    getAllShards: () => new Map([[0, { db, vectorIndex: null, readers: [] }] as any]),
    getShard: (n: number) => (n === 0 ? { db, vectorIndex: null, readers: [] } as any : undefined),
    execShard: async (_n: number, sql: string) => exec(sql),
    queryShard: (_n: number, sql: string, params?: any[]) =>
      db.prepare(sql).all(...(params || [])),
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async (sql: string) => exec(sql),
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async (sqls: string[]) => exec(sqls.join(';\n')),
    execBatchOnShard: async (_n: number, sqls: string[]) => exec(sqls.join(';\n')),
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
  return { qr: new QueryRouter(sm, {} as any, config), db };
}

describe('QueryRouter — real SQLite execution', () => {
  it('creates, populates, queries, and drops a table end-to-end', async () => {
    const { qr, db } = makeRouter();

    await qr.execute('CREATE TABLE tt (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO tt (x) VALUES (?)', ['a']);
    await qr.execute('INSERT INTO tt (x) VALUES (?)', ['b']);

    const rows = await qr.execute('SELECT * FROM tt');
    expect(rows.rowCount).toBe(2);

    const cnt = await qr.execute('SELECT COUNT(*) AS cnt FROM tt');
    expect(cnt.rows?.[0]?.count ?? cnt.rows?.[0]?.cnt).toBeDefined();

    // Verify the table physically exists in SQLite.
    const found = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tt'")
      .get();
    expect(found).toBeDefined();

    await qr.execute('DROP TABLE tt');
    const gone = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tt'")
      .get();
    expect(gone).toBeUndefined();
  });

  it('executes UPDATE and DELETE with real side effects', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE u (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO u (x) VALUES (?)', ['a']);
    await qr.execute('INSERT INTO u (x) VALUES (?)', ['b']);

    const upd = await qr.execute('UPDATE u SET x = ? WHERE id = 1', ['aa']);
    expect(upd.rowCount).toBe(1);

    const del = await qr.execute('DELETE FROM u WHERE id = 2');
    expect(del.rowCount).toBe(1);

    const cnt = db.prepare('SELECT COUNT(*) AS c FROM u').get() as any;
    expect(cnt.c).toBe(1);
  });

  it('inlines both $N and ? parameter styles on INSERT', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)');
    await qr.execute('INSERT INTO p (a, b) VALUES ($1, $2)', ['x', 1]);
    await qr.execute('INSERT INTO p (a, b) VALUES (?, ?)', ['y', 2]);

    const cnt = db.prepare('SELECT COUNT(*) AS c FROM p').get() as any;
    expect(cnt.c).toBe(2);
  });

  it('buffers DML inside a transaction and applies on COMMIT', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE tx (id INTEGER PRIMARY KEY, x TEXT)');
    const sid = 's1';
    await qr.execute('BEGIN', undefined, sid);
    await qr.execute('INSERT INTO tx (x) VALUES (?)', ['a'], sid);
    await qr.execute('INSERT INTO tx (x) VALUES (?)', ['b'], sid);
    await qr.execute('COMMIT', undefined, sid);

    const cnt = db.prepare('SELECT COUNT(*) AS c FROM tx').get() as any;
    expect(cnt.c).toBe(2);
  });

  it('reports engine type for standard SELECT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE s (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO s (x) VALUES (?)', ['hello']);
    const r = await qr.execute('SELECT * FROM s WHERE id = 1');
    expect(r.engine).toBe('shard');
    // MVCC row-version columns (_xmin/_xmax/_cmin/_cmax) are injected by the
    // schema shim; assert on the user columns only.
    expect(r.rows?.[0]).toMatchObject({ id: 1, x: 'hello' });
  });

  it('maps UNIQUE and NOT NULL constraint violations to SQLSTATE', async () => {
    const { qr } = makeRouter();
    await qr.execute(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT UNIQUE, price REAL NOT NULL)',
    );

    await expect(
      qr.execute('INSERT INTO items (name, price) VALUES (?, ?)', ['a', 1]),
    ).resolves.toMatchObject({ rowCount: 1 });

    await expect(
      qr.execute('INSERT INTO items (name, price) VALUES (?, ?)', ['a', 2]),
    ).rejects.toThrow(/UNIQUE constraint/i);

    await expect(
      qr.execute('INSERT INTO items (name, price) VALUES (?, ?)', ['b', null]),
    ).rejects.toThrow(/NOT NULL constraint/i);
  });

  it('executes aggregate GROUP BY and window functions', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE agg (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)');
    await qr.execute('INSERT INTO agg (name, qty) VALUES (?, ?)', ['a', 2]);
    await qr.execute('INSERT INTO agg (name, qty) VALUES (?, ?)', ['a', 3]);
    await qr.execute('INSERT INTO agg (name, qty) VALUES (?, ?)', ['b', 5]);

    const grouped = await qr.execute(
      'SELECT name, SUM(qty) AS total FROM agg GROUP BY name',
    );
    expect(grouped.rowCount).toBe(2);

    const windowed = await qr.execute('SELECT name, COUNT(*) OVER () AS wc FROM agg');
    expect(windowed.rowCount).toBe(3);
  });

  it('rewrites TRUNCATE to DELETE FROM', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE tr (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('INSERT INTO tr (x) VALUES (?)', ['a']);
    await qr.execute('INSERT INTO tr (x) VALUES (?)', ['b']);

    await qr.execute('TRUNCATE tr');

    const cnt = db.prepare('SELECT COUNT(*) AS c FROM tr').get() as any;
    expect(cnt.c).toBe(0);
  });

  it('accepts SAVEPOINT and RELEASE control statements', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE sp (id INTEGER PRIMARY KEY, x TEXT)');
    const sid = 'sp1';
    await qr.execute('BEGIN', undefined, sid);
    const sp = await qr.execute('SAVEPOINT p1', undefined, sid);
    expect(sp).toHaveProperty('rows');
    const rel = await qr.execute('RELEASE p1', undefined, sid);
    expect(rel).toHaveProperty('rows');
    await qr.execute('COMMIT', undefined, sid);
    expect(qr.getTransactionCount()).toBe(0);
  });

  it('creates an index and a view', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE iv (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute('CREATE INDEX idx_iv_x ON iv(x)');
    await qr.execute('CREATE VIEW v_iv AS SELECT x FROM iv');

    const tables = db
      .prepare("SELECT name, type FROM sqlite_master WHERE name IN ('idx_iv_x', 'v_iv')")
      .all() as any[];
    expect(tables.map((t) => `${t.type}:${t.name}`).sort()).toEqual([
      'index:idx_iv_x',
      'view:v_iv',
    ]);
  });

  it('maps SELECT errors for missing tables and columns', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE err (id INTEGER PRIMARY KEY, x TEXT)');

    await expect(qr.execute('SELECT * FROM nonexistent')).rejects.toThrow(
      /no such table/,
    );
    await expect(qr.execute('SELECT badcol FROM err')).rejects.toThrow(
      /no such column/,
    );
  });

  it('maps FOREIGN KEY and CHECK constraint violations on INSERT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY)');
    await qr.execute(
      'CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES parent(id), v INTEGER CHECK (v > 0))',
    );

    await expect(
      qr.execute('INSERT INTO child (pid, v) VALUES (?, ?)', [999, 1]),
    ).rejects.toThrow(/FOREIGN KEY constraint/);

    await expect(
      qr.execute('INSERT INTO child (pid, v) VALUES (?, ?)', [null, -5]),
    ).rejects.toThrow(/CHECK constraint/);
  });

  it('executes ALTER TABLE RENAME and ADD COLUMN', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE alt (id INTEGER PRIMARY KEY)');

    await qr.execute('ALTER TABLE alt RENAME TO renamed');
    await qr.execute('ALTER TABLE renamed RENAME COLUMN id TO newid');
    await qr.execute('ALTER TABLE renamed ADD COLUMN extra TEXT');

    const cols = db.prepare('PRAGMA table_info(renamed)').all() as any[];
    expect(cols.map((c) => c.name)).toContain('newid');
    expect(cols.map((c) => c.name)).toContain('extra');
  });

  it('reports accurate rowCount for single-row and multi-row INSERT', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE ins (id INTEGER PRIMARY KEY, a TEXT)');

    const single = await qr.execute('INSERT INTO ins (a) VALUES (?)', ['x']);
    expect(single.rowCount).toBe(1);

    const multi = await qr.execute("INSERT INTO ins (a) VALUES (?), (?)", ['y', 'z']);
    expect(multi.rowCount).toBe(2);

    expect(db.prepare('SELECT COUNT(*) AS c FROM ins').get()).toEqual({ c: 3 });
  });

  it('returns RETURNING rows from INSERT ... RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE ret (id INTEGER PRIMARY KEY, a TEXT)');

    const r = await qr.execute('INSERT INTO ret (a) VALUES (?) RETURNING id, a', ['hello']);
    expect(r.rowCount).toBe(1);
    // The generated id is a SQLite rowid; assert on the returned shape and the
    // non-null id rather than an exact value (the rowid may not start at 1).
    expect(r.rows).toHaveLength(1);
    expect(r.rows?.[0]).toMatchObject({ a: 'hello' });
    expect((r.rows?.[0] as any).id).toBeGreaterThan(0);
  });
});

describe('QueryRouter — multi-shard scatter-gather', () => {
  function makeMultiRouter(shardCount: number) {
    const dbs: any[] = [];
    for (let i = 0; i < shardCount; i++) dbs.push(new Database(':memory:'));
    const exec = (n: number, s: string) => dbs[n].exec(s);
    const sm: any = {
      getAllShards: () =>
        new Map(dbs.map((db, i) => [i, { db, vectorIndex: null, readers: [] } as any])),
      getShard: (n: number) =>
        n < shardCount ? { db: dbs[n], vectorIndex: null, readers: [] } : undefined,
      execShard: async (n: number, sql: string) => exec(n, sql),
      queryShard: (n: number, sql: string, params?: any[]) =>
        dbs[n].prepare(sql).all(...(params || [])),
      getShardCount: () => shardCount,
      getShardIdForKey: (key: string, _c: number) =>
        String(key).split('').reduce((a, c) => a + c.charCodeAt(0), 0) % shardCount,
      getShardIds: () => dbs.map((_, i) => i),
      execAll: async (sql: string) => {
        dbs.forEach((d) => d.exec(sql));
      },
      queryAll: async () => [],
      getStats: () => [],
      execAllBatch: async (sqls: string[]) => {
        dbs.forEach((d) => d.exec(sqls.join(';\n')));
      },
      execBatchOnShard: async (n: number, sqls: string[]) => exec(n, sqls.join(';\n')),
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
    return { qr: new QueryRouter(sm, {} as any, config), dbs };
  }

  it('scatter-gathers an unqualified SELECT across all shards', async () => {
    const { qr } = makeMultiRouter(2);
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, v INTEGER)');
    await qr.execute("INSERT INTO t (id, a, v) VALUES (1, 'x', 10)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (2, 'y', 20)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (3, 'z', 30)");

    const all = await qr.execute('SELECT * FROM t');
    expect(all.rowCount).toBe(3);
  });

  it('re-aggregates COUNT and SUM across shards', async () => {
    const { qr } = makeMultiRouter(2);
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, v INTEGER)');
    await qr.execute("INSERT INTO t (id, a, v) VALUES (1, 'x', 10)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (2, 'y', 20)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (3, 'z', 30)");

    const cnt = await qr.execute('SELECT COUNT(*) AS cnt FROM t');
    expect(cnt.rows).toEqual([{ cnt: 3 }]);

    const sum = await qr.execute('SELECT SUM(v) AS sv FROM t');
    expect(sum.rows).toEqual([{ sv: 60 }]);
  });

  it('correctly re-aggregates GROUP BY across shards', async () => {
    const { qr } = makeMultiRouter(2);
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, v INTEGER)');
    await qr.execute("INSERT INTO t (id, a, v) VALUES (1, 'x', 10)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (2, 'x', 20)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (3, 'y', 30)");

    // Regression: GROUP BY re-aggregation previously dropped the GROUP BY
    // clause, collapsing distinct groups into a single incorrect row.
    const grp = await qr.execute('SELECT a, COUNT(*) AS c FROM t GROUP BY a');
    expect(grp.rowCount).toBe(2);
    expect(grp.rows).toEqual(
      expect.arrayContaining([
        { a: 'x', c: 2 },
        { a: 'y', c: 1 },
      ]),
    );

    const sumGrp = await qr.execute('SELECT a, SUM(v) AS sv FROM t GROUP BY a');
    expect(sumGrp.rows).toEqual(
      expect.arrayContaining([
        { a: 'x', sv: 30 },
        { a: 'y', sv: 30 },
      ]),
    );
  });

  it('re-aggregates ORDER BY + LIMIT across shards', async () => {
    const { qr } = makeMultiRouter(2);
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, v INTEGER)');
    await qr.execute("INSERT INTO t (id, a, v) VALUES (1, 'x', 10)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (2, 'y', 20)");
    await qr.execute("INSERT INTO t (id, a, v) VALUES (3, 'z', 30)");

    const ordered = await qr.execute('SELECT id, v FROM t ORDER BY v DESC LIMIT 2');
    expect(ordered.rowCount).toBe(2);
    expect(ordered.rows.map((r: any) => r.v)).toEqual([30, 20]);
  });
});

describe('QueryRouter — SAVEPOINT transaction semantics', () => {
  // Reuse the single-shard harness from the first describe block.
  function makeRouter() {
    const db = new Database(':memory:');
    const exec = (s: string) => db.exec(s);
    const sm: any = {
      getAllShards: () => new Map([[0, { db, vectorIndex: null, readers: [] }] as any]),
      getShard: (n: number) => (n === 0 ? { db, vectorIndex: null, readers: [] } as any : undefined),
      execShard: async (_n: number, sql: string) => exec(sql),
      queryShard: (_n: number, sql: string, params?: any[]) =>
        db.prepare(sql).all(...(params || [])),
      getShardCount: () => 1,
      getShardIdForKey: () => 0,
      getShardIds: () => [0],
      execAll: async (sql: string) => exec(sql),
      queryAll: async () => [],
      getStats: () => [],
      execAllBatch: async (sqls: string[]) => exec(sqls.join(';\n')),
      execBatchOnShard: async (_n: number, sqls: string[]) => exec(sqls.join(';\n')),
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
    return { qr: new QueryRouter(sm, {} as any, config), db };
  }

  it('ROLLBACK TO SAVEPOINT discards only post-savepoint changes', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await qr.execute('BEGIN', undefined, 's');
    await qr.execute("INSERT INTO t (a) VALUES ('one')", undefined, 's');
    await qr.execute('SAVEPOINT sp1', undefined, 's');
    await qr.execute("INSERT INTO t (a) VALUES ('two')", undefined, 's');

    // Regression: ROLLBACK TO SAVEPOINT was misclassified by the top-level
    // transaction fast-path regex as a plain ROLLBACK, destroying the entire
    // transaction instead of rolling back to the savepoint.
    const rb = await qr.execute('ROLLBACK TO SAVEPOINT sp1', undefined, 's');
    expect(rb.rows).toEqual([{ message: 'ROLLBACK TO SP1', discarded: 1 }]);

    await qr.execute("INSERT INTO t (a) VALUES ('three')", undefined, 's');
    const rel = await qr.execute('RELEASE SAVEPOINT sp1', undefined, 's');
    expect(rel.rows).toEqual([{ message: 'RELEASE SP1', staged: 2 }]);

    const commit = await qr.execute('COMMIT', undefined, 's');
    expect(commit.rows?.[0]).toMatchObject({ message: 'COMMIT' });

    // 'two' must be rolled back; 'one' and 'three' must persist.
    expect(db.prepare('SELECT a FROM t ORDER BY id').all()).toEqual([
      { a: 'one' },
      { a: 'three' },
    ]);
  });
});
