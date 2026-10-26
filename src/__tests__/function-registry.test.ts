/**
 * FunctionRegistry unit tests.
 *
 * Covers registration, removal, lookup (case-insensitive), enumeration,
 * argument-count validation on invoke, and the `size` accessor. The registry
 * wraps `buildPgFunctions()`, so these tests also exercise the built-in
 * function table's structural integrity.
 */
import { describe, it, expect } from 'vitest';
import { FunctionRegistry } from '../system/FunctionRegistry';

function newRegistry() {
  return new FunctionRegistry();
}

describe('FunctionRegistry construction', () => {
  it('pre-loads the built-in function table', () => {
    const r = newRegistry();
    expect(r.size).toBeGreaterThan(0);
    // A few known built-ins must be present.
    expect(r.find('abs')).toBeDefined();
    expect(r.find('round')).toBeDefined();
    expect(r.find('pi')).toBeDefined();
  });
});

describe('FunctionRegistry.find', () => {
  it('returns undefined for unknown functions', () => {
    expect(newRegistry().find('no_such_fn_xyz')).toBeUndefined();
  });

  it('is case-insensitive', () => {
    const r = newRegistry();
    expect(r.find('ABS')?.name).toBe('abs');
    expect(r.find('Abs')?.name).toBe('abs');
  });

  it('returns the registered metadata shape', () => {
    const r = newRegistry();
    const f = r.find('abs')!;
    expect(f).toHaveProperty('name', 'abs');
    expect(f).toHaveProperty('minArgs', 1);
    expect(f).toHaveProperty('maxArgs', 1);
    expect(f).toHaveProperty('returns', 'numeric');
    expect(typeof f.fn).toBe('function');
  });
});

describe('FunctionRegistry.invoke', () => {
  it('invokes a known function with valid args', () => {
    const r = newRegistry();
    expect(r.invoke('abs', [-5])).toBe(5);
    expect(r.invoke('round', [3.14159, 2])).toBe(3.14);
  });

  it('returns undefined for an unknown function', () => {
    expect(newRegistry().invoke('no_such_fn', [])).toBeUndefined();
  });

  it('returns null when too few arguments are passed', () => {
    const r = newRegistry();
    expect(r.invoke('mod', [5])).toBeNull(); // mod requires 2 args
  });

  it('returns null when too many arguments are passed', () => {
    const r = newRegistry();
    expect(r.invoke('pi', [1])).toBeNull(); // pi requires 0 args
  });

  it('honors variadic maxArgs for concat', () => {
    const r = newRegistry();
    expect(r.invoke('concat', ['a', 'b', 'c', 'd'])).toBe('abcd');
  });
});

describe('FunctionRegistry.register / remove', () => {
  it('registers a custom function and overrides built-ins case-insensitively', () => {
    const r = newRegistry();
    r.register('my_fn', { name: 'my_fn', minArgs: 1, maxArgs: 1, returns: 'text', fn: (x: any) => `got:${x}` });
    expect(r.find('MY_FN')?.name).toBe('my_fn');
    expect(r.invoke('my_fn', ['hello'])).toBe('got:hello');
  });

  it('remove deletes case-insensitively and is a no-op for unknown names', () => {
    const r = newRegistry();
    const before = r.size;
    r.remove('abs');
    expect(r.find('abs')).toBeUndefined();
    expect(r.size).toBe(before - 1);
    r.remove('never_existed');
    expect(r.size).toBe(before - 1);
  });
});

describe('FunctionRegistry.getAll', () => {
  it('returns a shallow copy independent of the internal map', () => {
    const r = newRegistry();
    const copy = r.getAll();
    expect(copy.size).toBe(r.size);
    // Mutating the copy must not affect the registry.
    copy.delete('abs');
    expect(r.find('abs')).toBeDefined();
  });
});

describe('FunctionRegistry variadic binding', () => {
  it('marks maxArgs===Infinity functions as variadic so varargs bind correctly', () => {
    const r = newRegistry();
    // These are registered with maxArgs === Infinity (rest-parameter impls).
    // Without varargs:true the better-sqlite3 binding infers arity from
    // fn.length (0 for `(...args)`, 1 for `(fmt, ...args)`), which is less
    // than the actual call arity and rejects every call with "wrong number of
    // arguments". The registry must carry maxArgs===Infinity so the binding
    // layer can opt into varargs.
    const variadic = ['concat', 'format', 'json_build_object', 'jsonb_build_object', 'jsonb_build_array'];
    for (const name of variadic) {
      const f = r.find(name);
      expect(f, `missing ${name}`).toBeDefined();
      expect(f!.maxArgs, `${name} should be variadic`).toBe(Infinity);
    }
  });

  it('registers fixed-range optional-arg functions (minArgs !== maxArgs)', () => {
    const r = newRegistry();
    // Optional-argument functions must be bound variadically too: their
    // fn.length counts only required params, so a 2-arg PG call to
    // regexp_matches('abc','b') would otherwise be rejected even though the
    // declared range is 2..3.
    const optionalArg = ['regexp_matches', 'regexp_replace', 'regexp_split_to_array', 'regexp_count'];
    for (const name of optionalArg) {
      const f = r.find(name);
      expect(f, `missing ${name}`).toBeDefined();
      expect(f!.minArgs, `${name} minArgs`).toBeLessThan(f!.maxArgs);
    }
  });

  it('registers greatest/least as variadic comparison helpers', () => {
    const r = newRegistry();
    for (const name of ['greatest', 'least']) {
      const f = r.find(name)!;
      expect(f, `missing ${name}`).toBeDefined();
      expect(f.maxArgs).toBe(Infinity);
      expect(typeof f.fn).toBe('function');
    }
  });
});
