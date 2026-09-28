import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectCheckExtension,
  rewriteCheckConstraint,
  extractCheckExpression,
  addConstraint,
  removeConstraints,
  getConstraints,
  onInsert,
  onUpdate,
  loadFromDB,
} from '../query/CheckConstraintShim';

describe('detectCheckExtension', () => {
  it('returns false for empty or non-string input', () => {
    expect(detectCheckExtension('')).toBe(false);
    expect(detectCheckExtension(null as unknown as string)).toBe(false);
    expect(detectCheckExtension(42 as unknown as string)).toBe(false);
  });

  it('detects NO INHERIT', () => {
    expect(detectCheckExtension('... NO INHERIT ...')).toBe(true);
  });

  it('detects NOT VALID', () => {
    expect(detectCheckExtension('... NOT VALID ...')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectCheckExtension('no inherit')).toBe(true);
    expect(detectCheckExtension('Not Valid')).toBe(true);
  });

  it('returns false when no PG modifier is present', () => {
    expect(detectCheckExtension('SELECT 1')).toBe(false);
    expect(detectCheckExtension('CHECK (a > 0)')).toBe(false);
  });
});

describe('rewriteCheckConstraint', () => {
  it('returns unchanged for empty/non-string', () => {
    expect(rewriteCheckConstraint('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteCheckConstraint(null as unknown as string)).toEqual({ sql: null, rewritten: false });
  });

  it('returns unchanged when no modifier present', () => {
    expect(rewriteCheckConstraint('CHECK (a>0)')).toEqual({ sql: 'CHECK (a>0)', rewritten: false });
  });

  it('strips NO INHERIT', () => {
    expect(rewriteCheckConstraint('CHECK (a>0) NO INHERIT')).toEqual({
      sql: 'CHECK (a>0)',
      rewritten: true,
    });
  });

  it('strips NOT VALID', () => {
    expect(rewriteCheckConstraint('CHECK (a>0) NOT VALID')).toEqual({
      sql: 'CHECK (a>0)',
      rewritten: true,
    });
  });

  it('strips both modifiers and collapses runs of whitespace', () => {
    expect(rewriteCheckConstraint('CONSTRAINT c CHECK (a>0) NO INHERIT  NOT VALID')).toEqual({
      sql: 'CONSTRAINT c CHECK (a>0)',
      rewritten: true,
    });
  });
});

describe('extractCheckExpression', () => {
  it('returns null for empty or non-string input', () => {
    expect(extractCheckExpression('')).toBeNull();
    expect(extractCheckExpression(null as unknown as string)).toBeNull();
  });

  it('returns null when no CHECK ( clause is present', () => {
    expect(extractCheckExpression('SELECT 1')).toBeNull();
  });

  it('extracts a simple expression', () => {
    expect(extractCheckExpression('CHECK (price > 0)')).toBe('price > 0');
  });

  it('extracts a nested parenthesized expression', () => {
    expect(extractCheckExpression('CHECK ((a > 0) AND (b < 10))')).toBe('(a > 0) AND (b < 10)');
  });

  it('handles an opening parenthesis inside a string literal', () => {
    expect(extractCheckExpression("CHECK (col = '(')")).toBe("col = '('");
  });

  it('handles a closing parenthesis inside a string literal', () => {
    expect(extractCheckExpression("CHECK (a IN ('x))'))")).toBe("a IN ('x))')");
  });

  it('handles doubled single quotes inside a literal', () => {
    expect(extractCheckExpression("CHECK (name = 'O''Brien')")).toBe("name = 'O''Brien'");
  });

  it('handles a double-quoted identifier containing a parenthesis', () => {
    expect(extractCheckExpression('CHECK ("col(x" > 0)')).toBe('"col(x" > 0');
  });

  it('returns null for an empty expression', () => {
    expect(extractCheckExpression('CHECK ()')).toBeNull();
    expect(extractCheckExpression('CHECK (   )')).toBeNull();
  });

  it('returns null for an unterminated CHECK clause', () => {
    expect(extractCheckExpression('CHECK (a > 0')).toBeNull();
  });
});

describe('constraint registry (getConstraints / addConstraint / removeConstraints)', () => {
  beforeEach(async () => {
    await removeConstraints('products');
    await removeConstraints('orders');
  });

  it('returns empty when no constraints are registered', () => {
    expect(getConstraints('products')).toEqual([]);
  });

  it('registers and returns constraints for a table (case-insensitive)', () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    const defs = getConstraints('PRODUCTS');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('price_gt_0');
    expect(defs[0].expression).toBe('price > 0');
  });

  it('does not return constraints from other tables', async () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    addConstraint({ name: 'qty_gt_0', table: 'orders', expression: 'qty > 0' });
    expect(getConstraints('products')).toHaveLength(1);
    expect(getConstraints('orders')).toHaveLength(1);
    await removeConstraints('products');
    expect(getConstraints('products')).toHaveLength(0);
    expect(getConstraints('orders')).toHaveLength(1);
  });

  it('removes constraints by table prefix', async () => {
    addConstraint({ name: 'a', table: 'products', expression: 'a > 0' });
    addConstraint({ name: 'b', table: 'products', expression: 'b > 0' });
    await removeConstraints('products');
    expect(getConstraints('products')).toEqual([]);
  });
});

describe('onInsert / onUpdate (constraint enforcement)', () => {
  beforeEach(async () => {
    await removeConstraints('products');
  });

  it('passes when no constraint is registered', async () => {
    await expect(onInsert('products', { price: -1 })).resolves.toBeUndefined();
    await expect(onUpdate('products', { price: -1 }, {})).resolves.toBeUndefined();
  });

  it('passes when the row satisfies the constraint', async () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    await expect(onInsert('products', { price: 5 })).resolves.toBeUndefined();
  });

  it('throws when the row violates the constraint on INSERT', async () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    await expect(onInsert('products', { price: -5 })).rejects.toThrow(/violates check constraint "price_gt_0"/);
  });

  it('throws when the row violates the constraint on UPDATE', async () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    await expect(onUpdate('products', { price: -5 }, { price: 10 })).rejects.toThrow(/violates check constraint/);
  });

  it('passes on UPDATE when the row satisfies the constraint', async () => {
    addConstraint({ name: 'price_gt_0', table: 'products', expression: 'price > 0' });
    await expect(onUpdate('products', { price: 5 }, { price: 10 })).resolves.toBeUndefined();
  });

  it('passes by default when the expression is empty', async () => {
    addConstraint({ name: 'empty', table: 'products', expression: '   ' });
    await expect(onInsert('products', { price: -1 })).resolves.toBeUndefined();
  });
});

describe('persistence via queryFn', () => {
  let executed: string[];

  beforeEach(async () => {
    executed = [];
    await removeConstraints('products');
    await removeConstraints('orders');
  });

  it('addConstraint writes via queryFn and escapes single quotes', async () => {
    const queryFn = async (sql: string) => {
      executed.push(sql);
      return { rows: [] };
    };
    await addConstraint(
      { name: "O'Brien", table: 'products', expression: "name = 'O''Brien'" },
      queryFn,
    );
    // The INSERT must have single quotes doubled for the name "O'Brien".
    const insert = executed.find((s) => s.includes('INSERT OR REPLACE'));
    expect(insert).toBeDefined();
    expect(insert).toContain("'O''Brien'");
  });

  it('removeConstraints writes via queryFn when provided', async () => {
    addConstraint({ name: 'a', table: 'products', expression: 'a > 0' });
    const queryFn = async (sql: string) => {
      executed.push(sql);
      return { rows: [] };
    };
    await removeConstraints('products', queryFn);
    expect(executed.some((s) => s.includes('DELETE FROM __check_constraints'))).toBe(true);
    expect(getConstraints('products')).toEqual([]);
  });
});

describe('loadFromDB', () => {
  beforeEach(async () => {
    await removeConstraints('products');
  });

  it('loads constraint definitions from an array result', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [
          { name: 'price_gt_0', table_name: 'products', expression: 'price > 0' },
          { name: 'qty_gt_0', table_name: 'products', expression: 'qty > 0' },
        ];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')).toHaveLength(2);
  });

  it('loads constraint definitions from a { rows } result', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [{ name: 'a', table_name: 'products', expression: 'a > 0' }] };
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')).toHaveLength(1);
  });

  it('swallows errors from a failing query', async () => {
    const queryFn = async () => {
      throw new Error('db down');
    };
    await expect(loadFromDB(queryFn)).resolves.toBeUndefined();
  });

  it('handles array-tuple rows', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [['price_gt_0', 'products', 'price > 0']];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    const defs = getConstraints('products');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('price_gt_0');
  });

  it('handles a result that is neither an array nor has rows', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { unexpected: 'shape' };
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    // No rows match any known shape, so nothing is registered.
    expect(getConstraints('products')).toEqual([]);
  });

  it('defaults expression to empty string when absent from the row', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [['nameless', 'products', undefined]];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    const defs = getConstraints('products');
    expect(defs).toHaveLength(1);
    expect(defs[0].expression).toBe('');
  });
});
