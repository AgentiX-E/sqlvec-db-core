import { describe, it, expect, beforeEach } from 'vitest';
import { RoleManager, type DatabaseRole } from '../auth/RoleManager';
import {
  SQLSTATE_DUPLICATE_OBJECT,
  SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE,
  SQLSTATE_UNDEFINED_OBJECT,
} from '../constants/sqlstate';

/** Build a role with convenient default attribute values. */
function role(overrides: Partial<DatabaseRole> & { roleName: string }): DatabaseRole {
  return {
    superuser: false,
    login: false,
    canCreateDb: false,
    canCreateRole: false,
    memberOf: [],
    attributes: {},
    ...overrides,
  };
}

describe('RoleManager', () => {
  let rm: RoleManager;

  beforeEach(() => {
    rm = new RoleManager();
  });

  describe('default roles', () => {
    it('registers the canonical superuser role `postgres`', () => {
      const p = rm.getRole('postgres');
      expect(p).toBeDefined();
      expect(p!.superuser).toBe(true);
      expect(p!.login).toBe(true);
      expect(p!.canCreateDb).toBe(true);
      expect(p!.canCreateRole).toBe(true);
    });

    it('registers the predefined system roles as non-superuser groups', () => {
      for (const name of ['pg_read_all_data', 'pg_write_all_data', 'pg_database_owner']) {
        expect(rm.hasRole(name)).toBe(true);
        expect(rm.getRole(name)!.superuser).toBe(false);
        expect(rm.getRole(name)!.login).toBe(false);
      }
    });

    it('exposes default roles via getDefaultRoles', () => {
      const names = rm.getDefaultRoles().map((r) => r.roleName.toLowerCase());
      expect(names).toEqual(['pg_read_all_data', 'pg_write_all_data', 'pg_database_owner']);
    });
  });

  describe('role CRUD', () => {
    it('creates a role and retrieves it case-insensitively', () => {
      rm.createRole(role({ roleName: 'Alice', login: true }));
      expect(rm.hasRole('alice')).toBe(true);
      expect(rm.getRole('ALICE')!.roleName).toBe('Alice');
    });

    it('returns undefined for an unknown role', () => {
      expect(rm.getRole('nobody')).toBeUndefined();
    });

    it('lists all roles via getAllRoles', () => {
      rm.createRole(role({ roleName: 'alice', memberOf: ['staff'], attributes: { x: true } }));
      const all = rm.getAllRoles();
      const names = all.map((r) => r.roleName);
      // Default roles + postgres + alice.
      expect(names).toContain('postgres');
      expect(names).toContain('alice');
      expect(names).toContain('pg_read_all_data');
      // Returned entries are snapshots.
      const alice = all.find((r) => r.roleName === 'alice')!;
      alice.memberOf.push('admin');
      expect(rm.getRole('alice')!.memberOf).toEqual(['staff']);
    });

    it('defensively copies the stored role on getRole/getAllRoles', () => {
      rm.createRole(role({ roleName: 'bob', memberOf: ['staff'], attributes: { x: true } }));
      const copy = rm.getRole('bob')!;
      copy.memberOf.push('admin');
      copy.attributes.x = false;
      copy.superuser = true;
      // Mutating the returned snapshot must not affect the directory.
      expect(rm.getRole('bob')!.memberOf).toEqual(['staff']);
      expect(rm.getRole('bob')!.attributes.x).toBe(true);
      expect(rm.getRole('bob')!.superuser).toBe(false);
    });

    it('throws a duplicate-object error on re-creating an existing role', () => {
      rm.createRole(role({ roleName: 'dup' }));
      expect(() => rm.createRole(role({ roleName: 'DUP' }))).toThrowError(
        expect.objectContaining({ sqlstate: SQLSTATE_DUPLICATE_OBJECT }),
      );
    });

    it('drops a non-system role', () => {
      rm.createRole(role({ roleName: 'tmp' }));
      rm.dropRole('tmp');
      expect(rm.hasRole('tmp')).toBe(false);
    });

    it('throws an undefined-object error when dropping an unknown role', () => {
      expect(() => rm.dropRole('nope')).toThrowError(
        expect.objectContaining({ sqlstate: SQLSTATE_UNDEFINED_OBJECT }),
      );
    });

    it('refuses to drop a system role', () => {
      expect(() => rm.dropRole('pg_read_all_data')).toThrowError(
        expect.objectContaining({ sqlstate: SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE }),
      );
    });
  });

  describe('membership', () => {
    it('treats a role as a member of itself', () => {
      rm.createRole(role({ roleName: 'alice' }));
      expect(rm.isMemberOf('alice', 'alice')).toBe(true);
      expect(rm.isMemberOf('ALICE', 'Alice')).toBe(true);
    });

    it('reports direct membership', () => {
      rm.createRole(role({ roleName: 'staff' }));
      rm.createRole(role({ roleName: 'alice', memberOf: ['staff'] }));
      expect(rm.isMemberOf('alice', 'staff')).toBe(true);
      expect(rm.isMemberOf('staff', 'alice')).toBe(false);
    });

    it('resolves transitive membership through a chain', () => {
      rm.createRole(role({ roleName: 'company' }));
      rm.createRole(role({ roleName: 'staff', memberOf: ['company'] }));
      rm.createRole(role({ roleName: 'alice', memberOf: ['staff'] }));
      expect(rm.isMemberOf('alice', 'company')).toBe(true);
    });

    it('returns false for non-membership', () => {
      rm.createRole(role({ roleName: 'group1' }));
      rm.createRole(role({ roleName: 'group2' }));
      rm.createRole(role({ roleName: 'alice', memberOf: ['group1'] }));
      expect(rm.isMemberOf('alice', 'group2')).toBe(false);
    });

    it('returns false when the queried role does not exist', () => {
      rm.createRole(role({ roleName: 'group' }));
      expect(rm.isMemberOf('ghost', 'group')).toBe(false);
    });

    it('does not loop forever on cyclic memberships', () => {
      rm.createRole(role({ roleName: 'a', memberOf: ['b'] }));
      rm.createRole(role({ roleName: 'b', memberOf: ['a'] }));
      expect(rm.isMemberOf('a', 'b')).toBe(true);
      expect(rm.isMemberOf('b', 'a')).toBe(true);
    });

    it('skips a dangling membership reference to a missing role', () => {
      rm.createRole(role({ roleName: 'alice', memberOf: ['ghost'] }));
      // 'ghost' is never created; resolution must not error or treat it as a member.
      expect(rm.isMemberOf('alice', 'ghost')).toBe(false);
      expect(rm.isMemberOf('alice', 'pg_read_all_data')).toBe(false);
    });

    it('invalidates the membership cache after a role is dropped', () => {
      rm.createRole(role({ roleName: 'staff' }));
      rm.createRole(role({ roleName: 'alice', memberOf: ['staff'] }));
      expect(rm.isMemberOf('alice', 'staff')).toBe(true);
      rm.dropRole('staff');
      expect(rm.hasRole('staff')).toBe(false);
      // alice no longer resolves staff membership (role is gone).
      rm.createRole(role({ roleName: 'staff2' }));
      rm.createRole(role({ roleName: 'carol', memberOf: ['staff2'] }));
      expect(rm.isMemberOf('carol', 'staff2')).toBe(true);
    });
  });

  describe('connection and privilege checks', () => {
    it('lets a login role connect and denies a non-login group', () => {
      rm.createRole(role({ roleName: 'reader', login: true }));
      rm.createRole(role({ roleName: 'group1' }));
      expect(rm.canConnect('reader')).toBe(true);
      expect(rm.canConnect('group1')).toBe(false);
      expect(rm.canConnect('ghost')).toBe(false);
    });

    it('lets a superuser connect regardless of login', () => {
      rm.createRole(role({ roleName: 'root', superuser: true, login: false }));
      expect(rm.canConnect('root')).toBe(true);
    });

    it('lets a superuser pass any privilege check', () => {
      rm.createRole(role({ roleName: 'root', superuser: true }));
      expect(rm.checkPrivilege('root', 'SELECT')).toBe(true);
      expect(rm.checkPrivilege('root', 'DELETE')).toBe(true);
    });

    it('checks CREATE against canCreateDb/canCreateRole', () => {
      rm.createRole(role({ roleName: 'dbadmin', canCreateDb: true }));
      rm.createRole(role({ roleName: 'roleadmin', canCreateRole: true }));
      rm.createRole(role({ roleName: 'plain' }));
      expect(rm.checkPrivilege('dbadmin', 'CREATE')).toBe(true);
      expect(rm.checkPrivilege('roleadmin', 'CREATE')).toBe(true);
      expect(rm.checkPrivilege('plain', 'CREATE')).toBe(false);
    });

    it('grants SELECT via pg_read_all_data membership', () => {
      rm.createRole(role({ roleName: 'analyst', memberOf: ['pg_read_all_data'] }));
      expect(rm.checkPrivilege('analyst', 'SELECT')).toBe(true);
      expect(rm.checkPrivilege('analyst', 'INSERT')).toBe(false);
    });

    it('grants write via pg_write_all_data membership', () => {
      rm.createRole(role({ roleName: 'etl', memberOf: ['pg_write_all_data'] }));
      expect(rm.checkPrivilege('etl', 'INSERT')).toBe(true);
      expect(rm.checkPrivilege('etl', 'UPDATE')).toBe(true);
      expect(rm.checkPrivilege('etl', 'DELETE')).toBe(true);
      expect(rm.checkPrivilege('etl', 'SELECT')).toBe(false);
    });

    it('denies an unknown role for privilege checks', () => {
      expect(rm.checkPrivilege('ghost', 'SELECT')).toBe(false);
      expect(rm.checkPrivilege('ghost', 'CONNECT')).toBe(false);
    });

    it('grants CONNECT via checkPrivilege for a login role', () => {
      rm.createRole(role({ roleName: 'reader', login: true }));
      rm.createRole(role({ roleName: 'group' }));
      expect(rm.checkPrivilege('reader', 'CONNECT')).toBe(true);
      expect(rm.checkPrivilege('group', 'CONNECT')).toBe(false);
    });

    it('returns false for an unrecognized operation', () => {
      rm.createRole(role({ roleName: 'bob' }));
      expect(rm.checkPrivilege('bob', 'VACUUM')).toBe(false);
    });

    it('converges membership resolution on a diamond (shared group) graph', () => {
      // alice → g1 → base and alice → g2 → base: base reached from two paths.
      rm.createRole(role({ roleName: 'base' }));
      rm.createRole(role({ roleName: 'g1', memberOf: ['base'] }));
      rm.createRole(role({ roleName: 'g2', memberOf: ['base'] }));
      rm.createRole(role({ roleName: 'alice', memberOf: ['g1', 'g2'] }));
      expect(rm.isMemberOf('alice', 'base')).toBe(true);
      // The duplicate 'base' must be de-duplicated, not hang.
      expect(rm.isMemberOf('alice', 'g1')).toBe(true);
      expect(rm.isMemberOf('alice', 'g2')).toBe(true);
    });
  });
});
