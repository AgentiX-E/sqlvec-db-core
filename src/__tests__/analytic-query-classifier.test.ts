import { describe, it, expect, vi } from 'vitest';
import {
  AnalyticQueryClassifier,
  DEFAULT_CLASSIFIER_CONFIG,
  QueryTarget,
  AnalyticQueryClassifierResult,
} from '../analytics/AnalyticQueryClassifier';
import type { ParsedStatement } from '../query/SqlParser';

function select(over: Partial<Record<string, unknown>> = {}): ParsedStatement {
  return {
    type: 'SELECT',
    hasJoin: false,
    tables: ['t'],
    limit: null,
    where: undefined,
    ...over,
  } as unknown as ParsedStatement;
}

describe('AnalyticQueryClassifier.classify — config overrides', () => {
  it('routes to SQLite when alwaysRouteToSQLite is set', () => {
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, alwaysRouteToSQLite: true });
    const r = c.classify('SELECT * FROM t JOIN u ON t.id = u.id', select({ hasJoin: true, tables: ['t', 'u'] }));
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
  });

  it('routes to SQLite when disabled', () => {
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, enabled: false });
    const r = c.classify('SELECT COUNT(*) FROM t', select());
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(r.reason).toContain('disabled');
  });

  it('routes to DuckDB when alwaysRouteToDuckDB is set', () => {
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, alwaysRouteToDuckDB: true });
    const r = c.classify('SELECT * FROM t LIMIT 1', select({ limit: 1 }));
    expect(r.target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('prefers alwaysRouteToSQLite over alwaysRouteToDuckDB', () => {
    const c = new AnalyticQueryClassifier({
      ...DEFAULT_CLASSIFIER_CONFIG,
      alwaysRouteToSQLite: true,
      alwaysRouteToDuckDB: true,
    });
    const r = c.classify('SELECT * FROM t', select());
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
  });
});

describe('AnalyticQueryClassifier.classify — rule priority', () => {
  it('Rule 1: non-SELECT statements go to SQLite', () => {
    const c = new AnalyticQueryClassifier();
    const r = c.classify('UPDATE t SET x = 1', { type: 'UPDATE' } as unknown as ParsedStatement);
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(r.reason).toContain('not SELECT');
  });

  it('Rule 2: in-transaction queries go to SQLite', () => {
    const c = new AnalyticQueryClassifier();
    const r = c.classify('SELECT * FROM t', select(), { inTransaction: true });
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
  });

  it('Rule 3: hasJoin routes to DuckDB', () => {
    const c = new AnalyticQueryClassifier();
    const r = c.classify('SELECT * FROM t JOIN u ON t.id = u.id', select({ hasJoin: true, tables: ['t', 'u'] }));
    expect(r.target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 3: multiple tables routes to DuckDB', () => {
    const c = new AnalyticQueryClassifier();
    const r = c.classify('SELECT * FROM t, u', select({ tables: ['t', 'u'] }));
    expect(r.target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 4: aggregation routes to DuckDB', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT COUNT(*) FROM t', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM t GROUP BY x', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM t HAVING x > 1', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT SUM(x) FROM t', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT STRING_AGG(x, ",") FROM t', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 5: window function routes to DuckDB', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT rank() OVER (ORDER BY x) FROM t', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 6: subquery routes to DuckDB', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT * FROM t WHERE id IN (SELECT id FROM u)', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM t WHERE EXISTS (SELECT 1 FROM u)', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM (SELECT * FROM u) x', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM t WHERE x = ANY(SELECT y FROM u)', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 4: COUNT(DISTINCT ...) is captured by the aggregation rule', () => {
    const c = new AnalyticQueryClassifier();
    const r = c.classify('SELECT COUNT(DISTINCT x) FROM t', select());
    expect(r.target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(r.reason).toContain('aggregation');
  });

  it('Rule 8: WHERE equality point query routes to SQLite', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT * FROM t WHERE id = 1', select()).target).toBe(QueryTarget.SQLITE_OLTP);
    expect(c.classify('SELECT * FROM t WHERE name = \'bob\'', select()).target).toBe(QueryTarget.SQLITE_OLTP);
  });

  it('Rule 8 does not trigger on IN/NOT IN/LIKE/BETWEEN predicates', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT * FROM t WHERE id IN (1, 2, 3)', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(c.classify('SELECT * FROM t WHERE name LIKE \'%a%\'', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 8 does not trigger on an empty/malformed WHERE clause', () => {
    const c = new AnalyticQueryClassifier();
    // "WHERE" with no trailing predicate fails the extraction regex, so the
    // query falls through to the "no LIMIT → DuckDB" rule.
    expect(c.classify('SELECT * FROM t WHERE', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Rule 9: no LIMIT routes to DuckDB (large scan)', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT * FROM t', select()).target).toBe(QueryTarget.DUCKDB_OLAP);
  });

  it('Default: simple SELECT with LIMIT routes to SQLite', () => {
    const c = new AnalyticQueryClassifier();
    expect(c.classify('SELECT * FROM t LIMIT 10', select({ limit: 10 })).target).toBe(QueryTarget.SQLITE_OLTP);
  });
});

describe('AnalyticQueryClassifier — circuit breaker', () => {
  it('breaks after threshold consecutive failures', () => {
    const c = new AnalyticQueryClassifier(DEFAULT_CLASSIFIER_CONFIG);
    for (let i = 0; i < 5; i++) c.reportDuckDBFailure();
    expect(c.isCircuitBroken()).toBe(true);
    const r = c.classify('SELECT * FROM t LIMIT 1', select({ limit: 1 }));
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(r.reason).toContain('circuit-breaker');
    expect(r.confidence).toBe(0.3);
  });

  it('does not break below threshold', () => {
    const c = new AnalyticQueryClassifier(DEFAULT_CLASSIFIER_CONFIG);
    c.reportDuckDBFailure();
    c.reportDuckDBFailure();
    expect(c.isCircuitBroken()).toBe(false);
  });

  it('does not break when threshold is zero', () => {
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, circuitBreakerThreshold: 0 });
    for (let i = 0; i < 10; i++) c.reportDuckDBFailure();
    expect(c.isCircuitBroken()).toBe(false);
  });

  it('recovers after the cooldown elapses', () => {
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, circuitBreakerCooldownMs: 60_000 });
    for (let i = 0; i < 5; i++) c.reportDuckDBFailure();
    expect(c.isCircuitBroken()).toBe(true);
    // advance past the 60s cooldown
    now += 61_000;
    expect(c.isCircuitBroken()).toBe(false);
    expect(c.failureCount_).toBe(0);
    vi.restoreAllMocks();
  });

  it('never breaks when cooldown is zero (immediate recovery)', () => {
    const c = new AnalyticQueryClassifier({ ...DEFAULT_CLASSIFIER_CONFIG, circuitBreakerCooldownMs: 0 });
    for (let i = 0; i < 5; i++) c.reportDuckDBFailure();
    expect(c.isCircuitBroken()).toBe(false);
  });

  it('success decay reduces failure count', () => {
    const c = new AnalyticQueryClassifier(DEFAULT_CLASSIFIER_CONFIG);
    c.reportDuckDBFailure();
    c.reportDuckDBFailure();
    c.reportDuckDBSuccess();
    // 2 - 2 = 0
    expect(c.failureCount_).toBe(0);
  });

  it('success decay never goes below zero', () => {
    const c = new AnalyticQueryClassifier(DEFAULT_CLASSIFIER_CONFIG);
    c.reportDuckDBSuccess();
    expect(c.failureCount_).toBe(0);
  });

  it('reset clears failure state', () => {
    const c = new AnalyticQueryClassifier(DEFAULT_CLASSIFIER_CONFIG);
    c.reportDuckDBFailure();
    c.reset();
    expect(c.failureCount_).toBe(0);
    expect(c.isCircuitBroken()).toBe(false);
  });
});

describe('AnalyticQueryClassifierResult', () => {
  it('defaults confidence to 1.0', () => {
    const r = new AnalyticQueryClassifierResult(QueryTarget.SQLITE_OLTP, 'x');
    expect(r.confidence).toBe(1.0);
    expect(r.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(r.reason).toBe('x');
  });
});
