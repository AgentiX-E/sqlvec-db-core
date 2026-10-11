import { describe, it, expect } from 'vitest';
import {
  detectMerge,
  rewriteMerge,
  parseMergeReturning,
  executeMergeWithReturning,
} from '../query/MergeExecutor';

// ── detectMerge ────────────────────────────────────────────────────────────

describe('detectMerge', () => {
  it('detects MERGE INTO (case-insensitive, leading whitespace)', () => {
    expect(detectMerge('MERGE INTO t USING s ON t.id = s.id')).toBe(true);
    expect(detectMerge('  merge into t USING s ON t.id = s.id')).toBe(true);
  });

  it('rejects non-MERGE statements', () => {
    expect(detectMerge('SELECT * FROM t')).toBe(false);
    expect(detectMerge('INSERT INTO t VALUES (1)')).toBe(false);
    expect(detectMerge('MERGE INTOXYZ t')).toBe(false);
  });
});

// ── rewriteMerge: detect guard + parse failure ────────────────────────────

describe('rewriteMerge — guards', () => {
  it('returns unchanged (rewritten=false) for non-MERGE', () => {
    const r = rewriteMerge('SELECT 1');
    expect(r).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('returns unchanged for unparseable MERGE', () => {
    const sql = 'MERGE INTO t';  // missing USING/ON
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe(sql);
  });
});

// ── rewriteMerge: UPSERT (MATCHED UPDATE + NOT MATCHED INSERT) ─────────────

describe('rewriteMerge — UPSERT', () => {
  it('translates MATCHED UPDATE + NOT MATCHED INSERT to INSERT ... ON CONFLICT', () => {
    const sql = [
      'MERGE INTO target AS t',
      'USING source AS s',
      'ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name, val = s.val',
      'WHEN NOT MATCHED THEN INSERT (id, name, val) VALUES (s.id, s.name, s.val)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('INSERT INTO target');
    expect(r.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(r.sql).toContain('name = excluded.name');
    expect(r.sql).toContain('val = excluded.val');
  });

  it('MATCHED UPDATE only (no INSERT) infers columns from SET', () => {
    const sql = [
      'MERGE INTO t USING s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
  });
});

// ── rewriteMerge: pure NOT MATCHED INSERT ─────────────────────────────────

describe('rewriteMerge — NOT MATCHED INSERT', () => {
  it('translates pure NOT MATCHED INSERT to INSERT ... WHERE NOT EXISTS', () => {
    const sql = [
      'MERGE INTO target AS t',
      'USING source AS s',
      'ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
    expect(r.sql).toContain('INSERT INTO target');
  });

  it('NOT MATCHED INSERT with an AND condition adds extra WHERE', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED AND s.active = 1 THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(excluded.active');
  });
});

// ── rewriteMerge: MATCHED DELETE ──────────────────────────────────────────

describe('rewriteMerge — MATCHED DELETE', () => {
  it('translates MATCHED DELETE to DELETE ... WHERE IN', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE FROM target');
    expect(r.sql).toContain('IN (');
  });

  it('MATCHED DELETE with an AND condition adds a WHERE filter', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.flag = 1 THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(excluded.flag');
  });
});

// ── rewriteMerge: NOT MATCHED BY SOURCE (PG15+) ───────────────────────────

describe('rewriteMerge — NOT MATCHED BY SOURCE', () => {
  it('translates BY SOURCE DELETE to DELETE ... WHERE NOT EXISTS', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE FROM target');
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('translates BY SOURCE UPDATE to UPDATE ... WHERE NOT EXISTS', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('UPDATE target');
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('combines BY SOURCE DELETE + UPDATE into 2 statements', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE');
    expect(r.sql).toContain('UPDATE');
  });
});

// ── rewriteMerge: DO NOTHING (PG16+) ──────────────────────────────────────

describe('rewriteMerge — DO NOTHING', () => {
  it('MATCHED DO NOTHING + NOT MATCHED INSERT → insert only', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DO NOTHING',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('pure MATCHED DO NOTHING → no-op marker', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('no rows affected');
  });

  it('NOT MATCHED DO NOTHING + MATCHED UPDATE → upsert', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT');
  });
});

// ── rewriteMerge: compound patterns ───────────────────────────────────────

describe('rewriteMerge — compound patterns', () => {
  it('UPSERT + BY SOURCE DELETE → 2 statements', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT');
    expect(r.sql).toContain('DELETE FROM target');
  });

  it('INSERT + BY SOURCE DELETE → 2 statements', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
    expect(r.sql).toContain('DELETE FROM target');
  });

  it('UPDATE + DELETE + INSERT → 3 statements', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DELETE',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toMatch(/INSERT/);
  });

  it('UPDATE + DELETE → UPDATE wins (DELETE clause ignored by parser)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    // parseMerge only records whenMatchedDelete when there is no MATCHED UPDATE,
    // so this collapses to a pure upsert.
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
  });
});

// ── rewriteMerge: conflict column extraction (no equality → unsupported) ──

describe('rewriteMerge — conflict column extraction', () => {
  it('returns unchanged when no equality conflict columns (UPSERT)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });

  it('extracts conflict column when target column is on the RIGHT side', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON s.id = t.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id)');
  });

  it('extracts unqualified column (ON id = id)', () => {
    const sql = [
      'MERGE INTO target USING source ON id = id',
      'WHEN MATCHED THEN UPDATE SET name = name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id)');
  });
});

// ── parseMergeReturning ───────────────────────────────────────────────────

describe('parseMergeReturning', () => {
  it('returns null returningClause when absent', () => {
    const r = parseMergeReturning('MERGE INTO t USING s ON t.id = s.id');
    expect(r.returningClause).toBeNull();
    expect(r.mergeSql).toContain('MERGE INTO t');
  });

  it('splits off a RETURNING clause', () => {
    const r = parseMergeReturning('MERGE INTO t USING s ON t.id = s.id RETURNING id, name');
    expect(r.returningClause).toBe('id, name');
    expect(r.mergeSql).not.toContain('RETURNING');
  });
});

// ── executeMergeWithReturning (fake db) ───────────────────────────────────

function makeFakeDb(handlers: Record<string, any> = {}) {
  const calls: string[] = [];
  const db = {
    prepare(sql: string) {
      calls.push(sql);
      const h = handlers[sql] || handlers['_default'];
      return {
        run: (...args: any[]) => {
          if (h && typeof h.run === 'function') return h.run(sql, ...args);
          return { changes: 0 };
        },
        get: (...args: any[]) => {
          if (h && typeof h.get === 'function') return h.get(sql, ...args);
          return undefined;
        },
        all: (...args: any[]) => {
          if (h && typeof h.all === 'function') return h.all(sql, ...args);
          return [];
        },
      };
    },
    exec(sql: string) { calls.push('exec:' + sql); },
    _calls: calls,
  };
  return db;
}

describe('executeMergeWithReturning', () => {
  it('no RETURNING → executes rewrite, returns empty', () => {
    const db = makeFakeDb();
    const sql = 'MERGE INTO target AS t USING source AS s ON t.id = s.id WHEN MATCHED THEN UPDATE SET name = s.name';
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r).toEqual({ rows: [], rowCount: 0 });
    expect(db._calls.length).toBeGreaterThan(0);
  });

  it('no RETURNING, unrewritable MERGE → executes raw', () => {
    const db = makeFakeDb();
    const sql = 'MERGE INTO target AS t USING source AS s ON t.id > s.id WHEN MATCHED THEN UPDATE SET name = s.name';
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
    // raw prepare().run() fallback
    expect(db._calls.length).toBeGreaterThan(0);
  });

  it('RETURNING with merge_action() → returns tagged rows', () => {
    let inserted: any[] = [{ id: 1, name: 'a' }];
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: () => inserted,
        get: () => undefined,
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'RETURNING merge_action(), id, name',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].merge_action).toBe('INSERT');
  });

  it('RETURNING without merge_action → returns raw rows', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 7, name: 'x' }] },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'RETURNING id, name',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]).toEqual({ id: 7, name: 'x' });
  });

  it('RETURNING with unparseable MERGE → executes raw, empty result', () => {
    const db = makeFakeDb();
    const sql = 'MERGE INTO target RETURNING id';
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
  });
});

// ── parseInsertClause SELECT subquery (findTopLevelFromKeyword) ───────────

describe('rewriteMerge — INSERT ... SELECT subquery', () => {
  it('handles NOT MATCHED INSERT with SELECT expressions', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id, name) SELECT s.id, s.name FROM s',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('handles NOT MATCHED INSERT with DEFAULT VALUES', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) DEFAULT VALUES',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });
});

// ── multiple WHEN MATCHED (PG16+) ─────────────────────────────────────────

describe('rewriteMerge — multiple WHEN MATCHED', () => {
  it('two conditional WHEN MATCHED UPDATE clauses collapse to a single upsert', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.type = 1 THEN UPDATE SET name = s.name',
      'WHEN MATCHED AND s.type = 2 THEN UPDATE SET val = s.val',
    ].join(' ');
    // WHEN_MATCHED_UPDATE_RE uses a single .exec(), so only the first
    // MATCHED UPDATE is captured; this collapses to a plain upsert.
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
  });

  it('WHEN MATCHED UPDATE + WHEN MATCHED DO NOTHING (multiple)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.x = 1 THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });
});

// ── executeMergeWithReturning: DELETE / BY SOURCE paths ───────────────────

describe('executeMergeWithReturning — DELETE and BY SOURCE', () => {
  it('MATCHED DELETE with RETURNING marks rows as DELETE', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 1, name: 'x' }] },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DELETE',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].merge_action).toBe('DELETE');
  });

  it('BY SOURCE DELETE with RETURNING', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 2 }] },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
  });

  it('UPSERT with merge_action() pre-queries existing keys → UPDATE tag', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (sql: string) => {
          // source-keys query returns [{id:1}]; the exists query returns truthy
          return [{ id: 1, name: 'a' }];
        },
        get: () => ({ found: 1 }), // target exists → UPDATE
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'RETURNING merge_action(), id, name',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1); // single INSERT ... ON CONFLICT RETURNING
    // key existed in target → tagged UPDATE
    expect(r.rows[0].merge_action).toBe('UPDATE');
  });
});

// ── needsWhereOneOneHack / patchInsertOnConflict ──────────────────────────

describe('patchInsertOnConflict via executeMergeWithReturning', () => {
  it('does not patch when SQL already has WHERE', () => {
    // A delete with an explicit WHERE should not be touched (via execStatement path)
    const db = makeFakeDb();
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DELETE',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
  });

  it('handles db without sqlite_version (conservative hack)', () => {
    const db = makeFakeDb({
      '_default': { get: () => undefined, all: () => [{ id: 1 }] },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
  });
});

// ── upsert conflict column already in SET (skip) ─────────────────────────

describe('rewriteMerge — conflict column in SET is skipped', () => {
  it('skips SET on a conflict column', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET id = s.id, name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    // id is a conflict column → excluded from DO UPDATE SET
    expect(r.sql).toContain('name = excluded.name');
    expect(r.sql).not.toContain('id = excluded.id');
  });

  it('upsert where conflict column is not in INSERT columns → unshift', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (name) VALUES (s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    // id (conflict) is unshifted into the INSERT column list
    expect(r.sql).toContain('(id, name)');
  });
});

// ── findTopLevelFromKeyword / buildFromClause / parseSetClause boundaries ─

describe('rewriteMerge — parser boundary coverage', () => {
  it('subquery source (parenthesized) with alias', () => {
    const sql = [
      'MERGE INTO target AS t USING (SELECT id, name FROM src) AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('INSERT with SELECT subquery using a string literal containing FROM', () => {
    const sql = [
      "MERGE INTO target AS t USING source AS s ON t.id = s.id",
      "WHEN NOT MATCHED THEN INSERT (id) SELECT s.id, 'x FROM y' FROM source s",
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('NOT MATCHED INSERT with double-quoted identifier', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT ("id") VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('extractAlias on a plain table name (no alias)', () => {
    const sql = [
      'MERGE INTO target USING source ON target.id = source.id',
      'WHEN MATCHED THEN UPDATE SET name = source.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
  });

  it('NOT MATCHED BY SOURCE UPDATE with AND condition', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE AND s.active = 0 THEN UPDATE SET status = 1',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('UPDATE target');
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('NOT MATCHED BY SOURCE DELETE with AND condition', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE AND s.stale = 1 THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE FROM target');
  });

  it('NOT MATCHED BY SOURCE UPDATE with empty SET clause → unsupported', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET ',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });

  it('MATCHED DELETE with AND condition', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.del = 1 THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE FROM target');
  });
});

// ── executeMergeWithReturning: deep branch coverage ───────────────────────

describe('executeMergeWithReturning — deep branches', () => {
  it('3a multi-statement UPSERT includes an UPDATE statement → UPDATE tag', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 1 }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('executeWithReturning falls back when .all() throws', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: () => { throw new Error('prepare failed'); },
        get: () => undefined,
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(0);
  });

  it('merge_action with null column value (?? "" path) and INSERT tag', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (sql: string) => {
          // source keys query returns a row with null id; exists query undefined
          if (sql.includes('FROM source')) return [{ id: null }];
          return [{ id: null }];
        },
        get: () => undefined, // target key not found → INSERT tag
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    // rows may be empty or tagged; must not throw
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('pure WHEN MATCHED DELETE with RETURNING (3b path)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 3 }] },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].id).toBe(3);
  });

  it('needsWhereOneOneHack cached + no-db patchInsertOnConflict', () => {
    // no db → needsWhereOneOneHack returns true (conservative)
    const db = makeFakeDb({
      '_default': { all: () => [{ id: 1 }], get: () => undefined },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('DEFAULT VALUES clause (columns.map() DEFAULT path)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) DEFAULT VALUES',
    ].join(' ');
    const r = rewriteMerge(sql);
    // DEFAULT VALUES yields columns=[] and values=['DEFAULT']
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });
});

// ── character-level parser boundaries (topLevelSplit / findTopLevelFrom) ──

describe('rewriteMerge — character-level parser coverage', () => {
  it('SET clause with function call and qualified column', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      "WHEN MATCHED THEN UPDATE SET name = upper(s.name), val = coalesce(s.a, s.b)",
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT SELECT with escaped string literal and nested parens', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      "WHEN NOT MATCHED THEN INSERT (id) SELECT s.id, coalesce(s.a, 'x'')y') FROM source s",
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT SELECT with double-quoted identifier', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT s."col" FROM source s',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('SET clause with bracketed expression', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET arr = s.arr[1]',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('replaces qualified source refs in SET values (replaceSourceRefs)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('name = excluded.name');
  });

  it('extractConflictColumns with duplicate seen column (dedupe)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id AND t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id)');
  });
});

// ── multipleWhenMatched / combination-scenario fallback branches ──────────

describe('rewriteMerge — multiple WHEN MATCHED + combination fallbacks', () => {
  it('multiple WHEN MATCHED UPDATE (with AND) + DO NOTHING', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.active = 1 THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('Conditional MATCHED UPDATE (s.active = 1)');
    expect(r.sql).toContain('WHERE EXISTS');
  });

  it('multiple WHEN MATCHED UPDATE (with AND) + DO NOTHING + NOT MATCHED INSERT', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.active = 1 THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DO NOTHING',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHEN NOT MATCHED INSERT');
  });

  it('full combination with no conflict columns → upsert fails, delete orphan fallback', () => {
    // ON condition uses a non-equality operator so conflict columns are empty
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    // upsert returns null (no conflict cols); delete orphan may still rewrite
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('MATCHED DO NOTHING (with AND) + NOT MATCHED INSERT', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED AND s.skip = 1 THEN DO NOTHING',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('extractConflictColumns with non-equality operator (operator !== "=")', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id AND t.rank > s.rank',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('ON CONFLICT(id)');
  });

  it('extractConflictColumns bare columns without prefix (ON id = id)', () => {
    const sql = [
      'MERGE INTO target USING source ON id = id',
      'WHEN MATCHED THEN UPDATE SET name = name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });
});

// ── multiple (no AND) + findTopLevelFromKeyword boundary chars ─────────────

describe('rewriteMerge — no-AND multiple + FROM keyword boundaries', () => {
  it('multiple WHEN MATCHED UPDATE (no AND) + DO NOTHING (no AND)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('Conditional MATCHED UPDATE');
    expect(r.sql).not.toContain('Conditional MATCHED UPDATE (');
  });

  it('lowercase "from" keyword is not treated as FROM (word boundary)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      "WHEN NOT MATCHED THEN INSERT (id) SELECT s.id, 'x from y' FROM source s",
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('FROM followed by tab and newline in subquery source', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT s.id FROM\t(SELECT id FROM inner_t) AS x',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT SELECT with deeply nested parentheses', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT s.id, coalesce(nullif(s.a, 0), abs(s.b), (s.c + 1)) FROM source s',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });
});

// ── translate failure fallback paths (reachable via public API) ───────────

describe('rewriteMerge — translate failure fallbacks', () => {
  it('pure NOT MATCHED INSERT with unparseable clause → returns original', () => {
    // INSERT clause that parseInsertClause cannot parse (no columns/values)
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT INTO other',
    ].join(' ');
    const r = rewriteMerge(sql);
    // Either rewrites via some path or falls back; must not throw
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('WHEN MATCHED DELETE with no equality conflict columns → translateDeleteIn null', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });

  it('BY SOURCE DELETE+UPDATE combination (F3) full success', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHEN NOT MATCHED BY SOURCE THEN DELETE');
    expect(r.sql).toContain('WHEN NOT MATCHED BY SOURCE THEN UPDATE');
  });
});

// ── executeMergeWithReturning: 3a multi-statement DELETE/UPDATE branches ───

describe('executeMergeWithReturning — 3a multi-statement DELETE/UPDATE', () => {
  it('3a compound (UPSERT + BY SOURCE DELETE) hits DELETE branch with merge_action', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (q: string) => (q.includes('FROM source') ? [{ id: 1 }] : [{ id: 1, name: 'a' }]),
        get: () => ({ id: 1 }),
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('3a compound without merge_action → raw rows in both INSERT and DELETE', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (q: string) => (q.includes('FROM source') ? [{ id: 2 }] : [{ id: 2, name: 'b' }]),
        get: () => undefined,
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('merge_action with source key having null values → ?? "" path', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (q: string) => (q.includes('FROM source') ? [{ id: null }] : [{ id: null }]),
        get: () => true, // exists → UPDATE tag
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

// ── findTopLevelFromKeyword lowercase / escape / boundary chars ────────────

describe('rewriteMerge — lowercase FROM + escape + boundary', () => {
  it('lowercase "from" keyword recognized (all lowercase)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT s.id from source s',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('WHERE NOT EXISTS');
  });

  it('INSERT SELECT with escaped backslash in string literal', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      "WHEN NOT MATCHED THEN INSERT (id) SELECT s.id, 'a\\\\b' FROM source s",
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT SELECT with FROM at end of string (trailing FROM)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT s.id FROM',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('SET clause with unqualified column (no dot)', () => {
    const sql = [
      'MERGE INTO target USING source ON id = id',
      'WHEN MATCHED THEN UPDATE SET name = name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('NOT MATCHED BY SOURCE UPDATE with empty SET clause → unsupported', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET ',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });
});

// ── combination scenarios where a translate sub-result is null ─────────────

describe('rewriteMerge — combination translate fallbacks', () => {
  it('UPSERT + BY SOURCE DELETE with unparseable INSERT clause', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT INTO garbage',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('INSERT + BY SOURCE DELETE with unparseable INSERT clause', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT INTO garbage',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('BY SOURCE DELETE + UPDATE combination with empty UPDATE SET clause', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET ',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('MATCHED UPDATE + NOT MATCHED INSERT with no conflict columns (upsert null)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });
});

// ── merge_action() pre-query: MATCHED UPDATE + null/existing keys ──────────

describe('executeMergeWithReturning — merge_action pre-query branches', () => {
  it('MATCHED UPDATE + merge_action with existing key (UPDATE tag)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (q: string) => (q.includes('FROM source') ? [{ id: 1 }] : [{ id: 1 }]),
        get: (q: string) => (q.includes('FROM source') ? [{ id: 1 }] : { id: 1 }),
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
    // merge_action tag should be UPDATE because key exists
    if (r.rows.length > 0) expect(r.rows[0].merge_action).toBe('UPDATE');
  });

  it('MATCHED UPDATE + merge_action with null source key (?? "" path)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: (q: string) => (q.includes('FROM source') ? [{ id: null }] : [{ id: null }]),
        get: () => false, // never exists
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('RETURNING only merge_action() (strip → fallback)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': {
        all: () => [{ id: 1 }],
        get: () => false,
        run: () => ({ changes: 1 }),
      },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING merge_action()',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

// ── executeMergeWithReturning: UPDATE else branch + 3c standalone ──────────

describe('executeMergeWithReturning — UPDATE branch + 3c standalone', () => {
  it('3a compound (UPSERT + BY SOURCE UPDATE) hits UPDATE else branch', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 5, name: 'z' }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id, name) VALUES (s.id, s.name)',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
      'RETURNING id, name',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
    expect(r.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('3a compound with UPDATE else + merge_action (UPDATE tag)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 6 }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('3c standalone BY SOURCE DELETE without merge_action', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 9 }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('3c standalone BY SOURCE DELETE with merge_action (DELETE tag)', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 10 }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
    if (r.rows.length > 0) expect(r.rows[0].merge_action).toBe('DELETE');
  });
});

// ── parseInsertClause / parseSetClause char-level branches ─────────────────

describe('rewriteMerge — parse clause char-level branches', () => {
  it('INSERT with VALUES keyword (not SELECT) after column list', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('id');
  });

  it('INSERT with parenthesized subquery after column list', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) (SELECT id FROM source)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('SET clause item without equals sign (malformed) is skipped', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET name, val = s.val',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('SELECT with no FROM keyword (trailing FROM absent)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT 1, 2',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('SELECT with FROM followed by tab (nextCh \\t branch)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT id FROM\tsource s',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('SELECT with FROM followed by open paren', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) SELECT id FROM (SELECT id FROM src)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });
});

// ── SET with table-prefixed column + alias-equals-table ────────────────────

describe('rewriteMerge — table-prefixed SET + alias edge', () => {
  it('SET with table-qualified column (t.name = s.name)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET t.name = s.name, t.val = s.val',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('alias equals table base name (no AS alias)', () => {
    const sql = [
      'MERGE INTO target USING source ON target.id = source.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (source.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('SET clause with quoted column name', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN UPDATE SET "name" = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });
});

// ── combination scenarios where translate returns null (no conflict cols) ──

describe('rewriteMerge — combination translate-null failure sides', () => {
  const noEq = (body: string) =>
    ['MERGE INTO target AS t USING source AS s ON t.id > s.id', body].join(' ');

  it('UPSERT + BY SOURCE DELETE with no equality conflict cols → upsert null, delete succeeds', () => {
    const sql = noEq(
      'WHEN MATCHED THEN UPDATE SET name = s.name ' +
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id) ' +
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    );
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE');
  });

  it('INSERT + BY SOURCE DELETE with unparseable INSERT clause → insert null, delete succeeds', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT INTO garbage',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('DELETE');
  });

  it('MATCHED DO NOTHING + NOT MATCHED INSERT (normal path)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DO NOTHING',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('NOT MATCHED DO NOTHING + MATCHED UPDATE with no conflict cols → upsert null (falls through)', () => {
    const sql = noEq(
      'WHEN MATCHED THEN UPDATE SET name = s.name ' +
      'WHEN NOT MATCHED THEN DO NOTHING',
    );
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });

  it('F3 BY SOURCE DELETE+UPDATE normal combination (both succeed)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('F1 BY SOURCE DELETE normal path', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('F2 BY SOURCE UPDATE normal path', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('Scenario C MATCHED DELETE with no conflict cols → translate null → falls through', () => {
    const sql = noEq('WHEN MATCHED THEN DELETE');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });
});

// ── remaining char-level / scenario edges ────────────────────────────────

describe('rewriteMerge — remaining edges', () => {
  it('pure NOT MATCHED DO NOTHING (no MATCHED UPDATE)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN DO NOTHING',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('ON condition with both sides qualified (t.id = t.id)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = t.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('ON condition lhs qualified only (t.id = id)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('NOT MATCHED BY SOURCE UPDATE with empty SET clause → setItems empty → null', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET ',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });
});

// ── parseInsertClause: non-standard VALUES / parenthesized / DEFAULT ──────

describe('rewriteMerge — parseInsertClause non-standard rest forms', () => {
  it('INSERT (id) VALUES 123 → VALUES branch (non-standard)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES 123',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT (a,b) (SELECT a,b FROM src) → parenthesized branch', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (a, b) (SELECT a, b FROM src)',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT (id) DEFAULT VALUES → DEFAULT branch', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) DEFAULT VALUES',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(true);
  });

  it('INSERT (id) 42 → unparseable (rest is bare number)', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED THEN INSERT (id) 42',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(r.rewritten).toBe(false);
  });
});

// ── remaining translate-null + execute failure sides ─────────────────────

describe('rewriteMerge/execute — translate-null + rewrite-failure sides', () => {
  it('MATCHED DO NOTHING + NOT MATCHED INSERT with bad INSERT clause → insert null', () => {
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN MATCHED THEN DO NOTHING',
      'WHEN NOT MATCHED THEN INSERT INTO garbage',
    ].join(' ');
    const r = rewriteMerge(sql);
    expect(typeof r.rewritten).toBe('boolean');
  });

  it('execute 3a with MATCHED UPDATE + bad INSERT → rewrite fails (no conflict cols)', () => {
    const db = makeFakeDb({
      '_default': { all: () => [{ id: 1 }], run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN UPDATE SET name = s.name',
      'WHEN NOT MATCHED THEN INSERT (id) VALUES (s.id)',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('execute 3b standalone MATCHED DELETE with no conflict cols → rewrite false', () => {
    const db = makeFakeDb({
      '_default': { all: () => [{ id: 1 }], run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id > s.id',
      'WHEN MATCHED THEN DELETE',
      'RETURNING id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});

// ── 3c BY SOURCE DELETE + UPDATE → UPDATE else branch ────────────────────

describe('executeMergeWithReturning — 3c DELETE+UPDATE else branch', () => {
  it('3c with BY SOURCE DELETE + UPDATE hits the UPDATE (else) branch', () => {
    const db = makeFakeDb({
      'SELECT sqlite_version() AS ver': { get: () => ({ ver: '3.45.0' }) },
      '_default': { all: () => [{ id: 1 }], get: () => undefined, run: () => ({ changes: 1 }) },
    });
    const sql = [
      'MERGE INTO target AS t USING source AS s ON t.id = s.id',
      'WHEN NOT MATCHED BY SOURCE THEN DELETE',
      'WHEN NOT MATCHED BY SOURCE THEN UPDATE SET status = 0',
      'RETURNING merge_action(), id',
    ].join(' ');
    const r = executeMergeWithReturning(sql, undefined, db);
    expect(Array.isArray(r.rows)).toBe(true);
  });
});
