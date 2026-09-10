import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Regression: fallbackParse caches EXECUTE results keyed by a normalized
// template that collapses all literal values to '?'. Two EXECUTE statements
// differing only in their argument values (e.g. p(1) vs p(1.5)) therefore hit
// the same cache entry and returned the first statement's params. Lock the fix:
// EXECUTE is never cached, so each call re-parses its own values.
describe('SqlParser EXECUTE parameter cache isolation', () => {
  it('re-parses values for sequential EXECUTE calls (no stale cache)', () => {
    expect((parseStatement('EXECUTE p(1)') as any).params).toEqual([1]);
    expect((parseStatement('EXECUTE p(1.5)') as any).params).toEqual([1.5]);
    expect((parseStatement('EXECUTE p(-3)') as any).params).toEqual([-3]);
    expect((parseStatement('EXECUTE p(TRUE)') as any).params).toEqual([true]);
    expect((parseStatement('EXECUTE p(NULL)') as any).params).toEqual([null]);
    expect((parseStatement("EXECUTE p('hello')") as any).params).toEqual(['hello']);
  });

  it('keeps numeric/boolean/null literal typing distinct across calls', () => {
    const r1 = parseStatement('EXECUTE p(42)') as any;
    const r2 = parseStatement('EXECUTE p(FALSE)') as any;
    const r3 = parseStatement('EXECUTE p(3.14)') as any;
    expect(r1.params).toEqual([42]);
    expect(r2.params).toEqual([false]);
    expect(r3.params).toEqual([3.14]);
  });
});
