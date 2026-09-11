import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Malformed/truncated WITH statements (CTE but no trailing main query) resolve
// to UNKNOWN rather than throwing. Lock the defensive fallback for these
// boundary inputs.
describe('SqlParser truncated WITH statements', () => {
  it('returns UNKNOWN for a WITH CTE with no main query', () => {
    expect((parseStatement('WITH c AS (SELECT 1)') as any).type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a WITH CTE with only trailing whitespace', () => {
    expect((parseStatement('WITH c AS (SELECT 1) ') as any).type).toBe('UNKNOWN');
  });

  it('still routes a RECURSIVE CTE with a main query as SELECT', () => {
    const r = parseStatement('WITH RECURSIVE c AS (SELECT 1) SELECT 2') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual([]);
  });
});
