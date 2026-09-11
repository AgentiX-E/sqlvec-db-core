import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// PostgreSQL allows SELECT with no column list (`SELECT FROM t`), which
// pgsql-ast-parser v12 represents as `columns: null` (not an array). Lock that
// the no-columns SELECT still extracts its FROM tables correctly, exercising
// the columns-is-missing branch of both table extractors.
describe('SqlParser SELECT with no column list', () => {
  it('extracts the table from SELECT FROM t', () => {
    expect((parseStatement('SELECT FROM t') as any).tables).toEqual(['t']);
  });

  it('extracts the table from SELECT FROM t with a WHERE clause', () => {
    expect((parseStatement('SELECT FROM t WHERE id = 5') as any).tables).toEqual(['t']);
  });

  it('extracts the table from a no-columns SELECT in a CTE', () => {
    expect((parseStatement('WITH c AS (SELECT FROM u) SELECT FROM c') as any).tables).toEqual(['c', 'u']);
  });
});
