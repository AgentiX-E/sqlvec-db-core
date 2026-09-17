/**
 * RoleManager — role-based access control for the PostgreSQL-compatible layer.
 *
 * Implements the PostgreSQL role model in a pure, dependency-free way:
 *
 *   - Roles may be users or groups (the latter have `login = false`).
 *   - A role carries attributes: `superuser`, `login`, `canCreateDb`,
 *     `canCreateRole`, plus an ordered set of group memberships (`memberOf`).
 *   - Membership is transitive: if `alice ∈ developers` and
 *     `developers ∈ staff`, then `alice ∈ staff`.
 *   - A superuser bypasses every permission check.
 *   - A handful of system roles (`pg_read_all_data`, `pg_write_all_data`,
 *     `pg_database_owner`) are registered by default, mirroring PostgreSQL 14+.
 *
 * This module is intentionally free of logging / audit / storage concerns so
 * that the access-control decision itself stays small, deterministic, and easy
 * to test.  (The higher-level engine layers own observability and persistence.)
 *
 * @module auth/RoleManager
 */

import {
  SQLSTATE_DUPLICATE_OBJECT,
  SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE,
  SQLSTATE_UNDEFINED_OBJECT,
} from '../constants/sqlstate';
import { DatabaseError } from '../errors/DatabaseError';

/** A single role's attributes and memberships. */
export interface DatabaseRole {
  /** Canonical role name (case is preserved for display; lookups are case-insensitive). */
  roleName: string;
  /** Bypasses every permission check when true. */
  superuser: boolean;
  /** Whether the role may establish a connection (LOGIN). */
  login: boolean;
  /** Whether the role may create databases. */
  canCreateDb: boolean;
  /** Whether the role may create other roles. */
  canCreateRole: boolean;
  /** Group roles this role belongs to (direct membership only). */
  memberOf: string[];
  /** Extra named boolean attributes (e.g. inheritance, replication). */
  attributes: Record<string, boolean>;
}

/**
 * In-memory role directory with transitive membership resolution.
 *
 * Lookup is case-insensitive; a role is a member of itself; membership is the
 * transitive closure of the `memberOf` relation (computed once and cached until
 * the directory mutates).
 */
export class RoleManager {
  private readonly roles = new Map<string, DatabaseRole>();
  private readonly membershipCache = new Map<string, Set<string>>();

  constructor() {
    this.registerDefaults();
  }

  // ── CRUD ────────────────────────────────────────────────────

  /** Register a new role. Throws if a role with the same name already exists. */
  createRole(role: DatabaseRole): void {
    const key = role.roleName.toLowerCase();
    if (this.roles.has(key)) {
      throw new DatabaseError(
        `Role "${role.roleName}" already exists`,
        SQLSTATE_DUPLICATE_OBJECT,
      );
    }
    this.roles.set(key, Object.freeze({
      ...role,
      memberOf: [...role.memberOf],
      attributes: { ...role.attributes },
    }));
    this.invalidateMembershipCache();
  }

  /** Remove a non-system role. Throws for unknown or system (`pg_*`) roles. */
  dropRole(roleName: string): void {
    const key = roleName.toLowerCase();
    const role = this.roles.get(key);
    if (!role) {
      throw new DatabaseError(`Role "${roleName}" does not exist`, SQLSTATE_UNDEFINED_OBJECT);
    }
    if (role.roleName.toLowerCase().startsWith('pg_')) {
      throw new DatabaseError(
        `Cannot drop system role "${role.roleName}"`,
        SQLSTATE_OBJECT_NOT_IN_PREREQUISITE_STATE,
      );
    }
    this.roles.delete(key);
    this.invalidateMembershipCache();
  }

  // ── Queries ─────────────────────────────────────────────────

  /** Whether a role exists (case-insensitive). */
  hasRole(roleName: string): boolean {
    return this.roles.has(roleName.toLowerCase());
  }

  /** Return a role by name, or `undefined` if unknown. */
  getRole(roleName: string): DatabaseRole | undefined {
    const role = this.roles.get(roleName.toLowerCase());
    if (!role) return undefined;
    return { ...role, memberOf: [...role.memberOf], attributes: { ...role.attributes } };
  }

  /** All roles (defensively copied). */
  getAllRoles(): DatabaseRole[] {
    return Array.from(this.roles.values()).map((r) => ({
      ...r,
      memberOf: [...r.memberOf],
      attributes: { ...r.attributes },
    }));
  }

  /**
   * Whether `roleName` is a member of `groupName`, either directly or through
   * any chain of memberships.  A role is always a member of itself.
   */
  isMemberOf(roleName: string, groupName: string): boolean {
    const roleKey = roleName.toLowerCase();
    const groupKey = groupName.toLowerCase();

    if (!this.roles.has(roleKey)) return false;
    if (roleKey === groupKey) return true;

    return this.computeMembership(roleKey).has(groupKey);
  }

  /** Whether a role may establish a connection (LOGIN or superuser). */
  canConnect(roleName: string, _database?: string): boolean {
    const role = this.roles.get(roleName.toLowerCase());
    if (!role) return false;
    return role.superuser || role.login;
  }

  /**
   * Coarse privilege check against role attributes and predefined system-group
   * membership.  Object-level ACLs are outside this module's scope; this covers
   * the role's own capabilities.
   */
  checkPrivilege(roleName: string, operation: string, _objectName?: string): boolean {
    const role = this.roles.get(roleName.toLowerCase());
    if (!role) return false;

    const op = operation.toUpperCase();
    if (role.superuser) return true;

    if (op === 'CREATE') return role.canCreateDb || role.canCreateRole;
    if (op === 'CONNECT') return role.login;
    if (op === 'SELECT') return this.isMemberOf(roleName, 'pg_read_all_data');
    if (op === 'INSERT' || op === 'UPDATE' || op === 'DELETE') {
      return this.isMemberOf(roleName, 'pg_write_all_data');
    }
    return false;
  }

  // ── System roles ────────────────────────────────────────────

  /** Predefined system roles (PostgreSQL 14+). */
  getDefaultRoles(): DatabaseRole[] {
    const sys = (roleName: string): DatabaseRole => ({
      roleName,
      superuser: false,
      login: false,
      canCreateDb: false,
      canCreateRole: false,
      memberOf: [],
      attributes: {},
    });
    return [
      sys('pg_read_all_data'),
      sys('pg_write_all_data'),
      sys('pg_database_owner'),
    ];
  }

  // ── Internals ───────────────────────────────────────────────

  /** Register the default roles plus the canonical superuser `postgres`. */
  private registerDefaults(): void {
    for (const role of this.getDefaultRoles()) {
      this.roles.set(role.roleName.toLowerCase(), Object.freeze(role));
    }
    this.roles.set('postgres', Object.freeze({
      roleName: 'postgres',
      superuser: true,
      login: true,
      canCreateDb: true,
      canCreateRole: true,
      memberOf: [],
      attributes: { bypassrls: true },
    }));
  }

  /**
   * Compute the transitive closure of `entryKey`'s memberships via BFS, caching
   * the result (excluding the role itself).  BFS protects against cycles.
   */
  private computeMembership(entryKey: string): Set<string> {
    const cached = this.membershipCache.get(entryKey);
    if (cached) return cached;

    const visited = new Set<string>();
    const queue: string[] = [entryKey];

    while (queue.length > 0) {
      const currentKey = queue.shift()!;
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);

      const current = this.roles.get(currentKey);
      if (!current) {
        visited.delete(currentKey);
        continue;
      }
      for (const group of current.memberOf) {
        const g = group.toLowerCase();
        if (!visited.has(g)) queue.push(g);
      }
    }

    visited.delete(entryKey);
    this.membershipCache.set(entryKey, visited);
    return visited;
  }

  /** Memberships changed: drop the entire closure cache. */
  private invalidateMembershipCache(): void {
    this.membershipCache.clear();
  }
}
