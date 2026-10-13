import { describe, it, expect, beforeEach } from 'vitest';
import {
  PLpgSQLExecutor,
  parseFunctionParam,
  parseFunctionParams,
  buildParamListString,
  type FunctionParam,
} from '../query/PLpgSQLExecutor';

describe('parseFunctionParam', () => {
  it('parses a simple param name + type', () => {
    const p = parseFunctionParam('a integer');
    expect(p).toEqual({ name: 'a', type: 'integer', mode: undefined, length: undefined, scale: undefined, array: false, defaultValue: undefined });
  });

  it('parses varchar with length', () => {
    const p = parseFunctionParam('b varchar(100)');
    expect(p?.name).toBe('b');
    expect(p?.type).toBe('varchar');
    expect(p?.length).toBe(100);
  });

  it('parses numeric with length and scale', () => {
    const p = parseFunctionParam('c numeric(10,2)');
    expect(p?.length).toBe(10);
    expect(p?.scale).toBe(2);
  });

  it('parses OUT mode', () => {
    const p = parseFunctionParam('OUT b text');
    expect(p?.mode).toBe('OUT');
    expect(p?.name).toBe('b');
  });

  it('parses INOUT mode', () => {
    const p = parseFunctionParam('INOUT c int');
    expect(p?.mode).toBe('INOUT');
    expect(p?.name).toBe('c');
  });

  it('parses IN OUT (two words) as INOUT', () => {
    const p = parseFunctionParam('IN OUT c int');
    expect(p?.mode).toBe('INOUT');
  });

  it('parses VARIADIC with array', () => {
    const p = parseFunctionParam('VARIADIC a int[]');
    expect(p?.mode).toBe('VARIADIC');
    expect(p?.array).toBe(true);
  });

  it('parses DEFAULT value', () => {
    const p = parseFunctionParam('a integer DEFAULT 5');
    expect(p?.defaultValue).toBe('5');
  });

  it('parses := default value', () => {
    const p = parseFunctionParam('a integer := 10');
    expect(p?.defaultValue).toBe('10');
  });

  it('parses DEFAULT with array expression', () => {
    const p = parseFunctionParam("c int[] DEFAULT ARRAY[1,2]");
    expect(p?.defaultValue).toBe('ARRAY[1,2]');
    expect(p?.array).toBe(true);
  });

  it('strips trailing semicolon from default value', () => {
    const p = parseFunctionParam('a integer DEFAULT 5;');
    expect(p?.defaultValue).toBe('5');
  });

  it('parses qualified type name', () => {
    const p = parseFunctionParam('a pg_catalog.int4');
    expect(p?.type).toBe('pg_catalog.int4');
  });

  it('returns null for empty / whitespace input', () => {
    expect(parseFunctionParam('')).toBeNull();
    expect(parseFunctionParam('   ')).toBeNull();
  });

  it('returns null when no type name follows', () => {
    expect(parseFunctionParam('a')).toBeNull();
  });

  it('returns null when no name (starts with type token that has no following type)', () => {
    // "123" is not a valid identifier name
    expect(parseFunctionParam('123 integer')).toBeNull();
  });

  it('parses DEFAULT with semicolon-free long expression', () => {
    const p = parseFunctionParam("a text DEFAULT 'hello world'");
    expect(p?.defaultValue).toBe("'hello world'");
  });

  it('does not set defaultValue when DEFAULT is empty', () => {
    const p = parseFunctionParam('a int DEFAULT');
    expect(p?.defaultValue).toBeUndefined();
  });

  it('does not set defaultValue when := is empty', () => {
    const p = parseFunctionParam('a int :=');
    expect(p?.defaultValue).toBeUndefined();
  });
});

describe('parseFunctionParams', () => {
  it('parses a comma-separated list', () => {
    const ps = parseFunctionParams('a integer, b varchar(100)');
    expect(ps).toHaveLength(2);
    expect(ps[0].name).toBe('a');
    expect(ps[1].length).toBe(100);
  });

  it('handles nested parens in type', () => {
    const ps = parseFunctionParams('a integer, b numeric(10,2), c text');
    expect(ps).toHaveLength(3);
    expect(ps[1].length).toBe(10);
    expect(ps[1].scale).toBe(2);
  });

  it('handles default with parenthesized expression', () => {
    const ps = parseFunctionParams('a integer DEFAULT (1+2), b text');
    expect(ps).toHaveLength(2);
    expect(ps[0].defaultValue).toBe('(1+2)');
  });

  it('skips invalid params (returns fewer results)', () => {
    const ps = parseFunctionParams('a integer, , b text');
    expect(ps).toHaveLength(2);
  });

  it('returns empty array for empty input', () => {
    expect(parseFunctionParams('')).toEqual([]);
    expect(parseFunctionParams('   ')).toEqual([]);
  });

  it('handles a trailing comma (empty last segment)', () => {
    const ps = parseFunctionParams('a integer,');
    expect(ps).toHaveLength(1);
    expect(ps[0].name).toBe('a');
  });
});

describe('buildParamListString', () => {
  it('builds a simple IN param list', () => {
    const ps: FunctionParam[] = [{ name: 'a', type: 'integer', array: false }];
    expect(buildParamListString(ps)).toBe('IN a integer');
  });

  it('preserves mode, length, scale, array, default', () => {
    const ps: FunctionParam[] = [
      { name: 'b', type: 'varchar', length: 100, array: false },
      { name: 'c', type: 'int', mode: 'OUT', array: true },
      { name: 'd', type: 'numeric', length: 10, scale: 2, array: false, defaultValue: '0' },
    ];
    expect(buildParamListString(ps)).toBe(
      'IN b varchar(100), OUT c int[], IN d numeric(10, 2) DEFAULT 0',
    );
  });
});

describe('PLpgSQLExecutor lifecycle', () => {
  let ex: PLpgSQLExecutor;
  beforeEach(() => { ex = new PLpgSQLExecutor(); });

  it('reports not started initially', () => {
    expect(ex.isStarted).toBe(false);
  });

  it('starts and reports started', async () => {
    await ex.start();
    expect(ex.isStarted).toBe(true);
  });

  it('start is idempotent', async () => {
    await ex.start();
    await ex.start();
    expect(ex.isStarted).toBe(true);
  });

  it('throws when registering before start', async () => {
    await expect(ex.registerFunction('f', 'RETURN 1', 0, 'integer')).rejects.toThrow(/not started/);
  });

  it('throws when executing before start', async () => {
    await expect(ex.execute('f', [])).rejects.toThrow(/not started/);
  });

  it('registers and lists functions after start', async () => {
    await ex.start();
    await ex.registerFunction('f', 'RETURN 1', 0, 'integer');
    expect(ex.hasFunction('f')).toBe(true);
    expect(ex.getFunctionNames()).toEqual(['f']);
    expect(ex.getFunction('f')?.returnType).toBe('integer');
  });

  it('uses default argCount 0 and returnType text', async () => {
    await ex.start();
    await ex.registerFunction('f', 'RETURN 1');
    const f = ex.getFunction('f');
    expect(f?.argCount).toBe(0);
    expect(f?.returnType).toBe('text');
  });

  it('throws when executing an unregistered function', async () => {
    await ex.start();
    await expect(ex.execute('missing', [])).rejects.toThrow(/not found/);
  });

  it('drops a function', async () => {
    await ex.start();
    await ex.registerFunction('f', 'RETURN 1');
    await ex.dropFunction('f');
    expect(ex.hasFunction('f')).toBe(false);
  });

  it('stop clears functions and started flag', async () => {
    await ex.start();
    await ex.registerFunction('f', 'RETURN 1');
    await ex.stop();
    expect(ex.isStarted).toBe(false);
    expect(ex.hasFunction('f')).toBe(false);
    expect(ex.getFunctionNames()).toEqual([]);
  });

  it('reset delegates to stop', async () => {
    await ex.start();
    await ex.registerFunction('f', 'RETURN 1');
    await ex.reset();
    expect(ex.isStarted).toBe(false);
  });

  it('setQueryCallback wires the evaluator (no throw)', async () => {
    ex.setQueryCallback(async () => []);
    ex.setQueryCallback(null);
  });
});

describe('PLpgSQLExecutor param-name rewriting', () => {
  it('rewrites a bare param name to $1 in SELECT ... INTO', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction(
      'find_dept',
      'SELECT * FROM t WHERE department = dept',
      1,
      'text',
      'dept text',
    );
    const f = ex.getFunction('find_dept');
    expect(f?.body).toContain('$1');
    expect(f?.body).not.toContain('department = dept');
  });

  it('does not rewrite qualified names (employee.dept)', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction(
      'f',
      'SELECT * FROM t WHERE employee.dept = 1',
      1,
      'text',
      'dept text',
    );
    expect(ex.getFunction('f')?.body).toContain('employee.dept');
  });

  it('does not rewrite when no paramList', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('f', 'SELECT * FROM t WHERE dept = 1', 0, 'text');
    expect(ex.getFunction('f')?.body).toContain('dept = 1');
  });

  it('does not rewrite when paramList has no names', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('f', 'SELECT * FROM t WHERE x = 1', 0, 'text', '');
    expect(ex.getFunction('f')?.body).toContain('x = 1');
  });

  it('does not rewrite when paramList is whitespace only', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('f', 'SELECT * FROM t WHERE x = 1', 0, 'text', '   ');
    expect(ex.getFunction('f')?.body).toContain('x = 1');
  });

  it('filters non-identifier segments from param names', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    // ", b" -> first segment empty (no \w prefix), filtered out; "b" kept
    await ex.registerFunction('f', 'SELECT * FROM t WHERE v = b', 1, 'int', ', b int');
    expect(ex.getFunction('f')?.body).toContain('$1');
  });

  it('strips INOUT mode prefix when resolving param names', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('f', 'SELECT * FROM t WHERE v = c', 1, 'int', 'INOUT c integer');
    expect(ex.getFunction('f')?.body).toContain('$1');
    expect(ex.getFunction('f')?.body).not.toContain('WHERE v = c');
  });

  it('strips VARIADIC mode prefix when resolving param names', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('f', 'SELECT * FROM t WHERE v = a', 1, 'int', 'VARIADIC a int[]');
    expect(ex.getFunction('f')?.body).toContain('$1');
  });
});

describe('PLpgSQLExecutor.execute', () => {
  it('executes a simple RETURN value and returns it', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('answer', 'BEGIN RETURN 42; END;', 0, 'integer');
    await expect(ex.execute('answer', [])).resolves.toBe(42);
  });

  it('executes with injected positional arguments', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('double_it', 'BEGIN RETURN $1 * 2; END;', 1, 'integer');
    await expect(ex.execute('double_it', [21])).resolves.toBe(42);
  });

  it('executes with injected named arguments', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('greet', 'BEGIN RETURN arg1; END;', 1, 'text');
    await expect(ex.execute('greet', ['hi'])).resolves.toBe('hi');
  });

  it('executes no-arg convenience wrapper', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('const_val', 'BEGIN RETURN 7; END;', 0, 'integer');
    await expect(ex.executeNoArgs('const_val')).resolves.toBe(7);
  });

  it('throws on evaluator failure', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    // A body with invalid syntax that the evaluator rejects
    await ex.registerFunction('bad', 'THIS IS INVALID ###', 0, 'text');
    await expect(ex.execute('bad', [])).rejects.toThrow(/execution failed/);
  });

  it('propagates query callback into evaluator', async () => {
    const ex = new PLpgSQLExecutor();
    ex.setQueryCallback(async (sql) => [{ v: 1 }]);
    await ex.start();
    await ex.registerFunction('f', 'BEGIN RETURN 1; END;', 0, 'integer');
    await expect(ex.execute('f', [])).resolves.toBe(1);
  });

  it('injects named parameter variables when params are provided', async () => {
    const ex = new PLpgSQLExecutor();
    await ex.start();
    await ex.registerFunction('add', 'BEGIN RETURN a + b; END;', 2, 'integer', 'a integer, b integer');
    await expect(ex.execute('add', [3, 4])).resolves.toBe(7);
  });
});
