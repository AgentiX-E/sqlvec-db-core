import { describe, it, expect } from 'vitest';
import { detectFTS, rewriteFTS, extractCtes, inlineCtes } from '../query/SqlParser';

describe('SqlParser detectFTS plainto/phraseto/tsquery variants', () => {
  it('detects plainto_tsquery with config and queryText', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ plainto_tsquery('english', 'hello world')");
    expect(f.hasFts).toBe(true);
    expect(f.configName).toBe('english');
    expect(f.queryText).toBe('hello world');
  });

  it('detects plainto_tsquery with column from tsvector', () => {
    const f = detectFTS("SELECT * FROM t WHERE to_tsvector('english', col) @@ plainto_tsquery('english', 'hello')");
    expect(f.hasFts).toBe(true);
    expect(f.column).toBe('col');
    expect(f.queryText).toBe('hello');
  });

  it('detects phraseto_tsquery', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ phraseto_tsquery('english', 'big data')");
    expect(f.hasFts).toBe(true);
    expect(f.queryText).toBe('big data');
  });

  it('detects to_tsquery with column from tsvector', () => {
    const f = detectFTS("SELECT * FROM t WHERE to_tsvector('english', body) @@ to_tsquery('english', 'foo')");
    expect(f.hasFts).toBe(true);
    expect(f.operator).toBe('@@');
  });

  it('detects @@ without parseable details', () => {
    const f = detectFTS('SELECT * FROM t WHERE a @@ b');
    expect(f.hasFts).toBe(true);
    expect(f.operator).toBe('@@');
  });

  it('detects to_tsvector without @@ (configMatch)', () => {
    const f = detectFTS("SELECT to_tsvector('english', body) FROM t");
    expect(f.hasFts).toBe(true);
    expect(f.configName).toBe('english');
  });
});

describe('SqlParser rewriteFTS column+queryText branch', () => {
  it('rewrites to MATCH when column and queryText extracted', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE col @@ plainto_tsquery('english', 'hello')");
    expect(r).toContain('MATCH');
    expect(r).toContain('col');
  });

  it('replaces @@ with MATCH generically when no column/query', () => {
    const r = rewriteFTS('SELECT * FROM t WHERE a @@ b');
    expect(r).toContain('MATCH');
    expect(r).not.toContain('@@');
  });
});

describe('SqlParser extractCtes / inlineCtes column alias', () => {
  it('extracts CTE with column alias list', () => {
    const ctes = extractCtes('WITH c (a, b) AS (SELECT x, y FROM t) SELECT * FROM c');
    expect(ctes.length).toBeGreaterThan(0);
    expect(ctes[0].name).toBe('c');
  });

  it('inlineCtes removes CTE with column aliases', () => {
    const r = inlineCtes('WITH c (a, b) AS (SELECT x, y FROM t) SELECT a FROM c');
    expect(r).not.toMatch(/^\s*WITH\s+/i);
  });
});
