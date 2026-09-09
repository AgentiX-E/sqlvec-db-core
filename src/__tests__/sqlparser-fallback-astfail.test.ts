import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Truly-incomplete SQL (trailing clause missing) makes pgsql-ast-parser throw,
// routing to fallbackParse's INSERT/UPDATE/DELETE/CREATE TABLE branches — which
// previous tests never exercised because their "incomplete" samples were still
// parseable by the AST parser.

describe('SqlParser fallbackParse UPDATE/DELETE/INSERT/CREATE TABLE (AST-failing)', () => {
  it('UPDATE t SET (missing assignment) → fallback table extraction', () => {
    const r = parseStatement('UPDATE t SET');
    expect(r.type).toBe('UPDATE');
    expect((r as any).table).toBe('t');
  });

  it('UPDATE with non-numeric WHERE → whereColumns undefined', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE name =');
    expect(r.type).toBe('UPDATE');
    expect((r as any).whereColumns).toBeUndefined();
  });

  it('DELETE FROM (missing table) → fallback empty table', () => {
    const r = parseStatement('DELETE FROM');
    expect(r.type).toBe('DELETE');
  });

  it('INSERT INTO (missing table) → fallback', () => {
    const r = parseStatement('INSERT INTO');
    expect(r.type).toBe('INSERT');
  });

  it('CREATE TABLE (missing body) → fallback', () => {
    const r = parseStatement('CREATE TABLE');
    expect(r.type).toBe('DDL');
  });
});

describe('SqlParser fallbackParse SELECT isMultiShard + hasJoin', () => {
  it('SELECT with JOIN → isMultiShard true', () => {
    const r = parseStatement('SELECT * FROM a JOIN b ON a.id = b.id');
    expect((r as any).hasJoin).toBe(true);
  });

  it('SELECT single table → isMultiShard false', () => {
    const r = parseStatement('SELECT * FROM a');
    expect((r as any).hasJoin).toBe(false);
    expect((r as any).isMultiShard).toBe(false);
  });
});
