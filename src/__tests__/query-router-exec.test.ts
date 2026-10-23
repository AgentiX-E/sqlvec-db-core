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
  rotateCalls: string[];
}

function makeRouter(): RouterHarness {
  const db = new Database(':memory:');
  const exec = (s: string) => db.exec(s);
  const rotateCalls: string[] = [];
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
    rotateAllKeys: (key: string) => {
      rotateCalls.push(key);
      return [{ success: true }];
    },
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
  return { qr: new QueryRouter(sm, {} as any, config), db, rotateCalls };
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

describe('QueryRouter — read-your-own-writes within a transaction', () => {
  it('SELECT sees a buffered INSERT from the same session', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)');
    await qr.execute('BEGIN', undefined, 's');
    await qr.execute("INSERT INTO t (id, a) VALUES (1, 'x')", undefined, 's');

    // The uncommitted INSERT is pending; SELECT must merge it via
    // mergeOwnWritesIntoResult rather than returning an empty table.
    const sel = await qr.execute('SELECT * FROM t', undefined, 's');
    expect(sel.rows).toEqual([{ id: 1, a: 'x' }]);
    expect(sel.rowCount).toBe(1);
  });
});

describe('QueryRouter — window function execution', () => {
  it('ROW_NUMBER with PARTITION BY re-ranks within each partition', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (dept TEXT, name TEXT, sal INTEGER)');
    await qr.execute("INSERT INTO t (dept, name, sal) VALUES ('eng', 'a', 10)");
    await qr.execute("INSERT INTO t (dept, name, sal) VALUES ('eng', 'b', 20)");
    await qr.execute("INSERT INTO t (dept, name, sal) VALUES ('eng', 'c', 15)");
    await qr.execute("INSERT INTO t (dept, name, sal) VALUES ('sales', 'd', 30)");
    await qr.execute("INSERT INTO t (dept, name, sal) VALUES ('sales', 'e', 25)");

    const r = await qr.execute(
      'SELECT dept, name, sal, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY sal DESC) AS rn FROM t',
    );

    // eng members ranked 1..3 by sal desc; sales ranked 1..2.
    const rn = Object.fromEntries(
      r.rows.map((row: any) => [`${row.dept}:${row.name}`, row.rn]),
    );
    expect(rn).toEqual({
      'eng:b': 1,
      'eng:c': 2,
      'eng:a': 3,
      'sales:d': 1,
      'sales:e': 2,
    });
  });

  it('RANK without PARTITION BY ties equal values', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (name TEXT, sal INTEGER)');
    await qr.execute("INSERT INTO t (name, sal) VALUES ('a', 10)");
    await qr.execute("INSERT INTO t (name, sal) VALUES ('b', 25)");
    await qr.execute("INSERT INTO t (name, sal) VALUES ('c', 25)");
    await qr.execute("INSERT INTO t (name, sal) VALUES ('d', 30)");

    const r = await qr.execute(
      'SELECT name, sal, RANK() OVER (ORDER BY sal DESC) AS rk FROM t',
    );
    const rk = Object.fromEntries(r.rows.map((row: any) => [row.name, row.rk]));
    expect(rk).toEqual({ d: 1, b: 2, c: 2, a: 4 });
  });
});

describe('QueryRouter — INSERT RETURNING', () => {
  it('returns the inserted row for INSERT ... RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
    const r = await qr.execute("INSERT INTO t (a, b) VALUES (1, 'x') RETURNING a, b");
    expect(r.rows).toEqual([{ a: 1, b: 'x' }]);
    expect(r.rowCount).toBe(1);
  });

  it('honors ON CONFLICT DO NOTHING with RETURNING', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (a INTEGER PRIMARY KEY, b TEXT)');
    const r1 = await qr.execute("INSERT INTO t (a, b) VALUES (2, 'y') ON CONFLICT (a) DO NOTHING RETURNING a");
    expect(r1.rows).toEqual([{ a: 2 }]);

    // Second insert conflicts on (a); RETURNING must yield nothing.
    const r2 = await qr.execute("INSERT INTO t (a, b) VALUES (2, 'z') ON CONFLICT (a) DO NOTHING RETURNING a");
    expect(r2.rows).toEqual([]);
  });
});

describe('QueryRouter — DDL security shims', () => {
  it('strips UNLOGGED from CREATE UNLOGGED TABLE', async () => {
    const { qr, db } = makeRouter();
    const r = await qr.execute('CREATE UNLOGGED TABLE u1 (id INTEGER)');
    expect(r.engine).toBe('shard');
    // The table must actually exist (UNLOGGED keyword removed before SQLite).
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='u1'").get();
    expect(row).toEqual({ name: 'u1' });
  });

  it('rewrites ALTER TABLE ... ENABLE ROW LEVEL SECURITY as a no-op', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER)');
    const r = await qr.execute('ALTER TABLE t ENABLE ROW LEVEL SECURITY');
    expect(r.engine).toBe('shard');
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
  });
});

describe('QueryRouter — ALTER SYSTEM SET encryption_key (TDE key rotation)', () => {
  it('rotates the TDE key without reaching SQLite', async () => {
    const { qr, rotateCalls } = makeRouter();
    const r = await qr.execute("ALTER SYSTEM SET encryption_key = 'aGVsbG8='");
    expect(r.engine).toBe('shard');
    // rotateAllKeys must receive the original base64 key (recovered from the
    // literal-protection placeholder), never the __LIT_N__ placeholder itself.
    expect(rotateCalls).toEqual(['aGVsbG8=']);
  });
});

describe('QueryRouter — FOR UPDATE / FOR SHARE row locking', () => {
  it('strips FOR UPDATE from the fast path without a syntax error', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
    await qr.execute("INSERT INTO t (id, x) VALUES (1, 'a')");
    // SQLite has no SELECT ... FOR UPDATE; the fast path must strip the clause
    // before reaching SQLite instead of failing with `near "UPDATE"`.
    const r = await qr.execute('SELECT * FROM t FOR UPDATE');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).id).toBe(1);
    expect((r.rows[0] as any).x).toBe('a');
  });

  it('strips FOR SHARE NOWAIT', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    const r = await qr.execute('SELECT * FROM t FOR SHARE NOWAIT');
    expect(r.rowCount).toBe(0);
  });

  it('strips FOR NO KEY UPDATE', async () => {
    const { qr } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)');
    const r = await qr.execute('SELECT * FROM t FOR NO KEY UPDATE');
    expect(r.rowCount).toBe(0);
  });
});

describe('QueryRouter — PL/pgSQL executor interop', () => {
  it('intercepts a registered SELECT function call', async () => {
    const { qr } = makeRouter();
    (qr as any).plpgsqlExecutor = {
      hasFunction: (n: string) => n === 'add',
      execute: async () => 7,
      dropFunction: async () => {},
    };
    const r = await qr.execute('SELECT add(2, 5)');
    expect(r.engine).toBe('plpgsql');
    expect(r.rows).toEqual([{ add: 7 }]);
  });

  it('routes DROP FUNCTION to the PL/pgSQL executor', async () => {
    const { qr } = makeRouter();
    let dropped = '';
    (qr as any).plpgsqlExecutor = {
      hasFunction: () => false,
      execute: async () => 0,
      dropFunction: async (n: string) => {
        dropped = n;
      },
    };
    const r = await qr.execute('DROP FUNCTION foo(integer)');
    expect(dropped).toBe('foo');
    expect(r.engine).toBe('plpgsql');
  });
});

describe('QueryRouter — FTS full-text search (tsvector/tsquery @@ → FTS5 MATCH)', () => {
  it('rewrites body @@ to_tsquery to FTS5 MATCH', async () => {
    const { qr, db } = makeRouter();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    db.exec("INSERT INTO ft (body) VALUES ('hello world'), ('moon rise')");
    const r = await qr.execute("SELECT * FROM ft WHERE body @@ to_tsquery('hello')");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).body).toBe('hello world');
  });

  it('unwraps to_tsvector(config, col) @@ to_tsquery to col MATCH', async () => {
    const { qr, db } = makeRouter();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    db.exec("INSERT INTO ft (body) VALUES ('hello world'), ('moon rise')");
    const r = await qr.execute("SELECT * FROM ft WHERE to_tsvector('english', body) @@ to_tsquery('moon')");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).body).toBe('moon rise');
  });

  it('translates tsquery & (AND) operators', async () => {
    const { qr, db } = makeRouter();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    db.exec("INSERT INTO ft (body) VALUES ('hello world'), ('hello moon')");
    const r = await qr.execute("SELECT * FROM ft WHERE body @@ to_tsquery('hello & world')");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).body).toBe('hello world');
  });
});

describe('QueryRouter — CREATE INDEX CONCURRENTLY (CONCURRENTLY stripping)', () => {
  it('strips CONCURRENTLY and actually creates the index', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER, name TEXT)');
    // If CONCURRENTLY is not stripped, SQLite rejects the statement with
    // `near "idx": syntax error` and no index is created.
    const r = await qr.execute('CREATE INDEX CONCURRENTLY idx_t_name ON t (name)');
    expect(r.engine).toBe('shard');
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_name'",
    ).get();
    expect(idx).toEqual({ name: 'idx_t_name' });
  });

  it('strips CONCURRENTLY from DROP INDEX', async () => {
    const { qr, db } = makeRouter();
    await qr.execute('CREATE TABLE t (id INTEGER, name TEXT)');
    await qr.execute('CREATE INDEX idx_t_name ON t (name)');
    const r = await qr.execute('DROP INDEX CONCURRENTLY idx_t_name');
    expect(r.engine).toBe('shard');
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_t_name'",
    ).get();
    expect(idx).toBeUndefined();
  });
});

describe('QueryRouter — advisory lock functions (pg_advisory_* → SELECT 1)', () => {
  it('rewrites pg_advisory_lock to SELECT 1', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT pg_advisory_lock(12345)');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any)['1']).toBe(1);
  });

  it('rewrites pg_advisory_unlock to SELECT 1', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT pg_advisory_unlock(12345)');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any)['1']).toBe(1);
  });

  it('rewrites pg_advisory_unlock_all to SELECT 1', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT pg_advisory_unlock_all()');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any)['1']).toBe(1);
  });

  it('rewrites the two-key pg_try_advisory_lock to SELECT 1', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT pg_try_advisory_lock(42, 99)');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any)['1']).toBe(1);
  });
});

describe('QueryRouter — type cast (::) in the SELECT fast path', () => {
  it('rewrites ::int to CAST AS INTEGER', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute("SELECT '123'::int AS n");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).n).toBe(123);
  });

  it('rewrites ::text to CAST AS TEXT', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT 456::text AS s');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).s).toBe('456');
  });
});

describe('QueryRouter — JSONB operators in the SELECT fast path', () => {
  it('translates doc @> to json_extract containment', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (doc TEXT)');
    db.exec('INSERT INTO t (doc) VALUES (\'{"a":1,"b":2}\'), (\'{"a":5}\')');
    const r = await qr.execute("SELECT * FROM t WHERE doc @> '{\"a\":1}'");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).doc).toBe('{"a":1,"b":2}');
  });

  it('translates doc->>\'key\' to json_extract', async () => {
    const { qr, db } = makeRouter();
    db.exec('CREATE TABLE t (doc TEXT)');
    db.exec('INSERT INTO t (doc) VALUES (\'{"a":1}\'), (\'{"a":5}\')');
    const r = await qr.execute("SELECT doc->>'a' AS a FROM t");
    expect(r.rowCount).toBe(2);
    expect((r.rows[0] as any).a).toBe(1);
    expect((r.rows[1] as any).a).toBe(5);
  });
});

describe('QueryRouter — PG expression rewrites in the SELECT fast path', () => {
  it('rewrites ROW(...) to json_array', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute("SELECT ROW(1, 'a') AS r");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).r).toBe('[1,"a"]');
  });

  it('rewrites ARRAY[...] to json_array', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT ARRAY[1,2,3] AS a');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).a).toBe('[1,2,3]');
  });

  it('expands range overlap && to a boolean expression', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT int4range(1,5) && int4range(3,8) AS o');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).o).toBe(1);
  });

  it('rewrites DISTINCT ON to a ROW_NUMBER window subquery', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT DISTINCT ON (a) a, b FROM (SELECT 1 a, 2 b UNION ALL SELECT 1, 3)');
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).a).toBe(1);
    expect((r.rows[0] as any).b).toBe(2);
  });

  it('rewrites xmlelement to a benign XML literal', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute("SELECT xmlelement(name foo) AS x");
    expect(r.rowCount).toBe(1);
    expect((r.rows[0] as any).x).toBe('<xml/>');
  });
});

describe('QueryRouter — UUID functions in the SELECT fast path', () => {
  it('rewrites gen_random_uuid() to a 32-hex random value', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT gen_random_uuid() AS u');
    expect(r.rowCount).toBe(1);
    const u = (r.rows[0] as any).u;
    expect(u).toMatch(/^[0-9a-f]{32}$/i);
  });

  it('rewrites uuid_generate_v4() to a valid v4 UUID', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT uuid_generate_v4() AS u');
    expect(r.rowCount).toBe(1);
    const u = (r.rows[0] as any).u;
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

describe('QueryRouter — system catalog views in the SELECT fast path', () => {
  it('returns synthetic rows for pg_stat_bgwriter', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT * FROM pg_stat_bgwriter');
    expect(r.rowCount).toBeGreaterThanOrEqual(1);
    const keys = Object.keys(r.rows[0] as any);
    expect(keys).toContain('checkpoints_timed');
  });

  it('returns synthetic rows for pg_settings', async () => {
    const { qr } = makeRouter();
    const r = await qr.execute('SELECT * FROM pg_settings');
    expect(r.rowCount).toBeGreaterThanOrEqual(1);
    const keys = Object.keys(r.rows[0] as any);
    expect(keys).toContain('name');
    expect(keys).toContain('setting');
  });
});
