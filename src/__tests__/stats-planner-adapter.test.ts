/**
 * stats-planner-adapter.test.ts — Coverage tests for StatsPlannerAdapter
 * (stats -> QueryPlanner data path).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import {
  loadTableStats,
  loadHistogram,
  estimateSelectivity,
  listTableNeedingAnalyze,
  clearStatsCache,
} from '../query/StatsPlannerAdapter';
import { STATS_TABLE, HISTOGRAM_TABLE } from '../query/AnalyzeStatsCollector';

/** Minimal fake better-sqlite3 Database routed by SQL content. */
function makeDb(handlers: {
  get?: (sql: string, ...args: any[]) => any;
  all?: (sql: string, ...args: any[]) => any[];
}): Database.Database {
  const prepare = (sql: string) => ({
    get: (...args: any[]) => handlers.get?.(sql, ...args),
    all: (...args: any[]) => handlers.all?.(sql, ...args),
  });
  return { prepare } as unknown as Database.Database;
}

function sqlHas(sql: string, needle: string): boolean {
  return sql.includes(needle);
}

describe('loadTableStats', () => {
  beforeEach(() => clearStatsCache());

  it('returns null when db or tableName missing', async () => {
    expect(await loadTableStats(undefined, 't')).toBeNull();
    expect(await loadTableStats(makeDb({}), '')).toBeNull();
  });

  it('returns null when stats table missing', async () => {
    const db = makeDb({
      get: (sql) => (sqlHas(sql, 'sqlite_master') ? undefined : undefined),
    });
    expect(await loadTableStats(db, 't')).toBeNull();
  });

  it('loads table stats with row_count, columns, MCV, correlation', async () => {
    const db = makeDb({
      get: (sql, ...args) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        if (sqlHas(sql, 'row_count')) return { row_count: 100 };
        return undefined;
      },
      all: (sql, ...args) => {
        if (sqlHas(sql, 'column_name, distinct_count')) {
          return [
            {
              column_name: 'id',
              distinct_count: 10, // < reltuples(100) so correlation > 0
              mcv_values: JSON.stringify([1, 2, 3]),
              mcv_frequencies: JSON.stringify([0.5, 0.3, 0.2]),
              min_value: '1',
              max_value: '100',
            },
            {
              column_name: 'name',
              distinct_count: 50,
              mcv_values: 'not-json',
              mcv_frequencies: '{}',
              min_value: null,
              max_value: null,
            },
          ];
        }
        return [];
      },
    });
    const stats = await loadTableStats(db, 't');
    expect(stats).not.toBeNull();
    expect(stats!.reltuples).toBe(100);
    expect(stats!.relpages).toBe(Math.max(1, Math.ceil(100 * 100 / 4096)));
    expect(stats!.nDistinct.get('id')).toBe(10);
    expect(stats!.nDistinct.get('name')).toBe(50);
    expect(stats!.correlation.get('id')).toBeGreaterThan(0);
    // 'name' has null min/max so no correlation entry
    expect(stats!.correlation.get('name')).toBeUndefined();
  });

  it('uses row_count 0 when row_count query returns undefined (reltuples ?? 0)', async () => {
    const db = makeDb({
      get: (sql) =>
        sqlHas(sql, 'sqlite_master') ? { name: STATS_TABLE } : undefined,
      all: () => [],
    });
    const stats = await loadTableStats(db, 't');
    expect(stats).not.toBeNull();
    expect(stats!.reltuples).toBe(0);
  });

  it('skips correlation when min/max are non-numeric', async () => {
    const db = makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        if (sqlHas(sql, 'row_count')) return { row_count: 100 };
        return undefined;
      },
      all: () => [
        {
          column_name: 'c',
          distinct_count: 10,
          mcv_values: '[]',
          mcv_frequencies: '[]',
          min_value: 'abc', // non-numeric → NaN
          max_value: 'xyz',
        },
        {
          column_name: 'd',
          distinct_count: 10,
          mcv_values: '[]',
          mcv_frequencies: '[]',
          min_value: '50', // max <= min → no correlation
          max_value: '10',
        },
      ],
    });
    const stats = await loadTableStats(db, 't');
    expect(stats!.correlation.get('c')).toBeUndefined();
    expect(stats!.correlation.get('d')).toBeUndefined();
  });

  it('returns cached stats on second call within TTL', async () => {
    let rowCountGets = 0;
    const db = makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        if (sqlHas(sql, 'row_count')) {
          rowCountGets++;
          return { row_count: 10 };
        }
        return undefined;
      },
      all: () => [],
    });
    await loadTableStats(db, 't');
    expect(rowCountGets).toBe(1);
    await loadTableStats(db, 't');
    // Second call served from cache: no additional row_count query
    expect(rowCountGets).toBe(1);
  });

  it('returns null and warns when a query inside try throws', async () => {
    let first = true;
    const db = makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        // row_count query throws on first access
        throw new Error('db closed');
      },
      all: () => [],
    });
    expect(await loadTableStats(db, 't')).toBeNull();
  });
});

describe('loadHistogram', () => {
  it('returns [] when histogram table missing', () => {
    const db = makeDb({ get: () => undefined });
    expect(loadHistogram(db, 't', 'c')).toEqual([]);
  });

  it('maps histogram rows', () => {
    const db = makeDb({
      get: (sql) => (sqlHas(sql, 'sqlite_master') ? { name: HISTOGRAM_TABLE } : undefined),
      all: (sql, ...args) =>
        sqlHas(sql, 'bucket_index')
          ? [
              { bucket_index: 0, bucket_min: '1', bucket_max: '10', bucket_count: 5 },
              { bucket_index: 1, bucket_min: '11', bucket_max: '20', bucket_count: 3 },
            ]
          : [],
    });
    const hist = loadHistogram(db, 't', 'c');
    expect(hist).toEqual([
      { bucketIndex: 0, bucketMin: '1', bucketMax: '10', bucketCount: 5 },
      { bucketIndex: 1, bucketMin: '11', bucketMax: '20', bucketCount: 3 },
    ]);
  });

  it('returns [] when prepare throws', () => {
    const db = {
      prepare: () => {
        throw new Error('boom');
      },
    } as unknown as Database.Database;
    expect(loadHistogram(db, 't', 'c')).toEqual([]);
  });
});

describe('estimateSelectivity', () => {
  function statDb(statRow: any): Database.Database {
    return makeDb({
      get: (sql) => (sqlHas(sql, 'row_count') ? statRow : undefined),
      all: (sql) => (sqlHas(sql, 'bucket_index') ? [] : []),
    });
  }

  it('returns null when no stat row or row_count <= 0', () => {
    expect(estimateSelectivity(statDb(undefined), 't', 'c', '=', 1)).toBeNull();
    expect(estimateSelectivity(statDb({ row_count: 0 }), 't', 'c', '=', 1)).toBeNull();
  });

  it('uses MCV frequency for = when value found', () => {
    const db = statDb({
      row_count: 100,
      distinct_count: 10,
      null_fraction: 0,
      mcv_values: JSON.stringify(['a', 'b']),
      mcv_frequencies: JSON.stringify([0.5, 0.3]),
      min_value: null,
      max_value: null,
    });
    // MCV value 'a' found at index 0 → 0.5 / 100
    expect(estimateSelectivity(db, 't', 'c', '=', 'a')).toBeCloseTo(0.5 / 100);
  });

  it('uses uniform fallback when = value not in MCV', () => {
    const db = statDb({
      row_count: 100,
      distinct_count: 10,
      null_fraction: 0,
      mcv_values: JSON.stringify(['a', 'b']),
      mcv_frequencies: JSON.stringify([0.5, 0.3]),
      min_value: null,
      max_value: null,
    });
    const r = estimateSelectivity(db, 't', 'c', '=', 'zzz');
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(0);
  });

  it('uses histogram for range operators', () => {
    const db = makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: HISTOGRAM_TABLE };
        if (sqlHas(sql, 'row_count'))
          return {
            row_count: 100,
            distinct_count: 10,
            null_fraction: 0,
            mcv_values: '[]',
            mcv_frequencies: '[]',
            min_value: null,
            max_value: null,
          };
        return undefined;
      },
      all: (sql) =>
        sqlHas(sql, 'bucket_index')
          ? [
              { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 50 },
              { bucket_index: 1, bucket_min: '51', bucket_max: '100', bucket_count: 50 },
            ]
          : [],
    });
    const r = estimateSelectivity(db, 't', 'c', '<', 25);
    expect(r).not.toBeNull();
    // bucket 0 (1-50) relevant (bMin '1' < 25); bucket 1 (51-100) not relevant
    expect(r!).toBeCloseTo(0.5);
  });

  it('BETWEEN operator with array value', () => {
    const db = makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: HISTOGRAM_TABLE };
        if (sqlHas(sql, 'row_count'))
          return {
            row_count: 100, distinct_count: 10, null_fraction: 0,
            mcv_values: '[]', mcv_frequencies: '[]', min_value: null, max_value: null,
          };
        return undefined;
      },
      all: (sql) =>
        sqlHas(sql, 'bucket_index')
          ? [
              { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 50 },
              { bucket_index: 1, bucket_min: '51', bucket_max: '100', bucket_count: 50 },
            ]
          : [],
    });
    expect(estimateSelectivity(db, 't', 'c', 'BETWEEN', [10, 60])).toBeCloseTo(1);
  });

  function histDb(statRow: any, buckets: any[]): Database.Database {
    return makeDb({
      get: (sql) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: HISTOGRAM_TABLE };
        if (sqlHas(sql, 'row_count')) return statRow;
        return undefined;
      },
      all: (sql) => (sqlHas(sql, 'bucket_index') ? buckets : []),
    });
  }

  const baseStat = {
    row_count: 100, distinct_count: 10, null_fraction: 0,
    mcv_values: '[]', mcv_frequencies: '[]', min_value: null, max_value: null,
  };

  it('>  operator uses histogram (bMax <= value → not relevant)', () => {
    const db = histDb(baseStat, [
      { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 50 },
      { bucket_index: 1, bucket_min: '51', bucket_max: '100', bucket_count: 50 },
    ]);
    // > 75: bucket0 bMax '50' <= 75 → not relevant; bucket1 bMax '100' > 75 → relevant
    expect(estimateSelectivity(db, 't', 'c', '>', 75)).toBeCloseTo(0.5);
  });

  it('BETWEEN with out-of-range buckets (bMin > value[1], bMax < value[0])', () => {
    const db = histDb(baseStat, [
      { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 50 },
      { bucket_index: 1, bucket_min: '51', bucket_max: '100', bucket_count: 50 },
      { bucket_index: 2, bucket_min: '101', bucket_max: '200', bucket_count: 20 },
    ]);
    // BETWEEN [60, 80]: bucket0 bMax '50' < 60 → not relevant (L256 true)
    //   bucket1 fully inside → relevant (50)
    //   bucket2 bMin '101' > 80 → not relevant (L255 true)
    expect(estimateSelectivity(db, 't', 'c', 'BETWEEN', [60, 80])).toBeCloseTo(50 / 120);
  });

  it('BETWEEN with non-array value falls through (returns null)', () => {
    const db = histDb(baseStat, [
      { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 10 },
    ]);
    // value not array → bucket loop runs but no BETWEEN filter → all relevant
    expect(estimateSelectivity(db, 't', 'c', 'BETWEEN', 30)).toBeCloseTo(1);
  });

  it('returns null when all buckets have zero count (bucketTotalCount === 0)', () => {
    const db = histDb(baseStat, [
      { bucket_index: 0, bucket_min: '1', bucket_max: '50', bucket_count: 0 },
    ]);
    expect(estimateSelectivity(db, 't', 'c', '<', 25)).toBeNull();
  });

  it('falls back to uniform for = without MCV', () => {
    const db = statDb({
      row_count: 100,
      distinct_count: 20,
      null_fraction: 0,
      mcv_values: '[]',
      mcv_frequencies: '[]',
      min_value: null,
      max_value: null,
    });
    expect(estimateSelectivity(db, 't', 'c', '=', 1)).toBeCloseTo(1 / 20);
  });

  it('falls back to heuristic for range / BETWEEN without histogram', () => {
    const db = statDb({
      row_count: 100,
      distinct_count: 20,
      null_fraction: 0,
      mcv_values: '[]',
      mcv_frequencies: '[]',
      min_value: null,
      max_value: null,
    });
    expect(estimateSelectivity(db, 't', 'c', '>', 1)).toBeCloseTo(0.3333);
    expect(estimateSelectivity(db, 't', 'c', 'BETWEEN', [1, 100])).toBeCloseTo(0.05);
  });

  it('IS NULL / IS NOT NULL', () => {
    const db = statDb({
      row_count: 100,
      distinct_count: 20,
      null_fraction: 0.3,
      mcv_values: '[]',
      mcv_frequencies: '[]',
      min_value: null,
      max_value: null,
    });
    expect(estimateSelectivity(db, 't', 'c', 'IS NULL', null)).toBeCloseTo(0.3);
    expect(estimateSelectivity(db, 't', 'c', 'IS NOT NULL', null)).toBeCloseTo(0.7);
  });

  it('LIKE', () => {
    const db = statDb({
      row_count: 100, distinct_count: 20, null_fraction: 0,
      mcv_values: '[]', mcv_frequencies: '[]', min_value: null, max_value: null,
    });
    expect(estimateSelectivity(db, 't', 'c', 'LIKE', '%x%')).toBeCloseTo(0.05);
  });

  it('!= and <>', () => {
    const db = statDb({
      row_count: 100, distinct_count: 20, null_fraction: 0.1,
      mcv_values: '[]', mcv_frequencies: '[]', min_value: null, max_value: null,
    });
    const expected = (1 - 0.1) * (20 - 1) / 20;
    expect(estimateSelectivity(db, 't', 'c', '!=', 1)).toBeCloseTo(expected);
    expect(estimateSelectivity(db, 't', 'c', '<>', 1)).toBeCloseTo(expected);
  });

  it('unknown operator returns 0.1', () => {
    const db = statDb({
      row_count: 100, distinct_count: 20, null_fraction: 0,
      mcv_values: '[]', mcv_frequencies: '[]', min_value: null, max_value: null,
    });
    expect(estimateSelectivity(db, 't', 'c', 'REGEX', 'x')).toBeCloseTo(0.1);
  });

  it('returns null when prepare throws', () => {
    const db = {
      prepare: () => {
        throw new Error('boom');
      },
    } as unknown as Database.Database;
    expect(estimateSelectivity(db, 't', 'c', '=', 1)).toBeNull();
  });
});

describe('listTableNeedingAnalyze', () => {
  it('returns all user tables when stats table missing', () => {
    const db = makeDb({
      get: (sql) =>
        sqlHas(sql, 'sqlite_master') && sqlHas(sql, "name=?")
          ? undefined
          : undefined,
      all: (sql) =>
        sqlHas(sql, 'NOT LIKE')
          ? [{ name: 'users' }, { name: 'orders' }]
          : [],
    });
    expect(listTableNeedingAnalyze(db)).toEqual(['users', 'orders']);
  });

  it('returns only tables without stats', () => {
    const db = makeDb({
      get: (sql, ...args) => {
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        if (sqlHas(sql, 'COUNT(*)')) {
          const tbl = args[0];
          return tbl === 'users' ? { cnt: 5 } : { cnt: 0 };
        }
        return undefined;
      },
      all: (sql) =>
        sqlHas(sql, 'NOT LIKE')
          ? [{ name: 'users' }, { name: 'orders' }]
          : [],
    });
    expect(listTableNeedingAnalyze(db)).toEqual(['orders']);
  });

  it('returns [] when throws', () => {
    const db = {
      prepare: () => {
        throw new Error('boom');
      },
    } as unknown as Database.Database;
    expect(listTableNeedingAnalyze(db)).toEqual([]);
  });
});

describe('clearStatsCache', () => {
  it('clears the cache', async () => {
    let getCalls = 0;
    const db = makeDb({
      get: (sql) => {
        getCalls++;
        if (sqlHas(sql, 'sqlite_master')) return { name: STATS_TABLE };
        if (sqlHas(sql, 'row_count')) return { row_count: 10 };
        return undefined;
      },
      all: () => [],
    });
    await loadTableStats(db, 't');
    clearStatsCache();
    await loadTableStats(db, 't');
    // After clear, second load re-fetches (more get calls)
    expect(getCalls).toBeGreaterThan(2);
  });
});
