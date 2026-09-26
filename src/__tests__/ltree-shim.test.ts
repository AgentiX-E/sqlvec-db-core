import { describe, it, expect } from 'vitest';
import {
  LtreeLabel,
  LtreePath,
  LtreeShim,
  ltree,
  ltree2text,
  nlevel,
  subltree,
  subpath,
  ancestorOf,
  descendantOf,
  concat,
  ltreeMatch,
  anyLabelMatch,
  textSearch,
  lquery,
  ltxtquery,
  isLtreeModuleEnabled,
  detectLtreeFunctions,
  evaluateLtreeFunction,
} from '../query/LtreeShim';

describe('LtreeLabel', () => {
  it('constructs a valid label and preserves value', () => {
    expect(new LtreeLabel('abc').value).toBe('abc');
    expect(new LtreeLabel('A_1').value).toBe('A_1');
  });

  it('trims surrounding whitespace', () => {
    expect(new LtreeLabel('  abc  ').value).toBe('abc');
  });

  it('rejects empty / non-string / invalid labels', () => {
    expect(() => new LtreeLabel('')).toThrow(/non-empty string/);
    expect(() => new LtreeLabel(123 as any)).toThrow(/non-empty string/);
    expect(() => new LtreeLabel('a b')).toThrow(/Invalid ltree label/);
    expect(() => new LtreeLabel('a-b')).toThrow(/Invalid ltree label/);
    expect(() => new LtreeLabel('a.b')).toThrow(/Invalid ltree label/);
  });

  it('toString returns the value', () => {
    expect(new LtreeLabel('x').toString()).toBe('x');
  });

  it('equals compares by value', () => {
    expect(new LtreeLabel('a').equals(new LtreeLabel('a'))).toBe(true);
    expect(new LtreeLabel('a').equals(new LtreeLabel('b'))).toBe(false);
  });

  it('compareTo is lexicographic', () => {
    expect(new LtreeLabel('a').compareTo(new LtreeLabel('b'))).toBe(-1);
    expect(new LtreeLabel('b').compareTo(new LtreeLabel('a'))).toBe(1);
    expect(new LtreeLabel('a').compareTo(new LtreeLabel('a'))).toBe(0);
  });
});

describe('LtreePath', () => {
  it('parses a dotted string', () => {
    const p = LtreePath.parse('a.b.c');
    expect(p.depth).toBe(3);
    expect(p.toString()).toBe('a.b.c');
  });

  it('constructs from string or label array', () => {
    expect(new LtreePath('a.b').depth).toBe(2);
    expect(new LtreePath([new LtreeLabel('a'), new LtreeLabel('b')]).depth).toBe(2);
  });

  it('rejects empty/invalid/bad-type input', () => {
    expect(() => new LtreePath('')).toThrow();
    expect(() => new LtreePath([])).toThrow(/at least one label/);
    expect(() => new LtreePath(5 as any)).toThrow(/expected string or LtreeLabel\[\]/);
    expect(() => LtreePath.parse('')).toThrow(/non-empty string/);
    expect(() => LtreePath.parse(null as any)).toThrow();
    expect(() => LtreePath.parse('a..b')).toThrow(/Invalid ltree path/);
    expect(() => LtreePath.parse('a b')).toThrow(/Invalid ltree path/);
  });

  it('compareTo orders by depth then lexicographically', () => {
    expect(new LtreePath('a').compareTo(new LtreePath('a.b'))).toBe(-1);
    expect(new LtreePath('a.b').compareTo(new LtreePath('a'))).toBe(1);
    expect(new LtreePath('a.c').compareTo(new LtreePath('a.b'))).toBe(1);
    expect(new LtreePath('a.b').compareTo(new LtreePath('a.b'))).toBe(0);
  });

  it('isAncestorOf / isDescendantOf', () => {
    const a = LtreePath.parse('a');
    const ab = LtreePath.parse('a.b');
    const ac = LtreePath.parse('a.c');
    expect(a.isAncestorOf(ab)).toBe(true);
    expect(a.isAncestorOf(ac)).toBe(true);
    expect(ab.isAncestorOf(a)).toBe(false);
    expect(ab.isDescendantOf(a)).toBe(true);
    expect(a.isDescendantOf(ab)).toBe(false);
    expect(a.isAncestorOf(a)).toBe(true);
    // Same depth, later label mismatch.
    expect(LtreePath.parse('a.b').isAncestorOf(LtreePath.parse('a.c'))).toBe(false);
  });

  it('subltree slices from start (inclusive) to end (exclusive)', () => {
    const p = LtreePath.parse('a.b.c.d');
    expect(p.subltree(1).toString()).toBe('b.c.d');
    expect(p.subltree(1, 3).toString()).toBe('b.c');
    expect(() => p.subltree(1, 1)).toThrow(/empty/);
    expect(() => p.subltree(99)).toThrow(/empty/);
  });

  it('subpath takes start and count', () => {
    const p = LtreePath.parse('a.b.c.d');
    expect(p.subpath(1, 2).toString()).toBe('b.c');
    expect(() => p.subpath(1, 0)).toThrow(/empty/);
    expect(p.subpath(0, 1).toString()).toBe('a');
    expect(() => p.subpath(5, 1)).toThrow(/empty/);
  });

  it('equals by compareTo', () => {
    expect(LtreePath.parse('a.b').equals(LtreePath.parse('a.b'))).toBe(true);
    expect(LtreePath.parse('a.b').equals(LtreePath.parse('a.c'))).toBe(false);
  });
});

describe('LtreeShim static handlers', () => {
  const P = (s: string) => LtreePath.parse(s);

  it('ltree / ltree_in parse', () => {
    expect(LtreeShim.ltree('a.b').depth).toBe(2);
    expect(LtreeShim.ltree_in('a.b').depth).toBe(2);
  });

  it('ltree2text', () => {
    expect(LtreeShim.ltree2text(P('a.b'))).toBe('a.b');
  });

  it('comparison operators', () => {
    expect(LtreeShim.compare(P('a'), P('a.b'))).toBe(-1);
    expect(LtreeShim.lt(P('a'), P('a.b'))).toBe(true);
    expect(LtreeShim.lte(P('a'), P('a'))).toBe(true);
    expect(LtreeShim.gt(P('a.b'), P('a'))).toBe(true);
    expect(LtreeShim.gte(P('a'), P('a'))).toBe(true);
    expect(LtreeShim.eq(P('a'), P('a'))).toBe(true);
  });

  it('ancestorOf / descendantOf', () => {
    expect(LtreeShim.ancestorOf(P('a'), P('a.b'))).toBe(true);
    expect(LtreeShim.descendantOf(P('a.b'), P('a'))).toBe(true);
    expect(LtreeShim.ancestorOf(P('a.b'), P('a'))).toBe(false);
  });

  it('lca finds lowest common ancestor', () => {
    expect(LtreeShim.lca(P('a.b.c'), P('a.b.d')).toString()).toBe('a.b');
    expect(LtreeShim.lca(P('a.b'), P('a.b')).toString()).toBe('a.b');
    expect(() => LtreeShim.lca(P('a'), P('b'))).toThrow(/no common ancestor/);
  });

  it('subltree / subpath extraction', () => {
    expect(LtreeShim.subltree(P('a.b.c'), 1).toString()).toBe('b.c');
    expect(LtreeShim.subpath(P('a.b.c'), 1, 1).toString()).toBe('b');
  });

  it('nlevel', () => {
    expect(LtreeShim.nlevel(P('a.b.c'))).toBe(3);
  });

  it('concat', () => {
    expect(LtreeShim.concat(P('a'), P('b.c')).toString()).toBe('a.b.c');
  });

  it('anyLabelMatch', () => {
    expect(LtreeShim.anyLabelMatch(P('a.b.c'), 'b')).toBe(true);
    expect(LtreeShim.anyLabelMatch(P('a.b.c'), 'z')).toBe(false);
  });

  it('isModuleEnabled is always true', () => {
    expect(LtreeShim.isModuleEnabled()).toBe(true);
  });
});

describe('LtreeShim.match (lquery semantics)', () => {
  const m = (p: string, pat: string) => LtreeShim.match(LtreePath.parse(p), pat);

  it('matches exact path', () => {
    expect(m('a.b.c', 'a.b.c')).toBe(true);
    expect(m('a.b.c', 'a.b')).toBe(false);
    expect(m('a.b', 'a.b.c')).toBe(false);
  });

  it('supports * as exactly one label', () => {
    expect(m('a.b.c', 'a.*.c')).toBe(true);
    expect(m('a.b.c', 'a.*')).toBe(false);
    expect(m('a.b', 'a.*')).toBe(true);
    expect(m('a', '*')).toBe(true);
    expect(m('a.b.c', '*')).toBe(false);
    // `*` after the last label must fail (needs one more label).
    expect(m('a', 'a.*')).toBe(false);
    expect(m('a', '*.*')).toBe(false);
  });

  it('supports % as zero-or-more labels (anchored)', () => {
    expect(m('a.b.c', '%.c')).toBe(true);
    expect(m('a.b.c.d', 'a.%.d')).toBe(true);
    expect(m('a.b', 'a.%.b')).toBe(true);
    expect(m('a.b', '%')).toBe(true);
    expect(m('a.b.c', '%.b.%')).toBe(true);
  });

  it('does not match when leading label is wrong (regression)', () => {
    // `%` must not swallow a mismatched leading label.
    expect(m('x.a.b', 'a.%.b')).toBe(false);
    expect(m('c.a.b', 'a.%.b')).toBe(false);
  });

  it('matches literal label runs through % correctly', () => {
    expect(m('a.c.d.b', 'a.%.b')).toBe(true);
    expect(m('a.b.c', 'a.%.x')).toBe(false);
  });
});

describe('backward-compatible function exports', () => {
  const P = (s: string) => LtreePath.parse(s);

  it('ltree returns legacy result', () => {
    const r = ltree('a.b');
    expect(r.labels).toEqual(['a', 'b']);
    expect(r.toString()).toBe('a.b');
  });

  it('ltree2text handles LtreePath and legacy', () => {
    expect(ltree2text(P('a.b'))).toBe('a.b');
    expect(ltree2text(ltree('a.b'))).toBe('a.b');
  });

  it('nlevel handles LtreePath and legacy', () => {
    expect(nlevel(P('a.b'))).toBe(2);
    expect(nlevel(ltree('a.b.c'))).toBe(3);
  });

  it('subltree handles LtreePath and legacy', () => {
    expect(subltree(P('a.b.c'), 1).labels).toEqual(['b', 'c']);
    expect(subltree(ltree('a.b.c'), 1, 2).labels).toEqual(['b']);
  });

  it('subpath takes count and validates empty result', () => {
    expect(subpath(P('a.b.c.d'), 1, 2).labels).toEqual(['b', 'c']);
    expect(subpath(ltree('a.b.c.d'), 1, 2).labels).toEqual(['b', 'c']);
    expect(() => subpath(P('a.b'), 1, 0)).toThrow(/empty/);
  });

  it('ancestorOf / descendantOf handle LtreePath and legacy', () => {
    expect(ancestorOf(P('a'), P('a.b'))).toBe(true);
    expect(ancestorOf(ltree('a'), ltree('a.b'))).toBe(true);
    expect(descendantOf(P('a.b'), P('a'))).toBe(true);
    expect(descendantOf(ltree('a.b'), ltree('a'))).toBe(true);
  });

  it('concat merges paths', () => {
    expect(concat(P('a'), P('b')).labels).toEqual(['a', 'b']);
    expect(concat(ltree('a'), ltree('b')).labels).toEqual(['a', 'b']);
  });

  it('ltreeMatch delegates to match', () => {
    expect(ltreeMatch(P('a.b.c'), 'a.*.c')).toBe(true);
    expect(ltreeMatch(ltree('a.b.c'), { pattern: 'a.*.c' })).toBe(true);
    expect(ltreeMatch(P('a.b.c'), 'a.b')).toBe(false);
  });

  it('anyLabelMatch handles LtreePath and legacy', () => {
    expect(anyLabelMatch(P('a.b'), 'b')).toBe(true);
    expect(anyLabelMatch(ltree('a.b'), 'z')).toBe(false);
  });

  it('textSearch requires all labels present', () => {
    expect(textSearch(P('a.b.c'), { labels: ['a', 'c'] })).toBe(true);
    expect(textSearch(ltree('a.b.c'), { labels: ['a', 'z'] })).toBe(false);
  });

  it('lquery wraps pattern', () => {
    expect(lquery('a.*')).toEqual({ pattern: 'a.*' });
  });

  it('ltxtquery extracts words', () => {
    expect(ltxtquery('a b c').labels).toEqual(['a', 'b', 'c']);
    expect(() => ltxtquery('')).toThrow(/empty text search/);
    expect(() => ltxtquery(null as any)).toThrow(/empty text search/);
  });

  it('isLtreeModuleEnabled', () => {
    expect(isLtreeModuleEnabled()).toBe(true);
  });
});

describe('detectLtreeFunctions (literal-aware)', () => {
  it('detects real ltree function calls', () => {
    expect(detectLtreeFunctions('SELECT nlevel(a) FROM t')).toBe(true);
    expect(detectLtreeFunctions('SELECT ltree(a)')).toBe(true);
    expect(detectLtreeFunctions('SELECT ltree2text(a)')).toBe(true);
    expect(detectLtreeFunctions('SELECT ltree_in(a)')).toBe(true);
    expect(detectLtreeFunctions('SELECT subltree(a, 1)')).toBe(true);
    expect(detectLtreeFunctions('SELECT subpath(a, 1, 2)')).toBe(true);
    expect(detectLtreeFunctions('SELECT lca(a, b)')).toBe(true);
    expect(detectLtreeFunctions('SELECT lquery(a)')).toBe(true);
    expect(detectLtreeFunctions('SELECT ltxtquery(a)')).toBe(true);
  });

  it('does NOT detect inside string literals or comments (regression)', () => {
    expect(detectLtreeFunctions("SELECT 'nlevel(a)' AS x")).toBe(false);
    expect(detectLtreeFunctions('SELECT 1 -- nlevel(a)')).toBe(false);
    expect(detectLtreeFunctions('SELECT 1 /* ltree(a) */ FROM t')).toBe(false);
    expect(detectLtreeFunctions('SELECT "nlevel"(a) FROM t')).toBe(false);
    expect(detectLtreeFunctions('SELECT `ltree`(a) FROM t')).toBe(false);
  });

  it('returns false for no match / empty / non-string', () => {
    expect(detectLtreeFunctions('SELECT 1')).toBe(false);
    expect(detectLtreeFunctions('')).toBe(false);
    expect(detectLtreeFunctions(undefined as any)).toBe(false);
  });

  it('handles a word that is only a prefix of a function name', () => {
    expect(detectLtreeFunctions('SELECT nlevels FROM t')).toBe(false);
  });

  it('handles unterminated comments and literals gracefully', () => {
    expect(detectLtreeFunctions('SELECT 1 -- nlevel(a)')).toBe(false);
    expect(detectLtreeFunctions('SELECT 1 /* nlevel(a)')).toBe(false);
    expect(detectLtreeFunctions("SELECT 'nlevel(")).toBe(false);
    expect(detectLtreeFunctions('SELECT "nlevel')).toBe(false);
  });
});

describe('evaluateLtreeFunction', () => {
  const P = (s: string) => LtreePath.parse(s);

  it('ltree / ltree_in', () => {
    expect(JSON.stringify(evaluateLtreeFunction('ltree', ['a.b']))).toContain('"a"');
    expect(JSON.stringify(evaluateLtreeFunction('ltree_in', ['a.b']))).toContain('"b"');
  });

  it('ltree2text', () => {
    expect(evaluateLtreeFunction('ltree2text', [ltree('a.b')])).toBe('a.b');
  });

  it('nlevel', () => {
    expect(evaluateLtreeFunction('nlevel', [P('a.b.c')])).toBe(3);
  });

  it('subltree uses end semantics', () => {
    const r = evaluateLtreeFunction('subltree', [P('a.b.c.d'), 1, 3]) as any;
    expect(r.labels).toEqual(['b', 'c']);
  });

  it('subltree with only start (no end)', () => {
    const r = evaluateLtreeFunction('subltree', [P('a.b.c.d'), 1]) as any;
    expect(r.labels).toEqual(['b', 'c', 'd']);
  });

  it('subpath uses count semantics (regression #268)', () => {
    const r = evaluateLtreeFunction('subpath', [P('a.b.c.d'), 1, 2]) as any;
    expect(r.labels).toEqual(['b', 'c']);
  });

  it('subpath with only start falls back to subltree semantics via evaluateLtreeFunction', () => {
    // evaluateLtreeFunction subpath requires two numeric args; with a missing
    // second it coerces undefined -> Number(undefined) -> NaN.
    expect(() => evaluateLtreeFunction('subpath', [P('a.b.c.d'), 1])).toThrow(/empty/);
  });

  it('lca', () => {
    const r = evaluateLtreeFunction('lca', [P('a.b.c'), P('a.b.d')]) as LtreePath;
    expect(r.toString()).toBe('a.b');
  });

  it('lquery / ltxtquery', () => {
    expect(evaluateLtreeFunction('lquery', ['a.*'])).toBe('a.*');
    const r = evaluateLtreeFunction('ltxtquery', ['a b']) as any;
    expect(r.search).toBe('a b');
    expect(r.labels).toEqual(['a', 'b']);
    expect(() => evaluateLtreeFunction('ltxtquery', [''])).toThrow(/empty text search/);
  });

  it('unknown function falls back to LtreeShim.evaluateFunction', () => {
    expect(() => evaluateLtreeFunction('bogus', [])).toThrow(/Unknown ltree function/);
  });
});

describe('LtreeShim.evaluateFunction (direct)', () => {
  const P = (s: string) => LtreePath.parse(s);

  it('dispatches every ltree function', () => {
    expect((LtreeShim.evaluateFunction('ltree', ['a.b']) as LtreePath).toString()).toBe('a.b');
    expect((LtreeShim.evaluateFunction('ltree_in', ['a.b']) as LtreePath).toString()).toBe('a.b');
    expect(LtreeShim.evaluateFunction('ltree2text', [P('a.b')])).toBe('a.b');
    expect(LtreeShim.evaluateFunction('nlevel', [P('a.b.c')])).toBe(3);
    expect((LtreeShim.evaluateFunction('subltree', [P('a.b.c.d'), 1, 3]) as LtreePath).toString()).toBe('b.c');
    expect((LtreeShim.evaluateFunction('subpath', [P('a.b.c.d'), 1, 2]) as LtreePath).toString()).toBe('b.c');
    expect((LtreeShim.evaluateFunction('lca', [P('a.b.c'), P('a.b.d')]) as LtreePath).toString()).toBe('a.b');
    expect(LtreeShim.evaluateFunction('lquery', ['a.*'])).toBe('a.*');
    expect(LtreeShim.evaluateFunction('ltxtquery', ['a b'])).toEqual({ search: 'a b', labels: ['a', 'b'] });
  });

  it('throws for unknown function', () => {
    expect(() => LtreeShim.evaluateFunction('nope', [])).toThrow(/Unknown ltree function/);
  });

  it('handles case-insensitive function names', () => {
    expect(LtreeShim.evaluateFunction('NLEVEL', [P('a.b')])).toBe(2);
    expect(LtreeShim.evaluateFunction('Lca', [P('a.b'), P('a.b')]) as any).toBeTruthy();
  });
});
