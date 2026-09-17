import { describe, it, expect } from 'vitest';
import { ConstraintEvaluator } from '../constraint/ConstraintEvaluator';

const evalCheck = (expr: string, row: Record<string, unknown>): boolean =>
  new ConstraintEvaluator().evaluateCheck(expr, row);

// ─────────────────────────────────────────────────────────────
// ConstraintEvaluator — sandboxed CHECK expression evaluation.
// ─────────────────────────────────────────────────────────────
describe('ConstraintEvaluator.evaluateCheck', () => {
  describe('comparison operators', () => {
    it('evaluates > / < / >= / <= on numeric columns', () => {
      expect(evalCheck('price > 0', { price: 5 })).toBe(true);
      expect(evalCheck('price > 0', { price: -5 })).toBe(false);
      expect(evalCheck('price > 0', { price: 0 })).toBe(false);
      expect(evalCheck('price >= 0', { price: 0 })).toBe(true);
      expect(evalCheck('price < 10', { price: 5 })).toBe(true);
      expect(evalCheck('price <= 5', { price: 5 })).toBe(true);
    });

    it('evaluates equality and inequality', () => {
      expect(evalCheck('status = 1', { status: 1 })).toBe(true);
      expect(evalCheck('status = 1', { status: 2 })).toBe(false);
      expect(evalCheck("status <> 1", { status: 2 })).toBe(true);
      expect(evalCheck('status != 1', { status: 1 })).toBe(false);
    });

    it('compares strings', () => {
      expect(evalCheck("name = 'alice'", { name: 'alice' })).toBe(true);
      expect(evalCheck("name = 'alice'", { name: 'bob' })).toBe(false);
    });

    it('compares booleans', () => {
      expect(evalCheck('flag = true', { flag: true })).toBe(true);
      expect(evalCheck('flag = false', { flag: true })).toBe(false);
    });
  });

  describe('NULL three-valued logic', () => {
    it('treats NULL comparison as not-true (does not pass)', () => {
      // PostgreSQL: `NULL > 0` is NULL, which does not satisfy a CHECK.
      expect(evalCheck('price > 0', { price: null })).toBe(false);
      expect(evalCheck('price > 0', {})).toBe(false);
    });

    it('supports IS NULL / IS NOT NULL', () => {
      expect(evalCheck('deleted_at IS NULL', { deleted_at: null })).toBe(true);
      expect(evalCheck('deleted_at IS NULL', { deleted_at: 'x' })).toBe(false);
      expect(evalCheck('deleted_at IS NOT NULL', { deleted_at: 'x' })).toBe(true);
      expect(evalCheck('deleted_at IS NOT NULL', { deleted_at: null })).toBe(false);
    });

    it('treats NULL = NULL as not-true (SQL semantics)', () => {
      expect(evalCheck('a = b', { a: null, b: null })).toBe(false);
    });
  });

  describe('logical operators', () => {
    it('evaluates AND', () => {
      expect(evalCheck('a > 0 AND b > 0', { a: 1, b: 2 })).toBe(true);
      expect(evalCheck('a > 0 AND b > 0', { a: 1, b: -2 })).toBe(false);
      expect(evalCheck('a > 0 AND b > 0', { a: -1, b: 2 })).toBe(false);
    });

    it('evaluates OR', () => {
      expect(evalCheck('a > 0 OR b > 0', { a: -1, b: -2 })).toBe(false);
      expect(evalCheck('a > 0 OR b > 0', { a: -1, b: 2 })).toBe(true);
    });

    it('evaluates NOT', () => {
      expect(evalCheck('NOT (a > 0)', { a: -1 })).toBe(true);
      expect(evalCheck('NOT (a > 0)', { a: 1 })).toBe(false);
    });

    it('honors short-circuit FALSE AND NULL → FALSE', () => {
      expect(evalCheck('a > 0 AND b > 0', { a: -1, b: null })).toBe(false);
    });
  });

  describe('IN / NOT IN', () => {
    it('evaluates IN with a list of literals', () => {
      expect(evalCheck('status IN (1, 2, 3)', { status: 2 })).toBe(true);
      expect(evalCheck('status IN (1, 2, 3)', { status: 4 })).toBe(false);
    });

    it('evaluates NOT IN', () => {
      expect(evalCheck('status NOT IN (1, 2, 3)', { status: 4 })).toBe(true);
      expect(evalCheck('status NOT IN (1, 2, 3)', { status: 2 })).toBe(false);
    });

    it('evaluates IN with string literals', () => {
      expect(evalCheck("status IN ('a','b')", { status: 'a' })).toBe(true);
      expect(evalCheck("status IN ('a','b')", { status: 'c' })).toBe(false);
    });
  });

  describe('arithmetic in expressions', () => {
    it('evaluates arithmetic before comparison', () => {
      expect(evalCheck('a + b > 5', { a: 3, b: 4 })).toBe(true);
      expect(evalCheck('a + b > 5', { a: 1, b: 1 })).toBe(false);
    });

    it('evaluates subtraction / multiplication / division', () => {
      expect(evalCheck('a - b = 1', { a: 5, b: 4 })).toBe(true);
      expect(evalCheck('a * b = 6', { a: 2, b: 3 })).toBe(true);
      expect(evalCheck('a / b = 2', { a: 6, b: 3 })).toBe(true);
    });

    it('treats division by zero as NULL (not satisfied)', () => {
      expect(evalCheck('a / b > 0', { a: 6, b: 0 })).toBe(false);
    });
  });

  describe('qualified column references', () => {
    it('strips table qualifier from `t.col`', () => {
      expect(evalCheck('t.price > 0', { price: 5 })).toBe(true);
      expect(evalCheck('t.price > 0', { price: -1 })).toBe(false);
    });

    it('returns not-true for a missing column', () => {
      expect(evalCheck('missing_col > 0', { price: 5 })).toBe(false);
    });
  });

  describe('literal types', () => {
    it('evaluates float/numeric literals', () => {
      expect(evalCheck('x > 1.5', { x: 2 })).toBe(true);
      expect(evalCheck('x > 1.5', { x: 1 })).toBe(false);
      expect(evalCheck('x = 1.5', { x: 1.5 })).toBe(true);
    });

    it('evaluates NULL literal', () => {
      expect(evalCheck('x = NULL', { x: 5 })).toBe(false);
    });
  });

  describe('unary arithmetic', () => {
    it('evaluates unary minus and plus', () => {
      expect(evalCheck('-a = -5', { a: 5 })).toBe(true);
      expect(evalCheck('+a = 5', { a: 5 })).toBe(true);
      expect(evalCheck('-a > 0', { a: -5 })).toBe(true);
    });
  });

  describe('IS TRUE / IS FALSE', () => {
    it('evaluates IS TRUE and IS FALSE', () => {
      expect(evalCheck('flag IS TRUE', { flag: true })).toBe(true);
      expect(evalCheck('flag IS TRUE', { flag: false })).toBe(false);
      expect(evalCheck('flag IS FALSE', { flag: false })).toBe(true);
      expect(evalCheck('flag IS FALSE', { flag: true })).toBe(false);
    });
  });

  describe('string concatenation and pattern matching', () => {
    it('evaluates string concatenation ||', () => {
      expect(evalCheck("a || b = 'ab'", { a: 'a', b: 'b' })).toBe(true);
      expect(evalCheck("a || b = 'ab'", { a: 'x', b: 'y' })).toBe(false);
    });

    it('evaluates ILIKE (case-insensitive)', () => {
      expect(evalCheck("name ILIKE 'alice'", { name: 'ALICE' })).toBe(true);
      expect(evalCheck("name ILIKE 'alice'", { name: 'bob' })).toBe(false);
    });

    it('evaluates NOT LIKE', () => {
      expect(evalCheck("name NOT LIKE 'a%'", { name: 'bob' })).toBe(true);
      expect(evalCheck("name NOT LIKE 'a%'", { name: 'alice' })).toBe(false);
    });
  });

  describe('cast', () => {
    it('evaluates through a CAST to the inner value', () => {
      expect(evalCheck('CAST(x AS int) > 0', { x: 5 })).toBe(true);
      expect(evalCheck('CAST(x AS int) > 0', { x: -5 })).toBe(false);
    });
  });

  describe('IN with NULL elements', () => {
    it('yields NULL (not-true) when the list contains NULL and the value is absent', () => {
      expect(evalCheck('a IN (1, NULL)', { a: 5 })).toBe(false);
    });
  });

  describe('division and modulo', () => {
    it('evaluates modulo', () => {
      expect(evalCheck('a % 2 = 1', { a: 5 })).toBe(true);
      expect(evalCheck('a % 2 = 0', { a: 5 })).toBe(false);
    });

    it('treats modulo by zero as NULL', () => {
      expect(evalCheck('a % 0 = 0', { a: 5 })).toBe(false);
    });
  });

  describe('string comparison fallback', () => {
    it('compares non-numeric values lexicographically', () => {
      expect(evalCheck("name < 'b'", { name: 'a' })).toBe(true);
      expect(evalCheck("name < 'b'", { name: 'c' })).toBe(false);
      expect(evalCheck("name > 'b'", { name: 'c' })).toBe(true);
      expect(evalCheck("name <= 'b'", { name: 'a' })).toBe(true);
      expect(evalCheck("name >= 'b'", { name: 'c' })).toBe(true);
    });
  });

  describe('boolean literals as CHECK expressions', () => {
    it('evaluates true / false literals', () => {
      expect(evalCheck('true', {})).toBe(true);
      expect(evalCheck('false', {})).toBe(false);
    });
  });

  describe('NOT ILIKE', () => {
    it('evaluates NOT ILIKE (case-insensitive negation)', () => {
      expect(evalCheck("name NOT ILIKE 'alice'", { name: 'bob' })).toBe(true);
      expect(evalCheck("name NOT ILIKE 'alice'", { name: 'ALICE' })).toBe(false);
    });
  });

  describe('IN list with explicit NULL element', () => {
    it('yields NULL (not-true) when value matches NULL only', () => {
      // `a IN (NULL)` → NULL regardless of `a` → does not satisfy CHECK.
      expect(evalCheck('a IN (NULL)', { a: 5 })).toBe(false);
      expect(evalCheck('a IN (NULL)', { a: null })).toBe(false);
    });

    it('yields NULL for NOT IN when the list contains NULL (value absent)', () => {
      // `5 NOT IN (1, NULL)` → NULL (unknown), does not satisfy CHECK.
      expect(evalCheck('a NOT IN (1, NULL)', { a: 5 })).toBe(false);
    });
  });

  describe('string concatenation with NULL', () => {
    it('yields NULL when either operand is NULL', () => {
      expect(evalCheck("a || b = 'x'", { a: null, b: 'y' })).toBe(false);
      expect(evalCheck("a || b = 'x'", { a: 'x', b: null })).toBe(false);
    });
  });

  describe('arithmetic with NULL operand', () => {
    it('treats division by NULL as NULL', () => {
      expect(evalCheck('a / b > 0', { a: 6, b: null })).toBe(false);
    });
  });

  describe('BETWEEN', () => {
    it('evaluates BETWEEN', () => {
      expect(evalCheck('age BETWEEN 18 AND 65', { age: 30 })).toBe(true);
      expect(evalCheck('age BETWEEN 18 AND 65', { age: 10 })).toBe(false);
      expect(evalCheck('age NOT BETWEEN 18 AND 65', { age: 10 })).toBe(true);
    });
  });

  describe('LIKE', () => {
    it('evaluates LIKE with wildcards', () => {
      expect(evalCheck("name LIKE 'a%'", { name: 'alice' })).toBe(true);
      expect(evalCheck("name LIKE 'a%'", { name: 'bob' })).toBe(false);
      expect(evalCheck("name LIKE '_ob'", { name: 'bob' })).toBe(true);
    });
  });

  describe('empty / unparseable expressions', () => {
    it('treats empty expression as satisfied', () => {
      expect(evalCheck('', {})).toBe(true);
      expect(evalCheck('   ', {})).toBe(true);
    });

    it('treats unparseable expression as not satisfied', () => {
      expect(evalCheck(';;;not sql;;;', {})).toBe(false);
    });
  });

  describe('no arbitrary code execution (sandboxed purity)', () => {
    it('does not execute object property access as code', () => {
      const row = { constructor: 'x', a: 1 };
      // A column named `constructor` is just a value; no prototype pollution.
      expect(evalCheck('a > 0', row)).toBe(true);
    });

    it('is not affected by a poisoned __proto__ key', () => {
      const row = Object.create(null) as Record<string, unknown>;
      row.a = 5;
      expect(evalCheck('a = 5', row)).toBe(true);
    });
  });

  describe('scalar function calls', () => {
    it('evaluates length()', () => {
      expect(evalCheck('length(name) > 0', { name: 'abc' })).toBe(true);
      expect(evalCheck('length(name) > 3', { name: 'abc' })).toBe(false);
    });

    it('evaluates lower() / upper()', () => {
      expect(evalCheck("lower(name) = 'abc'", { name: 'ABC' })).toBe(true);
      expect(evalCheck("upper(name) = 'ABC'", { name: 'abc' })).toBe(true);
    });

    it('evaluates trim()', () => {
      expect(evalCheck("trim(name) = 'abc'", { name: '  abc  ' })).toBe(true);
    });

    it('evaluates abs()', () => {
      expect(evalCheck('abs(x) = 5', { x: -5 })).toBe(true);
      expect(evalCheck('abs(x) > 5', { x: 5 })).toBe(false);
    });

    it('evaluates coalesce()', () => {
      expect(evalCheck('coalesce(a, 0) = 0', { a: null })).toBe(true);
      expect(evalCheck('coalesce(a, 0) = 5', { a: 5 })).toBe(true);
    });

    it('evaluates coalesce() to NULL when all arguments are NULL', () => {
      expect(evalCheck('coalesce(a, b) IS NULL', { a: null, b: null })).toBe(true);
    });

    it('evaluates greatest() / least()', () => {
      expect(evalCheck('greatest(a, b) = 5', { a: 5, b: 3 })).toBe(true);
      expect(evalCheck('least(a, b) = 3', { a: 5, b: 3 })).toBe(true);
    });

    it('evaluates greatest() / least() on string arguments', () => {
      expect(evalCheck("greatest(a, b) = 'z'", { a: 'a', b: 'z' })).toBe(true);
      expect(evalCheck("least(a, b) = 'a'", { a: 'a', b: 'z' })).toBe(true);
    });

    it('evaluates nullif()', () => {
      expect(evalCheck('nullif(a, 0) IS NULL', { a: 0 })).toBe(true);
      expect(evalCheck('nullif(a, 0) = 5', { a: 5 })).toBe(true);
    });

    it('treats a NULL argument to a function as NULL', () => {
      expect(evalCheck('length(name) IS NULL', { name: null })).toBe(true);
    });

    it('refuses to evaluate an unknown function (returns NULL)', () => {
      expect(evalCheck('evil_func(1) IS NULL', {})).toBe(true);
    });
  });

  describe('CASE expressions', () => {
    it('evaluates a searched CASE', () => {
      expect(evalCheck('CASE WHEN a > 0 THEN 1 ELSE 0 END > 0', { a: 5 })).toBe(true);
      expect(evalCheck('CASE WHEN a > 0 THEN 1 ELSE 0 END > 0', { a: -5 })).toBe(false);
    });

    it('evaluates a simple CASE', () => {
      expect(evalCheck("CASE status WHEN 1 THEN 'a' WHEN 2 THEN 'b' END = 'b'", { status: 2 })).toBe(true);
      expect(evalCheck("CASE status WHEN 1 THEN 'a' WHEN 2 THEN 'b' END = 'b'", { status: 1 })).toBe(false);
    });

    it('falls through to ELSE when no branch matches', () => {
      expect(evalCheck('CASE WHEN a > 10 THEN 1 ELSE 0 END = 0', { a: 5 })).toBe(true);
    });
  });

  describe('IS NOT TRUE / IS NOT FALSE', () => {
    it('evaluates IS NOT TRUE and IS NOT FALSE', () => {
      expect(evalCheck('flag IS NOT TRUE', { flag: false })).toBe(true);
      expect(evalCheck('flag IS NOT TRUE', { flag: true })).toBe(false);
      expect(evalCheck('flag IS NOT FALSE', { flag: true })).toBe(true);
      expect(evalCheck('flag IS NOT FALSE', { flag: false })).toBe(false);
    });
  });

  describe('boundary NULL handling across operators', () => {
    it('treats BETWEEN with NULL bounds as NULL', () => {
      expect(evalCheck('age BETWEEN 18 AND NULL', { age: 30 })).toBe(false);
      expect(evalCheck('age BETWEEN NULL AND 65', { age: 30 })).toBe(false);
      expect(evalCheck('age NOT BETWEEN 18 AND NULL', { age: 30 })).toBe(false);
    });

    it('treats NOT BETWEEN when the value is inside the range', () => {
      expect(evalCheck('age NOT BETWEEN 18 AND 65', { age: 30 })).toBe(false);
    });

    it('treats NOT of NULL as NULL', () => {
      expect(evalCheck('NOT (x > 0)', { x: null })).toBe(false);
    });

    it('treats unary minus of NULL as NULL', () => {
      expect(evalCheck('-x > 0', { x: null })).toBe(false);
    });

    it('treats unary plus of a value as itself', () => {
      expect(evalCheck('+x = 5', { x: 5 })).toBe(true);
    });

    it('treats IN with a scalar (non-list) right side', () => {
      // `a IN (1)` parses with a list, but a single column reference would not.
      expect(evalCheck('a IN (1)', { a: 1 })).toBe(true);
    });

    it('treats NOT IN with a NULL left operand as NULL', () => {
      expect(evalCheck('a NOT IN (1, 2)', { a: null })).toBe(false);
    });

    it('treats LIKE with a NULL pattern as not-matching', () => {
      expect(evalCheck('name LIKE NULL', { name: 'x' })).toBe(false);
      expect(evalCheck('name ILIKE NULL', { name: 'x' })).toBe(false);
      expect(evalCheck('name NOT LIKE NULL', { name: 'x' })).toBe(false);
      expect(evalCheck('name NOT ILIKE NULL', { name: 'x' })).toBe(false);
    });

    it('treats a NULL right operand in comparison as NULL', () => {
      expect(evalCheck('a > NULL', { a: 5 })).toBe(false);
      expect(evalCheck('a = NULL', { a: 5 })).toBe(false);
      expect(evalCheck('a AND NULL', { a: true })).toBe(false);
      expect(evalCheck('a OR NULL', { a: false })).toBe(false);
    });

    it('treats an IN subquery as unsupported (NULL)', () => {
      expect(evalCheck('a IN (SELECT 1)', { a: 1 })).toBe(false);
    });
  });

  describe('edge cases in scalar functions', () => {
    it('treats NULL arguments to string functions as NULL', () => {
      expect(evalCheck('lower(name) IS NULL', { name: null })).toBe(true);
      expect(evalCheck('upper(name) IS NULL', { name: null })).toBe(true);
      expect(evalCheck('trim(name) IS NULL', { name: null })).toBe(true);
      expect(evalCheck('abs(x) IS NULL', { x: null })).toBe(true);
    });

    it('treats nullif with a single argument as NULL', () => {
      expect(evalCheck('nullif(a) IS NULL', { a: 0 })).toBe(true);
    });

    it('treats greatest/least with all NULL args as NULL', () => {
      expect(evalCheck('greatest(a, b) IS NULL', { a: null, b: null })).toBe(true);
      expect(evalCheck('least(a, b) IS NULL', { a: null, b: null })).toBe(true);
    });

    it('handles greatest/least with equal numeric values', () => {
      expect(evalCheck('greatest(a, b) = 5', { a: 5, b: 5 })).toBe(true);
      expect(evalCheck('least(a, b) = 5', { a: 5, b: 5 })).toBe(true);
    });

    it('handles greatest/least with equal string values', () => {
      expect(evalCheck("greatest(a, b) = 'x'", { a: 'x', b: 'x' })).toBe(true);
      expect(evalCheck("least(a, b) = 'x'", { a: 'x', b: 'x' })).toBe(true);
    });

    it('treats a range reference like * as NULL', () => {
      // A bare `*` is not a concrete column value.
      expect(evalCheck('* = 1', { a: 1 })).toBe(false);
    });
  });

  describe('CASE edge cases', () => {
    it('returns NULL for a CASE with no ELSE and no match', () => {
      expect(evalCheck('CASE WHEN a > 10 THEN 1 END IS NULL', { a: 5 })).toBe(true);
    });

    it('handles a simple CASE with no match and no ELSE', () => {
      expect(evalCheck('CASE status WHEN 1 THEN 1 END IS NULL', { status: 2 })).toBe(true);
    });
  });

  describe('numeric conversion edge cases', () => {
    it('treats boolean values in arithmetic', () => {
      expect(evalCheck('a + 1 = 2', { a: true })).toBe(true);
      expect(evalCheck('a + 1 = 2', { a: false })).toBe(false);
    });

    it('treats NaN-producing conversion as NULL', () => {
      expect(evalCheck("a + 1 > 0", { a: 'not-a-number' })).toBe(false);
    });

    it('handles BigInt column values in arithmetic', () => {
      expect(evalCheck('a + 1 = 6', { a: 5n })).toBe(true);
    });

    it('treats a non-numeric string operand as NULL in arithmetic', () => {
      expect(evalCheck("a + 1 > 0", { a: 'abc' })).toBe(false);
    });
  });
});
