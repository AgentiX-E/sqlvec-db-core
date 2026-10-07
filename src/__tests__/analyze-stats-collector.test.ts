import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  tableStatsQuery,
  buildMcvQuery,
  buildHistogramQuery,
  buildAnalyzeSql,
  analyzeTable,
  MCV_LIMIT,
  MAX_HISTOGRAM_BUCKETS,
  STATS_TABLE,
  HISTOGRAM_TABLE,
} from '../query/AnalyzeStatsCollector';

describe('tableStatsQuery', () => {
  it('throws when tableName or columns are missing', () => {
    expect(() => tableStatsQuery('', ['a'])).toThrow('tableName and columns are required');
    expect(() => tableStatsQuery('t', [])).toThrow('tableName and columns are required');
    expect(() => tableStatsQuery('t', undefined as any)).toThrow('tableName and columns are required');
  });

  it('generates one SELECT per column joined by UNION ALL', () => {
    const sql = tableStatsQuery('users', ['id', 'name']);
    expect(sql).toContain("'id' AS column_name");
    expect(sql).toContain("'name' AS column_name");
    expect(sql).toContain('UNION ALL');
    expect(sql.match(/SELECT/g)?.length).toBe(2);
  });

  it('escapes double quotes in identifiers', () => {
    const sql = tableStatsQuery('my"table', ['we"ird']);
    expect(sql).toContain('FROM "my""table"');
    expect(sql).toContain('"we""ird"');
  });

  it('escapes single quotes in column-name literals', () => {
    const sql = tableStatsQuery('t', ["o'brien"]);
    expect(sql).toContain("'o''brien' AS column_name");
  });

  it('produces a null_count of 0 for an empty table via IFNULL', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE empty_t (id INTEGER)');
    const rows = db.prepare(tableStatsQuery('empty_t', ['id'])).all() as any[];
    expect(rows[0].null_count).toBe(0);
    expect(rows[0].row_count).toBe(0);
  });
});

describe('buildMcvQuery', () => {
  it('generates a grouped COUNT query with default limit', () => {
    const sql = buildMcvQuery('users', 'status');
    expect(sql).toContain('SELECT "status" AS val, COUNT(*) AS freq');
    expect(sql).toContain('GROUP BY "status"');
    expect(sql).toContain(`LIMIT ${MCV_LIMIT}`);
  });

  it('clamps limit to at least 1', () => {
    const sql = buildMcvQuery('users', 'status', 0);
    expect(sql).toContain('LIMIT 1');
  });

  it('applies a custom limit', () => {
    const sql = buildMcvQuery('users', 'status', 25);
    expect(sql).toContain('LIMIT 25');
  });
});

describe('buildHistogramQuery', () => {
  it('generates an NTILE-based histogram query', () => {
    const sql = buildHistogramQuery('users', 'age', 10);
    expect(sql).toContain('NTILE(10) OVER (ORDER BY "age")');
    expect(sql).toContain('bucket - 1 AS bucket_index');
  });

  it('clamps bucketCount to the allowed range', () => {
    expect(buildHistogramQuery('t', 'c', 0)).toContain('NTILE(1)');
    expect(buildHistogramQuery('t', 'c', 99999)).toContain(`NTILE(${MAX_HISTOGRAM_BUCKETS})`);
  });

  it('uses the default bucket count', () => {
    expect(buildHistogramQuery('t', 'c')).toContain(`NTILE(${MAX_HISTOGRAM_BUCKETS})`);
  });
});

describe('buildAnalyzeSql', () => {
  it('throws when tableName is missing', () => {
    expect(() => buildAnalyzeSql('')).toThrow('tableName is required');
  });

  it('returns an analyze command marker', () => {
    const sql = buildAnalyzeSql('users');
    expect(sql).toContain("'__sqlvec_analyze' AS cmd");
    expect(sql).toContain("'users' AS table_name");
  });

  it('escapes single quotes in the table-name literal', () => {
    const sql = buildAnalyzeSql("us'ers");
    expect(sql).toContain("'us''ers' AS table_name");
  });
});

describe('analyzeTable', () => {
  it('throws when db or tableName is missing', () => {
    expect(() => analyzeTable(null as any, 't')).toThrow('db and tableName are required');
    expect(() => analyzeTable(new Database(':memory:') as any, '')).toThrow(
      'db and tableName are required',
    );
  });

  it('throws a descriptive error for a nonexistent table', () => {
    const db = new Database(':memory:');
    expect(() => analyzeTable(db, 'nope')).toThrow('table "nope" not found');
  });

  it('collects basic stats, MCV, and histograms for each column', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER, name TEXT, age INTEGER)');
    db.exec("INSERT INTO users VALUES (1,'alice',30),(2,'bob',25),(3,'carol',30),(4,NULL,25)");

    const r = analyzeTable(db, 'users');
    expect(r.tableName).toBe('users');
    expect(r.statsCount).toBe(3);
    expect(r.statsColumns).toEqual(['id', 'name', 'age']);

    const stats = db.prepare(`SELECT * FROM ${STATS_TABLE} WHERE table_name = 'users' ORDER BY column_name`).all() as any[];
    expect(stats.length).toBe(3);

    const age = stats.find((s) => s.column_name === 'age');
    expect(age.row_count).toBe(4);
    expect(age.null_count).toBe(0);
    expect(age.null_fraction).toBe(0);
    expect(age.distinct_count).toBe(2);
    expect(JSON.parse(age.mcv_values)).toEqual([30, 25]);

    const name = stats.find((s) => s.column_name === 'name');
    expect(name.null_count).toBe(1);
    expect(name.null_fraction).toBeCloseTo(0.25);

    const hist = db.prepare(`SELECT * FROM ${HISTOGRAM_TABLE} WHERE table_name = 'users'`).all() as any[];
    expect(hist.length).toBeGreaterThan(0);
    expect(r.histogramCount).toBe(hist.length);
  });

  it('replaces stale stats on re-analysis', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.exec('INSERT INTO t VALUES (1)');

    analyzeTable(db, 't');
    const first = db.prepare(`SELECT analyzed_at AS at FROM ${STATS_TABLE} WHERE table_name='t'`).get() as any;

    db.exec('INSERT INTO t VALUES (2),(3)');
    analyzeTable(db, 't');

    const stats = db.prepare(`SELECT * FROM ${STATS_TABLE} WHERE table_name='t'`).all() as any[];
    expect(stats.length).toBe(1);
    expect(stats[0].row_count).toBe(3);
  });

  it('returns zero counts for a table with no rows', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE empty_t (id INTEGER)');
    const r = analyzeTable(db, 'empty_t');
    expect(r.statsCount).toBe(1);
    expect(r.histogramCount).toBe(0);

    const stats = db.prepare(`SELECT * FROM ${STATS_TABLE} WHERE table_name='empty_t'`).all() as any[];
    expect(stats[0].row_count).toBe(0);
    expect(stats[0].null_count).toBe(0);
    expect(stats[0].null_fraction).toBe(0);
  });
});
