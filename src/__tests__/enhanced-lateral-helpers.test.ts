import { describe, it, expect } from 'vitest';
import {
  _extractParenthesizedContent,
  _extractOuterAliases,
  _findClauseEnd,
  _splitTopLevel,
  _isRefInWhereClause,
  _refIsInWhereClause,
  _extractColumnAlias,
  _checkSingleColumnSelect,
  _extractSubqueryAlias,
  _extractContextBeforeLateral,
  _rewriteOneLateralContext,
} from '../query/EnhancedLateralRewriter';

describe('_extractParenthesizedContent', () => {
  it('returns null when the open paren index is not an opening parenthesis', () => {
    // Call with an index that does not point at '('.
    const r = _extractParenthesizedContent('abc', 1);
    expect(r).toBeNull();
  });

  it('returns null for an unterminated paren', () => {
    const r = _extractParenthesizedContent('(abc', 0);
    expect(r).toBeNull();
  });

  it('extracts inner SQL with nested parens', () => {
    const r = _extractParenthesizedContent('(a(b)c)', 0);
    expect(r?.innerSql).toBe('a(b)c');
    expect(r?.endIndex).toBe(6);
  });
});

describe('_extractOuterAliases', () => {
  it('collects aliases and deduplicates', () => {
    const aliases = _extractOuterAliases(
      'SELECT * FROM users u, users u, orders o, LATERAL (SELECT 1) s',
      51,
    );
    expect(aliases).toContain('u');
    expect(aliases).toContain('o');
    // `u` appears twice but is deduplicated.
    expect(aliases.filter(a => a === 'u')).toHaveLength(1);
  });

  it('skips a parenthesized subquery and keyword-only items', () => {
    const aliases = _extractOuterAliases(
      'SELECT * FROM (SELECT 1) x, users u, LATERAL (SELECT 1) s',
      45,
    );
    expect(aliases).toContain('u');
    // `x` is an alias of a parenthesized subquery and is intentionally skipped.
    expect(aliases).not.toContain('x');
  });

  it('falls back past a trailing keyword to the preceding identifier', () => {
    // `ORDER` is a reserved keyword and is skipped; the walk-back lands on
    // `users` (the only preceding identifier).
    const aliases = _extractOuterAliases(
      'SELECT * FROM users ORDER, LATERAL (SELECT 1) s',
      33,
    );
    expect(aliases).toContain('users');
  });

  it('skips empty FROM items entirely', () => {
    const sql = 'SELECT * FROM , , LATERAL (SELECT 1) s';
    const aliases = _extractOuterAliases(sql, sql.indexOf('LATERAL'));
    // Both comma-separated items are empty → no aliases collected.
    expect(aliases).toEqual([]);
  });

  it('ignores a keyword-only FROM item without crashing', () => {
    const sql = 'SELECT * FROM GROUP, LATERAL (SELECT 1) s';
    const aliases = _extractOuterAliases(sql, sql.indexOf('LATERAL'));
    // `GROUP` is a reserved keyword; nothing else qualifies as an alias.
    expect(aliases).toEqual([]);
  });

  it('skips a FROM item that reduces to empty after removing the WHERE suffix', () => {
    const sql = 'SELECT * FROM WHERE x = 1, LATERAL (SELECT 1) s';
    const aliases = _extractOuterAliases(sql, sql.indexOf('LATERAL'));
    expect(aliases).toEqual([]);
  });

  it('skips an empty join segment produced by a leading JOIN keyword', () => {
    // `JOIN x` split on `\s+JOIN\s+` yields a leading empty segment; that
    // segment must be skipped without contributing an alias.
    const sql = 'SELECT * FROM JOIN x, LATERAL (SELECT 1) s';
    const aliases = _extractOuterAliases(sql, sql.indexOf('LATERAL'));
    expect(aliases).toEqual(['x']);
  });
});

describe('_findClauseEnd', () => {
  it('stops at a clause ender at depth 0', () => {
    const end = _findClauseEnd('FROM users u WHERE u.id = 1', 0);
    expect('FROM users u WHERE u.id = 1'.slice(0, end)).toBe('FROM users u ');
  });

  it('does not stop at a clause ender keyword inside a string literal', () => {
    const sql = "FROM users u JOIN t ON t.note = 'where' AND x";
    const end = _findClauseEnd(sql, 0);
    // `where` inside the string must not terminate the clause; only the real
    // end of string (or a genuine clause ender) does.
    expect(end).toBe(sql.length);
  });

  it('returns length when no clause ender found', () => {
    const end = _findClauseEnd('FROM users u', 0);
    expect(end).toBe('FROM users u'.length);
  });
});

describe('_splitTopLevel', () => {
  it('splits on commas at depth 0 but not inside parens or literals', () => {
    expect(_splitTopLevel('a, b(c,d), e', ',')).toEqual(['a', ' b(c,d)', ' e']);
    expect(_splitTopLevel("a, 'x,y', b", ',')).toEqual(['a', " 'x,y'", ' b']);
  });
});

describe('_isRefInWhereClause / _refIsInWhereClause', () => {
  it('returns false when the ref is at position 0', () => {
    expect(_isRefInWhereClause('u.id FROM t', 0)).toBe(false);
  });

  it('returns false when the ref is absent', () => {
    expect(_refIsInWhereClause('SELECT x FROM t WHERE x = 1', 'u.id')).toBe(false);
  });

  it('detects a ref in the WHERE clause', () => {
    expect(_refIsInWhereClause('SELECT x FROM t WHERE x = u.id', 'u.id')).toBe(true);
  });

  it('handles a FROM appearing after WHERE', () => {
    // `from` appears as a substring after the WHERE keyword.
    expect(_refIsInWhereClause("SELECT x FROM t WHERE note = 'from' AND y = u.id", 'u.id')).toBe(true);
  });

  it('returns false when the ref sits before the WHERE clause', () => {
    // `u.id` here would be in the FROM-located expression (before WHERE).
    expect(_isRefInWhereClause("u.id FROM t WHERE x = 1", 0)).toBe(false);
  });

  it('returns false when a FROM appears between WHERE and the ref (nested subquery)', () => {
    const sql = 'SELECT x FROM t WHERE note = (SELECT y FROM t2) AND z = u.id';
    expect(_isRefInWhereClause(sql, sql.indexOf('u.id'))).toBe(false);
  });

  it('accepts a ref in a top-level WHERE that precedes the outer FROM scan', () => {
    const sql = 'SELECT x FROM t WHERE z = u.id';
    expect(_isRefInWhereClause(sql, sql.indexOf('u.id'))).toBe(true);
  });
});

describe('_extractColumnAlias', () => {
  it('extracts AS alias', () => {
    expect(_extractColumnAlias('u.age AS calc')).toBe('calc');
  });

  it('extracts a bare space-separated alias', () => {
    expect(_extractColumnAlias('u.age calc')).toBe('calc');
  });

  it('extracts the column from a table-qualified reference', () => {
    expect(_extractColumnAlias('u.age')).toBe('age');
  });

  it('falls back to the whole expression when nothing matches', () => {
    expect(_extractColumnAlias('count(*)')).toBe('count(*)');
  });

  it('falls back to a literal scalar alias for a blank expression', () => {
    expect(_extractColumnAlias('   ')).toBe('scalar');
  });
});

describe('_checkSingleColumnSelect', () => {
  it('returns false for an empty/non-SELECT input', () => {
    expect(_checkSingleColumnSelect('')).toBe(false);
    expect(_checkSingleColumnSelect('VALUES (1)')).toBe(false);
    expect(_checkSingleColumnSelect('SELECT ')).toBe(false);
  });

  it('returns false when the SELECT list is empty', () => {
    expect(_checkSingleColumnSelect('SELECT FROM t')).toBe(false);
  });

  it('returns true for a single-column SELECT', () => {
    expect(_checkSingleColumnSelect('SELECT u.age')).toBe(true);
  });

  it('returns false for a multi-column SELECT', () => {
    expect(_checkSingleColumnSelect('SELECT u.id, u.age')).toBe(false);
  });
});

describe('_extractSubqueryAlias', () => {
  it('extracts a bare alias', () => {
    expect(_extractSubqueryAlias(') sub', 0)).toBe('sub');
  });

  it('extracts an AS alias', () => {
    expect(_extractSubqueryAlias(') AS sub', 0)).toBe('sub');
  });

  it('returns empty when no alias follows', () => {
    expect(_extractSubqueryAlias(') ', 0)).toBe('');
  });
});

describe('_extractContextBeforeLateral / _rewriteOneLateralContext', () => {
  it('returns empty for an unrecognized context', () => {
    expect(_extractContextBeforeLateral('SELECT x ')).toBe('');
  });

  it('extracts a comma context with trailing whitespace', () => {
    expect(_extractContextBeforeLateral('FROM users u, ')).toBe(', ');
  });

  it('strips LATERAL when context is empty', () => {
    const sql = 'SELECT 1 LATERAL (SELECT 2) s';
    expect(_rewriteOneLateralContext(sql, sql.indexOf('LATERAL'), '')).toBe(
      'SELECT 1  (SELECT 2) s',
    );
  });

  it('handles an unknown (non-FROM/comma/join) context', () => {
    const sql = 'X LATERAL (SELECT 1) s';
    // `X ` is not FROM/comma/join, so the context (and leading whitespace) is
    // dropped and only LATERAL is removed.
    expect(_rewriteOneLateralContext(sql, sql.indexOf('LATERAL'), 'X ')).toBe(
      '  (SELECT 1) s',
    );
  });
});
