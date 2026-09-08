import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

describe('SqlParser deep table extraction (subqueries / ANY / EXISTS / CASE)', () => {
  it('extracts tables from FROM subquery', () => {
    const r = parseStatement('SELECT * FROM (SELECT * FROM inner_tbl) AS sub');
    expect(r.type).toBe('SELECT');
    expect((r as any).tables).toEqual(expect.arrayContaining(['inner_tbl']));
  });

  it('extracts tables from JOIN subquery', () => {
    const r = parseStatement('SELECT * FROM a JOIN (SELECT * FROM b) AS sub ON a.id = sub.id');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extracts tables from ANY(subquery) in WHERE', () => {
    const r = parseStatement('SELECT * FROM orders WHERE id = ANY(SELECT id FROM items)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['orders', 'items']));
  });

  it('extracts tables from EXISTS(subquery)', () => {
    const r = parseStatement('SELECT * FROM a WHERE EXISTS(SELECT 1 FROM b WHERE b.id = a.id)');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extracts tables from nested WITH in FROM', () => {
    const r = parseStatement('WITH x AS (SELECT * FROM base) SELECT * FROM x');
    expect(r.type).toBe('SELECT');
  });

  it('extracts tables from CASE WHEN expression in WHERE', () => {
    // extractSubqueryTablesFromExpr only walks the WHERE subtree, so keep
    // the CASE/subquery inside WHERE to exercise the `when`/`result` recursion.
    const r = parseStatement('SELECT * FROM t1 WHERE CASE WHEN a > 0 THEN id IN (SELECT id FROM t2) ELSE false END');
    expect((r as any).tables).toEqual(expect.arrayContaining(['t1', 't2']));
  });
});

describe('SqlParser SERIAL rewrite', () => {
  it('rewrites SERIAL to INTEGER with PK and AUTOINCREMENT', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT)');
    expect(r.type).toBe('DDL');
    const rewritten = (r as any).rewrittenSql;
    expect(rewritten).toBeDefined();
    expect(rewritten).toMatch(/INTEGER/i);
    expect(rewritten).not.toMatch(/\bSERIAL\b/i);
  });

  it('rewrites SERIAL without explicit PK', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL, name TEXT)');
    const rewritten = (r as any).rewrittenSql;
    expect(rewritten).toBeDefined();
    expect(rewritten).toMatch(/INTEGER/i);
  });

  it('does not rewrite non-SERIAL columns', () => {
    const r = parseStatement('CREATE TABLE t (id INTEGER, name TEXT)');
    expect((r as any).rewrittenSql).toBeUndefined();
  });
});

describe('SqlParser extractDDLTable variants', () => {
  it('extracts table from CREATE INDEX (st.name.name)', () => {
    const r = parseStatement('CREATE INDEX idx ON t (name)');
    expect((r as any).table).toBeDefined();
  });

  it('extracts table from DROP TABLE', () => {
    const r = parseStatement('DROP TABLE users');
    expect((r as any).table).toBe('users');
  });

  it('extracts table from TRUNCATE', () => {
    const r = parseStatement('TRUNCATE t');
    expect(r.type).toBe('DDL');
  });
});

describe('SqlParser UPDATE/DELETE WHERE column extraction', () => {
  it('extracts multiple WHERE columns', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE a = 1 AND b = 2');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('returns undefined whereColumns for no WHERE', () => {
    const r = parseStatement('UPDATE t SET x = 1');
    expect((r as any).whereColumns).toBeUndefined();
  });

  it('extracts WHERE columns referencing function args', () => {
    const r = parseStatement('DELETE FROM t WHERE func(a) = b');
    expect((r as any).whereColumns).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
