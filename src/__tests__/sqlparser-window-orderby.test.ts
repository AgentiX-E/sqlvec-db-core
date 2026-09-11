import { describe, it, expect } from 'vitest';
import { extractWindowFunctions } from '../query/SqlParser';

// Window ORDER BY with a positional reference (`ORDER BY 1`) yields an `by`
// without a `name`, exercising the toSql.expr fallback in extractOverOrderBy.
describe('SqlParser window ORDER BY positional reference', () => {
  it('serializes a positional ORDER BY via toSql.expr', () => {
    expect(extractWindowFunctions('SELECT row_number() OVER (ORDER BY 1) FROM t')).toEqual([
      { fn: 'ROW_NUMBER', args: [], orderBy: [{ key: '(1)', dir: 'ASC' }] },
    ]);
  });

  it('extracts a named DESC ORDER BY', () => {
    expect(extractWindowFunctions('SELECT row_number() OVER (ORDER BY x DESC) FROM t')).toEqual([
      { fn: 'ROW_NUMBER', args: [], orderBy: [{ key: 'x', dir: 'DESC' }] },
    ]);
  });
});
