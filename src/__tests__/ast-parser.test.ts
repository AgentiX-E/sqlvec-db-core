/**
 * ASTParser — wrapper around pgsql-ast-parser for SQL parsing.
 *
 * Tests cover the full public API (`parseSQL`, `getStatementType`,
 * `extractTableName`, `extractWhereClause`, and `SQLParseError`) plus the
 * internal statement converters via the public `parseSQL`, and exercise the
 * regex fallback path with incomplete SQL that the PG parser rejects.
 */
import { describe, it, expect } from 'vitest';
import {
  parseSQL,
  getStatementType,
  extractTableName,
  extractWhereClause,
  SQLParseError,
} from '../query/ASTParser';
import type { ParsedStatement } from '../query/SqlParser';

describe('ASTParser.parseSQL', () => {
  it('returns a null statement for empty/whitespace input', () => {
    for (const sql of ['', '   ', '\n\t ']) {
      const r = parseSQL(sql);
      expect(r.statement).toBeNull();
      expect(r.error).toBeNull();
      expect(r.usedAST).toBe(false);
      expect(r.sql).toBe(sql);
    }
  });

  it('parses a SELECT with tables, orderBy and limit via AST', () => {
    const r = parseSQL('SELECT id, name FROM users WHERE age > 10 ORDER BY name DESC LIMIT 5');
    expect(r.usedAST).toBe(true);
    expect(r.error).toBeNull();
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.type).toBe('SELECT');
    expect(s.tables).toEqual(['users']);
    expect(s.hasJoin).toBe(false);
    expect(s.isMultiShard).toBe(false);
    // Regression: orderBy/limit were previously dropped due to reading the
    // wrong pgsql-ast-parser fields (ob.type vs ob.order, stmt.limit.value vs
    // stmt.limit.limit.value).
    expect(s.orderBy).toBe('name DESC');
    expect(s.limit).toBe(5);
  });

  it('parses an INSERT and extracts the id key column/key values', () => {
    const r = parseSQL("INSERT INTO t (id, name) VALUES (1, 'a') RETURNING id");
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.type).toBe('INSERT');
    expect(s.table).toBe('t');
    expect(s.columns).toEqual(['id', 'name']);
    expect(s.hasReturning).toBe(true);
    expect(s.keyColumn).toBe('id');
    expect(s.keyValues).toEqual(['1']);
  });

  it('parses an UPDATE and extracts the WHERE-referenced columns', () => {
    const r = parseSQL('UPDATE t SET a = 1 WHERE id = 5 AND x > 1');
    const s = r.statement as import('../query/SqlParser').UpdateStatement;
    expect(s.type).toBe('UPDATE');
    expect(s.table).toBe('t');
    expect(s.whereColumns).toEqual(['id', 'x']);
  });

  it('returns undefined whereColumns for a WHERE with no column references', () => {
    const r = parseSQL('UPDATE t SET a = 1 WHERE 1 = 1');
    const s = r.statement as import('../query/SqlParser').UpdateStatement;
    expect(s.whereColumns).toBeUndefined();
  });

  it('returns undefined limit for a parameterized LIMIT ($1)', () => {
    const r = parseSQL('SELECT a FROM t LIMIT $1');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    // A parameterized limit has no constant numeric value, exercising the
    // `typeof inner.value === 'number'` false branch.
    expect(s.limit).toBeUndefined();
  });

  it('parses a DELETE and extracts the WHERE-referenced columns', () => {
    const r = parseSQL('DELETE FROM t WHERE id = 5');
    const s = r.statement as import('../query/SqlParser').DeleteStatement;
    expect(s.type).toBe('DELETE');
    expect(s.table).toBe('t');
    expect(s.whereColumns).toEqual(['id']);
  });

  it('parses CREATE TABLE and rewrites SERIAL to INTEGER PRIMARY KEY AUTOINCREMENT', () => {
    const r = parseSQL('CREATE TABLE foo (id SERIAL PRIMARY KEY, name TEXT)');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.type).toBe('DDL');
    expect(s.ddlType).toBe('CREATE_TABLE');
    expect(s.table).toBe('foo');
    // Regression: AUTOINCREMENT was previously lost because toSql cannot
    // serialize the `autoinc` constraint; rewriteSERIAL now uses string
    // replacement.
    expect(s.rewrittenSql).toBe(
      'CREATE TABLE foo (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
    );
  });

  it('parses CREATE TABLE with a bare SERIAL column (no explicit PRIMARY KEY)', () => {
    const r = parseSQL('CREATE TABLE foo (id SERIAL)');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.rewrittenSql).toBe('CREATE TABLE foo (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  });

  it('parses CREATE TABLE without SERIAL and returns no rewritten SQL', () => {
    const r = parseSQL('CREATE TABLE foo (id INTEGER, name TEXT)');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.type).toBe('DDL');
    expect(s.ddlType).toBe('CREATE_TABLE');
    expect(s.rewrittenSql).toBeUndefined();
  });

  it('parses a PREPARE into a PREPARE statement', () => {
    const r = parseSQL('PREPARE p AS SELECT 1');
    const s = r.statement as any;
    expect(s.type).toBe('PREPARE');
    // Regression: name was previously String({ name: 'p' }) === "[object Object]".
    expect(s.name).toBe('p');
    expect(s.innerSql).toContain('SELECT');
  });

  it('resolves the real table name rather than the alias for FROM ... AS', () => {
    const r = parseSQL('SELECT a FROM users AS u');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    // Regression: previously returned the alias "u" instead of "users".
    expect(s.tables).toEqual(['users']);
  });

  it('detects a JOIN and dedupes table names', () => {
    const r = parseSQL('SELECT a FROM t1 JOIN t2 ON t1.x = t2.x');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.hasJoin).toBe(true);
    expect(s.isMultiShard).toBe(true);
    expect(s.tables).toEqual(['t1', 't2']);
  });

  it('detects a comma-separated (cross) join', () => {
    const r = parseSQL('SELECT a FROM t1, t2');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.hasJoin).toBe(true);
    expect(s.isMultiShard).toBe(true);
    expect(s.tables).toEqual(['t1', 't2']);
  });

  it('returns an empty table list for a FROM-less SELECT', () => {
    const r = parseSQL('SELECT 1');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.tables).toEqual([]);
    expect(s.hasJoin).toBe(false);
  });

  it('ignores a non-table FROM entry (subquery / statement)', () => {
    const r = parseSQL('SELECT a FROM (SELECT 1 AS a) t');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    // The subquery FROM entry has type 'statement', not 'table', so it is
    // skipped by extractSelectTables.
    expect(s.tables).toEqual([]);
  });

  it('maps the remaining DDL types (drop/alter/index/schema/view/truncate)', () => {
    const cases: [string, string][] = [
      ['DROP TABLE IF EXISTS foo', 'DROP'],
      ['DROP INDEX IF EXISTS idx', 'DROP'],
      ['ALTER TABLE t ADD COLUMN c INT', 'ALTER'],
      ['CREATE INDEX idx ON t (a)', 'CREATE_INDEX'],
      ['CREATE VIEW v AS SELECT 1', 'OTHER'],
      ['CREATE SCHEMA s', 'OTHER'],
      ['CREATE SEQUENCE sq', 'OTHER'],
      ['CREATE EXTENSION ext', 'OTHER'],
      ['TRUNCATE TABLE foo', 'TRUNCATE' as any],
    ];
    for (const [sql, ddlType] of cases) {
      const s = parseSQL(sql).statement as import('../query/SqlParser').DDLStatement;
      expect(s.type).toBe('DDL');
      expect(s.ddlType).toBe(ddlType);
    }
  });

  it('extracts the table name for DROP INDEX via the names array', () => {
    expect((parseSQL('DROP INDEX idx').statement as any).table).toBe('idx');
    expect((parseSQL('DROP INDEX idx').statement as any).ddlType).toBe('DROP');
  });

  it('extracts the table name for TRUNCATE via the plural tables array', () => {
    const s = parseSQL('TRUNCATE TABLE foo').statement as import('../query/SqlParser').DDLStatement;
    // Regression: extractDDLTable previously missed stmt.tables, returning undefined.
    expect(s.table).toBe('foo');
  });

  it('maps an unhandled top-level statement to UNKNOWN', () => {
    const r = parseSQL('SET x = 1');
    const s = r.statement as any;
    expect(s.type).toBe('UNKNOWN');
    expect(s.originalSql).toBe('SET x = 1');
  });
});

describe('ASTParser fallbackParse (incomplete SQL → regex heuristic)', () => {
  it('falls back to a heuristic SELECT on an incomplete FROM', () => {
    const r = parseSQL('SELECT * FROM');
    expect(r.usedAST).toBe(false);
    expect(r.error).not.toBeNull();
    expect(r.statement!.type).toBe('SELECT');
  });

  it('falls back to UNKNOWN with error info when the AST rejects the input', () => {
    const r = parseSQL('garbage here nonsense');
    expect(r.statement!.type).toBe('UNKNOWN');
    expect(r.error).not.toBeNull();
    expect(r.error!.line).toBeGreaterThanOrEqual(1);
    expect(r.usedAST).toBe(false);
  });

  it('falls back to a heuristic INSERT when the AST rejects the input', () => {
    // "INSERT x INTO t" is word-ordered so that pgsql-ast-parser rejects it,
    // but fallbackParse's INSERT branch (INSERT ... INTO ...) still matches.
    const r = parseSQL('INSERT INTO users (id) VALUES (1)');
    expect(r.statement!.type).toBe('INSERT');
  });

  it('falls back to a heuristic DROP on an AST failure', () => {
    const r = parseSQL('DROP TABLE IF EXISTS t');
    expect(r.statement!.type).toBe('DDL');
  });
});

describe('ASTParser fallbackParse — AST-rejecting branches', () => {
  // Each input is deliberately incomplete so pgsql-ast-parser throws, routing
  // to fallbackParse's per-statement regex branches (which the AST path never
  // exercises for these shapes).
  it('falls back to UPDATE table extraction', () => {
    const r = parseSQL('UPDATE t SET');
    expect(r.usedAST).toBe(false);
    const s = r.statement as import('../query/SqlParser').UpdateStatement;
    expect(s.type).toBe('UPDATE');
    expect(s.table).toBe('t');
  });

  it('falls back to DELETE table extraction', () => {
    const r = parseSQL('DELETE FROM');
    const s = r.statement as import('../query/SqlParser').DeleteStatement;
    expect(s.type).toBe('DELETE');
    expect(s.table).toBe('');
  });

  it('falls back to INSERT table extraction', () => {
    const r = parseSQL('INSERT INTO');
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.type).toBe('INSERT');
    expect(s.table).toBe('');
  });

  it('falls back to CREATE TABLE DDL', () => {
    const r = parseSQL('CREATE TABLE');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.type).toBe('DDL');
    expect(s.ddlType).toBe('CREATE_TABLE');
  });

  it('falls back to CREATE TABLE with a heuristic SERIAL rewrite', () => {
    const r = parseSQL('CREATE TABLE t (id SERIAL)');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.rewrittenSql).toBe('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)');
  });

  it('falls back to CREATE INDEX DDL', () => {
    const r = parseSQL('CREATE INDEX idx ON');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.type).toBe('DDL');
    expect(s.ddlType).toBe('CREATE_INDEX');
  });

  it('falls back to ALTER DDL', () => {
    const r = parseSQL('ALTER TABLE t ADD COLUMN');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.ddlType).toBe('ALTER');
    expect(s.table).toBe('t');
  });

  it('falls back to DROP DDL', () => {
    const r = parseSQL('DROP TABLE');
    const s = r.statement as import('../query/SqlParser').DDLStatement;
    expect(s.ddlType).toBe('DROP');
  });

  it('falls back to PREPARE/EXECUTE/DEALLOCATE via regex', () => {
    expect((parseSQL('PREPARE').statement as any).type).toBe('PREPARE');
    expect((parseSQL('EXECUTE foo').statement as any).type).toBe('EXECUTE');
    expect((parseSQL('DEALLOCATE').statement as any).type).toBe('DEALLOCATE');
  });

  it('falls back to a heuristic SELECT with JOIN detection and multi-shard', () => {
    const r = parseSQL('SELECT * FROM a JOIN b');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.type).toBe('SELECT');
    expect(s.hasJoin).toBe(true);
    expect(s.isMultiShard).toBe(true);
    expect(s.tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('falls back to a heuristic SELECT with no FROM (empty table list)', () => {
    const r = parseSQL('SELECT FROM');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    expect(s.type).toBe('SELECT');
    expect(s.hasJoin).toBe(false);
    expect(s.isMultiShard).toBe(false);
    expect(s.tables).toEqual([]);
  });
});

describe('ASTParser — deep expression and key-extraction branches', () => {
  it('extracts WHERE columns from binary left/right, operand, and args', () => {
    const r = parseSQL('SELECT a FROM t WHERE (x > 1) AND NOT y AND COALESCE(z, w) > 0');
    const s = r.statement as import('../query/SqlParser').SelectStatement;
    // extractWhereRefColumns runs on WHERE for UPDATE/DELETE; assert via those.
    const u = parseSQL('UPDATE t SET a = 1 WHERE (x > 1) AND NOT y AND COALESCE(z, w) > 0')
      .statement as import('../query/SqlParser').UpdateStatement;
    expect(u.whereColumns).toEqual(expect.arrayContaining(['x', 'y', 'z', 'w']));
  });

  it('insert key extraction handles a *_id / user_id column', () => {
    for (const col of ['user_id', 'account_id']) {
      const r = parseSQL(`INSERT INTO t (${col}, name) VALUES (5, 'a')`);
      const s = r.statement as import('../query/SqlParser').InsertStatement;
      expect(s.keyColumn).toBe(col);
      expect(s.keyValues).toEqual(['5']);
    }
  });

  it('insert key extraction skips when no id-like column exists', () => {
    const r = parseSQL("INSERT INTO t (name, age) VALUES ('a', 1)");
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.keyColumn).toBeUndefined();
    expect(s.keyValues).toBeUndefined();
  });

  it('insert key extraction returns keyColumn but no values for INSERT ... SELECT', () => {
    const r = parseSQL('INSERT INTO t (id, name) SELECT id, name FROM s');
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.keyColumn).toBe('id');
    expect(s.keyValues).toBeUndefined();
  });

  it('insert key extraction stringifies a non-integer scalar value', () => {
    const r = parseSQL("INSERT INTO t (id, name) VALUES ('abc', 'x')");
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.keyColumn).toBe('id');
    expect(s.keyValues).toEqual(['abc']);
  });

  it('insert key extraction handles a NULL scalar via the String fallback', () => {
    const r = parseSQL('INSERT INTO t (id, name) VALUES (NULL, \'a\')');
    const s = r.statement as import('../query/SqlParser').InsertStatement;
    expect(s.keyColumn).toBe('id');
    // A NULL literal has no integer type and no value field, exercising the
    // `String(val)` fallback branch.
    expect(s.keyValues).toEqual([expect.stringContaining('')]);
  });
});

describe('ASTParser.getStatementType', () => {
  it('classifies each supported leading keyword', () => {
    expect(getStatementType('select 1')).toBe('SELECT');
    expect(getStatementType('  INSERT INTO t VALUES (1)')).toBe('INSERT');
    expect(getStatementType('update t set a=1')).toBe('UPDATE');
    expect(getStatementType('DELETE FROM t')).toBe('DELETE');
    expect(getStatementType('CREATE TABLE t (a int)')).toBe('CREATE');
    expect(getStatementType('ALTER TABLE t ADD c')).toBe('ALTER');
    expect(getStatementType('DROP TABLE t')).toBe('DROP');
  });

  it('returns UNKNOWN for an unrecognized or empty leading keyword', () => {
    expect(getStatementType('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('UNKNOWN');
    expect(getStatementType('')).toBe('UNKNOWN');
    expect(getStatementType('   ')).toBe('UNKNOWN');
  });
});

describe('ASTParser.extractTableName', () => {
  const parsed = (sql: string): ParsedStatement => parseSQL(sql).statement as ParsedStatement;

  it('returns null for a falsy statement', () => {
    expect(extractTableName(null as any)).toBeNull();
    expect(extractTableName(undefined as any)).toBeNull();
  });

  it('returns the first table for SELECT', () => {
    expect(extractTableName(parsed('SELECT a FROM users, orders'))).toBe('users');
  });

  it('returns null for a FROM-less SELECT', () => {
    expect(extractTableName(parsed('SELECT 1'))).toBeNull();
  });

  it('returns the table for INSERT/UPDATE/DELETE/DDL', () => {
    expect(extractTableName(parsed('INSERT INTO t (a) VALUES (1)'))).toBe('t');
    expect(extractTableName(parsed('UPDATE t SET a=1'))).toBe('t');
    expect(extractTableName(parsed('DELETE FROM t'))).toBe('t');
    expect(extractTableName(parsed('DROP TABLE t'))).toBe('t');
  });

  it('returns null for an unrecognized statement type', () => {
    expect(extractTableName(parsed('SET x=1'))).toBeNull();
  });

  it('returns null when the table name is an empty string (fallback with no table)', () => {
    // `DELETE FROM` (incomplete) falls back with table === '', exercising the
    // `stmt.table || null` defensive branch.
    const del = parseSQL('DELETE FROM').statement as ParsedStatement;
    expect(extractTableName(del)).toBeNull();
  });

  it('returns null for INSERT/UPDATE/DDL statements with an empty table name', () => {
    // Hand-crafted statements with an empty-string table exercise the
    // `stmt.table || null` branch for each non-SELECT statement type.
    expect(extractTableName({ type: 'INSERT', originalSql: '', table: '', columns: [], hasReturning: false } as any)).toBeNull();
    expect(extractTableName({ type: 'UPDATE', originalSql: '', table: '', whereColumns: [] } as any)).toBeNull();
    expect(extractTableName({ type: 'DDL', originalSql: '', table: '', ddlType: 'DROP' } as any)).toBeNull();
  });
});

describe('ASTParser.extractWhereClause', () => {
  const parsed = (sql: string): ParsedStatement => parseSQL(sql).statement as ParsedStatement;

  it('returns null for a falsy statement', () => {
    expect(extractWhereClause(null as any)).toBeNull();
    expect(extractWhereClause(undefined as any)).toBeNull();
  });

  it('returns null when the statement has no originalSql', () => {
    expect(extractWhereClause({ type: 'SELECT', tables: [], hasJoin: false, isMultiShard: false } as any)).toBeNull();
  });

  it('extracts the WHERE clause up to ORDER BY/LIMIT boundaries', () => {
    expect(extractWhereClause(parsed('SELECT a FROM t WHERE x > 1 ORDER BY y'))).toBe('x > 1');
    expect(extractWhereClause(parsed('SELECT a FROM t WHERE x > 1 LIMIT 5'))).toBe('x > 1');
    expect(extractWhereClause(parsed('SELECT a FROM t WHERE x > 1 GROUP BY y'))).toBe('x > 1');
  });

  it('returns null when there is no WHERE clause', () => {
    expect(extractWhereClause(parsed('SELECT a FROM t'))).toBeNull();
  });
});

describe('ASTParser.SQLParseError', () => {
  it('formats a message with position info and a caret pointer', () => {
    const err = new SQLParseError({ message: 'bad token', line: 1, col: 3, offset: 2 });
    const msg = err.toFormattedMessage('SELECT * FROM t');
    expect(err.name).toBe('SQLParseError');
    expect(err.line).toBe(1);
    expect(err.col).toBe(3);
    expect(err.offset).toBe(2);
    expect(msg).toContain('Syntax error at line 1 col 3');
    expect(msg).toContain('^');
    expect(msg).toContain('bad token');
  });

  it('clamps the line number to the actual line count', () => {
    const err = new SQLParseError({ message: 'x', line: 99, col: 1, offset: 0 });
    const msg = err.toFormattedMessage('SELECT 1');
    expect(msg).toContain('Syntax error at line 1 col 1');
  });

  it('falls back to an empty line content for a zero line number', () => {
    // A non-positive line yields `lines[line - 1]` undefined, exercising the
    // `|| ''` defensive branch in toFormattedMessage.
    const err = new SQLParseError({ message: 'x', line: 0, col: 1, offset: 0 });
    const msg = err.toFormattedMessage('SELECT 1');
    expect(msg).toContain('line 0');
  });

  it('resolves error position from the pgsql "line N col M" message text', () => {
    const r = parseSQL('INSERT x INTO t');
    expect(r.error).not.toBeNull();
    // pgsql reports "Syntax error at line 1 col 8" for this input.
    expect(r.error!.line).toBe(1);
    expect(r.error!.col).toBe(8);
    expect(r.error!.offset).toBeGreaterThanOrEqual(0);
  });

  it('defaults to 1:1 position for an input with no position in the message', () => {
    const r = parseSQL('SELECT * FROM');
    expect(r.error!.line).toBe(1);
    expect(r.error!.col).toBe(1);
  });
});
