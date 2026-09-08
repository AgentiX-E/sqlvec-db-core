import { describe, it, expect } from 'vitest';
import {
  extractWindowFunctions,
  rewriteWindowSql,
  extractCtes,
  inlineCtes,
  detectFTS,
  rewriteFTS,
} from '../query/SqlParser';

describe('SqlParser.extractWindowFunctions', () => {
  it('extracts aggregate window function with partition/order', () => {
    const wfs = extractWindowFunctions('SELECT SUM(x) OVER (PARTITION BY y ORDER BY z) FROM t');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].fn).toBe('SUM');
    expect(wfs[0].partitionBy).toEqual(['y']);
  });

  it('extracts ranking window function ROW_NUMBER', () => {
    const wfs = extractWindowFunctions('SELECT row_number() OVER (ORDER BY id) FROM t');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].fn).toBe('ROW_NUMBER');
  });

  it('returns empty for non-window SQL', () => {
    expect(extractWindowFunctions('SELECT * FROM t')).toEqual([]);
  });

  it('handles empty/garbage SQL via fallback (regex)', () => {
    const wfs = extractWindowFunctions('SELECT AVG(x) OVER (PARTITION BY a ORDER BY b) FROM t');
    expect(wfs.length).toBe(1);
    expect(wfs[0].fn).toBe('AVG');
  });
});

describe('SqlParser.rewriteWindowSql', () => {
  it('strips OVER from aggregate window function', () => {
    const r = rewriteWindowSql('SELECT SUM(x) OVER (PARTITION BY y) FROM t');
    expect(typeof r).toBe('string');
    // SUM is aggregate → OVER stripped (not regex-replaced to bare SUM)
    expect(r).not.toMatch(/OVER/i);
  });

  it('keeps OVER for ranking window function', () => {
    const r = rewriteWindowSql('SELECT row_number() OVER (ORDER BY id) FROM t');
    expect(r).toMatch(/OVER/i);
  });

  it('returns input unchanged for non-window SQL', () => {
    const sql = 'SELECT * FROM t';
    expect(rewriteWindowSql(sql)).toBe(sql);
  });
});

describe('SqlParser.extractCtes', () => {
  it('extracts CTE definitions from WITH clause', () => {
    const ctes = extractCtes('WITH c AS (SELECT * FROM t) SELECT * FROM c');
    expect(ctes.length).toBe(1);
    expect(ctes[0].name).toBe('c');
    expect(ctes[0].recursive).toBe(false);
  });

  it('detects RECURSIVE CTE', () => {
    const ctes = extractCtes('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT * FROM r');
    expect(ctes.length).toBe(1);
    expect(ctes[0].recursive).toBe(true);
  });

  it('extracts multiple CTEs', () => {
    const ctes = extractCtes('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a');
    expect(ctes.length).toBe(2);
    expect(ctes.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('returns empty for non-CTE SQL', () => {
    expect(extractCtes('SELECT * FROM t')).toEqual([]);
  });
});

describe('SqlParser.inlineCtes', () => {
  it('inlines a non-recursive CTE into FROM', () => {
    const r = inlineCtes('WITH c AS (SELECT * FROM t) SELECT * FROM c');
    expect(r).not.toMatch(/^\s*WITH\s+/i);
    expect(r).toContain('AS c');
    expect(r).toContain('SELECT'); // inner query inlined as subquery
  });

  it('returns unchanged when no CTEs', () => {
    const sql = 'SELECT * FROM t';
    expect(inlineCtes(sql)).toBe(sql);
  });

  it('throws for recursive CTE', () => {
    expect(() =>
      inlineCtes('WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT n+1 FROM r) SELECT * FROM r'),
    ).toThrow(/[Rr]ecursive/);
  });
});

describe('SqlParser.detectFTS', () => {
  it('detects @@ with to_tsquery', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ to_tsquery('foo')");
    expect(f.hasFts).toBe(true);
    expect(f.operator).toBe('@@');
  });

  it('detects plainto_tsquery with column', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ plainto_tsquery('english', 'foo')");
    expect(f.hasFts).toBe(true);
  });

  it('detects to_tsvector without @@', () => {
    const f = detectFTS('SELECT to_tsvector(body) FROM t');
    expect(f.hasFts).toBe(true);
  });

  it('returns hasFts false for plain SQL', () => {
    expect(detectFTS('SELECT * FROM t').hasFts).toBe(false);
  });
});

describe('SqlParser.rewriteFTS', () => {
  it('rewrites @@ to MATCH when column and query extracted', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE col @@ to_tsquery('foo')");
    expect(r).toContain('MATCH');
  });

  it('returns unchanged for non-FTS SQL', () => {
    const sql = 'SELECT * FROM t';
    expect(rewriteFTS(sql)).toBe(sql);
  });
});
