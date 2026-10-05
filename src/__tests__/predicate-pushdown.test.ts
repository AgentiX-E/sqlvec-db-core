import { describe, it, expect } from 'vitest';
import {
  planPushdown,
  determineMergeStrategy,
  wrapWithReaggregate,
} from '../analytics/pushdown/PredicatePushdown';

/**
 * PredicatePushdown — distributed analytics filter/aggregation pushdown.
 *
 * These tests pin down the contract that `planPushdown`,
 * `determineMergeStrategy`, and `wrapWithReaggregate` agree on what counts as
 * an aggregation query. A mismatch here had real consequences: a
 * `STRING_AGG`/`ARRAY_AGG`/`LISTAGG` query was planned as `partial_group_by`
 * but merged as `union_all`, so per-node partial aggregates were UNION ALL'd
 * without re-aggregation.
 */
describe('PredicatePushdown — planPushdown', () => {
  it('returns a none plan when there are no peers', () => {
    const plan = planPushdown('SELECT * FROM t', []);
    expect(plan).toEqual({ nodeQueries: [], pushdownApplied: false, strategy: 'none' });
  });

  it('uses partial_group_by for GROUP BY queries', () => {
    const plan = planPushdown('SELECT region, SUM(amount) FROM orders GROUP BY region', [1, 2, 3]);
    expect(plan.strategy).toBe('partial_group_by');
    expect(plan.pushdownApplied).toBe(true);
    expect(plan.nodeQueries.map(q => q.nodeId)).toEqual([1, 2, 3]);
    expect(plan.nodeQueries.every(q => q.sql.includes('GROUP BY region'))).toBe(true);
  });

  it('uses partial_group_by for a bare aggregate without GROUP BY', () => {
    const plan = planPushdown('SELECT COUNT(*) FROM t', [1, 2]);
    expect(plan.strategy).toBe('partial_group_by');
  });

  it('uses full_filter for a plain filtered query with no aggregation', () => {
    const plan = planPushdown('SELECT * FROM t WHERE region = \'west\'', [1, 2]);
    expect(plan.strategy).toBe('full_filter');
    expect(plan.pushdownApplied).toBe(true);
  });

  it('broadcasts the identical SQL to every peer', () => {
    const sql = 'SELECT * FROM t WHERE a = 1';
    const plan = planPushdown(sql, [7, 8, 9]);
    expect(plan.nodeQueries).toEqual([
      { nodeId: 7, sql },
      { nodeId: 8, sql },
      { nodeId: 9, sql },
    ]);
  });

  it('accepts an optional shardKey argument without changing strategy shape', () => {
    const plan = planPushdown('SELECT * FROM t WHERE aid = 1', [1, 2], 'aid');
    expect(plan.strategy).toBe('full_filter');
    expect(plan.nodeQueries).toHaveLength(2);
  });
});

describe('PredicatePushdown — determineMergeStrategy', () => {
  it('returns union_all for a plain SELECT', () => {
    expect(determineMergeStrategy('SELECT * FROM t')).toBe('union_all');
  });

  it('returns union_all_reaggregate for GROUP BY', () => {
    expect(determineMergeStrategy('SELECT a, SUM(b) FROM t GROUP BY a')).toBe('union_all_reaggregate');
  });

  it('returns union_all_reaggregate for a bare aggregate (no GROUP BY)', () => {
    expect(determineMergeStrategy('SELECT COUNT(*) FROM t')).toBe('union_all_reaggregate');
  });

  it('returns union_all_reaggregate for STRING_AGG (regression)', () => {
    expect(determineMergeStrategy('SELECT STRING_AGG(n, \',\') FROM emp')).toBe('union_all_reaggregate');
  });

  it('returns union_all_reaggregate for ARRAY_AGG (regression)', () => {
    expect(determineMergeStrategy('SELECT ARRAY_AGG(n) FROM emp')).toBe('union_all_reaggregate');
  });

  it('returns union_all_reaggregate for LISTAGG (regression)', () => {
    expect(determineMergeStrategy('SELECT LISTAGG(n) FROM emp')).toBe('union_all_reaggregate');
  });
});

describe('PredicatePushdown — wrapWithReaggregate', () => {
  it('returns the original SQL unchanged when there is no aggregation', () => {
    const sql = 'SELECT * FROM t';
    expect(wrapWithReaggregate(sql)).toBe(sql);
  });

  it('wraps a GROUP BY query in an outer SELECT', () => {
    const out = wrapWithReaggregate('SELECT region, SUM(amount) FROM orders GROUP BY region');
    expect(out).toContain('SELECT * FROM (');
    expect(out).toContain(') AS _partial');
    expect(out).toContain('ORDER BY 1');
  });

  it('wraps an aggregate-without-GROUP-BY in a plain outer SELECT', () => {
    const out = wrapWithReaggregate('SELECT COUNT(*) FROM t');
    expect(out).toBe('SELECT * FROM (SELECT COUNT(*) FROM t) AS _partial');
  });

  it('wraps a STRING_AGG query (regression: previously not treated as agg)', () => {
    const sql = 'SELECT STRING_AGG(n, \',\') FROM emp';
    const out = wrapWithReaggregate(sql);
    // Now recognized as aggregation, so it must be wrapped (not returned as-is).
    expect(out).not.toBe(sql);
  });
});

describe('PredicatePushdown — cross-function consistency', () => {
  const aggregateQueries = [
    'SELECT STRING_AGG(n, \',\') FROM emp',
    'SELECT ARRAY_AGG(n) FROM emp',
    'SELECT LISTAGG(n) FROM emp',
    'SELECT dept, STRING_AGG(n, \',\') FROM emp GROUP BY dept',
    'SELECT COUNT(*) FROM t',
    'SELECT region, SUM(amount) FROM orders GROUP BY region',
  ];

  it.each(aggregateQueries)(
    'classifies the same query consistently across planPushdown and determineMergeStrategy: %s',
    (sql) => {
      const plan = planPushdown(sql, [1, 2]);
      const merge = determineMergeStrategy(sql);
      const planAgg = plan.strategy === 'partial_group_by';
      const mergeAgg = merge === 'union_all_reaggregate';
      expect(planAgg).toBe(mergeAgg);
    },
  );
});
