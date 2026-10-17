import { describe, it, expect, vi } from 'vitest';
import {
  DMLTriggerManager,
  MAX_TRIGGER_DEPTH,
  type DMLTriggerDef,
  type DMLTriggerResult,
} from '../query/DMLTriggerManager';

function makeDef(overrides: Partial<DMLTriggerDef> = {}): DMLTriggerDef {
  return {
    name: 'trg',
    timing: 'BEFORE',
    event: 'INSERT',
    level: 'ROW',
    tableName: 'users',
    callback: async () => ({}),
    enabled: true,
    ...overrides,
  };
}

describe('DMLTriggerManager', () => {
  it('creates and drops triggers', () => {
    const m = new DMLTriggerManager();
    const cb = async () => ({});
    m.createTrigger(makeDef({ name: 'MyTrigger', callback: cb, tableName: 'Users' }));
    expect(m.getAllTriggers()).toHaveLength(1);
    // normalized lowercase
    expect(m.getAllTriggers()[0].tableName).toBe('users');
    expect(m.getAllTriggers()[0].name).toBe('MyTrigger');

    expect(m.dropTrigger('mytrigger')).toBe(true);
    expect(m.dropTrigger('missing')).toBe(false);
  });

  it('throws on duplicate trigger name (case-insensitive)', () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ name: 'trg' }));
    expect(() => m.createTrigger(makeDef({ name: 'TRG' }))).toThrow(/already exists/);
  });

  it('defaults enabled to true when not explicitly false', () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ enabled: undefined as any }));
    expect(m.getAllTriggers()[0].enabled).toBe(true);
  });

  it('fires before insert and modifies row', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({
        callback: async (ctx) => ({ row: { ...ctx.newRow, name: 'MODIFIED' } }),
      }),
    );
    const result = await m.fireBeforeInsert('users', { id: 1, name: 'orig' });
    expect(result).toEqual({ id: 1, name: 'MODIFIED' });
  });

  it('returns null when before insert is skipped', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ callback: async () => ({ skip: true }) }));
    expect(await m.fireBeforeInsert('users', { id: 1 })).toBeNull();
  });

  it('throws on before insert error', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ callback: async () => ({ error: 'denied' }) }));
    await expect(m.fireBeforeInsert('users', { id: 1 })).rejects.toThrow('denied');
  });

  it('fires after insert', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ timing: 'AFTER', callback: cb }));
    await m.fireAfterInsert('users', { id: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].operation).toBe('INSERT');
  });

  it('fires before update with old/new row', async () => {
    const m = new DMLTriggerManager();
    let captured: any;
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        callback: async (ctx) => {
          captured = ctx;
          return { row: { ...ctx.newRow, n: 99 } };
        },
      }),
    );
    const result = await m.fireBeforeUpdate('users', { id: 1, n: 1 }, { id: 1, n: 2 });
    expect(captured.oldRow).toEqual({ id: 1, n: 1 });
    expect(result).toEqual({ id: 1, n: 99 });
  });

  it('fires after update', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ timing: 'AFTER', event: 'UPDATE', callback: cb }));
    await m.fireAfterUpdate('users', { id: 1 }, { id: 1, n: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires before delete and returns proceed/cancel', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'DELETE', callback: cb }));
    expect(await m.fireBeforeDelete('users', { id: 1 })).toBe(true);

    const m2 = new DMLTriggerManager();
    m2.createTrigger(makeDef({ event: 'DELETE', callback: async () => ({ skip: true }) }));
    expect(await m2.fireBeforeDelete('users', { id: 1 })).toBe(false);
  });

  it('fires after delete', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ timing: 'AFTER', event: 'DELETE', callback: cb }));
    await m.fireAfterDelete('users', { id: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires truncate triggers', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'TRUNCATE', callback: cb, level: 'STATEMENT' }));
    await m.fireTruncate('users');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('throws on truncate error', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ event: 'TRUNCATE', callback: async () => ({ error: 'no' }) }));
    await expect(m.fireTruncate('users')).rejects.toThrow('no');
  });

  it('fires instead of insert', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({ row: { id: 1 } }));
    m.createTrigger(makeDef({ timing: 'INSTEAD OF', cb, callback: cb }));
    const result = await m.fireInsteadOfInsert('users', { id: 1 });
    expect(result).toEqual({ row: { id: 1 } });
  });

  it('returns skip when no instead of insert trigger found', async () => {
    const m = new DMLTriggerManager();
    const result = await m.fireInsteadOfInsert('users', { id: 1 });
    expect(result.skip).toBe(true);
    expect(result.error).toContain('no INSTEAD OF INSERT');
  });

  it('respects WHEN condition (heuristic, no PGlite)', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    // IS DISTINCT FROM → fires only when differs
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: 'OLD.n IS DISTINCT FROM NEW.n',
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { n: 1 }, { n: 2 });
    expect(cb).toHaveBeenCalledTimes(1);

    await m.fireBeforeUpdate('users', { n: 1 }, { n: 1 });
    expect(cb).toHaveBeenCalledTimes(1); // not fired when equal
  });

  it('evaluates heuristic comparison operators', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: 'NEW.age > 18',
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { age: 20 }, { age: 25 });
    expect(cb).toHaveBeenCalledTimes(1);
    await m.fireBeforeUpdate('users', { age: 20 }, { age: 10 });
    expect(cb).toHaveBeenCalledTimes(1); // not fired
  });

  it('evaluates IS NOT DISTINCT FROM', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: 'OLD.x IS NOT DISTINCT FROM NEW.x',
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { x: 5 }, { x: 5 });
    expect(cb).toHaveBeenCalledTimes(1);
    await m.fireBeforeUpdate('users', { x: 5 }, { x: 6 });
    expect(cb).toHaveBeenCalledTimes(1); // not fired
  });

  it('evaluates heuristic comparison operators (=, <, <=, !=, <>)', async () => {
    // oldRow.n = 5 fixed; verify each operator against varying NEW.n
    const cases: Array<[string, number, boolean]> = [
      ['OLD.n = NEW.n', 5, true],
      ['OLD.n = NEW.n', 6, false],
      ['OLD.n < NEW.n', 8, true],
      ['OLD.n < NEW.n', 3, false],
      ['OLD.n <= NEW.n', 5, true],
      ['OLD.n <= NEW.n', 4, false],
      ['OLD.n != NEW.n', 1, true],
      ['OLD.n != NEW.n', 5, false],
      ['OLD.n <> NEW.n', 1, true],
      ['OLD.n > NEW.n', 2, true],
      ['OLD.n > NEW.n', 9, false],
      ['OLD.n >= NEW.n', 5, true],
      ['OLD.n >= NEW.n', 6, false],
    ];
    for (const [cond, newN, shouldFire] of cases) {
      const m = new DMLTriggerManager();
      const cb = vi.fn(async () => ({}));
      m.createTrigger(makeDef({ event: 'UPDATE', whenCondition: cond, callback: cb }));
      await m.fireBeforeUpdate('users', { n: 5 }, { n: newN });
      expect(cb).toHaveBeenCalledTimes(shouldFire ? 1 : 0);
    }
  });

  it('evaluates literal string/number/null right-hand comparison', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: "NEW.grade = 'A'", callback: cb }),
    );
    await m.fireBeforeUpdate('users', { grade: 'A' }, { grade: 'A' });
    expect(cb).toHaveBeenCalledTimes(1);

    // numeric literal comparison
    const m2 = new DMLTriggerManager();
    const cb2 = vi.fn(async () => ({}));
    m2.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: 'NEW.score > 90', callback: cb2 }),
    );
    await m2.fireBeforeUpdate('users', { score: 95 }, { score: 95 });
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('resolves direct column names (no OLD/NEW prefix) in heuristic', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: 'age > 18', callback: cb }),
    );
    await m.fireBeforeUpdate('users', { age: 20 }, { age: 25 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('uses PGliteEngine for WHEN evaluation when available', async () => {
    const m = new DMLTriggerManager();
    const evaluate = vi.fn(async () => ({ rows: [{ result: 1 }] }));
    m.setPGliteEngine({ evaluate } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: 'OLD.a = NEW.a',
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(evaluate).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns false when PGlite WHEN evaluation fails', async () => {
    const m = new DMLTriggerManager();
    m.setPGliteEngine({
      evaluate: async () => {
        throw new Error('sql error');
      },
    } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: 'bad condition',
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('builds values with NULL, number, and string escaping via PGlite', async () => {
    const m = new DMLTriggerManager();
    const evaluate = vi.fn(async () => ({ rows: [{ result: true }] }));
    m.setPGliteEngine({ evaluate } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: "OLD.a IS DISTINCT FROM NEW.a OR NEW.note = 'o''x'",
        callback: cb,
      }),
    );
    // oldRow has a, newRow has null + string with quote + number
    await m.fireBeforeUpdate('users', { a: 1 }, { a: null, note: "o'x", n: 42 });
    expect(evaluate).toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handles various PGlite result truthy values', async () => {
    const truthyValues = [1, true, '1'];
    for (const val of truthyValues) {
      const m = new DMLTriggerManager();
      m.setPGliteEngine({ evaluate: async () => ({ rows: [{ result: val }] }) } as any);
      const cb = vi.fn(async () => ({}));
      m.createTrigger(makeDef({ event: 'UPDATE', whenCondition: '1=1', callback: cb }));
      await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
      expect(cb).toHaveBeenCalledTimes(1);
    }

    // falsy result value → not fired
    const m2 = new DMLTriggerManager();
    m2.setPGliteEngine({ evaluate: async () => ({ rows: [{ result: 0 }] }) } as any);
    const cb2 = vi.fn(async () => ({}));
    m2.createTrigger(makeDef({ event: 'UPDATE', whenCondition: '1=1', callback: cb2 }));
    await m2.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(cb2).not.toHaveBeenCalled();
  });

  it('handles empty result rows from PGlite (assumes true)', async () => {
    const m = new DMLTriggerManager();
    m.setPGliteEngine({ evaluate: async () => ({ rows: [] }) } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'UPDATE', whenCondition: '1=1', callback: cb }));
    await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('parses null and string literals in heuristic', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: 'NEW.x = null', callback: cb }),
    );
    await m.fireBeforeUpdate('users', { x: null }, { x: null });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('falls back to true for unparseable heuristic condition', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: 'some_unknown_expression', callback: cb }),
    );
    await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('raises depth limit on update, delete, truncate, instead-of', async () => {
    const mk = () => {
      const m = new DMLTriggerManager();
      m.createTrigger(makeDef({}));
      m['callDepth'] = MAX_TRIGGER_DEPTH;
      return m;
    };
    await expect(mk().fireBeforeInsert('users', { id: 1 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireAfterInsert('users', { id: 1 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireBeforeUpdate('users', { id: 1 }, { id: 2 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireAfterUpdate('users', { id: 1 }, { id: 2 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireBeforeDelete('users', { id: 1 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireAfterDelete('users', { id: 1 })).rejects.toThrow(/depth limit/);
    await expect(mk().fireTruncate('users')).rejects.toThrow(/depth limit/);
    await expect(mk().fireInsteadOfInsert('users', { id: 1 })).rejects.toThrow(/depth limit/);
  });

  it('raises error on before update error and skip branches', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({ event: 'UPDATE', callback: async () => ({ error: 'x' }) }));
    await expect(m.fireBeforeUpdate('users', { id: 1 }, { id: 2 })).rejects.toThrow('x');
  });

  it('evaluates WHEN via PGlite for INSERT (oldRow null) and DELETE (newRow null)', async () => {
    // INSERT: oldRow undefined → builds only NEW columns
    const m1 = new DMLTriggerManager();
    const eval1 = vi.fn(async () => ({ rows: [{ result: 1 }] }));
    m1.setPGliteEngine({ evaluate: eval1 } as any);
    const cb1 = vi.fn(async () => ({}));
    m1.createTrigger(makeDef({ event: 'INSERT', whenCondition: 'NEW.id = 1', callback: cb1 }));
    await m1.fireBeforeInsert('users', { id: 1 });
    expect(cb1).toHaveBeenCalledTimes(1);

    // DELETE: newRow undefined → builds only OLD columns
    const m2 = new DMLTriggerManager();
    const eval2 = vi.fn(async () => ({ rows: [{ result: '1' }] }));
    m2.setPGliteEngine({ evaluate: eval2 } as any);
    const cb2 = vi.fn(async () => ({}));
    m2.createTrigger(makeDef({ event: 'DELETE', whenCondition: 'OLD.id = 1', callback: cb2 }));
    await m2.fireBeforeDelete('users', { id: 1 });
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('resolves direct column names against newRow in heuristic', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'UPDATE', whenCondition: 'score > 80', callback: cb }));
    // oldRow lacks `score`, so the direct column resolves against newRow
    await m.fireBeforeUpdate('users', { id: 1 }, { id: 1, score: 90 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('parses null literal in heuristic comparison', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: 'OLD.deleted_at IS DISTINCT FROM null', callback: cb }),
    );
    await m.fireBeforeUpdate('users', { deleted_at: null }, { deleted_at: null });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires statement-level triggers without WHEN condition', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ name: 'st-upd', event: 'UPDATE', level: 'STATEMENT', callback: cb }));
    await m.fireBeforeUpdate('users', { id: 1 }, { id: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires truncate with multiple triggers (exercises sort comparator)', async () => {
    const m = new DMLTriggerManager();
    const order: string[] = [];
    m.createTrigger(
      makeDef({ name: 'z_trg', event: 'TRUNCATE', level: 'STATEMENT', callback: async () => { order.push('z'); return {}; } }),
    );
    m.createTrigger(
      makeDef({ name: 'a_trg', event: 'TRUNCATE', level: 'STATEMENT', callback: async () => { order.push('a'); return {}; } }),
    );
    await m.fireTruncate('users');
    expect(order).toEqual(['a', 'z']);
  });

  it('passes string values through PGlite value escaping (oldRow)', async () => {
    const m = new DMLTriggerManager();
    const evaluate = vi.fn(async () => ({ rows: [{ result: 1 }] }));
    m.setPGliteEngine({ evaluate } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'UPDATE',
        whenCondition: "OLD.name = 'Alice'",
        callback: cb,
      }),
    );
    await m.fireBeforeUpdate('users', { name: 'Alice' }, { name: 'Alice' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('defaults to true when PGlite result is null', async () => {
    const m = new DMLTriggerManager();
    m.setPGliteEngine({ evaluate: async () => ({ rows: [{ result: null }] }) } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'UPDATE', whenCondition: '1=1', callback: cb }));
    await m.fireBeforeUpdate('users', { a: 1 }, { a: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('parses plain identifier literal in heuristic comparison', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    // 'foo' is neither numeric, quoted, nor null → parsed as bare string
    m.createTrigger(
      makeDef({ event: 'UPDATE', whenCondition: "OLD.status = active", callback: cb }),
    );
    await m.fireBeforeUpdate('users', { status: 'active' }, { status: 'active' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ignores WHEN on statement-level before delete and after update/delete', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ name: 'bd', event: 'DELETE', level: 'STATEMENT', whenCondition: 'OLD.id > 5', callback: cb }),
    );
    await m.fireBeforeDelete('users', { id: 1 });
    // statement-level triggers ignore WHEN → always fire
    expect(cb).toHaveBeenCalledTimes(1);

    const m2 = new DMLTriggerManager();
    const cb2 = vi.fn(async () => ({}));
    m2.createTrigger(
      makeDef({ name: 'au', timing: 'AFTER', event: 'UPDATE', level: 'STATEMENT', whenCondition: 'OLD.id > 5', callback: cb2 }),
    );
    await m2.fireAfterUpdate('users', { id: 1 }, { id: 1 });
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('ignores WHEN on statement-level after insert', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ name: 'ai', timing: 'AFTER', level: 'STATEMENT', whenCondition: 'NEW.id > 5', callback: cb }),
    );
    await m.fireAfterInsert('users', { id: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('returns true for empty column set with PGlite', async () => {
    const m = new DMLTriggerManager();
    m.setPGliteEngine({ evaluate: vi.fn(async () => ({ rows: [{ result: 1 }] })) } as any);
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({
        event: 'INSERT',
        whenCondition: '1 = 1',
        callback: cb,
      }),
    );
    await m.fireBeforeInsert('users', {});
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires statement-level before insert', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ level: 'STATEMENT', callback: cb }));
    await m.fireBeforeInsert('users', { id: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires statement-level after triggers', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ timing: 'AFTER', level: 'STATEMENT', callback: cb }));
    await m.fireAfterInsert('users', { id: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handles statement-level before insert error and skip', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({ level: 'STATEMENT', callback: async () => ({ error: 'boom' }) }),
    );
    await expect(m.fireBeforeInsert('users', { id: 1 })).rejects.toThrow('boom');

    const m2 = new DMLTriggerManager();
    m2.createTrigger(
      makeDef({ level: 'STATEMENT', callback: async () => ({ skip: true }) }),
    );
    expect(await m2.fireBeforeInsert('users', { id: 1 })).toBeNull();
  });

  it('ignores WHEN condition for statement-level triggers (PG semantics)', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ level: 'STATEMENT', whenCondition: 'NEW.id > 100', callback: cb }),
    );
    await m.fireBeforeInsert('users', { id: 1 });
    // statement-level triggers ignore WHEN → always fire
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handles statement-level before update error and skip', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({ event: 'UPDATE', level: 'STATEMENT', callback: async () => ({ error: 'no' }) }),
    );
    await expect(m.fireBeforeUpdate('users', { id: 1 }, { id: 2 })).rejects.toThrow('no');

    const m2 = new DMLTriggerManager();
    m2.createTrigger(
      makeDef({ event: 'UPDATE', level: 'STATEMENT', callback: async () => ({ skip: true }) }),
    );
    expect(await m2.fireBeforeUpdate('users', { id: 1 }, { id: 2 })).toBeNull();
  });

  it('fires statement-level before update', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ event: 'UPDATE', level: 'STATEMENT', callback: cb }));
    await m.fireBeforeUpdate('users', { id: 1 }, { id: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('handles before update error and skip', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({ event: 'UPDATE', callback: async () => ({ error: 'denied' }) }),
    );
    await expect(m.fireBeforeUpdate('users', { id: 1 }, { id: 2 })).rejects.toThrow('denied');

    const m2 = new DMLTriggerManager();
    m2.createTrigger(
      makeDef({ event: 'UPDATE', callback: async () => ({ skip: true }) }),
    );
    expect(await m2.fireBeforeUpdate('users', { id: 1 }, { id: 2 })).toBeNull();
  });

  it('respects WHEN condition on after update', async () => {
    const m = new DMLTriggerManager();
    const cb = vi.fn(async () => ({}));
    m.createTrigger(
      makeDef({ timing: 'AFTER', event: 'UPDATE', whenCondition: 'OLD.n <> NEW.n', callback: cb }),
    );
    await m.fireAfterUpdate('users', { n: 1 }, { n: 1 });
    expect(cb).not.toHaveBeenCalled();
  });

  it('handles before delete error and skip', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({ event: 'DELETE', callback: async () => ({ error: 'denied' }) }),
    );
    await expect(m.fireBeforeDelete('users', { id: 1 })).rejects.toThrow('denied');

    const m2 = new DMLTriggerManager();
    m2.createTrigger(
      makeDef({ event: 'DELETE', callback: async () => ({ skip: true }) }),
    );
    expect(await m2.fireBeforeDelete('users', { id: 1 })).toBe(false);
  });

  it('handles statement-level before delete error and skip', async () => {
    const m = new DMLTriggerManager();
    m.createTrigger(
      makeDef({ event: 'DELETE', level: 'STATEMENT', callback: async () => ({ error: 'no' }) }),
    );
    await expect(m.fireBeforeDelete('users', { id: 1 })).rejects.toThrow('no');

    const m2 = new DMLTriggerManager();
    m2.createTrigger(
      makeDef({ event: 'DELETE', level: 'STATEMENT', callback: async () => ({ skip: true }) }),
    );
    expect(await m2.fireBeforeDelete('users', { id: 1 })).toBe(false);
  });

  it('fires after-insert/after-delete/before-update row-level triggers when WHEN is met', async () => {
    // AFTER INSERT (row-level, met)
    const mai = new DMLTriggerManager();
    const cbai = vi.fn(async () => ({}));
    mai.createTrigger(makeDef({ timing: 'AFTER', whenCondition: 'NEW.id = 1', callback: cbai }));
    await mai.fireAfterInsert('users', { id: 1 });
    expect(cbai).toHaveBeenCalledTimes(1);

    // BEFORE UPDATE (row-level, met)
    const mu = new DMLTriggerManager();
    const cbu = vi.fn(async () => ({}));
    mu.createTrigger(makeDef({ event: 'UPDATE', whenCondition: 'OLD.id = 1', callback: cbu }));
    await mu.fireBeforeUpdate('users', { id: 1 }, { id: 2 });
    expect(cbu).toHaveBeenCalledTimes(1);

    // AFTER DELETE (row-level, met)
    const mad = new DMLTriggerManager();
    const cbad = vi.fn(async () => ({}));
    mad.createTrigger(makeDef({ timing: 'AFTER', event: 'DELETE', whenCondition: 'OLD.id = 1', callback: cbad }));
    await mad.fireAfterDelete('users', { id: 1 });
    expect(cbad).toHaveBeenCalledTimes(1);

    // AFTER UPDATE (row-level, met)
    const mau = new DMLTriggerManager();
    const cbau = vi.fn(async () => ({}));
    mau.createTrigger(makeDef({ timing: 'AFTER', event: 'UPDATE', whenCondition: 'OLD.id = 1', callback: cbau }));
    await mau.fireAfterUpdate('users', { id: 1 }, { id: 2 });
    expect(cbau).toHaveBeenCalledTimes(1);
  });

  it('skips after-delete row-level trigger when WHEN is unmet', async () => {
    const mad = new DMLTriggerManager();
    const cbad = vi.fn(async () => ({}));
    mad.createTrigger(makeDef({ timing: 'AFTER', event: 'DELETE', whenCondition: 'OLD.id > 100', callback: cbad }));
    await mad.fireAfterDelete('users', { id: 1 });
    expect(cbad).not.toHaveBeenCalled();
  });

  it('skips row-level triggers when WHEN is unmet across all events', async () => {
    // INSERT (row-level, unmet)
    const mi = new DMLTriggerManager();
    const cbi = vi.fn(async () => ({}));
    mi.createTrigger(makeDef({ whenCondition: 'NEW.id > 100', callback: cbi }));
    await mi.fireBeforeInsert('users', { id: 1 });
    expect(cbi).not.toHaveBeenCalled();

    // AFTER INSERT (row-level, unmet)
    const mai = new DMLTriggerManager();
    const cbai = vi.fn(async () => ({}));
    mai.createTrigger(makeDef({ timing: 'AFTER', whenCondition: 'NEW.id > 100', callback: cbai }));
    await mai.fireAfterInsert('users', { id: 1 });
    expect(cbai).not.toHaveBeenCalled();

    // UPDATE (row-level, unmet)
    const mu = new DMLTriggerManager();
    const cbu = vi.fn(async () => ({}));
    mu.createTrigger(makeDef({ event: 'UPDATE', whenCondition: 'OLD.id > 100', callback: cbu }));
    await mu.fireBeforeUpdate('users', { id: 1 }, { id: 1 });
    expect(cbu).not.toHaveBeenCalled();

    // DELETE (row-level, unmet)
    const md = new DMLTriggerManager();
    const cbd = vi.fn(async () => ({}));
    md.createTrigger(makeDef({ event: 'DELETE', whenCondition: 'OLD.id > 100', callback: cbd }));
    await md.fireBeforeDelete('users', { id: 1 });
    expect(cbd).not.toHaveBeenCalled();
  });

  it('fires statement-level after update and delete', async () => {
    const m = new DMLTriggerManager();
    const cb1 = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ name: 'upd', timing: 'AFTER', event: 'UPDATE', level: 'STATEMENT', callback: cb1 }));
    await m.fireAfterUpdate('users', { id: 1 }, { id: 2 });
    expect(cb1).toHaveBeenCalledTimes(1);

    const cb2 = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ name: 'del', timing: 'AFTER', event: 'DELETE', level: 'STATEMENT', callback: cb2 }));
    await m.fireAfterDelete('users', { id: 1 });
    expect(cb2).toHaveBeenCalledTimes(1);

    const cb3 = vi.fn(async () => ({}));
    m.createTrigger(makeDef({ name: 'delbefore', event: 'DELETE', level: 'STATEMENT', callback: cb3 }));
    await m.fireBeforeDelete('users', { id: 1 });
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it('sorts same-event triggers alphabetically', async () => {
    const m = new DMLTriggerManager();
    const order: string[] = [];
    m.createTrigger(makeDef({ name: 'beta', callback: async () => { order.push('beta'); return {}; } }));
    m.createTrigger(makeDef({ name: 'alpha', callback: async () => { order.push('alpha'); return {}; } }));
    await m.fireBeforeInsert('users', { id: 1 });
    expect(order).toEqual(['alpha', 'beta']);
  });

  it('enforces trigger depth limit', async () => {
    const m = new DMLTriggerManager();
    // set depth to MAX then verify depth exceeded check
    for (let i = 0; i < MAX_TRIGGER_DEPTH; i++) {
      m['callDepth'] = i;
    }
    m['callDepth'] = MAX_TRIGGER_DEPTH;
    await expect(m.fireBeforeInsert('users', { id: 1 })).rejects.toThrow(/depth limit/);
  });

  it('tracks call depth across operations', async () => {
    const m = new DMLTriggerManager();
    expect(m.getCallDepth()).toBe(0);
    m.resetCallDepth();
    expect(m.getCallDepth()).toBe(0);
  });

  it('parses CREATE TRIGGER SQL', () => {
    const m = new DMLTriggerManager();
    const parsed = m.parseCreateTriggerSQL(
      'CREATE TRIGGER audit BEFORE UPDATE OF name ON users FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION audit_fn()',
    );
    expect(parsed).toEqual({
      name: 'audit',
      timing: 'BEFORE',
      event: 'UPDATE',
      level: 'ROW',
      tableName: 'users',
      whenCondition: 'OLD.name IS DISTINCT FROM NEW.name',
    });
  });

  it('defaults level to ROW and handles INSTEAD OF timing', () => {
    const m = new DMLTriggerManager();
    expect(m.parseCreateTriggerSQL('CREATE TRIGGER t INSTEAD OF DELETE ON vw')).toEqual({
      name: 't',
      timing: 'INSTEAD OF',
      event: 'DELETE',
      level: 'ROW',
      tableName: 'vw',
      whenCondition: undefined,
    });
    expect(m.parseCreateTriggerSQL('SELECT 1')).toBeNull();
  });

  it('resets all state', () => {
    const m = new DMLTriggerManager();
    m.createTrigger(makeDef({}));
    m.reset();
    expect(m.getAllTriggers()).toEqual([]);
    expect(m.getCallDepth()).toBe(0);
  });
});
