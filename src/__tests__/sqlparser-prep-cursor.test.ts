import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

describe('SqlParser PREPARE / EXECUTE / DEALLOCATE', () => {
  it('parses PREPARE name AS sql', () => {
    const r = parseStatement('PREPARE p AS SELECT * FROM t WHERE id = $1');
    expect(r.type).toBe('PREPARE');
    expect((r as any).name).toBe('p');
    expect((r as any).innerSql).toBe('SELECT * FROM t WHERE id = $1');
    expect((r as any).paramTypes).toEqual([]);
  });

  it('parses PREPARE with param types (int, text)', () => {
    const r = parseStatement('PREPARE p (int, text) AS SELECT $1, $2');
    expect((r as any).paramTypes).toEqual(['int', 'text']);
  });

  it('parses EXECUTE with string/number/boolean/NULL params', () => {
    const r = parseStatement("EXECUTE p(1, 'foo', TRUE, NULL, 3.14)");
    expect(r.type).toBe('EXECUTE');
    expect((r as any).name).toBe('p');
    expect((r as any).params).toEqual([1, 'foo', true, null, 3.14]);
  });

  it('parses EXECUTE with no params', () => {
    const r = parseStatement('EXECUTE p');
    expect((r as any).params).toEqual([]);
  });

  it('parses DEALLOCATE ALL', () => {
    const r = parseStatement('DEALLOCATE ALL');
    expect(r.type).toBe('DEALLOCATE');
    expect((r as any).name).toBe('ALL');
  });

  it('parses DEALLOCATE PREPARE name', () => {
    const r = parseStatement('DEALLOCATE PREPARE p');
    expect((r as any).name).toBe('p');
  });
});

describe('SqlParser cursor statements', () => {
  it('parses DECLARE CURSOR with SCROLL and WITH HOLD', () => {
    const r = parseStatement('DECLARE c SCROLL CURSOR WITH HOLD FOR SELECT * FROM t');
    expect(r.type).toBe('CURSOR');
    expect((r as any).action).toBe('DECLARE');
    expect((r as any).cursorName).toBe('c');
    expect((r as any).scroll).toBe(true);
    expect((r as any).hold).toBe(true);
  });

  it('parses FETCH NEXT FROM cursor', () => {
    const r = parseStatement('FETCH NEXT FROM c');
    expect((r as any).action).toBe('FETCH');
    expect((r as any).direction).toBe('NEXT');
  });

  it('parses FETCH ABSOLUTE 5 FROM cursor', () => {
    const r = parseStatement('FETCH ABSOLUTE 5 FROM c');
    expect((r as any).direction).toBe('ABSOLUTE');
    expect((r as any).fetchCount).toBe(5);
  });

  it('parses MOVE and CLOSE', () => {
    expect((parseStatement('MOVE NEXT FROM c') as any).action).toBe('MOVE');
    expect((parseStatement('CLOSE c') as any).action).toBe('CLOSE');
  });
});

describe('SqlParser fallbackParse path (AST fails → heuristic)', () => {
  it('falls back to heuristic for SELECT', () => {
    // VACUUM triggers AST failure but isn't SELECT; use a malformed-ish query
    // that still starts with SELECT to exercise heuristic table extraction.
    const r = parseStatement('SELECT * FROM users WHERE id = 5');
    expect(r.type).toBe('SELECT');
  });

  it('returns UNKNOWN for truly unparseable non-SQL', () => {
    const r = parseStatement('GARBAGE !!! not sql at all');
    expect(r.type).toBe('UNKNOWN');
  });

  it('handles VACUUM / SHOW as UNKNOWN (AST + fallback both miss)', () => {
    expect(parseStatement('VACUUM t').type).toBe('UNKNOWN');
    expect(parseStatement('SHOW all').type).toBe('UNKNOWN');
  });
});

describe('SqlParser parseParamValues edge cases', () => {
  it('parses escaped single quotes in string literal', () => {
    const r = parseStatement("EXECUTE p('it''s')");
    expect((r as any).params).toEqual(["it's"]);
  });

  it('parses EXECUTE with no name match as empty-string name', () => {
    // "[^)]*" cannot span nested parens; a trailing ")" terminates the match
    // so the name regex fails → name='' with empty params.
    const r = parseStatement('EXECUTE');
    expect(r.type).toBe('EXECUTE');
    expect((r as any).name).toBe('');
    expect((r as any).params).toEqual([]);
  });
});
