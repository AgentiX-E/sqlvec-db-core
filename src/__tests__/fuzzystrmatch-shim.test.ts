import { describe, it, expect, vi } from 'vitest';
import {
  levenshtein,
  metaphoneFn,
  soundexFn,
  doubleMetaphoneFn,
  difference,
  diceCoefficient,
  detectFuzzyMatch,
  rewriteFuzzyMatch,
  registerFuzzyFunctions,
  FUZZYSTRMATCH_FUNCTIONS,
  FUZZYSTRMATCH_FN_MAP,
} from '../query/FuzzystrmatchShim';

describe('FuzzystrmatchShim', () => {
  describe('levenshtein', () => {
    it('computes edit distance', () => {
      expect(levenshtein('kitten', 'sitting')).toBe(3);
      expect(levenshtein('abc', 'abc')).toBe(0);
      expect(levenshtein('', 'abc')).toBe(3);
      expect(levenshtein('abc', '')).toBe(3);
      expect(levenshtein('', '')).toBe(0);
    });
  });

  describe('soundexFn', () => {
    it('computes soundex code', () => {
      expect(soundexFn('hello')).toBe('H400');
      expect(soundexFn('Robert')).toBe(soundexFn('Rupert'));
    });
  });

  describe('metaphoneFn', () => {
    it('computes metaphone code', () => {
      expect(metaphoneFn('knight')).toBe('NT');
      expect(metaphoneFn('knight', 2)).toBe('NT');
    });
  });

  describe('doubleMetaphoneFn', () => {
    it('computes double metaphone codes', () => {
      expect(doubleMetaphoneFn('smith')).toEqual(['SM0', 'XMT']);
      expect(doubleMetaphoneFn('smith')).toHaveLength(2);
    });
  });

  describe('difference', () => {
    it('returns 0-4 soundex similarity', () => {
      expect(difference('abc', 'abc')).toBe(4);
      expect(difference('hello', 'help')).toBeGreaterThanOrEqual(0);
      expect(difference('hello', 'help')).toBeLessThanOrEqual(4);
    });
  });

  describe('diceCoefficient', () => {
    it('computes bigram similarity', () => {
      expect(diceCoefficient('a', 'a')).toBe(1);
      expect(diceCoefficient('night', 'nacht')).toBeCloseTo(0.25, 5);
    });
    it('returns 0 (not null) for empty inputs', () => {
      expect(diceCoefficient('', '')).toBe(0);
      expect(diceCoefficient('', 'abc')).toBe(0);
      expect(diceCoefficient('abc', '')).toBe(0);
    });
  });

  describe('detectFuzzyMatch', () => {
    it('detects direct and qualified calls', () => {
      expect(detectFuzzyMatch("SELECT levenshtein('cat','dog')")).toBe(true);
      expect(detectFuzzyMatch("SELECT public.soundex('cat')")).toBe(true);
      expect(detectFuzzyMatch("SELECT dice_coefficient('a','b')")).toBe(true);
      expect(detectFuzzyMatch("SELECT double_metaphone('smith')")).toBe(true);
    });
    it('returns false when no fuzzy function', () => {
      expect(detectFuzzyMatch('SELECT 1')).toBe(false);
      expect(detectFuzzyMatch('SELECT upper(name) FROM t')).toBe(false);
    });
    it('does NOT match inside string literals', () => {
      expect(detectFuzzyMatch("SELECT 'levenshtein(a,b)'")).toBe(false);
      expect(detectFuzzyMatch("SELECT 'dice_coefficient'")).toBe(false);
    });
    it('does NOT match inside comments', () => {
      expect(detectFuzzyMatch('-- levenshtein(a,b)\nSELECT 1')).toBe(false);
      expect(detectFuzzyMatch('/* soundex(x) */ SELECT 1')).toBe(false);
    });
    it('does NOT match a bare word without call parens', () => {
      expect(detectFuzzyMatch('SELECT levenshtein FROM t')).toBe(false);
    });
    it('does NOT match dicecoefficient (missing underscore)', () => {
      // `dice_coefficient` must not be confused with a hypothetical `dicecoefficient`.
      expect(detectFuzzyMatch("SELECT dicecoefficient('a','b')")).toBe(false);
    });
    it('is stateless across repeated calls', () => {
      expect(detectFuzzyMatch("SELECT levenshtein('a','b')")).toBe(true);
      expect(detectFuzzyMatch('SELECT 1')).toBe(false);
      expect(detectFuzzyMatch("SELECT levenshtein('a','b')")).toBe(true);
    });
    it('returns false for empty / non-string', () => {
      expect(detectFuzzyMatch('')).toBe(false);
      expect(detectFuzzyMatch(null as any)).toBe(false);
      expect(detectFuzzyMatch(undefined as any)).toBe(false);
      expect(detectFuzzyMatch(42 as any)).toBe(false);
    });
  });

  describe('rewriteFuzzyMatch', () => {
    it('passes through when no match', () => {
      expect(rewriteFuzzyMatch('SELECT 1')).toEqual({ found: false, rewritten: 'SELECT 1' });
    });
    it('passes through when match (no rewrite needed)', () => {
      expect(rewriteFuzzyMatch("SELECT levenshtein('a','b')")).toEqual({
        found: true,
        rewritten: "SELECT levenshtein('a','b')",
      });
    });
  });

  describe('catalog metadata', () => {
    it('lists all six functions', () => {
      const names = FUZZYSTRMATCH_FUNCTIONS.map((f) => f.name).sort();
      expect(names).toEqual([
        'dice_coefficient', 'difference', 'double_metaphone',
        'levenshtein', 'metaphone', 'soundex',
      ]);
    });
    it('maps every function name to an implementation', () => {
      for (const f of FUZZYSTRMATCH_FUNCTIONS) {
        expect(FUZZYSTRMATCH_FN_MAP[f.name]).toBeTypeOf('function');
      }
    });
  });

  describe('registerFuzzyFunctions', () => {
    function makeDb() {
      const fns: Record<string, [any, Function]> = {};
      const db = {
        function(name: string, opts: any, fn: Function) {
          fns[name] = [opts, fn];
        },
      };
      return { db, fns };
    }

    it('registers all six functions', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      expect(Object.keys(fns).sort()).toEqual([
        'dice_coefficient', 'difference', 'double_metaphone',
        'levenshtein', 'metaphone', 'soundex',
      ]);
    });

    it('does nothing when db.function is missing', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      registerFuzzyFunctions({});
      registerFuzzyFunctions(null);
      warn.mockRestore();
    });

    it('2-arg levenshtein dispatches to standard distance', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      const fn = fns['levenshtein'][1];
      expect(fn('kitten', 'sitting')).toBe(3);
    });

    it('5-arg levenshtein dispatches to custom-cost distance', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      const fn = fns['levenshtein'][1];
      // standard (ins=1, del=1, sub=1): kitten→sitting = 3
      expect(fn('kitten', 'sitting', 1, 1, 1)).toBe(3);
      // insertion cost of 2 makes the edit distance double for a 1-char insert
      expect(fn('ab', 'abc', 2, 1, 1)).toBe(2);
      // deletion cost of 5 dominates: abc→ab removes 'c' at cost 5
      expect(fn('abc', 'ab', 1, 5, 1)).toBe(5);
      // substitution cost of 99 makes replace far worse than del+ins
      expect(fn('abc', 'abd', 1, 1, 99)).toBe(2);
    });

    it('metaphone with maxLen', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      expect(fns['metaphone'][1]('knight')).toBe('NT');
    });

    it('soundex/difference/double_metaphone/dice round-trip', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      expect(fns['soundex'][1]('hello')).toBe('H400');
      expect(fns['double_metaphone'][1]('smith')).toEqual(['SM0', 'XMT']);
      expect(fns['dice_coefficient'][1]('a', 'a')).toBe(1);
      expect(fns['difference'][1]('abc', 'abc')).toBe(4);
    });

    it('coerces null/undefined args to empty string', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      expect(fns['soundex'][1](null)).toBe(soundexFn(''));
      expect(fns['levenshtein'][1](null, 'abc')).toBe(3);
      expect(fns['levenshtein'][1](null, null)).toBe(0);
      expect(fns['dice_coefficient'][1](null, null)).toBe(0);
      expect(fns['difference'][1](null, null)).toBe(3); // '' vs '' → '000' vs '000'
      expect(fns['double_metaphone'][1](null)).toEqual(['', '']);
      expect(fns['metaphone'][1](null)).toBe('');
    });

    it('metaphone with explicit maxLen (non-null branch)', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      expect(fns['metaphone'][1]('knight', 2)).toBe('NT');
      expect(fns['metaphone'][1]('knight', undefined)).toBe(metaphoneFn('knight'));
    });

    it('levenshtein with partial cost args defaults missing weights to 1', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      // ins=2 provided, del/sub default to 1 (no NaN).
      expect(fns['levenshtein'][1]('ab', 'abc', 2)).toBe(2);
    });

    it('levenshtein with null cost args defaults weights to 1 (full 5-arg null)', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      // ins=null but del/sub provided → custom path with ins defaulted to 1.
      expect(fns['levenshtein'][1]('ab', 'abc', null, 1, 1)).toBe(1);
    });

    it('levenshtein custom path coerces null string args to empty', () => {
      const { db, fns } = makeDb();
      registerFuzzyFunctions(db);
      // a=null, b='abc', costs all 1 → distance 3.
      expect(fns['levenshtein'][1](null, 'abc', 1, 1, 1)).toBe(3);
      // b=null, a='abc', costs all 1 → distance 3.
      expect(fns['levenshtein'][1]('abc', null, 1, 1, 1)).toBe(3);
    });
  });
});
