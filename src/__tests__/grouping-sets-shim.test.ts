/**
 * GroupingSetsShim — PostgreSQL GROUPING SETS / CUBE / ROLLUP rewrite tests.
 *
 * Covers detection (including literal-aware guards that ignore operator
 * keywords inside string literals) and rewriting (UNION ALL expansion,
 * GROUPING() → CASE WHEN, plain-GROUP-BY stripping), plus the exported
 * `_`-prefixed helpers for parenthesis matching, comma splitting, and
 * CUBE/ROLLUP set expansion. Rename/rewrite results are validated against
 * real better-sqlite3 where set-expansion semantics can be observed.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  detectGroupingSets,
  rewriteGroupingSets,
  _skipSqlLiteral,
  _isInsideLiteral,
  _testOutsideLiterals,
  _findKeywordIndexOutsideLiterals,
  _findKeywordIndex,
  _findCharIndex,
  _findMatchingCloseParen,
  _findPlainGroupByBefore,
  _parseGroupingSetsContent,
  _expandRollup,
  _expandCube,
  _parseSelectColumns,
  _transformGroupingFunc,
} from '../query/GroupingSetsShim';

describe('detectGroupingSets', () => {
  it('detects GROUPING SETS', () => {
    expect(detectGroupingSets('SELECT a,b FROM t GROUP BY GROUPING SETS ((a),(b))')).toBe(true);
  });

  it('detects CUBE and ROLLUP', () => {
    expect(detectGroupingSets('SELECT a,b FROM t GROUP BY CUBE (a,b)')).toBe(true);
    expect(detectGroupingSets('SELECT a,b FROM t GROUP BY ROLLUP (a,b)')).toBe(true);
  });

  it('detects the standalone GROUPING() function', () => {
    expect(detectGroupingSets('SELECT a, GROUPING(a) FROM t GROUP BY a')).toBe(true);
  });

  it('detects GROUPING SETS with an intermediate GROUP BY expression', () => {
    expect(detectGroupingSets('SELECT a FROM t GROUP BY a, b GROUPING SETS ((a))')).toBe(true);
  });

  it('detects a dollar-quoted string with GROUPING inside it normally', () => {
    expect(detectGroupingSets('SELECT $tag$GROUPING(a)$tag$ AS g')).toBe(false);
  });

  it('returns false for plain GROUP BY', () => {
    expect(detectGroupingSets('SELECT a FROM t GROUP BY a')).toBe(false);
  });

  it('returns false for empty or non-string input', () => {
    expect(detectGroupingSets('')).toBe(false);
    expect(detectGroupingSets('   ')).toBe(false);
    expect(detectGroupingSets(null as any)).toBe(false);
    expect(detectGroupingSets(undefined as any)).toBe(false);
  });

  it('ignores operator keywords inside string literals', () => {
    expect(detectGroupingSets("SELECT 'GROUP BY CUBE (a,b)' AS x")).toBe(false);
    expect(detectGroupingSets("SELECT 'GROUP BY GROUPING SETS ((a))' AS x")).toBe(false);
    expect(detectGroupingSets("SELECT 'GROUPING(a)' AS x")).toBe(false);
  });

  it('ignores operator keywords inside line/block comments', () => {
    expect(detectGroupingSets('SELECT 1 -- GROUP BY CUBE (a)\nFROM t')).toBe(false);
    expect(detectGroupingSets('SELECT 1 /* GROUP BY ROLLUP (a) */ FROM t')).toBe(false);
  });

  it('still detects a real operator alongside a string-literal mention', () => {
    expect(detectGroupingSets("SELECT 'CUBE' AS kind, a FROM t GROUP BY CUBE (a)")).toBe(true);
  });
});

describe('rewriteGroupingSets — standalone GROUPING SETS expansion', () => {
  it('expands GROUPING SETS into UNION ALL with NULL padding', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a, b, SUM(c) FROM t GROUP BY GROUPING SETS ((a,b), (a), ())',
    );
    expect(rewritten).toBe(true);
    expect(sql).toContain('GROUP BY a, b');
    expect(sql).toContain('NULL AS b');
    expect(sql).toContain('GROUP BY a');
    expect(sql).toContain('NULL AS a, NULL AS b');
    expect(sql).toContain('UNION ALL');
  });

  it('passes through when no GROUP BY extension present', () => {
    const { sql, rewritten } = rewriteGroupingSets('SELECT a FROM t GROUP BY a');
    expect(rewritten).toBe(false);
    expect(sql).toBe('SELECT a FROM t GROUP BY a');
  });

  it('returns unchanged for empty/non-string input', () => {
    expect(rewriteGroupingSets('').rewritten).toBe(false);
    expect(rewriteGroupingSets('   ').rewritten).toBe(false);
    expect(rewriteGroupingSets(null as any).rewritten).toBe(false);
  });
});

describe('rewriteGroupingSets — GROUPING() only transformation', () => {
  it('transforms GROUPING(col) to CASE WHEN', () => {
    const { sql, rewritten } = rewriteGroupingSets('SELECT a, GROUPING(a) FROM t GROUP BY a');
    expect(rewritten).toBe(true);
    expect(sql).toBe('SELECT a, CASE WHEN (a IS NULL) THEN 1 ELSE 0 END FROM t GROUP BY a');
  });
});

describe('rewriteGroupingSets — CUBE / ROLLUP expansion', () => {
  it('expands CUBE to all subsets', () => {
    const { sql, rewritten } = rewriteGroupingSets('SELECT a, b FROM t GROUP BY CUBE (a, b)');
    expect(rewritten).toBe(true);
    expect(sql).toContain('GROUP BY a, b');
    expect(sql).toContain('UNION ALL');
    expect(sql).toContain('NULL AS a, NULL AS b');
  });

  it('expands ROLLUP to prefix sets', () => {
    const { sql, rewritten } = rewriteGroupingSets('SELECT a, b FROM t GROUP BY ROLLUP (a, b)');
    expect(rewritten).toBe(true);
    expect(sql).toContain('GROUP BY a, b');
    expect(sql).toContain('GROUP BY a');
    expect(sql).toContain('UNION ALL');
  });

  it('passes through CUBE when expansion fails (no FROM)', () => {
    const { sql, rewritten } = rewriteGroupingSets('SELECT GROUP BY CUBE (a)');
    expect(rewritten).toBe(false);
  });
});

describe('rewriteGroupingSets — plain GROUP BY before GROUPING SETS', () => {
  it('strips GROUPING SETS and keeps the plain GROUP BY', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a,b FROM t GROUP BY (a,b) GROUPING SETS ((a,b))',
    );
    expect(rewritten).toBe(true);
    expect(sql).toBe('SELECT a,b FROM t GROUP BY (a,b)');
  });

  it('transforms GROUPING() while stripping the GROUPING SETS clause', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a, GROUPING(a) FROM t GROUP BY (a) GROUPING SETS ((a))',
    );
    expect(rewritten).toBe(true);
    expect(sql).toContain('CASE WHEN (a IS NULL) THEN 1 ELSE 0 END');
  });
});

describe('rewriteGroupingSets — HAVING / ORDER BY handling', () => {
  it('keeps HAVING in each sub-query and ORDER BY at the outer level', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a, SUM(c) AS s FROM t GROUP BY GROUPING SETS ((a), ()) HAVING SUM(c) > 10 ORDER BY s LIMIT 5',
    );
    expect(rewritten).toBe(true);
    expect(sql).toContain('HAVING SUM(c) > 10');
    expect(sql).toContain('ORDER BY s');
    expect(sql).toContain('LIMIT 5');
  });

  it('keeps a plain HAVING with no ORDER BY / LIMIT suffix', () => {
    const { sql } = rewriteGroupingSets(
      'SELECT a, SUM(c) AS s FROM t GROUP BY GROUPING SETS ((a)) HAVING SUM(c) > 0',
    );
    expect(sql).toContain('HAVING SUM(c) > 0');
  });

  it('keeps ORDER BY when no HAVING is present', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a FROM t GROUP BY GROUPING SETS ((a), ()) ORDER BY a',
    );
    expect(rewritten).toBe(true);
    expect(sql).toContain('ORDER BY a');
  });
});

describe('rewriteGroupingSets — grouping-set columns not in SELECT', () => {
  it('NULL-pads a grouping-set column absent from the SELECT list', () => {
    const { sql } = rewriteGroupingSets(
      'SELECT SUM(c) FROM t GROUP BY GROUPING SETS ((a,b), ())',
    );
    expect(sql).toContain('NULL AS a');
    expect(sql).toContain('NULL AS b');
  });
});

describe('rewriteGroupingSets — fallback and error paths', () => {
  it('returns unchanged when GROUPING SETS has unbalanced parentheses', () => {
    // Unbalanced parens → can't locate the matching close → unchanged.
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a FROM t GROUP BY GROUPING SETS ((a)',
    );
    expect(rewritten).toBe(false);
    expect(sql).toContain('GROUPING SETS');
  });

  it('returns unchanged when GROUPING SETS keyword has no parenthesis', () => {
    const { rewritten } = rewriteGroupingSets(
      'SELECT a FROM t GROUP BY GROUPING SETS',
    );
    expect(rewritten).toBe(false);
  });

  it('falls back to stripping GROUP BY when no FROM clause exists', () => {
    // GROUP BY immediately followed by GROUPING SETS (no intermediate column)
    // keeps plainGroupByMatch null and, with no FROM, expansion is impossible,
    // so the whole GROUP BY GROUPING SETS clause is stripped.
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a GROUP BY GROUPING SETS ((a))',
    );
    expect(rewritten).toBe(true);
    expect(sql).toBe('SELECT a');
  });

  it('passes through ROLLUP when expansion fails (empty columns)', () => {
    const { rewritten } = rewriteGroupingSets('SELECT a FROM t GROUP BY ROLLUP ()');
    expect(rewritten).toBe(false);
  });

  it('passes through CUBE with an unclosed parenthesis', () => {
    const { rewritten } = rewriteGroupingSets('SELECT a FROM t GROUP BY CUBE (a');
    expect(rewritten).toBe(false);
  });

  it('falls back to stripping when GROUPING SETS content is empty', () => {
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a FROM t GROUP BY GROUPING SETS ()',
    );
    expect(rewritten).toBe(true);
    expect(sql).not.toContain('GROUPING SETS');
  });

  it('leaves a GROUPING SETS without a preceding GROUP BY unchanged', () => {
    // GROUPING SETS is detected, but expandGroupingSets requires `GROUP BY
    // GROUPING SETS`; without GROUP BY the inner keyword search misses, so the
    // statement is left unchanged rather than mis-expanded.
    const { sql, rewritten } = rewriteGroupingSets(
      'SELECT a FROM t GROUPING SETS ((a))',
    );
    expect(rewritten).toBe(false);
    expect(sql).toBe('SELECT a FROM t GROUPING SETS ((a))');
  });
});

describe('_findMatchingCloseParen — literal skip integration', () => {
  it('returns -1 for a non-literal bare character at openIdx+1', () => {
    // openIdx points at '('; next char is a normal char (skip returns -1)
    expect(_findMatchingCloseParen('(abc', 0)).toBe(-1);
  });
});

describe('_parseGroupingSetsContent — non-paren token skip', () => {
  it('skips leading non-paren tokens', () => {
    // content starts with `x` (not '(') → skipped
    expect(_parseGroupingSetsContent('x (a)')).toEqual([['a']]);
  });

  it('skips an unbalanced opening paren defensively', () => {
    expect(_parseGroupingSetsContent('(a')).toEqual([]);
  });
});

describe('_skipSqlLiteral', () => {
  it('skips single-quoted strings (incl. escaped and doubled quotes)', () => {
    expect(_skipSqlLiteral("'abc'", 0)).toBe(5);
    expect(_skipSqlLiteral("'it\\'s'", 0)).toBe(7);
    expect(_skipSqlLiteral("'a''b'", 0)).toBe(6);
  });

  it('skips double-quoted identifiers', () => {
    expect(_skipSqlLiteral('"col"', 0)).toBe(5);
    expect(_skipSqlLiteral('"a""b"', 0)).toBe(6);
  });

  it('skips line and block comments', () => {
    expect(_skipSqlLiteral('-- hello\n', 0)).toBe(8);
    expect(_skipSqlLiteral('/* hi */', 0)).toBe(8);
    expect(_skipSqlLiteral('/* unterminated', 0)).toBe(15);
  });

  it('skips dollar-quoted strings', () => {
    expect(_skipSqlLiteral('$$abc$$', 0)).toBe(7);
    expect(_skipSqlLiteral('$tag$abc$tag$', 0)).toBe(13);
  });

  it('returns len for an unterminated string or dollar-quote', () => {
    expect(_skipSqlLiteral("'abc", 0)).toBe(4);
    expect(_skipSqlLiteral('$$abc', 0)).toBe(5);
  });

  it('returns -1 for a bare character', () => {
    expect(_skipSqlLiteral('abc', 0)).toBe(-1);
    expect(_skipSqlLiteral('$1', 0)).toBe(-1);
  });
});

describe('_isInsideLiteral', () => {
  it('detects a position inside a string literal', () => {
    expect(_isInsideLiteral("SELECT 'GROUP BY X' FROM t", 11)).toBe(true);
    expect(_isInsideLiteral("SELECT 'GROUP BY X' FROM t", 5)).toBe(false);
  });

  it('returns false for a position before any literal', () => {
    expect(_isInsideLiteral('SELECT a', 3)).toBe(false);
  });

  it('handles a position past a completed literal', () => {
    expect(_isInsideLiteral("'abc' tail", 8)).toBe(false);
  });
});

describe('_testOutsideLiterals', () => {
  it('returns false for empty input', () => {
    expect(_testOutsideLiterals('', /\bGROUP\s+BY\b/i)).toBe(false);
  });

  it('finds a keyword outside literals', () => {
    expect(_testOutsideLiterals('SELECT a FROM t GROUP BY a', /\bGROUP\s+BY\b/i)).toBe(true);
  });

  it('ignores a keyword inside a string literal', () => {
    expect(_testOutsideLiterals("SELECT 'GROUP BY a' FROM t", /\bGROUP\s+BY\b/i)).toBe(false);
  });

  it('reuses a pre-global-flagged regex safely', () => {
    expect(_testOutsideLiterals('SELECT a GROUP BY a', /\bGROUP\s+BY\b/g)).toBe(true);
  });

  it('guards against a zero-width match (avoid infinite loop)', () => {
    expect(_testOutsideLiterals('abc', /\b/)).toBe(true);
  });
});

describe('_findKeywordIndexOutsideLiterals', () => {
  it('returns -1 for empty input', () => {
    expect(_findKeywordIndexOutsideLiterals('', /\bGROUP\s+BY\b/i)).toBe(-1);
  });

  it('returns the index of a keyword outside literals', () => {
    expect(_findKeywordIndexOutsideLiterals('SELECT a GROUP BY a', /\bGROUP\s+BY\b/i)).toBe(9);
  });

  it('skips a keyword inside a string literal and finds the real one', () => {
    const idx = _findKeywordIndexOutsideLiterals(
      "SELECT 'GROUP BY x' FROM t GROUP BY a",
      /\bGROUP\s+BY\b/i,
    );
    expect(idx).toBeGreaterThan(20);
  });

  it('returns -1 when the keyword only appears inside a literal', () => {
    expect(_findKeywordIndexOutsideLiterals("SELECT 'GROUP BY x'", /\bGROUP\s+BY\b/i)).toBe(-1);
  });

  it('reuses a pre-global-flagged regex safely', () => {
    expect(_findKeywordIndexOutsideLiterals('SELECT a GROUP BY a', /\bGROUP\s+BY\b/g)).toBe(9);
  });

  it('guards against a zero-width match (avoid infinite loop)', () => {
    expect(_findKeywordIndexOutsideLiterals('abc', /\b/)).toBe(0);
  });
});

describe('_findKeywordIndex / _findCharIndex', () => {
  it('returns match index or -1', () => {
    expect(_findKeywordIndex('abc GROUP BY x', /\bGROUP\s+BY\b/i)).toBe(4);
    expect(_findKeywordIndex('abc', /\bGROUP\s+BY\b/i)).toBe(-1);
  });

  it('finds a character at/after an index', () => {
    expect(_findCharIndex('abc(def)', '(', 0)).toBe(3);
    expect(_findCharIndex('abc(def)', '(', 4)).toBe(-1);
  });
});

describe('_findMatchingCloseParen', () => {
  it('matches nested parentheses', () => {
    expect(_findMatchingCloseParen('((a), (b))', 0)).toBe(9);
  });

  it('ignores parentheses inside string literals', () => {
    const idx = _findMatchingCloseParen("((a, 'x)'), (b))", 0);
    expect(idx).toBe(15);
  });

  it('returns -1 for unbalanced input', () => {
    expect(_findMatchingCloseParen('((a)', 0)).toBe(-1);
  });
});

describe('_findPlainGroupByBefore', () => {
  it('finds a plain GROUP BY before an index', () => {
    const r = _findPlainGroupByBefore('SELECT a FROM t GROUP BY (a,b) GROUPING SETS x', 30);
    expect(r).not.toBeNull();
    expect(r!.startIndex).toBeGreaterThan(0);
  });

  it('returns a result even when the GROUP BY starts at index 0', () => {
    const r = _findPlainGroupByBefore('GROUP BY (a,b) GROUPING SETS ((a,b))', 20);
    expect(r).not.toBeNull();
    expect(r!.startIndex).toBe(0);
    expect(r!.endIndex).toBe(20);
  });

  it('returns null when no plain GROUP BY precedes', () => {
    expect(_findPlainGroupByBefore('SELECT a FROM t', 15)).toBeNull();
  });
});

describe('_parseGroupingSetsContent', () => {
  it('parses simple sets (content excludes the outermost parens)', () => {
    expect(_parseGroupingSetsContent('(a,b), (a), ()')).toEqual([['a', 'b'], ['a'], []]);
  });

  it('handles empty/whitespace gracefully', () => {
    expect(_parseGroupingSetsContent('   ')).toEqual([]);
    expect(_parseGroupingSetsContent('')).toEqual([]);
  });

  it('ignores parentheses inside string literals', () => {
    // The `)` inside 'x)' must not terminate the first set's parenthesized
    // expression; both sets parse correctly.
    const r = _parseGroupingSetsContent("(a, 'x)'), (b)");
    expect(r).toEqual([['a', "'x)'"], ['b']]);
  });
});

describe('_expandRollup / _expandCube', () => {
  it('expands ROLLUP to prefix sets in descending length', () => {
    expect(_expandRollup(['a', 'b'])).toEqual([['a', 'b'], ['a'], []]);
    expect(_expandRollup([])).toEqual([[]]);
  });

  it('expands CUBE to all subsets (descending cardinality)', () => {
    expect(_expandCube(['a', 'b'])).toEqual([['a', 'b'], ['a'], ['b'], []]);
    expect(_expandCube([])).toEqual([[]]);
    expect(_expandCube(['a'])).toEqual([['a'], []]);
  });

  it('orders CUBE subsets by descending bitmask cardinality', () => {
    expect(_expandCube(['a', 'b', 'c'])).toEqual([
      ['a', 'b', 'c'],
      ['a', 'b'], ['a', 'c'], ['a'],
      ['b', 'c'], ['b'], ['c'],
      [],
    ]);
  });
});

describe('_parseSelectColumns', () => {
  it('parses simple and aliased columns', () => {
    const cols = _parseSelectColumns('SELECT a, b AS bee, t.c FROM t');
    expect(cols.map(c => c.name)).toEqual(['a', 'bee', 'c']);
    expect(cols.map(c => c.isSimple)).toEqual([true, true, true]);
  });

  it('marks function calls as non-simple but resolves alias', () => {
    const cols = _parseSelectColumns('SELECT a, SUM(c) AS total FROM t');
    expect(cols[1].isSimple).toBe(false);
    expect(cols[1].name).toBe('total');
  });

  it('returns [] when no SELECT...FROM present', () => {
    expect(_parseSelectColumns('foo')).toEqual([]);
  });
});

describe('_transformGroupingFunc', () => {
  it('transforms a single GROUPING() call', () => {
    expect(_transformGroupingFunc('SELECT GROUPING(a) FROM t')).toBe(
      'SELECT CASE WHEN (a IS NULL) THEN 1 ELSE 0 END FROM t',
    );
  });

  it('leaves text without GROUPING() untouched', () => {
    expect(_transformGroupingFunc('SELECT a FROM t')).toBe('SELECT a FROM t');
  });
});

describe('real better-sqlite3 end-to-end semantics', () => {
  it('ROLLUP expansion produces subtotal + grand-total rows', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE t(a TEXT, b TEXT); INSERT INTO t VALUES ('x','p'),('x','q'),('y','p')",
    );
    const { sql } = rewriteGroupingSets(
      'SELECT a, b, COUNT(*) AS c FROM t GROUP BY ROLLUP (a, b)',
    );
    const rows = db.prepare(sql).all();
    // ROLLUP(a,b) = GROUPING SETS((a,b),(a),()):
    // (a,b) has 3 groups, (a) has 2 groups, () has 1 group → 6 rows.
    expect(rows.length).toBe(6);
  });

  it('CUBE expansion produces all aggregates including cross-subtotals', () => {
    const db = new Database(':memory:');
    db.exec(
      "CREATE TABLE t(a TEXT, b TEXT); INSERT INTO t VALUES ('x','p'),('x','q'),('y','p')",
    );
    const { sql } = rewriteGroupingSets('SELECT a, b, COUNT(*) AS c FROM t GROUP BY CUBE (a, b)');
    const rows = db.prepare(sql).all();
    // CUBE(a,b) = GROUPING SETS((a,b),(a),(b),()):
    // (a,b) 3 groups, (a) 2, (b) 2, () 1 → 8 rows.
    expect(rows.length).toBe(8);
  });
});
