import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerPgScalarFunctions } from '../system/FunctionRegistry';

/**
 * Integration tests for registerPgScalarFunctions — the helper that binds PG
 * scalar UDFs onto a real better-sqlite3 connection. These verify the return
 * value marshalling at the SQLite boundary:
 *   - boolean results are coerced to integer 0/1, and
 *   - array results are serialized as a JSON array string (SQLite cannot
 *     represent raw JS arrays or booleans).
 *
 * Using a real in-memory connection proves the fix end-to-end rather than
 * relying on the pure-JS registerPgScalarFunctions unit surface.
 */

let db: Database.Database;

function open(): Database.Database {
  const handle = new Database(':memory:');
  registerPgScalarFunctions(handle);
  return handle;
}

afterEach(() => {
  if (db) {
    db.close();
    db = undefined as any;
  }
});

describe('registerPgScalarFunctions return marshalling', () => {
  it('coerces a boolean-returning function to integer 1', () => {
    db = open();
    const row = db.prepare("SELECT pg_cancel_backend(1) AS v").get() as any;
    expect(row.v).toBe(1);
  });

  it('coerces a boolean-returning function to integer 0', () => {
    db = open();
    const row = db.prepare('SELECT pg_is_in_recovery() AS v').get() as any;
    expect(row.v).toBe(0);
  });

  it('returns numeric results unchanged', () => {
    db = open();
    const row = db.prepare('SELECT abs(-7) AS v').get() as any;
    expect(row.v).toBe(7);
  });

  it('returns string results unchanged', () => {
    db = open();
    const row = db.prepare("SELECT md5('abc') AS v").get() as any;
    expect(row.v).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('serializes array-returning functions as JSON array strings', () => {
    db = open();
    const row = db.prepare("SELECT regexp_split_to_array('a,b,c', ',') AS v").get() as any;
    // SQLite cannot store a raw JS array; assert it arrives as a JSON string.
    expect(typeof row.v).toBe('string');
    expect(JSON.parse(row.v)).toEqual(['a', 'b', 'c']);
  });

  it('binds the inet member functions as scalar UDFs', () => {
    db = open();
    const host = db.prepare("SELECT host('192.168.1.10/24') AS v").get() as any;
    expect(host.v).toBe('192.168.1.10');
    const family = db.prepare("SELECT family('::1') AS v").get() as any;
    expect(family.v).toBe(6);
  });
});
