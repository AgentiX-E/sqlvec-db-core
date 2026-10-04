/**
 * UnifiedRouter — unified OLTP/OLAP routing decision pipeline tests.
 *
 * Covers the full decide() priority chain (cache → config overrides →
 * circuit breaker → non-SELECT → transaction → classifier → cost estimator
 * → default), the execute() cache/metrics side effects, and _doExecute()
 * DuckDB/SQLite dispatch including error paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { UnifiedRouter } from '../query/UnifiedRouter';
import { QueryTarget } from '../analytics/AnalyticQueryClassifier';
import { CostEstimator } from '../query/CostEstimator';
import { HotQueryCache } from '../query/HotQueryCache';
import type { ParsedStatement } from '../query/SqlParser';

function select(tables: string[] = ['t'], hasJoin = false): ParsedStatement {
  return { type: 'SELECT', originalSql: '', tables, hasJoin, isMultiShard: hasJoin && tables.length > 1 };
}

function makeDuckdb(overrides: any = {}) {
  return {
    isAvailable: true,
    execute: vi.fn().mockResolvedValue({
      rows: [{ a: 1 }],
      rowCount: 1,
      queryTimeMs: 1,
      engine: 'duckdb',
      routed: true,
    }),
    manager: {
      execute: vi.fn().mockResolvedValue({ rows: [{ a: 1 }], rowCount: 1 }),
    },
    ...overrides,
  } as any;
}

function makeClassifier(overrides: any = {}) {
  return {
    isCircuitBroken: () => false,
    classify: () => ({ target: QueryTarget.SQLITE_OLTP, reason: 'classified-sqlite' }),
    ...overrides,
  } as any;
}

describe('UnifiedRouter.decide priority chain', () => {
  it('returns the cached decision first (hot query cache)', () => {
    const cache = new HotQueryCache();
    cache.set('SELECT 1', {
      target: QueryTarget.DUCKDB_OLAP,
      reason: 'cached',
      skipFallback: true,
    });
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), hotQueryCache: cache });
    expect(r.decide('SELECT 1').reason).toBe('cached');
  });

  it('does not use cache when in a transaction', () => {
    const cache = new HotQueryCache();
    cache.set('SELECT 1', {
      target: QueryTarget.DUCKDB_OLAP,
      reason: 'cached',
      skipFallback: true,
    });
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), hotQueryCache: cache });
    const d = r.decide('SELECT 1', undefined, { inTransaction: true } as any);
    expect(d.reason).not.toBe('cached');
  });

  it('forces SQLite when alwaysRouteToSQLite is set', () => {
    const r = new UnifiedRouter({
      duckDBExecutor: makeDuckdb(),
      alwaysRouteToSQLite: true,
      analyticClassifier: makeClassifier({ classify: () => ({ target: QueryTarget.DUCKDB_OLAP, reason: 'x' }) }),
    });
    const d = r.decide('SELECT 1', select());
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(d.reason).toContain('alwaysRouteToSQLite');
  });

  it('forces DuckDB when alwaysRouteToDuckDB is set', () => {
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), alwaysRouteToDuckDB: true } as any);
    const d = r.decide('SELECT 1', select());
    expect(d.target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(d.skipFallback).toBe(true);
  });

  it('routes to SQLite when the circuit breaker is open', () => {
    const r = new UnifiedRouter({
      duckDBExecutor: makeDuckdb(),
      analyticClassifier: makeClassifier({ isCircuitBroken: () => true }),
    });
    const d = r.decide('SELECT 1', select());
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(d.reason).toContain('circuit-breaker');
  });

  it('routes non-SELECT statements to SQLite', () => {
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb() });
    const parsed = { type: 'INSERT', originalSql: '', table: 't', columns: [], hasReturning: false } as ParsedStatement;
    const d = r.decide('INSERT INTO t VALUES (1)', parsed);
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(d.reason).toContain('non-SELECT');
  });

  it('routes in-transaction queries to SQLite', () => {
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb() });
    const d = r.decide('SELECT 1', select(), { inTransaction: true } as any);
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(d.reason).toContain('in-transaction');
  });

  it('routes to DuckDB when the classifier says so', () => {
    const cls = makeClassifier({ classify: () => ({ target: QueryTarget.DUCKDB_OLAP, reason: 'analytic' }) });
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), analyticClassifier: cls });
    const d = r.decide('SELECT COUNT(*) FROM t', select());
    expect(d.target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(d.confidence).toBeCloseTo(0.8);
  });

  it('stays on SQLite when classifier says SQLite and no cost estimator', () => {
    const cls = makeClassifier({ classify: () => ({ target: QueryTarget.SQLITE_OLTP, reason: 'simple' }) });
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), analyticClassifier: cls });
    const d = r.decide('SELECT * FROM t', select());
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
    expect(d.confidence).toBeCloseTo(0.9);
  });

  it('upgrades to DuckDB via cost estimator when classifier says SQLite', () => {
    const cls = makeClassifier({ classify: () => ({ target: QueryTarget.SQLITE_OLTP, reason: 'simple' }) });
    const est = { estimate: () => ({ recommendDuckDB: true, reason: 'big', confidence: 0.65 }) };
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), analyticClassifier: cls, costEstimator: est as any });
    const d = r.decide('SELECT * FROM big', select());
    expect(d.target).toBe(QueryTarget.DUCKDB_OLAP);
    expect(d.reason).toContain('cost_estimator');
  });

  it('stays SQLite when cost estimator declines', () => {
    const cls = makeClassifier({ classify: () => ({ target: QueryTarget.SQLITE_OLTP, reason: 'simple' }) });
    const est = { estimate: () => ({ recommendDuckDB: false, reason: 'small' }) };
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), analyticClassifier: cls, costEstimator: est as any });
    const d = r.decide('SELECT * FROM small', select());
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
  });

  it('falls back to default SQLite when nothing matches', () => {
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb() });
    const d = r.decide('SELECT 1');
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
  });
});

describe('UnifiedRouter.execute', () => {
  it('caches the decision for non-transactional queries', async () => {
    const cache = new HotQueryCache();
    const dd = makeDuckdb();
    const r = new UnifiedRouter({ duckDBExecutor: dd, hotQueryCache: cache });
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    await r.execute('SELECT 1', decision, 0);
    expect(cache.get('SELECT 1')?.reason).toBe('r');
  });

  it('does not cache decisions for in-transaction queries', async () => {
    const cache = new HotQueryCache();
    const dd = makeDuckdb();
    const r = new UnifiedRouter({ duckDBExecutor: dd, hotQueryCache: cache });
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    await r.execute('SELECT 1', decision, 0, undefined, { inTransaction: true } as any);
    expect(cache.get('SELECT 1')).toBeUndefined();
  });

  it('emits route metrics after execution', async () => {
    const metrics = { emitRouteEvent: vi.fn() };
    const dd = makeDuckdb();
    const r = new UnifiedRouter({ duckDBExecutor: dd, routeMetrics: metrics as any });
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    await r.execute('SELECT 1', decision, 0);
    expect(metrics.emitRouteEvent).toHaveBeenCalled();
  });
});

describe('UnifiedRouter._doExecute DuckDB paths', () => {
  it('executes directly via manager when alwaysRouteToDuckDB is set', async () => {
    const dd = makeDuckdb();
    const r = new UnifiedRouter({ duckDBExecutor: dd, alwaysRouteToDuckDB: true } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(true);
    expect(res.engine).toBe('duckdb_olap');
    expect(dd.manager.execute).toHaveBeenCalled();
  });

  it('returns a failed result when direct DuckDB execution throws', async () => {
    const dd = makeDuckdb({
      manager: { execute: vi.fn().mockRejectedValue(new Error('boom')) },
    });
    const r = new UnifiedRouter({ duckDBExecutor: dd, alwaysRouteToDuckDB: true } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(false);
    expect(res.error).toBe('boom');
  });

  it('returns the DuckDB result when the executor routes', async () => {
    const dd = makeDuckdb();
    const r = new UnifiedRouter({ duckDBExecutor: dd } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(true);
    expect(res.engine).toBe('duckdb_olap');
  });

  it('returns a federated engine when the executor reports federated', async () => {
    const dd = makeDuckdb({
      execute: vi.fn().mockResolvedValue({
        rows: [], rowCount: 0, queryTimeMs: 1, engine: 'duckdb_federated',
        federated: true, routed: true,
      }),
    });
    const r = new UnifiedRouter({ duckDBExecutor: dd } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.engine).toBe('duckdb_federated');
    expect(res.federated).toBe(true);
  });

  it('returns failure when the executor reports not routed', async () => {
    const dd = makeDuckdb({
      execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, queryTimeMs: 1, routed: false, reason: 'nope' }),
    });
    const r = new UnifiedRouter({ duckDBExecutor: dd } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(false);
    expect(res.error).toContain('nope');
  });

  it('returns failure when DuckDB execution throws', async () => {
    const dd = makeDuckdb({ execute: vi.fn().mockRejectedValue(new Error('exec-fail')) });
    const r = new UnifiedRouter({ duckDBExecutor: dd } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(false);
    expect(res.error).toBe('exec-fail');
  });

  it('defers to caller for SQLite decisions', async () => {
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb() } as any);
    const decision = { target: QueryTarget.SQLITE_OLTP, reason: 'r', skipFallback: false };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.engine).toBe('sqlite_oltp');
    expect(res.success).toBe(false);
    expect(res.error).toContain('defer');
  });
});

describe('UnifiedRouter.isAvailable', () => {
  it('reflects the DuckDB executor availability', () => {
    expect(new UnifiedRouter({ duckDBExecutor: makeDuckdb() } as any).isAvailable).toBe(true);
    expect(new UnifiedRouter({ duckDBExecutor: makeDuckdb({ isAvailable: false }) } as any).isAvailable).toBe(false);
  });
});

describe('UnifiedRouter cache vs config override precedence', () => {
  it('config override wins over a previously-cached decision', () => {
    const cache = new HotQueryCache();
    // First: route under alwaysRouteToDuckDB, which caches the decision.
    const duck = makeDuckdb();
    let r = new UnifiedRouter({ duckDBExecutor: duck, alwaysRouteToDuckDB: true, hotQueryCache: cache } as any);
    const forced = r.decide('SELECT 1', select());
    expect(forced.target).toBe(QueryTarget.DUCKDB_OLAP);
    cache.set('SELECT 1', forced);

    // Now: a fresh router with alwaysRouteToSQLite must NOT return the stale DuckDB cache.
    r = new UnifiedRouter({ duckDBExecutor: duck, alwaysRouteToSQLite: true, hotQueryCache: cache } as any);
    const d = r.decide('SELECT 1', select());
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
  });
});

describe('UnifiedRouter config override cache pollution', () => {
  it('does not cache a decision when alwaysRouteToSQLite is active', async () => {
    const cache = new HotQueryCache();
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), alwaysRouteToSQLite: true, hotQueryCache: cache } as any);
    const decision = { target: QueryTarget.SQLITE_OLTP, reason: 'config', skipFallback: false };
    await r.execute('SELECT 1', decision, 0);
    expect(cache.get('SELECT 1')).toBeUndefined();
  });

  it('does not cache a decision when alwaysRouteToDuckDB is active', async () => {
    const cache = new HotQueryCache();
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), alwaysRouteToDuckDB: true, hotQueryCache: cache } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'config', skipFallback: true };
    await r.execute('SELECT 1', decision, 0);
    expect(cache.get('SELECT 1')).toBeUndefined();
  });
});

describe('UnifiedRouter remaining branches', () => {
  it('does not crash when a classifier returns an unknown target', () => {
    const cls = makeClassifier({ classify: () => ({ target: 'unknown', reason: 'x' }) });
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), analyticClassifier: cls } as any);
    const d = r.decide('SELECT 1', select());
    expect(d).toBeDefined();
  });

  it('emits metrics for a SQLite decision', async () => {
    const metrics = { emitRouteEvent: vi.fn() };
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), routeMetrics: metrics as any });
    const decision = { target: QueryTarget.SQLITE_OLTP, reason: 'r', skipFallback: false };
    await r.execute('SELECT 1', decision, 0);
    expect(metrics.emitRouteEvent).toHaveBeenCalledWith('sqlite_oltp', expect.any(Number), false);
  });

  it('uses a default error when DuckDB reports no route without a reason', async () => {
    const dd = makeDuckdb({
      execute: vi.fn().mockResolvedValue({ rows: [], rowCount: 0, queryTimeMs: 1, routed: false, reason: undefined }),
    });
    const r = new UnifiedRouter({ duckDBExecutor: dd } as any);
    const decision = { target: QueryTarget.DUCKDB_OLAP, reason: 'r', skipFallback: true };
    const res = await (r as any)._doExecute('SELECT 1', decision, 0);
    expect(res.success).toBe(false);
    expect(res.error).toBe('DuckDB route failed unexpectedly');
  });

  it('returns undefined from cache on a miss and falls through', () => {
    const cache = new HotQueryCache();
    const r = new UnifiedRouter({ duckDBExecutor: makeDuckdb(), hotQueryCache: cache });
    // no cache entry → decide must not use the cache and fall to default.
    const d = r.decide('SELECT 1');
    expect(d.target).toBe(QueryTarget.SQLITE_OLTP);
  });
});
