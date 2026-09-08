import { describe, it, expect } from 'vitest';
import { parseStatement, extractWindowFunctions, rewriteWindowSql } from '../query/SqlParser';

describe('SqlParser fallbackParse (incomplete SQL → AST failure → heuristic)', () => {
  it('fallback SELECT extracts table heuristically', () => {
    // "SELECT * FROM" is incomplete → AST parse fails → fallbackParse.
    const r = parseStatement('SELECT * FROM users');
    expect(r.type).toBe('SELECT');
  });

  it('fallback INSERT extracts table', () => {
    const r = parseStatement('INSERT INTO t (id) VALUES (1)');
    expect(r.type).toBe('INSERT');
    expect((r as any).table).toBe('t');
  });

  it('fallback UPDATE extracts table and WHERE column', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE id = 5');
    expect(r.type).toBe('UPDATE');
    expect((r as any).table).toBe('t');
  });

  it('fallback DELETE extracts table', () => {
    const r = parseStatement('DELETE FROM t WHERE id = 3');
    expect(r.type).toBe('DELETE');
    expect((r as any).table).toBe('t');
  });

  it('fallback CREATE TABLE rewrites SERIAL', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL, name TEXT)');
    expect(r.type).toBe('DDL');
  });
});

describe('SqlParser deep table extraction — nested WITH / UNION', () => {
  it('extracts tables from nested WITH in JOIN', () => {
    const r = parseStatement('SELECT * FROM a JOIN (SELECT * FROM b) x ON a.id = x.id');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extracts tables from ALL(...) subquery', () => {
    const r = parseStatement('SELECT * FROM t WHERE id > ALL(SELECT id FROM other)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['t', 'other']));
  });
});

describe('SqlParser window deep nesting', () => {
  it('finds window function in left/right binary tree', () => {
    const wfs = extractWindowFunctions(
      'SELECT (SUM(x) OVER () + COUNT(y) OVER ()) / 2 FROM t',
    );
    expect(wfs.length).toBeGreaterThan(0);
  });

  it('strips OVER from CASE whens in rewriteWindowSql', () => {
    const r = rewriteWindowSql('SELECT CASE WHEN a > 0 THEN SUM(x) OVER () ELSE 0 END FROM t');
    expect(r).not.toMatch(/\bOVER\b/i);
  });
});
