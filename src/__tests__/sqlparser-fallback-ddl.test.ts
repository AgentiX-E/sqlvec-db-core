import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// CREATE VIRTUAL TABLE (SQLite FTS5) is a real table creation, but was
// previously mis-classified as CREATE_INDEX with no table name extracted.
// These tests lock the fix: proper CREATE_TABLE ddlType + table name, and also
// cover the fallbackParse CREATE INDEX/ALTER/DROP branches reached by
// pgsql-ast-parser throwing on incomplete DDL.
describe('SqlParser fallback DDL (CREATE VIRTUAL TABLE / INDEX / ALTER / DROP)', () => {
  it('classifies CREATE VIRTUAL TABLE as CREATE_TABLE and extracts table', () => {
    const r = parseStatement('CREATE VIRTUAL TABLE v USING fts5(content)') as any;
    expect(r.type).toBe('DDL');
    expect(r.ddlType).toBe('CREATE_TABLE');
    expect(r.table).toBe('v');
  });

  it('handles CREATE VIRTUAL TABLE IF NOT EXISTS', () => {
    const r = parseStatement('CREATE VIRTUAL TABLE IF NOT EXISTS v USING fts5(a,b)') as any;
    expect(r.ddlType).toBe('CREATE_TABLE');
    expect(r.table).toBe('v');
  });

  it('fallback CREATE INDEX (incomplete) → CREATE_INDEX with no table', () => {
    const r = parseStatement('CREATE INDEX') as any;
    expect(r.type).toBe('DDL');
    expect(r.ddlType).toBe('CREATE_INDEX');
  });

  it('fallback ALTER TABLE (incomplete) → ALTER with no table', () => {
    const r = parseStatement('ALTER TABLE') as any;
    expect(r.ddlType).toBe('ALTER');
    expect(r.table).toBeUndefined();
  });

  it('fallback ALTER TABLE t ADD → ALTER with table extracted', () => {
    const r = parseStatement('ALTER TABLE t ADD') as any;
    expect(r.ddlType).toBe('ALTER');
    expect(r.table).toBe('t');
  });

  it('fallback DROP (incomplete) → DROP', () => {
    const r = parseStatement('DROP') as any;
    expect(r.type).toBe('DDL');
    expect(r.ddlType).toBe('DROP');
  });
});
