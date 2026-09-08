import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  extractWindowFunctions,
  rewriteWindowSql,
  extractCtes,
} from '../query/SqlParser';

describe('SqlParser collectRefColumns deep recursion (UPDATE/DELETE WHERE)', () => {
  it('extracts columns from function call args in WHERE', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE lower(name) = lower(target)');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['name', 'target']));
  });

  it('extracts columns from IN clause', () => {
    const r = parseStatement('DELETE FROM t WHERE id IN (1, 2, 3) AND status = \'active\'');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['id', 'status']));
  });

  it('extracts columns from subquery in WHERE (call select)', () => {
    const r = parseStatement('DELETE FROM t WHERE id IN (SELECT id FROM archive)');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['id']));
  });

  it('extracts columns from nested AND/OR expression', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE (a = 1 OR b = 2) AND c = 3');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });
});

describe('SqlParser findWindowFunctionsInExpr deep recursion', () => {
  it('finds window function nested in binary expression', () => {
    const wfs = extractWindowFunctions('SELECT SUM(x) OVER () + 1 AS total FROM t');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].fn).toBe('SUM');
  });

  it('finds window function in CASE WHEN result', () => {
    const wfs = extractWindowFunctions('SELECT CASE WHEN a > 0 THEN SUM(x) OVER () END FROM t');
    expect(wfs.length).toBeGreaterThan(0);
  });

  it('extracts orderBy direction DESC for window', () => {
    const wfs = extractWindowFunctions('SELECT SUM(x) OVER (ORDER BY y DESC) FROM t');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].orderBy).toEqual([{ key: 'y', dir: 'DESC' }]);
  });

  it('extracts window with partitionBy via ref name', () => {
    const wfs = extractWindowFunctions('SELECT RANK() OVER (PARTITION BY dept ORDER BY sal DESC) FROM emp');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].partitionBy).toEqual(['dept']);
  });
});

describe('SqlParser rewriteWindowSql stripOver recursion', () => {
  it('strips OVER from aggregate in nested expression', () => {
    const r = rewriteWindowSql('SELECT (SUM(x) OVER (PARTITION BY y) + 1) FROM t');
    expect(r).not.toMatch(/OVER/i);
  });

  it('strips OVER from multiple aggregate window functions', () => {
    const r = rewriteWindowSql('SELECT SUM(x) OVER (), COUNT(y) OVER () FROM t');
    expect(r).not.toMatch(/OVER/i);
  });
});

describe('SqlParser extractCtes fallback (columns alias)', () => {
  it('extracts CTE with column aliases', () => {
    // Column alias list forces the columns branch in fallback (via REGEX if AST succeeds)
    const sql = 'WITH c (a, b) AS (SELECT x, y FROM t) SELECT * FROM c';
    const ctes = extractCtes(sql);
    expect(ctes.length).toBeGreaterThan(0);
  });
});

describe('SqlParser parseStatement switch default (unknown / DDL-like)', () => {
  it('routes CREATE VIRTUAL TABLE to DDL', () => {
    const r = parseStatement('CREATE VIRTUAL TABLE vt USING fts5');
    expect(r.type).toBe('DDL');
  });

  it('routes DROP INDEX via fallback', () => {
    const r = parseStatement('DROP INDEX idx');
    expect(r.type).toBe('DDL');
  });
});
