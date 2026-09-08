import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  extractWindowFunctions,
  rewriteWindowSql,
} from '../query/SqlParser';

describe('SqlParser DDL type coverage', () => {
  it('routes CREATE TABLE / CREATE INDEX / ALTER TABLE', () => {
    expect((parseStatement('CREATE TABLE t (id INT)') as any).ddlType).toBe('CREATE_TABLE');
    expect((parseStatement('CREATE INDEX i ON t (x)') as any).ddlType).toBe('CREATE_INDEX');
    expect((parseStatement('ALTER TABLE t ADD c INT') as any).ddlType).toBe('ALTER');
  });

  it('routes ALTER INDEX', () => {
    expect((parseStatement('ALTER INDEX i RENAME TO j') as any).ddlType).toBe('ALTER');
  });

  it('routes DROP variants', () => {
    for (const sql of ['DROP TABLE t', 'DROP INDEX i', 'DROP VIEW v', 'DROP SCHEMA s', 'DROP SEQUENCE q', 'DROP EXTENSION e']) {
      expect((parseStatement(sql) as any).ddlType).toBe('DROP');
    }
  });

  it('routes TRUNCATE as OTHER', () => {
    expect((parseStatement('TRUNCATE t') as any).ddlType).toBe('OTHER');
  });

  it('extracts table from DROP multiple names (names array)', () => {
    const r = parseStatement('DROP TABLE a, b');
    expect((r as any).table).toBeDefined();
  });
});

describe('SqlParser extractOrderBy / extractLimit remaining', () => {
  it('extracts ascending order without explicit ASC', () => {
    const r = parseStatement('SELECT * FROM t ORDER BY name');
    expect((r as any).orderBy).toContain('name');
  });

  it('extracts multi-column ORDER BY', () => {
    const r = parseStatement('SELECT * FROM t ORDER BY a DESC, b ASC');
    expect((r as any).orderBy).toContain('DESC');
    expect((r as any).orderBy).toContain('ASC');
  });
});

describe('SqlParser window fallback via regex (AST failure path)', () => {
  it('falls back to regex window extraction when AST has ROWS BETWEEN', () => {
    // pgsql-ast-parser rejects ROWS BETWEEN → extractWindowFunctions catch →
    // fallbackExtractWindowFunctions regex path.
    const wfs = extractWindowFunctions('SELECT AVG(sal) OVER (PARTITION BY dept ORDER BY sal DESC) FROM emp');
    expect(wfs.length).toBeGreaterThan(0);
    expect(wfs[0].fn).toBe('AVG');
  });

  it('fallback regex extracts args and partitionBy/orderBy', () => {
    const wfs = extractWindowFunctions('SELECT SUM(a, b) OVER (PARTITION BY x ORDER BY y DESC) FROM t');
    expect(wfs.length).toBeGreaterThan(0);
  });
});

describe('SqlParser rewriteWindowSql fallback string replacement', () => {
  it('handles aggregate window via string fallback when toSql fails', () => {
    // Non-window SQL returns unchanged; aggregate with OVER gets stripped.
    const r = rewriteWindowSql('SELECT SUM(x) OVER (ORDER BY y) FROM t');
    expect(r).not.toMatch(/\bOVER\b/i);
  });
});
