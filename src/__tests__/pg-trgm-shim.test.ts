import { describe, it, expect } from 'vitest';
import {
  showTrgm,
  trigramDiceCoefficient,
  similarity,
  wordSimilarity,
  strictWordSimilarity,
  showLimit,
  setLimit,
  detectPgTrgmFunction,
  PG_TRGM_FUNCTIONS,
  PG_TRGM_FN_MAP,
} from '../query/PgTrgmShim';

describe('PgTrgmShim', () => {
  describe('showTrgm', () => {
    it('extracts padded trigrams for a single character', () => {
      expect(showTrgm('a')).toEqual(['  a', ' a ', 'a  ']);
    });
    it('extracts padded trigrams for two characters', () => {
      expect(showTrgm('ab')).toEqual(['  a', ' ab', 'ab ', 'b  ']);
    });
    it('extracts trigrams for three characters', () => {
      expect(showTrgm('abc')).toEqual(['  a', ' ab', 'abc', 'bc ', 'c  ']);
    });
    it('lowercases the input', () => {
      expect(showTrgm('ABC')).toEqual(showTrgm('abc'));
    });
    it('returns [] for null/undefined', () => {
      expect(showTrgm(null as any)).toEqual([]);
      expect(showTrgm(undefined as any)).toEqual([]);
    });
  });

  describe('trigramDiceCoefficient', () => {
    it('returns 1.0 when both empty', () => {
      expect(trigramDiceCoefficient([], [])).toBe(1.0);
    });
    it('returns 0.0 when one is empty', () => {
      expect(trigramDiceCoefficient(['  a'], [])).toBe(0.0);
      expect(trigramDiceCoefficient([], ['  a'])).toBe(0.0);
    });
    it('computes multiset intersection', () => {
      // identical sets → 1.0
      expect(trigramDiceCoefficient(['a', 'b'], ['a', 'b'])).toBe(1.0);
      // no overlap → 0.0
      expect(trigramDiceCoefficient(['a'], ['b'])).toBe(0.0);
      // partial overlap: shared=1 of 4 → 2*1/4 = 0.5
      expect(trigramDiceCoefficient(['a', 'b'], ['a', 'c'])).toBe(0.5);
    });
    it('counts duplicates via min frequency', () => {
      // t1 has 'a' twice, t2 once → shared=1; total=3 → 2/3
      expect(trigramDiceCoefficient(['a', 'a'], ['a'])).toBeCloseTo(2 / 3, 5);
    });
  });

  describe('similarity', () => {
    it('identical strings → 1.0', () => {
      expect(similarity('abc', 'abc')).toBe(1.0);
      expect(similarity('hello', 'hello')).toBe(1.0);
    });
    it('empty empty → 1.0', () => {
      expect(similarity('', '')).toBe(1.0);
    });
    it('empty vs non-empty → 0.0', () => {
      expect(similarity('', 'abc')).toBe(0.0);
      expect(similarity('abc', '')).toBe(0.0);
    });
    it('partial similarity is between 0 and 1', () => {
      const s = similarity('word', 'world');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });
  });

  describe('wordSimilarity', () => {
    it('returns 0.0 for null or empty inputs', () => {
      expect(wordSimilarity(null as any, 'abc')).toBe(0.0);
      expect(wordSimilarity('abc', null as any)).toBe(0.0);
      expect(wordSimilarity('', 'abc')).toBe(0.0);
      expect(wordSimilarity('abc', '')).toBe(0.0);
    });
    it('finds best word match', () => {
      expect(wordSimilarity('hello', 'hello world')).toBe(1.0);
    });
    it('returns 0.0 when b has no alphanumeric words', () => {
      expect(wordSimilarity('a', '---')).toBe(0.0);
    });
  });

  describe('strictWordSimilarity', () => {
    it('matches wordSimilarity', () => {
      expect(strictWordSimilarity('hello', 'hello world')).toBe(1.0);
      expect(strictWordSimilarity(null as any, 'x')).toBe(0.0);
    });
  });

  describe('showLimit / setLimit', () => {
    it('returns the module limit, setLimit returns the previous value', () => {
      const old = setLimit(0.6);
      const prevValue = old; // whatever it was before
      expect(showLimit()).toBeCloseTo(0.6, 5);
      expect(old).toBe(prevValue);
      setLimit(0.3); // reset to default
    });
    it('setLimit chaining is self-consistent', () => {
      setLimit(0.3);
      const a = setLimit(0.7);
      expect(a).toBeCloseTo(0.3, 5);
      const b = setLimit(a);
      expect(b).toBeCloseTo(0.7, 5);
      expect(showLimit()).toBeCloseTo(0.3, 5);
    });
  });

  describe('detectPgTrgmFunction', () => {
    it('detects direct and qualified calls', () => {
      expect(detectPgTrgmFunction("SELECT similarity(a, b)")).toBe(true);
      expect(detectPgTrgmFunction('SELECT public.show_trgm(t)')).toBe(true);
      expect(detectPgTrgmFunction('SELECT word_similarity(a, b)')).toBe(true);
      expect(detectPgTrgmFunction('SELECT show_limit()')).toBe(true);
      expect(detectPgTrgmFunction('SELECT set_limit(0.5)')).toBe(true);
    });
    it('returns false when no pg_trgm function', () => {
      expect(detectPgTrgmFunction('SELECT 1')).toBe(false);
      expect(detectPgTrgmFunction('SELECT upper(name) FROM t')).toBe(false);
    });
    it('does NOT match inside string literals', () => {
      expect(detectPgTrgmFunction("SELECT 'similarity(a,b)'")).toBe(false);
      expect(detectPgTrgmFunction("SELECT 'show_trgm'")).toBe(false);
    });
    it('does NOT match inside comments', () => {
      expect(detectPgTrgmFunction('-- similarity(a,b)\nSELECT 1')).toBe(false);
      expect(detectPgTrgmFunction('/* set_limit(0.1) */ SELECT 1')).toBe(false);
    });
    it('does NOT match a bare word without call parens', () => {
      expect(detectPgTrgmFunction('SELECT similarity FROM t')).toBe(false);
    });
    it('does NOT match wordsimilarity (missing underscore)', () => {
      expect(detectPgTrgmFunction("SELECT wordsimilarity(a,b)")).toBe(false);
    });
    it('returns false for empty / non-string', () => {
      expect(detectPgTrgmFunction('')).toBe(false);
      expect(detectPgTrgmFunction(null as any)).toBe(false);
      expect(detectPgTrgmFunction(42 as any)).toBe(false);
    });
    it('is stateless across repeated calls', () => {
      expect(detectPgTrgmFunction('SELECT similarity(a,b)')).toBe(true);
      expect(detectPgTrgmFunction('SELECT 1')).toBe(false);
      expect(detectPgTrgmFunction('SELECT similarity(a,b)')).toBe(true);
    });
  });

  describe('catalog metadata', () => {
    it('lists all six functions', () => {
      const names = PG_TRGM_FUNCTIONS.map((f) => f.name).sort();
      expect(names).toEqual([
        'set_limit', 'show_limit', 'show_trgm', 'similarity',
        'strict_word_similarity', 'word_similarity',
      ]);
    });
    it('maps every function name to an implementation', () => {
      for (const f of PG_TRGM_FUNCTIONS) {
        expect(PG_TRGM_FN_MAP[f.name]).toBeTypeOf('function');
      }
    });
  });
});
