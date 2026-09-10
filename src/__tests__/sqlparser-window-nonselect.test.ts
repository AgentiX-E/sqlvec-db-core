import { describe, it, expect } from 'vitest';
import { extractWindowFunctions } from '../query/SqlParser';

// extractWindowFunctions falls back to regex extraction when the parsed
// statement has no SELECT `columns` (INSERT/UPDATE/DELETE/DDL). Lock that the
// fallback defensively returns [] rather than throwing for non-SELECT input,
// and that a SELECT with no window function also resolves to [].
describe('SqlParser extractWindowFunctions non-SELECT fallback', () => {
  it('returns [] for INSERT (no columns)', () => {
    expect(extractWindowFunctions('INSERT INTO t VALUES (1)')).toEqual([]);
  });

  it('returns [] for UPDATE (no columns)', () => {
    expect(extractWindowFunctions('UPDATE t SET x = 1')).toEqual([]);
  });

  it('returns [] for a SELECT with no window function', () => {
    expect(extractWindowFunctions('SELECT * FROM t')).toEqual([]);
  });

  it('still extracts a window function from a SELECT', () => {
    expect(extractWindowFunctions('SELECT row_number() OVER (ORDER BY x) FROM t')).toEqual([
      { fn: 'ROW_NUMBER', args: [], orderBy: [{ key: 'x', dir: 'ASC' }] },
    ]);
  });
});
