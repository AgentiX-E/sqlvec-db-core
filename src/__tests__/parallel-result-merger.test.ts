import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  ParallelResultMerger,
  buildReaggregateSql,
  scatterGatherCollect,
  scatterGatherMerge,
  type MergeOptions,
} from '../query/ParallelResultMerger';

describe('ParallelResultMerger.merge — non-aggregate path', () => {
  it('returns empty for no rows', () => {
    const m = new ParallelResultMerger();
    expect(m.merge({ sql: 'SELECT * FROM t', shardResults: [], columnNames: [] })).toEqual([]);
    expect(m.merge({ sql: 'SELECT * FROM t', shardResults: [{ rows: [] }], columnNames: [] })).toEqual([]);
  });

  it('concatenates rows when no aggregate/order/limit', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT * FROM t',
      shardResults: [{ rows: [{ a: 1 }], shardId: 0 }, { rows: [{ a: 2 }], shardId: 1 }],
      columnNames: ['a'],
    });
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('ParallelResultMerger.merge — simple aggregate re-summation', () => {
  it('re-sums a single-column COUNT/SUM without GROUP BY', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT SUM(x) FROM t',
      shardResults: [{ rows: [{ 'sum(x)': 3 }] }, { rows: [{ 'sum(x)': 4 }] }],
      columnNames: ['sum(x)'],
    });
    expect(out).toEqual([{ 'sum(x)': 7 }]);
  });

  it('re-sums COUNT via JS path (non-numeric falls through)', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT COUNT(*) FROM t',
      shardResults: [{ rows: [{ cnt: 5 }] }, { rows: [{ cnt: 3 }] }],
      columnNames: ['cnt'],
    });
    expect(out).toEqual([{ cnt: 8 }]);
  });

  it('re-aggregates a single-column MIN (non COUNT/SUM) via temp table', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT MIN(x) FROM t',
      shardResults: [{ rows: [{ 'min(x)': 2 }] }, { rows: [{ 'min(x)': 5 }] }],
      columnNames: ['min(x)'],
    });
    expect(out).toEqual([{ min: 2 }]);
  });

  it('falls through to temp table when values are non-numeric', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT SUM(x) FROM t',
      shardResults: [{ rows: [{ 'sum(x)': 'nope' }] }],
      columnNames: ['sum(x)'],
    });
    // The JS fast-path requires all-numeric values; a text value falls through
    // to the temp-table path, where SQLite's NUMERIC affinity coerces it to 0
    // and SUM returns 0.
    expect(out).toEqual([{ sum: 0 }]);
  });

  it('falls through when the aggregate column value is null', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT SUM(x) FROM t',
      shardResults: [{ rows: [{ 'sum(x)': null }] }, { rows: [{ 'sum(x)': null }] }],
      columnNames: ['sum(x)'],
    });
    // null values are non-numeric -> temp-table path; the SUM over NULLs is NULL.
    expect(out).toEqual([{ sum: null }]);
  });

  it('re-aggregates bigint column values', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT SUM(x) FROM t',
      shardResults: [{ rows: [{ 'sum(x)': BigInt(3) }] }, { rows: [{ 'sum(x)': BigInt(4) }] }],
      columnNames: ['sum(x)'],
    });
    // bigint values are `typeof === 'bigint'`, not 'number'; Number(bigint)
    // works, so the JS fast-path sums them to 7.
    expect(Number(out[0]['sum(x)'])).toBe(7);
  });

  it('type-infers bigint columns in the temp table', () => {
    const m = new ParallelResultMerger();
    // ORDER BY forces the temp-table path, where a bigint value must map to an
    // INTEGER column definition. better-sqlite3 returns it as a number (its
    // default `safeIntegers` mode is off).
    const out = m.merge({
      sql: 'SELECT x FROM t ORDER BY x',
      shardResults: [{ rows: [{ x: BigInt(5) }] }],
      columnNames: ['x'],
      tableName: 't',
    });
    expect(out).toEqual([{ x: 5 }]);
  });
});

describe('buildReaggregateSql', () => {
  it('re-aggregates SUM with SQLite default column name', () => {
    expect(buildReaggregateSql('SELECT SUM(x) FROM t', ['sum(x)'], 't')).toBe(
      'SELECT SUM("sum(x)") AS sum FROM _ms_scatter',
    );
  });

  it('re-aggregates COUNT(*)', () => {
    expect(buildReaggregateSql('SELECT COUNT(*) FROM t', ['count(*)'], 't')).toBe(
      'SELECT SUM("count(*)") AS count FROM _ms_scatter',
    );
  });

  it('honors an explicit AS alias', () => {
    expect(buildReaggregateSql('SELECT COUNT(*) AS c FROM t', ['c'], 't')).toBe(
      'SELECT SUM("c") AS c FROM _ms_scatter',
    );
    expect(buildReaggregateSql('SELECT SUM(x) AS total FROM t', ['total'], 't')).toBe(
      'SELECT SUM("total") AS total FROM _ms_scatter',
    );
  });

  it('re-aggregates AVG and MIN/MAX', () => {
    expect(buildReaggregateSql('SELECT AVG(x) FROM t', ['avg(x)'], 't')).toBe(
      'SELECT AVG("avg(x)") AS avg FROM _ms_scatter',
    );
    expect(buildReaggregateSql('SELECT MIN(x), MAX(y) FROM t', ['min(x)', 'max(y)'], 't')).toBe(
      'SELECT MIN("min(x)") AS min, MAX("max(y)") AS max FROM _ms_scatter',
    );
  });

  it('handles GROUP BY with non-aggregate columns', () => {
    const out = buildReaggregateSql(
      'SELECT category, SUM(x) FROM t GROUP BY category',
      ['category', 'sum(x)'],
      't',
    );
    expect(out).toContain('SELECT category');
    expect(out).toContain('SUM("sum(x)")');
    expect(out).toContain('GROUP BY _ms_scatter.category');
  });

  it('passes through a non-SELECT statement via table-name replacement', () => {
    expect(buildReaggregateSql('DELETE FROM t WHERE x = 1', [], 't')).toBe(
      'DELETE FROM _ms_scatter WHERE x = 1',
    );
  });

  it('escapes table names with regex metacharacters', () => {
    // table name 't.x' has a dot which must be escaped in the replacement regex
    expect(buildReaggregateSql('SELECT SUM(v) FROM t.x', ['sum(v)'], 't.x')).toBe(
      'SELECT SUM("sum(v)") AS sum FROM _ms_scatter',
    );
  });

  it('re-aggregates AVG with a cnt column (weighted average)', () => {
    const out = buildReaggregateSql(
      'SELECT category, AVG(x) FROM t GROUP BY category',
      ['category', 'avg(x)', 'cnt'],
      't',
    );
    expect(out).toContain('CASE WHEN SUM("cnt") = 0');
    expect(out).toContain('SUM("avg(x)" * "cnt") / SUM("cnt")');
  });

  it('re-aggregates MIN/MAX with explicit aliases', () => {
    expect(buildReaggregateSql('SELECT MIN(x) AS lo FROM t', ['lo'], 't')).toBe(
      'SELECT MIN("lo") AS lo FROM _ms_scatter',
    );
    expect(buildReaggregateSql('SELECT MAX(x) AS hi FROM t', ['hi'], 't')).toBe(
      'SELECT MAX("hi") AS hi FROM _ms_scatter',
    );
  });

  it('rewrites table-qualified non-aggregate columns', () => {
    const out = buildReaggregateSql('SELECT t.category, SUM(x) FROM t GROUP BY t.category', ['category', 'sum(x)'], 't');
    expect(out).toContain('_ms_scatter.category');
  });

  it('passes through an aggregate whose column is not in perShardCols', () => {
    // SUM(z) has no matching per-shard column, so it is passed through (with
    // the table name rewritten) rather than re-aggregated.
    const out = buildReaggregateSql('SELECT SUM(z) FROM t', ['sum(x)'], 't');
    expect(out).toBe('SELECT SUM(z) FROM _ms_scatter');
  });

  it('passes through an aggregate whose alias and inferred name are absent', () => {
    // The alias 'missing' is not in perShardCols, and the inferred colName
    // ('sum(z)') is not present either, so the expression is passed through
    // with only the table name rewritten.
    const out = buildReaggregateSql('SELECT SUM(z) AS missing FROM t', ['sum(x)'], 't');
    expect(out).toBe('SELECT SUM(z) AS missing FROM _ms_scatter');
  });

  it('re-aggregates single-column AVG without GROUP BY (non-weighted)', () => {
    const out = buildReaggregateSql('SELECT AVG(x) FROM t', ['avg(x)'], 't');
    expect(out).toBe('SELECT AVG("avg(x)") AS avg FROM _ms_scatter');
  });

  it('re-aggregates AVG weighted without an alias', () => {
    // AVG without AS, with a cnt column, no GROUP BY -> still non-weighted
    // (groupKeys empty) so it emits plain AVG(alias).
    const out = buildReaggregateSql('SELECT AVG(x) FROM t', ['avg(x)', 'cnt'], 't');
    expect(out).toBe('SELECT AVG("avg(x)") AS avg FROM _ms_scatter');
  });

  it('re-aggregates single-column AVG with an alias', () => {
    const out = buildReaggregateSql('SELECT AVG(x) AS a FROM t', ['a'], 't');
    expect(out).toBe('SELECT AVG("a") AS a FROM _ms_scatter');
  });

  it('re-aggregates AVG weighted with an alias', () => {
    const out = buildReaggregateSql(
      'SELECT category, AVG(x) AS a FROM t GROUP BY category',
      ['category', 'a', 'cnt'],
      't',
    );
    expect(out).toContain('CASE WHEN SUM("cnt") = 0');
    expect(out).toContain('AS a');
  });

  it('re-aggregates AVG weighted when cnt column is absent (fallback)', () => {
    // hasCountCol is false (no cnt column), so AVG falls back to plain re-avg
    // with the inferred alias.
    const out = buildReaggregateSql(
      'SELECT category, AVG(x) FROM t GROUP BY category',
      ['category', 'avg(x)'],
      't',
    );
    expect(out).toContain('AVG("avg(x)")');
  });

  it('re-aggregates single-column MIN without GROUP BY', () => {
    const out = buildReaggregateSql('SELECT MIN(x) FROM t', ['min(x)'], 't');
    expect(out).toBe('SELECT MIN("min(x)") AS min FROM _ms_scatter');
  });

  it('extracts a HAVING clause', () => {
    const out = buildReaggregateSql(
      'SELECT category, SUM(x) AS total FROM t GROUP BY category HAVING SUM(x) > 10',
      ['category', 'total'],
      't',
    );
    expect(out).toContain('HAVING');
  });

  it('extracts ORDER BY and LIMIT', () => {
    const out = buildReaggregateSql(
      'SELECT x FROM t ORDER BY x LIMIT 5',
      ['x'],
      't',
    );
    expect(out).toContain('ORDER BY x');
    expect(out).toContain('LIMIT 5');
  });
});

describe('ParallelResultMerger.merge — temp table re-aggregation (end-to-end)', () => {
  it('re-aggregates ORDER BY + LIMIT via temp table', () => {
    const m = new ParallelResultMerger();
    // Two shards, each returning ordered rows; merge re-sorts and limits.
    const out = m.merge({
      sql: 'SELECT * FROM t ORDER BY x LIMIT 2',
      shardResults: [
        { rows: [{ x: 1 }, { x: 3 }] },
        { rows: [{ x: 2 }] },
      ],
      columnNames: ['x'],
    });
    expect(out.map((r) => r.x)).toEqual([1, 2]);
  });

  it('re-aggregates GROUP BY SUM correctly across shards', () => {
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT category, SUM(x) AS total FROM t GROUP BY category',
      shardResults: [
        { rows: [{ category: 'a', total: 10 }, { category: 'b', total: 5 }] },
        { rows: [{ category: 'a', total: 7 }] },
      ],
      columnNames: ['category', 'total'],
      tableName: 't',
    });
    // category 'a' sums to 17, 'b' to 5.
    const byCat = Object.fromEntries(out.map((r) => [r.category, r.total]));
    expect(byCat).toEqual({ a: 17, b: 5 });
  });

  it('falls back to raw rows when temp table re-aggregation fails', () => {
    const m = new ParallelResultMerger();
    // columnNames empty -> CREATE TABLE with no columns would fail, triggering
    // the catch branch that returns raw rows.
    const rows = [{ x: 1 }];
    const out = m.merge({
      sql: 'SELECT * FROM t ORDER BY x',
      shardResults: [{ rows }],
      columnNames: [],
    });
    expect(out).toEqual(rows);
  });

  it('falls back to raw rows when tableName is absent and SQL has no FROM', () => {
    const m = new ParallelResultMerger();
    const rows = [{ x: 1 }];
    const out = m.merge({
      // No FROM clause and no tableName -> effectiveTable is empty, so the
      // original SQL is used as-is against the temp table and fails, returning
      // raw rows.
      sql: 'SELECT 1 ORDER BY x',
      shardResults: [{ rows }],
      columnNames: ['x'],
    });
    expect(out).toEqual(rows);
  });
});

describe('scatterGatherCollect', () => {
  it('uses the default concurrency when maxParallel is omitted', async () => {
    const results = await scatterGatherCollect([
      async () => 'x',
      async () => 'y',
    ]);
    expect(results).toEqual(['x', 'y']);
  });

  it('runs all shard executors and preserves order', async () => {
    const order: number[] = [];
    const results = await scatterGatherCollect([
      async () => { order.push(0); return 'a'; },
      async () => { order.push(1); return 'b'; },
      async () => { order.push(2); return 'c'; },
    ], 2);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(order).toHaveLength(3);
  });

  it('isolates a failing shard with an empty array', async () => {
    const results = await scatterGatherCollect([
      async () => { throw new Error('boom'); },
      async () => 'ok',
    ], 2);
    expect(results).toEqual([[], 'ok']);
  });

  it('handles a single shard', async () => {
    const results = await scatterGatherCollect([async () => 42], 5);
    expect(results).toEqual([42]);
  });

  it('handles zero shards', async () => {
    const results = await scatterGatherCollect([], 5);
    expect(results).toEqual([]);
  });

  it('re-aggregates rows with a null column value via temp table', async () => {
    // Null values in a row force the `?? null` branch during insertion.
    const m = new ParallelResultMerger();
    const out = m.merge({
      sql: 'SELECT a, b FROM t ORDER BY a',
      shardResults: [{ rows: [{ a: 1, b: null }] }],
      columnNames: ['a', 'b'],
      tableName: 't',
    });
    expect(out).toEqual([{ a: 1, b: null }]);
  });
});

describe('scatterGatherMerge', () => {
  it('collects then merges shard results', async () => {
    const rows = await scatterGatherMerge(
      [
        async () => [{ a: 1 }],
        async () => [{ a: 2 }],
      ],
      { sql: 'SELECT * FROM t', shardResults: [], columnNames: ['a'] },
      2,
    );
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('merges a SUM aggregate across shards', async () => {
    const rows = await scatterGatherMerge(
      [
        async () => [{ 'sum(x)': 3 }],
        async () => [{ 'sum(x)': 4 }],
      ],
      { sql: 'SELECT SUM(x) FROM t', shardResults: [], columnNames: ['sum(x)'] },
      2,
    );
    expect(rows).toEqual([{ 'sum(x)': 7 }]);
  });
});
