/**
 * CostModel — PostgreSQL-style cost estimation tests.
 *
 * Covers seq/index/parallel/bitmap/index-only scan cost math, join costs
 * (nested-loop/hash/merge), sort and aggregate costs, GUC-backed factor
 * loading, and dynamic factor mutation/validation.
 */
import { describe, it, expect } from 'vitest';
import { CostModel } from '../query/CostModel';
import { GucSystem } from '../core/GucSystem';
import type { TableStats, ScanCost } from '../query/CostModel';

// PostgreSQL 16 default cost factors (documented in the module header).
const SEQ_PAGE_COST = 1.0;
const RANDOM_PAGE_COST = 4.0;
const CPU_TUPLE_COST = 0.01;
const CPU_INDEX_TUPLE_COST = 0.005;
const CPU_OPERATOR_COST = 0.0025;
const PARALLEL_TUPLE_COST = 0.1;
const BITMAP_PAGE_COST = 4.0;
const VISIBILITY_MAP_FRACTION = 0.1;

const DEFAULT_FACTORS = {
  seqPageCost: SEQ_PAGE_COST,
  randomPageCost: RANDOM_PAGE_COST,
  cpuTupleCost: CPU_TUPLE_COST,
  cpuIndexTupleCost: CPU_INDEX_TUPLE_COST,
  cpuOperatorCost: CPU_OPERATOR_COST,
  parallelTupleCost: PARALLEL_TUPLE_COST,
  bitmapPageCost: BITMAP_PAGE_COST,
  visibilityMapFraction: VISIBILITY_MAP_FRACTION,
};

function stats(overrides?: Partial<TableStats>): TableStats {
  return {
    reltuples: 1000,
    relpages: 100,
    nDistinct: new Map([['region', 10]]),
    correlation: new Map(),
    ...overrides,
  };
}

describe('CostModel scan costs', () => {
  it('computes sequential scan cost from pages and tuples', () => {
    const m = new CostModel();
    const c = m.seqScanCost(stats());
    expect(c.startupCost).toBe(0);
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.seqPageCost * 100 + DEFAULT_FACTORS.cpuTupleCost * 1000,
    );
    expect(c.rows).toBe(1000);
  });

  it('computes index scan cost with clamped selectivity', () => {
    const m = new CostModel();
    const c = m.indexScanCost(stats(), 0.1);
    expect(c.startupCost).toBeCloseTo(DEFAULT_FACTORS.cpuOperatorCost);
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.cpuOperatorCost +
        DEFAULT_FACTORS.randomPageCost * 10 +
        DEFAULT_FACTORS.cpuIndexTupleCost * 100 +
        DEFAULT_FACTORS.cpuTupleCost * 100,
    );
    expect(c.rows).toBeCloseTo(100);
  });

  it('clamps out-of-range selectivity to [0,1]', () => {
    const m = new CostModel();
    const neg = m.indexScanCost(stats(), -1);
    expect(neg.totalCost).toBe(m.indexScanCost(stats(), 0).totalCost);

    const over = m.indexScanCost(stats(), 5);
    expect(over.totalCost).toBe(m.indexScanCost(stats(), 1).totalCost);
  });

  it('computes parallel scan cost dividing by worker count', () => {
    const m = new CostModel();
    const c = m.parallelScanCost(stats(), 4);
    const seq = DEFAULT_FACTORS.seqPageCost * 100;
    const cpu = DEFAULT_FACTORS.cpuTupleCost * 1000;
    const overhead = DEFAULT_FACTORS.parallelTupleCost * 1000;
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.cpuOperatorCost + (seq + cpu + overhead) / 4,
    );
  });

  it('clamps worker count to at least 1', () => {
    const m = new CostModel();
    const c = m.parallelScanCost(stats(), 0);
    // nWorkers floored to 1 → no division benefit.
    expect(c.totalCost).toBe(m.parallelScanCost(stats(), 1).totalCost);
  });

  it('computes bitmap scan cost over index scan total', () => {
    const m = new CostModel();
    const c = m.bitmapScanCost(stats(), 0.1);
    const indexTotal = m.indexScanCost(stats(), 0.1).totalCost;
    const bitmapPages = 0.1 * 100; // selectivity × relpages
    const bitmapTuples = 0.1 * 1000; // selectivity × reltuples
    expect(c.totalCost).toBeCloseTo(
      indexTotal +
        DEFAULT_FACTORS.bitmapPageCost * bitmapPages +
        DEFAULT_FACTORS.cpuTupleCost * bitmapTuples,
    );
  });

  it('computes index-only scan cost using the visibility map fraction', () => {
    const m = new CostModel();
    const c = m.indexOnlyScanCost(stats(), 0.1);
    const vmPages = 0.1 * 100 * DEFAULT_FACTORS.visibilityMapFraction;
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.cpuOperatorCost +
        DEFAULT_FACTORS.randomPageCost * vmPages +
        DEFAULT_FACTORS.cpuIndexTupleCost * 100,
    );
    expect(c.rows).toBeCloseTo(100);
  });
});

describe('CostModel join costs', () => {
  const outer: ScanCost = { startupCost: 1, totalCost: 10, rows: 100, width: 8 };
  const inner: ScanCost = { startupCost: 2, totalCost: 20, rows: 50, width: 4 };

  it('computes nested-loop join cost', () => {
    const m = new CostModel();
    const c = m.nestedLoopCost(outer, inner, 1);
    expect(c.startupCost).toBeCloseTo(3);
    expect(c.totalCost).toBeCloseTo(10 + 100 * 20);
    expect(c.rows).toBeCloseTo(5000);
    expect(c.width).toBe(12);
  });

  it('applies join selectivity to row estimate', () => {
    const m = new CostModel();
    const c = m.nestedLoopCost(outer, inner, 0.5);
    expect(c.rows).toBeCloseTo(2500);
  });

  it('computes hash join cost', () => {
    const m = new CostModel();
    const c = m.hashJoinCost(outer, inner, 1);
    expect(c.startupCost).toBeCloseTo(3 + DEFAULT_FACTORS.cpuOperatorCost);
    expect(c.totalCost).toBeCloseTo(
      3 + DEFAULT_FACTORS.cpuOperatorCost + 10 + 20,
    );
  });

  it('computes merge join cost including sort costs', () => {
    const m = new CostModel();
    const c = m.mergeJoinCost(outer, inner, { outerSort: 5, innerSort: 7 }, 1);
    expect(c.startupCost).toBeCloseTo(1 + 2 + 5 + 7);
    expect(c.totalCost).toBeCloseTo(1 + 2 + 5 + 7 + 10 + 20);
  });
});

describe('CostModel sort and aggregate costs', () => {
  it('computes sort cost as O(n log n)', () => {
    const m = new CostModel();
    const c = m.sortCost(stats());
    const n = 1000;
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.cpuOperatorCost + DEFAULT_FACTORS.cpuOperatorCost * n * Math.log2(n),
    );
  });

  it('clamps sort cost to at least one row', () => {
    const m = new CostModel();
    const c = m.sortCost(stats({ reltuples: 0 }));
    // n = max(1, 0) = 1, so compareCost = cpuOperatorCost * 1 * log2(1) = 0.
    expect(c.totalCost).toBeCloseTo(DEFAULT_FACTORS.cpuOperatorCost);
  });

  it('computes a simple aggregate cost with no grouping', () => {
    const m = new CostModel();
    const c = m.aggregateCost(stats());
    // groupSize = 1 (no group clauses).
    expect(c.rows).toBe(1);
    expect(c.totalCost).toBeCloseTo(
      DEFAULT_FACTORS.cpuOperatorCost + DEFAULT_FACTORS.cpuOperatorCost * 1000 + DEFAULT_FACTORS.cpuTupleCost * 1,
    );
  });

  it('computes an aggregate cost using group column distinct counts', () => {
    const m = new CostModel();
    const c = m.aggregateCost(stats(), ['region']);
    // distinctProduct = 10 → groupSize = min(1000, 10) = 10.
    expect(c.rows).toBe(10);
  });

  it('ignores unknown group columns in the distinct product', () => {
    const m = new CostModel();
    const c = m.aggregateCost(stats(), ['unknown']);
    // distinctProduct stays 1.
    expect(c.rows).toBe(1);
  });
});

describe('CostModel factor management', () => {
  it('gets a copy of the current factors', () => {
    const m = new CostModel();
    const f = m.getCostFactors();
    expect(f).toEqual(DEFAULT_FACTORS);
    // mutation of the copy must not affect the instance.
    f.seqPageCost = 999;
    expect(m.getCostFactors().seqPageCost).toBe(DEFAULT_FACTORS.seqPageCost);
  });

  it('sets a valid cost factor', () => {
    const m = new CostModel();
    m.setCostFactor('seqPageCost', 2.5);
    expect(m.getCostFactors().seqPageCost).toBe(2.5);
  });

  it('rejects an unknown cost factor', () => {
    const m = new CostModel();
    expect(() => m.setCostFactor('nope' as any, 1)).toThrow(/Unknown cost factor/);
  });

  it('rejects a negative cost factor', () => {
    const m = new CostModel();
    expect(() => m.setCostFactor('seqPageCost', -1)).toThrow(/non-negative/);
  });

  it('sets factors in bulk', () => {
    const m = new CostModel();
    m.setCostFactors({ seqPageCost: 3, randomPageCost: 5 });
    expect(m.getCostFactors().seqPageCost).toBe(3);
    expect(m.getCostFactors().randomPageCost).toBe(5);
  });

  it('resets factors to PostgreSQL defaults', () => {
    const m = new CostModel({ seqPageCost: 9 });
    m.resetCostFactors();
    expect(m.getCostFactors()).toEqual(DEFAULT_FACTORS);
  });

  it('merges partial constructor factors over defaults', () => {
    const m = new CostModel({ seqPageCost: 42 });
    expect(m.getCostFactors().seqPageCost).toBe(42);
    expect(m.getCostFactors().randomPageCost).toBe(DEFAULT_FACTORS.randomPageCost);
  });
});

describe('CostModel GUC loading', () => {
  it('loadFromGucSystem returns empty overrides when GUC is unavailable', () => {
    // Without GucSystem resolvable, the overrides object stays empty (and the
    // try/catch swallows the require failure).
    const overrides = CostModel.loadFromGucSystem();
    expect(overrides).toEqual({});
  });

  it('loadCostFactorsFromGuc leaves defaults intact when GUC unavailable', () => {
    const m = new CostModel();
    m.loadCostFactorsFromGuc();
    expect(m.getCostFactors()).toEqual(DEFAULT_FACTORS);
  });

  it('shouldUseParallel is false when no sequential cost exists', () => {
    const m = new CostModel();
    // Zero rows and pages → seqCost 0 → false.
    expect(m.shouldUseParallel(stats({ reltuples: 0, relpages: 0 }), 4)).toBe(false);
  });

  it('shouldUseParallel compares parallel cost to thresholded seq cost', () => {
    const m = new CostModel();
    // With ample workers the parallel cost should fall below 0.8× seq cost.
    const r = m.shouldUseParallel(stats(), 128, 0.8);
    expect(typeof r).toBe('boolean');
  });
});

describe('CostModel GUC loading (with populated GucSystem)', () => {
  it('loads float overrides from the GucSystem singleton', () => {
    // GucSystem imported at top of file.
    const guc = GucSystem.getInstance();
    guc.set('seq_page_cost', '2.5');
    guc.set('random_page_cost', '3');
    guc.set('cpu_tuple_cost', '0.02');
    guc.set('cpu_index_tuple_cost', '0.007');
    guc.set('cpu_operator_cost', '0.004');

    const overrides = CostModel.loadFromGucSystem();
    expect(overrides.seqPageCost).toBeCloseTo(2.5);
    expect(overrides.randomPageCost).toBeCloseTo(3);
    expect(overrides.cpuTupleCost).toBeCloseTo(0.02);
    expect(overrides.cpuIndexTupleCost).toBeCloseTo(0.007);
    expect(overrides.cpuOperatorCost).toBeCloseTo(0.004);

    guc.registry.resetAllToDefaults();
  });

  it('derives bitmapPageCost from effective_cache_size', () => {
    // GucSystem imported at top of file.
    const guc = GucSystem.getInstance();
    // 524288 pages × 8KB = 4GB → cacheRatio = 1 → bitmapPageCost = 1.0.
    guc.set('effective_cache_size', '524288');

    const overrides = CostModel.loadFromGucSystem();
    expect(overrides.bitmapPageCost).toBeCloseTo(1.0);

    guc.registry.resetAllToDefaults();
  });

  it('ignores non-numeric GUC values gracefully', () => {
    // GucSystem imported at top of file.
    const guc = GucSystem.getInstance();
    guc.set('seq_page_cost', 'not-a-number');

    const overrides = CostModel.loadFromGucSystem();
    // parseFloat('not-a-number') is NaN → treated as unset.
    expect(overrides.seqPageCost).toBeUndefined();

    guc.registry.resetAllToDefaults();
  });

  it('applies GUC loading to an instance via the loadFromGuc constructor flag', () => {
    // GucSystem imported at top of file.
    const guc = GucSystem.getInstance();
    guc.set('seq_page_cost', '7');

    const m = new CostModel(undefined, true);
    expect(m.getCostFactors().seqPageCost).toBeCloseTo(7);

    guc.registry.resetAllToDefaults();
  });
});

describe('CostModel GUC integer parsing', () => {
  it('ignores a non-numeric effective_cache_size value', () => {
    const guc = GucSystem.getInstance();
    guc.set('effective_cache_size', 'abc');

    const overrides = CostModel.loadFromGucSystem();
    // parseInt('abc', 10) is NaN → treated as unset (no bitmapPageCost override).
    expect(overrides.bitmapPageCost).toBeUndefined();

    guc.registry.resetAllToDefaults();
  });
});
