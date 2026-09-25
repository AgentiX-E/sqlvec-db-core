/**
 * PatternRewriter — PostgreSQL pattern operators → SQLite rewrite tests.
 *
 * Covers every operator (ILIKE, the tilde/like-symbol forms, SIMILAR TO,
 * and the case-insensitive regex variants), the `NOT <operator>` keyword
 * form, ESCAPE clauses, literal-aware scanning (operators inside strings or
 * comments are never matched), backslash escapes, case-insensitive regex
 * routing through `regexp_isens`, and whole-string anchoring for SIMILAR TO.
 * Execution is validated against real better-sqlite3.
 */
import { describe, it, expect } from 'vitest';
import {
  detectPGPattern,
  rewritePGPattern,
  registerRegexpFunction,
  registerRegexpFunctionDual,
  rewriteAndRegister,
} from '../query/PatternRewriter';
import Database from 'better-sqlite3';

function freshDb() {
  const db = new Database(':memory:');
  registerRegexpFunctionDual(db);
  return db;
}

describe('detectPGPattern', () => {
  it('detects ILIKE outside strings', () => {
    expect(detectPGPattern("WHERE name ILIKE '%abc%'")).toBe(true);
  });

  it('detects regex operators', () => {
    expect(detectPGPattern("WHERE name ~ '^foo'")).toBe(true);
    expect(detectPGPattern("WHERE name ~* '^foo'")).toBe(true);
    expect(detectPGPattern("WHERE name !~~ '%x%'")).toBe(true);
  });

  it('does not flag plain LIKE or non-pattern SQL', () => {
    expect(detectPGPattern("WHERE name LIKE '%abc%'")).toBe(false);
    expect(detectPGPattern('SELECT 1')).toBe(false);
    expect(detectPGPattern('')).toBe(false);
  });

  it('does not flag operators inside string literals', () => {
    expect(detectPGPattern("SELECT '~~' AS x, 'ILIKE' AS y")).toBe(false);
  });
});

describe('rewritePGPattern — LIKE family', () => {
  it('rewrites ILIKE to case-folded LIKE', () => {
    expect(rewritePGPattern("SELECT * FROM t WHERE name ILIKE '%abc%'").sql)
      .toBe("SELECT * FROM t WHERE LOWER(name) LIKE LOWER('%abc%')");
  });

  it('rewrites ~~ to LIKE', () => {
    expect(rewritePGPattern("WHERE name ~~ '%abc%'").sql).toBe("WHERE name LIKE '%abc%'");
  });

  it('rewrites ~~* to case-folded LIKE', () => {
    expect(rewritePGPattern("WHERE name ~~* '%x%'").sql).toBe("WHERE LOWER(name) LIKE LOWER('%x%')");
  });

  it('rewrites !~~ to NOT LIKE', () => {
    expect(rewritePGPattern("WHERE name !~~ '%x%'").sql).toBe("WHERE NOT (name LIKE '%x%')");
  });

  it('rewrites !~~* to NOT case-folded LIKE', () => {
    expect(rewritePGPattern("WHERE name !~~* '%x%'").sql).toBe("WHERE NOT (LOWER(name) LIKE LOWER('%x%'))");
  });

  it('returns unchanged and rewritten=false when no operator present', () => {
    const r = rewritePGPattern('SELECT * FROM t WHERE a = 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT * FROM t WHERE a = 1');
    expect(r.patterns).toEqual([]);
  });

  it('collects unique pattern tags', () => {
    const r = rewritePGPattern("WHERE a ILIKE '%x%' AND b ~ '^y' AND c ILIKE '%z%'");
    expect(r.patterns).toEqual(['ILIKE', '~']);
  });
});

describe('rewritePGPattern — regex family', () => {
  it('rewrites ~ to REGEXP (case-sensitive, substring match)', () => {
    expect(rewritePGPattern("WHERE name ~ '^foo'").sql).toContain("REGEXP '^foo'");
  });

  it('rewrites ~* via regexp_isens (case-insensitive)', () => {
    expect(rewritePGPattern("WHERE name ~* '^foo'").sql).toContain("regexp_isens('^foo', name)");
  });

  it('rewrites !~ to NOT REGEXP', () => {
    expect(rewritePGPattern("WHERE name !~ '^foo'").sql).toContain('NOT (name REGEXP');
  });

  it('rewrites !~* to NOT regexp_isens', () => {
    expect(rewritePGPattern("WHERE name !~* '^foo'").sql).toContain('NOT (regexp_isens(');
  });
});

describe('rewritePGPattern — SIMILAR TO', () => {
  it('simple pattern → LIKE', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO '%bc%'").sql).toBe("WHERE n LIKE '%bc%'");
  });

  it('complex pattern (alternation) → anchored REGEXP', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a|b'").sql).toContain("REGEXP '^(a|b)$'");
  });

  it('anchors the whole string (no substring false positives)', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('aa'),('a'),('ab'),('abc')");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n SIMILAR TO 'a+'");
    const rows = db.prepare(sql).all().map((r: any) => r.n);
    expect(rows).toEqual(['aa', 'a']);
  });
});

describe('rewritePGPattern — NOT <operator> keyword form', () => {
  it('rewrites NOT ILIKE', () => {
    expect(rewritePGPattern("WHERE name NOT ILIKE '%a%'").sql).toBe("WHERE NOT (LOWER(name) LIKE LOWER('%a%'))");
  });

  it('rewrites NOT SIMILAR TO', () => {
    expect(rewritePGPattern("WHERE n NOT SIMILAR TO '%a%'").sql).toBe("WHERE NOT (n LIKE '%a%')");
  });

  it('rewrites NOT ~~', () => {
    expect(rewritePGPattern("WHERE n NOT ~~ '%a%'").sql).toBe("WHERE NOT (n LIKE '%a%')");
  });

  it('executes NOT ILIKE correctly', () => {
    const db = freshDb();
    db.exec("CREATE TABLE t(name TEXT); INSERT INTO t VALUES ('APPLE'),('banana')");
    const { sql } = rewritePGPattern("SELECT * FROM t WHERE name NOT ILIKE '%apple%'");
    expect(db.prepare(sql).all().map((r: any) => r.name)).toEqual(['banana']);
  });
});

describe('literal-aware scanning (no false matches)', () => {
  it('ignores operators inside string literals', () => {
    expect(rewritePGPattern("SELECT '~~' AS x").patterns).toEqual([]);
    expect(rewritePGPattern("SELECT 'ILIKE' AS x").patterns).toEqual([]);
  });

  it('handles backslash-escaped quote inside RHS', () => {
    expect(rewritePGPattern("SELECT * FROM t WHERE name ~ 'it\\'s'").sql)
      .toContain("REGEXP 'it\\'s'");
  });

  it('handles doubled-quote inside RHS', () => {
    expect(rewritePGPattern("SELECT * FROM t WHERE n ~ 'it''s'").sql).toContain("'it''s'");
  });

  it('does not match a bare ~ in an identifier context', () => {
    expect(rewritePGPattern('SELECT a~b FROM t').rewritten).toBe(false);
  });

  it('does not match ~ when RHS is not a string literal', () => {
    expect(rewritePGPattern('SELECT * FROM t WHERE name ILIKE other_col').rewritten).toBe(false);
  });
});

describe('ESCAPE clause', () => {
  it('preserves ESCAPE clause for ILIKE', () => {
    expect(rewritePGPattern("WHERE name ILIKE '%a!_%' ESCAPE '!'").sql)
      .toBe("WHERE LOWER(name) LIKE LOWER('%a!_%') ESCAPE '!'");
  });

  it('preserves ESCAPE clause for SIMILAR TO simple', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO '%a!_%' ESCAPE '!'").sql)
      .toBe("WHERE n LIKE '%a!_%' ESCAPE '!'");
  });
});

describe('regexp registration', () => {
  it('registers regexp function and executes ~', () => {
    const db = new Database(':memory:');
    registerRegexpFunction(db);
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('foo2'),('bar')");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n ~ '^foo'");
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['foo2']);
  });

  it('registers regexp_isens and executes ~* case-insensitively', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('FOO'),('bar')");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n ~* '^foo'");
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['FOO']);
  });

  it('returns null-safe when no .function method', () => {
    expect(() => registerRegexpFunction(null as any)).not.toThrow();
    expect(() => registerRegexpFunctionDual(null as any)).not.toThrow();
    expect(() => registerRegexpFunction({} as any)).not.toThrow();
    expect(() => registerRegexpFunctionDual(undefined as any)).not.toThrow();
  });

  it('handles NULL values in regexp (returns 0)', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('a'),(NULL)");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n ~ 'a'");
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['a']);
  });

  it('handles NULL values in case-insensitive regexp_isens', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('a'),(NULL)");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n ~* 'a'");
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['a']);
  });
});

describe('rewriteAndRegister', () => {
  it('registers regexp for ~ and returns rewrite', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('foo'),('bar')");
    const { sql } = rewriteAndRegister("SELECT n FROM x WHERE n ~ '^foo'", db);
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['foo']);
  });

  it('registers dual functions for ~*', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('FOO')");
    const { sql } = rewriteAndRegister("SELECT n FROM x WHERE n ~* '^foo'", db);
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['FOO']);
  });
});

describe('complex LHS extraction', () => {
  it('wraps function-call LHS', () => {
    expect(rewritePGPattern("WHERE lower(name) ILIKE '%x%'").sql)
      .toBe("WHERE LOWER(lower(name)) LIKE LOWER('%x%')");
  });

  it('handles parenthesized LHS', () => {
    expect(rewritePGPattern("WHERE (a || b) ~~ '%x%'").sql).toBe("WHERE (a || b) LIKE '%x%'");
  });

  it('handles subquery LHS', () => {
    expect(rewritePGPattern("WHERE (SELECT max(x) FROM y) ~~ '%a%'").sql)
      .toBe("WHERE (SELECT max(x) FROM y) LIKE '%a%'");
  });

  it('handles multiple operators in one statement', () => {
    const { sql, patterns } = rewritePGPattern("WHERE a ~~ 'x' OR b ~ 'y' OR c !~~* 'z'");
    expect(patterns).toEqual(['~~', '~', '!~~*']);
    expect(sql).toContain("a LIKE 'x'");
    expect(sql).toContain("b REGEXP 'y'");
    expect(sql).toContain("NOT (LOWER(c) LIKE LOWER('z'))");
  });

  it('handles an operator at the very start of input (boundary pos 0)', () => {
    const { sql } = rewritePGPattern("name ILIKE '%x%'");
    expect(sql).toBe("LOWER(name) LIKE LOWER('%x%')");
  });

  it('handles a symbol operator at position 0 (isAtBoundary true)', () => {
    // `~~` is the first token; isAtBoundary returns true at pos 0 (empty LHS
    // yields a leading space, which is harmless for an already-invalid input).
    const { sql } = rewritePGPattern("~~ '%x%'");
    expect(sql).toContain("LIKE '%x%'");
  });

  it('skips a string literal inside the LHS when walking backwards', () => {
    const { sql } = rewritePGPattern("WHERE concat('a', col) ILIKE '%x%'");
    expect(sql).toBe("WHERE LOWER(concat('a', col)) LIKE LOWER('%x%')");
  });

  it('handles a parenthesized whole-expression LHS (depth 0 open paren)', () => {
    const { sql } = rewritePGPattern("WHERE (name) ~~ '%x%'");
    expect(sql).toContain("(name) LIKE '%x%'");
  });

  it('skips an operator with non-string RHS (extractRangeAround null)', () => {
    expect(rewritePGPattern("WHERE a ILIKE b").rewritten).toBe(false);
    expect(rewritePGPattern("WHERE a SIMILAR TO b").rewritten).toBe(false);
  });

  it('skips an operator at end-of-input with no RHS', () => {
    expect(rewritePGPattern("SELECT * FROM t WHERE a ~").rewritten).toBe(false);
  });

  it('handles a trailing string ending with a lone backslash', () => {
    const { rewritten } = rewritePGPattern("SELECT 'a\\\\' AS x");
    expect(rewritten).toBe(false);
  });
});

describe('similarToRegex — character classes and escapes', () => {
  it('converts a character class verbatim', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO '[abc]%'").sql).toContain("REGEXP '^([abc].*)$'");
  });

  it('converts a negated character class', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO '[^xyz]%'").sql).toContain("'^([^xyz].*)$'");
  });

  it('treats an unmatched opening bracket as a literal', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a[bc'").sql).toContain("'^(a\\[bc)$'");
  });

  it('escapes an escaped wildcard (\\% and \\_ become literals)', () => {
    // A pattern of only escaped wildcards is "simple" → stays in LIKE form.
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a\\%b'").sql).toBe("WHERE n LIKE 'a\\%b'");
    // Forcing complexity with `|` routes the escaped wildcard through
    // similarToRegex, where `\%` collapses to a literal `%`.
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a\\%b|x'").sql).toContain("'^(a%b|x)$'");
  });

  it('escapes regex meta chars that are literal in SIMILAR TO', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a.b'").sql).toBe("WHERE n LIKE 'a.b'");
    // forces complexity with `|` so `.` goes through regexEscapeLiteral
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a.b|x'").sql).toContain("'^(a\\.b|x)$'");
  });

  it('handles empty-bracket character class [[]', () => {
    const { sql } = rewritePGPattern("WHERE n SIMILAR TO '[a]'");
    expect(sql).toContain("REGEXP '^([a])$'");
  });

  it('handles a leading closing-bracket empty class []', () => {
    // `[]a` has `]` as the first class member; exercises the empty-bracket
    // fast‑path (the `]` right after `[` or `[^`).
    const { sql } = rewritePGPattern("WHERE n SIMILAR TO '[]a'");
    expect(sql).toContain("REGEXP '^(");
  });

  it('escapes an underscore wildcard in a complex pattern', () => {
    // `_` → `.` inside similarToRegex (only reached when pattern is complex).
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a_b|x'").sql).toContain("'^(a.b|x)$'");
  });

  it('passes through an escaped non-wildcard character (default escape branch)', () => {
    // `\d` is not `%` or `_`, so it hits the default case of the escape switch.
    expect(rewritePGPattern("WHERE n SIMILAR TO 'a\\db|x'").sql).toContain("'^(a");
  });

  it('handles an escape char inside a character class', () => {
    expect(rewritePGPattern("WHERE n SIMILAR TO '[a\\]]'").sql).toContain("REGEXP '^(");
  });
});

describe('comment and identifier skipping', () => {
  it('ignores a line comment containing an operator', () => {
    const { patterns } = rewritePGPattern("SELECT 1 -- name ILIKE '%x%'\nFROM t");
    expect(patterns).toEqual([]);
  });

  it('ignores a block comment containing an operator', () => {
    const { patterns } = rewritePGPattern("SELECT 1 /* name ~~ '%x%' */ FROM t");
    expect(patterns).toEqual([]);
  });

  it('skips a doubled-quote escaped identifier', () => {
    const { patterns } = rewritePGPattern('SELECT "we""ird" FROM t');
    expect(patterns).toEqual([]);
  });

  it('returns null-range when an operator has no RHS', () => {
    const { rewritten } = rewritePGPattern("SELECT * FROM t WHERE name ILIKE");
    expect(rewritten).toBe(false);
  });
});

describe('regexp function error/value boundaries', () => {
  it('returns 0 for an invalid regex pattern instead of throwing', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('a')");
    // `[` is an invalid JS regex
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n ~ '['");
    expect(db.prepare(sql).all()).toEqual([]);
  });

  it('handles a non-null value with case-insensitive dual registration', () => {
    const db = freshDb();
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('Hello')");
    const { sql } = rewritePGPattern("SELECT n FROM x WHERE n !~* '^world'");
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['Hello']);
  });
});

describe('rewriteAndRegister branching', () => {
  it('no-op registration for non-regex patterns', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('abc')");
    const { sql } = rewriteAndRegister("SELECT n FROM x WHERE n ILIKE '%b%'", db);
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['abc']);
  });

  it('uses dual registration only when case-insensitive regex present', () => {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE x(n TEXT); INSERT INTO x VALUES ('FOO')");
    const { sql } = rewriteAndRegister("SELECT n FROM x WHERE n !~* '^x'", db);
    expect(db.prepare(sql).all().map((r: any) => r.n)).toEqual(['FOO']);
  });
});
