import { describe, it, expect } from 'vitest';
import {
  detectExpressionIndex,
  rewriteExpressionIndex,
} from '../index/ExpressionIndexRewriter';

describe('ExpressionIndexRewriter — detectExpressionIndex', () => {
  it('detects a double-parenthesised expression column', () => {
    expect(detectExpressionIndex('CREATE INDEX ix ON t ((lower(name)))')).toBe(true);
  });

  it('detects an arithmetic expression column', () => {
    expect(detectExpressionIndex('CREATE INDEX ix ON t ((price * 1.1))')).toBe(true);
  });

  it('detects an expression among simple columns', () => {
    expect(detectExpressionIndex('CREATE INDEX ix ON t (id, (lower(name)))')).toBe(true);
  });

  it('returns false for a plain column list', () => {
    expect(detectExpressionIndex('CREATE INDEX ix ON t (id, name)')).toBe(false);
  });

  it('returns false for a UNIQUE index without expressions', () => {
    expect(detectExpressionIndex('CREATE UNIQUE INDEX ix ON t (id)')).toBe(false);
  });

  it('returns false for a non CREATE INDEX statement', () => {
    expect(detectExpressionIndex('SELECT * FROM t')).toBe(false);
  });

  it('returns false for a harmless CREATE INDEX fragment', () => {
    expect(detectExpressionIndex('CREATE INDEX')).toBe(false);
  });

  it('detects a schema-qualified expression index', () => {
    expect(detectExpressionIndex('CREATE INDEX ix ON schema.t ((a + b))')).toBe(true);
  });
});

describe('ExpressionIndexRewriter — rewriteExpressionIndex (basic unwrapping)', () => {
  it('unwraps a simple function expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((lower(name)))');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX ix ON t (lower(name))');
  });

  it('unwraps an arithmetic expression and strips ASC', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((col + 1) ASC)');
    expect(r.sql).toBe('CREATE INDEX ON t (col + 1)');
  });

  it('unwraps and strips NULLS FIRST', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((col) NULLS FIRST)');
    expect(r.sql).toBe('CREATE INDEX ON t (col)');
  });

  it('unwraps and strips NULLS LAST', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((col) NULLS LAST)');
    expect(r.sql).toBe('CREATE INDEX ON t (col)');
  });

  it('preserves a JSON extraction expression', () => {
    const r = rewriteExpressionIndex("CREATE INDEX ix ON t ((json_extract(data, '$.key')))");
    expect(r.sql).toBe("CREATE INDEX ix ON t (json_extract(data, '$.key'))");
  });

  it('preserves a nested function composition', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((lower(trim(col))))');
    expect(r.sql).toBe('CREATE INDEX ix ON t (lower(trim(col)))');
  });

  it('preserves a simple price arithmetic expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((price * 1.1))');
    expect(r.sql).toBe('CREATE INDEX ix ON t (price * 1.1)');
  });

  it('keeps simple columns alongside an expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((a), id)');
    expect(r.sql).toBe('CREATE INDEX ix ON t (a, id)');
  });

  it('handles UNIQUE and IF NOT EXISTS modifiers', () => {
    const r = rewriteExpressionIndex('CREATE UNIQUE INDEX IF NOT EXISTS ix ON t ((a), b)');
    expect(r.sql).toBe('CREATE UNIQUE INDEX IF NOT EXISTS ix ON t (a, b)');
  });

  it('handles a schema-qualified table', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON schema.t ((a))');
    expect(r.sql).toBe('CREATE INDEX ix ON schema.t (a)');
  });

  it('handles a schema-qualified index name', () => {
    const r = rewriteExpressionIndex('CREATE INDEX schema.ix ON t ((a))');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('(a)');
  });

  it('strips DESC from a double-parenthesised expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((a) DESC)');
    expect(r.sql).toBe('CREATE INDEX ON t (a)');
  });

  it('strips a trailing semicolon correctly', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((a));');
    expect(r.sql).toBe('CREATE INDEX ix ON t (a);');
  });

  it('preserves extra whitespace in the suffix', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((a))   ');
    expect(r.sql).toBe('CREATE INDEX ix ON t (a)   ');
  });
});

describe('ExpressionIndexRewriter — rewriteExpressionIndex (no-op paths)', () => {
  it('returns the input unchanged for a non CREATE INDEX statement', () => {
    const r = rewriteExpressionIndex('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('returns the input unchanged for a plain column list', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t (id, name)');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE INDEX ix ON t (id, name)');
  });

  it('returns false rewritten for a single-column non-expression index', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t (id)');
    expect(r.rewritten).toBe(false);
  });
});

describe('ExpressionIndexRewriter — rewriteExpressionIndex (expression variants)', () => {
  const funcCases: Array<[string, string]> = [
    ['json_unquote', "json_unquote(data)"],
    ['json_type', "json_type(data)"],
    ['substr', 'substr(name, 1, 3)'],
    ['substring', 'substring(name, 1)'],
    ['trim', 'trim(name)'],
    ['ltrim', 'ltrim(name)'],
    ['rtrim', 'rtrim(name)'],
    ['lower', 'lower(name)'],
    ['upper', 'upper(name)'],
    ['length', 'length(name)'],
    ['abs', 'abs(x)'],
    ['round', 'round(x)'],
    ['ceil', 'ceil(x)'],
    ['floor', 'floor(x)'],
    ['coalesce', 'coalesce(a, b)'],
    ['ifnull', 'ifnull(a, b)'],
    ['nullif', 'nullif(a, b)'],
    ['typeof', 'typeof(a)'],
    ['instr', 'instr(a, b)'],
    ['replace', 'replace(a, b, c)'],
    ['like', 'like(a, b)'],
    ['glob', 'glob(a, b)'],
    ['unicode', 'unicode(a)'],
    ['char', 'char(65)'],
    ['printf', "printf('%d', x)"],
    ['hex', 'hex(x)'],
    ['quote', 'quote(x)'],
  ];

  for (const [fn, expr] of funcCases) {
    it(`preserves the ${fn}() expression`, () => {
      const sql = `CREATE INDEX ix ON t ((${expr}))`;
      const r = rewriteExpressionIndex(sql);
      expect(r.rewritten).toBe(true);
      expect(r.sql).toBe(`CREATE INDEX ix ON t (${expr})`);
    });
  }

  const arithOps = ['+', '-', '*', '/', '%'];
  for (const op of arithOps) {
    it(`preserves an arithmetic expression with ${op}`, () => {
      const sql = `CREATE INDEX ix ON t ((a ${op} b))`;
      const r = rewriteExpressionIndex(sql);
      expect(r.sql).toBe(`CREATE INDEX ix ON t (a ${op} b)`);
    });
  }
});

describe('ExpressionIndexRewriter — rewriteExpressionIndex (edge cases)', () => {
  it('handles a triple-nested expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t (((a)))');
    expect(r.sql).toBe('CREATE INDEX ix ON t (a)');
  });

  it('preserves an empty parenthesised fragment instead of emitting an empty column', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t (())');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX ON t (())');
  });

  it('preserves empty fragments among valid columns', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((), a)');
    expect(r.sql).toBe('CREATE INDEX ON t ((), a)');
  });

  it('handles a STRICT function name prefix that is not a function call', () => {
    // `lowerx` starts with `lower` but is not `lower(` — treated as a column.
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((lowerx))');
    expect(r.sql).toBe('CREATE INDEX ix ON t (lowerx)');
  });

  it('does not strip an arithmetic operator inside a quoted string', () => {
    const r = rewriteExpressionIndex("CREATE INDEX ix ON t ((replace(name, 'a-b', 'x')))");
    expect(r.sql).toBe("CREATE INDEX ix ON t (replace(name, 'a-b', 'x'))");
  });

  it('passes through a column with an embedded quote mark', () => {
    const r = rewriteExpressionIndex(`CREATE INDEX ix ON t (("weird"col))`);
    expect(r.rewritten).toBe(true);
  });

  it('returns false rewritten when no match', () => {
    expect(rewriteExpressionIndex('').rewritten).toBe(false);
  });

  it('passes through a non-expression column with a trailing comma', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t (a,)');
    expect(r.rewritten).toBe(false);
  });

  it('handles an unmatched opening parenthesis gracefully', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t ((a');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('CREATE INDEX ix ON t ((a');
  });

  it('preserves an unterminated nested expression as-is', () => {
    // `(((a)` has an unterminated inner parenthesis; the rewriter must return
    // the fragment unchanged rather than corrupting it.
    const r = rewriteExpressionIndex('CREATE INDEX ix ON t (((a)');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE INDEX ix ON t (((a)');
  });

  it('preserves a non-modifier tail after a function expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((lower(name)) foo)');
    expect(r.sql).toBe('CREATE INDEX ON t (lower(name) foo)');
  });

  it('strips DESC from a function expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((lower(name)) DESC)');
    expect(r.sql).toBe('CREATE INDEX ON t (lower(name))');
  });

  it('strips NULLS LAST from a function expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((lower(name)) NULLS LAST)');
    expect(r.sql).toBe('CREATE INDEX ON t (lower(name))');
  });

  it('strips DESC from an arithmetic expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((a + b) DESC)');
    expect(r.sql).toBe('CREATE INDEX ON t (a + b)');
  });

  it('preserves an unknown trailing token after a simple expression', () => {
    const r = rewriteExpressionIndex('CREATE INDEX ON t ((a) foo)');
    expect(r.sql).toBe('CREATE INDEX ON t (a foo)');
  });

  it('handles a nested expression with a trailing modifier (no duplication)', () => {
    // Regression guard: `afterInner` must not be emitted twice.
    const r = rewriteExpressionIndex('CREATE INDEX ON t (((a) b))');
    expect(r.sql).toBe('CREATE INDEX ON t (a b)');
  });
});
