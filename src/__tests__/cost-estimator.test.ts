/**
 * CostEstimator — OLTP/OLAP cost-based routing tests.
 *
 * Covers table-stat CRUD, aggregation/join detection, analytic-threshold
 * scheduling, disabled mode, unknown/empty table handling, join cost doubling,
 * and the human-readable row-count formatter (including boundary rounding).
 */
import { describe, it, expect } from 'vitest';
import { CostEstimator } from '../query/CostEstimator';
import type { ParsedStatement } from '../query/SqlParser';

function select(tables: string[], hasJoin = false): ParsedStatement {
  return {
    type: 'SELECT',
    originalSql: '',
    tables,
    hasJoin,
    isMultiShard: hasJoin && tables.length > 1,
  };
}

describe('CostEstimator table stats', () => {
  it('updates and retrieves table stats case-insensitively', () => {
    const e = new CostEstimator();
    e.updateTableStats('Users', 5000);
    expect(e.getTableStats('users')?.rowCount).toBe(5000);
    expect(e.getTableStats('USERS')?.rowCount).toBe(5000);
  });

  it('updates multiple tables in bulk', () => {
    const e = new CostEstimator();
    e.updateBulk([
      { tableName: 'a', rowCount: 1 },
      { tableName: 'b', rowCount: 2 },
    ]);
    expect(e.trackedTableCount).toBe(2);
    expect(e.getTableStats('a')?.rowCount).toBe(1);
  });

  it('returns undefined for unknown tables', () => {
    const e = new CostEstimator();
    expect(e.getTableStats('nope')).toBeUndefined();
  });

  it('getAllStats returns an independent snapshot', () => {
    const e = new CostEstimator();
    e.updateTableStats('a', 10);
    const snap = e.getAllStats();
    snap.set('b', { tableName: 'b', rowCount: 5, updatedAt: 0 });
    // Mutation of the snapshot must not affect the estimator.
    expect(e.trackedTableCount).toBe(1);
    expect(e.getTableStats('b')).toBeUndefined();
  });

  it('clear empties stats', () => {
    const e = new CostEstimator();
    e.updateTableStats('a', 10);
    e.clear();
    expect(e.trackedTableCount).toBe(0);
  });
});

describe('CostEstimator estimate', () => {
  it('recommends DuckDB for aggregation queries', () => {
    const e = new CostEstimator();
    e.updateTableStats('orders', 5000);
    const r = e.estimate('SELECT COUNT(*) FROM orders', select(['orders']));
    expect(r.recommendDuckDB).toBe(true);
    expect(r.confidence).toBeCloseTo(0.85);
    expect(r.reason).toContain('aggregation');
  });

  it('recommends DuckDB for joins', () => {
    const e = new CostEstimator();
    e.updateTableStats('a', 100);
    e.updateTableStats('b', 100);
    const r = e.estimate('SELECT * FROM a JOIN b', select(['a', 'b'], true));
    expect(r.recommendDuckDB).toBe(true);
    expect(r.confidence).toBeCloseTo(0.75);
    expect(r.reason).toContain('JOIN');
  });

  it('doubles the row estimate for multi-table joins', () => {
    const e = new CostEstimator();
    e.updateTableStats('a', 100);
    e.updateTableStats('b', 100);
    const r = e.estimate('SELECT * FROM a JOIN b', select(['a', 'b'], true));
    // 100 + 100 = 200, then × 2 for join = 400.
    expect(r.estimatedRows).toBe(400);
  });

  it('does not double for a single-table "join"', () => {
    const e = new CostEstimator();
    e.updateTableStats('a', 100);
    // hasJoin true but only one table → no doubling, no join recommendation.
    const r = e.estimate('SELECT * FROM a', select(['a'], true));
    expect(r.estimatedRows).toBe(100);
  });

  it('recommends DuckDB when rows exceed the analytic threshold', () => {
    const e = new CostEstimator();
    e.updateTableStats('big', 20_000);
    const r = e.estimate('SELECT * FROM big', select(['big']));
    expect(r.recommendDuckDB).toBe(true);
    expect(r.confidence).toBeCloseTo(0.65);
    expect(r.reason).toContain('threshold');
  });

  it('prefers SQLite for small queries', () => {
    const e = new CostEstimator();
    e.updateTableStats('small', 10);
    const r = e.estimate('SELECT * FROM small', select(['small']));
    expect(r.recommendDuckDB).toBe(false);
    expect(r.confidence).toBeCloseTo(0.9);
    expect(r.reason).toContain('SQLite');
  });

  it('assumes 1000 rows per unknown table', () => {
    const e = new CostEstimator();
    const r = e.estimate('SELECT * FROM unknown', select(['unknown']));
    expect(r.estimatedRows).toBe(1000);
  });

  it('returns zero rows for no tables referenced', () => {
    const e = new CostEstimator();
    const r = e.estimate('SELECT 1', select([]));
    expect(r.estimatedRows).toBe(0);
    expect(r.recommendDuckDB).toBe(false);
    expect(r.confidence).toBeCloseTo(0.5);
    expect(r.reason).toBe('no tables referenced');
  });

  it('returns a disabled estimate when disabled', () => {
    const e = new CostEstimator({ enabled: false });
    e.updateTableStats('big', 20_000);
    const r = e.estimate('SELECT COUNT(*) FROM big', select(['big']));
    expect(r.recommendDuckDB).toBe(false);
    expect(r.estimatedRows).toBe(0);
    expect(r.confidence).toBe(0);
  });

  it('treats a non-SELECT statement as having no tables', () => {
    const e = new CostEstimator();
    const parsed = { type: 'INSERT', originalSql: '', table: 't', columns: [], hasReturning: false } as ParsedStatement;
    const r = e.estimate('INSERT INTO t VALUES (1)', parsed);
    expect(r.estimatedRows).toBe(0);
    expect(r.reason).toBe('no tables referenced');
  });

  it('respects a custom analytic threshold', () => {
    const e = new CostEstimator({ analyticThreshold: 100 });
    e.updateTableStats('t', 150);
    const r = e.estimate('SELECT * FROM t', select(['t']));
    expect(r.recommendDuckDB).toBe(true);
  });
});

describe('CostEstimator formatCount', () => {
  function fmt(rows: number): string {
    const e = new CostEstimator();
    e.updateTableStats('t', rows);
    const r = e.estimate('SELECT * FROM t', select(['t']));
    // The reason always embeds the formatted count; extract it for inspection.
    return r.reason;
  }

  it('formats small counts as plain integers', () => {
    expect(fmt(999)).toContain('~999');
  });

  it('formats thousands with the K suffix', () => {
    expect(fmt(1500)).toContain('1.5K');
  });

  it('formats millions with the M suffix', () => {
    expect(fmt(2_000_000)).toContain('2.0M');
  });

  it('rolls 999.999K into 1.0M instead of 1000.0K', () => {
    expect(fmt(999_999)).toContain('1.0M');
  });
});
