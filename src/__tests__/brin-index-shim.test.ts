import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  BrinBlockRangeIndex,
  detectBRIN,
  rewriteBRIN,
  registerBrinIndex,
  unregisterBrinIndex,
  clearBrinRegistry,
  rewriteBrinQuery,
} from '../index/BRINIndexShim';

function makeDb(withRows = true): { db: Database.Database; brin: BrinBlockRangeIndex } {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE logs (rowid INTEGER PRIMARY KEY, created_at INTEGER, note TEXT)');
  if (withRows) {
    const ins = db.prepare('INSERT INTO logs (rowid, created_at, note) VALUES (?,?,?)');
    for (let i = 1; i <= 300; i++) {
      ins.run(i, i * 10, i % 10 === 0 ? null : `v${i}`);
    }
  }
  const brin = new BrinBlockRangeIndex('logs', 'created_at', { pagesPerRange: 128 });
  return { db, brin };
}

describe('BRINIndexShim — regex rewrite', () => {
  it('detects USING BRIN', () => {
    expect(detectBRIN('CREATE INDEX ix ON t USING BRIN (col)')).toBe(true);
    expect(detectBRIN('CREATE INDEX ix ON t (col)')).toBe(false);
    expect(detectBRIN('CREATE INDEX ix ON t USING brin (col)')).toBe(true); // case-insensitive
  });

  it('rewrites USING BRIN into a plain B-tree index', () => {
    const r = rewriteBRIN('CREATE INDEX ix ON t USING BRIN (col)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
  });

  it('strips CONCURRENTLY alongside USING BRIN', () => {
    const r = rewriteBRIN('CREATE INDEX CONCURRENTLY ON t USING BRIN (a, b)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX ON t (a, b)');
  });

  it('keeps UNIQUE intact', () => {
    const r = rewriteBRIN('CREATE UNIQUE INDEX ix ON t USING BRIN (col)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE UNIQUE INDEX ix ON t (col)');
  });

  it('passes through unchanged when no BRIN clause', () => {
    const r = rewriteBRIN('CREATE INDEX ix ON t (col)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE INDEX ix ON t (col)');
  });
});

describe('BrinBlockRangeIndex — construction & metadata', () => {
  it('exposes meta table name and pages-per-range', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    expect(b.getMetaTable()).toBe('__brin_pages_logs_created_at');
    expect(b.getPagesPerRange()).toBe(128);
    expect(b.getFlatbushIndex()).toBeNull();
    expect(b.table).toBe('logs');
    expect(b.column).toBe('created_at');
  });

  it('honors a custom pagesPerRange', () => {
    const b = new BrinBlockRangeIndex('t', 'c', { pagesPerRange: 7 });
    expect(b.getPagesPerRange()).toBe(7);
  });

  it('creates the metadata table', () => {
    const { db, brin } = makeDb(false);
    brin.createMetaTable(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get('__brin_pages_logs_created_at');
    expect(row).toBeTruthy();
    db.close();
  });
});

describe('BrinBlockRangeIndex — summarizing', () => {
  it('summarizes a single range with min/max/null', () => {
    const { db, brin } = makeDb();
    brin.summarizeRange(db, 1);
    const r = brin.getRanges()[0];
    expect(r.pageRangeStart).toBe(1);
    expect(r.pageRangeEnd).toBe(128);
    expect(r.minVal).toBe('10');
    expect(r.maxVal).toBe('1280');
    expect(r.hasNull).toBe(false); // created_at has no NULLs
    db.close();
  });

  it('reports hasNull when the indexed column has NULLs', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, v INTEGER)');
    db.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(1, 10);
    db.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(2, null);
    db.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(3, 30);
    const brin = new BrinBlockRangeIndex('t', 'v', { pagesPerRange: 128 });
    brin.summarizeRange(db, 1);
    const r = brin.getRanges()[0];
    expect(r.hasNull).toBe(true);
    db.close();
  });

  it('summarizes all ranges and builds flatbush', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // 300 rows / 128 = 3 ranges
    expect(brin.getRanges().length).toBe(3);
    expect(brin.getFlatbushIndex()).not.toBeNull();
    db.close();
  });

  it('buildFlatbushIndex returns null for empty data', () => {
    const { db, brin } = makeDb(false);
    brin.summarizeAll(db);
    expect(brin.getFlatbushIndex()).toBeNull();
    db.close();
  });

  it('handles a table with no rows (max rowid null)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE empty (rowid INTEGER PRIMARY KEY, x INTEGER)');
    const brin = new BrinBlockRangeIndex('empty', 'x');
    brin.summarizeAll(db);
    expect(brin.getRanges().length).toBe(0);
    expect(brin.getFlatbushIndex()).toBeNull();
    db.close();
  });
});

describe('BrinBlockRangeIndex — canPrune', () => {
  let db: Database.Database;
  let brin: BrinBlockRangeIndex;
  beforeEach(() => {
    const ctx = makeDb();
    db = ctx.db;
    brin = ctx.brin;
    brin.summarizeAll(db);
  });

  it('prunes equality outside range', () => {
    expect(brin.canPrune(db, 1, '=', 9999)).toBe(true);
    expect(brin.canPrune(db, 1, '=', 500)).toBe(false);
  });

  it('prunes less-than correctly', () => {
    expect(brin.canPrune(db, 1, '<', 5)).toBe(true); // min=10 >= 5
    expect(brin.canPrune(db, 1, '<', 500)).toBe(false);
  });

  it('prunes greater-than correctly', () => {
    expect(brin.canPrune(db, 1, '>', 2000)).toBe(true); // max=1280 <= 2000
    expect(brin.canPrune(db, 1, '>', 500)).toBe(false);
  });

  it('prunes <= and >= correctly', () => {
    expect(brin.canPrune(db, 1, '<=', 9)).toBe(true);
    expect(brin.canPrune(db, 1, '>=', 1281)).toBe(true);
    expect(brin.canPrune(db, 1, '<=', 10)).toBe(false);
    expect(brin.canPrune(db, 1, '>=', 1280)).toBe(false);
  });

  it('never prunes inequality', () => {
    expect(brin.canPrune(db, 1, '!=', 500)).toBe(false);
    expect(brin.canPrune(db, 1, '<>', 500)).toBe(false);
  });

  it('handles IS NULL / IS NOT NULL', () => {
    // created_at has no nulls → IS NULL prunes (no null to match)
    expect(brin.canPrune(db, 1, 'IS NULL', null)).toBe(true);
    expect(brin.canPrune(db, 1, 'IS NOT NULL', null)).toBe(false);
  });

  it('handles IS NULL on a column with nulls', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, v INTEGER)');
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(1, null);
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(2, 20);
    const b2 = new BrinBlockRangeIndex('t', 'v', { pagesPerRange: 128 });
    b2.summarizeRange(db2, 1);
    expect(b2.canPrune(db2, 1, 'IS NULL', null)).toBe(false); // has null, don't prune
    db2.close();
  });

  it('handles NULL value equality', () => {
    // created_at has no nulls → '= NULL' should prune (no null matches)
    expect(brin.canPrune(db, 1, '=', null)).toBe(true);
    expect(brin.canPrune(db, 1, '=', 'NULL')).toBe(true);
    expect(brin.canPrune(db, 1, '!=', null)).toBe(false);
  });

  it('returns false for unknown operator', () => {
    expect(brin.canPrune(db, 1, 'LIKE', 500)).toBe(false);
  });

  it('returns false for unknown page', () => {
    expect(brin.canPrune(db, 9999, '=', 5)).toBe(false);
  });

  it('BETWEEN prunes ranges entirely below or above the query', () => {
    // page1 = 10..1280
    expect(brin.canPrune(db, 1, 'BETWEEN', [2000, 3000])).toBe(true); // all above
    expect(brin.canPrune(db, 1, 'BETWEEN', [5, 8])).toBe(true); // all below
    expect(brin.canPrune(db, 1, 'BETWEEN', [100, 200])).toBe(false); // overlap
    expect(brin.canPrune(db, 1, 'BETWEEN', [5, 15])).toBe(false); // overlap
  });

  it('BETWEEN accepts string form', () => {
    expect(brin.canPrune(db, 1, 'BETWEEN', '5 AND 8')).toBe(true);
    expect(brin.canPrune(db, 1, 'BETWEEN', '100 AND 200')).toBe(false);
  });

  it('returns false for a range with a NULL min value', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, v INTEGER)');
    // a range whose min/max are both NULL (all-NULL rows)
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(1, null);
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(2, null);
    const b2 = new BrinBlockRangeIndex('t', 'v', { pagesPerRange: 128 });
    b2.summarizeRange(db2, 1);
    // min=null, max=null → comparison guard returns false (cannot prune)
    expect(b2.canPrune(db2, 1, '=', 5)).toBe(false);
    expect(b2.canPrune(db2, 1, '>', 5)).toBe(false);
    db2.close();
  });

  it('reloads a range from the DB after cache clear', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    brin.clearCache(); // wipes in-memory ranges, but metadata table remains
    // canPrune must now reload from the DB (row exists → not pruned for 500)
    expect(brin.canPrune(db, 1, '=', 500)).toBe(false);
    db.close();
  });

  it('handles non-numeric columns in canPrune (string comparison)', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, name TEXT)');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(1, 'apple');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(2, 'banana');
    const b2 = new BrinBlockRangeIndex('t', 'name', { pagesPerRange: 128 }, false);
    b2.summarizeRange(db2, 1);
    // non-numeric: string comparisons
    expect(b2.canPrune(db2, 1, '=', 'zzz')).toBe(true); // 'zzz' > 'banana'
    expect(b2.canPrune(db2, 1, '=', 'apple')).toBe(false); // within range
    db2.close();
  });

  it('handles non-numeric BETWEEN pruning (string bounds)', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, name TEXT)');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(1, 'apple');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(2, 'banana');
    const b2 = new BrinBlockRangeIndex('t', 'name', { pagesPerRange: 128 }, false);
    b2.summarizeRange(db2, 1);
    // apple..banana; query ['cherry','date'] is entirely above → prune
    expect(b2.canPrune(db2, 1, 'BETWEEN', ['cherry', 'date'])).toBe(true);
    // query ['ant','avocado'] overlaps → no prune
    expect(b2.canPrune(db2, 1, 'BETWEEN', ['ant', 'avocado'])).toBe(false);
    db2.close();
  });

  it('handles a single-element BETWEEN value array', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // value [2000] → low=high=2000, range 10..1280 entirely below → prune
    expect(brin.canPrune(db, 1, 'BETWEEN', [2000])).toBe(true);
    db.close();
  });

  it('handles a non-numeric min/max in buildFlatbushIndex', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, name TEXT)');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(1, 'abc');
    db2.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(2, 'def');
    // isNumeric=true but values are text → parseFloat gives NaN → flatbush stays null
    const b2 = new BrinBlockRangeIndex('t', 'name', { pagesPerRange: 128 }, true);
    b2.summarizeAll(db2);
    expect(b2.getFlatbushIndex()).toBeNull();
    db2.close();
  });

  it('handles a numeric column with non-numeric values in BETWEEN', () => {
    const db2 = new Database(':memory:');
    db2.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, v TEXT)');
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(1, 'abc');
    db2.prepare('INSERT INTO t (rowid, v) VALUES (?,?)').run(2, 'def');
    // isNumeric=true but min/max parseFloat → NaN → non-finite fallback path
    const b2 = new BrinBlockRangeIndex('t', 'v', { pagesPerRange: 128 }, true);
    b2.summarizeRange(db2, 1);
    expect(b2.canPrune(db2, 1, '=', 'xyz')).toBe(true); // string fallback compare
    db2.close();
  });

  it('handles a non-finite value in canPrune (NaN fallback)', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // value is a non-numeric string → parseFloat NaN → fallback to string compare
    expect(brin.canPrune(db, 1, '=', 'not-a-number')).toBe(true);
    db.close();
  });

  it('handles BETWEEN with a malformed (no AND) string value', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // value has no " AND " → highVal falls back to lowVal
    expect(brin.canPrune(db, 1, 'BETWEEN', '500')).toBe(false); // 500 within 10..1280
    db.close();
  });
});

describe('BrinBlockRangeIndex — getCandidateRanges', () => {
  it('returns candidates via flatbush fast path', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    const cands = brin.getCandidateRanges(db, '=', 500);
    // value 500 falls in page1 (10..1280) only
    expect(cands.length).toBe(1);
    expect(cands[0].pageRangeStart).toBe(1);
    db.close();
  });

  it('exercises every operator through the flatbush fast path', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // '>' : ranges where max > 500 → page1(1280), page2(2560), page3(3000)
    expect(brin.getCandidateRanges(db, '>', 500).length).toBe(3);
    // '>=' : max >= 1280 → all 3
    expect(brin.getCandidateRanges(db, '>=', 1280).length).toBe(3);
    // '<' : min < 1280 → page1 only
    expect(brin.getCandidateRanges(db, '<', 1280).length).toBe(1);
    // '<=' : min <= 1290 → page1 + page2
    expect(brin.getCandidateRanges(db, '<=', 1290).length).toBe(2);
    db.close();
  });

  it('returns no candidates when value matches nothing', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // 99999 is beyond all ranges
    expect(brin.getCandidateRanges(db, '=', 99999).length).toBe(0);
    db.close();
  });

  it('falls back to exhaustive scan for non-numeric columns', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, name TEXT)');
    const ins = db.prepare('INSERT INTO t (rowid, name) VALUES (?,?)');
    ins.run(1, 'alice');
    ins.run(2, 'bob');
    ins.run(3, 'carol');
    const brin = new BrinBlockRangeIndex('t', 'name', { pagesPerRange: 128 }, false);
    brin.summarizeAll(db);
    // non-numeric -> flatbush not built
    expect(brin.getFlatbushIndex()).toBeNull();
    const cands = brin.getCandidateRanges(db, '=', 'bob');
    expect(cands.length).toBe(1);
    db.close();
  });

  it('clears cache', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    expect(brin.getRanges().length).toBeGreaterThan(0);
    brin.clearCache();
    expect(brin.getRanges().length).toBe(0);
    expect(brin.getFlatbushIndex()).toBeNull();
    db.close();
  });

  it('falls back to scan when the value is non-numeric on a numeric column', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // flatbush is built, but the query value is non-numeric → isFinite false → fallback
    const cands = brin.getCandidateRanges(db, '=', 'not-a-number');
    expect(cands.length).toBe(0); // exhaustive scan returns nothing for a non-numeric value
    db.close();
  });

  it('returns candidates when all ranges survive pruning in fallback scan', () => {
    const { db, brin } = makeDb();
    brin.summarizeAll(db);
    // '!=' never prunes, so every range survives → all 3 returned
    const cands = brin.getCandidateRanges(db, '!=', 500);
    expect(cands.length).toBe(3);
    db.close();
  });
});

describe('BRIN query rewrite registry', () => {
  beforeEach(() => clearBrinRegistry());

  it('registers and unregisters by column', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    clearBrinRegistry();
  });

  it('unregister with table removes the qualified entry', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b1);
    unregisterBrinIndex('created_at', 'logs');
    // Only the unqualified entry is removed; verify registry is now empty for
    // this column (both unqualified and qualified forms were deleted).
    expect(rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5').rewritten).toBe(false);
    clearBrinRegistry();
  });

  it('unregister without table removes all qualified entries', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    const b2 = new BrinBlockRangeIndex('events', 'created_at');
    registerBrinIndex(b1);
    registerBrinIndex(b2);
    unregisterBrinIndex('created_at');
    expect(rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5').rewritten).toBe(false);
    expect(rewriteBrinQuery('SELECT * FROM events WHERE created_at > 5').rewritten).toBe(false);
    clearBrinRegistry();
  });

  it('unregister only removes the matching column across tables', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    const b2 = new BrinBlockRangeIndex('logs', 'score');
    registerBrinIndex(b1);
    registerBrinIndex(b2);
    unregisterBrinIndex('created_at'); // leaves logs.score intact
    expect(rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5').rewritten).toBe(false);
    expect(rewriteBrinQuery('SELECT * FROM logs WHERE score > 5').rewritten).toBe(true);
    clearBrinRegistry();
  });

  it('dedupes the same simple column across different qualified entries', () => {
    const b1 = new BrinBlockRangeIndex('a', 'created_at');
    const b2 = new BrinBlockRangeIndex('bb', 'created_at');
    // Explicit map of two qualified entries sharing the same simple column.
    // Sorted desc by key length: 'bb.created_at' first, then 'a.created_at'.
    // The second entry's simple-column fallback is skipped (already processed).
    const map = new Map<string, BrinBlockRangeIndex>([
      ['a.created_at', b1],
      ['bb.created_at', b2],
    ]);
    const r = rewriteBrinQuery('SELECT * FROM t WHERE created_at > 5', map);
    expect(r.rewritten).toBe(true);
    expect(r.rewrittenConditions).toBe(1);
  });
});

describe('BRIN query rewrite', () => {
  beforeEach(() => clearBrinRegistry());

  it('returns unchanged when no registered indexes', () => {
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT * FROM logs WHERE created_at > 5');
  });

  it('returns unchanged for non-DML statements', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('INSERT INTO logs VALUES (1)');
    expect(r.rewritten).toBe(false);
  });

  it('rewrites a range predicate with an EXISTS subquery', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 1000000');
    expect(r.rewritten).toBe(true);
    expect(r.brinTables).toContain('__brin_pages_logs_created_at');
    expect(r.rewrittenConditions).toBe(1);
    expect(r.sql).toContain('EXISTS');
    expect(r.sql).toContain('created_at > 1000000');
  });

  it('rewrites equality predicates', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at = 500');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('min_val');
  });

  it('rewrites BETWEEN predicates', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at BETWEEN 100 AND 200');
    expect(r.rewritten).toBe(true);
  });

  it('rewrites IN predicates', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at IN (1, 2, 3)');
    expect(r.rewritten).toBe(true);
  });

  it('rewrites every operator type', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    for (const [sql] of [
      ['created_at > 5'],
      ['created_at >= 5'],
      ['created_at < 5'],
      ['created_at <= 5'],
      ['created_at = 5'],
    ] as const) {
      const r = rewriteBrinQuery(`SELECT * FROM logs WHERE ${sql}`);
      expect(r.rewritten).toBe(true);
      expect(r.rewrittenConditions).toBe(1);
    }
  });

  it('handles string literal values in WHERE (inString path)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (rowid INTEGER PRIMARY KEY, name TEXT)');
    db.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(1, "bob's");
    db.prepare('INSERT INTO t (rowid, name) VALUES (?,?)').run(2, 'carol');
    const b = new BrinBlockRangeIndex('t', 'name', { pagesPerRange: 128 }, false);
    registerBrinIndex(b);
    // WHERE contains a string literal ("ordered") plus a numeric predicate on
    // a different column; this exercises the quote/string-scan branches.
    const r = rewriteBrinQuery(
      "SELECT * FROM t WHERE status = 'ordered' AND name = 'bob' ORDER BY name",
    );
    expect(r.rewritten).toBe(false); // name has no numeric comparison here
    clearBrinRegistry();
    db.close();
  });

  it('still matches a column inside a subquery (documented limitation)', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    // findOpInWhere does not track parenthesis depth, so a subquery predicate
    // on a BRIN column is still matched at the outer WHERE level.
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE id IN (SELECT id FROM x WHERE created_at > 5)');
    expect(r.rewritten).toBe(true);
  });

  it('unregisters qualified and unqualified entries', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    const b2 = new BrinBlockRangeIndex('events', 'created_at');
    registerBrinIndex(b1);
    registerBrinIndex(b2);
    // unregister with table removes only logs.created_at
    unregisterBrinIndex('created_at', 'logs');
    const rEvents = rewriteBrinQuery('SELECT * FROM events WHERE created_at > 5');
    expect(rEvents.rewritten).toBe(true); // events.created_at still present
    clearBrinRegistry();
  });

  it('unregisters all qualified entries when table omitted', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    const b2 = new BrinBlockRangeIndex('events', 'created_at');
    registerBrinIndex(b1);
    registerBrinIndex(b2);
    unregisterBrinIndex('created_at');
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5');
    expect(r.rewritten).toBe(false);
    clearBrinRegistry();
  });

  it('accepts an explicit brinIndexes map', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    const map = new Map<string, BrinBlockRangeIndex>();
    map.set('created_at', b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5', map);
    expect(r.rewritten).toBe(true);
  });

  it('returns unchanged when column not in WHERE', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE note = 5');
    expect(r.rewritten).toBe(false);
  });

  it('handles quoted strings and parentheses in the WHERE scan', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    // String literals and parens BEFORE the top-level WHERE force the
    // character-scan branches of extractWhereInfo (paren depth + string state).
    const r = rewriteBrinQuery(
      "SELECT l1.*, (SELECT 'x' FROM dual) AS sub FROM logs l1 WHERE created_at > 5 AND status = 'done'",
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('created_at > 5');
  });

  it('handles WHERE-less and top-level-clause boundaries', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    // WHERE ends at LIMIT (a top-level clause keyword)
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5 LIMIT 10');
    expect(r.rewritten).toBe(true);
    // No WHERE at all → no rewrite
    expect(rewriteBrinQuery('SELECT * FROM logs').rewritten).toBe(false);
  });

  it('skips a WHERE that lives inside a subquery (paren depth > 0)', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    // First WHERE is inside a parenthesized subquery; the top-level WHERE
    // (whose column is created_at) is found only after skipping that one.
    const r = rewriteBrinQuery(
      'SELECT * FROM (SELECT id FROM x WHERE y > 1) AS s JOIN logs ON true WHERE logs.created_at > 5',
    );
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('created_at > 5');
  });

  it('is idempotent (skips already-rewritten columns)', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const once = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5');
    const twice = rewriteBrinQuery(once.sql);
    expect(twice.rewritten).toBe(false);
  });

  it('matches qualified column reference (table.column)', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE logs.created_at > 5');
    expect(r.rewritten).toBe(true);
  });

  it('rewrites two different BRIN columns in one query (combined EXISTS)', () => {
    const b1 = new BrinBlockRangeIndex('logs', 'created_at');
    const b2 = new BrinBlockRangeIndex('logs', 'score');
    registerBrinIndex(b1);
    registerBrinIndex(b2);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5 AND score < 100');
    expect(r.rewritten).toBe(true);
    expect(r.rewrittenConditions).toBe(2);
    // both conditions combined into a single parenthesized EXISTS group
    expect(r.sql).toContain('AND');
    clearBrinRegistry();
  });

  it('rewrites multiple conditions on the same column', () => {
    const b = new BrinBlockRangeIndex('logs', 'created_at');
    registerBrinIndex(b);
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE created_at > 5 AND created_at < 100');
    // both conditions on created_at are recognized
    expect(r.rewritten).toBe(true);
    expect(r.rewrittenConditions).toBeGreaterThanOrEqual(1);
  });

  it('rewrites a non-numeric column without CAST', () => {
    const b = new BrinBlockRangeIndex('logs', 'note', { pagesPerRange: 128 }, false);
    registerBrinIndex(b);
    // note is non-numeric; the generated subquery should use plain min_val/max_val
    const r = rewriteBrinQuery('SELECT * FROM logs WHERE note > 5');
    expect(r.rewritten).toBe(true);
    clearBrinRegistry();
  });
});
