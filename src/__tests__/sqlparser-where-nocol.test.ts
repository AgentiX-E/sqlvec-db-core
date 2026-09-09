import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Cover remaining reachable falsy branches: extractWhereColumns returning
// undefined for WHERE without any column reference, and collectRefColumns
// early-return on a non-object/empty operand.
describe('SqlParser WHERE with no column references', () => {
  it('SELECT WHERE 1=1 → whereColumns undefined', () => {
    const r = parseStatement('SELECT * FROM t WHERE 1 = 1') as any;
    expect(r.type).toBe('SELECT');
    expect(r.whereColumns).toBeUndefined();
  });

  it('SELECT WHERE TRUE → whereColumns undefined', () => {
    const r = parseStatement('SELECT * FROM t WHERE TRUE') as any;
    expect(r.whereColumns).toBeUndefined();
  });

  it('UPDATE WHERE 1=1 → whereColumns undefined', () => {
    const r = parseStatement('UPDATE t SET x=1 WHERE 1=1') as any;
    expect(r.whereColumns).toBeUndefined();
  });
});
