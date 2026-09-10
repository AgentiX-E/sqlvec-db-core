import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// Data-modifying CTEs (WITH ... INSERT/UPDATE/DELETE) are valid PostgreSQL.
// parseWith only handled `in.type === 'select'`, so such statements returned
// UNKNOWN and lost their target table, breaking shard routing. Lock the fix:
// each modifying statement is dispatched to its own parser.
describe('SqlParser data-modifying CTE (WITH ... INSERT/UPDATE/DELETE)', () => {
  it('routes WITH ... INSERT to the INSERT target table', () => {
    const r = parseStatement('WITH c AS (SELECT 1) INSERT INTO t VALUES (1)') as any;
    expect(r.type).toBe('INSERT');
    expect(r.table).toBe('t');
  });

  it('extracts columns and key values from WITH ... INSERT', () => {
    const r = parseStatement(
      'WITH c AS (SELECT 1) INSERT INTO t (id) VALUES (5) RETURNING id',
    ) as any;
    expect(r.type).toBe('INSERT');
    expect(r.table).toBe('t');
    expect(r.columns).toEqual(['id']);
    expect(r.keyColumn).toBe('id');
    expect(r.keyValues).toEqual(['5']);
  });

  it('routes WITH ... UPDATE to the UPDATE target table', () => {
    const r = parseStatement('WITH c AS (SELECT 1) UPDATE t SET x = 1') as any;
    expect(r.type).toBe('UPDATE');
    expect(r.table).toBe('t');
  });

  it('routes WITH ... DELETE to the DELETE target table', () => {
    const r = parseStatement('WITH c AS (SELECT 1) DELETE FROM t WHERE id = 1') as any;
    expect(r.type).toBe('DELETE');
    expect(r.table).toBe('t');
  });

  it('still extracts CTE tables for a WITH ... SELECT', () => {
    const r = parseStatement('WITH c AS (SELECT * FROM u) SELECT * FROM c') as any;
    expect(r.type).toBe('SELECT');
    expect(r.tables).toEqual(['c', 'u']);
  });
});
