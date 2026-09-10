import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser v12 rejects single-table maintenance/utility statements
// (VACUUM/ANALYZE/COPY), so their target table was lost to UNKNOWN. Lock the
// fix: the target table is extracted and preserved for shard placement.
describe('SqlParser maintenance statement table extraction', () => {
  it.each([
    'VACUUM t',
    'VACUUM FULL t',
    'VACUUM ANALYZE t',
    'VACUUM FULL ANALYZE t',
    'ANALYZE t',
    'COPY t FROM STDIN',
    'COPY t TO STDOUT',
  ])('extracts the table from %s', (sql) => {
    const r = parseStatement(sql) as any;
    expect(r.type).toBe('DDL');
    expect(r.table).toBe('t');
  });
});
