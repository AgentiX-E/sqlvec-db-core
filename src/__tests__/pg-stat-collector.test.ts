import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { PgStatCollector } from '../query/PgStatCollector';

function setupDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT,
      age INTEGER,
      score REAL
    );
    CREATE INDEX idx_users_age ON users(age);
    CREATE TABLE empty_table (id INTEGER PRIMARY KEY, note TEXT);
  `);
  // Populate with a mix of values, nulls, and duplicates.
  const insert = db.prepare(
    'INSERT INTO users (id, name, age, score) VALUES (?, ?, ?, ?)',
  );
  const rows: Array<[number, string | null, number | null, number | null]> = [
    [1, 'alice', 30, 9.5],
    [2, 'bob', 25, 7.0],
    [3, 'charlie', 30, 8.0],
    [4, null, null, null],
    [5, 'dave', 40, 6.5],
    [6, null, 25, 9.0],
    [7, 'eve', 35, 8.5],
  ];
  for (const r of rows) insert.run(...r);
  return db;
}

describe('PgStatCollector', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = setupDb();
  });

  afterEach(() => {
    db.close();
  });

  describe('construction & persistence', () => {
    it('creates the stats table and loads persisted stats on construct', () => {
      const c1 = new PgStatCollector(db);
      // Run analyze, then reconstruct to verify persistence round-trip.
      return c1.analyze({ tables: ['users'] }).then(() => {
        const c2 = new PgStatCollector(db);
        expect(c2.getTableStats('users')).not.toBeNull();
      });
    });
  });

  // Helpers exposed via a subclass to reach private methods for targeted tests.
  function makeCollector(opts?: any) {
    return new PgStatCollector(db, opts) as any;
  }

  describe('listTables', () => {
    it('excludes sqlite internal and _sqlvec_ prefixed tables', () => {
      const c = makeCollector();
      const tables = c.listTables();
      expect(tables).toContain('users');
      expect(tables).toContain('empty_table');
      expect(tables).not.toContain('sqlite_master');
      expect(tables.some((t: string) => t.startsWith('_sqlvec_'))).toBe(false);
    });
  });

  describe('analyze', () => {
    it('analyzes specified tables only', async () => {
      const c = makeCollector();
      const res = await c.analyze({ tables: ['users'] });
      expect(res.tablesAnalyzed).toBe(1);
      expect(res.errors).toEqual([]);
      expect(c.getTableStats('users')).not.toBeNull();
    });

    it('analyzes all tables when none specified', async () => {
      const c = makeCollector();
      const res = await c.analyze({});
      expect(res.tablesAnalyzed).toBe(2);
    });

    it('reports errors for missing tables without throwing', async () => {
      const c = makeCollector();
      const res = await c.analyze({ tables: ['nonexistent'] });
      expect(res.tablesAnalyzed).toBe(0);
      expect(res.errors.length).toBe(1);
      expect(res.errors[0]).toContain('nonexistent');
    });

    it('swallows per-column and per-index analyze errors', async () => {
      // Expression indexes yield a null column name from PRAGMA index_info,
      // which makes collectIndexStats throw (null.replace) — the error is
      // swallowed by analyzeTable's per-index catch, not surfaced as an error.
      const db2 = new Database(':memory:');
      db2.exec('CREATE TABLE t (a TEXT, b INTEGER)');
      db2.exec('CREATE INDEX expr_idx ON t (lower(a))');
      const c = new PgStatCollector(db2) as any;
      const res = await c.analyze({ tables: ['t'] });
      expect(res.errors).toEqual([]);
      expect(c.getIndexStats('expr_idx')).toBeNull(); // index stats failed silently
      db2.close();
    });

    it('merges options over defaults', async () => {
      const c = makeCollector({ maxMcv: 2, sampleSize: 100 });
      await c.analyze({ tables: ['users'] });
      const col = c.getColumnStats('users', 'age');
      expect(col.mcv.length).toBeLessThanOrEqual(2);
    });
  });

  describe('collectTableStats', () => {
    it('computes row count and a sane page count', () => {
      const c = makeCollector();
      const stats = c.collectTableStats('users');
      expect(stats.rowCount).toBe(7);
      expect(stats.pageCount).toBeGreaterThanOrEqual(1);
      expect(c.getTableStats('users')?.rowCount).toBe(7);
    });
  });

  describe('collectColumnStats', () => {
    it('computes null fraction, distinct count, MCV, and histogram', () => {
      const c = makeCollector({ maxMcv: 5 });
      const stats = c.collectColumnStats('users', 'age', c.options);
      expect(stats.nDistinct).toBe(4); // 30, 25, 40, 35 (null not counted)
      expect(stats.nullFrac).toBeCloseTo(1 / 7);
      // MCV should contain the most frequent value (30 and 25 each appear twice).
      expect(stats.mcv.length).toBeGreaterThan(0);
      expect(stats.mcv[0].freq).toBeCloseTo(2 / 7);
      // The top MCV is one of the two modal values (tie order is not stable).
      expect([25, 30]).toContain(stats.mcv[0].value);
    });

    it('escapes identifiers and handles text columns', () => {
      const c = makeCollector();
      const stats = c.collectColumnStats('users', 'name', c.options);
      expect(stats.nullFrac).toBeCloseTo(2 / 7);
      expect(stats.avgWidth).toBeGreaterThan(0);
    });
  });

  describe('collectIndexStats', () => {
    it('collects index column names and distinct counts', () => {
      const c = makeCollector();
      c.collectIndexStats('users', 'idx_users_age');
      const idx = c.getIndexStats('idx_users_age');
      expect(idx).not.toBeNull();
      expect(idx!.columnNames).toContain('age');
      expect(idx!.rowCount).toBe(7);
    });
  });

  describe('estimateSelectivity', () => {
    it('returns default 0.5 for unknown columns', () => {
      const c = makeCollector();
      expect(c.estimateSelectivity('users', 'unknown', '=')).toBe(0.5);
    });

    it('handles = via MCV and distinct fallback', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      // 30 is the MCV with freq 2/7
      expect(c.estimateSelectivity('users', 'age', '=', 30)).toBeCloseTo(2 / 7);
      // A non-MCV value falls back to 1/nDistinct
      const nonMcv = c.estimateSelectivity('users', 'age', '=', 999);
      expect(nonMcv).toBeCloseTo(1 / 4);
    });

    it('handles comparison operators with rough estimate', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      expect(c.estimateSelectivity('users', 'age', '>', 10)).toBe(0.33);
      expect(c.estimateSelectivity('users', 'age', '<=', 10)).toBe(0.33);
      expect(c.estimateSelectivity('users', 'age', '<>', 10)).toBe(0.33);
    });

    it('handles LIKE with/without leading wildcard', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'name', c.options);
      expect(c.estimateSelectivity('users', 'name', 'LIKE', '%a')).toBe(0.1);
      expect(c.estimateSelectivity('users', 'name', 'LIKE', 'a%')).toBe(0.05);
    });

    it('handles IN with value count vs distinct', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      // value "1,2,3" -> 3 values over 4 distinct
      expect(c.estimateSelectivity('users', 'age', 'IN', '1,2,3')).toBeCloseTo(3 / 4);
    });

    it('handles IS NULL / IS NOT NULL', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      const nullSel = c.estimateSelectivity('users', 'age', 'IS', null);
      expect(nullSel).toBeCloseTo(1 / 7);
      const notNullSel = c.estimateSelectivity('users', 'age', 'IS', 1);
      expect(notNullSel).toBeCloseTo(1 - 1 / 7);
    });

    it('returns 0.5 for unknown operators', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      expect(c.estimateSelectivity('users', 'age', 'BETWEEN', 1)).toBe(0.5);
    });
  });

  describe('cost estimation', () => {
    it('returns defaults for unknown tables', () => {
      const c = makeCollector();
      expect(c.estimateSeqScanCost('ghost')).toEqual({
        startupCost: 0,
        totalCost: 1000,
        rows: 1000,
      });
      expect(c.estimateIndexScanCost('ghost', 'i', 0.5)).toEqual({
        startupCost: 0.1,
        totalCost: 10,
        rows: 10,
      });
    });

    it('computes seq scan and index scan costs from row count', () => {
      const c = makeCollector();
      c.collectTableStats('users');
      const seq = c.estimateSeqScanCost('users');
      expect(seq.rows).toBe(7);
      expect(seq.totalCost).toBeCloseTo(0.07);
      const idx = c.estimateIndexScanCost('users', 'i', 0.5);
      expect(idx.rows).toBe(4); // round(7 * 0.5) = 4
      expect(idx.totalCost).toBeCloseTo(0.1 + 4 * 0.005);
    });
  });

  describe('analyzeColumnPair', () => {
    it('returns 0 for fewer than 2 numeric pairs', () => {
      const c = makeCollector();
      expect(c.analyzeColumnPair('empty_table', 'id', 'note')).toBe(0);
    });

    it('computes correlation between numeric columns', () => {
      const c = makeCollector();
      // age and score are negatively-ish correlated in our fixture.
      const corr = c.analyzeColumnPair('users', 'age', 'score');
      expect(corr).toBeGreaterThanOrEqual(-1);
      expect(corr).toBeLessThanOrEqual(1);
    });

    it('ignores non-numeric pairs', () => {
      const c = makeCollector();
      // name is text, so no numeric pairs -> 0
      expect(c.analyzeColumnPair('users', 'name', 'age')).toBe(0);
    });
  });

  describe('getColumnSummary', () => {
    it('returns zeros for an empty column', () => {
      const c = makeCollector();
      const s = c.getColumnSummary('empty_table', 'note');
      expect(s).toEqual({
        min: 0, max: 0, mean: 0, median: 0, mode: [], stdDev: 0, skewness: 0, kurtosis: 0,
      });
    });

    it('computes full summary for a numeric column', () => {
      const c = makeCollector();
      const s = c.getColumnSummary('users', 'age');
      expect(s.min).toBe(25);
      expect(s.max).toBe(40);
      expect(s.mean).toBeCloseTo((30 + 25 + 30 + 40 + 25 + 35) / 6);
      // Both 25 and 30 occur twice — mode may be either depending on tie-break.
      expect(s.mode.length).toBe(1);
      expect([25, 30]).toContain(s.mode[0]);
      expect(s.stdDev).toBeGreaterThan(0);
    });
  });

  describe('retrieval APIs', () => {
    it('getColumnStats/getIndexStats return null for missing entries', () => {
      const c = makeCollector();
      expect(c.getColumnStats('users', 'nope')).toBeNull();
      expect(c.getIndexStats('nope')).toBeNull();
    });

    it('getAllColumnStats returns array (possibly empty)', () => {
      const c = makeCollector();
      expect(c.getAllColumnStats('ghost')).toEqual([]);
      c.collectColumnStats('users', 'age', c.options);
      expect(c.getAllColumnStats('users').length).toBeGreaterThan(0);
    });
  });

  describe('edge cases', () => {
    it('getColumnSummary handles a single numeric value (no stdDev/skew/kurtosis)', () => {
      const db2 = new Database(':memory:');
      db2.exec('CREATE TABLE one (v INTEGER)');
      db2.prepare('INSERT INTO one (v) VALUES (5)').run();
      const c = new PgStatCollector(db2) as any;
      const s = c.getColumnSummary('one', 'v');
      expect(s.min).toBe(5);
      expect(s.max).toBe(5);
      expect(s.stdDev).toBe(0); // < 2 values -> 0
      expect(s.skewness).toBe(0); // < 3 values -> 0
      expect(s.kurtosis).toBe(0); // < 4 values -> 0
      db2.close();
    });

    it('getColumnSummary ignores non-numeric values in a mixed column', () => {
      const db2 = new Database(':memory:');
      db2.exec('CREATE TABLE mixed (v TEXT)');
      db2.prepare('INSERT INTO mixed (v) VALUES (?)').run('10');
      db2.prepare('INSERT INTO mixed (v) VALUES (?)').run('20');
      db2.prepare('INSERT INTO mixed (v) VALUES (?)').run('not-a-number');
      const c = new PgStatCollector(db2) as any;
      const s = c.getColumnSummary('mixed', 'v');
      expect(s.min).toBe(10);
      expect(s.max).toBe(20);
      expect(s.mean).toBeCloseTo(15);
      db2.close();
    });

    it('estimateSelectivity IN with falsy value defaults to 10 values', () => {
      const c = makeCollector();
      c.collectColumnStats('users', 'age', c.options);
      // No value -> nValues = 10
      const sel = c.estimateSelectivity('users', 'age', 'IN');
      expect(sel).toBeCloseTo(Math.min(1, Math.max(0.001, 10 / 4)));
    });

    it('loadFromDb restores column (null column_name) and index stats', () => {
      const db2 = new Database(':memory:');
      db2.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      // First construct to create the pg_stats table.
      new PgStatCollector(db2);
      // Write a column row with NULL column_name and an index row directly,
      // then reconstruct to exercise the load-path branches.
      db2.prepare(
        `INSERT OR REPLACE INTO _sqlvec_pg_stats (stat_type, table_name, column_name, index_name, stat_key, stat_value) VALUES (?,?,?,?,?,?)`,
      ).run(
        'column', 'users', null, null, '__fallback__',
        JSON.stringify({ tableName: 'users', columnName: '', nullFrac: 0, avgWidth: 8, nDistinct: 1, mcv: [], histogramBounds: [], correlation: 0 }),
      );
      db2.prepare(
        `INSERT OR REPLACE INTO _sqlvec_pg_stats (stat_type, table_name, column_name, index_name, stat_key, stat_value) VALUES (?,?,?,?,?,?)`,
      ).run(
        'index', 'users', null, 'idx_x', 'idx_x',
        JSON.stringify({ indexName: 'idx_x', tableName: 'users', columnNames: ['a'], rowCount: 1, distinctKeys: 1, nullFrac: 0, avgWidth: 8 }),
      );
      // A row with an unrecognized stat_type is simply skipped (no branch matches).
      db2.prepare(
        `INSERT OR REPLACE INTO _sqlvec_pg_stats (stat_type, table_name, column_name, index_name, stat_key, stat_value) VALUES (?,?,?,?,?,?)`,
      ).run('unknown', 'users', null, null, 'u', JSON.stringify({}));
      const c = new PgStatCollector(db2) as any;
      // Empty column_name maps to '' key in the cache.
      expect(c.getColumnStats('users', '')).not.toBeNull();
      expect(c.getIndexStats('idx_x')).not.toBeNull();
      db2.close();
    });
  });
});
