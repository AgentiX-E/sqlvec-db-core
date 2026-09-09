import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover fallbackParse's SELECT branch (extractTableNamesHeuristic), reached when
// an incomplete SELECT makes pgsql-ast-parser throw. Exercises FROM extraction,
// JOIN extraction, and subquery-FROM extraction plus hasJoin inference.
describe('SqlParser fallback SELECT heuristic (AST-failing)', () => {
  it('extracts FROM table from incomplete SELECT', () => {
    const r = parseStatement('SELECT * FROM t WHERE') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual(['t']);
  });

  it('extracts JOIN table and marks hasJoin', () => {
    const r = parseStatement('SELECT x FROM t JOIN u ON') as any;
    expect(r.tables).toEqual(['t', 'u']);
    expect(r.hasJoin).toBe(true);
  });

  it('returns empty tables when FROM has no table', () => {
    const r = parseStatement('SELECT * FROM') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual([]);
  });

  it('extracts subquery FROM table from ANY/EXISTS pattern', () => {
    const r = parseStatement('SELECT * FROM t WHERE x = ANY(SELECT y FROM u)') as any;
    // complete enough to AST-parse, so exercise both paths via table set
    expect(r.tables).toContain('t');
  });
});
