import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover parseDDL switch cases and extractDDLTable's plural `tables` field
// (TRUNCATE). pgsql-ast-parser v12 emits type 'truncate table' with a plural
// tables array, and DROP VIEW/SCHEMA/EXTENSION fail AST and route to fallback.
describe('SqlParser parseDDL table extraction', () => {
  it('TRUNCATE extracts table from plural tables array', () => {
    const r = parseStatement('TRUNCATE t, u') as any;
    expect(r.type).toBe('DDL');
    expect(r.table).toBe('t');
    expect(r.ddlType).toBe('OTHER');
  });

  it('CREATE TABLE extracts table and ddlType CREATE_TABLE', () => {
    const r = parseStatement('CREATE TABLE myt (id int)') as any;
    expect(r.table).toBe('myt');
    expect(r.ddlType).toBe('CREATE_TABLE');
  });

  it('ALTER TABLE maps ALTER', () => {
    const r = parseStatement('ALTER TABLE t ADD c int') as any;
    expect(r.ddlType).toBe('ALTER');
    expect(r.table).toBe('t');
  });

  it('CREATE INDEX maps CREATE_INDEX', () => {
    const r = parseStatement('CREATE INDEX i ON t (a)') as any;
    expect(r.ddlType).toBe('CREATE_INDEX');
  });

  it('DROP TABLE maps DROP and extracts table', () => {
    const r = parseStatement('DROP TABLE t') as any;
    expect(r.ddlType).toBe('DROP');
    expect(r.table).toBe('t');
  });
});
