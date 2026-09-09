import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// These drive fallbackParse's falsy branches: UPDATE/DELETE without WHERE
// (whereColumns undefined), CREATE TABLE without SERIAL (rewrittenSql
// undefined), INSERT without RETURNING, backtick-quoted tables, ALTER on
// non-TABLE, DROP without IF EXISTS, and CREATE INDEX / CREATE VIRTUAL.

describe('SqlParser fallbackParse falsy branches', () => {
  it('UPDATE without WHERE → whereColumns undefined', () => {
    const r = parseStatement('UPDATE users SET name = 123');
    expect(r.type).toBe('UPDATE');
    expect((r as any).whereColumns).toBeUndefined();
  });

  it('DELETE without WHERE → whereColumns undefined', () => {
    const r = parseStatement('DELETE FROM logs');
    expect(r.type).toBe('DELETE');
    expect((r as any).whereColumns).toBeUndefined();
  });

  it('CREATE TABLE without SERIAL → rewrittenSql undefined', () => {
    const r = parseStatement('CREATE TABLE t (id INT, name TEXT)');
    expect(r.type).toBe('DDL');
    expect((r as any).rewrittenSql).toBeUndefined();
  });

  it('INSERT without RETURNING → hasReturning false', () => {
    const r = parseStatement('INSERT INTO t (id) VALUES (1)');
    expect(r.type).toBe('INSERT');
    expect((r as any).hasReturning).toBe(false);
  });

  it('backtick-quoted table name extracted (no spaces)', () => {
    const r = parseStatement('SELECT * FROM `mytable`');
    expect((r as any).tables).toContain('mytable');
  });

  it('ALTER TABLE non-matching (ALTER DATABASE) → table undefined', () => {
    const r = parseStatement('ALTER DATABASE db SET x = 1');
    expect(r.type).toBe('DDL');
    expect((r as any).ddlType).toBe('ALTER');
  });

  it('DROP TABLE without IF EXISTS', () => {
    const r = parseStatement('DROP TABLE t');
    expect(r.type).toBe('DDL');
    expect((r as any).ddlType).toBe('DROP');
    expect((r as any).table).toBe('t');
  });

  it('CREATE INDEX and CREATE VIRTUAL TABLE', () => {
    const idx = parseStatement('CREATE INDEX i ON t (c)');
    expect((idx as any).ddlType).toBe('CREATE_INDEX');
    const vt = parseStatement('CREATE VIRTUAL TABLE v USING fts5(c)');
    expect((vt as any).ddlType).toBe('CREATE_TABLE');
    expect((vt as any).table).toBe('v');
  });
});
