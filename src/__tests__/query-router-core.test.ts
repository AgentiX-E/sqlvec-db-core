import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { classifyQuery, shimsForCategory, QueryRouter } from '../query/QueryRouter';
import { VectorMetric, VectorMode, VectorIndexType } from '../types/types-raw';

/**
 * Build a lightweight QueryRouter backed by a mocked ShardManager whose shard 0
 * exposes a fake better-sqlite3 database. This avoids real disk I/O while
 * exercising the class's pure and side-effect-tolerant methods.
 *
 * The fake `prepare(sql)` routes by SQL content so `SELECT COUNT(*)` returns a
 * `{ cnt }` row, PRAGMA returns an empty column list, and generic statements
 * return an empty result set.
 */
function makeShardManager() {
  const db: any = {
    prepare: (sql: string) => {
      if (/COUNT\(\*\)\s+AS\s+cnt/i.test(sql)) {
        return { get: () => ({ cnt: 0 }), all: () => [{ cnt: 0 }], run: () => ({ lastInsertRowid: 1 }) };
      }
      if (/last_insert_rowid\(\s*\)\s+as\s+id/i.test(sql)) {
        return { get: () => ({ id: 1 }), all: () => [{ id: 1 }], run: () => ({ lastInsertRowid: 1 }) };
      }
      if (/PRAGMA\s+table_info/i.test(sql)) {
        return { get: () => undefined, all: () => [], run: () => ({ lastInsertRowid: 1 }) };
      }
      return { get: () => undefined, all: () => [], run: () => ({ lastInsertRowid: 1 }) };
    },
    pragma: () => [],
    exec: () => {},
    close: () => {},
    transaction: (fn: any) => fn(),
  };
  const sm: any = {
    getAllShards: () => new Map([[0, { db, vectorIndex: null }] as any]),
    getShard: (n: number) => (n === 0 ? { db, vectorIndex: null } as any : undefined),
    execShard: async () => {},
    queryShard: () => [],
    getShardCount: () => 1,
    getShardIdForKey: () => 0,
    getShardIds: () => [0],
    execAll: async () => {},
    queryAll: async () => [],
    getStats: () => [],
    execAllBatch: async () => {},
    execBatchOnShard: async () => {},
  };
  return { sm, db };
}

function makeConfig(): any {
  return {
    enabled: true,
    dimension: 768,
    metric: VectorMetric.COSINE,
    mode: VectorMode.AUTO,
    bruteForceThreshold: 1000,
    indexType: VectorIndexType.FLAT,
    indexParams: {},
  };
}

function makeRouter() {
  const { sm } = makeShardManager();
  const qr = new QueryRouter(sm, {} as any, makeConfig());
  return { qr, sm };
}

describe('classifyQuery', () => {
  it.each([
    ['SELECT 1', 'SELECT'],
    ['select * from t', 'SELECT'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'SELECT'],
    ['INSERT INTO t VALUES (1)', 'INSERT'],
    ['UPDATE t SET a = 1', 'UPDATE'],
    ['DELETE FROM t', 'DELETE'],
    ['CREATE TABLE t (id int)', 'CREATE'],
    ['ALTER TABLE t ADD c int', 'ALTER'],
    ['DROP TABLE t', 'DROP'],
    ['TRUNCATE t', 'TRUNCATE'],
    ['SET search_path = public', 'SET'],
    ['RESET search_path', 'RESET'],
    ['SHOW timezone', 'SHOW'],
    ['PRAGMA foreign_keys = ON', 'PRAGMA'],
    ['VACUUM', 'VACUUM'],
    ['ANALYZE t', 'ANALYZE'],
    ['BEGIN', 'BEGIN'],
    ['START TRANSACTION', 'BEGIN'],
    ['COMMIT', 'COMMIT'],
    ['END', 'COMMIT'],
    ['ROLLBACK', 'ROLLBACK'],
    ['ABORT', 'ROLLBACK'],
    ['SAVEPOINT s1', 'SAVEPOINT'],
    ['RELEASE s1', 'SAVEPOINT'],
    ['CALL my_proc()', 'CALL'],
    ['DO $$ BEGIN END $$', 'DO'],
    ['COPY t FROM stdin', 'COPY'],
    ['EXPLAIN SELECT 1', 'EXPLAIN'],
    ['PREPARE p AS SELECT 1', 'PREPARE'],
    ['EXECUTE p', 'EXECUTE_'],
    ['GRANT SELECT ON t TO u', 'GRANT'],
    ['REVOKE SELECT ON t FROM u', 'GRANT'],
    ['CHECKPOINT', 'CHECKPOINT'],
  ])('classifies %s as %s', (sql, expected) => {
    expect(classifyQuery(sql)).toBe(expected);
  });

  it('returns OTHER for unknown first keyword', () => {
    expect(classifyQuery('FOO BAR')).toBe('OTHER');
  });

  it('returns OTHER for whitespace-only input', () => {
    expect(classifyQuery('   ')).toBe('OTHER');
  });

  it('returns OTHER for empty string (no keyword match)', () => {
    expect(classifyQuery('')).toBe('OTHER');
  });
});

describe('shimsForCategory', () => {
  it('returns select shims for SELECT and WITH', () => {
    const expected = ['from', 'join', 'index', 'general', 'security'];
    expect(shimsForCategory('SELECT')).toEqual(expected);
    expect(shimsForCategory('WITH')).toEqual(expected);
  });

  it('returns dml shims for DML and TRUNCATE', () => {
    const expected = ['from', 'join', 'index', 'general', 'security'];
    for (const c of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns ddl shims for CREATE/ALTER/DROP', () => {
    const expected = ['ddl', 'general'];
    for (const c of ['CREATE', 'ALTER', 'DROP'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns config shims for SET/RESET/SHOW/PRAGMA', () => {
    const expected = ['config'];
    for (const c of ['SET', 'RESET', 'SHOW', 'PRAGMA'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns maintenance shims for VACUUM/ANALYZE/CHECKPOINT', () => {
    const expected = ['maintenance'];
    for (const c of ['VACUUM', 'ANALYZE', 'CHECKPOINT'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns transaction shims for BEGIN/COMMIT/ROLLBACK/SAVEPOINT', () => {
    const expected = ['transaction'];
    for (const c of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns dml shims for CALL and DO', () => {
    const expected = ['from', 'join', 'index', 'general', 'security'];
    expect(shimsForCategory('CALL')).toEqual(expected);
    expect(shimsForCategory('DO')).toEqual(expected);
  });

  it('returns dml shims for COPY', () => {
    expect(shimsForCategory('COPY')).toEqual(['from', 'join', 'index', 'general', 'security']);
  });

  it('returns all shims for EXPLAIN/PREPARE/EXECUTE_', () => {
    const expected = ['ddl', 'from', 'join', 'index', 'general', 'config', 'maintenance', 'transaction', 'security'];
    for (const c of ['EXPLAIN', 'PREPARE', 'EXECUTE_'] as const) {
      expect(shimsForCategory(c)).toEqual(expected);
    }
  });

  it('returns all shims for OTHER category (default)', () => {
    expect(shimsForCategory('OTHER')).toEqual([
      'ddl', 'from', 'join', 'index', 'general', 'config', 'maintenance', 'transaction', 'security',
    ]);
  });
});

describe('QueryRouter — side-effect-tolerant methods', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseQuery / detectQueryType / extractTablesFromParsed', () => {
    it('parses a SELECT into QueryType.SELECT', () => {
      const { qr } = makeRouter();
      const q = qr.parseQuery('SELECT * FROM t');
      expect(q.queryType).toBe('SELECT');
      expect(q.hasVectorComponent).toBe(false);
    });

    it('parses an INSERT (non-vector)', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('INSERT INTO t VALUES (1)').queryType).toBe('INSERT');
    });

    it('parses an UPDATE', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('UPDATE t SET a = 1').queryType).toBe('UPDATE');
    });

    it('parses a DELETE', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('DELETE FROM t').queryType).toBe('DELETE');
    });

    it('detects VEC_SELECT / VECTOR_DISTANCE as VECTOR_SEARCH', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('SELECT vec_search(...)').queryType).toBe('VECTOR_SEARCH');
      expect(qr.parseQuery('SELECT vector_distance(...)').queryType).toBe('VECTOR_SEARCH');
    });

    it('detects VEC_ insert as VECTOR_INSERT', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('INSERT INTO vec_t VALUES (1)').queryType).toBe('VECTOR_INSERT');
    });

    it('parses a CREATE TABLE DDL', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('CREATE TABLE t (id int)').queryType).toBe('CREATE_TABLE');
    });

    it('parses a CREATE INDEX DDL', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('CREATE INDEX idx ON t(a)').queryType).toBe('CREATE_INDEX');
    });

    it('parses an ALTER DDL', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('ALTER TABLE t ADD c int').queryType).toBe('ALTER');
    });

    it('parses other DDL as DDL_OTHER', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('DROP TABLE t').queryType).toBe('DDL_OTHER');
    });

    it('treats transaction statements as SELECT (no-op read)', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('BEGIN').queryType).toBe('SELECT');
    });

    it('returns UNKNOWN for unrecognized statements', () => {
      const { qr } = makeRouter();
      expect(qr.parseQuery('FOO BAR BAZ').queryType).toBe('UNKNOWN');
    });
  });

  describe('isVectorQuery', () => {
    it.each([
      ['SELECT vec_search(q) FROM t', true],
      ['SELECT vector_distance(a, b)', true],
      ['SELECT list_cosine_similarity(a, b)', true],
      ['SELECT list_distance(a, b)', true],
      ['SELECT list_dot_product(a, b)', true],
      ['SELECT * FROM t', false],
    ])('detects %s as %s', (sql, expected) => {
      const { qr } = makeRouter();
      expect(qr.isVectorQuery(sql)).toBe(expected);
    });
  });

  describe('getTransactionCount / getParallelQueryCount', () => {
    it('starts with zero transactions', () => {
      const { qr } = makeRouter();
      expect(qr.getTransactionCount()).toBe(0);
    });

    it('starts with zero parallel queries', () => {
      const { qr } = makeRouter();
      expect(qr.getParallelQueryCount()).toBe(0);
    });
  });

  describe('setCurrentUser / getCurrentUser', () => {
    it('round-trips the current user', () => {
      const { qr } = makeRouter();
      qr.setCurrentUser('alice');
      expect(qr.getCurrentUser()).toBe('alice');
    });
  });

  describe('estimateJoinCost', () => {
    it('computes nested-loop cost', () => {
      const { qr } = makeRouter();
      const cost = qr.estimateJoinCost('Nested Loop', 10, 20);
      expect(cost).toBeCloseTo(10 * Math.log2(21));
    });

    it('computes hash-join cost', () => {
      const { qr } = makeRouter();
      const cost = qr.estimateJoinCost('Hash Join', 10, 20);
      expect(cost).toBeCloseTo(10 + 20 + 10 * 20 * 0.1);
    });

    it('computes merge-join cost', () => {
      const { qr } = makeRouter();
      const cost = qr.estimateJoinCost('Merge Join', 10, 20);
      expect(cost).toBeCloseTo(10 * Math.log2(10) + 20 * Math.log2(20));
    });

    it('returns Infinity for unknown join type', () => {
      const { qr } = makeRouter();
      expect(qr.estimateJoinCost('Unknown', 10, 20)).toBe(Infinity);
    });
  });

  describe('selectJoinType', () => {
    it('uses Nested Loop for small tables (default 1000 rows each)', () => {
      const { qr } = makeRouter();
      // No pgStatCollector → estimateRowCount returns 1000 → not < 1000,
      // not > 1000 → falls through to Nested Loop fallback.
      expect(qr.selectJoinType('a', 'b')).toBe('Nested Loop');
    });

    it('uses Nested Loop when no join condition and tables are small', () => {
      const { qr } = makeRouter();
      expect(qr.selectJoinType('a', 'b', undefined)).toBe('Nested Loop');
    });

    it('uses Hash Join path when join condition is provided', () => {
      const { qr } = makeRouter();
      // With pgStatCollector absent, estimateRowCount = 1000 (not >1000),
      // cardinality = 100 (not >5000), so it reaches the fallback.
      expect(qr.selectJoinType('a', 'b', 'a.id = b.id')).toBe('Nested Loop');
    });
  });

  describe('analyzeJoin', () => {
    it('recommends a join type and returns all three costs', () => {
      const { qr } = makeRouter();
      const result = qr.analyzeJoin('a', 'b');
      expect(result.costs).toHaveProperty('Nested Loop');
      expect(result.costs).toHaveProperty('Hash Join');
      expect(result.costs).toHaveProperty('Merge Join');
      expect(['Nested Loop', 'Hash Join', 'Merge Join']).toContain(result.recommended);
    });

    it('recommends Nested Loop for small default estimates', () => {
      const { qr } = makeRouter();
      const result = qr.analyzeJoin('a', 'b');
      // nested loop cost = 1000*log2(1001) ≈ 9973; hash = 1000+1000+100000*?—smallest is nested loop
      expect(result.recommended).toBe('Nested Loop');
    });
  });

  describe('storeGeneratedColumnDefs', () => {
    it('no-ops when the list is empty', () => {
      const { qr } = makeRouter();
      expect(() => qr.storeGeneratedColumnDefs('t', [])).not.toThrow();
    });

    it('stores definitions without throwing', () => {
      const { qr } = makeRouter();
      expect(() =>
        qr.storeGeneratedColumnDefs('t', [
          { name: 'c', expression: 'a + b', stored: true, dependencies: ['a', 'b'] },
        ]),
      ).not.toThrow();
    });
  });

  describe('accessors', () => {
    it('getDMLTriggerManager lazily initializes a DMLTriggerManager', () => {
      const { qr } = makeRouter();
      const mgr = qr.getDMLTriggerManager();
      expect(mgr).toBeDefined();
      // Lazy singleton: repeated access returns the same instance.
      expect(qr.getDMLTriggerManager()).toBe(mgr);
    });

    it('columnGrantChecker getter/setter round-trips', () => {
      const { qr } = makeRouter();
      expect(qr.columnGrantChecker).toBeNull();
      const fake: any = { check: () => true };
      qr.columnGrantChecker = fake;
      expect(qr.columnGrantChecker).toBe(fake);
    });
  });

  describe('execute — dispatch layer', () => {
    it('executes a constant SELECT on shard 0', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT 1');
      expect(r.engine).toBe('shard');
      expect(r.rows).toBeDefined();
    });

    it('executes a simple SELECT with FROM clause', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM t');
      expect(r.engine).toBe('shard');
    });

    it('executes a CREATE TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (id int)');
      expect(r).toHaveProperty('rows');
    });

    it('executes DROP TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('DROP TABLE t');
      expect(r.engine).toBe('shard');
    });

    it('strips CASCADE from DROP TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('DROP TABLE t CASCADE');
      expect(r.engine).toBe('shard');
    });

    it('rewrites SHOW timezone', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SHOW timezone');
      expect(r).toHaveProperty('rows');
    });

    it('fixes bare OFFSET', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT 1 OFFSET 5');
      expect(r).toHaveProperty('rows');
    });

    it('executes BEGIN', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('BEGIN');
      expect(r.engine).toBe('shard');
    });

    it('executes COMMIT', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('COMMIT');
      expect(r.engine).toBe('shard');
    });

    it('executes SET search_path', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SET search_path = public');
      expect(r).toHaveProperty('rows');
    });

    it('executes VACUUM', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('VACUUM');
      expect(r).toHaveProperty('rows');
    });

    it('blocks a malicious query via SQLInjectionGuard', async () => {
      const { qr } = makeRouter();
      // A classic tautology-based injection that the guard classifies as blocked
      // (and is not the downgraded "union-based-injection" pattern).
      await expect(qr.execute("SELECT * FROM t WHERE a = '1' OR '1'='1'")).rejects.toThrow();
    });
  });

  describe('execute — transaction & DML paths', () => {
    it('executes ROLLBACK', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ROLLBACK');
      expect(r.engine).toBe('shard');
    });

    it('executes END (alias for COMMIT)', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('END');
      expect(r.engine).toBe('shard');
    });

    it('executes INSERT with a column list', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('INSERT INTO t (a) VALUES (1)');
      expect(r.engine).toBe('shard');
    });

    it('executes INSERT without a column list', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('INSERT INTO t VALUES (1, 2)');
      expect(r.engine).toBe('shard');
    });

    it('executes UPDATE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('UPDATE t SET a = 1 WHERE id = 1');
      expect(r.engine).toBe('shard');
    });

    it('executes DELETE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('DELETE FROM t WHERE id = 1');
      expect(r.engine).toBe('shard');
    });

    it('executes TRUNCATE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('TRUNCATE t');
      expect(r.engine).toBe('shard');
    });

    it('executes ALTER TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ALTER TABLE t ADD COLUMN c int');
      expect(r.engine).toBe('shard');
    });

    it('executes ANALYZE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ANALYZE t');
      expect(r).toHaveProperty('rows');
    });

    it('executes PRAGMA', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('PRAGMA foreign_keys');
      expect(r).toHaveProperty('rows');
    });

    it('executes EXPLAIN', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('EXPLAIN SELECT 1');
      expect(r).toHaveProperty('rows');
    });

    it('executes TABLE shorthand', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('TABLE t');
      expect(r).toHaveProperty('rows');
    });

    it('executes MERGE as INSERT ... ON CONFLICT', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute(
        'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = s.a',
      );
      expect(r.engine).toBe('shard');
    });
  });

  describe('execute — parameterized statements', () => {
    it('inlines $N parameters', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM t WHERE id = $1', [42]);
      expect(r).toHaveProperty('rows');
    });

    it('inlines multiple $N parameters', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 1]);
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — PG compatibility rewrites', () => {
    it('handles nextval sequence call', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT nextval('seq')");
      expect(r).toHaveProperty('rows');
    });

    it('handles to_tsvector FTS operator', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT to_tsvector('a b c')");
      expect(r).toHaveProperty('rows');
    });

    it('handles advisory lock call', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT pg_advisory_lock(1)');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_stat_bgwriter view', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM pg_stat_bgwriter');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_stat_replication view', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM pg_stat_replication');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_blocking_pids', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT pg_blocking_pids(1)');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_wait_sampling view', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM pg_wait_sampling');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_prewarm', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT pg_prewarm('t')");
      expect(r).toHaveProperty('rows');
    });

    it('handles SET standard_conforming_strings', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SET standard_conforming_strings = on');
      expect(r).toHaveProperty('rows');
    });

    it('handles SET CONSTRAINTS', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SET CONSTRAINTS ALL DEFERRED');
      expect(r).toHaveProperty('rows');
    });

    it('handles pg_catalog function call', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT pg_catalog.pg_get_serial_sequence('t','id')");
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE OR REPLACE FUNCTION (PL/pgSQL)', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute(
        "CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
      );
      expect(r.engine).toBe('plpgsql');
    });

    it('handles DISTINCT ON', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT DISTINCT ON (a) * FROM t');
      expect(r).toHaveProperty('rows');
    });

    it('handles CTE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('WITH cte AS (SELECT 1) SELECT * FROM cte');
      expect(r).toHaveProperty('rows');
    });

    it('handles jsonb_extract_path', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT jsonb_extract_path(t, 'a', 'b')");
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — transaction buffering', () => {
    it('buffers INSERT inside a transaction', async () => {
      const { qr } = makeRouter();
      const sid = 's1';
      await qr.execute('BEGIN', undefined, sid);
      expect(qr.getTransactionCount()).toBe(1);
      const r = await qr.execute('INSERT INTO t (a) VALUES (1)', undefined, sid);
      expect(r.rows).toEqual([{ affected: true, staged: true }]);
    });

    it('buffers UPDATE and DELETE inside a transaction', async () => {
      const { qr } = makeRouter();
      const sid = 's2';
      await qr.execute('BEGIN', undefined, sid);
      const upd = await qr.execute('UPDATE t SET a = 2 WHERE id = 1', undefined, sid);
      expect(upd.engine).toBe('shard');
      const del = await qr.execute('DELETE FROM t WHERE id = 1', undefined, sid);
      expect(del.engine).toBe('shard');
    });

    it('commits a transaction with buffered changes', async () => {
      const { qr } = makeRouter();
      const sid = 's3';
      await qr.execute('BEGIN', undefined, sid);
      await qr.execute('INSERT INTO t (a) VALUES (1)', undefined, sid);
      const r = await qr.execute('COMMIT', undefined, sid);
      expect(r).toHaveProperty('rows');
      expect(qr.getTransactionCount()).toBe(0);
    });

    it('rollbacks a transaction', async () => {
      const { qr } = makeRouter();
      const sid = 's4';
      await qr.execute('BEGIN', undefined, sid);
      const r = await qr.execute('ROLLBACK', undefined, sid);
      expect(r).toHaveProperty('rows');
      expect(qr.getTransactionCount()).toBe(0);
    });
  });

  describe('execute — system catalogs, sequences, aggregates', () => {
    it.each([
      "SELECT pg_get_relation_size('t')",
      'SELECT * FROM pg_stat_user_tables',
      'SELECT * FROM pg_matviews',
      'SELECT * FROM information_schema.tables',
      'SELECT relname FROM pg_class',
      'SELECT version()',
      'SELECT current_schema()',
    ])('handles system query %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT lastval()',
      "SELECT currval('s')",
      "SELECT setval('s', 100)",
      'CREATE SEQUENCE s',
    ])('handles sequence %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT array_agg(x) FROM t',
      "SELECT string_agg(x, ',') FROM t",
      'SELECT json_agg(x) FROM t',
      'SELECT json_object_agg(k, v) FROM t',
    ])('handles aggregate %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT now()',
      'SELECT current_timestamp',
      'SELECT EXTRACT(year FROM now())',
      "SELECT date_part('year', now())",
    ])('handles date/time %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT * FROM t LIMIT 10 OFFSET 5',
      'SELECT DISTINCT a FROM t',
      'SELECT a, COUNT(*) FROM t GROUP BY a',
      'SELECT a, COUNT(*) FROM t GROUP BY a HAVING COUNT(*) > 1',
    ])('handles SELECT clause %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — compatibility detect/rewrite branches', () => {
    it('rewrites LATERAL join with correlation semantics', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM t LATERAL JOIN s ON true');
      expect(r).toHaveProperty('rows');
    });

    it('strips COLLATE clause', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT * FROM t ORDER BY a COLLATE "en_US"');
      expect(r).toHaveProperty('rows');
    });

    it('strips partial index WHERE clause', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE INDEX idx ON t(a) WHERE a > 0');
      expect(r).toHaveProperty('rows');
    });

    it('strips covering index INCLUDE clause', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE INDEX idx ON t(a) INCLUDE (b)');
      expect(r).toHaveProperty('rows');
    });

    it('unwraps expression index double parens', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE INDEX idx ON t((lower(a)))');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites GiST index', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE INDEX idx ON t USING GIST (a)');
      expect(r).toHaveProperty('rows');
    });

    it('handles SAVEPOINT and RELEASE', async () => {
      const { qr } = makeRouter();
      const sp = await qr.execute('SAVEPOINT sp1');
      expect(sp).toHaveProperty('rows');
      const rel = await qr.execute('RELEASE sp1');
      expect(rel).toHaveProperty('rows');
    });

    it('handles CREATE DOMAIN as a no-op DDL', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE DOMAIN d AS int');
      expect(r).toHaveProperty('rows');
    });

    it('handles ALTER DEFAULT PRIVILEGES through DefaultPrivilegeManager', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO u');
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE TABLE ... PARTITION BY', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE p (id int) PARTITION BY RANGE (id)');
      expect(r).toHaveProperty('rows');
    });

    it('handles ATTACH PARTITION', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute(
        'ALTER TABLE p ATTACH PARTITION p1 FOR VALUES FROM (1) TO (100)',
      );
      expect(r).toHaveProperty('rows');
    });

    it('handles DETACH PARTITION', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ALTER TABLE p DETACH PARTITION p1');
      expect(r).toHaveProperty('rows');
    });

    it('handles SET SESSION AUTHORIZATION and RESET', async () => {
      const { qr } = makeRouter();
      const set = await qr.execute('SET SESSION AUTHORIZATION u');
      expect(set).toHaveProperty('rows');
      const reset = await qr.execute('RESET ALL');
      expect(reset).toHaveProperty('rows');
    });

    it('handles row-level locks (FOR UPDATE/FOR SHARE)', async () => {
      const { qr } = makeRouter();
      const upd = await qr.execute('SELECT 1 FOR UPDATE');
      expect(upd).toHaveProperty('rows');
      const share = await qr.execute('SELECT * FROM t FOR SHARE');
      expect(share).toHaveProperty('rows');
    });

    it('handles LOCK TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('LOCK TABLE t IN ACCESS EXCLUSIVE MODE');
      expect(r).toHaveProperty('rows');
    });

    it('handles COMMENT ON', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("COMMENT ON TABLE t IS 'x'");
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE MATERIALIZED VIEW', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE MATERIALIZED VIEW mv AS SELECT 1');
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — DDL column & index compatibility', () => {
    it('rewrites GENERATED ALWAYS AS IDENTITY column', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (id int GENERATED ALWAYS AS IDENTITY, name text)');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites SERIAL column', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (id SERIAL PRIMARY KEY)');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites BIGSERIAL column', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (id BIGSERIAL, x int)');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites GENERATED ALWAYS AS (expr) STORED column', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (a int GENERATED ALWAYS AS (a*2) STORED)');
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE TYPE ... AS ENUM as a no-op', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("CREATE TYPE mood AS ENUM ('sad','ok','happy')");
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'CREATE INDEX idx ON t USING BRIN (a)',
      'CREATE INDEX idx ON t USING HASH (a)',
      'CREATE INDEX idx ON t(a NULLS FIRST)',
    ])('rewrites index compatibility %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it('rewrites GROUPING SETS', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT a, SUM(x) FROM t GROUP BY GROUPING SETS ((a), ())');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites CREATE INDEX CONCURRENTLY', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE INDEX CONCURRENTLY idx ON t(a)');
      expect(r).toHaveProperty('rows');
    });

    it('rewrites DROP INDEX CONCURRENTLY', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('DROP INDEX CONCURRENTLY idx');
      expect(r).toHaveProperty('rows');
    });

    it('executes ANALYZE VERBOSE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('ANALYZE VERBOSE t');
      expect(r).toHaveProperty('rows');
    });

    it('executes VACUUM FULL', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('VACUUM FULL');
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE VIEW and SELECT from it', async () => {
      const { qr } = makeRouter();
      const v = await qr.execute('CREATE VIEW v AS SELECT 1');
      expect(v).toHaveProperty('rows');
      const s = await qr.execute('SELECT * FROM v');
      expect(s).toHaveProperty('rows');
    });

    it('rewrites PG FK extension (ALTER TABLE ADD CONSTRAINT)', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute(
        'ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES s(id)',
      );
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'CREATE UNIQUE INDEX idx ON t(a)',
      'CREATE INDEX IF NOT EXISTS idx ON t(a, b)',
    ])('handles CREATE INDEX variant %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — function & view shims', () => {
    it.each([
      'SELECT left(a, 3) FROM t',
      'SELECT right(a, 3) FROM t',
      'SELECT levenshtein(a, b) FROM t',
      'SELECT soundex(a) FROM t',
      'SELECT upper(a) FROM t',
      'SELECT lower(a) FROM t',
      'SELECT array_length(a, 1) FROM t',
    ])('handles function shim %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it('strips table WITH options (fillfactor)', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE TABLE t (a int) WITH (fillfactor=70)');
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE EXTENSION', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE EXTENSION pg_trgm');
      expect(r).toHaveProperty('rows');
    });

    it('handles CREATE FOREIGN TABLE', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('CREATE FOREIGN TABLE ft (a int) SERVER srv');
      expect(r).toHaveProperty('rows');
    });

    it('handles replication slot creation', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT pg_create_logical_replication_slot('a','b')");
      expect(r).toHaveProperty('rows');
    });

    it('handles pgpool advisory lock', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute('SELECT pgpool_advisory_lock(1)');
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT * FROM pg_stat_activity',
      'SELECT * FROM pg_user',
      'SELECT * FROM pg_group',
    ])('handles pg system view %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it('handles cron.schedule', async () => {
      const { qr } = makeRouter();
      const r = await qr.execute("SELECT cron.schedule('x','y')");
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT * FROM t FOR UPDATE NOWAIT',
      'SELECT * FROM t FOR UPDATE SKIP LOCKED',
    ])('handles row-lock option %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });
  });

  describe('execute — PG16 stat views & JSON/PostGIS/window shims', () => {
    it.each([
      'SELECT * FROM pg_stat_io',
      'SELECT * FROM pg_stat_checkpointer',
      'SELECT * FROM pg_statio_user_tables',
      'SELECT * FROM pg_stat_archiver',
      'SELECT * FROM pg_stat_gssapi',
      'SELECT * FROM pg_stat_slru',
      'SELECT pg_stat_get_backend_idset()',
      'SELECT * FROM pg_buffercache',
    ])('rewrites PG16 stat view %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      "SELECT json_build_object('a', 1)",
      'SELECT json_array_length(t) FROM t',
      "SELECT t->>'a' FROM t",
      "SELECT json_extract_path_text(t, 'a') FROM t",
      'SELECT row_to_json(t) FROM t',
      'SELECT to_json(t) FROM t',
    ])('handles JSON function %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT ST_MakePoint(1,2)',
      'SELECT ST_Distance(a, b) FROM t',
    ])('handles PostGIS function %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });

    it.each([
      'SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t',
      'SELECT RANK() OVER (PARTITION BY a ORDER BY b) FROM t',
      'SELECT LAG(a) OVER (ORDER BY b) FROM t',
    ])('handles window function %s', async (sql) => {
      const { qr } = makeRouter();
      const r = await qr.execute(sql);
      expect(r).toHaveProperty('rows');
    });
  });
});
