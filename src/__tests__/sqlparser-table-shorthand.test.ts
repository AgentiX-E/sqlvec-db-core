import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// `TABLE name` is SQL-standard shorthand for `SELECT * FROM name`, but
// pgsql-ast-parser v12 rejects it, so it fell through fallbackParse to UNKNOWN.
// Lock the fix: it routes as a SELECT with the referenced table.
describe('SqlParser TABLE shorthand', () => {
  it('routes TABLE t as SELECT with table t', () => {
    expect((parseStatement('TABLE t') as any).tables).toEqual(['t']);
  });

  it('skips the ONLY modifier in TABLE ONLY t', () => {
    expect((parseStatement('TABLE ONLY t') as any).tables).toEqual(['t']);
  });
});
