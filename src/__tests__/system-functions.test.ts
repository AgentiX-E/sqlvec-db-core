/**
 * SystemFunctions unit tests.
 *
 * Covers the `SystemFunctionRegistry` (init/idempotence, lookup, arity-checked
 * execution, OID ordinal mapping) and the numeric/string/privilege helpers
 * registered in handlers. Asserts PostgreSQL-compatible behavior.
 */
import { describe, it, expect } from 'vitest';
import { SystemFunctionRegistry } from '../system/SystemFunctions';

describe('SystemFunctionRegistry.init', () => {
  it('initializes idempotently', () => {
    SystemFunctionRegistry.init();
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.getFunctionNames().length).toBeGreaterThan(0);
  });

  it('reports known system functions', () => {
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.isSystemFunction('version')).toBe(true);
    expect(SystemFunctionRegistry.isSystemFunction('current_schema')).toBe(true);
    expect(SystemFunctionRegistry.isSystemFunction('no_such_fn')).toBe(false);
  });
});

describe('SystemFunctionRegistry.execute', () => {
  it('executes a zero-arg function', () => {
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.execute('version', [])).toMatch(/PostgreSQL 16\.0/);
    expect(SystemFunctionRegistry.execute('current_schema', [])).toBe('public');
    expect(SystemFunctionRegistry.execute('current_user', [])).toBe('postgres');
  });

  it('executes a one-arg function', () => {
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.execute('pg_size_pretty', [1024])).toBe('1 kB');
  });

  it('throws when too few arguments are supplied', () => {
    SystemFunctionRegistry.init();
    expect(() => SystemFunctionRegistry.execute('pg_size_pretty', [])).toThrow();
  });

  it('throws when too many arguments are supplied', () => {
    SystemFunctionRegistry.init();
    expect(() => SystemFunctionRegistry.execute('version', [1])).toThrow();
  });

  it('throws for an unknown function', () => {
    SystemFunctionRegistry.init();
    expect(() => SystemFunctionRegistry.execute('definitely_not_real')).toThrow();
  });
});

describe('SystemFunctionRegistry.getFunctionByOid', () => {
  it('maps OIDs starting at 20000 to function infos', () => {
    SystemFunctionRegistry.init();
    const first = SystemFunctionRegistry.getFunctionByOid(20000);
    expect(first).toBeDefined();
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('handler');
    // The second OID maps to a distinct function.
    const second = SystemFunctionRegistry.getFunctionByOid(20001);
    expect(second?.name).not.toBe(first?.name);
  });

  it('returns undefined for out-of-range OIDs', () => {
    SystemFunctionRegistry.init();
    expect(SystemFunctionRegistry.getFunctionByOid(19999)).toBeUndefined();
    expect(SystemFunctionRegistry.getFunctionByOid(999999)).toBeUndefined();
  });
});

describe('handlers — pg_size_pretty', () => {
  const exec = (args: any[]) => SystemFunctionRegistry.execute('pg_size_pretty', args);

  it('formats bytes into human-readable units', () => {
    expect(exec([0])).toBe('0 bytes');
    expect(exec([1])).toBe('1 bytes');
    expect(exec([1023])).toBe('1023 bytes');
    expect(exec([1024])).toBe('1 kB');
    expect(exec([1048576])).toBe('1 MB');
    expect(exec([1073741824])).toBe('1 GB');
  });

  it('handles fractional values with one decimal place', () => {
    expect(exec([1536])).toBe('1.5 kB');
  });

  it('returns "0 bytes" for NaN and non-numeric input', () => {
    expect(exec([NaN])).toBe('0 bytes');
    expect(exec(['abc' as any])).toBe('0 bytes');
  });
});

describe('handlers — pg_size_bytes', () => {
  const exec = (args: any[]) => SystemFunctionRegistry.execute('pg_size_bytes', args);

  it('parses unit-suffixed sizes', () => {
    expect(exec(['1 kB'])).toBe(1024);
    expect(exec(['1 MB'])).toBe(1048576);
    expect(exec(['1 GB'])).toBe(1073741824);
    expect(exec(['100 bytes'])).toBe(100);
  });

  it('accepts bare numbers as bytes', () => {
    expect(exec(['42'])).toBe(42);
  });

  it('returns 0 for unparseable input', () => {
    expect(exec(['not a size'])).toBe(0);
  });
});

describe('handlers — privilege checks', () => {
  it('has_schema_privilege accepts USAGE/CREATE/ALL', () => {
    const exec = (args: any[]) => SystemFunctionRegistry.execute('has_schema_privilege', args);
    expect(exec(['user', 'public', 'USAGE'])).toBe(true);
    expect(exec(['user', 'public', 'CREATE'])).toBe(true);
    expect(exec(['user', 'public', 'ALL'])).toBe(true);
    expect(exec(['user', 'public', 'SELECT'])).toBe(false);
  });

  it('has_table_privilege accepts DML privileges', () => {
    const exec = (args: any[]) => SystemFunctionRegistry.execute('has_table_privilege', args);
    expect(exec(['user', 'tbl', 'SELECT'])).toBe(true);
    expect(exec(['user', 'tbl', 'ALL'])).toBe(true);
    expect(exec(['user', 'tbl', 'USAGE'])).toBe(false);
  });
});

describe('handlers — to_hex', () => {
  const exec = (args: any[]) => SystemFunctionRegistry.execute('to_hex', args);

  it('converts positive integers to hex', () => {
    expect(exec([10])).toBe('a');
    expect(exec([255])).toBe('ff');
    expect(exec([16])).toBe('10');
  });

  it('returns null for null input', () => {
    expect(exec([null])).toBeNull();
  });

  it('converts negative integers to two\'s-complement hex (PostgreSQL semantics)', () => {
    // PostgreSQL to_hex(-1) returns 'ffffffffffffffff' (64-bit two's complement).
    expect(exec([-1])).toBe('ffffffffffffffff');
  });
});

describe('handlers — regexp_like', () => {
  const exec = (args: any[]) => SystemFunctionRegistry.execute('regexp_like', args);

  it('tests a regular expression', () => {
    expect(exec(['hello', 'ell'])).toBe(true);
    expect(exec(['hello', '^h'])).toBe(true);
    expect(exec(['hello', '^x'])).toBe(false);
  });

  it('returns null for null input', () => {
    expect(exec([null, 'x'])).toBeNull();
    expect(exec(['x', null])).toBeNull();
  });

  it('returns false for an invalid pattern', () => {
    expect(exec(['hello', '['])).toBe(false);
  });
});

describe('handlers — trim_array', () => {
  const exec = (args: any[]) => SystemFunctionRegistry.execute('trim_array', args);

  it('removes the last n elements', () => {
    expect(exec([[1, 2, 3, 4], 1])).toEqual([1, 2, 3]);
    expect(exec([[1, 2, 3, 4], 2])).toEqual([1, 2]);
  });

  it('returns the array unchanged for n <= 0', () => {
    expect(exec([[1, 2, 3], 0])).toEqual([1, 2, 3]);
    expect(exec([[1, 2, 3], -1])).toEqual([1, 2, 3]);
  });

  it('returns null for null input', () => {
    expect(exec([null, 1])).toBeNull();
  });
});
