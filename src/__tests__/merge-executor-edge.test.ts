/**
 * Edge-case coverage for MergeExecutor defensive/fallback branches.
 *
 * These scenarios exercise the remaining error-handling paths that the main
 * suites do not reach:
 *   - NOT MATCHED BY SOURCE UPDATE with an empty (unparseable) SET clause
 *   - needsWhereOneOneHack() catch branch (sqlite_version probe throws)
 *   - execStatement() prepare().run() → db.exec() fallback
 *   - merge_action() pre-query failure (source key scan throws)
 *   - 3b/3c standalone-MERGE statement dispatch (non-DELETE fallback,
 *     and unrewritable raw execution)
 *
 * The module-level `_needsWhereOneOne` cache is fresh in this file, which is
 * required to deterministically reach the catch branch in the version probe.
 */
import { describe, it, expect } from 'vitest';
import { rewriteMerge, executeMergeWithReturning } from '../query/MergeExecutor';

describe('rewriteMerge — NOT MATCHED BY SOURCE UPDATE empty SET', () => {
  it('returns original when the BY SOURCE UPDATE SET clause has no assignments', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET bareword',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe(sql);
  });
});

describe('needsWhereOneOneHack — version probe throws (catch branch)', () => {
  it('falls back to conservative hack when sqlite_version get() throws', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return {
            get: () => { throw new Error('version probe boom'); },
            all: () => [],
            run: () => ({ changes: 0 }),
          };
        }
        return { run: () => ({ changes: 1 }), get: () => undefined, all: () => [] };
      },
      exec: () => {},
    };
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

describe('execStatement — prepare().run() falls back to exec()', () => {
  it('calls db.exec() when prepare().run() throws (compound statement)', () => {
    const execCalls: string[] = [];
    const db = {
      prepare: (sql: string) => {
        // The version probe succeeds, but every DML prepare().run() throws.
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => ({ ver: '3.45.0' }), all: () => [], run: () => ({ changes: 0 }) };
        }
        return {
          run: () => { throw new Error('prepare().run() boom'); },
          get: () => undefined,
          all: () => [],
        };
      },
      exec: (sql: string) => { execCalls.push(sql); },
    };
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    // No RETURNING → the rewrite result is executed via execStatement().
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
    expect(execCalls.length).toBeGreaterThan(0);
  });
});

describe('merge_action — source key pre-query failure', () => {
  it('swallows the pre-query error and still returns rows', () => {
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => ({ ver: '3.45.0' }), all: () => [], run: () => ({ changes: 0 }) };
        }
        // The source key scan (SELECT ... FROM source) throws.
        if (/FROM source/i.test(sql)) {
          return {
            all: () => { throw new Error('source scan boom'); },
            get: () => undefined,
            run: () => ({ changes: 1 }),
          };
        }
        return { all: () => [], get: () => undefined, run: () => ({ changes: 1 }) };
      },
      exec: () => {},
    };
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

describe('executeMergeWithReturning — 3b/3c standalone dispatch', () => {
  it('executes a non-DELETE statement via execStatement (BY SOURCE UPDATE fallback)', () => {
    const execCalls: string[] = [];
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => ({ ver: '3.45.0' }), all: () => [], run: () => ({ changes: 0 }) };
        }
        return {
          all: () => (sql.toUpperCase().includes('DELETE') ? [{ id: 1 }] : []),
          get: () => undefined,
          run: () => ({ changes: 1 }),
        };
      },
      exec: (sql: string) => { execCalls.push(sql); },
    };
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET name = s.name',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    // The matched-DELETE branch yields DELETE rows; the BY SOURCE UPDATE is
    // dispatched via execStatement (not RETURNING) — must not throw.
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('executes raw when a standalone BY SOURCE DELETE cannot be rewritten', () => {
    const execCalls: string[] = [];
    const db = {
      prepare: (sql: string) => {
        if (sql === 'SELECT sqlite_version() AS ver') {
          return { get: () => ({ ver: '3.45.0' }), all: () => [], run: () => ({ changes: 0 }) };
        }
        return { all: () => [], get: () => undefined, run: () => ({ changes: 1 }) };
      },
      exec: (sql: string) => { execCalls.push(sql); },
    };
    // No equality in ON → conflict columns empty → rewrite fails → raw exec.
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
  });
});
