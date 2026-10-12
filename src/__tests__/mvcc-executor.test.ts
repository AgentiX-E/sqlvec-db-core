import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MvccExecutor } from '../executor/MvccExecutor';
import type { MvccContext } from '../query/MVCCShim';

// MvccExecutor implements MVCC UPDATE (mark old row __xmax + INSERT new version)
// and DELETE (soft delete via __xmax). Tables without MVCC columns pass through.
describe('MvccExecutor', () => {
  let db: Database.Database;
  let ex: MvccExecutor;
  const ctx = { currentXid: 99 } as MvccContext;

  beforeEach(() => {
    db = new Database(':memory:');
    ex = new MvccExecutor(db);
  });

  describe('getSchema / hasMvccColumns', () => {
    it('detects MVCC columns', () => {
      db.exec('CREATE TABLE t (id INT, __xmin INT, __xmax INT, __ctid INT)');
      expect(ex.hasMvccColumns('t')).toBe(true);
      expect(ex.getSchema('t').columns).toContain('__xmin');
    });

    it('reports non-MVCC tables', () => {
      db.exec('CREATE TABLE plain (id INT, name TEXT)');
      expect(ex.hasMvccColumns('plain')).toBe(false);
    });

    it('returns empty columns for a missing table (no throw)', () => {
      expect(ex.getSchema('does_not_exist')).toEqual({
        name: 'does_not_exist',
        columns: [],
        hasMvccColumns: false,
      });
    });

    // BUG regression: `public.users` used to be cleaned to `publicusers`,
    // which failed to resolve and returned an empty schema.
    it('strips a schema qualifier (schema.table)', () => {
      db.exec('CREATE TABLE t (id INT, __xmin INT, __xmax INT, __ctid INT)');
      expect(ex.getSchema('public.t').name).toBe('t');
      expect(ex.getSchema('public.t').hasMvccColumns).toBe(true);
    });

    it('strips surrounding quotes/brackets', () => {
      db.exec('CREATE TABLE t (id INT)');
      expect(ex.getSchema('"t"').name).toBe('t');
      expect(ex.getSchema('[t]').name).toBe('t');
    });

    it('caches schema and clears on clearCache', () => {
      db.exec('CREATE TABLE t (id INT, __xmin INT, __xmax INT, __ctid INT)');
      expect(ex.getSchema('t').hasMvccColumns).toBe(true);
      ex.clearCache();
      expect(ex.getSchema('t').hasMvccColumns).toBe(true);
    });
  });

  describe('executeUpdate', () => {
    it('returns 0 for a non-UPDATE string', () => {
      expect(ex.executeUpdate('SELECT 1', ctx)).toBe(0);
    });

    it('passes through a non-MVCC table', () => {
      db.exec('CREATE TABLE t (id INT, name TEXT)');
      db.exec("INSERT INTO t VALUES (1, 'alice')");
      expect(ex.executeUpdate("UPDATE t SET name = 'bob' WHERE id = 1", ctx)).toBe(1);
      expect(db.prepare('SELECT name FROM t WHERE id = 1').get()).toEqual({ name: 'bob' });
    });

    it('runs as-is when the table has only MVCC columns (<=3)', () => {
      db.exec('CREATE TABLE t (__xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t VALUES (1, 0, 1)');
      expect(ex.executeUpdate('UPDATE t SET __xmax = 5', ctx)).toBe(1);
    });

    it('returns 0 when there is no SET clause', () => {
      db.exec('CREATE TABLE t (id INT, v INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t VALUES (1, 10, 1, 0, 1)');
      expect(ex.executeUpdate('UPDATE t WHERE id = 1', ctx)).toBe(0);
    });

    it('returns 0 when no rows match the WHERE clause', () => {
      db.exec('CREATE TABLE t (id INT, v INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t VALUES (1, 10, 1, 0, 1)');
      expect(ex.executeUpdate('UPDATE t SET v = 99 WHERE id = 999', ctx)).toBe(0);
    });

    it('performs the MVCC UPDATE dance (mark old + insert new)', () => {
      db.exec('CREATE TABLE t (name TEXT, age INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (name, age, __xmin, __xmax, __ctid) VALUES ('alice', 30, 1, 0, 1)");
      const n = ex.executeUpdate("UPDATE t SET age = 40 WHERE name = 'alice'", ctx);
      expect(n).toBe(1);
      const rows = db.prepare('SELECT name, age, __xmin, __xmax, __ctid FROM t ORDER BY rowid').all();
      // old version marked deleted (__xmax = 99), new version visible
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ name: 'alice', age: 30, __xmax: 99 });
      expect(rows[1]).toMatchObject({ name: 'alice', age: 40, __xmin: 99, __xmax: 0 });
    });

    it('sets a NULL literal', () => {
      db.exec('CREATE TABLE t (name TEXT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (name, __xmin, __xmax, __ctid) VALUES ('alice', 1, 0, 1)");
      ex.executeUpdate("UPDATE t SET name = NULL WHERE name = 'alice'", ctx);
      const latest = db.prepare('SELECT name FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ name: null });
    });

    it('sets boolean and numeric literals', () => {
      db.exec('CREATE TABLE t (a INT, b INT, c INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t (a, b, c, __xmin, __xmax, __ctid) VALUES (0, 0, 0, 1, 0, 1)');
      ex.executeUpdate('UPDATE t SET a = TRUE, b = FALSE, c = 42 WHERE 1=1', ctx);
      const latest = db.prepare('SELECT a, b, c FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ a: 1, b: 0, c: 42 });
    });

    // BUG regression: `SET name = 'a,b'` was split on the comma inside the
    // string literal, producing a corrupted value.
    it('preserves a comma inside a string literal in SET', () => {
      db.exec('CREATE TABLE t (name TEXT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (name, __xmin, __xmax, __ctid) VALUES ('alice', 1, 0, 1)");
      ex.executeUpdate("UPDATE t SET name = 'a,b' WHERE name = 'alice'", ctx);
      const latest = db.prepare('SELECT name FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ name: 'a,b' });
    });

    it('skips a SET pair with no equals sign', () => {
      db.exec('CREATE TABLE t (name TEXT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (name, __xmin, __xmax, __ctid) VALUES ('alice', 1, 0, 1)");
      ex.executeUpdate("UPDATE t SET name WHERE name = 'alice'", ctx);
      const latest = db.prepare('SELECT name FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ name: 'alice' }); // unchanged: no-op pair skipped
    });

    it('tolerates a trailing WHERE with no condition (defaults 1=1)', () => {
      db.exec('CREATE TABLE t (a INT, b INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t (a, b, __xmin, __xmax, __ctid) VALUES (1, 2, 1, 0, 1)');
      const n = ex.executeUpdate('UPDATE t SET a = 5 WHERE', ctx);
      expect(n).toBe(1);
    });

    it('tolerates a trailing comma in the SET list', () => {
      db.exec('CREATE TABLE t (a INT, b INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t (a, b, __xmin, __xmax, __ctid) VALUES (1, 2, 1, 0, 1)');
      const n = ex.executeUpdate('UPDATE t SET a = 5, WHERE 1=1', ctx);
      expect(n).toBe(1);
      const latest = db.prepare('SELECT a, b FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ a: 5, b: 2 });
    });

    it('handles a double-quoted string literal', () => {
      db.exec('CREATE TABLE t (a TEXT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (a, __xmin, __xmax, __ctid) VALUES ('x', 1, 0, 1)");
      ex.executeUpdate('UPDATE t SET a = "doublequoted" WHERE 1=1', ctx);
      const latest = db.prepare('SELECT a FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ a: 'doublequoted' });
    });

    it('falls back to a raw expression for an unparsed value', () => {
      db.exec('CREATE TABLE t (a TEXT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t (a, __xmin, __xmax, __ctid) VALUES ('x', 1, 0, 1)");
      ex.executeUpdate('UPDATE t SET a = col + 1 WHERE 1=1', ctx);
      const latest = db.prepare('SELECT a FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ a: 'col + 1' });
    });
  });

  describe('executeDelete', () => {
    it('returns 0 for a non-DELETE string', () => {
      expect(ex.executeDelete('SELECT 1', ctx)).toBe(0);
    });

    it('hard-deletes on a non-MVCC table', () => {
      db.exec('CREATE TABLE t (id INT, name TEXT)');
      db.exec("INSERT INTO t VALUES (1, 'alice')");
      expect(ex.executeDelete('DELETE FROM t WHERE id = 1', ctx)).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS c FROM t').get()).toEqual({ c: 0 });
    });

    it('soft-deletes (sets __xmax) on an MVCC table', () => {
      db.exec('CREATE TABLE t (id INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec("INSERT INTO t VALUES (1, 1, 0, 1)");
      db.exec("INSERT INTO t VALUES (2, 1, 0, 2)");
      expect(ex.executeDelete('DELETE FROM t WHERE id = 1', ctx)).toBe(1);
      const rows = db.prepare('SELECT id, __xmax FROM t ORDER BY id').all();
      expect(rows[0]).toEqual({ id: 1, __xmax: 99 });
      expect(rows[1]).toEqual({ id: 2, __xmax: 0 });
    });

    it('soft-deletes all rows when no WHERE clause', () => {
      db.exec('CREATE TABLE t (id INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t VALUES (1, 1, 0, 1)');
      db.exec('INSERT INTO t VALUES (2, 1, 0, 2)');
      expect(ex.executeDelete('DELETE FROM t', ctx)).toBe(2);
      const rows = db.prepare('SELECT __xmax FROM t').all();
      expect(rows.every((r) => r.__xmax === 99)).toBe(true);
    });
  });

  describe('parseLiteral (via executeUpdate)', () => {
    it('parses a quoted string, number, NULL, TRUE, FALSE', () => {
      db.exec('CREATE TABLE t (s TEXT, n INT, x INT, b INT, __xmin INT, __xmax INT, __ctid INT)');
      db.exec('INSERT INTO t (s, n, x, b, __xmin, __xmax, __ctid) VALUES (0, 0, 0, 0, 1, 0, 1)');
      ex.executeUpdate("UPDATE t SET s = 'hi', n = 12.5, x = NULL, b = FALSE WHERE 1=1", ctx);
      const latest = db.prepare('SELECT s, n, x, b FROM t WHERE __xmax = 0').get();
      expect(latest).toEqual({ s: 'hi', n: 12.5, x: null, b: 0 });
    });
  });
});
