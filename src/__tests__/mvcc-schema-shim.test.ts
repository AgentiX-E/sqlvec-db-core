/**
 * mvcc-schema-shim.test.ts — Coverage tests for MvccSchemaShim
 * (MVCC row-version column injection + write/read path SQL rewriting).
 */

import { describe, it, expect } from 'vitest';
import { MvccSchemaShim } from '../query/MvccSchemaShim';

const shim = new MvccSchemaShim();

// ──────────────────────────────────────────────
//  injectRowVersionColumns
// ──────────────────────────────────────────────

describe('injectRowVersionColumns', () => {
  it('injects row version columns into a plain CREATE TABLE', () => {
    expect(shim.injectRowVersionColumns('CREATE TABLE users (id INT, name TEXT)')).toBe(
      'CREATE TABLE IF NOT EXISTS users (id INT, name TEXT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });

  it('preserves schema-qualified table name', () => {
    expect(shim.injectRowVersionColumns('CREATE TABLE myschema.t (id INT)')).toBe(
      'CREATE TABLE IF NOT EXISTS myschema.t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });

  it('injects before table-level constraints', () => {
    expect(
      shim.injectRowVersionColumns('CREATE TABLE t (id INT, CONSTRAINT pk PRIMARY KEY (id), name TEXT)'),
    ).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0, CONSTRAINT pk PRIMARY KEY (id), name TEXT)',
    );
  });

  it('injects before CHECK constraint', () => {
    expect(shim.injectRowVersionColumns('CREATE TABLE t (id INT, CHECK (id > 0))')).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0, CHECK (id > 0))',
    );
  });

  it('injects before UNIQUE(name) without space (table-level constraint)', () => {
    // `UNIQUE(name)` is a table-level constraint (SQLite accepts both
    // `UNIQUE (name)` and `UNIQUE(name)`), so the MVCC columns are injected
    // before it, preserving column-definitions-before-constraints ordering.
    expect(shim.injectRowVersionColumns('CREATE TABLE t (id INT, UNIQUE(name))')).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0, UNIQUE(name))',
    );
  });

  it('preserves inline PRIMARY KEY AUTOINCREMENT (regression)', () => {
    // `INTEGER PRIMARY KEY AUTOINCREMENT` is an inline column constraint; the
    // MVCC columns must be appended, NOT injected between `INTEGER` and
    // `PRIMARY KEY` (which previously produced `... PRIMARY KEY AUTOINCREMENT`
    // without a column name, a SQL syntax error).
    const out = shim.injectRowVersionColumns(
      'CREATE TABLE d (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT)',
    );
    expect(out).toBe(
      'CREATE TABLE IF NOT EXISTS d (id INTEGER PRIMARY KEY AUTOINCREMENT, a TEXT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });

  it('preserves inline UNIQUE column constraint', () => {
    const out = shim.injectRowVersionColumns('CREATE TABLE t (id INT, name TEXT UNIQUE)');
    expect(out).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, name TEXT UNIQUE, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });

  it('preserves inline CHECK column constraint', () => {
    const out = shim.injectRowVersionColumns('CREATE TABLE t (id INT CHECK (id > 0))');
    expect(out).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT CHECK (id > 0), _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });

  it('injects before UNIQUE (name) with space (table-level constraint)', () => {
    expect(shim.injectRowVersionColumns('CREATE TABLE t (id INT, UNIQUE (name))')).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0, UNIQUE (name))',
    );
  });

  it('skips CREATE TEMP TABLE', () => {
    const sql = 'CREATE TEMP TABLE t (id INT)';
    expect(shim.injectRowVersionColumns(sql)).toBe(sql);
  });

  it('skips CREATE TEMPORARY TABLE', () => {
    const sql = 'CREATE TEMPORARY TABLE t (id INT)';
    expect(shim.injectRowVersionColumns(sql)).toBe(sql);
  });

  it('skips CREATE TABLE AS SELECT', () => {
    const sql = 'CREATE TABLE t AS SELECT * FROM src';
    expect(shim.injectRowVersionColumns(sql)).toBe(sql);
  });

  it('skips when row version columns already present', () => {
    const sql = 'CREATE TABLE t (id INT DEFAULT 0, _xmin INTEGER)';
    expect(shim.injectRowVersionColumns(sql)).toBe(sql);
  });

  it('skips non-CREATE TABLE SQL', () => {
    const sql = 'SELECT * FROM t';
    expect(shim.injectRowVersionColumns(sql)).toBe(sql);
  });

  it('handles IF NOT EXISTS', () => {
    expect(shim.injectRowVersionColumns('CREATE TABLE IF NOT EXISTS t (id INT)')).toBe(
      'CREATE TABLE IF NOT EXISTS t (id INT, _xmin INTEGER DEFAULT 0, _xmax INTEGER DEFAULT 0, _cmin INTEGER DEFAULT 0, _cmax INTEGER DEFAULT 0)',
    );
  });
});

// ──────────────────────────────────────────────
//  hasRowVersionColumns
// ──────────────────────────────────────────────

describe('hasRowVersionColumns', () => {
  it('returns true when _xmin present', () => {
    expect(shim.hasRowVersionColumns('_xmin INTEGER')).toBe(true);
  });

  it('returns true when _xmax present', () => {
    expect(shim.hasRowVersionColumns('_xmax INTEGER')).toBe(true);
  });

  it('returns true when _cmin/_cmax present', () => {
    expect(shim.hasRowVersionColumns('_cmin INTEGER')).toBe(true);
    expect(shim.hasRowVersionColumns('_cmax INTEGER')).toBe(true);
  });

  it('returns false when none present', () => {
    expect(shim.hasRowVersionColumns('id INT, name TEXT')).toBe(false);
  });
});

// ──────────────────────────────────────────────
//  alterTableAddRowVersionColumns
// ──────────────────────────────────────────────

describe('alterTableAddRowVersionColumns', () => {
  it('generates four ALTER TABLE ADD COLUMN statements', () => {
    expect(shim.alterTableAddRowVersionColumns('t')).toBe(
      'ALTER TABLE t ADD COLUMN _xmin INTEGER DEFAULT 0; ' +
        'ALTER TABLE t ADD COLUMN _xmax INTEGER DEFAULT 0; ' +
        'ALTER TABLE t ADD COLUMN _cmin INTEGER DEFAULT 0; ' +
        'ALTER TABLE t ADD COLUMN _cmax INTEGER DEFAULT 0',
    );
  });
});

// ──────────────────────────────────────────────
//  rewriteWriteSql — dispatch
// ──────────────────────────────────────────────

describe('rewriteWriteSql — dispatch', () => {
  it('routes INSERT to _rewriteInsert', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t VALUES (1)', 50)).toEqual([
      'INSERT INTO t VALUES (1, 50, NULL, 0, 0)',
    ]);
  });

  it('routes UPDATE to _rewriteUpdate', () => {
    const r = shim.rewriteWriteSql('UPDATE t SET a = 1 WHERE id = 1', 50);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe('UPDATE t SET _xmax = 50 WHERE id = 1 AND (_xmax IS NULL OR _xmax = 0)');
    expect(r[1]).toBe('UPDATE t SET _xmin = 50, _xmax = NULL, a = 1 WHERE id = 1');
  });

  it('routes DELETE to _rewriteDelete', () => {
    expect(shim.rewriteWriteSql('DELETE FROM t WHERE id = 1', 50)).toEqual([
      'UPDATE t SET _xmax = 50 WHERE id = 1',
    ]);
  });

  it('passes through DDL and other statements', () => {
    expect(shim.rewriteWriteSql('CREATE TABLE x (id INT)', 50)).toEqual([
      'CREATE TABLE x (id INT)',
    ]);
    expect(shim.rewriteWriteSql('DROP TABLE x', 50)).toEqual(['DROP TABLE x']);
  });
});

// ──────────────────────────────────────────────
//  _rewriteInsert (via rewriteWriteSql)
// ──────────────────────────────────────────────

describe('_rewriteInsert', () => {
  it('skips when _xmin already in SQL', () => {
    const sql = 'INSERT INTO t (_xmin, c1) VALUES (1, 2)';
    expect(shim.rewriteWriteSql(sql, 50)).toEqual([sql]);
  });

  it('INSERT with column list + VALUES → appends columns and values', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t (c1, c2) VALUES (1, 2)', 50)).toEqual([
      'INSERT INTO t (c1, c2, _xmin, _xmax, _cmin, _cmax) VALUES (1, 2, 50, NULL, 0, 0)',
    ]);
  });

  it('INSERT with column list + multiple VALUES tuples', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t (c1) VALUES (1), (2)', 50)).toEqual([
      'INSERT INTO t (c1, _xmin, _xmax, _cmin, _cmax) VALUES (1, 50, NULL, 0, 0), (2, 50, NULL, 0, 0)',
    ]);
  });

  it('INSERT with column list + SELECT → appends _xmin/_xmax', () => {
    expect(
      shim.rewriteWriteSql('INSERT INTO t (c1, c2) SELECT a, b FROM src WHERE x = 1', 50),
    ).toEqual([
      'INSERT INTO t (c1, c2, _xmin, _xmax) SELECT a, b , 50 AS _xmin, NULL AS _xmax FROM src WHERE x = 1',
    ]);
  });

  it('INSERT with column list + SELECT without FROM → appends to tail', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t (c1) SELECT 1', 50)).toEqual([
      'INSERT INTO t (c1, _xmin, _xmax) SELECT 1, 50 AS _xmin, NULL AS _xmax',
    ]);
  });

  it('INSERT without column list + VALUES → appends to each tuple', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t VALUES (1, 2), (3, 4)', 50)).toEqual([
      'INSERT INTO t VALUES (1, 2, 50, NULL, 0, 0), (3, 4, 50, NULL, 0, 0)',
    ]);
  });

  it('INSERT with function call inside tuple (nested parens)', () => {
    expect(shim.rewriteWriteSql('INSERT INTO t VALUES (NOW())', 50)).toEqual([
      'INSERT INTO t VALUES (NOW(), 50, NULL, 0, 0)',
    ]);
  });

  it('INSERT without recognizable pattern → pass through', () => {
    // No VALUES clause and no column list → returns unchanged
    const sql = 'INSERT INTO t DEFAULT VALUES';
    expect(shim.rewriteWriteSql(sql, 50)).toEqual([sql]);
  });
});

// ──────────────────────────────────────────────
//  _rewriteUpdate (via rewriteWriteSql)
// ──────────────────────────────────────────────

describe('_rewriteUpdate', () => {
  it('UPDATE with WHERE → logical delete + updated row', () => {
    expect(shim.rewriteWriteSql('UPDATE t SET a = 1 WHERE id = 5', 50)).toEqual([
      'UPDATE t SET _xmax = 50 WHERE id = 5 AND (_xmax IS NULL OR _xmax = 0)',
      'UPDATE t SET _xmin = 50, _xmax = NULL, a = 1 WHERE id = 5',
    ]);
  });

  it('UPDATE without WHERE → guard-only logical delete', () => {
    expect(shim.rewriteWriteSql('UPDATE t SET a = 1', 50)).toEqual([
      'UPDATE t SET _xmax = 50 WHERE (_xmax IS NULL OR _xmax = 0)',
      'UPDATE t SET _xmin = 50, _xmax = NULL, a = 1',
    ]);
  });

  it('UPDATE that already has _xmin → skips re-injection in second stmt', () => {
    expect(shim.rewriteWriteSql('UPDATE t SET _xmin = 5 WHERE id = 1', 50)).toEqual([
      'UPDATE t SET _xmax = 50 WHERE id = 1 AND (_xmax IS NULL OR _xmax = 0)',
      'UPDATE t SET _xmin = 5 WHERE id = 1',
    ]);
  });

  it('UPDATE not matching UPDATE SET → pass through', () => {
    const sql = 'UPDATE t'; // no SET
    expect(shim.rewriteWriteSql(sql, 50)).toEqual([sql]);
  });
});

// ──────────────────────────────────────────────
//  _rewriteDelete (via rewriteWriteSql)
// ──────────────────────────────────────────────

describe('_rewriteDelete', () => {
  it('DELETE with WHERE → soft delete', () => {
    expect(shim.rewriteWriteSql('DELETE FROM t WHERE id = 5', 50)).toEqual([
      'UPDATE t SET _xmax = 50 WHERE id = 5',
    ]);
  });

  it('DELETE without WHERE → soft delete without predicate', () => {
    expect(shim.rewriteWriteSql('DELETE FROM t', 50)).toEqual(['UPDATE t SET _xmax = 50']);
  });

  it('DELETE without table name → pass through', () => {
    const sql = 'DELETE FROM'; // no table name, DELETE_REGEX fails to match
    expect(shim.rewriteWriteSql(sql, 50)).toEqual([sql]);
  });
});

// ──────────────────────────────────────────────
//  injectSelectVisibility
// ──────────────────────────────────────────────

describe('injectSelectVisibility', () => {
  it('injects transactional visibility predicate for snapshot > 0', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t', 5)).toBe(
      'SELECT * FROM t WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5)',
    );
  });

  it('injects autocommit predicate for snapshot 0', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t', 0)).toBe(
      'SELECT * FROM t WHERE (_xmax IS NULL OR _xmax = 0)',
    );
  });

  it('injects before existing WHERE conditions', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t WHERE id > 1', 5)).toBe(
      'SELECT * FROM t WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5) AND id > 1',
    );
  });

  it('returns unchanged when _xmin predicate already present', () => {
    const sql = 'SELECT * FROM t WHERE _xmin <= 5';
    expect(shim.injectSelectVisibility(sql, 5)).toBe(sql);
  });

  it('returns unchanged when no FROM clause', () => {
    const sql = 'SELECT 1';
    expect(shim.injectSelectVisibility(sql, 5)).toBe(sql);
  });

  it('injects before ORDER BY', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t ORDER BY id', 5)).toBe(
      'SELECT * FROM t  WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5) ORDER BY id',
    );
  });

  it('injects before LIMIT', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t LIMIT 10', 5)).toBe(
      'SELECT * FROM t  WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5) LIMIT 10',
    );
  });

  it('injects before earliest of multiple trailing clauses', () => {
    // Two trailing clauses (ORDER BY then LIMIT): the second pattern's index
    // is >= the first, exercising the non-taken branch of the min-index check.
    expect(shim.injectSelectVisibility('SELECT * FROM t ORDER BY id LIMIT 10', 5)).toBe(
      'SELECT * FROM t  WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5) ORDER BY id LIMIT 10',
    );
  });

  it('injects before GROUP BY', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t GROUP BY id', 5)).toBe(
      'SELECT * FROM t  WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5) GROUP BY id',
    );
  });

  it('appends WHERE at end when no trailing clause', () => {
    expect(shim.injectSelectVisibility('SELECT * FROM t', 5)).toBe(
      'SELECT * FROM t WHERE (_xmin = 0 OR _xmin <= 5) AND (_xmax IS NULL OR _xmax = 0 OR _xmax > 5)',
    );
  });
});
