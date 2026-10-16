import { describe, it, expect, vi } from 'vitest';
import {
  DDLTriggerManager,
  extractDDLTag,
  parseTagFilter,
  parseCreateEventTrigger,
  isDropStatement,
  extractDropObjectType,
  extractDropObjectName,
  extractDropTargets,
} from '../query/DDLTriggerManager';

describe('extractDDLTag', () => {
  it('returns UNKNOWN for non-DDL statements', () => {
    expect(extractDDLTag('SELECT * FROM t')).toBe('UNKNOWN');
    expect(extractDDLTag('   ')).toBe('UNKNOWN');
  });

  it('handles CREATE with no object type', () => {
    expect(extractDDLTag('CREATE TABLE')).toBe('CREATE TABLE');
    // bare CREATE with no trailing word is non-DDL (prefix regex requires `\s+`)
    expect(extractDDLTag('CREATE')).toBe('UNKNOWN');
  });

  it('extracts single-word tags', () => {
    expect(extractDDLTag('CREATE TABLE foo (id int)')).toBe('CREATE TABLE');
    expect(extractDDLTag('ALTER TABLE foo')).toBe('ALTER TABLE');
    expect(extractDDLTag('DROP TABLE foo')).toBe('DROP TABLE');
  });

  it('returns bare tags for single-keyword commands (object name is not an object type)', () => {
    expect(extractDDLTag('TRUNCATE foo')).toBe('TRUNCATE');
    expect(extractDDLTag('COMMENT ON TABLE t IS')).toBe('COMMENT');
    expect(extractDDLTag('GRANT SELECT ON t TO u')).toBe('GRANT');
    expect(extractDDLTag('REVOKE SELECT ON t FROM u')).toBe('REVOKE');
    expect(extractDDLTag('RENAME t TO u')).toBe('RENAME');
    expect(extractDDLTag('ANALYZE t')).toBe('ANALYZE');
    expect(extractDDLTag('VACUUM t')).toBe('VACUUM');
  });

  it('detects CREATE ... AS multi-word tags (no explicit table name)', () => {
    expect(extractDDLTag('CREATE TABLE AS SELECT 1')).toBe('CREATE TABLE AS');
    expect(extractDDLTag('CREATE VIEW AS SELECT 1')).toBe('CREATE VIEW AS');
  });

  it('does not treat a named CREATE ... AS as a multi-word tag', () => {
    expect(extractDDLTag('CREATE TABLE foo AS SELECT 1')).toBe('CREATE TABLE');
  });

  it('normalizes CREATE OR REPLACE to CREATE', () => {
    expect(extractDDLTag('CREATE OR REPLACE VIEW v AS SELECT 1')).toBe('CREATE VIEW');
    expect(extractDDLTag('CREATE OR REPLACE FUNCTION f() RETURNS int')).toBe('CREATE FUNCTION');
  });
});

describe('parseTagFilter', () => {
  it('returns undefined when no WHEN TAG IN clause', () => {
    expect(parseTagFilter('CREATE EVENT TRIGGER x ON ddl_command_end')).toBeUndefined();
    expect(parseTagFilter('SELECT 1')).toBeUndefined();
  });

  it('parses a single tag', () => {
    expect(parseTagFilter("WHEN TAG IN ('CREATE TABLE')")).toEqual(['CREATE TABLE']);
  });

  it('parses multiple tags and uppercases them', () => {
    expect(parseTagFilter("WHEN TAG IN ('create table', 'drop table')")).toEqual([
      'CREATE TABLE',
      'DROP TABLE',
    ]);
  });

  it('returns undefined for an empty WHEN TAG IN clause', () => {
    expect(parseTagFilter('WHEN TAG IN ()')).toBeUndefined();
  });
});

describe('parseCreateEventTrigger', () => {
  it('returns null for non-CREATE EVENT TRIGGER SQL', () => {
    expect(parseCreateEventTrigger('CREATE TABLE foo (id int)')).toBeNull();
    expect(parseCreateEventTrigger('DROP EVENT TRIGGER x')).toBeNull();
  });

  it('parses a full CREATE EVENT TRIGGER statement', () => {
    const cfg = parseCreateEventTrigger(
      "CREATE EVENT TRIGGER audit ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION audit_fn()",
    );
    expect(cfg).not.toBeNull();
    expect(cfg!.name).toBe('audit');
    expect(cfg!.event).toBe('ddl_command_end');
    expect(cfg!.tags).toEqual(['CREATE TABLE']);
    expect(cfg!.functionName).toBe('audit_fn');
    expect(cfg!.enabled).toBe(true);
  });

  it('defaults function name to event_<name>', () => {
    const cfg = parseCreateEventTrigger('CREATE EVENT TRIGGER audit ON sql_drop');
    expect(cfg!.functionName).toBe('event_audit');
  });
});

describe('isDropStatement', () => {
  it('detects DROP statements', () => {
    expect(isDropStatement('DROP TABLE foo')).toBe(true);
    expect(isDropStatement('  DROP INDEX i')).toBe(true);
    expect(isDropStatement('CREATE TABLE foo')).toBe(false);
  });
});

describe('extractDropObjectType', () => {
  it('returns object for unparseable drops', () => {
    expect(extractDropObjectType('DROP foo')).toBe('object');
  });

  it('extracts and normalizes multi-word types', () => {
    expect(extractDropObjectType('DROP TABLE t')).toBe('table');
    expect(extractDropObjectType('DROP EVENT TRIGGER t')).toBe('event_trigger');
    expect(extractDropObjectType('DROP MATERIALIZED VIEW v')).toBe('materialized_view');
    expect(extractDropObjectType('DROP FOREIGN TABLE t')).toBe('foreign_table');
  });
});

describe('extractDropObjectName', () => {
  it('returns empty for unparseable drops', () => {
    expect(extractDropObjectName('DROP')).toBe('');
  });

  it('extracts name, skipping IF EXISTS', () => {
    expect(extractDropObjectName('DROP TABLE IF EXISTS myschema.mytable')).toBe('myschema.mytable');
    expect(extractDropObjectName('DROP TABLE plain')).toBe('plain');
  });
});

describe('extractDropTargets', () => {
  it('returns unknown object for unparseable drops', () => {
    expect(extractDropTargets('DROP')).toEqual([{ schema: 'public', name: 'unknown' }]);
  });

  it('extracts schema-qualified names', () => {
    expect(extractDropTargets('DROP TABLE myschema.foo, bar')).toEqual([
      { schema: 'myschema', name: 'foo' },
      { schema: 'public', name: 'bar' },
    ]);
  });

  it('handles trailing punctuation and empty parts', () => {
    expect(extractDropTargets('DROP TABLE foo, bar,')).toEqual([
      { schema: 'public', name: 'foo' },
      { schema: 'public', name: 'bar' },
    ]);
  });

  it('returns unknown for a DROP with no objects', () => {
    expect(extractDropTargets('DROP TABLE')).toEqual([{ schema: 'public', name: 'unknown' }]);
  });
});

describe('DDLTriggerManager', () => {
  it('creates and fires a before trigger', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('before_t', 'ddl_command_start', cb);
    mgr.fireBefore('CREATE TABLE foo (id int)');
    expect(cb).toHaveBeenCalledWith('CREATE TABLE foo (id int)', 'ddl_command_start');
  });

  it('stores string callbacks as function identifiers', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('s', 'ddl_command_end', 'my_fn', ['CREATE TABLE']);
    const t = mgr.getTrigger('s');
    expect(t!.callback).toBe('my_fn');
    expect(t!.tags).toEqual(['CREATE TABLE']);
    expect(t!.timing).toBe('after');
  });

  it('skips firing when a string callback is not registered', () => {
    const mgr = new DDLTriggerManager();
    // string callback identifier, never registered via registerCallback → no-op firing
    mgr.createTrigger('s1', 'ddl_command_start', 'unregistered_fn');
    mgr.createTrigger('s2', 'ddl_command_end', 'unregistered_fn');
    mgr.createTrigger('s3', 'sql_drop', 'unregistered_fn');
    expect(() => mgr.fireBefore('CREATE TABLE foo (id int)')).not.toThrow();
    expect(() => mgr.fireAfter('CREATE TABLE foo (id int)', {})).not.toThrow();
    expect(() =>
      mgr.fireSqlDrop('DROP TABLE foo', [{ type: 'table', schema: 'public', name: 'foo' }]),
    ).not.toThrow();
  });

  it('does not attach empty tags', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('s', 'ddl_command_end', 'fn', []);
    expect(mgr.getTrigger('s')!.tags).toBeUndefined();
  });

  it('respects tag filtering in fireBefore', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('t', 'ddl_command_start', cb, ['DROP TABLE']);
    mgr.fireBefore('CREATE TABLE foo (id int)');
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores disabled triggers and non-DDL SQL', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('t', 'ddl_command_start', cb);
    mgr.setTriggerEnabled('t', false);
    mgr.fireBefore('CREATE TABLE foo (id int)');
    expect(cb).not.toHaveBeenCalled();

    mgr.setTriggerEnabled('t', true);
    mgr.fireBefore('SELECT 1');
    expect(cb).not.toHaveBeenCalled();
  });

  it('catches callback errors silently', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_start', () => {
      throw new Error('boom');
    });
    expect(() => mgr.fireBefore('CREATE TABLE foo (id int)')).not.toThrow();
  });

  it('fires after triggers and clears transient command', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('t', 'ddl_command_end', cb);
    mgr.fireAfter('CREATE TABLE foo (id int)', { ok: true });
    expect(cb).toHaveBeenCalledWith('CREATE TABLE foo (id int)', 'ddl_command_end');
    expect(mgr.pgEventTriggerDDLCommands()).toEqual([]);
  });

  it('ignores non-DDL SQL and disabled triggers in fireAfter', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('t', 'ddl_command_end', cb);
    mgr.fireAfter('SELECT 1', {});
    expect(cb).not.toHaveBeenCalled();

    mgr.setTriggerEnabled('t', false);
    mgr.fireAfter('CREATE TABLE foo (id int)', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('respects tag filtering in fireAfter', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('t', 'ddl_command_end', cb, ['DROP TABLE']);
    mgr.fireAfter('CREATE TABLE foo (id int)', {});
    expect(cb).not.toHaveBeenCalled();
  });

  it('catches fireAfter callback errors', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_end', () => {
      throw new Error('boom');
    });
    expect(() => mgr.fireAfter('CREATE TABLE foo (id int)', {})).not.toThrow();
  });

  it('does not apply default privileges for non-CREATE statements', () => {
    const mgr = new DDLTriggerManager();
    const applier = vi.fn();
    mgr.setDefaultPrivilegeApplier(applier);
    mgr.fireAfter('ALTER TABLE foo ADD COLUMN x int', {});
    expect(applier).not.toHaveBeenCalled();
  });

  it('applies default privileges on CREATE', () => {
    const mgr = new DDLTriggerManager();
    const applier = vi.fn();
    mgr.setDefaultPrivilegeApplier(applier);
    mgr.fireAfter('CREATE TABLE myschema.foo (id int)', {});
    expect(applier).toHaveBeenCalledWith('TABLE', 'myschema', 'foo');
  });

  it('catches default privilege applier errors', () => {
    const mgr = new DDLTriggerManager();
    mgr.setDefaultPrivilegeApplier(() => {
      throw new Error('boom');
    });
    expect(() => mgr.fireAfter('CREATE TABLE foo (id int)', {})).not.toThrow();
  });

  it('fires sql_drop triggers with dropped objects', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('d', 'sql_drop', cb);
    const dropped = [{ type: 'table', schema: 'public', name: 'foo' }];
    mgr.fireSqlDrop('DROP TABLE foo', dropped);
    expect(cb).toHaveBeenCalledWith('DROP TABLE foo', 'sql_drop');
    // transient objects cleared after firing
    expect(mgr.pgEventTriggerDroppedObjects()).toEqual([]);
  });

  it('ignores non-DROP sql_drop and respects tags', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('d', 'sql_drop', cb, ['DROP TABLE']);
    mgr.fireSqlDrop('DROP VIEW v', [{ type: 'view', schema: 'public', name: 'v' }]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores non-DROP and disabled sql_drop triggers', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.createTrigger('d', 'sql_drop', cb);
    mgr.fireSqlDrop('SELECT 1', []);
    expect(cb).not.toHaveBeenCalled();

    mgr.setTriggerEnabled('d', false);
    mgr.fireSqlDrop('DROP TABLE foo', [{ type: 'table', schema: 'public', name: 'foo' }]);
    expect(cb).not.toHaveBeenCalled();
  });

  it('catches sql_drop callback errors', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('d', 'sql_drop', () => {
      throw new Error('boom');
    });
    expect(() =>
      mgr.fireSqlDrop('DROP TABLE foo', [{ type: 'table', schema: 'public', name: 'foo' }]),
    ).not.toThrow();
  });

  it('creates triggers from CREATE EVENT TRIGGER SQL', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTriggerFromSQL(
      "CREATE EVENT TRIGGER audit ON ddl_command_end WHEN TAG IN ('CREATE TABLE')",
    );
    const t = mgr.getTrigger('audit');
    expect(t).toBeDefined();
    expect(t!.event).toBe('ddl_command_end');
    expect(t!.tags).toEqual(['CREATE TABLE']);
  });

  it('warns on unparseable CREATE EVENT TRIGGER', () => {
    const mgr = new DDLTriggerManager();
    expect(() => mgr.createTriggerFromSQL('CREATE TABLE foo (id int)')).not.toThrow();
    expect(mgr.getTrigger('x')).toBeUndefined();
  });

  it('drops triggers by name', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_start', 'fn');
    mgr.dropTrigger('t');
    expect(mgr.getTrigger('t')).toBeUndefined();
  });

  it('alters event trigger enabled state', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_start', 'fn');
    expect(mgr.alterEventTrigger('t', 'DISABLE')).toBe(true);
    expect(mgr.getTrigger('t')!.enabled).toBe(false);
    expect(mgr.alterEventTrigger('t', 'ENABLE')).toBe(true);
    expect(mgr.getTrigger('t')!.enabled).toBe(true);
    expect(mgr.alterEventTrigger('missing', 'DISABLE')).toBe(false);
  });

  it('alters event trigger from SQL', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_start', 'fn');
    expect(mgr.alterEventTriggerFromSQL('ALTER EVENT TRIGGER t DISABLE')).toBe(true);
    expect(mgr.getTrigger('t')!.enabled).toBe(false);
    expect(mgr.alterEventTriggerFromSQL('SELECT 1')).toBe(false);
  });

  it('exposes event trigger configs and event filtering', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('a', 'ddl_command_start', 'fn1');
    mgr.createTrigger('b', 'ddl_command_end', 'fn2');
    const configs = mgr.getAllEventTriggerConfigs();
    expect(configs).toHaveLength(2);
    expect(mgr.getTriggersForEvent('ddl_command_start')).toHaveLength(1);
    expect(mgr.getAllTriggers()).toHaveLength(2);
  });

  it('registers callbacks by name', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn();
    mgr.registerCallback('fn', cb);
    mgr.createTrigger('t', 'ddl_command_start', 'fn');
    mgr.fireBefore('CREATE TABLE foo (id int)');
    expect(cb).toHaveBeenCalled();
  });

  it('captures and reads dropped objects via pseudo-function', () => {
    const mgr = new DDLTriggerManager();
    const objs = [{ type: 'table', schema: 'public', name: 'foo' }];
    mgr.captureDroppedObjects(objs);
    expect(mgr.pgEventTriggerDroppedObjects()).toEqual(objs);
  });

  it('extracts dropped objects from SQL', () => {
    const mgr = new DDLTriggerManager();
    const objs = mgr.extractDroppedObjectsFromSQL('DROP TABLE myschema.foo');
    expect(objs).toEqual([{ type: 'table', schema: 'myschema', name: 'foo' }]);
    expect(mgr.extractDroppedObjectsFromSQL('SELECT 1')).toEqual([]);
  });

  it('extracts created object info', () => {
    const mgr = new DDLTriggerManager();
    expect(mgr.extractCreatedObject('CREATE TABLE myschema.foo (id int)')).toEqual({
      objectType: 'TABLE',
      schemaName: 'myschema',
      objectName: 'foo',
    });
    expect(mgr.extractCreatedObject('CREATE OR REPLACE FUNCTION bar()')).toEqual({
      objectType: 'FUNCTION',
      schemaName: null,
      objectName: 'bar',
    });
    expect(mgr.extractCreatedObject('SELECT 1')).toBeNull();
  });

  it('resets all state', () => {
    const mgr = new DDLTriggerManager();
    mgr.createTrigger('t', 'ddl_command_start', 'fn');
    mgr.reset();
    expect(mgr.getAllTriggers()).toEqual([]);
  });

  it('setTriggerEnabled no-ops for unknown trigger', () => {
    const mgr = new DDLTriggerManager();
    expect(() => mgr.setTriggerEnabled('nope', true)).not.toThrow();
  });

  it('builds DDL command info for single-keyword tags', () => {
    const mgr = new DDLTriggerManager();
    const cb = vi.fn((_sql, _evt) => {
      const cmds = mgr.pgEventTriggerDDLCommands();
      // 'TRUNCATE' is a single-keyword tag → objectType 'unknown'
      expect(cmds[0].ddlTag).toBe('TRUNCATE');
    });
    mgr.createTrigger('t', 'ddl_command_start', cb);
    mgr.fireBefore('TRUNCATE foo');
    expect(cb).toHaveBeenCalled();
  });

  it('resolves object name for DROP and ALTER statements', () => {
    const mgr = new DDLTriggerManager();
    const names: string[] = [];
    mgr.createTrigger('t', 'ddl_command_start', (_sql) => {
      names.push(mgr.pgEventTriggerDDLCommands()[0].identity);
    });
    mgr.fireBefore('DROP TABLE foo');
    mgr.fireBefore('ALTER TABLE bar ADD COLUMN x int');
    mgr.fireBefore('VACUUM baz');
    expect(names).toEqual(['foo', 'bar', 'unknown']);
  });
});
