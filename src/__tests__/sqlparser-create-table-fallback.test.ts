import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// pgsql-ast-parser v12 rejects `CREATE TABLE ... AS SELECT` and `PARTITION BY`,
// so those fall through to fallbackParse's CREATE TABLE branch. Lock that the
// target table is preserved and that SERIAL is still rewritten when the query
// only reaches the fallback path.
describe('SqlParser CREATE TABLE fallback', () => {
  it('extracts the target table from CREATE TABLE AS SELECT', () => {
    const r = parseStatement('CREATE TABLE t AS SELECT * FROM u') as any;
    expect(r.type).toBe('DDL');
    expect(r.table).toBe('t');
  });

  it('rewrites SERIAL in a PARTITION BY (fallback) CREATE TABLE', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL) PARTITION BY RANGE (id)') as any;
    expect(r.table).toBe('t');
    expect(r.rewrittenSql).toContain('INTEGER PRIMARY KEY AUTOINCREMENT');
  });
});
