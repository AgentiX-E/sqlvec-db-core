import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover extractSubqueryTablesFromExpr's ANY/ALL/SOME subquery branches, which
// pgsql-ast-parser v12 emits as { type: 'call', function: { name: 'any'|'all'|
// 'some' }, args: [select] }.
describe('SqlParser ANY/ALL/SOME subquery table extraction', () => {
  it('extracts table from ANY subquery', () => {
    const r = parseStatement('SELECT * FROM t WHERE a = ANY (SELECT x FROM u)') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toContain('u');
    expect(r.tables).toContain('t');
  });

  it('extracts table from ALL subquery', () => {
    const r = parseStatement('SELECT * FROM t WHERE a > ALL (SELECT x FROM u)') as any;
    expect(r.tables).toContain('u');
  });

  it('extracts table from SOME subquery', () => {
    const r = parseStatement('SELECT * FROM t WHERE a = SOME (SELECT x FROM u)') as any;
    expect(r.tables).toContain('u');
  });
});
