import { describe, it, expect } from 'vitest';
import { detectFTS } from '../query/SqlParser';

// When the left-hand side of `@@` is neither a bare column nor a to_tsvector(...)
// call, detectFTS falls back to column undefined rather than guessing. Lock that
// fallback (the third branch of the `|| undefined` chain).
describe('SqlParser detectFTS column undefined fallback', () => {
  it('returns undefined column when @@ lhs is to_tsquery (not a column)', () => {
    const f = detectFTS(
      "WHERE to_tsquery('english', 'hello') @@ to_tsquery('english', 'world')",
    );
    expect(f.hasFts).toBe(true);
    expect(f.column).toBeUndefined();
    expect(f.queryText).toBe('hello');
  });

  it('still extracts a bare column on the @@ lhs', () => {
    const f = detectFTS("WHERE xx @@ to_tsquery('english', 'hello')");
    expect(f.column).toBe('xx');
  });

  it('still extracts the column from to_tsvector on the @@ lhs', () => {
    const f = detectFTS("WHERE to_tsvector(col) @@ to_tsquery('english', 'hello')");
    expect(f.column).toBe('col');
  });
});
