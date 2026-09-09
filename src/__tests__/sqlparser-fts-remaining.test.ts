import { describe, it, expect } from 'vitest';
import { parseStatement, detectFTS, rewriteFTS } from '../query/SqlParser';

// Remaining truly-reachable branches: parseInsertHeuristic values-tuple index
// bounds, parseUpdate/Delete empty table, parseDDL 'truncate', extractDDLTable
// from, PREPARE without AS, parseParamValues depth tracking, detectFTS default
// config (plainto/phraseto without config arg), and rewriteFTS column+queryText
// and generic @@ paths.

describe('SqlParser insert heuristic value-tuple bounds', () => {
  it('values tuple shorter than id column index → skipped', () => {
    // columns: (id, name); tuple has only one value → values[0] exists but
    // values[1] undefined; id is index 0 so still extracted. Use a table where
    // id is NOT first to trigger the bounds guard.
    const r = parseStatement('INSERT INTO t (name, id) VALUES (\'a\')');
    expect((r as any).keyColumn).toBe('id');
    expect((r as any).keyValues).toBeUndefined();
  });
});

describe('SqlParser parseDDL truncate + extractDDLTable from', () => {
  it('TRUNCATE maps ddlType OTHER', () => {
    const r = parseStatement('TRUNCATE t');
    expect((r as any).type).toBe('DDL');
  });

  it('DROP TABLE via from?.name path', () => {
    const r = parseStatement('DROP TABLE sometable');
    expect((r as any).table).toBe('sometable');
  });
});

describe('SqlParser detectFTS default config', () => {
  it('plainto_tsquery without config defaults to english', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ plainto_tsquery('hello world')");
    expect(f.hasFts).toBe(true);
    expect(f.configName).toBe('english');
    expect(f.queryText).toBe('hello world');
  });

  it('phraseto_tsquery without config defaults to english', () => {
    const f = detectFTS("SELECT * FROM t WHERE col @@ phraseto_tsquery('big data')");
    expect(f.configName).toBe('english');
  });
});

describe('SqlParser rewriteFTS column+queryText and generic @@', () => {
  it('rewrites when column and queryText extracted (MATCH form)', () => {
    const r = rewriteFTS("SELECT * FROM t WHERE col @@ plainto_tsquery('hello')");
    expect(r).toContain('MATCH');
  });

  it('rewrites generic @@ without column/query', () => {
    const r = rewriteFTS('SELECT * FROM t WHERE a @@ b');
    expect(r).not.toContain('@@');
  });

  it('returns unchanged when hasFts but no @@ (to_tsvector only)', () => {
    const sql = "SELECT to_tsvector('english', body) FROM t";
    const r = rewriteFTS(sql);
    expect(r).toBe(sql);
  });

  it('returns unchanged when hasFts but no @@ (to_tsquery only)', () => {
    const sql = "SELECT to_tsquery('english', 'hello') FROM t";
    const r = rewriteFTS(sql);
    expect(r).toBe(sql);
  });
});
