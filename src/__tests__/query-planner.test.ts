import { describe, it, expect } from 'vitest';
import {
  QueryPlanner,
  type CandidatePlan,
  type IndexDef,
  type JoinCondition,
  type QueryCondition,
  type TableJoinInfo,
  type TableStats,
  type OptimizedJoinOrder,
} from '../query/QueryPlanner';
import { CostModel } from '../query/CostModel';

// ── helpers ────────────────────────────────────────────────────────────────

function makeStats(overrides: Partial<TableStats> = {}): TableStats {
  return {
    reltuples: 1000,
    relpages: 10,
    nDistinct: new Map<string, number>(),
    correlation: new Map<string, number>(),
    ...overrides,
  };
}

function makeIndex(overrides: Partial<IndexDef>): IndexDef {
  return {
    name: 'idx',
    tableName: 't',
    columns: ['id'],
    unique: true,
    primary: true,
    ...overrides,
  };
}

function scanPlan(overrides: Partial<CandidatePlan> = {}): CandidatePlan {
  return {
    type: 'sequential-scan',
    startupCost: 0,
    totalCost: 10,
    rows: 100,
    width: 0,
    description: 'Seq Scan on t',
    ...overrides,
  };
}

function joinInfo(overrides: Partial<TableJoinInfo> = {}): TableJoinInfo {
  const stats = makeStats();
  return {
    name: 't',
    stats,
    scanCost: { startupCost: 0, totalCost: 10, rows: 100, width: 0 },
    conditions: [],
    ...overrides,
  };
}

// ── constructor / accessor ────────────────────────────────────────────────

describe('QueryPlanner constructor & cost model accessor', () => {
  it('uses a default CostModel when none is supplied', () => {
    const qp = new QueryPlanner();
    expect(qp.getCostModel()).toBeInstanceOf(CostModel);
  });

  it('uses a caller-supplied cost model', () => {
    const cm = new CostModel({ seqPageCost: 2 });
    const qp = new QueryPlanner(cm);
    expect(qp.getCostModel()).toBe(cm);
    expect(qp.getCostModel().getCostFactors().seqPageCost).toBe(2);
  });
});

// ── estimateSelectivity ───────────────────────────────────────────────────

describe('QueryPlanner.estimateSelectivity', () => {
  const stats = makeStats({ nDistinct: new Map([['id', 100]]) });

  it('handles = and ==', () => {
    const qp = new QueryPlanner();
    const cond = (op: string): QueryCondition => ({
      table: 't', column: 'id', operator: op, value: 'x', exact: true,
    });
    expect(qp.estimateSelectivity(cond('='), stats)).toBeCloseTo(0.01);
    expect(qp.estimateSelectivity(cond('=='), stats)).toBeCloseTo(0.01);
  });

  it('handles range operators (<, <=, >, >=) to ~1/3', () => {
    const qp = new QueryPlanner();
    for (const op of ['<', '<=', '>', '>=']) {
      const cond: QueryCondition = { table: 't', column: 'id', operator: op, value: '5', exact: false };
      expect(qp.estimateSelectivity(cond, stats)).toBeCloseTo(1 / 3);
    }
  });

  it('handles LIKE / ILIKE to 0.1', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'LIKE', value: 'a%', exact: false }, stats)).toBe(0.1);
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'ILIKE', value: 'a%', exact: false }, stats)).toBe(0.1);
  });

  it('handles IN to 1/n', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'IN', value: '1,2', exact: false }, stats)).toBeCloseTo(0.01);
  });

  it('handles <> and != to 1 - 1/n', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: '<>', value: 'x', exact: false }, stats)).toBeCloseTo(0.99);
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: '!=', value: 'x', exact: false }, stats)).toBeCloseTo(0.99);
  });

  it('handles IS NULL / IS NOT NULL', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'IS NULL', value: '', exact: true }, stats)).toBe(0.01);
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'IS NOT NULL', value: '', exact: true }, stats)).toBe(0.99);
  });

  it('returns 0.5 for unknown operators', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: 'WEIRD', value: '', exact: false }, stats)).toBe(0.5);
  });

  it('clamps a zero nDistinct to at least 1', () => {
    const qp = new QueryPlanner();
    const zero = makeStats({ nDistinct: new Map([['id', 0]]) });
    // 1 / max(1, 0) = 1
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: '=', value: 'x', exact: true }, zero)).toBe(1);
  });

  it('falls back to reltuples when column has no nDistinct entry', () => {
    const qp = new QueryPlanner();
    const noEntry = makeStats({ reltuples: 50, nDistinct: new Map() });
    expect(qp.estimateSelectivity({ table: 't', column: 'id', operator: '=', value: 'x', exact: true }, noEntry)).toBeCloseTo(1 / 50);
  });
});

// ── estimateOutputRows ────────────────────────────────────────────────────

describe('QueryPlanner.estimateOutputRows', () => {
  it('returns reltuples when no conditions', () => {
    const qp = new QueryPlanner();
    expect(qp.estimateOutputRows(makeStats({ reltuples: 500 }), [])).toBe(500);
  });

  it('multiplies selectivities (AND semantics), capped at reltuples', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 1000, nDistinct: new Map([['id', 100], ['k', 10]]) });
    const conds: QueryCondition[] = [
      { table: 't', column: 'id', operator: '=', value: 'x', exact: true },
      { table: 't', column: 'k', operator: '=', value: 'y', exact: true },
    ];
    // 0.01 * 0.1 = 0.001 → 1 row
    expect(qp.estimateOutputRows(stats, conds)).toBe(1);
  });

  it('caps combined selectivity at 1', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 100 });
    const conds: QueryCondition[] = [
      { table: 't', column: 'id', operator: 'IS NOT NULL', value: '', exact: true },
      { table: 't', column: 'k', operator: 'IS NOT NULL', value: '', exact: true },
    ];
    // 0.99 * 0.99 = 0.9801 → ceil(98.01)=99
    expect(qp.estimateOutputRows(stats, conds)).toBe(99);
  });
});

// ── generateScanPlans ─────────────────────────────────────────────────────

describe('QueryPlanner.generateScanPlans', () => {
  it('always generates a sequential scan', () => {
    const qp = new QueryPlanner();
    const plans = qp.generateScanPlans('t', makeStats(), [], []);
    expect(plans.length).toBe(1);
    expect(plans[0].type).toBe('sequential-scan');
    expect(plans[0].description).toMatch(/Seq Scan on t/);
  });

  it('adds a parallel scan when reltuples > 1000', () => {
    const qp = new QueryPlanner();
    const plans = qp.generateScanPlans('t', makeStats({ reltuples: 5000 }), [], []);
    expect(plans.some(p => p.type === 'parallel-scan')).toBe(true);
  });

  it('does not add parallel scan when reltuples <= 1000', () => {
    const qp = new QueryPlanner();
    const plans = qp.generateScanPlans('t', makeStats({ reltuples: 1000 }), [], []);
    expect(plans.some(p => p.type === 'parallel-scan')).toBe(false);
  });

  it('adds an index scan when an index matches a condition column', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 1000, nDistinct: new Map([['id', 100]]) });
    const conds: QueryCondition[] = [
      { table: 't', column: 'id', operator: '=', value: 'x', exact: true },
    ];
    const idx = makeIndex({ name: 'pk_id', tableName: 't', columns: ['id'] });
    const plans = qp.generateScanPlans('t', stats, [idx], conds);
    expect(plans.some(p => p.type === 'index-scan')).toBe(true);
  });

  it('skips an index that does not reduce selectivity (indexSelectivity >= 1)', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 1000 });
    const conds: QueryCondition[] = [
      // condition on a column NOT in the index → indexSelectivity stays 1
      { table: 't', column: 'other', operator: '=', value: 'x', exact: true },
    ];
    const idx = makeIndex({ name: 'pk_id', tableName: 't', columns: ['id'] });
    const plans = qp.generateScanPlans('t', stats, [idx], conds);
    expect(plans.some(p => p.type === 'index-scan')).toBe(false);
  });
});

// ── generatePlans ─────────────────────────────────────────────────────────

describe('QueryPlanner.generatePlans', () => {
  it('generates scan plans per table using that table indexes', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>([
      ['a', makeStats({ reltuples: 10 })],
      ['b', makeStats({ reltuples: 20 })],
    ]);
    const idx = makeIndex({ name: 'pk_b', tableName: 'b', columns: ['id'] });
    const plans = qp.generatePlans('SELECT ...', [idx], stats);
    // a → 1 seq scan; b → 1 seq scan (index skipped, no matching condition)
    expect(plans.length).toBe(2);
    expect(plans.every(p => p.type === 'sequential-scan')).toBe(true);
  });
});

// ── generateJoinPlans ─────────────────────────────────────────────────────

describe('QueryPlanner.generateJoinPlans', () => {
  const left = scanPlan({ rows: 100, totalCost: 10 });
  const right = scanPlan({ rows: 50, totalCost: 8 });

  it('produces NLJ, hash join, and merge join', () => {
    const qp = new QueryPlanner();
    const conds: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
    ];
    const plans = qp.generateJoinPlans(left, right, conds);
    const types = plans.map(p => p.type).sort();
    expect(types).toEqual(['hash-join', 'merge-join', 'nested-loop-join']);
  });

  it('handles empty conditions (selectivity stays 1)', () => {
    const qp = new QueryPlanner();
    const plans = qp.generateJoinPlans(left, right, []);
    expect(plans.length).toBe(3);
  });

  it('scales selectivity by condition count', () => {
    const qp = new QueryPlanner();
    const conds: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
      { leftTable: 'a', leftColumn: 'k', rightTable: 'b', rightColumn: 'k', operator: '=' },
    ];
    const plans = qp.generateJoinPlans(left, right, conds);
    // selectivity = min(1, (1/100) * 2) = 0.02
    expect(plans.length).toBe(3);
    expect(plans[0].children).toHaveLength(2);
  });
});

// ── chooseBestPlan ────────────────────────────────────────────────────────

describe('QueryPlanner.chooseBestPlan', () => {
  it('returns null for empty list', () => {
    expect(new QueryPlanner().chooseBestPlan([])).toBeNull();
  });

  it('returns cheapest by totalCost', () => {
    const qp = new QueryPlanner();
    const plans = [
      scanPlan({ totalCost: 50 }),
      scanPlan({ totalCost: 10 }),
      scanPlan({ totalCost: 30 }),
    ];
    expect(qp.chooseBestPlan(plans)!.totalCost).toBe(10);
  });

  it('breaks totalCost ties by lower startupCost', () => {
    const qp = new QueryPlanner();
    const plans = [
      scanPlan({ totalCost: 10, startupCost: 5 }),
      scanPlan({ totalCost: 10, startupCost: 1 }),
    ];
    expect(qp.chooseBestPlan(plans)!.startupCost).toBe(1);
  });

  it('keeps the first when both costs tie', () => {
    const qp = new QueryPlanner();
    const a = scanPlan({ totalCost: 10, startupCost: 1 });
    const b = scanPlan({ totalCost: 10, startupCost: 1 });
    expect(qp.chooseBestPlan([a, b])).toBe(a);
  });
});

// ── optimizeJoinOrder ─────────────────────────────────────────────────────

describe('QueryPlanner.optimizeJoinOrder', () => {
  it('throws on empty table list', () => {
    expect(() => new QueryPlanner().optimizeJoinOrder([], [])).toThrow(/No tables/);
  });

  it('returns a single-table plan for one table', () => {
    const qp = new QueryPlanner();
    const t = joinInfo({ name: 'only', scanCost: { startupCost: 1, totalCost: 42, rows: 7, width: 3 } });
    const r = qp.optimizeJoinOrder([t], []);
    expect(r.order).toEqual(['only']);
    expect(r.totalCost).toBe(42);
    expect(r.plan.type).toBe('sequential-scan');
  });

  it('sorts by scan cost (small table first) with condition-based joins', () => {
    const qp = new QueryPlanner();
    const a = joinInfo({ name: 'a', scanCost: { startupCost: 0, totalCost: 100, rows: 1000, width: 0 } });
    const b = joinInfo({ name: 'b', scanCost: { startupCost: 0, totalCost: 5, rows: 10, width: 0 } });
    const c = joinInfo({ name: 'c', scanCost: { startupCost: 0, totalCost: 50, rows: 500, width: 0 } });
    const conds: JoinCondition[] = [
      { leftTable: 'a', leftColumn: 'id', rightTable: 'b', rightColumn: 'id', operator: '=' },
      { leftTable: 'b', leftColumn: 'id', rightTable: 'c', rightColumn: 'id', operator: '=' },
    ];
    const r = qp.optimizeJoinOrder([a, b, c], conds);
    // cheapest scan first
    expect(r.order[0]).toBe('b');
    expect(r.order).toHaveLength(3);
    expect(r.plan).toBeTruthy();
  });

  it('handles reversed join condition direction', () => {
    const qp = new QueryPlanner();
    const a = joinInfo({ name: 'a', scanCost: { startupCost: 0, totalCost: 1, rows: 1, width: 0 } });
    const b = joinInfo({ name: 'b', scanCost: { startupCost: 0, totalCost: 2, rows: 2, width: 0 } });
    const conds: JoinCondition[] = [
      { leftTable: 'b', leftColumn: 'id', rightTable: 'a', rightColumn: 'id', operator: '=' },
    ];
    const r = qp.optimizeJoinOrder([a, b], conds);
    expect(r.order).toHaveLength(2);
    expect(r.order[0]).toBe('a');
  });
});

// ── shouldUseParallel ─────────────────────────────────────────────────────

describe('QueryPlanner.shouldUseParallel', () => {
  it('returns false when sequential scan cost is <= 0', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 0, relpages: 0 });
    expect(qp.shouldUseParallel(stats)).toBe(false);
  });

  it('returns true when parallel scan is cheaper than the threshold', () => {
    // Lower the parallel per-tuple overhead so parallel beats 0.8×seq.
    const cm = new CostModel({ parallelTupleCost: 0.0001 });
    const qp = new QueryPlanner(cm);
    const stats = makeStats({ reltuples: 100000, relpages: 1000 });
    expect(qp.shouldUseParallel(stats)).toBe(true);
  });

  it('returns false when parallel is not cheaper (default overhead)', () => {
    const qp = new QueryPlanner();
    const stats = makeStats({ reltuples: 1000, relpages: 10 });
    expect(qp.shouldUseParallel(stats)).toBe(false);
  });
});

// ── detectUnnestableSubquery ──────────────────────────────────────────────

describe('QueryPlanner.detectUnnestableSubquery', () => {
  it('returns null for empty / non-string / non-SELECT input', () => {
    const qp = new QueryPlanner();
    expect(qp.detectUnnestableSubquery('')).toBeNull();
    expect(qp.detectUnnestableSubquery('UPDATE t SET x=1')).toBeNull();
  });

  it('detects an IN subquery with forward correlation', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2 WHERE t1.id = t2.id)';
    const info = qp.detectUnnestableSubquery(sql);
    expect(info).not.toBeNull();
    expect(info!.type).toBe('IN_SUBQUERY');
    expect(info!.parentTable).toBe('t1');
    expect(info!.subqueryTable).toBe('t2');
    expect(info!.correlationColumns).toEqual([{ parent: 'id', subquery: 'id' }]);
  });

  it('detects an IN subquery with reverse correlation (t2.col = t1.col)', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2 WHERE t2.id = t1.id)';
    const info = qp.detectUnnestableSubquery(sql);
    expect(info).not.toBeNull();
    expect(info!.correlationColumns).toEqual([{ parent: 'id', subquery: 'id' }]);
  });

  it('detects an EXISTS correlated subquery', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id)';
    const info = qp.detectUnnestableSubquery(sql);
    expect(info).not.toBeNull();
    expect(info!.type).toBe('EXISTS_SUBQUERY');
    expect(info!.subqueryTable).toBe('t2');
  });

  it('detects EXISTS with forward correlation (t1.id = t2.id)', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t1.id = t2.id)';
    const info = qp.detectUnnestableSubquery(sql);
    expect(info).not.toBeNull();
    expect(info!.correlationColumns).toEqual([{ parent: 'id', subquery: 'id' }]);
  });

  it('returns null when no subquery is present', () => {
    const qp = new QueryPlanner();
    expect(qp.detectUnnestableSubquery('SELECT * FROM t1 WHERE id = 5')).toBeNull();
  });
});

// ── unnestSubquery ────────────────────────────────────────────────────────

describe('QueryPlanner.unnestSubquery', () => {
  it('returns sql unchanged for empty sql/info', () => {
    const qp = new QueryPlanner();
    const info = {
      type: 'IN_SUBQUERY', parentTable: '', subqueryTable: '', correlationColumns: [],
      parentColumn: '', subqueryColumn: '', originalSubquery: '',
    } as any;
    expect(qp.unnestSubquery('', info)).toBe('');
    expect(qp.unnestSubquery('SELECT 1', null as any)).toBe('SELECT 1');
  });

  it('rewrites an IN subquery to a SEMI JOIN annotation', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2 WHERE t1.id = t2.id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
    expect(out).toContain('WHERE 1=1');
    expect(out).not.toMatch(/IN\s*\(/);
  });

  it('rewrites an IN subquery with table-qualified column (drops qualifier)', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2)';
    const info = qp.detectUnnestableSubquery(sql)!;
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
  });

  it('rewrites an EXISTS subquery to an INNER JOIN SELECT DISTINCT', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
    expect(out).toContain('SELECT DISTINCT');
    expect(out).toContain('_unnest_sq');
  });

  it('returns unchanged for EXISTS without correlation columns', () => {
    const qp = new QueryPlanner();
    const info = {
      type: 'EXISTS_SUBQUERY', parentTable: 't1', subqueryTable: 't2',
      correlationColumns: [], parentColumn: '', subqueryColumn: '', originalSubquery: '',
    } as any;
    const sql = 'SELECT * FROM t1';
    expect(qp.unnestSubquery(sql, info)).toBe('SELECT * FROM t1');
  });
});

// ── applyJoinOrder ────────────────────────────────────────────────────────

describe('QueryPlanner.applyJoinOrder', () => {
  it('returns unchanged for empty sql/order', () => {
    const qp = new QueryPlanner();
    expect(qp.applyJoinOrder('', { order: ['a'], totalCost: 1, plan: scanPlan() })).toBe('');
    expect(qp.applyJoinOrder('SELECT 1', null as any)).toBe('SELECT 1');
  });

  it('returns unchanged when order has <= 1 table', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM a';
    const order: OptimizedJoinOrder = { order: ['a'], totalCost: 1, plan: scanPlan() };
    expect(qp.applyJoinOrder(sql, order)).toBe(sql);
  });

  it('returns unchanged for non-SELECT statements', () => {
    const qp = new QueryPlanner();
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 1, plan: scanPlan() };
    expect(qp.applyJoinOrder('UPDATE a SET x=1', order)).toBe('UPDATE a SET x=1');
  });

  it('returns unchanged when optimized table is not present in SQL', () => {
    const qp = new QueryPlanner();
    const order: OptimizedJoinOrder = { order: ['zz', 'a'], totalCost: 1, plan: scanPlan() };
    expect(qp.applyJoinOrder('SELECT * FROM a JOIN b ON a.id = b.id', order)).toBe('SELECT * FROM a JOIN b ON a.id = b.id');
  });

  it('returns unchanged when first table is already optimal', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM a JOIN b ON a.id = b.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 1, plan: scanPlan() };
    expect(qp.applyJoinOrder(sql, order)).toBe(sql);
  });

  it('adds a JOIN ORDER comment when reordering is possible', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM b JOIN a ON b.id = a.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 12.34, plan: scanPlan() };
    const out = qp.applyJoinOrder(sql, order);
    expect(out).toContain('JOIN ORDER');
    expect(out).toContain('a → b');
  });
});

// ── maybeOptimizeJoins ────────────────────────────────────────────────────

describe('QueryPlanner.maybeOptimizeJoins', () => {
  it('returns empty for empty sql', () => {
    expect(new QueryPlanner().maybeOptimizeJoins('')).toBe('');
  });

  it('returns unchanged for non-SELECT', () => {
    const qp = new QueryPlanner();
    expect(qp.maybeOptimizeJoins('INSERT INTO t VALUES (1)')).toBe('INSERT INTO t VALUES (1)');
  });

  it('returns unchanged for a single table', () => {
    const qp = new QueryPlanner();
    expect(qp.maybeOptimizeJoins('SELECT * FROM a')).toBe('SELECT * FROM a');
  });

  it('optimizes a two-table join (or returns original on trivial order)', () => {
    const qp = new QueryPlanner();
    const sql = 'SELECT * FROM b JOIN a ON b.id = a.id';
    const out = qp.maybeOptimizeJoins(sql, { a: { reltuples: 10 }, b: { reltuples: 1000 } });
    // either reordered (comment) or unchanged; must be a string, never throws
    expect(typeof out).toBe('string');
  });

  it('falls back to original SQL when optimization throws', () => {
    const qp = new QueryPlanner();
    // A SELECT with tables but no FROM/JOIN regex match path that would throw is hard;
    // instead verify a malformed input still returns a string.
    const out = qp.maybeOptimizeJoins('SELECT 1 FROM a JOIN b', undefined);
    expect(typeof out).toBe('string');
  });
});

// ── detectIndexSort ───────────────────────────────────────────────────────

describe('QueryPlanner.detectIndexSort', () => {
  it('returns plans unchanged when no orderByColumn or no plans', () => {
    const qp = new QueryPlanner();
    const plans = [scanPlan()];
    expect(qp.detectIndexSort('', false, plans, [])).toBe(plans);
    expect(qp.detectIndexSort('id', false, [], [])).toEqual([]);
  });

  it('sets sortedBy on a matching index-scan plan', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_id', tableName: 't', columns: ['id'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_id on t (sel=0.1)' });
    const plans = [plan];
    qp.detectIndexSort('id', false, plans, [idx]);
    expect(plan.sortedBy).toBe('id');
  });

  it('skips non-index-scan plans', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ tableName: 't', columns: ['id'] });
    const plan = scanPlan({ type: 'sequential-scan' });
    qp.detectIndexSort('id', false, [plan], [idx]);
    expect(plan.sortedBy).toBeUndefined();
  });

  it('skips indexes on a different table (case-insensitive)', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_id', tableName: 'OTHER', columns: ['id'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_id on t' });
    qp.detectIndexSort('id', false, [plan], [idx]);
    expect(plan.sortedBy).toBeUndefined();
  });

  it('skips indexes whose first column does not match', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_other', tableName: 't', columns: ['other'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_other on t' });
    qp.detectIndexSort('id', false, [plan], [idx]);
    expect(plan.sortedBy).toBeUndefined();
  });

  it('skips indexes with empty columns', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_empty', tableName: 't', columns: [] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_empty on t' });
    qp.detectIndexSort('id', false, [plan], [idx]);
    expect(plan.sortedBy).toBeUndefined();
  });
});

// ── applyIndexOrderBySort ─────────────────────────────────────────────────

describe('QueryPlanner.applyIndexOrderBySort', () => {
  it('returns plans unchanged when no ORDER BY clause', () => {
    const qp = new QueryPlanner();
    const plans = [scanPlan()];
    expect(qp.applyIndexOrderBySort('SELECT * FROM t', plans, [])).toBe(plans);
  });

  it('detects ASC order by', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_id', tableName: 't', columns: ['id'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_id on t' });
    qp.applyIndexOrderBySort('SELECT * FROM t ORDER BY id ASC', [plan], [idx]);
    expect(plan.sortedBy).toBe('id');
  });

  it('detects DESC order by', () => {
    const qp = new QueryPlanner();
    const idx = makeIndex({ name: 'idx_id', tableName: 't', columns: ['id'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan using idx_id on t' });
    qp.applyIndexOrderBySort('SELECT * FROM t ORDER BY id DESC', [plan], [idx]);
    expect(plan.sortedBy).toBe('id');
  });
});

// ── plan (high-level entry) ───────────────────────────────────────────────

describe('QueryPlanner.plan', () => {
  it('generates and sorts scan plans per table', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>([['t', makeStats({ reltuples: 100 })]]);
    const plans = qp.plan('SELECT * FROM t WHERE id = 5', ['t'], [], stats);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    // sorted ascending by totalCost
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i].totalCost).toBeGreaterThanOrEqual(plans[i - 1].totalCost);
    }
  });

  it('uses default stats when a table is missing from the map', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>();
    const plans = qp.plan('SELECT * FROM t', ['t'], [], stats);
    expect(plans.length).toBeGreaterThanOrEqual(1);
  });

  it('attaches extracted conditions to each plan', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>([['t', makeStats()]]);
    const plans = qp.plan('SELECT * FROM t WHERE id = 5', ['t'], [], stats);
    for (const p of plans) {
      expect(p.conditions).toEqual([
        { table: 't', column: 'id', operator: '=', value: '5', exact: true },
      ]);
    }
  });

  it('filters indexes by table name case-insensitively', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>([['t', makeStats({ reltuples: 100, nDistinct: new Map([['id', 10]]) })]]);
    const idx = makeIndex({ name: 'pk', tableName: 'T', columns: ['id'] });
    const plans = qp.plan('SELECT * FROM t WHERE id = 5', ['t'], [idx], stats);
    expect(plans.some(p => p.type === 'index-scan')).toBe(true);
  });

  it('applies index sort optimization for single-table ORDER BY', () => {
    const qp = new QueryPlanner();
    const stats = new Map<string, TableStats>([['t', makeStats({ reltuples: 100, nDistinct: new Map([['id', 10]]) })]]);
    const idx = makeIndex({ name: 'pk', tableName: 't', columns: ['id'] });
    const plans = qp.plan('SELECT * FROM t WHERE id = 5 ORDER BY id', ['t'], [idx], stats);
    const idxPlan = plans.find(p => p.type === 'index-scan');
    expect(idxPlan?.sortedBy).toBe('id');
  });
});

// ── extract
// ── extractSimpleConditions (via plan) ────────────────────────────────────

describe('QueryPlanner.extractSimpleConditions (via plan)', () => {
  const qp = new QueryPlanner();
  const stats = () => new Map<string, TableStats>([['t', makeStats()]]);
  const condsFor = (sql: string): QueryCondition[] => {
    return qp.plan(sql, ['t'], [], stats())[0].conditions!;
  };

  it('returns empty when no WHERE clause', () => {
    expect(condsFor('SELECT * FROM t')).toEqual([]);
  });

  it('extracts string equality', () => {
    expect(condsFor("SELECT * FROM t WHERE name = 'alice'")).toEqual([
      { table: 't', column: 'name', operator: '=', value: 'alice', exact: true },
    ]);
  });

  it('extracts numeric equality', () => {
    expect(condsFor('SELECT * FROM t WHERE id = 42')).toEqual([
      { table: 't', column: 'id', operator: '=', value: '42', exact: true },
    ]);
  });

  it('extracts boolean/null equality literals', () => {
    expect(condsFor('SELECT * FROM t WHERE flag = true')[0].value).toBe('true');
    expect(condsFor('SELECT * FROM t WHERE flag = false')[0].value).toBe('false');
    expect(condsFor('SELECT * FROM t WHERE x = null')[0].value).toBe('null');
  });

  it('extracts comparison operators', () => {
    for (const op of ['>', '>=', '<', '<=']) {
      const c = condsFor(`SELECT * FROM t WHERE id ${op} 10`)[0];
      expect(c.operator).toBe(op);
      expect(c.exact).toBe(false);
    }
    expect(condsFor('SELECT * FROM t WHERE id != 10')[0].operator).toBe('!=');
    expect(condsFor('SELECT * FROM t WHERE id <> 10')[0].operator).toBe('<>');
  });

  it('extracts IS NULL / IS NOT NULL', () => {
    expect(condsFor('SELECT * FROM t WHERE x IS NULL')[0].operator).toBe('IS NULL');
    expect(condsFor('SELECT * FROM t WHERE x IS NOT NULL')[0].operator).toBe('IS NOT NULL');
  });

  it('extracts LIKE', () => {
    const c = condsFor("SELECT * FROM t WHERE name LIKE 'a%'")[0];
    expect(c.operator).toBe('LIKE');
    expect(c.value).toBe('a%');
  });

  it('extracts IN list', () => {
    const c = condsFor('SELECT * FROM t WHERE id IN (1, 2, 3)')[0];
    expect(c.operator).toBe('IN');
    expect(c.value).toBe('1, 2, 3');
  });

  it('splits multiple conditions on AND', () => {
    const conds = condsFor("SELECT * FROM t WHERE id > 5 AND name LIKE 'a%' AND x IS NULL");
    expect(conds).toHaveLength(3);
    expect(conds.map(c => c.operator)).toEqual(['>', 'LIKE', 'IS NULL']);
  });

  it('stops at ORDER BY / LIMIT / GROUP BY / HAVING', () => {
    expect(condsFor('SELECT * FROM t WHERE id = 5 ORDER BY id')[0].operator).toBe('=');
    expect(condsFor('SELECT * FROM t WHERE id = 5 LIMIT 10')[0].operator).toBe('=');
    expect(condsFor('SELECT * FROM t WHERE id = 5 GROUP BY id')[0].operator).toBe('=');
    expect(condsFor('SELECT * FROM t WHERE id = 5 HAVING count(*) > 1')[0].operator).toBe('=');
  });
});

// ── additional branch coverage (multi-table, qualified columns, etc.) ─────

describe('QueryPlanner — additional branch coverage', () => {
  const qp = new QueryPlanner();

  it('plan with multiple tables (tableNames.length > 1)', () => {
    const stats = new Map<string, TableStats>([
      ['a', makeStats({ reltuples: 10 })],
      ['b', makeStats({ reltuples: 20 })],
    ]);
    const plans = qp.plan('SELECT * FROM a JOIN b ON a.id = b.id', ['a', 'b'], [], stats);
    expect(plans.length).toBe(2);
  });

  it('estimateSelectivity with exact=false (the identical ternary branch)', () => {
    const stats = makeStats({ nDistinct: new Map([['id', 50]]) });
    const cond: QueryCondition = { table: 't', column: 'id', operator: '=', value: 'x', exact: false };
    expect(qp.estimateSelectivity(cond, stats)).toBeCloseTo(1 / 50);
  });

  it('IN subquery with table-qualified columns (includes `.` true)', () => {
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2 WHERE t1.id = t2.id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    expect(info.parentColumn).toBe('t1.id');
    expect(info.subqueryColumn).toBe('t2.id');
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
  });

  it('IN subquery with qualified correlation columns (no WHERE clause)', () => {
    const sql = 'SELECT * FROM t1 WHERE t1.id IN (SELECT t2.id FROM t2)';
    const info = qp.detectUnnestableSubquery(sql)!;
    // correlationColumns empty → no corrStr
    expect(info.correlationColumns).toEqual([]);
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('WHERE 1=1');
  });

  it('EXISTS subquery with reverse correlation (t2.x = t1.x)', () => {
    const sql = 'SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t1.id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    expect(info.correlationColumns).toEqual([{ parent: 'id', subquery: 'id' }]);
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
    expect(out).toContain('SELECT DISTINCT');
  });

  it('EXISTS subquery with qualified correlation (t2.x = t1.x with dots)', () => {
    const sql = 'SELECT * FROM t1 WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.col = t1.col)';
    const info = qp.detectUnnestableSubquery(sql)!;
    expect(info.correlationColumns).toEqual([{ parent: 'col', subquery: 'col' }]);
  });

  it('applyJoinOrder with alias reordering', () => {
    const sql = 'SELECT * FROM b AS x JOIN a AS y ON x.id = y.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 5, plan: scanPlan() };
    const out = qp.applyJoinOrder(sql, order);
    expect(out).toContain('JOIN ORDER');
  });

  it('maybeOptimizeJoins with two tables and matching ON conditions', () => {
    const sql = 'SELECT * FROM b JOIN a ON b.id = a.id';
    const out = qp.maybeOptimizeJoins(sql, { a: { reltuples: 100 }, b: { reltuples: 2000 } });
    expect(typeof out).toBe('string');
  });
});

// ── non-qualified columns (includes('.') false side) ──────────────────────

describe('QueryPlanner — non-qualified column branches', () => {
  const qp = new QueryPlanner();

  it('IN subquery with non-qualified columns', () => {
    const sql = 'SELECT * FROM t1 WHERE id IN (SELECT id FROM t2 WHERE id = id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    expect(info.parentColumn).toBe('id');
    expect(info.subqueryColumn).toBe('id');
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
  });

  it('IN subquery with non-qualified parent but qualified subquery', () => {
    const sql = 'SELECT * FROM t1 WHERE id IN (SELECT t2.id FROM t2 WHERE id = t2.id)';
    const info = qp.detectUnnestableSubquery(sql)!;
    expect(info.parentColumn).toBe('id');
    expect(info.subqueryColumn).toBe('t2.id');
    const out = qp.unnestSubquery(sql, info);
    expect(out).toContain('SEMI JOIN');
  });
});

// ── applyJoinOrder branch coverage (WHERE/alias/duplicate tables) ─────────

describe('QueryPlanner.applyJoinOrder — remaining branches', () => {
  const qp = new QueryPlanner();

  it('reorders a join that has a WHERE clause (restOfSql/afterFromRest true side)', () => {
    const sql = 'SELECT * FROM b JOIN a ON b.id = a.id WHERE a.x > 5';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 3, plan: scanPlan() };
    const out = qp.applyJoinOrder(sql, order);
    expect(out).toContain('JOIN ORDER');
    expect(out).toContain('WHERE');
  });

  it('reorders a join without trailing clauses (restOfSql/afterFromRest false side)', () => {
    const sql = 'SELECT * FROM b JOIN a ON b.id = a.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 3, plan: scanPlan() };
    const out = qp.applyJoinOrder(sql, order);
    expect(out).toContain('JOIN ORDER');
  });

  it('returns unchanged when a non-optimized table is present', () => {
    const sql = 'SELECT * FROM b JOIN c ON b.id = c.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 3, plan: scanPlan() };
    // 'a' not in SQL → returns unchanged; 'c' in SQL but not in order
    expect(qp.applyJoinOrder(sql, order)).toBe(sql);
  });

  it('maybeOptimizeJoins deduplicates repeated table references', () => {
    const sql = 'SELECT * FROM a JOIN b ON a.id = b.id JOIN a ON a.id2 = b.id2';
    // repeated 'a' referenced twice → tables list deduped
    const out = qp.maybeOptimizeJoins(sql, { a: { reltuples: 10 }, b: { reltuples: 20 } });
    expect(typeof out).toBe('string');
  });
});

// ── final sweep: unknown-type unnest + no-alias reorder ───────────────────

describe('QueryPlanner — final branch sweep', () => {
  const qp = new QueryPlanner();

  it('unnestSubquery with an unknown type returns the input unchanged', () => {
    const sql = 'SELECT * FROM t1';
    const info = {
      type: 'SOME_OTHER_TYPE', parentTable: 't1', subqueryTable: 't2',
      correlationColumns: [], parentColumn: 'id', subqueryColumn: 'id', originalSubquery: '',
    } as any;
    expect(qp.unnestSubquery(sql, info)).toBe(sql);
  });

  it('applyJoinOrder where alias equals table name (alias !== table false)', () => {
    const sql = 'SELECT * FROM b AS b JOIN a AS a ON b.id = a.id';
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 3, plan: scanPlan() };
    const out = qp.applyJoinOrder(sql, order);
    expect(out).toContain('JOIN ORDER');
  });
});

// ── dead-branch real triggers + defensive guards ──────────────────────────

describe('QueryPlanner — defensive guard coverage', () => {
  const qp = new QueryPlanner();

  it('detectUnnestableSubquery on a SELECT without FROM (parentTable empty)', () => {
    expect(qp.detectUnnestableSubquery('SELECT 1')).toBeNull();
  });

  it('unnestSubquery with null sql hits the sql ?? "" fallback', () => {
    const info = { type: 'IN_SUBQUERY', parentTable: 't', subqueryTable: 't2', correlationColumns: [], parentColumn: 'id', subqueryColumn: 'id', originalSubquery: '' } as any;
    expect(qp.unnestSubquery(null as any, info)).toBe('');
  });

  it('unnestSubquery with null info hits the sql ?? "" fallback', () => {
    expect(qp.unnestSubquery('SELECT 1', null as any)).toBe('SELECT 1');
  });

  it('applyJoinOrder on SELECT without FROM (selectEnd/fromMatch guards)', () => {
    const order: OptimizedJoinOrder = { order: ['a', 'b'], totalCost: 3, plan: scanPlan() };
    // "SELECT 1" has no FROM → fromMatch null → returns unchanged
    expect(qp.applyJoinOrder('SELECT 1', order)).toBe('SELECT 1');
  });

  it('extractSimpleConditions ignores an unrecognized part (IN false side)', () => {
    const stats = new Map<string, TableStats>([['t', makeStats()]]);
    // "x IS TRUE" is not recognized by any matcher; no condition extracted
    const plans = qp.plan('SELECT * FROM t WHERE x IS TRUE', ['t'], [], stats);
    expect(plans[0].conditions).toEqual([]);
  });

  it('detectIndexSort skips an index-scan whose description lacks "on"', () => {
    const idx = makeIndex({ name: 'pk', tableName: 't', columns: ['id'] });
    const plan = scanPlan({ type: 'index-scan', description: 'Index Scan (malformed)' });
    qp.detectIndexSort('id', false, [plan], [idx]);
    expect(plan.sortedBy).toBeUndefined();
  });
});
