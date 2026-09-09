import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// PostgreSQL supports FORWARD/BACKWARD as FETCH/MOVE directions. These were
// previously unrecognized: MOVE FORWARD fell through every cursor regex and
// hit the default return (action 'DECLARE', empty cursorName) — a real bug.
// Lock the fix: FORWARD/BACKWARD parse correctly for both MOVE and FETCH.
describe('SqlParser cursor FORWARD/BACKWARD directions', () => {
  it('parses MOVE FORWARD n FROM c', () => {
    const r = parseStatement('MOVE FORWARD 1 FROM c') as any;
    expect(r.action).toBe('MOVE');
    expect(r.cursorName).toBe('c');
    expect(r.direction).toBe('FORWARD');
    expect(r.fetchCount).toBe(1);
  });

  it('parses MOVE BACKWARD n c (optional FROM)', () => {
    const r = parseStatement('MOVE BACKWARD 2 c') as any;
    expect(r.action).toBe('MOVE');
    expect(r.cursorName).toBe('c');
    expect(r.direction).toBe('BACKWARD');
    expect(r.fetchCount).toBe(2);
  });

  it('parses FETCH FORWARD FROM c', () => {
    const r = parseStatement('FETCH FORWARD FROM c') as any;
    expect(r.action).toBe('FETCH');
    expect(r.direction).toBe('FORWARD');
  });

  it('parses FETCH BACKWARD n FROM c', () => {
    const r = parseStatement('FETCH BACKWARD 3 FROM c') as any;
    expect(r.action).toBe('FETCH');
    expect(r.cursorName).toBe('c');
    expect(r.direction).toBe('BACKWARD');
    expect(r.fetchCount).toBe(3);
  });

  it('keeps default NEXT for plain MOVE/FETCH', () => {
    expect((parseStatement('MOVE c') as any).direction).toBe('NEXT');
    expect((parseStatement('FETCH FROM c') as any).direction).toBe('NEXT');
  });
});
