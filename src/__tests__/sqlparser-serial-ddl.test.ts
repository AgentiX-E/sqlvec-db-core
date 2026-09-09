import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

describe('SqlParser rewriteSERIAL branches', () => {
  it('rewrites SERIAL without PK → adds PK + AUTOINCREMENT', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL, name TEXT)');
    expect(r.type).toBe('DDL');
    expect((r as any).rewrittenSql).toContain('INTEGER');
    expect((r as any).rewrittenSql).toContain('AUTOINCREMENT');
  });

  it('rewrites SERIAL with existing PRIMARY KEY', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT)');
    expect((r as any).rewrittenSql).toContain('INTEGER');
  });

  it('does not rewrite non-SERIAL CREATE TABLE', () => {
    const r = parseStatement('CREATE TABLE t (id INT, name TEXT)');
    expect((r as any).rewrittenSql).toBeUndefined();
  });
});

describe('SqlParser parseDDL ddlType mapping', () => {
  it('maps alter table and alter index to ALTER', () => {
    expect((parseStatement('ALTER TABLE t ADD c INT') as any).ddlType).toBe('ALTER');
    expect((parseStatement('ALTER INDEX i RENAME TO j') as any).ddlType).toBe('ALTER');
  });

  it('maps drop index/view/schema to DROP', () => {
    expect((parseStatement('DROP INDEX i') as any).ddlType).toBe('DROP');
    expect((parseStatement('DROP VIEW v') as any).ddlType).toBe('DROP');
    expect((parseStatement('DROP SCHEMA s') as any).ddlType).toBe('DROP');
  });

  it('maps create index/table correctly', () => {
    expect((parseStatement('CREATE INDEX i ON t(c)') as any).ddlType).toBe('CREATE_INDEX');
    expect((parseStatement('CREATE TABLE t (id INT)') as any).ddlType).toBe('CREATE_TABLE');
  });
});

describe('SqlParser extractDDLTable variants', () => {
  it('extracts table from DROP INDEX (names array)', () => {
    const r = parseStatement('DROP INDEX idx');
    expect((r as any).table).toBe('idx');
  });

  it('extracts table from CREATE INDEX on table', () => {
    const r = parseStatement('CREATE INDEX i ON mytable (c)');
    expect((r as any).table).toBeDefined();
  });
});
