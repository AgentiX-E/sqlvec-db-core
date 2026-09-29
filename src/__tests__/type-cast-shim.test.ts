import { describe, it, expect } from 'vitest';
import {
  detectTypeCast,
  detectCastOperator,
  detectCastFunction,
  detectLiteralPrefix,
  rewriteTypeCast,
} from '../query/TypeCastShim';

describe('detectTypeCast', () => {
  it('returns false for empty / non-string / blank', () => {
    expect(detectTypeCast('')).toBe(false);
    expect(detectTypeCast('   ')).toBe(false);
    expect(detectTypeCast(null as unknown as string)).toBe(false);
    expect(detectTypeCast(undefined as unknown as string)).toBe(false);
  });

  it('detects :: operator', () => {
    expect(detectTypeCast('SELECT x::int FROM t')).toBe(true);
  });

  it('detects CAST() function', () => {
    expect(detectTypeCast('SELECT CAST(x AS int) FROM t')).toBe(true);
  });

  it('detects literal prefix', () => {
    expect(detectTypeCast("SELECT DATE '2024-01-01'")).toBe(true);
  });

  it('does not detect inside a string literal', () => {
    expect(detectTypeCast("SELECT 'x::int' FROM t")).toBe(false);
  });

  it('does not detect inside a comment', () => {
    expect(detectTypeCast('-- x::int\nSELECT 1')).toBe(false);
  });

  it('does not detect a longer identifier sharing the CAST prefix', () => {
    expect(detectTypeCast('SELECT casted FROM t')).toBe(false);
  });
});

describe('detectCastOperator', () => {
  it('detects only the :: syntax', () => {
    expect(detectCastOperator('SELECT x::int FROM t')).toBe(true);
    expect(detectCastOperator('SELECT CAST(x AS int) FROM t')).toBe(false);
    expect(detectCastOperator("SELECT DATE '2024'")).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(detectCastOperator('')).toBe(false);
    expect(detectCastOperator(null as unknown as string)).toBe(false);
  });
});

describe('detectCastFunction', () => {
  it('detects only the CAST() syntax', () => {
    expect(detectCastFunction('SELECT CAST(x AS int) FROM t')).toBe(true);
    expect(detectCastFunction('SELECT x::int FROM t')).toBe(false);
    expect(detectCastFunction("SELECT DATE '2024'")).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(detectCastFunction('')).toBe(false);
    expect(detectCastFunction(null as unknown as string)).toBe(false);
  });
});

describe('detectLiteralPrefix', () => {
  it('detects only the literal prefix syntax', () => {
    expect(detectLiteralPrefix("SELECT DATE '2024-01-01'")).toBe(true);
    expect(detectLiteralPrefix('SELECT x::int FROM t')).toBe(false);
    expect(detectLiteralPrefix('SELECT CAST(x AS int) FROM t')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(detectLiteralPrefix('')).toBe(false);
    expect(detectLiteralPrefix(null as unknown as string)).toBe(false);
  });
});

describe('rewriteTypeCast', () => {
  it('returns unchanged for empty / non-string / blank', () => {
    expect(rewriteTypeCast('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteTypeCast(null as unknown as string)).toEqual({ sql: null, rewritten: false });
    expect(rewriteTypeCast('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites :: integer', () => {
    expect(rewriteTypeCast('SELECT x::int FROM t').sql).toBe('SELECT CAST(x AS INTEGER) FROM t');
  });

  it('rewrites :: text', () => {
    expect(rewriteTypeCast('SELECT x::text FROM t').sql).toBe('SELECT CAST(x AS TEXT) FROM t');
  });

  it('rewrites :: boolean to CASE', () => {
    expect(rewriteTypeCast('SELECT x::boolean FROM t').sql).toBe('SELECT CASE WHEN x THEN 1 ELSE 0 END FROM t');
  });

  it('rewrites CAST(x AS integer)', () => {
    expect(rewriteTypeCast('SELECT CAST(x AS integer) FROM t').sql).toBe('SELECT CAST(x AS INTEGER) FROM t');
  });

  it('rewrites literal prefix DATE', () => {
    expect(rewriteTypeCast("SELECT DATE '2024-01-01'").sql).toBe("SELECT DATE('2024-01-01')");
  });

  it('rewrites literal prefix TIMESTAMP', () => {
    expect(rewriteTypeCast("SELECT TIMESTAMP '2024-01-01 12:00:00'").sql).toBe(
      "SELECT DATETIME('2024-01-01 12:00:00')",
    );
  });

  it('rewrites literal prefix BOOLEAN true/false', () => {
    expect(rewriteTypeCast("SELECT BOOLEAN 'true'").sql).toBe('SELECT 1');
    expect(rewriteTypeCast("SELECT BOOLEAN 'false'").sql).toBe('SELECT 0');
    expect(rewriteTypeCast("SELECT BOOLEAN 't'").sql).toBe('SELECT 1');
    expect(rewriteTypeCast("SELECT BOOLEAN 'F'").sql).toBe('SELECT 0');
  });

  it('rewrites literal prefix INTEGER / REAL / TEXT / INTERVAL', () => {
    expect(rewriteTypeCast("SELECT INTEGER '42'").sql).toBe("SELECT CAST('42' AS INTEGER)");
    expect(rewriteTypeCast("SELECT REAL '3.14'").sql).toBe("SELECT CAST('3.14' AS REAL)");
    expect(rewriteTypeCast("SELECT TEXT 'hi'").sql).toBe("SELECT 'hi'");
    expect(rewriteTypeCast("SELECT INTERVAL '1 day'").sql).toBe("SELECT '1 day'");
  });

  it('handles double precision type in :: syntax', () => {
    expect(rewriteTypeCast('SELECT x::double precision FROM t').sql).toBe('SELECT CAST(x AS REAL) FROM t');
  });

  it('handles nested parentheses in the left operand', () => {
    expect(rewriteTypeCast('SELECT (a+b)::numeric(10,2) FROM t').sql).toBe('SELECT CAST((a+b) AS REAL) FROM t');
    expect(rewriteTypeCast('SELECT f(a, (b+c))::int FROM t').sql).toBe('SELECT CAST(f(a, (b+c)) AS INTEGER) FROM t');
  });

  it('handles a function-call left operand', () => {
    expect(rewriteTypeCast('SELECT COUNT(*)::bigint FROM t').sql).toBe('SELECT CAST(COUNT(*) AS INTEGER) FROM t');
    expect(rewriteTypeCast('SELECT coalesce(a, b)::text FROM t').sql).toBe('SELECT CAST(coalesce(a, b) AS TEXT) FROM t');
  });

  it('handles a qualified column left operand', () => {
    expect(rewriteTypeCast('SELECT t.col::text FROM t').sql).toBe('SELECT CAST(t.col AS TEXT) FROM t');
  });

  it('does not detach the SELECT keyword from a grouped operand', () => {
    // Regression #347: backscanning must not swallow the SELECT keyword.
    expect(rewriteTypeCast('SELECT (a+b)::int FROM t').sql).toBe('SELECT CAST((a+b) AS INTEGER) FROM t');
  });

  it('does not touch a string literal containing cast syntax', () => {
    expect(rewriteTypeCast("SELECT 'x::int' FROM t")).toEqual({ sql: "SELECT 'x::int' FROM t", rewritten: false });
    expect(rewriteTypeCast("SELECT 'CAST(a AS int)' AS s FROM t").rewritten).toBe(false);
  });

  it('does not touch a comment containing cast syntax', () => {
    expect(rewriteTypeCast('-- x::text\nSELECT 1')).toEqual({ sql: '-- x::text\nSELECT 1', rewritten: false });
    expect(rewriteTypeCast("-- DATE '2024'\nSELECT 1").rewritten).toBe(false);
  });

  it('handles escaped single quotes in a literal prefix', () => {
    expect(rewriteTypeCast("SELECT DATE 'it''s'").sql).toBe("SELECT DATE('it''s')");
    expect(rewriteTypeCast("SELECT DATE 'a''b''c'").sql).toBe("SELECT DATE('a''b''c')");
  });

  it('does not rewrite a longer identifier sharing the CAST prefix', () => {
    expect(rewriteTypeCast('SELECT casted FROM t')).toEqual({ sql: 'SELECT casted FROM t', rewritten: false });
  });

  it('handles unknown types by casting to TEXT', () => {
    expect(rewriteTypeCast('SELECT x::someunknown FROM t').sql).toBe('SELECT CAST(x AS TEXT) FROM t');
  });

  it('rewrites literal prefix TIME', () => {
    expect(rewriteTypeCast("SELECT TIME '12:00:00'").sql).toBe("SELECT TIME('12:00:00')");
  });

  it('rewrites literal prefix FLOAT / REAL / VARCHAR', () => {
    expect(rewriteTypeCast("SELECT REAL '3.14'").sql).toBe("SELECT CAST('3.14' AS REAL)");
    expect(rewriteTypeCast("SELECT FLOAT '1.5'").sql).toBe("SELECT CAST('1.5' AS REAL)");
    expect(rewriteTypeCast("SELECT VARCHAR 'abc'").sql).toBe("SELECT 'abc'");
  });

  it('rewrites literal prefix INTEGER / INT / BIGINT / SMALLINT', () => {
    expect(rewriteTypeCast("SELECT INTEGER '42'").sql).toBe("SELECT CAST('42' AS INTEGER)");
    expect(rewriteTypeCast("SELECT INT '7'").sql).toBe("SELECT CAST('7' AS INTEGER)");
    expect(rewriteTypeCast("SELECT BIGINT '9'").sql).toBe("SELECT CAST('9' AS INTEGER)");
    expect(rewriteTypeCast("SELECT SMALLINT '3'").sql).toBe("SELECT CAST('3' AS INTEGER)");
  });

  it('rewrites literal prefix DOUBLE PRECISION', () => {
    expect(rewriteTypeCast("SELECT DOUBLE PRECISION '1.5'").sql).toBe("SELECT CAST('1.5' AS REAL)");
  });

  it('handles a string-literal left operand for ::', () => {
    expect(rewriteTypeCast("SELECT 'abc'::text FROM t").sql).toBe("SELECT CAST('abc' AS TEXT) FROM t");
  });

  it('handles a varchar type with length parameter', () => {
    expect(rewriteTypeCast('SELECT x::varchar(255) FROM t').sql).toBe('SELECT CAST(x AS TEXT) FROM t');
  });

  it('handles multiple rewrites in one query', () => {
    const r = rewriteTypeCast('SELECT a::int, b::text FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('CAST(a AS INTEGER)');
    expect(r.sql).toContain('CAST(b AS TEXT)');
  });

  it('leaves malformed casts untouched (no crash, no rewrite)', () => {
    // No left operand.
    expect(rewriteTypeCast("SELECT ::int").rewritten).toBe(false);
    // No type name after ::.
    expect(rewriteTypeCast('SELECT x::').rewritten).toBe(false);
    // CAST without parentheses.
    expect(rewriteTypeCast('SELECT CAST x AS int').rewritten).toBe(false);
    // CAST without AS keyword.
    expect(rewriteTypeCast('SELECT CAST(x int)').rewritten).toBe(false);
    // CAST with empty expression.
    expect(rewriteTypeCast('SELECT CAST( AS int)').rewritten).toBe(false);
    // Literal prefix that is actually a longer identifier.
    expect(rewriteTypeCast("SELECT DATE_foo 'x'").rewritten).toBe(false);
  });

  it('does not treat a non-identifier type as a cast', () => {
    // `x::123` has no valid type name; left untouched.
    expect(rewriteTypeCast('SELECT x::123 FROM t').rewritten).toBe(false);
  });

  // ── scanner-robustness edge cases (no crash, correct skip) ──

  it('handles an unbalanced CAST (missing closing paren)', () => {
    expect(rewriteTypeCast('SELECT CAST(x AS int').rewritten).toBe(false);
  });

  it('handles an unterminated literal prefix', () => {
    expect(rewriteTypeCast("SELECT DATE 'unterminated").rewritten).toBe(false);
  });

  it('handles a stray :: with no valid left operand', () => {
    expect(rewriteTypeCast('SELECT +::int FROM t').rewritten).toBe(false);
  });

  it('handles a string literal containing an escaped quote as a :: left operand', () => {
    expect(rewriteTypeCast("SELECT 'it''s'::text FROM t").sql).toBe("SELECT CAST('it''s' AS TEXT) FROM t");
  });

  it('handles a type with a length parameter list', () => {
    expect(rewriteTypeCast('SELECT x::numeric(10,2) FROM t').sql).toBe('SELECT CAST(x AS REAL) FROM t');
  });

  it('handles CAST with a literal and comma inside the expression', () => {
    expect(rewriteTypeCast("SELECT CAST('a,b' AS text) FROM t").sql).toBe("SELECT CAST('a,b' AS TEXT) FROM t");
  });

  it('handles CAST with nested function calls in the expression', () => {
    expect(rewriteTypeCast('SELECT CAST(coalesce(a, b) AS text) FROM t').sql).toBe(
      'SELECT CAST(coalesce(a, b) AS TEXT) FROM t',
    );
  });

  it('handles a type with an unbalanced length parameter', () => {
    // `varchar(10` — the parameter list is never closed, so the construct is
    // malformed and must be left untouched (no leaked `(10` in the output).
    expect(rewriteTypeCast('SELECT x::varchar(10 FROM t').rewritten).toBe(false);
  });
});
