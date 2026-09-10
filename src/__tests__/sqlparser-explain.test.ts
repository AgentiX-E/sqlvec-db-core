import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser v12 rejects EXPLAIN, so it fell through fallbackParse to
// UNKNOWN and lost the wrapped statement's tables. Lock the fix: EXPLAIN
// (with optional ANALYZE/VERBOSE and parenthesized options) unwraps to the
// inner statement so it routes correctly.
describe('SqlParser EXPLAIN unwrapping', () => {
  it('routes EXPLAIN SELECT to the wrapped table', () => {
    expect((parseStatement('EXPLAIN SELECT * FROM t') as any).tables).toEqual(['t']);
  });

  it('handles EXPLAIN ANALYZE', () => {
    expect((parseStatement('EXPLAIN ANALYZE SELECT * FROM t') as any).tables).toEqual(['t']);
  });

  it('handles EXPLAIN (options)', () => {
    expect((parseStatement('EXPLAIN (FORMAT JSON) SELECT * FROM t') as any).tables).toEqual(['t']);
  });

  it('handles EXPLAIN VERBOSE with a WHERE clause', () => {
    expect((parseStatement('EXPLAIN VERBOSE SELECT * FROM t WHERE id = 5') as any).tables).toEqual(['t']);
  });

  it('extracts join tables from an EXPLAIN ANALYZE VERBOSE query', () => {
    expect(
      (parseStatement('EXPLAIN ANALYZE VERBOSE SELECT a.id FROM a JOIN b ON a.id = b.id') as any).tables,
    ).toEqual(['a', 'b']);
  });
});
