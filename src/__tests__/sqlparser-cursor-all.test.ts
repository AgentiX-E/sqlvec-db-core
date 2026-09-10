import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// FETCH ALL / MOVE ALL are valid PostgreSQL cursor directions (fetch/move all
// remaining rows). The direction alternation lacked ALL, so `FETCH ALL FROM c`
// fell through to the default DECLARE arm with an empty cursor name. Lock the
// fix: ALL is recognized as a direction.
describe('SqlParser cursor FETCH ALL / MOVE ALL direction', () => {
  it('parses FETCH ALL FROM cursor', () => {
    const r = parseStatement('FETCH ALL FROM c') as any;
    expect(r.type).toBe('CURSOR');
    expect(r.action).toBe('FETCH');
    expect(r.cursorName).toBe('c');
    expect(r.direction).toBe('ALL');
    expect(r.fetchCount).toBe(1);
  });

  it('parses MOVE ALL FROM cursor', () => {
    const r = parseStatement('MOVE ALL FROM c') as any;
    expect(r.action).toBe('MOVE');
    expect(r.cursorName).toBe('c');
    expect(r.direction).toBe('ALL');
  });

  it('still parses FETCH NEXT and FORWARD with counts', () => {
    expect((parseStatement('FETCH NEXT FROM c') as any).direction).toBe('NEXT');
    const f = parseStatement('FETCH FORWARD 5 FROM c') as any;
    expect(f.direction).toBe('FORWARD');
    expect(f.fetchCount).toBe(5);
  });

  it('still parses MOVE BACKWARD with count', () => {
    const m = parseStatement('MOVE BACKWARD 3 FROM c') as any;
    expect(m.action).toBe('MOVE');
    expect(m.direction).toBe('BACKWARD');
    expect(m.fetchCount).toBe(3);
  });
});
