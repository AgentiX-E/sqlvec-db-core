import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// parseWith's fallback computes isMultiShard as (has JOIN) AND (tables.length > 1).
// Lock both outcomes: a multi-table join is multi-shard, while a self-join
// (`c JOIN c`) collapses to a single table and is not multi-shard.
describe('SqlParser fallback isMultiShard', () => {
  it('marks a multi-table join as multi-shard', () => {
    const r = parseStatement(
      'WITH c AS (SELECT * FROM a INTERSECT SELECT * FROM b) SELECT * FROM c JOIN d ON c.id = d.id',
    ) as any;
    expect(r.hasJoin).toBe(true);
    expect(r.isMultiShard).toBe(true);
  });

  it('marks a self-join (single table) as not multi-shard', () => {
    const r = parseStatement(
      'WITH c AS (SELECT 1 INTERSECT SELECT 2) SELECT * FROM c JOIN c ON c.id = c.id',
    ) as any;
    expect(r.hasJoin).toBe(true);
    expect(r.isMultiShard).toBe(false);
  });
});
