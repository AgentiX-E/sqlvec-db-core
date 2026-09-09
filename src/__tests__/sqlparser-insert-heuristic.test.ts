import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// parseInsertHeuristic branches: table-less INSERT, INSERT..SELECT (no VALUES),
// values tuples shorter than id column index, all-empty extracted keyValues.

describe('SqlParser parseInsertHeuristic boundary branches', () => {
  it('INSERT with id column and multi-value tuples extracts keyValues', () => {
    const r = parseStatement('INSERT INTO t (id, name) VALUES (1, \'a\'), (2, \'b\')');
    expect((r as any).keyColumn).toBe('id');
    expect((r as any).keyValues).toEqual(['1', '2']);
  });

  it('INSERT..SELECT has no VALUES → no keyValues', () => {
    const r = parseStatement('INSERT INTO t (id, name) SELECT id, name FROM src');
    expect((r as any).keyColumn).toBe('id');
    expect((r as any).keyValues).toBeUndefined();
  });

  it('INSERT without id-like column → keyColumn undefined', () => {
    const r = parseStatement('INSERT INTO t (name, age) VALUES (\'a\', 3)');
    expect((r as any).keyColumn).toBeUndefined();
    expect((r as any).keyValues).toBeUndefined();
  });

  it('INSERT with user_id column extracts keyValues', () => {
    const r = parseStatement('INSERT INTO t (user_id, x) VALUES (10, 1)');
    expect((r as any).keyColumn).toBe('user_id');
    expect((r as any).keyValues).toEqual(['10']);
  });

  it('INSERT with DEFAULT values (no tuple)', () => {
    const r = parseStatement('INSERT INTO t (id, name) DEFAULT VALUES');
    expect((r as any).keyColumn).toBe('id');
    expect((r as any).keyValues).toBeUndefined();
  });

  it('INSERT with RETURNING detected', () => {
    const r = parseStatement('INSERT INTO t (id) VALUES (1) RETURNING id');
    expect((r as any).hasReturning).toBe(true);
  });
});
