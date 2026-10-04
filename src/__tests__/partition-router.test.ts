/**
 * PartitionRouter — range/list/hash partition routing tests.
 *
 * Covers DDL registration, child add/remove with default-partition ordering,
 * INSERT/DML routing, range/list/hash pruning, WHERE extraction, and the
 * union-select rewrite for multi-partition scans.
 */
import { describe, it, expect } from 'vitest';
import { PartitionRouter } from '../query/PartitionRouter';

function freshRouter(): PartitionRouter {
  const r = new PartitionRouter();
  return r;
}

describe('PartitionRouter DDL', () => {
  it('registers and unregisters a partitioned table', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    expect(r.isPartitioned('orders')).toBe(true);
    expect(r.getPartition('orders')).toMatchObject({
      parentTable: 'orders',
      strategy: 'range',
      partitionKey: 'id',
    });

    r.unregisterPartitionedTable('orders');
    expect(r.isPartitioned('orders')).toBe(false);
  });

  it('addChildPartition throws for an unknown parent', () => {
    const r = freshRouter();
    expect(() =>
      r.addChildPartition('orders_p1', 'nope', 0, 100),
    ).toThrow(/not a partitioned table/);
  });

  it('sorts children with the default partition last', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_mid', 'orders', 100, 200);
    r.addChildPartition('orders_low', 'orders', 0, 100);
    r.addChildPartition('orders_default', 'orders', null, null, true);

    const def = r.getPartition('orders')!;
    // default always sorts last; non-default sorted by rangeFrom.
    expect(def.children.map((c) => c.childTable)).toEqual([
      'orders_low',
      'orders_mid',
      'orders_default',
    ]);
  });

  it('removeChildPartition drops a child and no-ops for unknown parent', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_p1', 'orders', 0, 100);

    r.removeChildPartition('orders_p1', 'orders');
    expect(r.getPartition('orders')!.children).toHaveLength(0);

    // Unknown parent is a no-op (no throw).
    expect(() => r.removeChildPartition('x', 'nope')).not.toThrow();
  });

  it('getAllPartitions returns all registered defs', () => {
    const r = freshRouter();
    r.registerPartitionedTable('a', 'range', 'k');
    r.registerPartitionedTable('b', 'list', 'k');
    expect(r.getAllPartitions().map((d) => d.parentTable)).toEqual(['a', 'b']);
  });
});

describe('PartitionRouter INSERT routing', () => {
  function rangeRouter(): PartitionRouter {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_p1', 'orders', 0, 100);
    r.addChildPartition('orders_p2', 'orders', 100, 200);
    r.addChildPartition('orders_default', 'orders', null, null, true);
    return r;
  }

  it('routes an INSERT to the matching range child', () => {
    const r = rangeRouter();
    const res = r.routeInsert('orders', 'INSERT INTO orders VALUES (1)', 50);
    expect(res.routed).toBe(true);
    expect(res.targetTable).toBe('orders_p1');
    expect(res.sql).toBe('INSERT INTO orders_p1 VALUES (1)');
  });

  it('routes to the default partition when no range matches', () => {
    const r = rangeRouter();
    const res = r.routeInsert('orders', 'INSERT INTO orders VALUES (1)', 999);
    expect(res.targetTable).toBe('orders_default');
  });

  it('throws when no partition (not even default) matches', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_p1', 'orders', 0, 100);
    expect(() =>
      r.routeInsert('orders', 'INSERT INTO orders VALUES (1)', 500),
    ).toThrow(/No partition found/);
  });

  it('returns unrouted result for a non-partitioned table', () => {
    const r = freshRouter();
    const res = r.routeInsert('plain', 'INSERT INTO plain VALUES (1)', 5);
    expect(res.routed).toBe(false);
    expect(res.targetTable).toBe('plain');
    expect(res.sql).toBe('INSERT INTO plain VALUES (1)');
  });

  it('routes list-partitioned inserts by value', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'list', 'region');
    r.addChildPartition('orders_eu', 'orders', null, null, false, ['EU', 'UK']);
    r.addChildPartition('orders_na', 'orders', null, null, false, ['US', 'CA']);
    r.addChildPartition('orders_default', 'orders', null, null, true);

    const res = r.routeInsert('orders', 'INSERT INTO orders VALUES (1)', 'US');
    expect(res.targetTable).toBe('orders_na');
  });

  it('routes hash-partitioned inserts by hashed remainder', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'hash', 'id');
    r.addChildPartition('orders_h0', 'orders', null, null, false, undefined, 4, 0);
    r.addChildPartition('orders_h1', 'orders', null, null, false, undefined, 4, 1);
    r.addChildPartition('orders_h2', 'orders', null, null, false, undefined, 4, 2);
    r.addChildPartition('orders_h3', 'orders', null, null, false, undefined, 4, 3);

    // value 10 → hash 10 % 4 = 2.
    const res = r.routeInsert('orders', 'INSERT INTO orders VALUES (1)', 10);
    expect(res.targetTable).toBe('orders_h2');
  });
});

describe('PartitionRouter SELECT pruning', () => {
  function rangeRouter(): PartitionRouter {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_p1', 'orders', 0, 100);
    r.addChildPartition('orders_p2', 'orders', 100, 200);
    r.addChildPartition('orders_p3', 'orders', 200, 300);
    return r;
  }

  it('returns the parent unchanged for an unknown table', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('nope', 'SELECT * FROM nope', []);
    expect(res.targetTables).toEqual(['nope']);
    expect(res.sql).toBe('SELECT * FROM nope');
  });

  it('scans all children when no predicates are given', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('orders', 'SELECT * FROM orders WHERE x = 1');
    expect(res.targetTables).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
  });

  it('prunes range with an equality predicate to a single child', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '=', value: 150 },
    ]);
    expect(res.targetTables).toEqual(['orders_p2']);
  });

  it('prunes range with a >= predicate', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '>=', value: 150 },
    ]);
    // rangeTo > 150 → p2 (to 200) and p3 (to 300) qualify; p1 (to 100) does not.
    expect(res.targetTables).toEqual(['orders_p2', 'orders_p3']);
  });

  it('prunes range with a < predicate', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '<', value: 100 },
    ]);
    // rangeFrom < 100 → p1 (from 0) qualifies; p2 (from 100) not (< strict).
    expect(res.targetTables).toEqual(['orders_p1']);
  });

  it('prunes range with BETWEEN', () => {
    const r = rangeRouter();
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: 'BETWEEN', value: null, values: [50, 150] },
    ]);
    expect(res.targetTables).toEqual(['orders_p1', 'orders_p2']);
  });

  it('prunes list partitions by IN values', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'list', 'region');
    r.addChildPartition('orders_eu', 'orders', null, null, false, ['EU', 'UK']);
    r.addChildPartition('orders_na', 'orders', null, null, false, ['US', 'CA']);
    r.addChildPartition('orders_ap', 'orders', null, null, false, ['JP', 'CN']);

    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: 'IN', value: null, values: ['US', 'JP'] },
    ]);
    expect(res.targetTables).toEqual(['orders_na', 'orders_ap']);
  });

  it('prunes list partitions by equality', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'list', 'region');
    r.addChildPartition('orders_eu', 'orders', null, null, false, ['EU', 'UK']);
    r.addChildPartition('orders_na', 'orders', null, null, false, ['US', 'CA']);

    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '=', value: 'EU' },
    ]);
    expect(res.targetTables).toEqual(['orders_eu']);
  });

  it('prunes hash partitions by equality', () => {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'hash', 'id');
    r.addChildPartition('orders_h0', 'orders', null, null, false, undefined, 4, 0);
    r.addChildPartition('orders_h1', 'orders', null, null, false, undefined, 4, 1);
    r.addChildPartition('orders_h2', 'orders', null, null, false, undefined, 4, 2);
    r.addChildPartition('orders_h3', 'orders', null, null, false, undefined, 4, 3);

    // 10 % 4 = 2 → h2.
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '=', value: 10 },
    ]);
    expect(res.targetTables).toEqual(['orders_h2']);
  });

  it('falls back to all children when no partition matches', () => {
    const r = rangeRouter();
    // = 999 matches nothing (and no default partition).
    const res = r.pruneSelect('orders', 'SELECT * FROM orders', [
      { op: '=', value: 999 },
    ]);
    expect(res.targetTables).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
    expect(res.sql).toBe('SELECT * FROM orders');
  });

  it('rewrites a multi-partition scan preserving the original SELECT list and WHERE', () => {
    const r = rangeRouter();
    const res = r.pruneSelect(
      'orders',
      'SELECT id, name FROM orders WHERE name = \'x\'',
      [{ op: '>=', value: 0 }],
    );
    // All three children match >= 0.
    expect(res.targetTables).toEqual(['orders_p1', 'orders_p2', 'orders_p3']);
    // The projection and WHERE must survive the UNION ALL rewrite.
    expect(res.sql).toContain('SELECT id, name FROM');
    expect(res.sql).toContain("WHERE name = 'x'");
    expect(res.sql).toContain('UNION ALL');
    expect(res.sql).toContain('orders_p1');
    expect(res.sql).toContain('orders_p2');
    expect(res.sql).toContain('orders_p3');
  });

  it('preserves the original SELECT when a single child matches', () => {
    const r = rangeRouter();
    const res = r.pruneSelect(
      'orders',
      'SELECT id FROM orders WHERE id = 150',
      [{ op: '=', value: 150 }],
    );
    expect(res.targetTables).toEqual(['orders_p2']);
    expect(res.sql).toBe('SELECT id FROM orders_p2 WHERE id = 150');
  });
});

describe('PartitionRouter extractWhereClause', () => {
  it('returns the WHERE clause up to ORDER BY', () => {
    const s = PartitionRouter.extractWhereClause(
      'SELECT * FROM t WHERE a = 1 ORDER BY b',
    );
    expect(s).toBe('a = 1');
  });

  it('returns the full tail when no following clause exists', () => {
    const s = PartitionRouter.extractWhereClause('SELECT * FROM t WHERE a = 1');
    expect(s).toBe('a = 1');
  });

  it('returns null when no WHERE exists', () => {
    expect(PartitionRouter.extractWhereClause('SELECT * FROM t')).toBeNull();
  });
});

describe('PartitionRouter DML routing', () => {
  function rangeRouter(): PartitionRouter {
    const r = freshRouter();
    r.registerPartitionedTable('orders', 'range', 'id');
    r.addChildPartition('orders_p1', 'orders', 0, 100);
    r.addChildPartition('orders_p2', 'orders', 100, 200);
    return r;
  }

  it('routes DML with a known key to a single child', () => {
    const r = rangeRouter();
    const res = r.routeDML('orders', 'DELETE FROM orders WHERE id = 1', 50);
    expect(res.routed).toBe(true);
    expect(res.targetTable).toBe('orders_p1');
    expect(res.targetTables).toEqual(['orders_p1']);
  });

  it('routes DML without a key to all children', () => {
    const r = rangeRouter();
    const res = r.routeDML('orders', 'DELETE FROM orders', undefined);
    expect(res.routed).toBe(true);
    expect(res.targetTables).toEqual(['orders_p1', 'orders_p2']);
  });

  it('returns unrouted for an unknown table', () => {
    const r = freshRouter();
    const res = r.routeDML('nope', 'DELETE FROM nope', 1);
    expect(res.routed).toBe(false);
    expect(res.targetTable).toBe('nope');
  });
});

describe('PartitionRouter hash string values and fallbacks', () => {
  it('hashes string partition keys deterministically', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'k');
    // Four buckets.
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_h1', 't', null, null, false, undefined, 4, 1);
    r.addChildPartition('t_h2', 't', null, null, false, undefined, 4, 2);
    r.addChildPartition('t_h3', 't', null, null, false, undefined, 4, 3);

    // Same string maps to the same bucket twice.
    const a = r.routeInsert('t', 'INSERT INTO t VALUES (1)', 'hello');
    const b = r.routeInsert('t', 'INSERT INTO t VALUES (1)', 'hello');
    expect(a.targetTable).toBe(b.targetTable);
  });

  it('hashes non-string/non-number values to bucket 0', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'k');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_h1', 't', null, null, false, undefined, 4, 1);

    // boolean → hashValue returns 0 → 0 % 4 = 0 → h0.
    const res = r.routeInsert('t', 'INSERT INTO t VALUES (1)', true);
    expect(res.targetTable).toBe('t_h0');
  });

  it('routes a list insert to the default when no list value matches', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    r.addChildPartition('t_default', 't', null, null, true);

    const res = r.routeInsert('t', 'INSERT INTO t VALUES (1)', 'ZZZ');
    expect(res.targetTable).toBe('t_default');
  });

  it('prunes list with no equality/IN predicate to all children', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    r.addChildPartition('t_na', 't', null, null, false, ['US']);

    // A range predicate is meaningless for list; no =/IN → all children.
    const res = r.pruneSelect('t', 'SELECT * FROM t', [{ op: '>', value: 1 } as any]);
    expect(res.targetTables).toEqual(['t_eu', 't_na']);
  });

  it('prunes hash with no equality predicate to all children', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_h1', 't', null, null, false, undefined, 4, 1);

    const res = r.pruneSelect('t', 'SELECT * FROM t', [{ op: '>', value: 1 } as any]);
    expect(res.targetTables).toEqual(['t_h0', 't_h1']);
  });

  it('compares Date values for range partitioning', () => {
    const r = freshRouter();
    const d1 = new Date('2026-01-01');
    const d2 = new Date('2026-02-01');
    const d3 = new Date('2026-03-01');
    r.registerPartitionedTable('t', 'range', 'created');
    r.addChildPartition('t_p1', 't', d1, d2);
    r.addChildPartition('t_p2', 't', d2, d3);

    const res = r.routeInsert('t', 'INSERT INTO t VALUES (1)', new Date('2026-01-15'));
    expect(res.targetTable).toBe('t_p1');
  });

  it('throws from routeDML when a key has no matching partition', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    expect(() => r.routeDML('t', 'DELETE FROM t', 500)).toThrow(/No partition found/);
  });

  it('routes DML to a list child by value', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    r.addChildPartition('t_na', 't', null, null, false, ['US']);

    const res = r.routeDML('t', 'DELETE FROM t WHERE region = ?', 'US');
    expect(res.targetTable).toBe('t_na');
  });

  it('reset clears all partitions', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    r.reset();
    expect(r.isPartitioned('t')).toBe(false);
    expect(r.getAllPartitions()).toEqual([]);
  });
});

describe('PartitionRouter edge branches', () => {
  it('prunes range partitions by IN predicate', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    r.addChildPartition('t_p2', 't', 100, 200);
    r.addChildPartition('t_p3', 't', 200, 300);

    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'IN', value: null, values: [50, 250] },
    ]);
    expect(res.targetTables).toEqual(['t_p1', 't_p3']);
  });

  it('keeps the default child in a range prune alongside matches', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    r.addChildPartition('t_default', 't', null, null, true);

    const res = r.pruneSelect('t', 'SELECT * FROM t', [{ op: '=', value: 50 }]);
    // p1 matches, and the default partition is always included.
    expect(res.targetTables).toEqual(['t_p1', 't_default']);
  });

  it('keeps the default child in a list prune', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    r.addChildPartition('t_default', 't', null, null, true);

    const res = r.pruneSelect('t', 'SELECT * FROM t', [{ op: '=', value: 'EU' }]);
    expect(res.targetTables).toEqual(['t_eu', 't_default']);
  });

  it('keeps the default child in a hash prune', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_default', 't', null, null, true);

    const res = r.pruneSelect('t', 'SELECT * FROM t', [{ op: '=', value: 9 }]);
    // 9 % 4 = 1, but only h0 (remainder 0) exists plus default.
    expect(res.targetTables).toContain('t_default');
  });

  it('prunes hash partitions by IN predicate', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_h1', 't', null, null, false, undefined, 4, 1);
    r.addChildPartition('t_h2', 't', null, null, false, undefined, 4, 2);
    r.addChildPartition('t_h3', 't', null, null, false, undefined, 4, 3);

    // IN (4, 5) → 4%4=0, 5%4=1 → h0 and h1.
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'IN', value: null, values: [4, 5] },
    ]);
    expect(res.targetTables).toEqual(['t_h0', 't_h1']);
  });

  it('sorts children with default in the middle to the end', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_default', 't', null, null, true);
    r.addChildPartition('t_low', 't', 0, 100);
    r.addChildPartition('t_high', 't', 100, 200);

    const def = r.getPartition('t')!;
    expect(def.children.map((c) => c.childTable)).toEqual([
      't_low',
      't_high',
      't_default',
    ]);
  });

  it('routes a hash insert through the default when no remainder matches', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    r.addChildPartition('t_default', 't', null, null, true);

    // value 7 → 7 % 4 = 3, no child has remainder 3 → default.
    const res = r.routeInsert('t', 'INSERT INTO t VALUES (1)', 7);
    expect(res.targetTable).toBe('t_default');
  });

  it('returns all children for DML when no key is provided', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    r.addChildPartition('t_default', 't', null, null, true);

    // default children are excluded from multi-target DML.
    const res = r.routeDML('t', 'DELETE FROM t', undefined);
    expect(res.targetTables).toEqual(['t_p1']);
  });
});

describe('PartitionRouter defensive/illegal inputs', () => {
  it('handles a hash child with remainder zero when sorting', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h1', 't', null, null, false, undefined, 4, 1);
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    // remainder 0 (falsy) exercises the `|| 0` fallback in the sort comparator.
    expect(r.getPartition('t')!.children.map((c) => c.childTable)).toEqual([
      't_h0',
      't_h1',
    ]);
  });

  it('extracts a WHERE clause from a SQL string starting with WHERE', () => {
    // whereMatch.index === 0 exercises the `|| 0` fallback.
    expect(PartitionRouter.extractWhereClause('WHERE a = 1')).toBe('a = 1');
  });

  it('does not crash on an unknown range predicate op', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    // Unknown op falls through to `default: return true` (matches everything).
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'LIKE' as any, value: 'x' },
    ]);
    expect(res.targetTables).toEqual(['t_p1']);
  });

  it('prunes range with an IN predicate lacking values (treated as no match)', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    r.addChildPartition('t_p1', 't', 0, 100);
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'IN', value: null, values: undefined as any },
    ]);
    // (p.values || []) is empty → no value qualifies → fallback to all.
    expect(res.targetTables).toEqual(['t_p1']);
  });

  it('prunes list with an IN predicate lacking values', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'IN', value: null, values: undefined as any },
    ]);
    // No matched values → all children.
    expect(res.targetTables).toEqual(['t_eu']);
  });

  it('prunes list with a child lacking listValues', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'list', 'region');
    r.addChildPartition('t_empty', 't', null, null, false); // no listValues
    r.addChildPartition('t_eu', 't', null, null, false, ['EU']);
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: '=', value: 'EU' },
    ]);
    // t_empty has no listValues → `(child.listValues || [])` empty side.
    expect(res.targetTables).toEqual(['t_eu']);
  });

  it('prunes hash with an IN predicate lacking values', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'hash', 'id');
    r.addChildPartition('t_h0', 't', null, null, false, undefined, 4, 0);
    const res = r.pruneSelect('t', 'SELECT * FROM t', [
      { op: 'IN', value: null, values: undefined as any },
    ]);
    expect(res.targetTables).toEqual(['t_h0']);
  });

  it('returns unrouted DML for a partitioned table with no children', () => {
    const r = freshRouter();
    r.registerPartitionedTable('t', 'range', 'id');
    // No children → routeDML returns unrouted.
    const res = r.routeDML('t', 'DELETE FROM t', undefined);
    expect(res.routed).toBe(false);
    expect(res.targetTable).toBe('t');
  });
});

describe('PartitionRouter unknown strategy fallback', () => {
  it('falls back to the default child for an unknown strategy', () => {
    const r = freshRouter();
    // Strategy is TypedScript-union 'range'|'list'|'hash'; an illegal runtime
    // value exercises the findChild switch default branch.
    r.registerPartitionedTable('t', 'unknown' as any, 'id');
    r.addChildPartition('t_default', 't', null, null, true);

    const res = r.routeInsert('t', 'INSERT INTO t VALUES (1)', 5);
    // findChild hits the default case and returns the default partition.
    expect(res.targetTable).toBe('t_default');
  });
});
