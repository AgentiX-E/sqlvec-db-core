/**
 * Unit tests for PlPgSqlExtended — extended PL/pgSQL control structures.
 *
 * Covers every exported function: detection helpers, extract helpers, and the
 * async execute* helpers (with mocked parser/db/context collaborators).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  detectWhileLoop,
  detectForLoop,
  detectForSelectLoop,
  detectForRangeLoop,
  detectContinue,
  detectSelectInto,
  extractIntoVariable,
  extractWhileLoop,
  executeWhileLoop,
  extractForSelectLoop,
  executeForSelectLoop,
  extractForRangeLoop,
  executeForRangeLoop,
  extractContinueCondition,
  extractSelectInto,
  executeSelectInto,
  hasExtendedControlStructure,
} from '../plpgsql/PlPgSqlExtended';

// ─────────────────────────────────────────────────────────────────────────────
// Detection functions
// ─────────────────────────────────────────────────────────────────────────────

describe('detectWhileLoop', () => {
  it('detects a WHILE ... LOOP block', () => {
    expect(detectWhileLoop('WHILE counter < 10 LOOP ... END LOOP')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(detectWhileLoop('while x > 0 loop end loop')).toBe(true);
  });
  it('returns false when no WHILE ... LOOP', () => {
    expect(detectWhileLoop('SELECT 1')).toBe(false);
  });
  it('returns false for a bare LOOP without WHILE', () => {
    expect(detectWhileLoop('LOOP ... END LOOP')).toBe(false);
  });
});

describe('detectForLoop', () => {
  it('detects FOR x IN SELECT', () => {
    expect(detectForLoop('FOR rec IN SELECT * FROM t LOOP END LOOP')).toBe(true);
  });
  it('detects FOR i IN 1..10', () => {
    expect(detectForLoop('FOR i IN 1..10 LOOP END LOOP')).toBe(true);
  });
  it('returns false without FOR ... IN', () => {
    expect(detectForLoop('SELECT 1')).toBe(false);
  });
});

describe('detectForSelectLoop', () => {
  it('detects FOR ... IN SELECT', () => {
    expect(detectForSelectLoop('FOR rec IN SELECT * FROM t LOOP END LOOP')).toBe(true);
  });
  it('returns false for a range loop', () => {
    expect(detectForSelectLoop('FOR i IN 1..10 LOOP END LOOP')).toBe(false);
  });
});

describe('detectForRangeLoop', () => {
  it('detects FOR i IN 1..10', () => {
    expect(detectForRangeLoop('FOR i IN 1..10 LOOP END LOOP')).toBe(true);
  });
  it('detects range loop with whitespace around ..', () => {
    expect(detectForRangeLoop('FOR i IN 1 .. 10 LOOP END LOOP')).toBe(true);
  });
  it('returns false for a select loop', () => {
    expect(detectForRangeLoop('FOR rec IN SELECT 1 LOOP END LOOP')).toBe(false);
  });
});

describe('detectContinue', () => {
  it('detects a bare CONTINUE', () => {
    expect(detectContinue('CONTINUE;')).toBe(true);
  });
  it('detects CONTINUE WHEN', () => {
    expect(detectContinue('CONTINUE WHEN counter < 5;')).toBe(true);
  });
  it('returns false when no CONTINUE', () => {
    expect(detectContinue('SELECT 1')).toBe(false);
  });
});

describe('detectSelectInto', () => {
  it('detects SELECT ... INTO var', () => {
    expect(detectSelectInto('SELECT x INTO v FROM t')).toBe(true);
  });
  it('detects SELECT ... INTO STRICT var', () => {
    expect(detectSelectInto('SELECT x INTO STRICT v FROM t')).toBe(true);
  });
  it('returns false when no INTO', () => {
    expect(detectSelectInto('SELECT x FROM t')).toBe(false);
  });
});

describe('hasExtendedControlStructure', () => {
  it('returns true for WHILE', () => {
    expect(hasExtendedControlStructure('WHILE x LOOP END LOOP')).toBe(true);
  });
  it('returns true for FOR', () => {
    expect(hasExtendedControlStructure('FOR i IN 1..10 LOOP END LOOP')).toBe(true);
  });
  it('returns true for CONTINUE', () => {
    expect(hasExtendedControlStructure('CONTINUE;')).toBe(true);
  });
  it('returns true for SELECT INTO', () => {
    expect(hasExtendedControlStructure('SELECT x INTO v FROM t')).toBe(true);
  });
  it('returns false when none present', () => {
    expect(hasExtendedControlStructure('SELECT 1')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractIntoVariable
// ─────────────────────────────────────────────────────────────────────────────

describe('extractIntoVariable', () => {
  it('extracts a plain INTO var', () => {
    expect(extractIntoVariable('SELECT x INTO v FROM t')).toBe('v');
  });
  it('extracts INTO STRICT var', () => {
    expect(extractIntoVariable('SELECT x INTO STRICT v FROM t')).toBe('v');
  });
  it('returns null when no INTO', () => {
    expect(extractIntoVariable('SELECT x FROM t')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractWhileLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('extractWhileLoop', () => {
  it('extracts condition and body', () => {
    const r = extractWhileLoop('WHILE x < 10 LOOP y := y + 1; END LOOP');
    expect(r!.condition).toBe('x < 10');
    expect(r!.body).toBe('y := y + 1;');
  });
  it('handles nested loops (inner LOOP/END LOOP)', () => {
    const r = extractWhileLoop(
      'WHILE a LOOP LOOP b; END LOOP; END LOOP',
    );
    expect(r!.condition).toBe('a');
    expect(r!.body).toBe('LOOP b; END LOOP;');
  });
  it('returns null when no WHILE ... LOOP', () => {
    expect(extractWhileLoop('SELECT 1')).toBeNull();
  });
  it('returns null when END LOOP is missing (unbalanced)', () => {
    expect(extractWhileLoop('WHILE a LOOP b;')).toBeNull();
  });
  it('handles deeply nested loops and unmatched inner END LOOP', () => {
    // body contains a nested LOOP whose END LOOP decrements depth but does not
    // close the outer loop (exercises the depth !== 0 branch)
    const r = extractWhileLoop('WHILE a LOOP LOOP b; END LOOP; END LOOP');
    expect(r!.condition).toBe('a');
    expect(r!.body).toBe('LOOP b; END LOOP;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeWhileLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('executeWhileLoop', () => {
  it('runs the body until the condition is false', async () => {
    const body = vi.fn(async () => {});
    let n = 0;
    const parser = { evaluateCondition: vi.fn(() => ++n < 3) };
    await executeWhileLoop(parser, { executeBody: body }, 'WHILE x LOOP b; END LOOP');
    // condition evaluated: 1,2,3 -> third is false, so body runs twice
    expect(parser.evaluateCondition).toHaveBeenCalledTimes(3);
    expect(body).toHaveBeenCalledTimes(2);
  });
  it('throws when the loop cannot be parsed', async () => {
    await expect(
      executeWhileLoop(
        { evaluateCondition: vi.fn(() => true) },
        { executeBody: vi.fn() },
        'SELECT 1',
      ),
    ).rejects.toThrow('Failed to parse WHILE loop');
  });
  it('stops at the max-iteration guard', async () => {
    // A never-false condition forces the loop to hit the 100000 iteration cap.
    const parser = { evaluateCondition: vi.fn(() => true) };
    const body = vi.fn(async () => {});
    await executeWhileLoop(parser, { executeBody: body }, 'WHILE x LOOP b; END LOOP');
    expect(parser.evaluateCondition).toHaveBeenCalledTimes(100000);
    expect(body).toHaveBeenCalledTimes(100000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractForSelectLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('extractForSelectLoop', () => {
  it('extracts variable, query and body', () => {
    const r = extractForSelectLoop('FOR rec IN SELECT * FROM t LOOP x := rec; END LOOP');
    expect(r!.variable).toBe('rec');
    expect(r!.query).toBe('SELECT * FROM t');
    expect(r!.body).toBe('x := rec;');
  });
  it('returns null when not a FOR-SELECT loop', () => {
    expect(extractForSelectLoop('SELECT 1')).toBeNull();
  });
  it('returns null when END LOOP is missing', () => {
    expect(extractForSelectLoop('FOR rec IN SELECT 1 LOOP x := 1;')).toBeNull();
  });
  it('handles a nested LOOP inside the body', () => {
    const r = extractForSelectLoop(
      'FOR rec IN SELECT 1 LOOP LOOP x := 1; END LOOP; END LOOP',
    );
    expect(r!.variable).toBe('rec');
    expect(r!.body).toBe('LOOP x := 1; END LOOP;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeForSelectLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('executeForSelectLoop', () => {
  it('iterates over returned rows, setting the variable per row', async () => {
    const db = {
      query: vi.fn(async () => ({ rows: [{ a: 1 }, { a: 2 }] })),
    };
    const setVariable = vi.fn();
    const executeBody = vi.fn(async () => {});
    await executeForSelectLoop(
      db,
      { executeBody, setVariable },
      'FOR rec IN SELECT a FROM t LOOP x := rec; END LOOP',
    );
    expect(db.query).toHaveBeenCalledWith('SELECT a FROM t');
    expect(setVariable).toHaveBeenCalledTimes(2);
    expect(setVariable).toHaveBeenNthCalledWith(1, 'rec', { a: 1 });
    expect(setVariable).toHaveBeenNthCalledWith(2, 'rec', { a: 2 });
    expect(executeBody).toHaveBeenCalledTimes(2);
  });
  it('iterates zero times over an empty result', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const executeBody = vi.fn(async () => {});
    await executeForSelectLoop(
      db,
      { executeBody, setVariable: vi.fn() },
      'FOR rec IN SELECT a FROM t LOOP x := rec; END LOOP',
    );
    expect(executeBody).not.toHaveBeenCalled();
  });
  it('treats a missing `rows` field as an empty result set', async () => {
    const db = { query: vi.fn(async () => ({})) };
    const executeBody = vi.fn(async () => {});
    await executeForSelectLoop(
      db,
      { executeBody, setVariable: vi.fn() },
      'FOR rec IN SELECT a FROM t LOOP x := rec; END LOOP',
    );
    expect(executeBody).not.toHaveBeenCalled();
  });
  it('throws when the loop cannot be parsed', async () => {
    await expect(
      executeForSelectLoop(
        { query: vi.fn() },
        { executeBody: vi.fn(), setVariable: vi.fn() },
        'SELECT 1',
      ),
    ).rejects.toThrow('Failed to parse FOR-SELECT loop');
  });
  it('wraps query errors', async () => {
    const db = { query: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(
      executeForSelectLoop(
        db,
        { executeBody: vi.fn(), setVariable: vi.fn() },
        'FOR rec IN SELECT a FROM t LOOP x := rec; END LOOP',
      ),
    ).rejects.toThrow('FOR query failed: boom');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractForRangeLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('extractForRangeLoop', () => {
  it('extracts variable, start, end and body', () => {
    const r = extractForRangeLoop('FOR i IN 1..10 LOOP x := i; END LOOP');
    expect(r!.variable).toBe('i');
    expect(r!.start).toBe(1);
    expect(r!.end).toBe(10);
    expect(r!.body).toBe('x := i;');
  });
  it('parses integer bounds', () => {
    const r = extractForRangeLoop('FOR i IN 3..7 LOOP x := i; END LOOP');
    expect(r!.start).toBe(3);
    expect(r!.end).toBe(7);
  });
  it('returns null when not a range loop', () => {
    expect(extractForRangeLoop('SELECT 1')).toBeNull();
  });
  it('returns null when END LOOP is missing', () => {
    expect(extractForRangeLoop('FOR i IN 1..3 LOOP x := i;')).toBeNull();
  });
  it('handles a nested LOOP inside the body', () => {
    const r = extractForRangeLoop('FOR i IN 1..3 LOOP LOOP x := i; END LOOP; END LOOP');
    expect(r!.variable).toBe('i');
    expect(r!.body).toBe('LOOP x := i; END LOOP;');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeForRangeLoop
// ─────────────────────────────────────────────────────────────────────────────

describe('executeForRangeLoop', () => {
  it('iterates inclusively from start to end', async () => {
    const setVariable = vi.fn();
    const executeBody = vi.fn(async () => {});
    await executeForRangeLoop(
      { executeBody, setVariable },
      'FOR i IN 1..3 LOOP x := i; END LOOP',
    );
    expect(setVariable).toHaveBeenCalledTimes(3);
    expect(setVariable).toHaveBeenNthCalledWith(1, 'i', 1);
    expect(setVariable).toHaveBeenNthCalledWith(2, 'i', 2);
    expect(setVariable).toHaveBeenNthCalledWith(3, 'i', 3);
    expect(executeBody).toHaveBeenCalledTimes(3);
  });
  it('does not iterate when start > end', async () => {
    const executeBody = vi.fn(async () => {});
    await executeForRangeLoop(
      { executeBody, setVariable: vi.fn() },
      'FOR i IN 5..2 LOOP x := i; END LOOP',
    );
    expect(executeBody).not.toHaveBeenCalled();
  });
  it('throws when the loop cannot be parsed', async () => {
    await expect(
      executeForRangeLoop(
        { executeBody: vi.fn(), setVariable: vi.fn() },
        'SELECT 1',
      ),
    ).rejects.toThrow('Failed to parse FOR range loop');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractContinueCondition
// ─────────────────────────────────────────────────────────────────────────────

describe('extractContinueCondition', () => {
  it('returns null for an unconditional CONTINUE', () => {
    expect(extractContinueCondition('CONTINUE;')).toBeNull();
  });
  it('extracts the WHEN condition', () => {
    expect(extractContinueCondition('CONTINUE WHEN counter < 5;')).toBe('counter < 5');
  });
  it('returns null for CONTINUE without a WHEN (trailing whitespace)', () => {
    expect(extractContinueCondition('CONTINUE ')).toBeNull();
  });
  it('returns null when no CONTINUE', () => {
    expect(extractContinueCondition('SELECT 1')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSelectInto
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSelectInto', () => {
  it('extracts variable and rewrites query without INTO', () => {
    const r = extractSelectInto('SELECT x INTO v FROM t');
    expect(r!.variable).toBe('v');
    expect(r!.query).toBe('SELECT x FROM t');
  });
  it('handles INTO STRICT', () => {
    const r = extractSelectInto('SELECT x INTO STRICT v FROM t WHERE id = 1');
    expect(r!.variable).toBe('v');
    expect(r!.query).toBe('SELECT x FROM t WHERE id = 1');
  });
  it('returns null when no INTO', () => {
    expect(extractSelectInto('SELECT x FROM t')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// executeSelectInto
// ─────────────────────────────────────────────────────────────────────────────

describe('executeSelectInto', () => {
  it('assigns the first column of the first row and marks found', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{ a: 42 }] })) };
    const setVariable = vi.fn();
    await executeSelectInto(
      'SELECT a INTO v FROM t',
      db,
      { setVariable },
    );
    expect(db.query).toHaveBeenCalledWith('SELECT a FROM t');
    expect(setVariable).toHaveBeenCalledWith('v', 42);
    expect(setVariable).toHaveBeenCalledWith('found', true);
  });
  it('sets variable to null and found false on zero rows', async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const setVariable = vi.fn();
    await executeSelectInto(
      'SELECT a INTO v FROM t',
      db,
      { setVariable },
    );
    expect(setVariable).toHaveBeenCalledWith('v', null);
    expect(setVariable).toHaveBeenCalledWith('found', false);
  });
  it('sets variable to null when the row has no keys', async () => {
    const db = { query: vi.fn(async () => ({ rows: [{}] })) };
    const setVariable = vi.fn();
    await executeSelectInto(
      'SELECT a INTO v FROM t',
      db,
      { setVariable },
    );
    expect(setVariable).toHaveBeenCalledWith('v', null);
    expect(setVariable).toHaveBeenCalledWith('found', true);
  });
  it('treats a missing `rows` field as zero rows', async () => {
    const db = { query: vi.fn(async () => ({})) };
    const setVariable = vi.fn();
    await executeSelectInto('SELECT a INTO v FROM t', db, { setVariable });
    expect(setVariable).toHaveBeenCalledWith('v', null);
    expect(setVariable).toHaveBeenCalledWith('found', false);
  });
  it('throws when the statement cannot be parsed', async () => {
    await expect(
      executeSelectInto('SELECT 1', { query: vi.fn() }, { setVariable: vi.fn() }),
    ).rejects.toThrow('Failed to parse SELECT INTO');
  });
  it('wraps query errors', async () => {
    const db = { query: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(
      executeSelectInto('SELECT a INTO v FROM t', db, { setVariable: vi.fn() }),
    ).rejects.toThrow('SELECT INTO failed: boom');
  });
});
