import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// parsePrepare required a trailing "AS sql", so a bare "PREPARE name" lost its
// statement name (returned empty). Lock the fix: the name and optional param
// types are extracted even when the AS clause is absent.
describe('SqlParser PREPARE without AS clause', () => {
  it('extracts name from bare PREPARE name', () => {
    const r = parseStatement('PREPARE p') as any;
    expect(r.type).toBe('PREPARE');
    expect(r.name).toBe('p');
    expect(r.paramTypes).toEqual([]);
    expect(r.innerSql).toBe('');
  });

  it('still extracts name + paramTypes + innerSql with AS', () => {
    const r = parseStatement('PREPARE p (int) AS SELECT 1') as any;
    expect(r.name).toBe('p');
    expect(r.paramTypes).toEqual(['int']);
    expect(r.innerSql).toBe('SELECT 1');
  });

  it('bare PREPARE (no name) → empty name', () => {
    const r = parseStatement('PREPARE') as any;
    expect(r.name).toBe('');
  });
});
