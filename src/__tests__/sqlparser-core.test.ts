import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  serializeStatement,
} from '../query/SqlParser';

describe('SqlParser.parseStatement — empty & transaction fast paths', () => {
  it('returns UNKNOWN for empty/whitespace SQL', () => {
    expect(parseStatement('').type).toBe('UNKNOWN');
    expect(parseStatement('   \n\t ').type).toBe('UNKNOWN');
  });

  it('parses BEGIN as TRANSACTION', () => {
    const r = parseStatement('BEGIN');
    expect(r.type).toBe('TRANSACTION');
    expect((r as any).command).toBe('BEGIN');
  });

  it('parses COMMIT and END as TRANSACTION COMMIT', () => {
    expect((parseStatement('COMMIT') as any).command).toBe('COMMIT');
    expect((parseStatement('END') as any).command).toBe('COMMIT');
  });

  it('parses ROLLBACK and ABORT as TRANSACTION ROLLBACK', () => {
    expect((parseStatement('ROLLBACK') as any).command).toBe('ROLLBACK');
    expect((parseStatement('ABORT') as any).command).toBe('ROLLBACK');
  });

  it('parses SET TRANSACTION', () => {
    const r = parseStatement('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(r.type).toBe('TRANSACTION');
    expect((r as any).command).toBe('SET TRANSACTION');
  });
});

describe('SqlParser.parseStatement — INSERT heuristic fast path', () => {
  it('parses INSERT with table, columns, keyColumn, keyValues, RETURNING', () => {
    const r = parseStatement('INSERT INTO users (id, name) VALUES (1, \'alice\'), (2, \'bob\') RETURNING id');
    expect(r.type).toBe('INSERT');
    expect((r as any).table).toBe('users');
    expect((r as any).columns).toEqual(['id', 'name']);
    expect((r as any).hasReturning).toBe(true);
    expect((r as any).keyColumn).toBe('id');
    expect((r as any).keyValues).toEqual(['1', '2']);
  });

  it('parses INSERT without id-like column as empty keyValues', () => {
    const r = parseStatement('INSERT INTO t (name, age) VALUES (\'x\', 30)');
    expect((r as any).keyColumn).toBeUndefined();
  });

  it('parses INSERT DEFAULT VALUES (no match → empty table)', () => {
    const r = parseStatement('INSERT INTO t DEFAULT VALUES');
    expect(r.type).toBe('INSERT');
    expect((r as any).table).toBe('t');
  });
});

describe('SqlParser.parseStatement — SELECT AST path', () => {
  it('parses simple SELECT with tables and no join', () => {
    const r = parseStatement('SELECT id, name FROM users WHERE id = 42');
    expect(r.type).toBe('SELECT');
    expect((r as any).tables).toContain('users');
    expect((r as any).hasJoin).toBe(false);
  });

  it('parses JOIN and marks hasJoin + isMultiShard', () => {
    const r = parseStatement('SELECT * FROM a JOIN b ON a.id = b.id');
    expect((r as any).tables).toEqual(expect.arrayContaining(['a', 'b']));
    expect((r as any).hasJoin).toBe(true);
  });

  it('parses SELECT with LIMIT and ORDER BY', () => {
    const r = parseStatement('SELECT * FROM t ORDER BY id DESC LIMIT 10');
    expect((r as any).limit).toBe(10);
    expect((r as any).orderBy).toContain('DESC');
  });

  it('parses comma-separated multi-table FROM as join', () => {
    const r = parseStatement('SELECT * FROM a, b WHERE a.id = b.id');
    expect((r as any).hasJoin).toBe(true);
  });
});

describe('SqlParser.parseStatement — UPDATE / DELETE / DDL', () => {
  it('parses UPDATE with whereColumns', () => {
    const r = parseStatement('UPDATE t SET x = 1 WHERE id = 5');
    expect(r.type).toBe('UPDATE');
    expect((r as any).table).toBe('t');
    expect((r as any).whereColumns).toContain('id');
  });

  it('parses DELETE with whereColumns', () => {
    const r = parseStatement('DELETE FROM t WHERE id = 3');
    expect(r.type).toBe('DELETE');
    expect((r as any).table).toBe('t');
  });

  it('parses CREATE TABLE as DDL with ddlType CREATE_TABLE', () => {
    const r = parseStatement('CREATE TABLE t (id SERIAL PRIMARY KEY, name TEXT)');
    expect(r.type).toBe('DDL');
    expect((r as any).ddlType).toBe('CREATE_TABLE');
  });

  it('parses CREATE INDEX / DROP TABLE / ALTER TABLE', () => {
    expect((parseStatement('CREATE INDEX idx ON t (name)') as any).ddlType).toBe('CREATE_INDEX');
    expect((parseStatement('DROP TABLE t') as any).ddlType).toBe('DROP');
    expect((parseStatement('ALTER TABLE t ADD COLUMN x INT') as any).ddlType).toBe('ALTER');
  });
});

describe('SqlParser.parseStatement — WITH / CTE', () => {
  it('parses WITH ... SELECT and extracts inner SELECT', () => {
    const r = parseStatement('WITH c AS (SELECT * FROM t) SELECT * FROM c');
    expect(r.type).toBe('SELECT');
  });
});

describe('SqlParser.serializeStatement', () => {
  it('returns the original SQL', () => {
    const p = parseStatement('SELECT 1');
    expect(serializeStatement(p)).toBe('SELECT 1');
  });
});
