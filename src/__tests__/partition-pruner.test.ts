import { describe, it, expect } from 'vitest';
import {
  prunePartitions,
  rewriteSelectForPartition,
  _matchesSinglePredicate,
  _rangePredicateMatch,
  _listPredicateMatch,
  _hashPredicateMatch,
} from '../query/PartitionPruner';
import type { PartitionMeta } from '../query/PartitionMetaManager';

function meta(
  partitionName: string,
  method: 'RANGE' | 'LIST' | 'HASH',
  bounds: string,
  partitionColumn = 'id',
): PartitionMeta {
  return {
    parentTable: 'orders',
    partitionMethod: method,
    partitionColumn,
    partitionName,
    partitionBounds: bounds,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const RANGE_PARTITIONS: PartitionMeta[] = [
  meta('orders_p1', 'RANGE', '{"from":0,"to":100}'),
  meta('orders_p2', 'RANGE', '{"from":100,"to":200}'),
  meta('orders_p3', 'RANGE', '{"from":200,"to":300}'),
];

const LIST_PARTITIONS: PartitionMeta[] = [
  meta('orders_eu', 'LIST', '{"values":["DE","FR","IT"]}'),
  meta('orders_na', 'LIST', '{"values":["US","CA","MX"]}'),
  meta('orders_ap', 'LIST', '{"values":["JP","CN","IN"]}'),
];

const HASH_PARTITIONS: PartitionMeta[] = [
  meta('orders_h0', 'HASH', '{"modulus":4,"remainder":0}'),
  meta('orders_h1', 'HASH', '{"modulus":4,"remainder":1}'),
  meta('orders_h2', 'HASH', '{"modulus":4,"remainder":2}'),
  meta('orders_h3', 'HASH', '{"modulus":4,"remainder":3}'),
];

describe('prunePartitions — empty input', () => {
  it('returns an empty result when there are no partitions', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id = 5', []);
    expect(result.matchingPartitions).toEqual([]);
    expect(result.pruned).toBe(false);
    expect(result.rewrittenSql).toBe('SELECT * FROM orders WHERE id = 5');
  });

  it('scans all partitions when the WHERE clause has no predicate on the key', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE amount > 10', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
    expect(result.pruned).toBe(false);
  });

  it('scans all partitions when there is no WHERE clause at all', () => {
    const result = prunePartitions('SELECT * FROM orders', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
    expect(result.pruned).toBe(false);
  });
});

describe('prunePartitions — RANGE', () => {
  it('matches the exact partition for an equality predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id = 50', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p1']);
    expect(result.pruned).toBe(true);
  });

  it('matches partitions for a greater-than predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id > 150', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p2', 'orders_p3']);
    expect(result.pruned).toBe(true);
  });

  it('matches partitions for a greater-than-or-equal predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id >= 100', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p2', 'orders_p3']);
  });

  it('matches partitions for a less-than predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id < 100', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p1']);
  });

  it('matches partitions for a less-than-or-equal predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id <= 100', RANGE_PARTITIONS);
    // `<= 100` includes 100 itself, which is the lower (inclusive) bound of p2,
    // so both p1 (0-99) and p2 (100-199) can contain a value <= 100.
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2']);
  });

  it('matches partitions for an IN predicate', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id IN (50, 150)', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2']);
  });

  it('matches partitions for a BETWEEN predicate', () => {
    const result = prunePartitions(
      'SELECT * FROM orders WHERE id BETWEEN 50 AND 150',
      RANGE_PARTITIONS,
    );
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2']);
  });

  it('returns empty when the predicate is outside all bounds', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id = 500', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual([]);
    expect(result.pruned).toBe(true);
    expect(result.rewrittenSql).toContain('WHERE 1=0');
  });
});

describe('prunePartitions — LIST', () => {
  it('matches the exact partition for an equality predicate', () => {
    const result = prunePartitions("SELECT * FROM orders WHERE region = 'DE'", LIST_PARTITIONS.map((p) => ({
      ...p,
      partitionColumn: 'region',
    })));
    expect(result.matchingPartitions).toEqual(['orders_eu']);
    expect(result.pruned).toBe(true);
  });

  it('matches partitions for an IN predicate', () => {
    const result = prunePartitions(
      "SELECT * FROM orders WHERE region IN ('US', 'JP')",
      LIST_PARTITIONS.map((p) => ({ ...p, partitionColumn: 'region' })),
    );
    expect(result.matchingPartitions).toEqual(['orders_na', 'orders_ap']);
  });

  it('matches partitions for a range predicate on list values', () => {
    // Numeric list values make the comparison well-defined: values < 15 keep
    // only partitions that hold at least one value below 15.
    const numericList: PartitionMeta[] = [
      meta('orders_low', 'LIST', '{"values":[1,2,3]}', 'id'),
      meta('orders_mid', 'LIST', '{"values":[10,20,30]}', 'id'),
      meta('orders_high', 'LIST', '{"values":[100,200]}', 'id'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id < 15', numericList);
    expect(result.matchingPartitions).toEqual(['orders_low', 'orders_mid']);
  });

  it('returns empty for a list value that matches no partition', () => {
    const result = prunePartitions(
      "SELECT * FROM orders WHERE region = 'ZZ'",
      LIST_PARTITIONS.map((p) => ({ ...p, partitionColumn: 'region' })),
    );
    expect(result.matchingPartitions).toEqual([]);
  });
});

describe('prunePartitions — HASH', () => {
  it('matches the correct hash bucket for an equality predicate', () => {
    // 10 % 4 === 2
    const result = prunePartitions('SELECT * FROM orders WHERE id = 10', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h2']);
    expect(result.pruned).toBe(true);
  });

  it('matches hash buckets for an IN predicate', () => {
    // 10 % 4 = 2, 11 % 4 = 3
    const result = prunePartitions('SELECT * FROM orders WHERE id IN (10, 11)', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h2', 'orders_h3']);
  });

  it('scans all hash partitions for a range predicate (cannot prune)', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id > 5', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h0', 'orders_h1', 'orders_h2', 'orders_h3']);
    expect(result.pruned).toBe(false);
  });
});

describe('prunePartitions — multiple predicates (AND)', () => {
  it('requires ALL predicates to match', () => {
    const result = prunePartitions(
      'SELECT * FROM orders WHERE id > 50 AND id < 150',
      RANGE_PARTITIONS,
    );
    // id > 50: p1 (50..99), p2, p3 all have an upper bound > 50 → p1,p2,p3.
    // id < 150: p1 (0..99) and p2 (100..199) have a lower bound < 150 → p1,p2.
    // Intersection: p1,p2.
    expect(result.matchingPartitions).toEqual(['orders_p1', 'orders_p2']);
  });

  it('returns empty when predicates are contradictory', () => {
    const result = prunePartitions(
      'SELECT * FROM orders WHERE id = 10 AND id = 150',
      RANGE_PARTITIONS,
    );
    // No single RANGE partition can satisfy id = 10 AND id = 150 simultaneously.
    expect(result.matchingPartitions).toEqual([]);
  });
});

describe('rewriteSelectForPartition', () => {
  it('returns an empty SELECT when no partitions match', () => {
    const sql = rewriteSelectForPartition('SELECT * FROM orders WHERE id = 1', []);
    expect(sql).toContain('WHERE 1=0');
  });

  it('replaces the table name for a single partition', () => {
    const sql = rewriteSelectForPartition('SELECT * FROM orders WHERE id = 1', ['orders_p1']);
    expect(sql).toBe('SELECT * FROM orders_p1 WHERE id = 1');
  });

  it('joins multiple partitions with UNION ALL', () => {
    const sql = rewriteSelectForPartition('SELECT * FROM orders WHERE id > 5', [
      'orders_p1',
      'orders_p2',
    ]);
    expect(sql).toBe(
      'SELECT * FROM orders_p1 WHERE id > 5 UNION ALL SELECT * FROM orders_p2 WHERE id > 5',
    );
  });

  it('preserves a quoted shard name when it needs quoting', () => {
    const sql = rewriteSelectForPartition('SELECT * FROM orders', ['orders p1']);
    expect(sql).toBe('SELECT * FROM "orders p1"');
  });
});

describe('prunePartitions — coercion and edge cases', () => {
  it('coerces string numbers to numbers for comparison (quoting preserved)', () => {
    // A list partition holding the value "5" must match `= '5'` where the
    // extractor infers the value as a number but the bounds store a string.
    const list: PartitionMeta[] = [
      meta('orders_s', 'LIST', '{"values":["5","15"]}', 'id'),
    ];
    const result = prunePartitions("SELECT * FROM orders WHERE id = '5'", list);
    expect(result.matchingPartitions).toEqual(['orders_s']);
  });

  it('matches a hash bucket for a non-numeric string value by scanning all', () => {
    // A string value cannot be hashed; the guard should include all partitions.
    const result = prunePartitions("SELECT * FROM orders WHERE id = 'abc'", HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h0', 'orders_h1', 'orders_h2', 'orders_h3']);
  });

  it('handles a BETWEEN predicate with a single bound (defensive include)', () => {
    const result = prunePartitions(
      'SELECT * FROM orders WHERE id BETWEEN 50 AND 50',
      RANGE_PARTITIONS,
    );
    // 50..50 overlaps p1 (0..99).
    expect(result.matchingPartitions).toEqual(['orders_p1']);
  });

  it('handles an unknown partition method by including the partition', () => {
    const unknown: PartitionMeta[] = [
      meta('orders_x', 'RANGE' as any, '{"from":0,"to":10}'),
    ];
    // Force the switch default via a method value the switch does not match.
    const bad = { ...unknown[0], partitionMethod: 'WEIRD' as any };
    const result = prunePartitions('SELECT * FROM orders WHERE id = 5', [bad]);
    expect(result.matchingPartitions).toEqual(['orders_x']);
    expect(result.pruned).toBe(false);
  });

  it('generates a wildcard SELECT list when no SELECT..FROM column list exists', () => {
    const result = prunePartitions('VALUES (1)', RANGE_PARTITIONS);
    // No WHERE/partition key predicate → scans all; rewrite path exercised.
    expect(result.pruned).toBe(false);
  });
});

describe('prunePartitions — RANGE operator coverage', () => {
  it('covers the >= operator', () => {
    expect(
      prunePartitions('SELECT * FROM orders WHERE id >= 200', RANGE_PARTITIONS).matchingPartitions,
    ).toEqual(['orders_p3']);
  });

  it('covers the = operator at an upper-exclusive boundary', () => {
    // 100 is the lower (inclusive) bound of p2.
    expect(
      prunePartitions('SELECT * FROM orders WHERE id = 100', RANGE_PARTITIONS).matchingPartitions,
    ).toEqual(['orders_p2']);
  });

  it('covers an IN predicate with values spanning multiple partitions', () => {
    expect(
      prunePartitions('SELECT * FROM orders WHERE id IN (50, 150, 250)', RANGE_PARTITIONS)
        .matchingPartitions,
    ).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
  });
});

describe('prunePartitions — LIST operator coverage', () => {
  const list = LIST_PARTITIONS.map((p) => ({ ...p, partitionColumn: 'region' }));

  it('covers the >= operator', () => {
    const numeric: PartitionMeta[] = [
      meta('orders_a', 'LIST', '{"values":[10,20]}', 'id'),
      meta('orders_b', 'LIST', '{"values":[30,40]}', 'id'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id >= 25', numeric);
    expect(result.matchingPartitions).toEqual(['orders_b']);
  });

  it('covers the > operator', () => {
    const numeric: PartitionMeta[] = [
      meta('orders_a', 'LIST', '{"values":[10,20]}', 'id'),
      meta('orders_b', 'LIST', '{"values":[30,40]}', 'id'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id > 20', numeric);
    expect(result.matchingPartitions).toEqual(['orders_b']);
  });

  it('covers the <= operator', () => {
    const numeric: PartitionMeta[] = [
      meta('orders_a', 'LIST', '{"values":[10,20]}', 'id'),
      meta('orders_b', 'LIST', '{"values":[30,40]}', 'id'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id <= 20', numeric);
    expect(result.matchingPartitions).toEqual(['orders_a']);
  });

  it('covers the BETWEEN operator', () => {
    const numeric: PartitionMeta[] = [
      meta('orders_a', 'LIST', '{"values":[10,20]}', 'id'),
      meta('orders_b', 'LIST', '{"values":[30,40]}', 'id'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id BETWEEN 15 AND 35', numeric);
    expect(result.matchingPartitions).toEqual(['orders_a', 'orders_b']);
  });

  it('covers the equality operator with a non-matching value', () => {
    const result = prunePartitions("SELECT * FROM orders WHERE region = 'FR'", list);
    expect(result.matchingPartitions).toEqual(['orders_eu']);
  });
});

describe('prunePartitions — HASH operator coverage', () => {
  it('covers the = operator with a matching bucket', () => {
    // 4 % 4 === 0
    expect(
      prunePartitions('SELECT * FROM orders WHERE id = 4', HASH_PARTITIONS).matchingPartitions,
    ).toEqual(['orders_h0']);
  });

  it('covers the >= operator (cannot prune for HASH)', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id >= 2', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h0', 'orders_h1', 'orders_h2', 'orders_h3']);
  });

  it('covers the <= operator (cannot prune for HASH)', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id <= 2', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h0', 'orders_h1', 'orders_h2', 'orders_h3']);
  });

  it('covers the BETWEEN operator (cannot prune for HASH)', () => {
    const result = prunePartitions('SELECT * FROM orders WHERE id BETWEEN 1 AND 10', HASH_PARTITIONS);
    expect(result.matchingPartitions).toEqual(['orders_h0', 'orders_h1', 'orders_h2', 'orders_h3']);
  });

  it('covers the IN operator with mixed matching/non-matching buckets', () => {
    expect(
      prunePartitions('SELECT * FROM orders WHERE id IN (5, 7)', HASH_PARTITIONS).matchingPartitions,
    ).toEqual(['orders_h1', 'orders_h3']);
  });
});

describe('prunePartitions — remaining defensive edges', () => {
  it('generates a wildcard SELECT when the no-match SQL has no SELECT..FROM', () => {
    const result = prunePartitions('WHERE id = 500', RANGE_PARTITIONS);
    expect(result.matchingPartitions).toEqual([]);
    expect(result.pruned).toBe(true);
    expect(result.rewrittenSql).toBe('SELECT * WHERE 1=0');
  });

  it('compares boolean values (non-string, non-number coercion)', () => {
    const list: PartitionMeta[] = [
      meta('orders_t', 'LIST', '{"values":[true]}', 'flag'),
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE flag = true', list);
    expect(result.matchingPartitions).toEqual(['orders_t']);
  });
});

describe('prunePartitions — bounds shape edge cases', () => {
  it('handles a LIST partition whose bounds have no values array', () => {
    // `values` is absent from the JSON, exercising the `?? []` fallback.
    const noVals: PartitionMeta[] = [
      { ...meta('orders_x', 'LIST', '{}', 'id') },
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id = 5', noVals);
    expect(result.matchingPartitions).toEqual([]);
  });

  it('handles a LIST partition with no values for an IN predicate', () => {
    const noVals: PartitionMeta[] = [
      { ...meta('orders_x', 'LIST', '{}', 'id') },
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id IN (5, 6)', noVals);
    expect(result.matchingPartitions).toEqual([]);
  });

  it('matches a LIST partition whose stored value is a quoted numeric string', () => {
    // The bounds store the value with quotes intact (e.g. `"5"`); `Number` sees
    // the quotes and returns NaN, so coercion must strip them and re-parse.
    const quotedVals: PartitionMeta[] = [
      { ...meta('orders_q', 'LIST', '{"values":["\\"5\\""]}', 'id') },
    ];
    const result = prunePartitions('SELECT * FROM orders WHERE id = 5', quotedVals);
    expect(result.matchingPartitions).toEqual(['orders_q']);
  });
});

describe('PartitionPruner defensive branches (via internal test hooks)', () => {

  it('matches an unknown operator by including the partition (RANGE)', () => {
    const p = meta('orders_r', 'RANGE', '{"from":0,"to":100}');
    // @ts-expect-error exercise the switch default with an invalid op
    const r = _rangePredicateMatch(p, { col: 'id', op: 'WEIRD', value: 5 });
    expect(r).toBe(true);
  });

  it('matches an unknown operator by including the partition (LIST)', () => {
    const p = meta('orders_l', 'LIST', '{"values":[1,2,3]}');
    // @ts-expect-error exercise the switch default with an invalid op
    const r = _listPredicateMatch(p, { col: 'id', op: 'WEIRD', value: 5 });
    expect(r).toBe(true);
  });

  it('matches an unknown operator by including the partition (HASH)', () => {
    const p = meta('orders_h', 'HASH', '{"modulus":4,"remainder":0}');
    // @ts-expect-error exercise the switch default with an invalid op
    const r = _hashPredicateMatch(p, { col: 'id', op: 'WEIRD', value: 5 });
    expect(r).toBe(true);
  });

  it('matches an unknown partition method by including the partition', () => {
    const p = meta('orders_m', 'RANGE', '{"from":0,"to":100}');
    // @ts-expect-error exercise the method switch default
    const r = _matchesSinglePredicate(p, { col: 'id', op: '=', value: 5 }, 'WEIRD');
    expect(r).toBe(true);
  });

  it('covers the RANGE IN fallback when IN values are absent', () => {
    const p = meta('orders_r', 'RANGE', '{"from":0,"to":100}');
    // `values` is null, exercising `pred.values ?? []`.
    const r = _rangePredicateMatch(p, { col: 'id', op: 'IN', value: null, values: null });
    expect(r).toBe(false);
  });

  it('covers the LIST IN fallback when IN values are absent', () => {
    const p = meta('orders_l', 'LIST', '{"values":[1,2,3]}');
    const r = _listPredicateMatch(p, { col: 'id', op: 'IN', value: null, values: null });
    expect(r).toBe(false);
  });

  it('covers the HASH IN fallback when IN values are absent', () => {
    const p = meta('orders_h', 'HASH', '{"modulus":4,"remainder":0}');
    const r = _hashPredicateMatch(p, { col: 'id', op: 'IN', value: null, values: null });
    expect(r).toBe(false);
  });

  it('covers the RANGE BETWEEN fallback when bounds are undefined', () => {
    const p = meta('orders_r', 'RANGE', '{"from":0,"to":100}');
    // `values` set to [undefined] so `values?.[0]` and `[1]` are undefined.
    const r = _rangePredicateMatch(p, {
      col: 'id',
      op: 'BETWEEN',
      value: null,
      values: [undefined, undefined],
    });
    expect(r).toBe(true);
  });

  it('covers the LIST range comparison fallback when the comparison value is undefined', () => {
    const p = meta('orders_l', 'LIST', '{"values":[1,2,3]}');
    // `value` is undefined, so `coerceCompare` returns undefined and the guard
    // short-circuits to "include the partition".
    const r = _listPredicateMatch(p, { col: 'id', op: '>', value: undefined });
    expect(r).toBe(true);
  });
});
