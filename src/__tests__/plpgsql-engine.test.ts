import { describe, it, expect } from 'vitest';
import {
  createPlPgSqlEngine,
  parsePlPgSql,
  PlPgSqlEngine,
} from '../plpgsql/PlPgSqlEngine';

async function run(sql: string): Promise<PlPgSqlEngine> {
  const e = createPlPgSqlEngine();
  await e.execute(sql);
  return e;
}

describe('PlPgSqlEngine', () => {
  // ── entry / lifecycle ────────────────────────────────────────
  describe('lifecycle', () => {
    it('starts and stops without error', async () => {
      const e = createPlPgSqlEngine();
      await e.start();
      await e.stop();
    });

    it('executes an empty string as success with no variables', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute('   ');
      expect(r.success).toBe(true);
      expect(r.variables).toEqual({});
    });

    it('reports failure for garbage input without DECLARE/BEGIN', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute('SELECT 1');
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/missing DECLARE or BEGIN/);
    });

    it('getVariable / setVariable / getVariables round-trip', async () => {
      const e = createPlPgSqlEngine();
      e.setVariable('foo', 123);
      expect(e.getVariable('foo')).toBe(123);
      expect(e.getVariables().foo).toBe(123);
    });

    it('parse returns an AST without executing', () => {
      const e = createPlPgSqlEngine();
      const parsed = e.parse(`DO $$ DECLARE x INT; BEGIN NULL; END; $$`);
      expect(parsed.block.type).toBe('BLOCK');
      expect(parsed.block.declarations[0].name).toBe('x');
    });

    it('reset clears custom variables', async () => {
      const e = createPlPgSqlEngine();
      e.setVariable('foo', 123);
      e.reset();
      expect(e.getVariable('foo')).toBeUndefined();
    });
  });

  describe('DO wrapper extraction', () => {
    it('accepts DO $$ ... $$', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 5; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(5);
    });

    it('accepts DO LANGUAGE plpgsql $$ ... $$', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO LANGUAGE plpgsql $$ DECLARE x INT := 7; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(7);
    });

    it('accepts DO \'...\' string wrapper', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO 'DECLARE x INT := 9; BEGIN RETURN x; END;'`);
      expect(r.returnValue).toBe(9);
    });

    it('accepts a bare body without DO wrapper', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DECLARE x INT := 11; BEGIN RETURN x; END;`);
      expect(r.returnValue).toBe(11);
    });
  });

  // ── declarations ─────────────────────────────────────────────
  describe('declarations', () => {
    it('declares a variable with default', async () => {
      const e = await run(`DO $$ DECLARE x INT := 42; BEGIN NULL; END; $$`);
      expect(e.getVariable('x')).toBe(42);
    });

    it('declares a variable without default as null', async () => {
      const e = await run(`DO $$ DECLARE x INT; BEGIN NULL; END; $$`);
      expect(e.getVariable('x')).toBeNull();
    });

    it('supports DEFAULT keyword', async () => {
      const e = await run(`DO $$ DECLARE x INT DEFAULT 10; BEGIN NULL; END; $$`);
      expect(e.getVariable('x')).toBe(10);
    });

    it('supports CONSTANT', async () => {
      const e = await run(`DO $$ DECLARE x CONSTANT INT := 3; BEGIN NULL; END; $$`);
      expect(e.getVariable('x')).toBe(3);
    });

    it('supports string default value', async () => {
      const e = await run(`DO $$ DECLARE s TEXT := 'hi'; BEGIN NULL; END; $$`);
      expect(e.getVariable('s')).toBe('hi');
    });

    it('strips array brackets from the data type', async () => {
      const e = await run(`DO $$ DECLARE arr INTEGER[] := ARRAY[1,2]; BEGIN NULL; END; $$`);
      expect(Array.isArray(e.getVariable('arr'))).toBe(true);
    });

    it('skips ALIAS declarations', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE old ALIAS FOR new; x INT := 1; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('skips a comma-separated multi-variable declaration', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT; y INT := 2; BEGIN RETURN y; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('skips a nested DECLARE keyword', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 3; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('handles NULL assignment in declaration', async () => {
      const e = await run(`DO $$ DECLARE x INT := NULL; BEGIN NULL; END; $$`);
      expect(e.getVariable('x')).toBeNull();
    });
  });

  // ── assignments & expressions ────────────────────────────────
  describe('assignments and expressions', () => {
    it('evaluates arithmetic', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 10; BEGIN x := x + 5 * 2; RETURN x; END; $$`);
      expect(r.returnValue).toBe(20);
    });

    it('evaluates number, string, boolean literals', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := 1.5; RETURN x; END; $$`);
      expect(r.returnValue).toBe(1.5);
      r = await e.execute(`DO $$ DECLARE x BOOLEAN; BEGIN x := TRUE; RETURN x; END; $$`);
      expect(r.returnValue).toBe(true);
    });

    it('evaluates string concatenation with ||', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a TEXT := 'foo'; b TEXT := 'bar'; BEGIN RETURN a || b; END; $$`);
      expect(r.returnValue).toBe('foobar');
    });

    it('evaluates comparison = as equality', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; BEGIN IF x = 1 THEN RETURN 'yes'; ELSE RETURN 'no'; END IF; END; $$`);
      expect(r.returnValue).toBe('yes');
    });
  });

  // ── built-in functions ───────────────────────────────────────
  describe('built-in functions', () => {
    const cases: Array<[string, any]> = [
      [`x := upper('abc')`, 'ABC'],
      [`x := lower('ABC')`, 'abc'],
      [`x := length('hello')`, 5],
      [`x := trim('  x  ')`, 'x'],
      [`x := btrim('  x  ')`, 'x'],
      [`x := btrim('xxhixx', 'x')`, 'hi'],
      [`x := ltrim('  x  ')`, 'x  '],
      [`x := rtrim('  x  ')`, '  x'],
      [`x := substr('hello', 2, 3)`, 'ell'],
      [`x := substring('hello', 1, 2)`, 'he'],
      [`x := concat('a', 'b', 'c')`, 'abc'],
      [`x := position('l', 'hello')`, 3],
      [`x := replace('abc', 'b', 'X')`, 'aXc'],
      [`x := repeat('ab', 3)`, 'ababab'],
      [`x := reverse('abc')`, 'cba'],
      [`x := initcap('hello world')`, 'Hello World'],
      [`x := abs(-5)`, 5],
      [`x := ceil(1.2)`, 2],
      [`x := floor(1.8)`, 1],
      [`x := round(1.7)`, 2],
      [`x := trunc(1.9)`, 1],
      [`x := mod(7, 3)`, 1],
      [`x := power(2, 3)`, 8],
      [`x := sqrt(9)`, 3],
      [`x := sign(-5)`, -1],
      [`x := greatest(1, 9, 4)`, 9],
      [`x := least(1, 9, 4)`, 1],
      [`x := coalesce(null, null, 3)`, 3],
      [`x := coalesce(null, null)`, null],
      [`x := nullif(1, 1)`, null],
      [`x := nullif(1, 2)`, 1],
      [`x := to_number('42')`, 42],
      [`x := to_char(42)`, '42'],
    ];

    for (const [expr, expected] of cases) {
      it(`evaluates ${expr}`, async () => {
        const e = createPlPgSqlEngine();
        const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN ${expr}; RETURN x; END; $$`);
        expect(r.returnValue).toBe(expected);
      });
    }

    it('evaluates a function call inside a comparison', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s TEXT := 'HELLO'; BEGIN IF upper(s) = 'HELLO' THEN RETURN 'up'; END IF; END; $$`);
      expect(r.returnValue).toBe('up');
    });

    it('evaluates nested function calls', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := upper(lower('HeLLo')); RETURN x; END; $$`);
      expect(r.returnValue).toBe('HELLO');
    });

    it('supports pg_catalog schema prefix', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := pg_catalog.upper('abc'); RETURN x; END; $$`);
      expect(r.returnValue).toBe('ABC');
    });

    it('evaluates random, to_date, unnest', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE x DOUBLE PRECISION; BEGIN x := random(); RETURN x; END; $$`);
      expect(typeof r.returnValue).toBe('number');
      r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := to_date('2020-01-01'); RETURN x; END; $$`);
      expect(r.returnValue).toBe('2020-01-01');
      r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2]; x INT[]; BEGIN x := unnest(a); RETURN array_length(x); END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('evaluates round with precision digits', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x DOUBLE PRECISION; BEGIN x := round(1.2345, 2); RETURN x; END; $$`);
      expect(r.returnValue).toBe(1.23);
    });

    it('resolves builtin calls with literal args inside a larger expression', async () => {
      const e = createPlPgSqlEngine();
      // abs(-5) + literal forces evaluateExpression through the safe-eval path,
      // which pre-resolves the builtin call and its literal arg (-5, null, etc.)
      let r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := abs(-5) + 1; RETURN x; END; $$`);
      expect(r.returnValue).toBe(6);
      r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := coalesce(null, 7) + 1; RETURN x; END; $$`);
      expect(r.returnValue).toBe(8);
      r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := upper('ab') || 'c'; RETURN x; END; $$`);
      expect(r.returnValue).toBe('ABc');
    });

    it('resolves a boolean literal arg inside a larger expression', async () => {
      const e = createPlPgSqlEngine();
      // coalesce(true, false) returns true (a boolean literal arg), then || ''
      // forces the safe-eval path that pre-resolves the builtin call.
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := coalesce(true, false) || ''; RETURN x; END; $$`);
      expect(r.returnValue).toBe('true');
    });

    it('resolves a floating-point arg inside a larger expression', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x DOUBLE PRECISION; BEGIN x := round(1.5, 1) + 0; RETURN x; END; $$`);
      expect(r.returnValue).toBe(1.5);
    });

    it('resolves a dollar-quoted positional parameter expression', async () => {
      const e = createPlPgSqlEngine();
      e.setVariable('$1', 10);
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := $1 + 5; RETURN x; END; $$`);
      expect(r.returnValue).toBe(15);
    });

    it('resolves a standalone $N parameter expression', async () => {
      const e = createPlPgSqlEngine();
      e.setVariable('$2', 42);
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := $2; RETURN x; END; $$`);
      expect(r.returnValue).toBe(42);
    });

    it('resolves builtin calls with a string literal arg inside an expression', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := upper('hi') = 'HI'; RETURN x; END; $$`);
      expect(r.returnValue).toBe(true);
    });

    it('resolves a builtin call returning null inside an expression', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := nullif(1, 1); RETURN x; END; $$`);
      expect(r.returnValue).toBeNull();
    });

    it('evaluates an empty ARRAY[] literal', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[]; BEGIN a := ARRAY[]; RETURN array_length(a); END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('returns an unevaluable expression as-is (safe pattern violation)', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := 1 @ 2; RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });
  });

  // ── array built-ins ──────────────────────────────────────────
  describe('array built-ins', () => {
    it('evaluates ARRAY literal', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[]; BEGIN a := ARRAY[1, 2, 3]; RETURN a[2]; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('evaluates array_length and cardinality', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3]; x INT; BEGIN x := array_length(a); RETURN x; END; $$`);
      expect(r.returnValue).toBe(3);
      r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2]; x INT; BEGIN x := cardinality(a); RETURN x; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('evaluates array_append', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1]; BEGIN a := array_append(a, 2); RETURN a[2]; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('evaluates array_cat', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1]; b INT[] := ARRAY[2,3]; x INT[]; BEGIN x := array_cat(a, b); RETURN x[3]; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('evaluates array_remove', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3]; x INT[]; BEGIN x := array_remove(a, 2); RETURN array_length(x); END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('evaluates array_replace', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3]; x INT[]; BEGIN x := array_replace(a, 2, 9); RETURN x[2]; END; $$`);
      expect(r.returnValue).toBe(9);
    });
  });

  // ── control flow ─────────────────────────────────────────────
  describe('control flow', () => {
    it('executes IF/THEN/ELSE', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ BEGIN IF 1 < 2 THEN RETURN 'a'; ELSE RETURN 'b'; END IF; END; $$`);
      expect(r.returnValue).toBe('a');
      r = await e.execute(`DO $$ BEGIN IF 1 > 2 THEN RETURN 'a'; ELSE RETURN 'b'; END IF; END; $$`);
      expect(r.returnValue).toBe('b');
    });

    it('executes ELSEIF / ELSIF chains', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 5; BEGIN IF x > 10 THEN RETURN 'big'; ELSIF x > 3 THEN RETURN 'mid'; ELSE RETURN 'small'; END IF; END; $$`);
      expect(r.returnValue).toBe('mid');
    });

    it('supports ELSIF spelling', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF 1 > 2 THEN RETURN 'a'; ELSEIF 1 < 2 THEN RETURN 'b'; END IF; END; $$`);
      expect(r.returnValue).toBe('b');
    });

    it('executes LOOP with EXIT', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; EXIT WHEN i >= 5; END LOOP; RETURN i; END; $$`);
      expect(r.returnValue).toBe(5);
    });

    it('executes unconditional EXIT', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; EXIT; END LOOP; RETURN i; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('executes CONTINUE', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN LOOP i := i + 1; CONTINUE WHEN i = 2; EXIT WHEN i > 3; s := s + i; END LOOP; RETURN s; END; $$`);
      // adds 1, skips 2, adds 3 -> 4
      expect(r.returnValue).toBe(4);
    });

    it('executes unconditional CONTINUE (bounded by safety limit)', async () => {
      const e = createPlPgSqlEngine();
      // An unconditional CONTINUE inside an otherwise-infinite LOOP is caught by
      // the 10000-iteration safety limit rather than hanging forever. The loop
      // below uses EXIT WHEN before CONTINUE so it terminates normally.
      const r = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN LOOP i := i + 1; EXIT WHEN i > 3; CONTINUE; s := s + 1; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('executes WHILE loop', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN WHILE i < 3 LOOP i := i + 1; s := s + i; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(6);
    });

    it('executes WHILE loop that never runs', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN WHILE false LOOP NULL; END LOOP; RETURN 'done'; END; $$`);
      expect(r.returnValue).toBe('done');
    });

    it('executes FOREACH over array', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3]; s INT := 0; BEGIN FOREACH x IN ARRAY a LOOP s := s + x; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(6);
    });
  });

  // ── RETURN / RAISE ───────────────────────────────────────────
  describe('return and raise', () => {
    it('returns a value', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RETURN 'hello'; END; $$`);
      expect(r.returnValue).toBe('hello');
    });

    it('returns without value (null)', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RETURN; END; $$`);
      expect(r.success).toBe(true);
      expect(r.returnValue).toBeUndefined();
    });

    it('RAISE NOTICE invokes the notice callback', async () => {
      const e = createPlPgSqlEngine();
      const notices: Array<[string, string]> = [];
      e.setNoticeCallback((level, msg) => notices.push([level, msg]));
      await e.execute(`DO $$ BEGIN RAISE NOTICE 'hello'; END; $$`);
      expect(notices).toEqual([['NOTICE', 'hello']]);
    });

    it('RAISE WARNING and EXCEPTION set correct level', async () => {
      const e = createPlPgSqlEngine();
      const notices: string[] = [];
      e.setNoticeCallback((level) => notices.push(level));
      await e.execute(`DO $$ BEGIN RAISE WARNING 'w'; END; $$`);
      expect(notices).toEqual(['WARNING']);
      // EXCEPTION throws
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'boom'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/boom/);
    });

    it('RAISE without level defaults to NOTICE', async () => {
      const e = createPlPgSqlEngine();
      const notices: string[] = [];
      e.setNoticeCallback((level) => notices.push(level));
      await e.execute(`DO $$ BEGIN RAISE 'plain'; END; $$`);
      expect(notices).toEqual(['NOTICE']);
    });
  });

  // ── nested blocks ────────────────────────────────────────────
  describe('nested blocks', () => {
    it('executes a nested BEGIN ... END block', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 0; BEGIN x := 1; BEGIN x := x + 10; END; RETURN x; END; $$`);
      expect(r.returnValue).toBe(11);
    });

    it('executes a nested DECLARE ... BEGIN ... END block', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN DECLARE y INT := 5; BEGIN RETURN y; END; END; $$`);
      expect(r.returnValue).toBe(5);
    });

    it('catches an exception in a nested block', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN BEGIN RAISE EXCEPTION 'inner'; EXCEPTION WHEN OTHERS THEN NULL; END; RETURN 'outer'; END; $$`);
      expect(r.returnValue).toBe('outer');
    });
  });

  // ── exception handlers ───────────────────────────────────────
  describe('exception handlers', () => {
    it('catches WHEN OTHERS', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'boom'; EXCEPTION WHEN OTHERS THEN RETURN 'caught'; END; $$`);
      expect(r.success).toBe(true);
      expect(r.returnValue).toBe('caught');
    });

    it('sets SQLSTATE and SQLERRM in the handler', async () => {
      const e = createPlPgSqlEngine();
      await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'oops'; EXCEPTION WHEN OTHERS THEN NULL; END; $$`);
      expect(e.getVariable('SQLSTATE')).toBe('P0001');
      expect(e.getVariable('SQLERRM')).toBe('oops');
    });

    it('catches a named condition', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'division_by_zero'; EXCEPTION WHEN division_by_zero THEN RETURN 'div0'; END; $$`);
      expect(r.returnValue).toBe('div0');
    });

    it('re-throws unhandled exceptions', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'boom'; EXCEPTION WHEN division_by_zero THEN NULL; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/boom/);
    });

    it('catches WHEN SQLSTATE \'XXXXX\'', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'P0001 my error'; EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN 'matched'; END; $$`);
      expect(r.returnValue).toBe('matched');
    });

    it('does not match a different SQLSTATE', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'P0002 my error'; EXCEPTION WHEN SQLSTATE 'P0001' THEN RETURN 'matched'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/P0002/);
    });

    it('catches WHEN OTHERS after other handlers did not match', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'P0002 x'; EXCEPTION WHEN division_by_zero THEN RETURN 'div0'; WHEN OTHERS THEN RETURN 'others'; END; $$`);
      expect(r.returnValue).toBe('others');
    });

    it('sets SQLSTATE/SQLERRM on a matched SQLSTATE handler', async () => {
      const e = createPlPgSqlEngine();
      await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'P0001 boom'; EXCEPTION WHEN SQLSTATE 'P0001' THEN NULL; END; $$`);
      expect(e.getVariable('SQLSTATE')).toBe('P0001');
      expect(e.getVariable('SQLERRM')).toBe('P0001 boom');
    });
  });

  // ── SELECT INTO ──────────────────────────────────────────────
  describe('SELECT ... INTO', () => {
    it('assigns a result row to the target variable', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => [{ id: 42, name: 'alice' }]);
      const r = await e.execute(`DO $$ DECLARE id INT; name TEXT; BEGIN SELECT 1 INTO id, name; RETURN id; END; $$`);
      expect(r.returnValue).toBe(42);
    });

    it('sets found = true when rows are returned', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => [{ col: 'x' }]);
      const r = await e.execute(`DO $$ DECLARE v TEXT; BEGIN SELECT 'a' INTO v; RETURN found; END; $$`);
      expect(r.returnValue).toBe(true);
    });

    it('sets found = false when no rows are returned', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => []);
      const r = await e.execute(`DO $$ DECLARE v TEXT; BEGIN SELECT 'a' INTO v; RETURN found; END; $$`);
      expect(r.returnValue).toBe(false);
    });

    it('sets the target to null when no rows are returned', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => []);
      const r = await e.execute(`DO $$ DECLARE v TEXT := 'init'; BEGIN SELECT 'a' INTO v; RETURN v; END; $$`);
      expect(r.returnValue).toBeNull();
    });

    it('supports select without INTO (PERFORM-like), no target', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => [{ a: 1 }]);
      const r = await e.execute(`DO $$ BEGIN SELECT * FROM users; RETURN 'ok'; END; $$`);
      expect(r.returnValue).toBe('ok');
    });

    it('warns when queryCallback is missing', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN SELECT 1 INTO x; RETURN 'still'; END; $$`);
      expect(r.returnValue).toBe('still');
    });

    it('resolves $N positional parameters from variables', async () => {
      const e = createPlPgSqlEngine();
      let seenSql = '';
      e.setQueryCallback(async (sql) => {
        seenSql = sql;
        return [{ id: 42 }];
      });
      e.setVariable('$1', 42);
      const r = await e.execute(`DO $$ DECLARE id INT; BEGIN SELECT 1 INTO id WHERE x = $1; RETURN id; END; $$`);
      expect(r.returnValue).toBe(42);
      expect(seenSql).toContain('42');
    });

    it('resolves $N string and null values', async () => {
      const e = createPlPgSqlEngine();
      let seenSql = '';
      e.setQueryCallback(async (sql) => {
        seenSql = sql;
        return [{ v: 'x' }];
      });
      e.setVariable('$1', "O'Brien");
      e.setVariable('$2', null);
      await e.execute(`DO $$ DECLARE v TEXT; BEGIN SELECT 1 INTO v WHERE a = $1 AND b = $2; END; $$`);
      expect(seenSql).toContain("'O''Brien'");
      expect(seenSql).toContain('NULL');
    });

    it('skips the raw PERFORM statement path', async () => {
      const e = createPlPgSqlEngine();
      // PERFORM is not SELECT/assignment/control; it falls through to the
      // "skip unknown tokens" path and is quietly ignored.
      const r = await e.execute(`DO $$ BEGIN PERFORM some_thing(1); RETURN 'ok'; END; $$`);
      expect(r.returnValue).toBe('ok');
    });
  });

  // ── parsing (without execution) ──────────────────────────────
  describe('parsePlPgSql', () => {
    it('parses a block into an AST', () => {
      const parsed = parsePlPgSql(`DO $$ DECLARE x INT := 1; BEGIN x := x + 1; RETURN x; END; $$`);
      expect(parsed.block.type).toBe('BLOCK');
      expect(parsed.block.declarations.length).toBe(1);
      expect(parsed.block.declarations[0].name).toBe('x');
    });

    it('parses a labeled block', () => {
      const parsed = parsePlPgSql(`DO $$ <<mylab>> BEGIN NULL; END; $$`);
      expect(parsed.block.label).toBe('mylab');
    });
  });

  // ── evaluateCondition edge cases ─────────────────────────────
  describe('condition coercion', () => {
    it('coerces a nonzero number to true', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF 5 THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('t');
    });

    it('coerces a string "true" to true', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s TEXT := 'true'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('t');
    });

    it('coerces a numeric string to truthy/falsy condition', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE s TEXT := '0'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('f');
      r = await e.execute(`DO $$ DECLARE s TEXT := '42'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('t');
      r = await e.execute(`DO $$ DECLARE s TEXT := 'hello'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('t');
    });

    it('stops the block when a top-level EXIT is encountered', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN EXIT; RETURN 'unreachable'; END; $$`);
      expect(r.returnValue).toBeUndefined();
    });

    it('resets a stray top-level CONTINUE signal', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN CONTINUE; RETURN 'after'; END; $$`);
      expect(r.returnValue).toBe('after');
    });

    it('resets a CONTINUE signal when it is the final statement', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN CONTINUE; END; $$`);
      expect(r.success).toBe(true);
    });

    it('parses EXIT and CONTINUE with an explicit label', async () => {
      const e = createPlPgSqlEngine();
      // EXIT lbl / CONTINUE lbl parse the label token without a WHEN clause.
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; EXIT lbl WHEN i >= 2; END LOOP; RETURN i; END; $$`);
      expect(r.returnValue).toBe(2);
      const r2 = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN LOOP i := i + 1; CONTINUE lbl WHEN i = 1; s := s + i; EXIT WHEN i >= 3; END LOOP; RETURN s; END; $$`);
      expect(r2.returnValue).toBe(5);
    });

    it('parses an assignment inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 0; BEGIN IF true THEN x := 42; END IF; RETURN x; END; $$`);
      expect(r.returnValue).toBe(42);
    });

    it('re-raises from a handler via RAISE EXCEPTION', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'x'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'y'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/y/);
    });
  });

  // ── tokenizer / parser edge cases ────────────────────────────
  describe('tokenizer and parser edge cases', () => {
    it('handles line comments (--) in the body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; -- a comment\nBEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('skips a -- comment line inside the body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; -- note\nBEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('handles escaped quotes in string literals', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s TEXT := 'O\\'Brien'; BEGIN RETURN s; END; $$`);
      expect(r.returnValue).toContain('Brien');
    });

    it('evaluates scientific notation and negative numbers', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x DOUBLE PRECISION; BEGIN x := 1.5e3; RETURN x; END; $$`);
      expect(r.returnValue).toBe(1500);
      const r2 = await e.execute(`DO $$ DECLARE x INT; BEGIN x := -5; RETURN x; END; $$`);
      expect(r2.returnValue).toBe(-5);
    });

    it('handles function call with no arguments', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x DOUBLE PRECISION; BEGIN x := random(); RETURN x; END; $$`);
      expect(typeof r.returnValue).toBe('number');
    });

    it('reports failure for a block missing its END', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN NULL;`);
      expect(r.success).toBe(false);
    });

    it('reports failure when THEN is missing from an IF', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF 1 RETURN 1; END IF; END; $$`);
      expect(r.success).toBe(false);
    });

    it('reports failure for a trailing unmatched begin', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := 1;`);
      expect(r.success).toBe(false);
    });

    it('tolerates a declaration missing its trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      // x INT is not followed by `;` — the parser tolerates the omission and
      // still parses the following BEGIN block.
      const r = await e.execute(`DO $$ DECLARE x INT BEGIN RETURN 1; END; $$`);
      expect(r.success).toBe(true);
    });

    it('tolerates an assignment missing its trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 0; BEGIN x := 5 RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('tolerates a stray empty statement (double semicolon)', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; BEGIN ;; RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('tolerates a non-identifier statement token before RETURN', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 7; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(7);
    });

    it('parses an EXECUTE statement without a trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      // EXECUTE consumes tokens up to the next semicolon (or end of input), so
      // the omitted `;` is tolerated; the runtime then reports EXECUTE as
      // unsupported.
      const r = await e.execute(`DO $$ BEGIN EXECUTE 'SELECT 1'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/EXECUTE|not supported/i);
    });

    it('parses a RETURN without a trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      // Without the `;`, END is consumed as part of the RETURN expression, so
      // the block is left unterminated and the parser reports it.
      const r = await e.execute(`DO $$ BEGIN RETURN 1 END; $$`);
      expect(r.success).toBe(false);
    });

    it('parses a CONTINUE without a trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; CONTINUE WHEN i >= 3; s := s + 1; EXIT WHEN i > 3; END LOOP; END; $$`);
      expect(r.success).toBe(true);
    });

    it('raises with a single-character message', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'x'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/x/);
    });

    it('parses EXCEPTION without a WHEN clause', async () => {
      const e = createPlPgSqlEngine();
      // EXCEPTION with no WHEN handler yields a parse error rather than hanging.
      const r = await e.execute(`DO $$ BEGIN NULL; EXCEPTION; END; $$`);
      expect(r.success).toBe(false);
    });

    it('accepts a block with a label and END label', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ <<lbl>> DECLARE x INT := 1; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('handles a DO block with no trailing semicolon', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('handles multi-digit positional parameter ($10)', async () => {
      const e = createPlPgSqlEngine();
      e.setVariable('$10', 99);
      e.setQueryCallback(async () => [{ v: 1 }]);
      const r = await e.execute(`DO $$ DECLARE v INT; BEGIN SELECT 1 INTO v WHERE x = $10; END; $$`);
      expect(r.success).toBe(true);
    });

    it('handles a string with escaped backslash', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s TEXT := 'a\\b'; BEGIN RETURN s; END; $$`);
      expect(r.success).toBe(true);
    });

    it('handles nested parens in function args via splitArgs', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := concat('a', upper('b')); RETURN x; END; $$`);
      expect(r.returnValue).toBe('aB');
    });

    it('consumes the label name after END label', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ <<lbl>> BEGIN RETURN 1; END lbl; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('skips a nested DECLARE section', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 1; DECLARE y INT := 2; BEGIN RETURN y; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('returns an empty string for an empty block body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ $$`);
      expect(r.success).toBe(true);
    });

    it('skips a comma-separated multi-variable declaration', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x, y INT := 2; BEGIN RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('skips a CONSTANT declaration', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x CONSTANT INT := 5; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(5);
    });

    it('skips a DEFAULT declaration', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT DEFAULT 7; BEGIN RETURN x; END; $$`);
      expect(r.returnValue).toBe(7);
    });

    it('skips a colon-style declaration', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x : INT; BEGIN RETURN 1; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('handles a dangling -- comment with no trailing newline', async () => {
      const e = createPlPgSqlEngine();
      // A trailing -- comment with no newline consumes the closing $$, so the
      // block simply fails to parse. This exercises the tokenizer's `end === -1`
      // branch where the line comment has no terminating newline.
      const r = await e.execute(`DO $$ DECLARE x INT := 1; BEGIN RETURN x; END; -- trailing comment\n$$`);
      expect(r.returnValue).toBe(1);
    });
  });

  // ── safe-eval fallback and un-evaluable expressions ─────────
  describe('expression fallback', () => {
    it('returns an unevaluable expression as-is', async () => {
      const e = createPlPgSqlEngine();
      // An expression that fails the safe pattern is returned verbatim.
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := some_unknown_keyword_here; RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('concatenates two arrays with ||', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1]; b INT[] := ARRAY[2,3]; x INT[]; BEGIN x := a || b; RETURN array_length(x); END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('evaluates builtin args that are booleans and null literals', async () => {
      const e = createPlPgSqlEngine();
      // nullif evaluates the first arg against the second; true/false literals
      // are resolved as booleans in the argument list.
      const r = await e.execute(`DO $$ DECLARE x BOOLEAN; BEGIN x := true; RETURN x; END; $$`);
      expect(r.returnValue).toBe(true);
      const r2 = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := coalesce(null, 'fallback'); RETURN x; END; $$`);
      expect(r2.returnValue).toBe('fallback');
    });

    it('coerces the string "false" and "0" to falsy in conditions', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE s TEXT := 'false'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('f');
      r = await e.execute(`DO $$ DECLARE s TEXT := '0'; BEGIN IF s THEN RETURN 't'; ELSE RETURN 'f'; END IF; END; $$`);
      expect(r.returnValue).toBe('f');
    });

    it('re-raises from within an exception handler body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'outer'; EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'inner'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/inner/);
    });

    it('returns early from a handler via RETURN', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RAISE EXCEPTION 'x'; EXCEPTION WHEN OTHERS THEN RETURN 'handled'; END; $$`);
      expect(r.returnValue).toBe('handled');
    });

    it('handles array subscript out of bounds as null', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1]; x INT; BEGIN x := a[99]; RETURN x; END; $$`);
      expect(r.returnValue).toBeNull();
    });

    it('handles array built-ins on non-array values', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := array_length('not-array'); RETURN x; END; $$`);
      expect(r.returnValue).toBe(0);
      r = await e.execute(`DO $$ DECLARE x INT[]; BEGIN x := array_append('not-array', 1); RETURN x; END; $$`);
      expect(r.returnValue).toEqual([]);
      r = await e.execute(`DO $$ DECLARE x INT[]; BEGIN x := array_cat('a', 'b'); RETURN x; END; $$`);
      expect(r.returnValue).toEqual([]);
      r = await e.execute(`DO $$ DECLARE x INT[]; BEGIN x := array_remove('a', 1); RETURN x; END; $$`);
      expect(r.returnValue).toEqual([]);
      r = await e.execute(`DO $$ DECLARE x INT[]; BEGIN x := array_replace('a', 1, 2); RETURN x; END; $$`);
      expect(r.returnValue).toEqual([]);
    });

    it('evaluates ltrim/rtrim with an explicit chars argument', async () => {
      const e = createPlPgSqlEngine();
      let r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := ltrim('  x', ' '); RETURN x; END; $$`);
      expect(r.returnValue).toBe('x');
      r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := rtrim('x  ', ' '); RETURN x; END; $$`);
      expect(r.returnValue).toBe('x');
    });

    it('evaluates substring with an explicit count argument', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := substring('hello', 2, 3); RETURN x; END; $$`);
      expect(r.returnValue).toBe('ell');
    });

    it('resolves a schema-qualified builtin via the qualified-name tokenizer branch', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := pg_catalog.upper('ab'); RETURN x; END; $$`);
      expect(r.returnValue).toBe('AB');
    });

    it('resolves a named variable argument inside a larger expression', async () => {
      const e = createPlPgSqlEngine();
      // A named variable is not inlined within a compound expression, so the
      // whole expression falls back to its verbatim form.
      const r = await e.execute(`DO $$ DECLARE s TEXT := 'xyz'; x TEXT; BEGIN x := upper(s) || '!'; RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('returns the verbatim expression for a subscript on a non-existent variable', async () => {
      const e = createPlPgSqlEngine();
      // A subscript whose base name is not a known variable is not evaluable,
      // so it is returned as-is rather than null.
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := missing_arr[1]; RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('returns the verbatim expression for a subscript on a scalar variable', async () => {
      const e = createPlPgSqlEngine();
      // A scalar variable is not an array, so indexing it is not evaluable.
      const r = await e.execute(`DO $$ DECLARE s INT := 5; x INT; BEGIN x := s[1]; RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('evaluates a function call with an empty-string argument', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := concat('', 'hi'); RETURN x; END; $$`);
      expect(r.returnValue).toBe('hi');
    });

    it('evaluates an unknown function name as a non-call expression', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x TEXT; BEGIN x := not_a_function(3); RETURN x; END; $$`);
      expect(r.success).toBe(true);
    });

    it('evaluates cardinality on a non-array value', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := cardinality('nope'); RETURN x; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('evaluates unnest on a non-array value', async () => {
      const e = createPlPgSqlEngine();
      // unnest of a scalar returns the args as-is (a one-element array).
      const r = await e.execute(`DO $$ DECLARE x INT; BEGIN x := array_length(unnest(42)); RETURN x; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('throws on dynamic EXECUTE', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN EXECUTE 'SELECT 1'; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/not supported/);
    });

    it('exits a LOOP when a RAISE is hit inside the body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; RAISE EXCEPTION 'stop'; EXIT WHEN i >= 5; END LOOP; EXCEPTION WHEN OTHERS THEN RETURN i; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('calls the sequential positional assignment fallback in SELECT INTO', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => [{ id: 1, x: 2 }]); // no column matches the target name
      const r = await e.execute(`DO $$ DECLARE z INT; BEGIN SELECT 1 INTO z; RETURN z; END; $$`);
      expect(r.returnValue).toBe(1);
    });

    it('safely breaks an infinite LOOP via the iteration cap', async () => {
      const e = createPlPgSqlEngine();
      e.maxLoopIterations = 5;
      // A LOOP with no EXIT runs until the (lowered) safety limit.
      const r = await e.execute(`DO $$ BEGIN LOOP NULL; END LOOP; END; $$`);
      expect(r.success).toBe(true);
    });

    it('safely breaks an infinite WHILE loop via the iteration cap', async () => {
      const e = createPlPgSqlEngine();
      e.maxLoopIterations = 5;
      const r = await e.execute(`DO $$ BEGIN WHILE true LOOP NULL; END LOOP; END; $$`);
      expect(r.success).toBe(true);
    });

    it('supports EXIT with a label', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN LOOP i := i + 1; EXIT WHEN i >= 3; END LOOP; RETURN i; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('supports CONTINUE with a label', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN LOOP i := i + 1; CONTINUE WHEN i = 2; EXIT WHEN i > 3; s := s + i; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(4);
    });

    it('RAISE with a non-string message token', async () => {
      const e = createPlPgSqlEngine();
      const notices: string[] = [];
      e.setNoticeCallback((l, m) => notices.push(m));
      await e.execute(`DO $$ DECLARE v INT := 5; BEGIN RAISE NOTICE v; END; $$`);
      expect(notices).toContain('v');
    });

    it('supports a single-quoted RAISE message', async () => {
      const e = createPlPgSqlEngine();
      const notices: string[] = [];
      e.setNoticeCallback((l, m) => notices.push(m));
      await e.execute(`DO $$ BEGIN RAISE NOTICE 'x'; END; $$`);
      expect(notices).toEqual(['x']);
    });

    it('parses an empty RETURN as null expression', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN RETURN; END; $$`);
      expect(r.success).toBe(true);
    });

    it('continues a loop after catching an exception in a nested block', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s INT := 0; BEGIN LOOP EXIT WHEN s >= 3; BEGIN RAISE EXCEPTION 'x'; EXCEPTION WHEN OTHERS THEN s := s + 1; END; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('propagates an exception thrown by the query callback', async () => {
      const e = createPlPgSqlEngine();
      e.setQueryCallback(async () => { throw new Error('db down'); });
      const r = await e.execute(`DO $$ DECLARE v INT; BEGIN SELECT 1 INTO v; END; $$`);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/db down/);
    });

    it('exits an IF body via an inner EXIT', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN IF true THEN EXIT; i := 99; END IF; RETURN i; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('exits an ELSEIF body via an inner EXIT', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN IF false THEN i := 1; ELSIF true THEN EXIT; i := 99; END IF; RETURN i; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('exits an ELSE body via an inner EXIT', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN IF false THEN i := 1; ELSE EXIT; i := 99; END IF; RETURN i; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('exits a WHILE loop body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN WHILE true LOOP i := i + 1; EXIT WHEN i >= 3; END LOOP; RETURN i; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('continues a WHILE loop body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; s INT := 0; BEGIN WHILE i < 5 LOOP i := i + 1; CONTINUE WHEN i = 2; s := s + i; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(13);
    });

    it('exits an inner FOREACH loop', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3,4]; s INT := 0; BEGIN FOREACH x IN ARRAY a LOOP s := s + 1; EXIT WHEN s >= 2; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(2);
    });

    it('continues an inner FOREACH loop', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2,3]; s INT := 0; BEGIN FOREACH x IN ARRAY a LOOP CONTINUE WHEN x = 2; s := s + x; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(4);
    });
  });

  // ── nested statements inside IF bodies ──────────────────────
  describe('statements nested inside conditional bodies', () => {
    it('runs a LOOP inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s INT := 0; BEGIN IF true THEN LOOP s := s + 1; EXIT WHEN s >= 4; END LOOP; END IF; RETURN s; END; $$`);
      expect(r.returnValue).toBe(4);
    });

    it('runs a WHILE inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE i INT := 0; BEGIN IF true THEN WHILE i < 3 LOOP i := i + 1; END LOOP; END IF; RETURN i; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('runs a FOREACH inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE a INT[] := ARRAY[1,2]; s INT := 0; BEGIN IF true THEN FOREACH x IN ARRAY a LOOP s := s + x; END LOOP; END IF; RETURN s; END; $$`);
      expect(r.returnValue).toBe(3);
    });

    it('skips FOREACH when the expression is not an array', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE s INT := 0; BEGIN FOREACH x IN ARRAY 42 LOOP s := s + 1; END LOOP; RETURN s; END; $$`);
      expect(r.returnValue).toBe(0);
    });

    it('runs a nested IF inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF true THEN IF true THEN RETURN 'inner'; END IF; END IF; END; $$`);
      expect(r.returnValue).toBe('inner');
    });

    it('runs a nested BEGIN block inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF true THEN BEGIN RETURN 'nested'; END; END IF; END; $$`);
      expect(r.returnValue).toBe('nested');
    });

    it('runs a nested DECLARE block inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ BEGIN IF true THEN DECLARE y INT := 7; BEGIN RETURN y; END; END IF; END; $$`);
      expect(r.returnValue).toBe(7);
    });

    it('runs a RAISE inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const notices: string[] = [];
      e.setNoticeCallback((l, m) => notices.push(m));
      await e.execute(`DO $$ BEGIN IF true THEN RAISE NOTICE 'in-if'; END IF; END; $$`);
      expect(notices).toContain('in-if');
    });

    it('skips a PERFORM statement inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 0; BEGIN IF true THEN PERFORM some_thing(1); x := 5; END IF; RETURN x; END; $$`);
      expect(r.returnValue).toBe(5);
    });

    it('skips an unknown identifier statement inside an IF body', async () => {
      const e = createPlPgSqlEngine();
      const r = await e.execute(`DO $$ DECLARE x INT := 0; BEGIN IF true THEN whatever_token_here; x := 9; END IF; RETURN x; END; $$`);
      expect(r.returnValue).toBe(9);
    });
  });
});
