import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

/**
 * Regression tests for table-name extraction in SELECT statements.
 *
 * The `tables` array of a parsed SELECT is consumed downstream by partition
 * routing, shard routing, and column-privilege checks — all of which index
 * metadata by the *real* table name, never by a FROM alias. These tests pin
 * that contract so an alias like `users AS u` resolves to `users`, not `u`.
 */
describe('SELECT table-name extraction (alias handling)', () => {
  it('returns the real table name for a plain FROM', () => {
    const r = parseStatement('SELECT * FROM users');
    expect((r as any).tables).toEqual(['users']);
  });

  it('returns the real table name, not the alias, for `FROM t AS x`', () => {
    const r = parseStatement('SELECT * FROM users AS u');
    expect((r as any).tables).toEqual(['users']);
  });

  it('returns real names for every aliased table in a multi-table FROM', () => {
    const r = parseStatement('SELECT * FROM users AS u, orders AS o');
    expect((r as any).tables).toEqual(['users', 'orders']);
  });

  it('ignores a bare alias without a name (defensive empty-name branch)', () => {
    // `AS` with a quoted/empty identifier should not produce a bogus table.
    const r = parseStatement('SELECT * FROM ""');
    expect((r as any).tables).toEqual([]);
  });

  it('keeps the real name consistent between a top-level FROM and a subquery FROM', () => {
    const top = parseStatement('SELECT * FROM users AS u');
    const sub = parseStatement('SELECT * FROM (SELECT * FROM users AS u) x');
    // The same logical table must resolve to the same name in both contexts.
    expect((sub as any).tables).toEqual(expect.arrayContaining(['users']));
    expect((top as any).tables).toEqual(['users']);
  });
});
