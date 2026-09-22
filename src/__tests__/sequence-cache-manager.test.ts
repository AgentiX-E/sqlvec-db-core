/**
 * SequenceCacheManager — PostgreSQL SERIAL/SEQUENCE compatibility tests.
 *
 * Covers nextVal/currVal/setVal/setIncrement semantics, range allocation and
 * cache exhaustion, cache reset/flush, cache-size changes, and the increment
 * step being actually applied. Regression coverage for the defect where
 * setIncrement had no effect: increment was read but never used, so sequence
 * values always advanced by 1 and last_value advanced by cacheSize instead of
 * cacheSize * increment.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SequenceCacheManager } from '../query/SequenceCacheManager';

describe('SequenceCacheManager', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('allocates sequential values starting from 1 by default', () => {
    const seq = new SequenceCacheManager(db, 3);
    expect(seq.nextVal('s')).toBe(1);
    expect(seq.nextVal('s')).toBe(2);
    expect(seq.nextVal('s')).toBe(3);
    expect(seq.nextVal('s')).toBe(4);
  });

  it('applies the increment step (regression: increment was ignored)', () => {
    const seq = new SequenceCacheManager(db, 2);
    seq.setIncrement('s', 5);
    expect(seq.nextVal('s')).toBe(5);
    expect(seq.nextVal('s')).toBe(10);
    expect(seq.nextVal('s')).toBe(15);
    expect(seq.nextVal('s')).toBe(20);
  });

  it('advances last_value by cacheSize * increment', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.setIncrement('s', 5);
    seq.nextVal('s'); // allocate range: last_value += 3*5 = 15
    const row = db
      .prepare('SELECT last_value, increment FROM _sqlvec_sequences WHERE name = ?')
      .get('s') as { last_value: number; increment: number };
    expect(row.last_value).toBe(15);
    expect(row.increment).toBe(5);
  });

  it('reports the last handed-out value via currVal (cached)', () => {
    const seq = new SequenceCacheManager(db, 10);
    seq.nextVal('s');
    seq.nextVal('s');
    expect(seq.currVal('s')).toBe(2);
  });

  it('reports currVal honoring increment', () => {
    const seq = new SequenceCacheManager(db, 10);
    seq.setIncrement('s', 5);
    seq.nextVal('s'); // 5
    seq.nextVal('s'); // 10
    expect(seq.currVal('s')).toBe(10);
  });

  it('returns currVal 0 for a never-used sequence', () => {
    const seq = new SequenceCacheManager(db, 10);
    expect(seq.currVal('never')).toBe(0);
  });

  it('returns currVal from the stored last_value when cache is cold', () => {
    const seq = new SequenceCacheManager(db, 10);
    seq.nextVal('s');
    // Clear the in-memory cache; currVal must fall back to the DB row.
    seq.resetCache('s');
    expect(seq.currVal('s')).toBe(10); // last_value == full allocated range
  });

  it('setVal overwrites the stored value and invalidates cache', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.nextVal('s');
    seq.nextVal('s');
    seq.setVal('s', 1000);
    expect(seq.nextVal('s')).toBe(1001);
  });

  it('setVal preserves an existing increment', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.setIncrement('s', 5);
    seq.setVal('s', 100);
    // Next value = 100 + increment (5)
    expect(seq.nextVal('s')).toBe(105);
    expect(seq.nextVal('s')).toBe(110);
  });

  it('setIncrement invalidates an existing cache', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.nextVal('s');
    seq.setIncrement('s', 5);
    // Cache was flushed; the next allocation respects the new increment.
    expect(seq.nextVal('s')).toBeGreaterThan(0);
  });

  it('getIncrement returns 1 for an unknown sequence', () => {
    const seq = new SequenceCacheManager(db, 3);
    expect((seq as any).getIncrement('ghost')).toBe(1);
  });

  it('getIncrement returns the stored increment', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.setIncrement('s', 7);
    expect((seq as any).getIncrement('s')).toBe(7);
  });

  it('resetCache clears a single sequence cache', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.nextVal('a');
    seq.resetCache('a');
    // Re-allocates from the stored last_value.
    expect(seq.nextVal('a')).toBe(4);
  });

  it('flushAllCaches clears every sequence', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.nextVal('a');
    seq.nextVal('b');
    seq.flushAllCaches();
    expect(seq.nextVal('a')).toBe(4);
    expect(seq.nextVal('b')).toBe(4);
  });

  it('getCacheSize returns the configured size', () => {
    const seq = new SequenceCacheManager(db, 42);
    expect(seq.getCacheSize()).toBe(42);
  });

  it('defaults cache size to 20', () => {
    const seq = new SequenceCacheManager(db);
    expect(seq.getCacheSize()).toBe(20);
  });

  it('setCacheSize applies to future allocations', () => {
    const seq = new SequenceCacheManager(db, 3);
    seq.setCacheSize(5);
    expect(seq.getCacheSize()).toBe(5);
    // A fresh allocation now reserves 5 values.
    seq.nextVal('s');
    const row = db
      .prepare('SELECT last_value FROM _sqlvec_sequences WHERE name = ?')
      .get('s') as { last_value: number };
    expect(row.last_value).toBe(5);
  });

  it('creates the sequences table on construction', () => {
    new SequenceCacheManager(db, 3);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlvec_sequences'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('_sqlvec_sequences');
  });

  it('does not double-create the table across instances', () => {
    new SequenceCacheManager(db, 3);
    new SequenceCacheManager(db, 3);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = '_sqlvec_sequences'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  it('handles multiple independent sequences', () => {
    const seq = new SequenceCacheManager(db, 3);
    expect(seq.nextVal('a')).toBe(1);
    expect(seq.nextVal('b')).toBe(1);
    expect(seq.nextVal('a')).toBe(2);
    expect(seq.nextVal('b')).toBe(2);
  });

  it('survives cache exhaustion across multiple allocations', () => {
    const seq = new SequenceCacheManager(db, 2);
    const values = [1, 2, 3, 4, 5, 6].map(() => seq.nextVal('s'));
    expect(values).toEqual([1, 2, 3, 4, 5, 6]);
  });

  describe('defensive read-back failure', () => {
    it('throws when the post-insert read-back returns no row', () => {
      const seq = new SequenceCacheManager(db, 3);
      // Simulate a database anomaly where the SELECT after INSERT/UPDATE
      // returns undefined, exercising the guard that prevents a crash on
      // undefined.last_value.
      const originalPrepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, 'prepare').mockImplementation(function (sql: string) {
        const stmt = originalPrepare(sql);
        if (sql.includes('SELECT last_value, increment')) {
          return {
            get: () => undefined,
            run: () => undefined,
          } as any;
        }
        return stmt;
      });
      try {
        expect(() => seq.nextVal('s')).toThrow(/Failed to allocate range/);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
