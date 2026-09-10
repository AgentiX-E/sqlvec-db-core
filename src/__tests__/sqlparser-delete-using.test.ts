import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser rejects DELETE ... USING, so those statements fall back to
// fallbackParse. Its WHERE-column heuristic only matches `col = <number>`; a
// USING join condition (`WHERE t.id = u.id`) yields whereColumns undefined.
// Lock that real fallback path and its whereMatch falsy branch.
describe('SqlParser fallback DELETE ... USING', () => {
  it('routes DELETE ... USING to the target table', () => {
    const r = parseStatement('DELETE FROM t USING u WHERE t.id = u.id') as any;
    expect(r.type).toBe('DELETE');
    expect(r.table).toBe('t');
  });

  it('leaves whereColumns undefined when the WHERE is a join condition', () => {
    const r = parseStatement('DELETE FROM t USING u WHERE t.id = u.id') as any;
    expect(r.whereColumns).toBeUndefined();
  });
});
