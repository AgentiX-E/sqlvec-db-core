import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser v12 rejects MERGE (PostgreSQL 15+), so it fell through to
// UNKNOWN and lost its merge target table. Lock the fix: the INTO target table
// is preserved (routed as an UPDATE with a table) so shard placement is kept.
describe('SqlParser MERGE target table', () => {
  it('extracts the merge target from MERGE INTO', () => {
    const r = parseStatement(
      'MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = 1',
    ) as any;
    expect(r.type).toBe('UPDATE');
    expect(r.table).toBe('t');
  });

  it('handles MERGE with a NOT MATCHED INSERT branch', () => {
    const r = parseStatement(
      'MERGE INTO t USING s ON t.id = s.id WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ) as any;
    expect(r.table).toBe('t');
  });

  it('returns UNKNOWN for a bare MERGE with no table name', () => {
    expect((parseStatement('MERGE INTO') as any).type).toBe('UNKNOWN');
    expect((parseStatement('MERGE') as any).type).toBe('UNKNOWN');
  });
});
