import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { PrewarmShim } from '../query/PrewarmShim';

// PrewarmShim is a database-operation shim (not a SQL rewriter), so it has no
// literal-protection surface. Tests use a real in-memory DB and lock the
// page-warming contract exactly, including the mode branches and error paths.
describe('PrewarmShim', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
    db.exec("INSERT INTO t1 VALUES (1, 'alice', x'0102'), (2, 'bob', x'0304')");
  });

  afterEach(() => {
    db.close();
  });

  it('prewarms in read mode (page count from pragma)', () => {
    const s = new PrewarmShim(db);
    const r = s.prewarm('t1', 'read');
    expect(r.table).toBe('t1');
    expect(r.mode).toBe('read');
    expect(r.pagesRead).toBeGreaterThan(0);
    expect(r.bytesRead).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('treats prefetch mode like read (falls back)', () => {
    const s = new PrewarmShim(db);
    const r = s.prewarm('t1', 'prefetch');
    expect(r.mode).toBe('prefetch');
    expect(r.pagesRead).toBe(s.prewarm('t1', 'read').pagesRead);
  });

  it('prewarms in buffer mode with a full sequential scan', () => {
    const s = new PrewarmShim(db);
    const r = s.prewarm('t1', 'buffer');
    expect(r.mode).toBe('buffer');
    // pagesRead equals row count in buffer mode; bytesRead estimates row size.
    expect(r.pagesRead).toBe(2);
    expect(r.bytesRead).toBeGreaterThan(0);
  });

  it('skips null values when estimating row size in buffer mode', () => {
    db.exec('CREATE TABLE has_null (id INTEGER, note TEXT)');
    db.exec('INSERT INTO has_null VALUES (1, NULL)');
    const s = new PrewarmShim(db);
    const r = s.prewarm('has_null', 'buffer');
    expect(r.pagesRead).toBe(1);
    // Only `id` (number, +8) contributes; `note` is null and skipped.
    expect(r.bytesRead).toBe(8);
  });

  it('returns zero pages for an unknown mode (defensive fall-through)', () => {
    const s = new PrewarmShim(db);
    const r = s.prewarm('t1', 'not-a-mode' as unknown as 'read');
    // Unknown mode hits neither read/prefetch nor buffer branch.
    expect(r.mode).toBe('not-a-mode');
    expect(r.pagesRead).toBe(0);
    expect(r.bytesRead).toBe(0);
  });

  it('reports zero pages for an empty table (read mode)', () => {
    db.exec('CREATE TABLE empty_t (id INTEGER)');
    const s = new PrewarmShim(db);
    const r = s.prewarm('empty_t', 'read');
    expect(r.pagesRead).toBe(0);
    expect(r.bytesRead).toBe(0);
  });

  it('throws for a non-existent table', () => {
    const s = new PrewarmShim(db);
    expect(() => s.prewarm('nope')).toThrow('Table "nope" does not exist');
  });

  it('re-throws internal errors (catch path)', () => {
    const s = new PrewarmShim(db);
    // Force the inner prepare/count to throw after table existence is confirmed.
    const spy = vi.spyOn(db, 'prepare').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => s.prewarm('t1', 'read')).toThrow('boom');
    spy.mockRestore();
  });

  it('falls back to zero rows when COUNT returns an empty object', () => {
    const s = new PrewarmShim(db);
    // COUNT normally returns { "COUNT(*)": n }; simulate an empty record so
    // Object.values(...)[0] ?? 0 returns 0.
    const original = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(function (this: unknown, sql: string) {
      const stmt = original(sql);
      if (sql.includes('COUNT(*)') && sql.includes('FROM "t1"')) {
        return { ...stmt, get: () => ({}) };
      }
      return stmt;
    });
    const r = s.prewarm('t1', 'read');
    expect(r.pagesRead).toBe(0);
    expect(r.bytesRead).toBe(0);
    vi.restoreAllMocks();
  });

  it('prewarms all user tables and skips internal SQLite tables', () => {
    db.exec('CREATE TABLE t2 (id INTEGER)');
    const s = new PrewarmShim(db);
    const results = s.prewarmAll('read');
    const names = results.map((r) => r.table).sort();
    expect(names).toEqual(['t1', 't2']);
    expect(results.every((r) => r.mode === 'read')).toBe(true);
  });

  it('continues when a single table fails during prewarmAll', () => {
    const s = new PrewarmShim(db);
    // Make t1 fail while still allowing t2 to succeed.
    const original = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(function (this: unknown, sql: string) {
      if (sql.includes('FROM "t1"')) {
        throw new Error('scan failed');
      }
      return original(sql);
    });
    db.exec('CREATE TABLE t2 (id INTEGER)');
    const results = s.prewarmAll('read');
    // Only t2 succeeds; t1's failure is swallowed and logged.
    expect(results).toHaveLength(1);
    expect(results[0].table).toBe('t2');
    vi.restoreAllMocks();
  });
});
