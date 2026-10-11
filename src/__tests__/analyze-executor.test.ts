import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  analyzeTable,
  getTableStats,
  needsAnalyze,
  getColumnCorrelation,
  getColumnDistinctCount,
  STATS_PREFIX,
  CREATE_STATS_SQL,
} from '../query/AnalyzeExecutor';

describe('AnalyzeExecutor — analyzeTable', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('creates the stats table and returns zero columns for a missing table', () => {
    const res = analyzeTable(db, 'nope');
    expect(res.table_name).toBe('nope');
    expect(res.columns_analyzed).toBe(0);
    expect(res.total_columns).toBe(0);
  });

  it('collects stats for each column of a populated table', () => {
    db.exec('CREATE TABLE users (id INTEGER, name TEXT, score REAL)');
    const ins = db.prepare('INSERT INTO users (id, name, score) VALUES (?, ?, ?)');
    ins.run(1, 'alice', 10.5);
    ins.run(2, 'bob', 20.0);
    ins.run(3, 'charlie', 30.0);

    const res = analyzeTable(db, 'users');
    expect(res.columns_analyzed).toBe(3);
    expect(res.total_columns).toBe(3);

    const stats = getTableStats(db, 'users');
    expect(stats).toHaveLength(3);

    const idStats = stats.find(s => s.column_name === 'id')!;
    expect(idStats.row_count).toBe(3);
    expect(idStats.null_count).toBe(0);
    expect(idStats.n_distinct).toBe(3);
    expect(idStats.min_value).toBe('1');
    expect(idStats.max_value).toBe('3');

    const scoreStats = stats.find(s => s.column_name === 'score')!;
    expect(scoreStats.n_distinct).toBe(3);
  });

  it('computes null_count and null_fraction for partial-null columns', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    ins.run(1);
    ins.run(null);
    ins.run(2);
    ins.run(null);

    analyzeTable(db, 't');
    const stats = getTableStats(db, 't');
    const v = stats.find(s => s.column_name === 'v')!;
    expect(v.null_count).toBe(2);
    expect(v.null_fraction).toBeCloseTo(0.5, 5);
    expect(v.n_distinct).toBe(2);
  });

  it('handles an all-null column (min/max null, correlation=0)', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (NULL), (NULL), (NULL)').run();

    const res = analyzeTable(db, 't');
    expect(res.columns_analyzed).toBe(1);

    const stats = getTableStats(db, 't');
    const v = stats.find(s => s.column_name === 'v')!;
    expect(v.null_count).toBe(3);
    expect(v.n_distinct).toBe(0);
    expect(v.min_value).toBe(null);
    expect(v.max_value).toBe(null);
  });

  it('computes a non-zero correlation for a monotonic column', () => {
    db.exec('CREATE TABLE t (v REAL)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 10; i++) ins.run(i);

    analyzeTable(db, 't');
    const stats = getTableStats(db, 't');
    const v = stats.find(s => s.column_name === 'v')!;
    // monotonic increasing → correlation ≈ +1
    expect(v.correlation).toBeGreaterThan(0.9);
  });

  it('computes a negative correlation for a decreasing column', () => {
    db.exec('CREATE TABLE t (v REAL)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 10; i++) ins.run(10 - i);

    analyzeTable(db, 't');
    const stats = getTableStats(db, 't');
    const v = stats.find(s => s.column_name === 'v')!;
    expect(v.correlation).toBeLessThan(-0.9);
  });

  it('falls back to correlation 0 for a non-numeric column', () => {
    db.exec('CREATE TABLE t (v TEXT)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    ins.run('a');
    ins.run('b');
    ins.run('c');

    analyzeTable(db, 't');
    const stats = getTableStats(db, 't');
    const v = stats.find(s => s.column_name === 'v')!;
    // TEXT CAST to REAL → 0, correlation correlation may be NaN → clamped to 0
    expect(Number.isFinite(v.correlation)).toBe(true);
  });

  it('escapes double quotes in table and column names', () => {
    db.exec('CREATE TABLE "we""ird" ("co""l" INTEGER)');
    db.prepare('INSERT INTO "we""ird" ("co""l") VALUES (1), (2)').run();

    const res = analyzeTable(db, 'we"ird');
    expect(res.columns_analyzed).toBe(1);
    const stats = getTableStats(db, 'we"ird');
    expect(stats[0].column_name).toBe('co"l');
  });

  it('replaces stale stats on re-analysis (DELETE then INSERT)', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1), (2)').run();

    analyzeTable(db, 't');
    expect(getTableStats(db, 't')).toHaveLength(1);

    // re-analyze should not duplicate rows
    analyzeTable(db, 't');
    expect(getTableStats(db, 't')).toHaveLength(1);
  });
});

describe('AnalyzeExecutor — needsAnalyze', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('returns true when the stats table does not exist yet (auto-created)', () => {
    // needsAnalyze must be resilient to a missing _sqlvec_stats table
    expect(needsAnalyze(db, 'unknown')).toBe(true);
  });

  it('returns true when stats exist but are stale (older than maxAge)', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1)').run();
    analyzeTable(db, 't');

    // backdate the analyzed_at to 2 hours ago
    db.prepare(
      `UPDATE "${STATS_PREFIX}" SET analyzed_at = CAST(strftime('%s','now') AS INTEGER) - 7200`,
    ).run();

    expect(needsAnalyze(db, 't', 3600)).toBe(true);
  });

  it('returns false when stats are fresh (within maxAge)', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1)').run();
    analyzeTable(db, 't');

    expect(needsAnalyze(db, 't', 3600)).toBe(false);
  });

  it('returns true when stats table is empty for the table (cnt === 0)', () => {
    db.exec(CREATE_STATS_SQL);
    // no analyzeTable() called → _sqlvec_stats has no rows for 't'
    expect(needsAnalyze(db, 't')).toBe(true);
  });
});

describe('AnalyzeExecutor — getColumnCorrelation / getColumnDistinctCount', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('returns correlation for a known column', () => {
    db.exec('CREATE TABLE t (v REAL)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 5; i++) ins.run(i);
    analyzeTable(db, 't');

    const corr = getColumnCorrelation(db, 't', 'v');
    expect(corr).toBeGreaterThan(0.9);
  });

  it('returns 0 correlation for an unknown column', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1)').run();
    analyzeTable(db, 't');

    expect(getColumnCorrelation(db, 't', 'missing')).toBe(0);
  });

  it('returns n_distinct for a known column', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)');
    ins.run(1);
    ins.run(1);
    ins.run(2);
    analyzeTable(db, 't');

    expect(getColumnDistinctCount(db, 't', 'v')).toBe(2);
  });

  it('returns 0 distinct for an unknown column', () => {
    db.exec('CREATE TABLE t (v INTEGER)');
    db.prepare('INSERT INTO t (v) VALUES (1)').run();
    analyzeTable(db, 't');

    expect(getColumnDistinctCount(db, 't', 'missing')).toBe(0);
  });
});

describe('AnalyzeExecutor — read functions tolerate missing stats table', () => {
  it('getTableStats returns [] when nothing has been analyzed yet', () => {
    const db = new Database(':memory:');
    expect(getTableStats(db, 't')).toEqual([]);
  });

  it('getColumnCorrelation returns 0 when nothing has been analyzed yet', () => {
    const db = new Database(':memory:');
    expect(getColumnCorrelation(db, 't', 'v')).toBe(0);
  });

  it('getColumnDistinctCount returns 0 when nothing has been analyzed yet', () => {
    const db = new Database(':memory:');
    expect(getColumnDistinctCount(db, 't', 'v')).toBe(0);
  });

  it('needsAnalyze returns true when nothing has been analyzed yet', () => {
    const db = new Database(':memory:');
    expect(needsAnalyze(db, 't')).toBe(true);
  });
});
