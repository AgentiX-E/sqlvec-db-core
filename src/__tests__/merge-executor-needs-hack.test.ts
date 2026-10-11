/**
 * Isolated tests for needsWhereOneOneHack module-level cache branches.
 *
 * These run in a separate file so the module-level `_needsWhereOneOne` cache
 * is fresh, letting us exercise the `row.ver` truthy and falsy paths that
 * would otherwise be short-circuited by an earlier test in the same file.
 *
 * A true UPSERT (MATCHED UPDATE + NOT MATCHED INSERT) is required so the
 * rewritten SQL is `INSERT ... SELECT ... ON CONFLICT`, which is what actually
 * reaches `patchInsertOnConflict` → `needsWhereOneOneHack`.
 */
import { describe, it, expect } from 'vitest';
import { executeMergeWithReturning } from '../query/MergeExecutor';

function upsertSql(): string {
  return [
    'MERGE INTO target AS t USING source AS s ON t.id = s.id',
    'WHEN MATCHED THEN UPDATE SET name = s.name',
    'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    'RETURNING id',
  ].join(' ');
}

describe('needsWhereOneOneHack — sqlite_version row.ver truthy path', () => {
  it('real sqlite version populates the conservative cache (truthy row.ver)', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => ({ ver: '3.45.0' }), all: () => [], run: () => ({ changes: 0 }) };
        }
        return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [{ id: 1, name: 'x' }] };
      },
      exec: () => {},
    };
    const r = executeMergeWithReturning(upsertSql(), undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});
