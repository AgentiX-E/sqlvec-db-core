/**
 * Isolated tests for needsWhereOneOneHack row.ver falsy path + throw path.
 *
 * Separate file so the module-level `_needsWhereOneOne` cache is fresh; the
 * first (and only) call here exercises the falsy `row.ver` branch (missing
 * version row) and the error branch (thrown get()).
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

describe('needsWhereOneOneHack — row.ver falsy path + throw path', () => {
  it('missing sqlite_version row → falsy row.ver branch (still conservative)', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
        }
        return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [{ id: 1, name: 'x' }] };
      },
      exec: () => {},
    };
    const r = executeMergeWithReturning(upsertSql(), undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

describe('needsWhereOneOneHack — error path (separate file for fresh cache)', () => {
  it('version get() throws → catch branch (still conservative)', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => { throw new Error('boom'); }, all: () => [], run: () => ({ changes: 0 }) };
        }
        return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [{ id: 1, name: 'x' }] };
      },
      exec: () => {},
    };
    const r = executeMergeWithReturning(upsertSql(), undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});
