import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectUniqueExtension,
  rewriteUniqueConstraint,
  extractUniqueConstraints,
  addConstraint,
  removeConstraints,
  getConstraints,
  onInsert,
  onUpdate,
  loadFromDB,
} from '../query/UniqueConstraintShim';

describe('detectUniqueExtension', () => {
  it('returns false for empty or non-string input', () => {
    expect(detectUniqueExtension('')).toBe(false);
    expect(detectUniqueExtension(null as unknown as string)).toBe(false);
    expect(detectUniqueExtension(42 as unknown as string)).toBe(false);
  });

  it('returns false when no UNIQUE keyword present', () => {
    expect(detectUniqueExtension('SELECT 1')).toBe(false);
  });

  it('returns false for a plain UNIQUE with no PG extension', () => {
    expect(detectUniqueExtension('CREATE TABLE t (a INT UNIQUE)')).toBe(false);
    expect(detectUniqueExtension('CREATE TABLE t (UNIQUE (a, b))')).toBe(false);
  });

  it('detects NULLS NOT DISTINCT', () => {
    expect(detectUniqueExtension('CREATE TABLE t (a INT UNIQUE NULLS NOT DISTINCT)')).toBe(true);
  });

  it('detects DEFERRABLE', () => {
    expect(detectUniqueExtension('UNIQUE (a) DEFERRABLE')).toBe(true);
  });

  it('detects INITIALLY DEFERRED', () => {
    expect(detectUniqueExtension('UNIQUE (a) INITIALLY DEFERRED')).toBe(true);
  });

  it('detects USING INDEX TABLESPACE', () => {
    expect(detectUniqueExtension('UNIQUE (a) USING INDEX TABLESPACE ts')).toBe(true);
  });

  it('detects WITH options', () => {
    expect(detectUniqueExtension('UNIQUE (a) WITH (fillfactor=70)')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectUniqueExtension('UNIQUE (a) deferrable')).toBe(true);
  });

  it('does not misdetect extension keywords inside a string literal', () => {
    expect(detectUniqueExtension("INSERT INTO t VALUES ('UNIQUE then DEFERRABLE')")).toBe(false);
  });

  it('does not misdetect extension keywords inside a comment', () => {
    expect(detectUniqueExtension('-- UNIQUE DEFERRABLE\nSELECT 1')).toBe(false);
  });

  it('does not misdetect an extension that is not directly attached to UNIQUE', () => {
    // DEFERRABLE belongs to a different (unrelated) clause, not the UNIQUE.
    expect(detectUniqueExtension('UNIQUE (a) SOMETHING ELSE DEFERRABLE')).toBe(false);
  });
});

describe('rewriteUniqueConstraint', () => {
  it('returns unchanged for empty/non-string', () => {
    expect(rewriteUniqueConstraint('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteUniqueConstraint(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns unchanged for a plain UNIQUE with no extension', () => {
    expect(rewriteUniqueConstraint('CREATE TABLE t (UNIQUE (a, b))')).toEqual({
      sql: 'CREATE TABLE t (UNIQUE (a, b))',
      rewritten: false,
    });
  });

  it('strips DEFERRABLE from a table-level constraint', () => {
    expect(rewriteUniqueConstraint('CREATE TABLE t (a INT, UNIQUE (a) DEFERRABLE)')).toEqual({
      sql: 'CREATE TABLE t (a INT, UNIQUE (a))',
      rewritten: true,
      constraints: ['UNIQUE (a) DEFERRABLE'],
    });
  });

  it('strips NULLS NOT DISTINCT from an inline constraint', () => {
    expect(rewriteUniqueConstraint('CREATE TABLE t (a INT UNIQUE NULLS NOT DISTINCT)')).toEqual({
      sql: 'CREATE TABLE t (a INT UNIQUE)',
      rewritten: true,
      constraints: ['UNIQUE NULLS NOT DISTINCT'],
    });
  });

  it('strips multiple stacked extensions', () => {
    expect(rewriteUniqueConstraint('UNIQUE (a) DEFERRABLE INITIALLY DEFERRED')).toEqual({
      sql: 'UNIQUE (a)',
      rewritten: true,
      constraints: ['UNIQUE (a) DEFERRABLE INITIALLY DEFERRED'],
    });
  });

  it('strips USING INDEX TABLESPACE', () => {
    expect(rewriteUniqueConstraint('UNIQUE (a) USING INDEX TABLESPACE my_ts')).toEqual({
      sql: 'UNIQUE (a)',
      rewritten: true,
      constraints: ['UNIQUE (a) USING INDEX TABLESPACE my_ts'],
    });
  });

  it('strips WITH options', () => {
    expect(rewriteUniqueConstraint('UNIQUE (a) WITH (fillfactor=70)')).toEqual({
      sql: 'UNIQUE (a)',
      rewritten: true,
      constraints: ['UNIQUE (a) WITH (fillfactor=70)'],
    });
  });

  it('does not strip extension keywords inside a string literal', () => {
    expect(rewriteUniqueConstraint("CREATE TABLE t (a TEXT DEFAULT 'UNIQUE DEFERRABLE')")).toEqual({
      sql: "CREATE TABLE t (a TEXT DEFAULT 'UNIQUE DEFERRABLE')",
      rewritten: false,
    });
  });

  it('only strips the extension from the extended constraint when multiple exist', () => {
    const r = rewriteUniqueConstraint('CREATE TABLE t (a INT, b INT, UNIQUE (a), UNIQUE (b) DEFERRABLE)');
    expect(r.sql).toBe('CREATE TABLE t (a INT, b INT, UNIQUE (a), UNIQUE (b))');
    expect(r.rewritten).toBe(true);
  });
});

describe('extractUniqueConstraints', () => {
  it('returns undefined for empty or non-string input', () => {
    expect(extractUniqueConstraints('')).toBeUndefined();
    expect(extractUniqueConstraints(null as unknown as string)).toBeUndefined();
  });

  it('returns undefined when no UNIQUE constraint is present', () => {
    expect(extractUniqueConstraints('SELECT 1')).toBeUndefined();
  });

  it('extracts a table-level constraint with its extensions', () => {
    expect(extractUniqueConstraints('UNIQUE (a, b) NULLS NOT DISTINCT')).toEqual([
      'UNIQUE (a, b) NULLS NOT DISTINCT',
    ]);
  });

  it('extracts an inline constraint with its extensions', () => {
    expect(extractUniqueConstraints('a INT UNIQUE NULLS NOT DISTINCT INITIALLY DEFERRED')).toEqual([
      'UNIQUE NULLS NOT DISTINCT INITIALLY DEFERRED',
    ]);
  });

  it('extracts a named constraint', () => {
    expect(extractUniqueConstraints('CONSTRAINT u UNIQUE (a) DEFERRABLE')).toEqual([
      'CONSTRAINT u UNIQUE (a) DEFERRABLE',
    ]);
  });

  it('extracts a plain UNIQUE even without extensions', () => {
    expect(extractUniqueConstraints('UNIQUE (a)')).toEqual(['UNIQUE (a)']);
  });

  it('does not extract keywords inside a string literal', () => {
    expect(extractUniqueConstraints("DEFAULT 'UNIQUE DEFERRABLE'")).toBeUndefined();
  });
});

describe('constraint registry (getConstraints / addConstraint / removeConstraints)', () => {
  beforeEach(async () => {
    await removeConstraints('products');
    await removeConstraints('orders');
  });

  it('returns empty when no constraints registered', () => {
    expect(getConstraints('products')).toEqual([]);
  });

  it('registers and returns constraints (case-insensitive)', () => {
    addConstraint({ name: 'u_email', table: 'products', columns: ['email'], nullsNotDistinct: false });
    const defs = getConstraints('PRODUCTS');
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('u_email');
    expect(defs[0].columns).toEqual(['email']);
    expect(defs[0].nullsNotDistinct).toBe(false);
  });

  it('does not return constraints from other tables', async () => {
    addConstraint({ name: 'a', table: 'products', columns: ['a'], nullsNotDistinct: false });
    addConstraint({ name: 'b', table: 'orders', columns: ['b'], nullsNotDistinct: false });
    expect(getConstraints('products')).toHaveLength(1);
    expect(getConstraints('orders')).toHaveLength(1);
    await removeConstraints('products');
    expect(getConstraints('products')).toHaveLength(0);
    expect(getConstraints('orders')).toHaveLength(1);
  });

  it('removes all constraints for a table', async () => {
    addConstraint({ name: 'a', table: 'products', columns: ['a'], nullsNotDistinct: false });
    addConstraint({ name: 'b', table: 'products', columns: ['b'], nullsNotDistinct: false });
    await removeConstraints('products');
    expect(getConstraints('products')).toEqual([]);
  });
});

describe('onInsert / onUpdate (uniqueness enforcement)', () => {
  let executed: string[];

  beforeEach(async () => {
    executed = [];
    await removeConstraints('users');
  });

  const queryFn = async (sql: string) => {
    executed.push(sql);
    // Default: no duplicate row found.
    return { rows: [] };
  };

  it('passes when no constraint is registered', async () => {
    await expect(onInsert('users', ['email'], { email: 'a@b.c' }, queryFn)).resolves.toBeUndefined();
  });

  it('builds an equality WHERE clause for a non-null value', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onInsert('users', ['email'], { email: 'a@b.c' }, queryFn);
    expect(executed.some((s) => s.includes('"email" = \'a@b.c\''))).toBe(true);
  });

  it('builds a 1=0 predicate for a NULL value when NULLs are distinct', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onInsert('users', ['email'], { email: null }, queryFn);
    expect(executed.some((s) => s.includes('1=0'))).toBe(true);
  });

  it('builds an IS NULL predicate for NULL when nullsNotDistinct', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: true });
    await onInsert('users', ['email'], { email: null }, queryFn);
    expect(executed.some((s) => s.includes('"email" IS NULL'))).toBe(true);
  });

  it('throws when a duplicate row is found on INSERT', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    const dupFn = async (_sql: string) => ({ rows: [{ 1: 1 }] });
    await expect(onInsert('users', ['email'], { email: 'a@b.c' }, dupFn)).rejects.toThrow(
      /violates unique constraint "u_email"/,
    );
  });

  it('passes when a duplicate is absent on INSERT (array result)', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    const fn = async (_sql: string) => [];
    await expect(onInsert('users', ['email'], { email: 'a@b.c' }, fn)).resolves.toBeUndefined();
  });

  it('skips the check on UPDATE when no unique column changed', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onUpdate('users', ['email'], { email: 'a@b.c' }, { email: 'a@b.c' }, queryFn);
    // No SELECT was emitted because nothing changed.
    expect(executed).toHaveLength(0);
  });

  it('builds an exclusion clause on UPDATE', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onUpdate('users', ['email'], { email: 'new@b.c' }, { email: 'a@b.c' }, queryFn);
    expect(executed.some((s) => s.includes('AND NOT ('))).toBe(true);
    expect(executed.some((s) => s.includes('"email" = \'a@b.c\''))).toBe(true);
  });

  it('throws when a duplicate is found on UPDATE', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    const dupFn = async (_sql: string) => ({ rows: [{}] });
    await expect(
      onUpdate('users', ['email'], { email: 'new@b.c' }, { email: 'a@b.c' }, dupFn),
    ).rejects.toThrow(/violates unique constraint/);
  });

  it('escapes single quotes in values', async () => {
    addConstraint({ name: 'u_name', table: 'users', columns: ['name'], nullsNotDistinct: false });
    await onInsert('users', ['name'], { name: "O'Brien" }, queryFn);
    expect(executed.some((s) => s.includes("'O''Brien'"))).toBe(true);
  });

  it('serializes boolean and number values correctly', async () => {
    addConstraint({ name: 'u_flag', table: 'users', columns: ['flag', 'count'], nullsNotDistinct: false });
    await onInsert('users', ['flag', 'count'], { flag: true, count: 42 }, queryFn);
    expect(executed.some((s) => s.includes('"flag" = 1'))).toBe(true);
    expect(executed.some((s) => s.includes('"count" = 42'))).toBe(true);
  });

  it('serializes a false boolean as 0', async () => {
    addConstraint({ name: 'u_flag', table: 'users', columns: ['flag'], nullsNotDistinct: false });
    await onInsert('users', ['flag'], { flag: false }, queryFn);
    expect(executed.some((s) => s.includes('"flag" = 0'))).toBe(true);
  });

  it('builds IS NULL on UPDATE for a null value when nullsNotDistinct', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: true });
    await onUpdate('users', ['email'], { email: null }, { email: 'a@b.c' }, queryFn);
    expect(executed.some((s) => s.includes('"email" IS NULL'))).toBe(true);
  });

  it('builds 1=0 on UPDATE for a distinct NULL value', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onUpdate('users', ['email'], { email: null }, { email: 'a@b.c' }, queryFn);
    expect(executed.some((s) => s.includes('1=0'))).toBe(true);
  });

  it('builds IS NULL for a null old value in the UPDATE exclusion clause', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    await onUpdate('users', ['email'], { email: 'new@b.c' }, { email: null }, queryFn);
    expect(executed.some((s) => s.includes('NOT ("email" IS NULL)'))).toBe(true);
  });

  it('passes when the query returns no recognized rows', async () => {
    addConstraint({ name: 'u_email', table: 'users', columns: ['email'], nullsNotDistinct: false });
    const fn = async (_sql: string) => ({}); // no .rows, no array
    await expect(onInsert('users', ['email'], { email: 'a@b.c' }, fn)).resolves.toBeUndefined();
  });
});

describe('persistence via queryFn', () => {
  beforeEach(async () => {
    await removeConstraints('products');
  });

  it('addConstraint writes via queryFn and escapes single quotes', async () => {
    const executed: string[] = [];
    const queryFn = async (sql: string) => {
      executed.push(sql);
      return { rows: [] };
    };
    await addConstraint(
      { name: "O'Brien", table: 'products', columns: ['name'], nullsNotDistinct: true },
      queryFn,
    );
    const insert = executed.find((s) => s.includes('INSERT OR REPLACE'));
    expect(insert).toBeDefined();
    expect(insert).toContain("'O''Brien'");
    expect(insert).toContain('nulls_not_distinct');
  });

  it('addConstraint writes 0 for a non-nullsNotDistinct constraint', async () => {
    const executed: string[] = [];
    const queryFn = async (sql: string) => {
      executed.push(sql);
      return { rows: [] };
    };
    await addConstraint(
      { name: 'u_a', table: 'products', columns: ['a'], nullsNotDistinct: false },
      queryFn,
    );
    const insert = executed.find((s) => s.includes('INSERT OR REPLACE'));
    expect(insert).toBeDefined();
    expect(insert).toMatch(/nulls_not_distinct\s*\)\s*VALUES[\s\S]*,\s*0\s*\)/);
  });

  it('removeConstraints writes via queryFn when provided', async () => {
    addConstraint({ name: 'a', table: 'products', columns: ['a'], nullsNotDistinct: false });
    const executed: string[] = [];
    const queryFn = async (sql: string) => {
      executed.push(sql);
      return { rows: [] };
    };
    await removeConstraints('products', queryFn);
    expect(executed.some((s) => s.includes('DELETE FROM __unique_constraints'))).toBe(true);
    expect(getConstraints('products')).toEqual([]);
  });
});

describe('loadFromDB', () => {
  beforeEach(async () => {
    await removeConstraints('products');
  });

  it('loads definitions from an array result', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [
          { name: 'a', table_name: 'products', columns_json: '["a","b"]', nulls_not_distinct: 1 },
        ];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    const defs = getConstraints('products');
    expect(defs).toHaveLength(1);
    expect(defs[0].columns).toEqual(['a', 'b']);
    expect(defs[0].nullsNotDistinct).toBe(true);
  });

  it('loads definitions from a { rows } result', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [{ name: 'a', table_name: 'products', columns_json: '["a"]', nulls_not_distinct: 0 }] };
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')).toHaveLength(1);
  });

  it('handles true as nulls_not_distinct', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { rows: [{ name: 'a', table_name: 'products', columns_json: '["a"]', nulls_not_distinct: true }] };
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')[0].nullsNotDistinct).toBe(true);
  });

  it('handles array-tuple rows', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [['a', 'products', '["x"]', 0]];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    const defs = getConstraints('products');
    expect(defs).toHaveLength(1);
    expect(defs[0].columns).toEqual(['x']);
  });

  it('swallows errors from a failing query', async () => {
    const queryFn = async () => {
      throw new Error('db down');
    };
    await expect(loadFromDB(queryFn)).resolves.toBeUndefined();
  });

  it('defaults columns to [] when empty', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return [['a', 'products', '', 0]];
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')[0].columns).toEqual([]);
  });

  it('handles a result that is neither an array nor has rows', async () => {
    const queryFn = async (sql: string) => {
      if (sql.startsWith('SELECT')) {
        return { unexpected: 'shape' };
      }
      return undefined;
    };
    await loadFromDB(queryFn);
    expect(getConstraints('products')).toEqual([]);
  });
});
