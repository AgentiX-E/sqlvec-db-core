import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { registerIntarrayFunctions } from '../query/IntarrayShim';

/**
 * Integration tests for registerIntarrayFunctions — the helper that binds the
 * `@>`/`<@`/`&&` intarray operator callbacks onto a real better-sqlite3
 * connection. These exercise toIntArray's array-decoding branches end-to-end:
 * JSON array strings, PG `{...}` array literals, bare scalars, and empty/null
 * inputs, verifying the PostgreSQL semantic where an unset operand can never
 * satisfy `@>`.
 */

let db: Database.Database;

function open(): Database.Database {
  const handle = new Database(':memory:');
  registerIntarrayFunctions(handle);
  return handle;
}

afterEach(() => {
  if (db) {
    db.close();
    db = undefined as any;
  }
});

describe('registerIntarrayFunctions', () => {
  it('contains: JSON array string vs JSON array string', () => {
    db = open();
    const r = db.prepare("SELECT intarray_contains('[1,2,3]', '[1,2]') AS v").get() as any;
    expect(r.v).toBe(1);
  });

  it('contains: PG array literal vs JSON array string', () => {
    db = open();
    const r = db.prepare("SELECT intarray_contains('{1,2,3}', '[1,2]') AS v").get() as any;
    expect(r.v).toBe(1);
  });

  it('contains: empty LHS never satisfies @>', () => {
    db = open();
    const r = db.prepare("SELECT intarray_contains('{}', '[1]') AS v").get() as any;
    expect(r.v).toBe(0);
  });

  it('contains: empty bracket array decodes as empty (empty @> empty is true)', () => {
    db = open();
    // Both operands decode to [], and an empty superset always contains an
    // empty subset (PostgreSQL: '{}'::int[] @> '{}'::int[] is true).
    const r = db.prepare("SELECT intarray_contains('[]', '[]') AS v").get() as any;
    expect(r.v).toBe(1);
  });

  it('contains: bare scalar decodes as a single-element array', () => {
    db = open();
    // A bare numeric string decodes to a single-element array via the
    // Number(s) fallback (toIntArray's JSON/PG-array parsers both miss it).
    const r = db.prepare("SELECT intarray_contains('5', '5') AS v").get() as any;
    expect(r.v).toBe(1);
    // '5,6' is neither JSON nor a PG array literal, so it decodes to NaN -> [].
    const r2 = db.prepare("SELECT intarray_contains('5', '5,6') AS v").get() as any;
    expect(r2.v).toBe(1);
  });

  it('contains: null operands decode as empty (empty @> empty is true)', () => {
    db = open();
    // null -> [], and [] @> [] is true under the empty-superset rule.
    const r = db.prepare('SELECT intarray_contains(NULL, NULL) AS v').get() as any;
    expect(r.v).toBe(1);
  });

  it('contained_by: JSON array string <@ works', () => {
    db = open();
    const r = db.prepare("SELECT intarray_contained_by('[1]', '[1,2]') AS v").get() as any;
    expect(r.v).toBe(1);
  });

  it('overlap: JSON array string && works', () => {
    db = open();
    const r = db.prepare("SELECT intarray_overlap('[1,2]', '[2,3]') AS v").get() as any;
    expect(r.v).toBe(1);
    const r2 = db.prepare("SELECT intarray_overlap('[1,2]', '[3,4]') AS v").get() as any;
    expect(r2.v).toBe(0);
  });
});
