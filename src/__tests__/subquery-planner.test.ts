import { describe, it, expect } from 'vitest';
import {
  analyzeSubquery,
  hasCorrelatableSubquery,
  extractSubqueryColumn,
} from '../query/SubqueryPlanner';

/**
 * SubqueryPlanner — IN / NOT IN / EXISTS / NOT EXISTS decorrelation analysis.
 *
 * The core contract under test: a subquery that references the outer table
 * (directly by name or via an alias) must be classified as correlated and NOT
 * rewritten, while an uncorrelated subquery may be flattened to a join. Alias
 * handling is the critical regression surface — `FROM orders o` makes `o.id`
 * resolve to an alias reference that must still be recognized as a reference
 * to `orders`.
 */

describe('hasCorrelatableSubquery', () => {
  it('detects IN / NOT IN / EXISTS / NOT EXISTS with a SELECT', () => {
    expect(hasCorrelatableSubquery('SELECT * FROM t WHERE a IN (SELECT x FROM y)')).toBe(true);
    expect(hasCorrelatableSubquery('SELECT * FROM t WHERE a NOT IN (SELECT x FROM y)')).toBe(true);
    expect(hasCorrelatableSubquery('SELECT * FROM t WHERE EXISTS (SELECT 1 FROM y)')).toBe(true);
    expect(hasCorrelatableSubquery('SELECT * FROM t WHERE NOT EXISTS (SELECT 1 FROM y)')).toBe(true);
  });

  it('rejects plain selects and IN-list literals', () => {
    expect(hasCorrelatableSubquery('SELECT * FROM t')).toBe(false);
    expect(hasCorrelatableSubquery('SELECT * FROM t WHERE a IN (1, 2, 3)')).toBe(false);
  });
});

describe('extractSubqueryColumn', () => {
  it('extracts the first column reference', () => {
    expect(extractSubqueryColumn('SELECT order_id FROM items')).toBe('order_id');
  });

  it('returns null for a non-select statement', () => {
    expect(extractSubqueryColumn('INSERT INTO items VALUES (1)')).toBeNull();
  });

  it('returns null for star / non-ref expressions', () => {
    expect(extractSubqueryColumn('SELECT * FROM items')).toBeNull();
    expect(extractSubqueryColumn('SELECT 1 FROM items')).toBeNull();
  });

  it('returns null when the SELECT has no columns', () => {
    expect(extractSubqueryColumn('SELECT FROM items')).toBeNull();
  });

  it('returns null for unparseable SQL', () => {
    expect(extractSubqueryColumn('this is not sql at all ((((')).toBeNull();
  });
});

describe('analyzeSubquery — IN / NOT IN', () => {
  it('rewrites an uncorrelated IN subquery to a semi-join', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id IN (SELECT order_id FROM items)',
      'orders',
    );
    expect(r).not.toBeNull();
    expect(r!.rewritten).toBe(true);
    expect(r!.hasCorrelation).toBe(false);
    expect(r!.rewrittenPlanType).toBe('semi-join');
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: 'id',
      rightTable: 'items',
      rightColumn: 'order_id',
    });
  });

  it('rewrites an uncorrelated NOT IN as an anti-join', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id NOT IN (SELECT order_id FROM items)',
      'orders',
    );
    expect(r!.rewritten).toBe(true);
    expect(r!.rewrittenPlanType).toBe('anti-join');
  });

  it('keeps a correlated IN subquery (real table name)', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE orders.id IN (SELECT order_id FROM items WHERE items.order_id = orders.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('keeps a correlated IN subquery referenced by alias (regression)', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id IN (SELECT order_id FROM items WHERE items.order_id = o.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('returns null for a non-IN binary WHERE', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id = 5',
      'orders',
    );
    expect(r).toBeNull();
  });

  it('returns null for no WHERE clause', () => {
    const r = analyzeSubquery('SELECT * FROM orders', 'orders');
    expect(r).toBeNull();
  });

  it('returns rewritten:false (not a subquery) for IN-list values', () => {
    // IN (1,2,3) — right operand is a list, not a select.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE id IN (1, 2, 3)',
      'orders',
    );
    expect(r).toBeNull();
  });
});

describe('analyzeSubquery — EXISTS / NOT EXISTS', () => {
  it('rewrites an uncorrelated EXISTS as a semi-join', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items)',
      'orders',
    );
    expect(r).not.toBeNull();
    expect(r!.rewritten).toBe(true);
    expect(r!.hasCorrelation).toBe(false);
    expect(r!.rewrittenPlanType).toBe('semi-join');
  });

  it('keeps a correlated EXISTS referenced by alias (regression)', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
    expect(r!.rewrittenPlanType).toBe('semi-join');
  });

  it('keeps a correlated NOT EXISTS referenced by alias', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
    expect(r!.rewrittenPlanType).toBe('anti-join');
  });

  it('extracts a join condition from a correlated EXISTS (alias to real name mapping)', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id)',
      'orders',
    );
    // correlation condition: i.order_id (inner) = o.id (outer alias)
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: 'id',
      rightTable: 'items',
      rightColumn: 'order_id',
    });
  });
});

describe('analyzeSubquery — fallback / guard paths', () => {
  it('returns null for unparseable SQL', () => {
    expect(analyzeSubquery('((( not sql', 'orders')).toBeNull();
  });

  it('returns null for a non-select statement', () => {
    expect(analyzeSubquery('INSERT INTO t VALUES (1)', 't')).toBeNull();
  });

  it('returns null for an empty string (parseFirst yields null)', () => {
    expect(analyzeSubquery('', 'orders')).toBeNull();
  });

  it('returns null for a SELECT with no WHERE', () => {
    expect(analyzeSubquery('SELECT * FROM orders', 'orders')).toBeNull();
  });
});

describe('analyzeSubquery — IN guard branches', () => {
  it('returns rewritten:false when the subquery has no FROM table', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE id IN (SELECT 1)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('returns rewritten:false when the IN left side is not a column ref', () => {
    // `1 IN (SELECT ...)` — left operand is an integer literal, not a ref.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE 1 IN (SELECT order_id FROM items)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('returns rewritten:false when the subquery projects a non-ref column', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE id IN (SELECT 1 FROM items)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('returns rewritten:false when the first FROM item is not a plain table', () => {
    // A derived-table FROM (SELECT ...) as the first FROM item is not a
    // bare `table` type, so extractSubqueryTable returns null.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE id IN (SELECT x FROM (SELECT 1 AS x) AS sub)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('returns rewritten:false when the subquery projects no columns', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE id IN (SELECT FROM items)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });
});

describe('analyzeSubquery — EXISTS guard branches', () => {
  it('returns null for a NOT on a non-exists operand', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE NOT (id = 5)',
      'orders',
    );
    expect(r).toBeNull();
  });

  it('returns rewritten:false for EXISTS with no FROM table', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE EXISTS (SELECT 1)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('derives a default join condition for an uncorrelated EXISTS with a ref column', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE EXISTS (SELECT id FROM items)',
      'orders',
    );
    expect(r!.rewritten).toBe(true);
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: '',
      rightTable: 'items',
      rightColumn: 'id',
    });
  });
});

describe('analyzeSubquery — correlation in HAVING and nested predicates', () => {
  it('detects correlation in the HAVING clause', () => {
    // HAVING references the outer table; no WHERE reference.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i GROUP BY i.x HAVING count(*) > o.min_qty)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('detects correlation nested inside AND/OR in WHERE', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id IN (SELECT order_id FROM items WHERE items.active = 1 AND items.order_id = o.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('detects correlation when the inner column is on the left of "="', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.order_id = o.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
    // inner on the left => outerCol from the right ref
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: 'id',
      rightTable: 'items',
      rightColumn: 'order_id',
    });
  });

  it('traverses function-call arguments when scanning for correlation', () => {
    // `lower(i.name)` is a call node whose `args` array must be walked.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE lower(i.name) = o.name)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('finds a correlation nested inside a function-call argument', () => {
    // The outer reference `o.name` sits inside `lower(...)` args — the array
    // traversal must descend into the argument to detect the correlation.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE lower(o.name) = i.name)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('traverses a multi-table (join) subquery FROM for the inner table', () => {
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id IN (SELECT i.order_id FROM items i JOIN meta m ON m.id = i.id WHERE i.order_id = o.id)',
      'orders',
    );
    // first FROM item is `items` (aliased i)
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });

  it('rewrites a subquery whose WHERE references only the inner table (no correlation)', () => {
    // `items.active = 1` references only the inner table, so the subquery is
    // uncorrelated despite having a WHERE clause.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE o.id IN (SELECT order_id FROM items WHERE items.active = 1)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(false);
    expect(r!.rewritten).toBe(true);
  });

  it('extracts no join condition for an equality on two inner columns', () => {
    // inner.col = inner.col is not an outer↔inner correlation.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i WHERE i.a = i.b)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(false);
    expect(r!.joinCondition).toBeUndefined();
  });

  it('handles a query whose outer SELECT has no FROM clause', () => {
    // collectOuterTableKeys iterates an empty `from ?? []`; the IN left side is
    // a literal (not a ref), so the subquery is not rewritable.
    const r = analyzeSubquery(
      'SELECT 1 WHERE 1 IN (SELECT x FROM items)',
      'orders',
    );
    expect(r).toEqual({ rewritten: false });
  });

  it('returns null when EXISTS wraps a non-select argument', () => {
    // `EXISTS(1)` — args[0] is not a select, so extractExistsCall returns null.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE EXISTS (1)',
      'orders',
    );
    expect(r).toBeNull();
  });

  it('handles an outer table with no alias and an inner table with no alias', () => {
    // Both tables are bare (no alias), exercising the `name.alias` falsy branch
    // in collectOuterTableKeys / extractSubqueryTableKeys.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE orders.id IN (SELECT order_id FROM items WHERE items.order_id = orders.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: 'id',
      rightTable: 'items',
      rightColumn: 'order_id',
    });
  });

  it('detects inner-on-the-left equality for correlation extraction', () => {
    // `items.order_id = orders.id` — inner on left, outer on right.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE EXISTS (SELECT 1 FROM items WHERE items.order_id = orders.id)',
      'orders',
    );
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.joinCondition).toEqual({
      leftTable: 'orders',
      leftColumn: 'id',
      rightTable: 'items',
      rightColumn: 'order_id',
    });
  });

  it('handles an EXISTS subquery with no FROM clause', () => {
    // extractSubqueryTableKeys iterates `subquery.from ?? []` → empty.
    const r = analyzeSubquery(
      'SELECT * FROM orders WHERE EXISTS (SELECT 1 WHERE 1 = 1)',
      'orders',
    );
    // no inner table => cannot build a join condition or classify correlation
    expect(r).toEqual({ rewritten: false });
  });

  it('handles a non-table outer FROM (derived table)', () => {
    // A derived-table FROM item (type `statement`, not `table`) exercises the
    // `fromItem.type === 'table'` false branch in collectOuterTableKeys.
    const r = analyzeSubquery(
      'SELECT * FROM (SELECT 1 AS id) sub WHERE sub.id IN (SELECT order_id FROM items)',
      'orders',
    );
    expect(r).not.toBeNull();
    expect(r!.rewritten).toBe(true);
  });

  it('handles a non-table inner FROM (derived table after a table)', () => {
    // `FROM items i, (SELECT 1 AS x) s` — the second FROM item is a derived
    // table (type `statement`), exercising the `type === 'table'` false branch
    // in extractSubqueryTableKeys while extractSubqueryTable still resolves
    // the first (real) table.
    const r = analyzeSubquery(
      'SELECT * FROM orders o WHERE EXISTS (SELECT 1 FROM items i, (SELECT 1 AS x) s WHERE s.x = o.id)',
      'orders',
    );
    expect(r).not.toBeNull();
    expect(r!.hasCorrelation).toBe(true);
    expect(r!.rewritten).toBe(false);
  });
});
