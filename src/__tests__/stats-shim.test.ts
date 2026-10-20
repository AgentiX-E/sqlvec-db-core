/**
 * stats-shim.test.ts — Coverage tests for StatsShim
 * (PostgreSQL planner-statistics SQL → SQLite-safe rewriting).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PgCatalog } from '../system/PgCatalog';
import { detectStats, rewriteStats, refreshStatsCache } from '../query/StatsShim';

// ── Fake better-sqlite3 database ──────────────────────────────────
// Routes `prepare(sql).all()/.get()` by inspecting the SQL content, matching
// the shape of the real `PgCatalog.shardDb` (better-sqlite3-like interface).
type Row = Record<string, unknown>;

function makeDb(overrides: {
  tables?: string[];
  rowCounts?: Record<string, number>;
  statisticsExists?: boolean;
  statRows?: Record<string, Row[]>;
  columns?: Record<string, Row[]>;
  distinctCounts?: Record<string, Row>;
  mcvRows?: Record<string, Row[]>;
} = {}) {
  const {
    tables = [],
    rowCounts = {},
    statisticsExists = false,
    statRows = {},
    columns = {},
    distinctCounts = {},
    mcvRows = {},
  } = overrides;

  const prepare = (sql: string) => ({
    all: (...args: unknown[]): Row[] => {
      const s = sql;
      if (s.includes('FROM sqlite_master') && s.includes("name NOT LIKE 'sqlite_%'")) {
        return tables.map(name => ({ name }));
      }
      if (s.includes("name='__sqlvec_statistics'") || s.includes("name = '__sqlvec_statistics'")) {
        return statisticsExists ? [{ name: '__sqlvec_statistics' }] : [];
      }
      if (s.includes('FROM __sqlvec_statistics')) {
        return statRows[String(args[0])] ?? [];
      }
      if (s.includes('PRAGMA table_info')) {
        const m = s.match(/table_info\("([^"]+)"\)/);
        return columns[m ? m[1] : ''] ?? [];
      }
      if (s.includes('GROUP BY v ORDER BY c DESC')) {
        const m = s.match(/"([^"]+)" as v.*FROM "([^"]+)"/s);
        const key = m ? `${m[2]}.${m[1]}` : '';
        return mcvRows[key] ?? [];
      }
      return [];
    },
    get: (...args: unknown[]): Row | undefined => {
      const s = sql;
      if (s.includes('SELECT COUNT(*) as cnt')) {
        const m = s.match(/FROM "([^"]+)"/);
        const t = m ? m[1] : '';
        const cnt = rowCounts[t] ?? 0;
        return { cnt };
      }
      if (s.includes('COUNT(DISTINCT')) {
        const m = s.match(/COUNT\(DISTINCT "([^"]+)"\).*FROM "([^"]+)"/s);
        const key = m ? `${m[2]}.${m[1]}` : '';
        return distinctCounts[key] ?? { d: 0, t: 1, n: 0 };
      }
      if (s.includes("name='__sqlvec_statistics'") || s.includes("name = '__sqlvec_statistics'")) {
        return statisticsExists ? { name: '__sqlvec_statistics' } : undefined;
      }
      return undefined;
    },
  });

  return { prepare };
}

function setShardDb(db: unknown) {
  Object.defineProperty(PgCatalog, 'shardDb', {
    value: db,
    writable: true,
    configurable: true,
  });
}

// Reset the module-level stats cache + shardDb between tests.
beforeEach(() => {
  setShardDb(null);
  refreshStatsCache();
});

describe('detectStats', () => {
  it('returns false for empty / non-string / undefined', () => {
    expect(detectStats('')).toBe(false);
    expect(detectStats('   ')).toBe(false);
    expect(detectStats(undefined as unknown as string)).toBe(false);
    expect(detectStats(null as unknown as string)).toBe(false);
  });

  it('returns false for non-SET/SHOW/ANALYZE/SELECT prefix', () => {
    expect(detectStats('DELETE FROM t')).toBe(false);
    expect(detectStats('CREATE TABLE t (id INT)')).toBe(false);
    expect(detectStats('INSERT INTO t VALUES (1)')).toBe(false);
    expect(detectStats('UPDATE t SET a = 1')).toBe(false);
  });

  it('detects SET default_statistics_target', () => {
    expect(detectStats('SET default_statistics_target = 100')).toBe(true);
    expect(detectStats('SET SESSION default_statistics_target TO 500')).toBe(true);
  });

  it('detects SET from_collapse_limit / join_collapse_limit', () => {
    expect(detectStats('SET from_collapse_limit = 8')).toBe(true);
    expect(detectStats('SET join_collapse_limit = 16')).toBe(true);
  });

  it('detects SET enable_* planner flags', () => {
    expect(detectStats('SET enable_seqscan = off')).toBe(true);
    expect(detectStats('SET enable_nestloop = on')).toBe(true);
    expect(detectStats('SET enable_bitmapscan = false')).toBe(true);
  });

  it('detects ANALYZE statements', () => {
    expect(detectStats('ANALYZE')).toBe(true);
    expect(detectStats('ANALYZE VERBOSE my_table')).toBe(true);
    expect(detectStats('ANALYZE myschema.mytable')).toBe(true);
  });

  it('detects SELECT FROM pg_stats / pg_statistic', () => {
    expect(detectStats('SELECT * FROM pg_stats')).toBe(true);
    expect(detectStats('SELECT * FROM pg_statistic')).toBe(true);
    expect(detectStats('SELECT * FROM pg_catalog.pg_stats')).toBe(true);
  });

  it('detects SHOW default_statistics_target', () => {
    expect(detectStats('SHOW default_statistics_target')).toBe(true);
  });

  it('returns false for plain SELECT', () => {
    expect(detectStats('SELECT 1')).toBe(false);
    expect(detectStats('SELECT * FROM users')).toBe(false);
  });
});

describe('rewriteStats — SET patterns', () => {
  it('rewrites SET default_statistics_target → SELECT 1', () => {
    expect(rewriteStats('SET default_statistics_target = 100')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteStats('SET LOCAL default_statistics_target TO 1000')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET from_collapse_limit → SELECT 1', () => {
    expect(rewriteStats('SET from_collapse_limit = 8')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET join_collapse_limit → SELECT 1', () => {
    expect(rewriteStats('SET join_collapse_limit = 16')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET enable_* → SELECT 1 (all 7 methods)', () => {
    for (const m of ['material', 'nestloop', 'hashjoin', 'mergejoin', 'seqscan', 'indexscan', 'bitmapscan']) {
      expect(rewriteStats(`SET enable_${m} = on`)).toEqual({ sql: 'SELECT 1', rewritten: true });
    }
    expect(rewriteStats('SET enable_seqscan = false')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteStats('SET enable_seqscan = 0')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('passes through non-matching SET (e.g. arbitrary GUC)', () => {
    expect(rewriteStats('SET work_mem = 4MB')).toEqual({ sql: 'SET work_mem = 4MB', rewritten: false });
  });
});

describe('rewriteStats — ANALYZE patterns', () => {
  it('rewrites all ANALYZE variants → SELECT 1 and refreshes cache', () => {
    setShardDb(null);
    for (const sql of [
      'ANALYZE',
      'ANALYZE;',
      'ANALYZE VERBOSE',
      'ANALYZE VERBOSE my_table',
      'ANALYZE my_table',
      'ANALYZE myschema.my_table',
      'ANALYZE (VERBOSE)',
      'ANALYZE (VERBOSE, SKIP_DATABASE_STATS) my_table',
    ]) {
      expect(rewriteStats(sql)).toEqual({ sql: 'SELECT 1', rewritten: true });
    }
  });
});

describe('rewriteStats — SHOW pattern', () => {
  it('rewrites SHOW default_statistics_target → constant', () => {
    expect(rewriteStats('SHOW default_statistics_target')).toEqual({
      sql: "SELECT '100' as default_statistics_target",
      rewritten: true,
    });
  });
});

describe('rewriteStats — pg_stats / pg_statistic (real stats)', () => {
  it('returns empty-result stats SQL when no DB (SystemCatalog fallback)', () => {
    setShardDb(null);
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('schemaname');
  });

  it('builds UNION rows from real shardDb columns', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 3 },
        columns: {
          users: [
            { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
          ],
        },
        distinctCounts: {
          'users.id': { d: 3, t: 3, n: 0 },
          'users.name': { d: 2, t: 3, n: 1 },
        },
        mcvRows: {
          'users.id': [{ v: 1, c: 1 }, { v: 2, c: 1 }, { v: 3, c: 1 }],
          'users.name': [{ v: 'alice', c: 2 }, { v: 'bob', c: 1 }],
        },
      }),
    );
    refreshStatsCache(); // force rebuild against the new shardDb
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('UNION ALL');
    expect(r.sql).toContain('users');
  });

  it('uses __sqlvec_statistics when present (ANALYZE-collected stats)', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 100 },
        statisticsExists: true,
        statRows: {
          users: [
            { column_name: 'id', null_fraction: 0.0, distinct_count: 100, mcv_values: '[]' },
            { column_name: 'name', null_fraction: 0.1, distinct_count: 90, mcv_values: '["alice","bob"]' },
          ],
        },
        columns: {
          users: [
            { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
          ],
        },
      }),
    );
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('alice,bob');
  });

  it('filters by WHERE tablename = ... and falls back to placeholder when no match', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 2 },
        columns: { users: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }] },
      }),
    );
    refreshStatsCache();
    const r1 = rewriteStats("SELECT * FROM pg_stats WHERE tablename = 'users'");
    expect(r1.rewritten).toBe(true);
    expect(r1.sql).toContain('users');
    const r2 = rewriteStats("SELECT * FROM pg_stats WHERE tablename = 'nonexistent'");
    expect(r2.rewritten).toBe(true);
    expect(r2.sql).toContain("WHERE tablename = 'nonexistent'");
  });

  it('handles pg_statistic and pg_catalog qualification', () => {
    setShardDb(
      makeDb({
        tables: ['t'],
        rowCounts: { t: 1 },
        columns: { t: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }] },
      }),
    );
    refreshStatsCache();
    expect(rewriteStats('SELECT * FROM pg_statistic').rewritten).toBe(true);
    expect(rewriteStats('SELECT * FROM pg_catalog.pg_stats').rewritten).toBe(true);
    expect(rewriteStats('SELECT * FROM "pg_catalog".pg_statistic').rewritten).toBe(true);
  });

  it('handles zero row count, unknown column type, and empty stat rows', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 0 },
        statisticsExists: true,
        statRows: {}, // category exists but no rows → statRows.length > 0 is false
        columns: {
          users: [
            { cid: 0, name: 'id', type: undefined, notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'tags', type: 'UUID', notnull: 0, dflt_value: null, pk: 0 },
          ],
        },
      }),
    );
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('users');
  });

  it('handles __sqlvec_statistics present but empty rows (statRows.length === 0)', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 5 },
        statisticsExists: true,
        statRows: { users: [] }, // table exists but no stat rows
        columns: { users: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }] },
      }),
    );
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('users');
  });

  it('handles large table (>10 rows) without explicit statistics', () => {
    setShardDb(
      makeDb({
        tables: ['big'],
        rowCounts: { big: 1000 },
        columns: { big: [{ cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 }] },
      }),
    );
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('big');
  });

  it('computes correlation and handles empty/non-array MCV from __sqlvec_statistics', () => {
    setShardDb(
      makeDb({
        tables: ['users'],
        rowCounts: { users: 50 },
        statisticsExists: true,
        statRows: {
          users: [
            // correlation computed: n_distinct > 0 && rowCount > 0
            { column_name: 'id', null_fraction: 0.0, distinct_count: 50, mcv_values: '[]' },
            // mcv_vals = '[]' → falsy branch; n_distinct = 0 → correlation stays 0
            { column_name: 'name', null_fraction: 0.2, distinct_count: 0, mcv_values: '[]' },
            // mcv_vals = non-array JSON → Array.isArray false branch
            { column_name: 'email', null_fraction: 0.5, distinct_count: 10, mcv_values: '"not-an-array"' },
          ],
        },
        columns: {
          users: [
            { cid: 0, name: 'id', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 1 },
            { cid: 1, name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
            { cid: 2, name: 'email', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
          ],
        },
      }),
    );
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('users');
  });
});

describe('rewriteStats — non-string / empty guard', () => {
  it('returns unchanged for empty and non-string input', () => {
    expect(rewriteStats('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteStats('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteStats(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteStats(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through plain SELECT', () => {
    expect(rewriteStats('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewriteStats('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });
});

describe('refreshStatsCache', () => {
  it('resets cache and rebuilds (exported)', () => {
    setShardDb(null);
    refreshStatsCache();
    const r = rewriteStats('SELECT * FROM pg_stats');
    expect(r.rewritten).toBe(true);
  });
});
