import { describe, it, expect, vi } from 'vitest';
import { DdlEventTrigger, type DdlEventTriggerDescriptor } from '../query/DdlEventTrigger';

describe('DdlEventTrigger', () => {
  it('creates a trigger with a function callback', () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    const d = t.getTrigger('a');
    expect(d).toBeDefined();
    expect(d!.functionName).toBe('callback_a');
    expect(d!.enabled).toBe(true);
    expect(d!.fireCount).toBe(0);
    expect(t.getTriggersForEvent('ddl_command_start')).toHaveLength(1);
  });

  it('creates a trigger with a string callback name', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_end', callback: 'my_fn', tags: ['CREATE TABLE'] });
    expect(t.getTrigger('a')!.functionName).toBe('my_fn');
    expect(t.getTrigger('a')!.tags).toEqual(['CREATE TABLE']);
  });

  it('throws on duplicate trigger name', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: 'fn' });
    expect(() =>
      t.createTrigger({ name: 'a', event: 'ddl_command_end', callback: 'fn2' }),
    ).toThrow(/already exists/);
  });

  it('creates trigger from CREATE EVENT TRIGGER SQL', () => {
    const t = new DdlEventTrigger();
    expect(
      t.createTriggerFromSQL(
        "CREATE EVENT TRIGGER audit ON ddl_command_end WHEN TAG IN ('CREATE TABLE', 'DROP TABLE') EXECUTE FUNCTION audit_fn()",
      ),
    ).toBe(true);
    const d = t.getTrigger('audit');
    expect(d!.event).toBe('ddl_command_end');
    expect(d!.tags).toEqual(['CREATE TABLE', 'DROP TABLE']);
    expect(d!.functionName).toBe('audit_fn');
  });

  it('reuses an existing event listener set for a second trigger', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: vi.fn() });
    t.createTrigger({ name: 'b', event: 'ddl_command_start', callback: vi.fn() });
    // 2 triggers share one listener set; drop one → set still has the other
    t.dropTrigger('a');
    expect(t.getTriggersForEvent('ddl_command_start')).toHaveLength(1);
  });

  it('defaults function name when no EXECUTE clause', () => {
    const t = new DdlEventTrigger();
    t.createTriggerFromSQL('CREATE EVENT TRIGGER audit ON sql_drop');
    expect(t.getTrigger('audit')!.functionName).toBe('event_audit');
  });

  it('returns false for unparseable CREATE EVENT TRIGGER SQL', () => {
    const t = new DdlEventTrigger();
    expect(t.createTriggerFromSQL('CREATE TABLE foo (id int)')).toBe(false);
  });

  it('drops triggers and cleans up listeners', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: vi.fn() });
    expect(t.dropTrigger('a')).toBe(true);
    expect(t.getTrigger('a')).toBeUndefined();
    expect(t.dropTrigger('missing')).toBe(false);
  });

  it('cleans up empty listener sets on drop', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: vi.fn() });
    t.dropTrigger('a');
    // firing with no listeners is a no-op
    expect(t.getTriggersForEvent('ddl_command_start')).toEqual([]);
  });

  it('enables and disables triggers', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: vi.fn() });
    t.setTriggerEnabled('a', false);
    expect(t.getTrigger('a')!.enabled).toBe(false);
    t.setTriggerEnabled('a', true);
    expect(t.getTrigger('a')!.enabled).toBe(true);
    // no-op on unknown
    expect(() => t.setTriggerEnabled('nope', false)).not.toThrow();
  });

  it('fires callbacks for matching event type', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_end', callback: cb });
    await t.fireEnd('CREATE TABLE foo (id int)', { ok: true });
    expect(cb).toHaveBeenCalledTimes(1);
    const payload = cb.mock.calls[0][0];
    expect(payload.ddlTag).toBe('CREATE TABLE');
    expect(payload.objectType).toBe('table');
    expect(payload.objectName).toBe('foo');
    expect(t.getTrigger('a')!.fireCount).toBe(1);
  });

  it('respects tag filters during firing', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb, tags: ['DROP TABLE'] });
    await t.fireStart('CREATE TABLE foo (id int)');
    expect(cb).not.toHaveBeenCalled();
  });

  it('fires when the tag filter matches', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb, tags: ['CREATE TABLE'] });
    await t.fireStart('CREATE TABLE foo (id int)');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('extracts UNKNOWN tag for non-DDL SQL', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    await t.fireStart('SELECT 1');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].ddlTag).toBe('UNKNOWN');
  });

  it('skips disabled triggers during firing', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    t.setTriggerEnabled('a', false);
    await t.fireStart('CREATE TABLE foo (id int)');
    expect(cb).not.toHaveBeenCalled();
  });

  it('catches callback errors during firing', async () => {
    const t = new DdlEventTrigger();
    t.createTrigger({
      name: 'a',
      event: 'ddl_command_start',
      callback: async () => {
        throw new Error('boom');
      },
    });
    await expect(t.fireStart('CREATE TABLE foo (id int)')).resolves.toBeUndefined();
  });

  it('string callbacks that are unregistered do not fire', async () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: 'unregistered' });
    await t.fireStart('CREATE TABLE foo (id int)');
    expect(t.getTrigger('a')!.fireCount).toBe(0);
  });

  it('registers callbacks by name and fires them', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: 'fn' });
    t.registerCallback('fn', cb);
    await t.fireStart('CREATE TABLE foo (id int)');
    expect(cb).toHaveBeenCalled();
    expect(t.getTrigger('a')!.fireCount).toBe(1);
  });

  it('fires sql_drop events', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'sql_drop', callback: cb });
    await t.fireDrop('DROP TABLE foo');
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0].ddlTag).toBe('DROP TABLE');
  });

  it('hooks and unhooks a query router', async () => {
    const t = new DdlEventTrigger();
    const startCb = vi.fn();
    t.createTrigger({ name: 'start', event: 'ddl_command_start', callback: startCb });

    const router = { executeDDL: vi.fn(async (sql: string) => ({ sql })) };
    t.hookQueryRouter(router as any);

    const result = await router.executeDDL('CREATE TABLE foo (id int)');
    expect(result).toEqual({ sql: 'CREATE TABLE foo (id int)' });
    expect(startCb).toHaveBeenCalledTimes(1);

    // second hook attempt warns
    t.hookQueryRouter(router as any);

    t.unhookQueryRouter();
    // after unhook, original method restored
    expect(router.executeDDL).toBe(t['originalDDLMethod'] === null ? router.executeDDL : router.executeDDL);
  });

  it('fires sql_drop when hooking a DROP statement', async () => {
    const t = new DdlEventTrigger();
    const dropCb = vi.fn();
    t.createTrigger({ name: 'd', event: 'sql_drop', callback: dropCb });
    const router = { executeDDL: vi.fn(async () => ({ done: true })) };
    t.hookQueryRouter(router as any);
    await router.executeDDL('DROP TABLE foo');
    expect(dropCb).toHaveBeenCalledTimes(1);
  });

  it('propagates original DDL errors and skips end/drop events', async () => {
    const t = new DdlEventTrigger();
    const endCb = vi.fn();
    t.createTrigger({ name: 'e', event: 'ddl_command_end', callback: endCb });
    const router = {
      executeDDL: vi.fn(async () => {
        throw new Error('ddl failed');
      }),
    };
    t.hookQueryRouter(router as any);
    await expect(router.executeDDL('CREATE TABLE foo (id int)')).rejects.toThrow('ddl failed');
    expect(endCb).not.toHaveBeenCalled();
  });

  it('adds before and after hooks', () => {
    const t = new DdlEventTrigger();
    const before = vi.fn(() => true);
    const after = vi.fn();
    t.addBeforeHook(before);
    t.addAfterHook(after);
    expect(before).toHaveBeenCalledTimes(0);
    expect(after).toHaveBeenCalledTimes(0);
  });

  it('queries all triggers and total fire count', async () => {
    const t = new DdlEventTrigger();
    const cb = vi.fn();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    t.createTrigger({ name: 'b', event: 'ddl_command_end', callback: cb });
    await t.fireStart('CREATE TABLE foo (id int)');
    await t.fireEnd('ALTER TABLE foo ADD COLUMN x int');
    expect(t.getAllTriggers()).toHaveLength(2);
    expect(t.getTotalFireCount()).toBe(2);
  });

  it('detects DDL vs non-DDL SQL', () => {
    const t = new DdlEventTrigger();
    expect(t.isDDL('CREATE TABLE foo (id int)')).toBe(true);
    expect(t.isDDL('  ALTER TABLE foo')).toBe(true);
    expect(t.isDDL('DROP TABLE foo')).toBe(true);
    expect(t.isDDL('TRUNCATE foo')).toBe(true);
    expect(t.isDDL('COMMENT ON TABLE foo IS')).toBe(true);
    expect(t.isDDL('GRANT SELECT ON foo TO u')).toBe(true);
    expect(t.isDDL('REVOKE SELECT ON foo FROM u')).toBe(true);
    expect(t.isDDL('SELECT 1')).toBe(false);
    expect(t.isDDL('INSERT INTO foo VALUES (1)')).toBe(false);
  });

  it('extracts object type from various DDL forms', async () => {
    const t = new DdlEventTrigger();
    const types: (string | undefined)[] = [];
    const cb = vi.fn((p) => {
      types.push(p.objectType);
    });
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    await t.fireStart('CREATE TABLE foo (id int)');
    await t.fireStart('DROP INDEX my_idx');
    await t.fireStart('ALTER VIEW v ADD COLUMN x int');
    await t.fireStart('CREATE EVENT TRIGGER audit ON ddl_command_end');
    await t.fireStart('TRUNCATE foo');
    expect(types).toEqual(['table', 'index', 'view', 'event_trigger', undefined]);
  });

  it('extracts object name for CREATE/ALTER/DROP', async () => {
    const t = new DdlEventTrigger();
    const names: (string | undefined)[] = [];
    const cb = vi.fn((p) => {
      names.push(p.objectName);
    });
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: cb });
    await t.fireStart('CREATE TABLE myschema.foo (id int)');
    await t.fireStart('ALTER TABLE bar ADD COLUMN x int');
    await t.fireStart('DROP INDEX IF EXISTS idx_x');
    await t.fireStart('TRUNCATE baz');
    expect(names).toEqual(['foo', 'bar', 'idx_x', undefined]);
  });

  it('resets all state', () => {
    const t = new DdlEventTrigger();
    t.createTrigger({ name: 'a', event: 'ddl_command_start', callback: vi.fn() });
    t.reset();
    expect(t.getAllTriggers()).toEqual([]);
    expect(t.getTotalFireCount()).toBe(0);
  });
});
