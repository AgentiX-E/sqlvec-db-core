/**
 * default-privilege-manager.test.ts — Coverage tests for DefaultPrivilegeManager.
 *
 * Uses a real in-memory better-sqlite3 database to exercise SQL detection,
 * parsing, rule storage/removal, and grant-SQL generation end to end.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  DefaultPrivilegeManager,
  detectAlterDefaultPrivileges,
} from '../query/DefaultPrivilegeManager';

let db: Database.Database;
let mgr: DefaultPrivilegeManager;

beforeEach(() => {
  db = new Database(':memory:');
  mgr = new DefaultPrivilegeManager();
});

describe('detectAlterDefaultPrivileges (standalone)', () => {
  it('detects ALTER DEFAULT PRIVILEGES', () => {
    expect(detectAlterDefaultPrivileges('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice')).toBe(true);
  });

  it('returns false for other SQL', () => {
    expect(detectAlterDefaultPrivileges('SELECT 1')).toBe(false);
  });
});

describe('init / isReady / createSystemTable', () => {
  it('initializes and marks ready', () => {
    expect(mgr.isReady()).toBe(false);
    mgr.init(db);
    expect(mgr.isReady()).toBe(true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_default_privileges'").all();
    expect(tables.length).toBe(1);
  });

  it('isReady returns false after reset', () => {
    mgr.init(db);
    expect(mgr.isReady()).toBe(true);
    mgr.reset();
    expect(mgr.isReady()).toBe(false);
  });
});

describe('detect', () => {
  beforeEach(() => mgr.init(db));

  it('detects ALTER DEFAULT PRIVILEGES', () => {
    expect(mgr.detect('  ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO x;')).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(mgr.detect('SELECT 1')).toBe(false);
  });
});

describe('parse', () => {
  beforeEach(() => mgr.init(db));

  it('parses GRANT with FOR ROLE and IN SCHEMA', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE bob IN SCHEMA public GRANT SELECT ON TABLES TO alice');
    expect(r.targetRole).toBe('bob');
    expect(r.schemaName).toBe('public');
    expect(r.objectType).toBe('TABLES');
    expect(r.privilegeType).toBe('SELECT');
    expect(r.isGrant).toBe(true);
    expect(r.grantee).toBe('alice');
  });

  it('parses GRANT with ALL PRIVILEGES suffix', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON TABLES TO alice');
    expect(r.privilegeType).toBe('ALL');
  });

  it('parses comma-separated privileges with normalization', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT ON TABLES TO alice');
    expect(r.privilegeType).toBe('SELECT, INSERT');
  });

  it('parses REVOKE ... FROM', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM alice');
    expect(r.isGrant).toBe(false);
    expect(r.grantee).toBe('alice');
  });

  it('parses without FOR ROLE / IN SCHEMA (null target/schema)', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice');
    expect(r.targetRole).toBeNull();
    expect(r.schemaName).toBeNull();
  });

  it('parses FOR USER alias', () => {
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES FOR USER bob GRANT SELECT ON TABLES TO alice');
    expect(r.targetRole).toBe('bob');
  });

  it('parses different object types', () => {
    for (const ot of ['SEQUENCES', 'FUNCTIONS', 'TYPES']) {
      const r = mgr.parse(`ALTER DEFAULT PRIVILEGES GRANT SELECT ON ${ot} TO alice`);
      expect(r.objectType).toBe(ot);
    }
  });

  it('throws on unparseable SQL', () => {
    expect(() => mgr.parse('NOT VALID SQL')).toThrow(/Unable to parse/);
  });

  it('throws when GRANT used with FROM', () => {
    expect(() => mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES FROM alice')).toThrow(/GRANT must use TO/);
  });

  it('throws when REVOKE used with TO', () => {
    expect(() => mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES TO alice')).toThrow(/REVOKE must use FROM/);
  });
});

describe('handle', () => {
  it('returns handled:false for non-matching SQL', () => {
    mgr.init(db);
    expect(mgr.handle('SELECT 1')).toEqual({ handled: false });
  });

  it('throws when not initialized', () => {
    expect(() => mgr.handle('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice')).toThrow(/not initialized/);
  });

  it('handles GRANT by storing rule', () => {
    mgr.init(db);
    const res = mgr.handle('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice');
    expect(res.handled).toBe(true);
    expect(res.rule).toBeDefined();
    expect(res.deletedCount).toBe(0);
  });

  it('handles REVOKE by removing matching rules', () => {
    mgr.init(db);
    mgr.handle('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice');
    const res = mgr.handle('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM alice');
    expect(res.handled).toBe(true);
    expect(res.deletedCount).toBe(1);
  });
});

describe('storeRule', () => {
  it('stores single privilege', () => {
    mgr.init(db);
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice');
    const stored = mgr.storeRule(r);
    expect(stored.id).toBeGreaterThan(0);
    expect(mgr.getAllRules().length).toBe(1);
  });

  it('stores multiple privileges as separate rows', () => {
    mgr.init(db);
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT,INSERT,UPDATE ON TABLES TO alice');
    mgr.storeRule(r);
    expect(mgr.getAllRules().length).toBe(3);
  });

  it('stores a REVOKE rule (isGrant=false) directly', () => {
    mgr.init(db);
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM alice');
    const stored = mgr.storeRule(r);
    expect(stored.isGrant).toBe(false);
    const rows = db.prepare('SELECT is_grant FROM _sqlvec_default_privileges WHERE id = ?').get(stored.id!) as any;
    expect(rows.is_grant).toBe(0);
  });

  it('stores multiple REVOKE privileges (isGrant=false) as separate rows', () => {
    mgr.init(db);
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT,INSERT ON TABLES FROM alice');
    mgr.storeRule(r);
    const rows = db.prepare('SELECT is_grant FROM _sqlvec_default_privileges').all() as any[];
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.is_grant === 0)).toBe(true);
  });
});

describe('removeMatchingRules', () => {
  it('removes by full criteria', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE bob IN SCHEMA public GRANT SELECT ON TABLES TO alice'));
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE bob IN SCHEMA public REVOKE SELECT ON TABLES FROM alice');
    expect(mgr.removeMatchingRules(r)).toBe(1);
  });

  it('removes without targetRole/schemaName (wildcards)', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT ON TABLES FROM alice');
    expect(mgr.removeMatchingRules(r)).toBe(1);
  });

  it('removes ALL privileges', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO alice'));
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM alice');
    expect(mgr.removeMatchingRules(r)).toBe(2);
  });

  it('removes comma-separated privileges (IN clause)', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO alice'));
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT UPDATE ON TABLES TO alice'));
    const r = mgr.parse('ALTER DEFAULT PRIVILEGES REVOKE SELECT,INSERT ON TABLES FROM alice');
    expect(mgr.removeMatchingRules(r)).toBe(2);
  });
});

describe('removeRuleById', () => {
  it('removes existing rule', () => {
    mgr.init(db);
    const stored = mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    expect(mgr.removeRuleById(stored.id!)).toBe(true);
  });

  it('returns false for non-existent id', () => {
    mgr.init(db);
    expect(mgr.removeRuleById(9999)).toBe(false);
  });
});

describe('getGrantSqlForObject', () => {
  it('returns empty when not ready', () => {
    expect(mgr.getGrantSqlForObject('TABLE', 'public', 'bob', 'my_table')).toEqual([]);
  });

  it('generates GRANT for matching rule (TABLE normalized to TABLES)', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE bob IN SCHEMA public GRANT SELECT ON TABLES TO alice'));
    const sqls = mgr.getGrantSqlForObject('TABLE', 'public', 'bob', 'my_table');
    expect(sqls).toContain('GRANT SELECT ON my_table TO alice');
  });

  it('normalizes VIEW / INDEX to TABLES', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    expect(mgr.getGrantSqlForObject('VIEW', 'public', 'bob', 'v')).toContain('GRANT SELECT ON v TO alice');
    expect(mgr.getGrantSqlForObject('INDEX', 'public', 'bob', 'i')).toContain('GRANT SELECT ON i TO alice');
  });

  it('normalizes SEQUENCE → SEQUENCES', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON SEQUENCES TO alice'));
    expect(mgr.getGrantSqlForObject('SEQUENCE', 'public', 'bob', 's')).toContain('GRANT SELECT ON s TO alice');
  });

  it('normalizes FUNCTION / PROCEDURE → FUNCTIONS', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO alice'));
    expect(mgr.getGrantSqlForObject('FUNCTION', 'public', 'bob', 'f')).toContain('GRANT EXECUTE ON f TO alice');
    expect(mgr.getGrantSqlForObject('PROCEDURE', 'public', 'bob', 'p')).toContain('GRANT EXECUTE ON p TO alice');
  });

  it('passes through TYPES object type (no normalization)', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT USAGE ON TYPES TO alice'));
    expect(mgr.getGrantSqlForObject('TYPES', 'public', 'bob', 'ty')).toContain('GRANT USAGE ON ty TO alice');
  });

  it('returns empty when no matching rules', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE other IN SCHEMA other GRANT SELECT ON TABLES TO alice'));
    expect(mgr.getGrantSqlForObject('TABLE', 'public', 'bob', 't')).toEqual([]);
  });
});

describe('getAllRules / getRules / clearAllRules', () => {
  it('returns empty when not ready', () => {
    expect(mgr.getAllRules()).toEqual([]);
    expect(mgr.getRules({})).toEqual([]);
  });

  it('clearAllRules is no-op when not ready', () => {
    expect(() => mgr.clearAllRules()).not.toThrow();
  });

  it('removeRuleById returns false when not ready', () => {
    expect(mgr.removeRuleById(1)).toBe(false);
  });

  it('storeRule throws when not ready', () => {
    expect(() => mgr.storeRule({ objectType: 'TABLES', privilegeType: 'SELECT', isGrant: true, grantee: 'alice' }))
      .toThrow(/not initialized/);
  });

  it('removeMatchingRules throws when not ready', () => {
    expect(() => mgr.removeMatchingRules({ objectType: 'TABLES', privilegeType: 'SELECT', isGrant: false, grantee: 'alice' }))
      .toThrow(/not initialized/);
  });

  it('lists all rules ordered by id', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT INSERT ON TABLES TO bob'));
    expect(mgr.getAllRules().length).toBe(2);
  });

  it('filters rules by criteria', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES FOR ROLE bob IN SCHEMA public GRANT SELECT ON TABLES TO alice'));
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT INSERT ON SEQUENCES TO carol'));

    expect(mgr.getRules({ targetRole: 'bob' }).length).toBe(1);
    expect(mgr.getRules({ schemaName: 'public' }).length).toBe(1);
    expect(mgr.getRules({ objectType: 'tables' }).length).toBe(1);
    expect(mgr.getRules({ grantee: 'alice' }).length).toBe(1);
    expect(mgr.getRules({ grantee: 'nobody' }).length).toBe(0);
    // empty filter → all rules
    expect(mgr.getRules({}).length).toBe(2);
  });

  it('clears all rules', () => {
    mgr.init(db);
    mgr.storeRule(mgr.parse('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO alice'));
    mgr.clearAllRules();
    expect(mgr.getAllRules().length).toBe(0);
  });
});
