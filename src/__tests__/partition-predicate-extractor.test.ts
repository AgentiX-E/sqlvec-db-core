/**
 * Unit tests for PartitionPredicateExtractor.
 *
 * This module drives partition pruning: it pulls `partition_key = value`
 * predicates out of a SELECT's WHERE clause so only the relevant partitions are
 * scanned. Getting these predicates wrong — silently dropping a predicate or
 * mis-typing a value — means either a full-table scan (correct but slow) or,
 * worse, scanning the *wrong* partition (incorrect results).
 *
 * The tests below pin the correct behaviour for the common predicate shapes
 * (=, ranges, IN, BETWEEN) and, critically, the literal-handling edge cases
 * that a regex-only approach gets wrong: string values containing spaces or
 * commas, SQL escaped quotes, scientific notation, booleans, and type casts.
 */
import { describe, it, expect } from 'vitest';
import {
  extractWhereClause,
  extractPartitionPredicates,
} from '../query/PartitionPredicateExtractor';

describe('extractWhereClause', () => {
  it('returns null when there is no WHERE clause', () => {
    expect(extractWhereClause('SELECT * FROM t')).toBeNull();
  });

  it('extracts the text between WHERE and the next clause', () => {
    expect(extractWhereClause('SELECT * FROM t WHERE id = 1 ORDER BY x')).toBe('id = 1');
    expect(extractWhereClause('SELECT * FROM t WHERE id = 1 GROUP BY y')).toBe('id = 1');
    expect(extractWhereClause('SELECT * FROM t WHERE id = 1 LIMIT 10')).toBe('id = 1');
    expect(extractWhereClause('SELECT * FROM t WHERE id = 1 HAVING count(*) > 1')).toBe('id = 1');
  });

  it('extracts everything after WHERE when no later clause follows', () => {
    expect(extractWhereClause('SELECT * FROM t WHERE id=1')).toBe('id=1');
  });

  it('matches WHERE case-insensitively', () => {
    expect(extractWhereClause('SELECT * FROM t where id = 1')).toBe('id = 1');
  });

  it('does not treat WHERE inside a string literal as the clause start', () => {
    // The leading "WHERE" is inside a quoted string; only the real one counts,
    // but simplest: a column name/value containing the word WHERE must not
    // confuse the top-level WHERE detection.
    expect(extractWhereClause("SELECT * FROM t WHERE note = 'WHERE is it'")).toBe(
      "note = 'WHERE is it'",
    );
  });

  it('handles a WHERE clause starting at index 0', () => {
    expect(extractWhereClause('WHERE id = 5')).toBe('id = 5');
  });
});

describe('extractPartitionPredicates — equality', () => {
  it('extracts a simple equality predicate with an integer value', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 5', 'id')).toEqual([
      { col: 'id', op: '=', value: 5 },
    ]);
  });

  it('infers a negative integer value', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = -5', 'id')).toEqual([
      { col: 'id', op: '=', value: -5 },
    ]);
  });

  it('infers a float value', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 5.5', 'id')).toEqual([
      { col: 'id', op: '=', value: 5.5 },
    ]);
  });

  it('infers a null value (any casing)', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = NULL', 'id')).toEqual([
      { col: 'id', op: '=', value: null },
    ]);
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = Null', 'id')).toEqual([
      { col: 'id', op: '=', value: null },
    ]);
  });

  it('strips surrounding single quotes from a string value', () => {
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id = 'abc'", 'id')).toEqual([
      { col: 'id', op: '=', value: 'abc' },
    ]);
  });

  it('preserves a string value containing spaces', () => {
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id = 'hello world'", 'id')).toEqual([
      { col: 'id', op: '=', value: 'hello world' },
    ]);
  });

  it('decodes SQL doubled-quote escapes inside a string value', () => {
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id = 'it''s'", 'id')).toEqual([
      { col: 'id', op: '=', value: "it's" },
    ]);
  });

  it('matches a double-quoted partition key', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE "id" = 5', 'id')).toEqual([
      { col: 'id', op: '=', value: 5 },
    ]);
  });

  it('infers scientific-notation numbers as numbers', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 1e10', 'id')).toEqual([
      { col: 'id', op: '=', value: 1e10 },
    ]);
  });

  it('infers boolean literals as booleans', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = true', 'id')).toEqual([
      { col: 'id', op: '=', value: true },
    ]);
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = false', 'id')).toEqual([
      { col: 'id', op: '=', value: false },
    ]);
  });

  it('strips a trailing type cast before inferring the value type', () => {
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id = '5'::int", 'id')).toEqual([
      { col: 'id', op: '=', value: 5 },
    ]);
  });

  it('strips a trailing type cast on a bare numeric literal', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 5::text', 'id')).toEqual([
      { col: 'id', op: '=', value: 5 },
    ]);
  });

  it('treats a double-quoted value as a string identifier', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = "abc"', 'id')).toEqual([
      { col: 'id', op: '=', value: 'abc' },
    ]);
  });

  it('decodes doubled double-quote escapes inside an identifier value', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = "a""b"', 'id')).toEqual([
      { col: 'id', op: '=', value: 'a"b' },
    ]);
  });

  it('keeps a non-numeric bare token as a string', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 0x1F', 'id')).toEqual([
      { col: 'id', op: '=', value: '0x1F' },
    ]);
  });

  it('ignores a non-partition-key predicate with an unsupported operator', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id != 5', 'id')).toEqual([]);
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id LIKE 'x%'", 'id')).toEqual([]);
  });
});

describe('extractPartitionPredicates — ranges', () => {
  it('extracts greater/less than and equality operators', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id >= 5 AND id < 10', 'id')).toEqual([
      { col: 'id', op: '>=', value: 5 },
      { col: 'id', op: '<', value: 10 },
    ]);
  });

  it('extracts each comparison operator distinctly', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id < 10', 'id')).toEqual([
      { col: 'id', op: '<', value: 10 },
    ]);
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id > 1', 'id')).toEqual([
      { col: 'id', op: '>', value: 1 },
    ]);
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id <= 9', 'id')).toEqual([
      { col: 'id', op: '<=', value: 9 },
    ]);
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id >= 2', 'id')).toEqual([
      { col: 'id', op: '>=', value: 2 },
    ]);
  });
});

describe('extractPartitionPredicates — IN', () => {
  it('extracts an IN list of integers', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id IN (1,2,3)', 'id')).toEqual([
      { col: 'id', op: 'IN', value: null, values: [1, 2, 3] },
    ]);
  });

  it('extracts an IN list of strings', () => {
    expect(
      extractPartitionPredicates("SELECT * FROM t WHERE id IN ('a','b')", 'id'),
    ).toEqual([{ col: 'id', op: 'IN', value: null, values: ['a', 'b'] }]);
  });

  it('does not split an IN list on a comma inside a string value', () => {
    expect(
      extractPartitionPredicates("SELECT * FROM t WHERE id IN ('a,b','c')", 'id'),
    ).toEqual([{ col: 'id', op: 'IN', value: null, values: ['a,b', 'c'] }]);
  });

  it('infers mixed-type IN values independently', () => {
    expect(
      extractPartitionPredicates("SELECT * FROM t WHERE id IN (1,'x',2.5)", 'id'),
    ).toEqual([{ col: 'id', op: 'IN', value: null, values: [1, 'x', 2.5] }]);
  });

  it('matches IN case-insensitively', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id in (1,2)', 'id')).toEqual([
      { col: 'id', op: 'IN', value: null, values: [1, 2] },
    ]);
  });

  it('produces no predicate for an empty IN list', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id IN ()', 'id')).toEqual([]);
  });

  it('produces no predicate for an unbalanced IN list', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id IN (1,2', 'id')).toEqual([]);
  });

  it('tolerates a trailing comma in an IN list', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id IN (1,2,)', 'id')).toEqual([
      { col: 'id', op: 'IN', value: null, values: [1, 2] },
    ]);
  });

  it('does not crash on a nested-parenthesised IN list', () => {
    // A malformed `IN ((1),(2))` must not hang or throw; it degrades to a
    // best-effort extraction or an empty result rather than crashing.
    expect(() =>
      extractPartitionPredicates('SELECT * FROM t WHERE id IN ((1),(2))', 'id'),
    ).not.toThrow();
  });
});

describe('extractPartitionPredicates — BETWEEN', () => {
  it('extracts a BETWEEN range of integers', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id BETWEEN 1 AND 10', 'id')).toEqual([
      { col: 'id', op: 'BETWEEN', value: null, values: [1, 10] },
    ]);
  });

  it('extracts a BETWEEN range with negative/fractional bounds', () => {
    expect(
      extractPartitionPredicates('SELECT * FROM t WHERE id BETWEEN -5 AND 5.5', 'id'),
    ).toEqual([{ col: 'id', op: 'BETWEEN', value: null, values: [-5, 5.5] }]);
  });

  it('extracts a BETWEEN range with string bounds containing spaces', () => {
    expect(
      extractPartitionPredicates("SELECT * FROM t WHERE id BETWEEN 'a b' AND 'c d'", 'id'),
    ).toEqual([{ col: 'id', op: 'BETWEEN', value: null, values: ['a b', 'c d'] }]);
  });

  it('treats the AND inside BETWEEN as part of the range, not a separator', () => {
    expect(
      extractPartitionPredicates("SELECT * FROM t WHERE id BETWEEN 1 AND 10 AND name = 'x'", 'id'),
    ).toEqual([{ col: 'id', op: 'BETWEEN', value: null, values: [1, 10] }]);
  });

  it('produces no predicate for a BETWEEN missing its AND bound', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id BETWEEN 1', 'id')).toEqual([]);
  });

  it('tolerates parenthesised BETWEEN bounds without crashing', () => {
    expect(() =>
      extractPartitionPredicates('SELECT * FROM t WHERE id BETWEEN (1) AND (10)', 'id'),
    ).not.toThrow();
  });
});

describe('extractPartitionPredicates — conjunction handling', () => {
  it('ignores non-partition-key predicates', () => {
    expect(extractPartitionPredicates("SELECT * FROM t WHERE id = 5 AND name = 'x'", 'id')).toEqual([
      { col: 'id', op: '=', value: 5 },
    ]);
  });

  it('skips OR branches entirely', () => {
    expect(extractPartitionPredicates('SELECT * FROM t WHERE id = 5 OR id = 6', 'id')).toEqual([]);
  });

  it('skips a parenthesised OR expression entirely', () => {
    // The whole predicate is wrapped in parentheses with an inner OR, which is
    // a complex shape this extractor intentionally declines to reason about.
    expect(
      extractPartitionPredicates('SELECT * FROM t WHERE (id = 5 OR other = 1)', 'id'),
    ).toEqual([]);
  });

  it('does not split on AND inside parentheses', () => {
    // A parenthesised subexpression keeps its inner AND intact.
    expect(
      extractPartitionPredicates('SELECT * FROM t WHERE id = 5 AND (name = 1)', 'id'),
    ).toEqual([{ col: 'id', op: '=', value: 5 }]);
  });

  it('returns an empty list when there is no WHERE clause', () => {
    expect(extractPartitionPredicates('SELECT * FROM t', 'id')).toEqual([]);
  });
});
