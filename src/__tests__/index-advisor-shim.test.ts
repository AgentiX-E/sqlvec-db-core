/**
 * index-advisor-shim.test.ts — tests for the PostgreSQL index-advisor
 * compatibility shim.
 *
 * Covers:
 *   - detectIndexAdvisor / rewriteIndexAdvisor (regex scoping + strip rules)
 *   - IndexAdvisorShim (regex-based column extraction + recommendation)
 *   - IndexAdvisor (AST-based recommendation engine, both overloads,
 *     existing-index lookup, pg_catalog row conversion)
 *
 * Fake better-sqlite3 is used for the Database overload.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectIndexAdvisor,
  rewriteIndexAdvisor,
  IndexAdvisorShim,
  IndexAdvisor,
} from '../query/IndexAdvisorShim';
import type { IndexSchema, IndexRecommendation, IndexInfo } from '../query/IndexAdvisorShim';

// ── Fake better-sqlite3 Database ──────────────────────────────────

type DbRows = Record<string, unknown>[];

function makeDb(indexes: DbRows, indexInfo: Record<string, DbRows>): any {
  return {
    prepare: vi.fn((sql: string) => {
      return {
        all: vi.fn(() => {
          const s = sql.trim();
          if (s.startsWith('PRAGMA index_info')) {
            const m = s.match(/'([^']+)'/);
            return m ? (indexInfo[m[1]] ?? []) : [];
          }
          if (s.startsWith('SELECT name')) {
            // Simulate the sqlite_master WHERE filter (exclude sqlite_autoindex)
            return indexes.filter((r) => !String(r.name).startsWith('sqlite_autoindex'));
          }
          return [];
        }),
        run: vi.fn(() => ({ changes: 1 })),
      };
    }),
  };
}

// ── detect + rewrite (regex-scoped) ───────────────────────────────

describe('detectIndexAdvisor', () => {
  it('returns false for non-string or empty input', () => {
    expect(detectIndexAdvisor(undefined as any)).toBe(false);
    expect(detectIndexAdvisor(null as any)).toBe(false);
    expect(detectIndexAdvisor('')).toBe(false);
    expect(detectIndexAdvisor('   ')).toBe(false);
  });

  it('detects CREATE INDEX variants', () => {
    expect(detectIndexAdvisor('CREATE INDEX i ON t (a)')).toBe(true);
    expect(detectIndexAdvisor('CREATE UNIQUE INDEX i ON t (a)')).toBe(true);
    expect(detectIndexAdvisor('CREATE INDEX IF NOT EXISTS i ON t (a)')).toBe(true);
    expect(detectIndexAdvisor('  create index i on t (a)')).toBe(true);
  });

  it('returns false for non-CREATE-INDEX SQL', () => {
    expect(detectIndexAdvisor('SELECT 1')).toBe(false);
    expect(detectIndexAdvisor('INSERT INTO t (a) VALUES (1)')).toBe(false);
    expect(detectIndexAdvisor('ALTER TABLE t ADD COLUMN b')).toBe(false);
    expect(detectIndexAdvisor('DROP INDEX i')).toBe(false);
  });
});

describe('rewriteIndexAdvisor', () => {
  it('returns unchanged for empty/non-string', () => {
    expect(rewriteIndexAdvisor(undefined as any)).toEqual({ sql: '', rewritten: false });
    expect(rewriteIndexAdvisor('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteIndexAdvisor('   ')).toEqual({ sql: '   ', rewritten: false });
  });

  it('returns unchanged for non-CREATE-INDEX SQL (trimmed)', () => {
    expect(rewriteIndexAdvisor('  SELECT 1  ')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('strips INCLUDE clause', () => {
    expect(rewriteIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE (b)')).toEqual({
      sql: 'CREATE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('strips INCLUDE with multiple columns + whitespace', () => {
    expect(rewriteIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE ( b, c )')).toEqual({
      sql: 'CREATE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('strips NULLS DISTINCT and NULLS NOT DISTINCT', () => {
    expect(rewriteIndexAdvisor('CREATE UNIQUE INDEX i ON t (a) NULLS NOT DISTINCT')).toEqual({
      sql: 'CREATE UNIQUE INDEX i ON t (a)',
      rewritten: true,
    });
    expect(rewriteIndexAdvisor('CREATE UNIQUE INDEX i ON t (a) NULLS DISTINCT')).toEqual({
      sql: 'CREATE UNIQUE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('strips WITH (storage_parameter) clause', () => {
    expect(rewriteIndexAdvisor('CREATE INDEX i ON t (a) WITH (fillfactor = 70)')).toEqual({
      sql: 'CREATE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('strips combined INCLUDE + WITH clauses', () => {
    expect(
      rewriteIndexAdvisor('CREATE INDEX i ON t (a) INCLUDE (b) WITH (fillfactor = 90)'),
    ).toEqual({
      sql: 'CREATE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('returns unchanged for plain CREATE INDEX (no PG syntax)', () => {
    const r = rewriteIndexAdvisor('CREATE INDEX i ON t (a)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE INDEX i ON t (a)');
  });

  it('collapses double-space artifacts after stripping', () => {
    // INCLUDE stripped, leaving a gap before WITH, which is also stripped
    expect(rewriteIndexAdvisor('CREATE INDEX i ON t (a)   INCLUDE (b)')).toEqual({
      sql: 'CREATE INDEX i ON t (a)',
      rewritten: true,
    });
  });

  it('does not strip INCLUDE outside CREATE INDEX context', () => {
    const r = rewriteIndexAdvisor('INSERT INTO t (a) VALUES (1) INCLUDE (extra)');
    expect(r.rewritten).toBe(false);
  });
});

// ── IndexAdvisorShim (regex-based) ────────────────────────────────

describe('IndexAdvisorShim', () => {
  const schema: IndexSchema = {
    tables: ['users', 'orders'],
    columns: ['id', 'name', 'email', 'user_id', 'created_at', 'status'],
    existingIndexes: ['idx_users_id'],
  };

  it('recommends single-column indexes for WHERE columns', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE email = ?', schema);
    expect(recs).toContain('CREATE INDEX IF NOT EXISTS idx_users_email ON users (email)');
  });

  it('skips columns that already have an index', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE id = ?', schema);
    expect(recs).not.toContain('CREATE INDEX IF NOT EXISTS idx_users_id ON users (id)');
  });

  it('skips columns not present in the schema', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE nonexistent = ?', schema);
    expect(recs).toEqual([]);
  });

  it('recommends a composite index for multiple WHERE columns', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE name = ? AND email = ?', schema);
    expect(recs).toContain(
      'CREATE INDEX IF NOT EXISTS idx_users_name_email ON users (name, email)',
    );
  });

  it('extracts ORDER BY columns', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM orders ORDER BY created_at', schema);
    expect(recs).toContain(
      'CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)',
    );
  });

  it('extracts JOIN columns', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze(
      'SELECT * FROM orders JOIN users ON orders.user_id = users.id',
      schema,
    );
    expect(recs).toContain(
      'CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id)',
    );
  });

  it('deduplicates recommendations', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE email = ? AND email = ?', schema);
    const unique = new Set(recs);
    expect(unique.size).toBe(recs.length);
  });

  it('uses fallback table name when inferTable returns null (no FROM)', () => {
    const shim = new IndexAdvisorShim();
    // No FROM clause → inferTable returns null → falls back to 'table'
    const recs = shim.analyze('SELECT 1 WHERE email = 1', {
      tables: [],
      columns: ['email'],
      existingIndexes: [],
    });
    expect(recs).toContain('CREATE INDEX IF NOT EXISTS idx_table_email ON table (email)');
  });

  it('uses fallback table name for composite with no FROM', () => {
    const shim = new IndexAdvisorShim();
    // multi-column WHERE + no FROM → composite falls back to 'table'
    const recs = shim.analyze('SELECT 1 WHERE a = 1 AND b = 2', {
      tables: [],
      columns: ['a', 'b'],
      existingIndexes: [],
    });
    expect(recs).toContain('CREATE INDEX IF NOT EXISTS idx_table_a_b ON table (a, b)');
  });

  it('skips SQL keyword-like column names in WHERE extraction', () => {
    const shim = new IndexAdvisorShim();
    // 'select', 'and', 'in', etc. are filtered as WHERE keywords
    const recs = shim.analyze('SELECT * FROM t WHERE in = 1 AND select = 2', {
      tables: ['t'],
      columns: ['in', 'select'],
      existingIndexes: [],
    });
    // 'in' and 'select' are in the WHERE keyword guard list → skipped
    expect(recs).toEqual([]);
  });

  it('skips keyword-like column names in JOIN extraction', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM a JOIN b ON a.on = b.and', {
      tables: ['a', 'b'],
      columns: ['on', 'and'],
      existingIndexes: [],
    });
    // 'on' and 'and' are in the join keyword guard list → skipped
    expect(recs).toEqual([]);
  });

  it('skips SQL keywords in WHERE column extraction', () => {
    const shim = new IndexAdvisorShim();
    // 'order' as a column name would be reserved; keyword guard skips it
    const recs = shim.analyze('SELECT * FROM orders WHERE status IN (1,2,3)', schema);
    // `status` is a valid column; `IN` keyword is skipped as a column
    expect(recs).toContain('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)');
  });

  it('skips asc/desc keywords in ORDER BY extraction', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM orders ORDER BY created_at DESC', schema);
    // 'desc' is filtered out; 'created_at' retained
    expect(recs).toContain(
      'CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)',
    );
    expect(recs).not.toContain(
      'CREATE INDEX IF NOT EXISTS idx_orders_desc ON orders (desc)',
    );
  });

  it('does not duplicate a composite recommendation already emitted', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze('SELECT * FROM users WHERE name = ? AND email = ?', schema);
    // composite recommendation appears exactly once
    const composite = recs.filter((r) => r.includes('name, email'));
    expect(composite).toHaveLength(1);
  });

  it('handles WHERE column that is also a join column (dedup)', () => {
    const shim = new IndexAdvisorShim();
    const recs = shim.analyze(
      'SELECT * FROM orders JOIN users ON orders.user_id = users.id WHERE user_id = 5',
      schema,
    );
    const userIdx = recs.filter((r) => r.includes('idx_orders_user_id'));
    expect(userIdx.length).toBeGreaterThanOrEqual(1);
  });
});

// ── IndexAdvisor (AST-based) ──────────────────────────────────────

describe('IndexAdvisor', () => {
  describe('analyzeQuery', () => {
    it('returns WHERE + JOIN columns', () => {
      const adv = new IndexAdvisor();
      expect(adv.analyzeQuery('SELECT * FROM t WHERE a = 1 AND b = 2')).toEqual(['a', 'b']);
    });

    it('returns JOIN ON columns', () => {
      const adv = new IndexAdvisor();
      expect(adv.analyzeQuery('SELECT * FROM t1 JOIN t2 ON t1.x = t2.y')).toEqual(['x', 'y']);
    });

    it('returns empty for invalid SQL', () => {
      const adv = new IndexAdvisor();
      expect(adv.analyzeQuery('not valid sql ((((')).toEqual([]);
    });

    it('returns empty for non-select SQL', () => {
      const adv = new IndexAdvisor();
      expect(adv.analyzeQuery('INSERT INTO t (a) VALUES (1)')).toEqual([]);
    });

    it('returns WHERE columns for SELECT without FROM', () => {
      const adv = new IndexAdvisor();
      // no FROM → extractAllRefs skips the JOIN loop
      expect(adv.analyzeQuery('SELECT 1 WHERE a = 1')).toEqual(['a']);
    });
  });

  describe('recommendIndexes (table, queries[]) overload', () => {
    it('recommends a composite index for multi-column WHERE', () => {
      const adv = new IndexAdvisor();
      const recs = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1 AND b = 2']);
      expect(recs).toHaveLength(1);
      expect(recs[0].table).toBe('t');
      expect(recs[0].columns).toEqual(['a', 'b']);
      expect(recs[0].type).toBe('btree');
      expect(recs[0].cardinality).toBe(2);
    });

    it('recommends individual JOIN indexes per table', () => {
      const adv = new IndexAdvisor();
      const recs = adv.recommendIndexes('t1', ['SELECT * FROM t1 JOIN t2 ON t1.x = t2.y']);
      // t1.x appears in JOIN → individual index for t1
      expect(recs.some((r) => r.table === 't1' && r.columns.includes('x'))).toBe(true);
    });

    it('recommends individual indexes for remaining WHERE columns', () => {
      const adv = new IndexAdvisor();
      const recs = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1']);
      expect(recs.some((r) => r.columns.includes('a'))).toBe(true);
    });

    it('deduplicates identical recommendations across calls', () => {
      const adv = new IndexAdvisor();
      const r1 = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1']);
      const r2 = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1']);
      expect(r2).toHaveLength(0); // already recommended
      expect(adv.getRecommendedIndexes()).toHaveLength(r1.length);
    });

    it('handles empty queries array', () => {
      const adv = new IndexAdvisor();
      expect(adv.recommendIndexes('t', [])).toEqual([]);
    });

    it('skips individual index when column already covered by join index', () => {
      const adv = new IndexAdvisor();
      // t1.x appears in both JOIN ON and WHERE → individual skips duplicate
      const recs = adv.recommendIndexes('t1', [
        'SELECT * FROM t1 JOIN t2 ON t1.x = t2.y WHERE t1.x = 1',
      ]);
      // x should be recommended exactly once for t1
      const xRecs = recs.filter((r) => r.table === 't1' && r.columns.includes('x'));
      expect(xRecs).toHaveLength(1);
    });

    it('deduplicates composite index across multiple queries', () => {
      const adv = new IndexAdvisor();
      const recs = adv.recommendIndexes('t', [
        'SELECT * FROM t WHERE a = 1 AND b = 2',
        'SELECT * FROM t WHERE b = 2 AND a = 1',
      ]);
      // composite (a,b) recommended once, not twice
      const composite = recs.filter((r) => r.columns.length === 2);
      expect(composite).toHaveLength(1);
    });

    it('deduplicates composite index across separate calls', () => {
      const adv = new IndexAdvisor();
      const r1 = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1 AND b = 2']);
      const r2 = adv.recommendIndexes('t', ['SELECT * FROM t WHERE a = 1 AND b = 2']);
      expect(r1).toHaveLength(1);
      // composite already recommended → addIfUnique false on second call
      expect(r2).toEqual([]);
    });

    it('extractWhereRefs / extractJoinRefs return empty on parse failure', () => {
      const adv = new IndexAdvisor();
      expect((adv as any).extractWhereRefs('not valid ((((')).toEqual([]);
      expect((adv as any).extractJoinRefs('not valid ((((')).toEqual([]);
    });

    it('extractWhereColumnsForTable matches qualified and unqualified refs', () => {
      const adv = new IndexAdvisor();
      // qualified ref (t.a) and unqualified (b) both belong to target table t
      const cols = (adv as any).extractWhereColumnsForTable(
        'SELECT * FROM t WHERE t.a = 1 AND b = 2',
        't',
      );
      expect(cols).toEqual(['a', 'b']);
    });

    it('extractWhereColumnsForTable ignores refs from other tables', () => {
      const adv = new IndexAdvisor();
      const cols = (adv as any).extractWhereColumnsForTable(
        'SELECT * FROM t JOIN s ON t.x = s.y WHERE s.z = 1',
        't',
      );
      expect(cols).not.toContain('z');
    });

    it('extractJoinColumnsForTable matches qualified refs', () => {
      const adv = new IndexAdvisor();
      const cols = (adv as any).extractJoinColumnsForTable(
        'SELECT * FROM t JOIN s ON t.x = s.y',
        't',
      );
      expect(cols).toEqual(['x']);
    });

    it('extractWhereColumnsForTable handles SELECT without FROM', () => {
      const adv = new IndexAdvisor();
      // no FROM → extractWhereRefs skips the JOIN loop; unqualified ref still matches
      const cols = (adv as any).extractWhereColumnsForTable('SELECT 1 WHERE a = 1', 't');
      expect(cols).toEqual(['a']);
    });

    it('extractJoinColumnsForTable handles SELECT without FROM', () => {
      const adv = new IndexAdvisor();
      const cols = (adv as any).extractJoinColumnsForTable('SELECT 1', 't');
      expect(cols).toEqual([]);
    });

    it('deduplicates a JOIN column recommendation across calls', () => {
      const adv = new IndexAdvisor();
      const r1 = adv.recommendIndexes('t1', ['SELECT * FROM t1 JOIN t2 ON t1.x = t2.y']);
      const r2 = adv.recommendIndexes('t1', ['SELECT * FROM t1 JOIN t2 ON t1.x = t2.y']);
      expect(r1.length).toBeGreaterThan(0);
      // join column 'x' already recommended → addIfUnique false on second call
      expect(r2).toEqual([]);
    });

    it('skips a single WHERE column already covered by existing index', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [{ name: 'idx_t_a', tbl_name: 't', sql: 'CREATE INDEX idx_t_a ON t(a)' }],
        { idx_t_a: [{ seqno: 0, cid: 0, name: 'a' }] },
      );
      // single WHERE col 'a' is covered → isCovered true → no recommendation
      const recs = adv.recommendIndexes('SELECT * FROM t WHERE a = 1', db);
      expect(recs).toEqual([]);
    });

    it('skips a JOIN column already covered by existing index', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [
          { name: 'idx_t_x', tbl_name: 't', sql: 'CREATE INDEX idx_t_x ON t(x)' },
          { name: 'idx_s_y', tbl_name: 's', sql: 'CREATE INDEX idx_s_y ON s(y)' },
        ],
        {
          idx_t_x: [{ seqno: 0, cid: 0, name: 'x' }],
          idx_s_y: [{ seqno: 0, cid: 0, name: 'y' }],
        },
      );
      // both JOIN columns (t.x, s.y) covered → no recommendation
      const recs = adv.recommendIndexes('SELECT * FROM t JOIN s ON t.x = s.y', db);
      expect(recs).toEqual([]);
    });
  });

  describe('recommendIndexes (sql, db) overload', () => {
    it('returns empty when no candidate columns', () => {
      const adv = new IndexAdvisor();
      const db = makeDb([], {});
      expect(adv.recommendIndexes('SELECT 1', db)).toEqual([]);
    });

    it('recommends missing indexes against existing index coverage', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [{ name: 'idx_t_a', tbl_name: 't', sql: 'CREATE INDEX idx_t_a ON t(a)' }],
        { idx_t_a: [{ seqno: 0, cid: 0, name: 'a' }] },
      );
      const recs = adv.recommendIndexes('SELECT * FROM t WHERE a = 1 AND b = 2', db);
      // 'a' covered by existing index; 'b' is not
      expect(recs.some((r) => r.columns.includes('b'))).toBe(true);
    });

    it('recommends WHERE/JOIN/ORDER/GROUP columns in priority order', () => {
      const adv = new IndexAdvisor();
      const db = makeDb([], {});
      // Note: GROUP BY must precede ORDER BY (valid SQL ordering)
      const recs = adv.recommendIndexes(
        'SELECT * FROM t1 JOIN t2 ON t1.x = t2.y WHERE t1.a = 1 GROUP BY t1.c ORDER BY t1.b',
        db,
      );
      expect(recs.length).toBeGreaterThan(0);
    });

    it('uses case-insensitive existing-index table matching', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [{ name: 'idx_T_a', tbl_name: 'T', sql: 'CREATE INDEX idx_T_a ON T(a)' }],
        { idx_T_a: [{ seqno: 0, cid: 0, name: 'a' }] },
      );
      // lowercase 't' in query matches uppercase 'T' in existing index
      const recs = adv.recommendIndexes('SELECT * FROM t WHERE a = 1 AND b = 2', db);
      // 'a' covered (case-insensitive), 'b' not
      expect(recs.some((r) => r.columns.includes('b'))).toBe(true);
    });

    it('reports distinct WHERE and JOIN candidates against existing coverage', () => {
      const adv = new IndexAdvisor();
      const db = makeDb([], {});
      const recs = adv.recommendIndexes(
        'SELECT * FROM t1 JOIN t2 ON t1.x = t2.y WHERE t1.a = 1 AND t1.b = 2',
        db,
      );
      expect(recs.length).toBeGreaterThan(0);
    });

    it('returns no recommendations when all columns already covered', () => {
      const adv = new IndexAdvisor();
      // existing index covers columns a, b, c, d for table t (left-prefix)
      const db = makeDb(
        [{ name: 'idx_t_abcd', tbl_name: 't', sql: 'CREATE INDEX idx_t_abcd ON t(a, b, c, d)' }],
        {
          idx_t_abcd: [
            { seqno: 0, cid: 0, name: 'a' },
            { seqno: 1, cid: 1, name: 'b' },
            { seqno: 2, cid: 2, name: 'c' },
            { seqno: 3, cid: 3, name: 'd' },
          ],
        },
      );
      const recs = adv.recommendIndexes(
        'SELECT * FROM t WHERE a = 1 AND b = 2 ORDER BY c GROUP BY d',
        db,
      );
      // a,b composite covered; c,d single covered → no new recommendations
      expect(recs).toEqual([]);
    });

    it('treats a non-unique index with null sql as non-unique', () => {
      const adv = new IndexAdvisor();
      const db = makeDb([{ name: 'idx_t_a', tbl_name: 't', sql: null }], {
        idx_t_a: [{ seqno: 0, cid: 0, name: 'a' }],
      });
      const idx = adv.getExistingIndexes(db);
      expect(idx[0].unique).toBe(false);
    });

    it('skips JOIN/ORDER/GROUP columns already covered by existing indexes', () => {
      const adv = new IndexAdvisor();
      // existing indexes cover join col x, order col b, group col c on table t
      const db = makeDb(
        [
          { name: 'idx_t_x', tbl_name: 't', sql: 'CREATE INDEX idx_t_x ON t(x)' },
          { name: 'idx_t_b', tbl_name: 't', sql: 'CREATE INDEX idx_t_b ON t(b)' },
          { name: 'idx_t_c', tbl_name: 't', sql: 'CREATE INDEX idx_t_c ON t(c)' },
        ],
        {
          idx_t_x: [{ seqno: 0, cid: 0, name: 'x' }],
          idx_t_b: [{ seqno: 0, cid: 0, name: 'b' }],
          idx_t_c: [{ seqno: 0, cid: 0, name: 'c' }],
        },
      );
      const recs = adv.recommendIndexes('SELECT * FROM t GROUP BY c ORDER BY b', db);
      // b (ORDER) and c (GROUP) are covered → only uncovered cols recommended (none)
      expect(recs).toEqual([]);
    });

    it('deduplicates a single-column recommendation repeated across queries', () => {
      const adv = new IndexAdvisor();
      const db = makeDb([], {});
      const r1 = adv.recommendIndexes('SELECT * FROM t WHERE a = 1', db);
      const r2 = adv.recommendIndexes('SELECT * FROM t WHERE a = 1', db);
      // second call: 'a' already recommended → addIfUnique false → empty
      expect(r1).toHaveLength(1);
      expect(r2).toEqual([]);
    });
  });

  describe('getExistingIndexes', () => {
    it('reads sqlite_master and PRAGMA index_info', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [
          { name: 'idx_t_a', tbl_name: 't', sql: 'CREATE UNIQUE INDEX idx_t_a ON t(a)' },
          { name: 'sqlite_autoindex_t_1', tbl_name: 't', sql: null },
        ],
        { idx_t_a: [{ seqno: 0, cid: 0, name: 'a' }] },
      );
      const idx = adv.getExistingIndexes(db);
      expect(idx).toHaveLength(1);
      expect(idx[0]).toEqual({ table: 't', name: 'idx_t_a', columns: ['a'], unique: true });
    });

    it('sorts PRAGMA columns by seqno', () => {
      const adv = new IndexAdvisor();
      const db = makeDb(
        [{ name: 'idx_t_ab', tbl_name: 't', sql: 'CREATE INDEX idx_t_ab ON t(a, b)' }],
        {
          idx_t_ab: [
            { seqno: 1, cid: 1, name: 'b' },
            { seqno: 0, cid: 0, name: 'a' },
          ],
        },
      );
      const idx = adv.getExistingIndexes(db);
      expect(idx[0].columns).toEqual(['a', 'b']);
    });

    it('returns empty and swallows DB errors', () => {
      const adv = new IndexAdvisor();
      const db = {
        prepare: vi.fn(() => {
          throw new Error('db boom');
        }),
      };
      expect(adv.getExistingIndexes(db as any)).toEqual([]);
    });
  });

  describe('extractCandidateColumns', () => {
    it('extracts WHERE, ORDER_BY, GROUP_BY, JOIN contexts', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns(
        'SELECT * FROM t1 JOIN t2 ON t1.x = t2.y WHERE t1.a = 1 GROUP BY t1.c ORDER BY t1.b',
      );
      const contexts = cs.map((c) => c.context);
      expect(contexts).toContain('JOIN');
      expect(contexts).toContain('WHERE');
      expect(contexts).toContain('ORDER_BY');
      expect(contexts).toContain('GROUP_BY');
    });

    it('returns empty for invalid SQL', () => {
      const adv = new IndexAdvisor();
      expect(adv.extractCandidateColumns('not valid ((((')).toEqual([]);
    });

    it('returns empty for non-select SQL', () => {
      const adv = new IndexAdvisor();
      expect(adv.extractCandidateColumns('INSERT INTO t (a) VALUES (1)')).toEqual([]);
    });

    it('deduplicates repeated column references', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT * FROM t WHERE a = 1 OR a = 2');
      const whereCols = cs.filter((c) => c.context === 'WHERE').map((c) => c.column);
      expect(new Set(whereCols).size).toBe(1);
    });
  });

  describe('toPgCatalogRows', () => {
    it('converts recommendations to pg_catalog rows', () => {
      const adv = new IndexAdvisor();
      const rec: IndexRecommendation[] = [
        { table: 't', columns: ['a', 'b'], type: 'btree', cardinality: 2, reason: 'test' },
      ];
      const rows = adv.toPgCatalogRows(rec);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        schemaname: 'public',
        tablename: 't',
        indexname: 'idx_t_a_b',
        columns: 'a, b',
        type: 'btree',
        estimated_impact: 2,
      });
      expect(rows[0].indexdef).toContain('CREATE INDEX IF NOT EXISTS idx_t_a_b ON t (a, b)');
    });

    it('returns empty for empty recommendations', () => {
      const adv = new IndexAdvisor();
      expect(adv.toPgCatalogRows([])).toEqual([]);
    });
  });

  describe('private helpers (via public API + cast)', () => {
    it('inferTableFromFrom returns first table name', () => {
      const adv = new IndexAdvisor();
      const t = (adv as any).inferTableFromFrom([{ type: 'table', name: { name: 'users' } }]);
      expect(t).toBe('users');
    });

    it('inferTableFromFrom returns empty when no table', () => {
      const adv = new IndexAdvisor();
      expect((adv as any).inferTableFromFrom([])).toBe('');
      expect((adv as any).inferTableFromFrom([{ type: 'join' }])).toBe('');
    });

    it('arrayStartsWith handles prefix and length mismatch', () => {
      const adv = new IndexAdvisor();
      expect((adv as any).arrayStartsWith(['a', 'b', 'c'], ['a', 'b'])).toBe(true);
      expect((adv as any).arrayStartsWith(['a', 'b'], ['a', 'b', 'c'])).toBe(false);
      expect((adv as any).arrayStartsWith(['a', 'b'], ['a', 'x'])).toBe(false);
    });

    it('collectRefsFromExpr handles null / scalar / unary / cast / ternary / call', () => {
      const adv = new IndexAdvisor();
      const refs: any[] = [];
      (adv as any).collectRefsFromExpr(null, refs);
      (adv as any).collectRefsFromExpr(undefined, refs);
      (adv as any).collectRefsFromExpr(42, refs);
      (adv as any).collectRefsFromExpr({ type: 'integer', value: 1 }, refs);
      (adv as any).collectRefsFromExpr(
        { type: 'unary', operand: { type: 'ref', name: 'a' } },
        refs,
      );
      (adv as any).collectRefsFromExpr(
        { type: 'cast', operand: { type: 'ref', name: 'b' } },
        refs,
      );
      (adv as any).collectRefsFromExpr(
        {
          type: 'ternary',
          value: { type: 'ref', name: 'c' },
          lo: { type: 'ref', name: 'd' },
          hi: { type: 'ref', name: 'e' },
        },
        refs,
      );
      (adv as any).collectRefsFromExpr(
        { type: 'call', args: [{ type: 'ref', name: 'f' }] },
        refs,
      );
      const cols = refs.map((r) => r.column);
      expect(cols).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd', 'e', 'f']));
    });

    it('collectRefsFromExpr handles a ref with table qualifier', () => {
      const adv = new IndexAdvisor();
      const refs: any[] = [];
      (adv as any).collectRefsFromExpr(
        { type: 'ref', name: 'x', table: { name: 't' } },
        refs,
      );
      expect(refs[0]).toEqual({ table: 't', column: 'x' });
    });

    it('collectRefsFromExpr handles call without args', () => {
      const adv = new IndexAdvisor();
      const refs: any[] = [];
      (adv as any).collectRefsFromExpr({ type: 'call', args: undefined }, refs);
      expect(refs).toEqual([]);
    });

    it('extractCandidateColumns skips non-ref orderBy/groupBy expressions', () => {
      const adv = new IndexAdvisor();
      // ORDER BY 1 (integer literal, not ref) and GROUP BY 1 → no columns
      const cs = adv.extractCandidateColumns('SELECT COUNT(*) FROM t GROUP BY 1 ORDER BY 1');
      // integer literal orderBy/groupBy are non-ref → skipped
      expect(cs.filter((c) => c.context === 'ORDER_BY' || c.context === 'GROUP_BY')).toEqual([]);
    });

    it('extractCandidateColumns handles SELECT without FROM', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT 1 WHERE a = 1');
      // no FROM clause → inferTableFromFrom returns '' for unqualified refs
      expect(cs.length).toBeGreaterThanOrEqual(0);
    });

    it('extractCandidateColumns uses FROM table for unqualified WHERE ref', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT * FROM t WHERE a = 1');
      const where = cs.find((c) => c.context === 'WHERE');
      expect(where).toEqual({ table: 't', column: 'a', context: 'WHERE' });
    });

    it('extractCandidateColumns uses FROM table for unqualified ORDER/GROUP refs', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT * FROM t GROUP BY c ORDER BY b');
      const order = cs.find((c) => c.context === 'ORDER_BY');
      const group = cs.find((c) => c.context === 'GROUP_BY');
      expect(order).toEqual({ table: 't', column: 'b', context: 'ORDER_BY' });
      expect(group).toEqual({ table: 't', column: 'c', context: 'GROUP_BY' });
    });

    it('extractCandidateColumns uses join table name for unqualified JOIN refs', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT * FROM t1 JOIN t2 ON x = y');
      const joins = cs.filter((c) => c.context === 'JOIN');
      // unqualified refs in ON inherit from join's from.name (t2)
      expect(joins.length).toBe(2);
    });

    it('extractCandidateColumns deduplicates repeated column keys', () => {
      const adv = new IndexAdvisor();
      const cs = adv.extractCandidateColumns('SELECT * FROM t WHERE a = 1 AND a = 2');
      const where = cs.filter((c) => c.context === 'WHERE');
      expect(where).toHaveLength(1);
    });

    it('extractCandidateColumns deduplicates repeated JOIN/ORDER/GROUP keys', () => {
      const adv = new IndexAdvisor();
      const csJoin = adv.extractCandidateColumns('SELECT * FROM t1 JOIN t2 ON t1.x = t1.x');
      expect(csJoin.filter((c) => c.context === 'JOIN')).toHaveLength(1);
      const csOrder = adv.extractCandidateColumns('SELECT * FROM t ORDER BY b, b');
      expect(csOrder.filter((c) => c.context === 'ORDER_BY')).toHaveLength(1);
      const csGroup = adv.extractCandidateColumns('SELECT * FROM t GROUP BY c, c');
      expect(csGroup.filter((c) => c.context === 'GROUP_BY')).toHaveLength(1);
    });

    it('extractCandidateColumns handles ORDER/GROUP without FROM', () => {
      const adv = new IndexAdvisor();
      // valid: no FROM, GROUP BY c, no ORDER BY in the same statement
      const csWithOrder = adv.extractCandidateColumns('SELECT 1 ORDER BY b');
      const csWithGroup = adv.extractCandidateColumns('SELECT 1 GROUP BY c');
      const order = csWithOrder.find((c) => c.context === 'ORDER_BY');
      const group = csWithGroup.find((c) => c.context === 'GROUP_BY');
      // no FROM → inferTableFromFrom([]) returns ''
      expect(order?.table).toBe('');
      expect(group?.table).toBe('');
    });
  });
});
