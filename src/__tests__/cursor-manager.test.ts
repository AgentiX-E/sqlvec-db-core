import { describe, it, expect, beforeEach } from 'vitest';
import { CursorManager } from '../query/CursorManager';

/**
 * CursorManager — DECLARE/FETCH/MOVE/CLOSE cursor lifecycle.
 *
 * Tests target real cursor semantics: forward/backward fetch directionality
 * (including PRIOR off-by-one fixes and ABSOLUTE/RELATIVE boundary handling),
 * non-scroll guards, and session-scoped cleanup.
 */

const ROWS = [['r0'], ['r1'], ['r2'], ['r3'], ['r4']];

function declareScroll(name = 'c'): CursorManager {
  const c = new CursorManager();
  c.declare(name, 'SELECT * FROM t', true, false, ROWS, ['col']);
  return c;
}

describe('declare / hasCursor / getCursor / listCursors', () => {
  it('declares a cursor at position -1 (before first)', () => {
    const c = declareScroll();
    expect(c.hasCursor('c')).toBe(true);
    expect(c.hasCursor('C')).toBe(true); // case-insensitive
    expect(c.getCursor('c')?.position).toBe(-1);
    expect(c.getCursor('c')?.rows).toEqual(ROWS);
    expect(c.getCursor('c')?.scroll).toBe(true);
  });

  it('throws when declaring a duplicate name', () => {
    const c = declareScroll();
    expect(() => c.declare('C', 'SELECT 1', false, false, [], [])).toThrow(
      /already exists/,
    );
  });

  it('lists cursor names and reports stats', () => {
    const c = new CursorManager();
    c.declare('b', 'SELECT 1', false, false, [], ['col']);
    c.declare('a', 'SELECT 2', false, false, [], ['col']);
    expect(c.listCursors().sort()).toEqual(['a', 'b']);
    expect(c.getStats().count).toBe(2);
  });

  it('hasCursor / getCursor return false/undefined for unknown', () => {
    const c = declareScroll();
    expect(c.hasCursor('nope')).toBe(false);
    expect(c.getCursor('nope')).toBeUndefined();
  });
});

describe('FETCH NEXT', () => {
  it('advances one row at a time from before-first', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'NEXT', 1)).toEqual([['r0']]);
    expect(c.fetch('c', 'NEXT', 1)).toEqual([['r1']]);
    expect(c.fetch('c', 'NEXT', 2)).toEqual([['r2'], ['r3']]);
    expect(c.getCursor('c')?.position).toBe(3);
  });

  it('clamps at the end without over-reading', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 4); // pos 3
    expect(c.fetch('c', 'NEXT', 10)).toEqual([['r4']]);
    expect(c.getCursor('c')?.position).toBe(4);
  });

  it('FETCH NEXT 0 returns no rows', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'NEXT', 0)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(-1);
  });
});

describe('FETCH PRIOR', () => {
  it('fetches a single prior row (off-by-one regression)', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 4); // pos 3
    expect(c.fetch('c', 'PRIOR', 1)).toEqual([['r2']]);
    expect(c.getCursor('c')?.position).toBe(2);
  });

  it('fetches multiple prior rows', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 4); // pos 3
    expect(c.fetch('c', 'PRIOR', 2)).toEqual([['r2'], ['r1']]);
    expect(c.getCursor('c')?.position).toBe(1);
  });

  it('throws on a non-scroll cursor', () => {
    const c = new CursorManager();
    c.declare('c', 'SELECT 1', false, false, ROWS, ['col']);
    expect(() => c.fetch('c', 'PRIOR', 1)).toThrow(/non-scroll/);
  });

  it('clamps at before-first', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 1); // pos 0 (on r0); no rows exist before it
    expect(c.fetch('c', 'PRIOR', 5)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(-1);
  });
});

describe('FETCH FIRST / LAST', () => {
  it('fetches the first N rows', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'FIRST', 2)).toEqual([['r0'], ['r1']]);
    expect(c.getCursor('c')?.position).toBe(1);
  });

  it('fetches the last N rows', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'LAST', 2)).toEqual([['r3'], ['r4']]);
    expect(c.getCursor('c')?.position).toBe(4);
  });
});

describe('FETCH ABSOLUTE', () => {
  it('positions at the n-th row (1-based)', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'ABSOLUTE', 3)).toEqual([['r2']]);
    expect(c.getCursor('c')?.position).toBe(2);
  });

  it('ABSOLUTE 0 positions before the first row (no row)', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'ABSOLUTE', 0)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(-1);
  });

  it('ABSOLUTE negative positions from the end', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'ABSOLUTE', -1)).toEqual([['r4']]);
    expect(c.getCursor('c')?.position).toBe(4);
  });

  it('ABSOLUTE beyond the end positions past the last row (no row)', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'ABSOLUTE', 99)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(4);
  });
});

describe('FETCH RELATIVE', () => {
  it('moves relative to the current position', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 3); // pos 2
    expect(c.fetch('c', 'RELATIVE', 1)).toEqual([['r3']]);
    expect(c.getCursor('c')?.position).toBe(3);
  });

  it('RELATIVE 0 stays on the current row', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 2); // pos 1
    expect(c.fetch('c', 'RELATIVE', 0)).toEqual([['r1']]);
  });

  it('RELATIVE negative moves backward (not clamped to first row)', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 1); // pos 0
    expect(c.fetch('c', 'RELATIVE', -1)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(-1);
  });

  it('RELATIVE positive beyond the end returns no row', () => {
    const c = declareScroll();
    c.fetch('c', 'NEXT', 4); // pos 4 (last)
    expect(c.fetch('c', 'RELATIVE', 5)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(4);
  });
});

describe('FETCH on an empty cursor', () => {
  it('returns an empty result for any direction', () => {
    const c = new CursorManager();
    c.declare('e', 'SELECT 1', true, false, [], ['col']);
    expect(c.fetch('e', 'NEXT', 1)).toEqual([]);
    expect(c.fetch('e', 'LAST', 1)).toEqual([]);
  });
});

describe('MOVE', () => {
  it('moves forward and returns the number of rows moved', () => {
    const c = declareScroll();
    expect(c.move('c', 'NEXT', 2)).toBe(2);
    expect(c.getCursor('c')?.position).toBe(1);
  });

  it('moves backward on a scroll cursor', () => {
    const c = declareScroll();
    c.move('c', 'NEXT', 3); // pos 2
    expect(c.move('c', 'PRIOR', 1)).toBe(1);
    expect(c.getCursor('c')?.position).toBe(1);
  });

  it('throws when moving backward on a non-scroll cursor', () => {
    const c = new CursorManager();
    c.declare('c', 'SELECT 1', false, false, ROWS, ['col']);
    expect(() => c.move('c', 'PRIOR', 1)).toThrow(/non-scroll/);
  });

  it('MOVE FIRST positions at the first rows', () => {
    const c = declareScroll();
    c.move('c', 'FIRST', 2);
    expect(c.getCursor('c')?.position).toBe(1);
  });

  it('MOVE LAST positions at the last row', () => {
    const c = declareScroll();
    c.move('c', 'LAST', 1);
    expect(c.getCursor('c')?.position).toBe(4);
  });

  it('MOVE ABSOLUTE handles 0 and negatives', () => {
    const c = declareScroll();
    expect(c.move('c', 'ABSOLUTE', 0)).toBe(0);
    expect(c.getCursor('c')?.position).toBe(-1);
    c.move('c', 'ABSOLUTE', -1);
    expect(c.getCursor('c')?.position).toBe(4);
  });

  it('MOVE RELATIVE moves backward', () => {
    const c = declareScroll();
    c.move('c', 'NEXT', 2); // pos 1
    c.move('c', 'RELATIVE', -1); // pos 0
    expect(c.getCursor('c')?.position).toBe(0);
  });

  it('throws when the cursor does not exist', () => {
    const c = declareScroll();
    expect(() => c.move('nope', 'NEXT', 1)).toThrow(/not found/);
  });
});

describe('error paths and unclassified directions', () => {
  it('fetch throws when the cursor does not exist', () => {
    const c = declareScroll();
    expect(() => c.fetch('nope', 'NEXT', 1)).toThrow(/not found/);
  });

  it('fetch falls back to NEXT for an unclassified direction', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'BOGUS' as any, 1)).toEqual([['r0']]);
    expect(c.getCursor('c')?.position).toBe(0);
  });

  it('fetch falls back to NEXT with zero count (stays before first)', () => {
    const c = declareScroll();
    expect(c.fetch('c', 'BOGUS' as any, 0)).toEqual([]);
    expect(c.getCursor('c')?.position).toBe(-1);
  });

  it('move falls back to NEXT for an unclassified direction', () => {
    const c = declareScroll();
    expect(c.move('c', 'BOGUS', 1)).toBe(1);
    expect(c.getCursor('c')?.position).toBe(0);
  });

  it('MOVE FIRST with count 0 positions before-first', () => {
    const c = declareScroll();
    c.move('c', 'NEXT', 2); // pos 1
    c.move('c', 'FIRST', 0);
    expect(c.getCursor('c')?.position).toBe(-1);
  });

  it('MOVE ABSOLUTE beyond the end clamps to last row', () => {
    const c = declareScroll();
    c.move('c', 'ABSOLUTE', 99);
    expect(c.getCursor('c')?.position).toBe(4);
  });

  it('MOVE ABSOLUTE negative before the first clamps to -1', () => {
    const c = declareScroll();
    c.move('c', 'ABSOLUTE', -99);
    expect(c.getCursor('c')?.position).toBe(-1);
  });
});

describe('close / closeAll / clear', () => {
  it('closes a single cursor (case-insensitive)', () => {
    const c = declareScroll();
    c.close('C');
    expect(c.hasCursor('c')).toBe(false);
  });

  it('close is a no-op for an unknown cursor', () => {
    const c = declareScroll();
    c.close('nope'); // should not throw
    expect(c.hasCursor('c')).toBe(true);
  });

  it('closes all cursors owned by a session', () => {
    const c = new CursorManager();
    c.declare('a', 'SELECT 1', false, false, ROWS, ['col'], 's1');
    c.declare('b', 'SELECT 2', false, false, ROWS, ['col'], 's1');
    c.declare('c2', 'SELECT 3', false, false, ROWS, ['col'], 's2');
    c.closeAll('s1');
    expect(c.listCursors()).toEqual(['c2']);
  });

  it('closeAll is a no-op for an unowned session', () => {
    const c = new CursorManager();
    c.declare('a', 'SELECT 1', false, false, ROWS, ['col'], 's1');
    c.closeAll('nobody');
    expect(c.listCursors()).toEqual(['a']);
  });

  it('clear removes every cursor', () => {
    const c = declareScroll();
    c.clear();
    expect(c.getStats().count).toBe(0);
  });
});
