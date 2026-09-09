import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// EXECUTE p(,) previously emitted a spurious empty-string parameter because
// parseParamValues pushed every comma-delimited segment without checking for
// emptiness. Lock the fix: empty segments are skipped.
describe('SqlParser EXECUTE empty parameter segments', () => {
  it('empty parens → no params', () => {
    expect((parseStatement('EXECUTE p()') as any).params).toEqual([]);
  });

  it('bare comma (,) → no params', () => {
    expect((parseStatement('EXECUTE p(,)') as any).params).toEqual([]);
  });

  it('trailing comma (1,) → single param', () => {
    expect((parseStatement('EXECUTE p(1,)') as any).params).toEqual([1]);
  });

  it('interior empty segment (1,,2) → skips gap', () => {
    expect((parseStatement('EXECUTE p(1,,2)') as any).params).toEqual([1, 2]);
  });

  it('normal params unaffected', () => {
    expect((parseStatement('EXECUTE p(1,2)') as any).params).toEqual([1, 2]);
  });
});
