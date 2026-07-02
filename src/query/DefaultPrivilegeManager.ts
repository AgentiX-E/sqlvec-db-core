/**
 * DefaultPrivilegeManager — ALTER DEFAULT PRIVILEGES support for SQLVec.
 *
 * PostgreSQL's ALTER DEFAULT PRIVILEGES allows users to define privilege rules
 * that auto-apply when an object (table, view, sequence, function) is created
 * by a specified role in a specified schema.
 *
 * This implementation:
 *   1. Parses ALTER DEFAULT PRIVILEGES SQL statements
 *   2. Stores rules in the `_sqlvec_default_privileges` system table
 *   3. Applies matching rules when DDL creates new objects
 *   4. Supports REVOKE to remove rules
 *
 * ## Supported SQL Syntax
 *
 * ```sql
 * ALTER DEFAULT PRIVILEGES
 *   [ FOR { ROLE | USER } target_role ]
 *   [ IN SCHEMA schema_name ]
 *   { GRANT | REVOKE } priv_types ON object_types TO grantee
 *   { GRANT | REVOKE } priv_types ON object_types FROM grantee
 * ```
 *
 * ## Object types: TABLES, SEQUENCES, FUNCTIONS, TYPES
 * ## Privilege types: SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, ALL
 *
 * @module query/DefaultPrivilegeManager
 */

import Database from 'better-sqlite3';
import { PinoLogger } from '../monitoring/PinoLogger';

// ═══════════════════════════════════════════════════════════════════
//  Constants
// ═══════════════════════════════════════════════════════════════════

const SYSTEM_TABLE = '_sqlvec_default_privileges';

// ═══════════════════════════════════════════════════════════════════
//  Types
// ═══════════════════════════════════════════════════════════════════

export interface DefaultPrivilegeRule {
  id?: number;
  /** The role that this rule was defined by (current_user at parse time) */
  grantorRole?: string | null;
  /** FOR ROLE <target_role> — restricts the rule to objects created by this role (null = all) */
  targetRole?: string | null;
  /** IN SCHEMA <schema_name> — restricts the rule to objects in this schema (null = all) */
  schemaName?: string | null;
  /** Object type: TABLES, SEQUENCES, FUNCTIONS, TYPES */
  objectType: string;
  /** Privilege type: SELECT, INSERT, UPDATE, DELETE, etc., or ALL */
  privilegeType: string;
  /** true = GRANT, false = REVOKE */
  isGrant: boolean;
  /** TO <grantee> — the role receiving the privilege */
  grantee: string;
  /** Auto-set timestamp */
  createdAt?: string;
}

// ═══════════════════════════════════════════════════════════════════
//  Regex patterns
// ═══════════════════════════════════════════════════════════════════

/**
 * Full ALTER DEFAULT PRIVILEGES pattern.
 *
 * Group capture:
 *   1 - target_role (if FOR ROLE/USER clause present)
 *   2 - schema_name (if IN SCHEMA clause present)
 *   3 - GRANT or REVOKE keyword
 *   4 - privilege list (e.g. "SELECT, INSERT" or "ALL")
 *   5 - object type (TABLES, SEQUENCES, FUNCTIONS, TYPES)
 *   6 - TO or FROM
 *   7 - grantee name
 */
const ALTER_DEFAULT_PRIVILEGES_RE =
  /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\s*((?:FOR\s+(?:ROLE|USER)\s+(\S+)\s*)?)((?:IN\s+SCHEMA\s+(\S+)\s*)?)\s*(GRANT|REVOKE)\s+(.+?)\s+ON\s+(TABLES|SEQUENCES|FUNCTIONS|TYPES)\s+(TO|FROM)\s+(\S+?)\s*;?\s*$/i;

/**
 * Detect whether a SQL statement starts with ALTER DEFAULT PRIVILEGES.
 */
const ALTER_DEFAULT_START_RE = /^\s*ALTER\s+DEFAULT\s+PRIVILEGES\s/i;

// ═══════════════════════════════════════════════════════════════════
//  DefaultPrivilegeManager Class
// ═══════════════════════════════════════════════════════════════════

export class DefaultPrivilegeManager {
  private readonly logger = PinoLogger.forComponent('DefaultPrivilegeManager');
  private db: Database.Database | null = null;
  private ready = false;

  // ── Initialization ─────────────────────────────────────────────

  /**
   * Initialize with a better-sqlite3 database.
   * Creates the _sqlvec_default_privileges table if it doesn't exist.
   */
  init(db: Database.Database): void {
    this.db = db;
    this.createSystemTable();
    this.ready = true;
    this.logger.debug('DefaultPrivilegeManager initialized');
  }

  private createSystemTable(): void {
    if (!this.db) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${SYSTEM_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        grantor_role TEXT,
        target_role TEXT,
        schema_name TEXT,
        object_type TEXT NOT NULL,
        privilege_type TEXT NOT NULL,
        is_grant INTEGER NOT NULL DEFAULT 1,
        grantee TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  /** Whether the manager is backed by a real database. */
  isReady(): boolean {
    return this.ready && this.db !== null;
  }

  // ── SQL Detection ──────────────────────────────────────────────

  /**
   * Check if a SQL statement is an ALTER DEFAULT PRIVILEGES statement.
   */
  detect(sql: string): boolean {
    return ALTER_DEFAULT_START_RE.test(sql.trim());
  }

  // ── Parsing ────────────────────────────────────────────────────

  /**
   * Parse an ALTER DEFAULT PRIVILEGES SQL statement.
   *
   * @returns The parsed rule (not yet stored).
   * @throws Error if the SQL cannot be parsed.
   */
  parse(sql: string): DefaultPrivilegeRule {
    const trimmed = sql.trim();
    const match = ALTER_DEFAULT_PRIVILEGES_RE.exec(trimmed);

    if (!match) {
      throw new Error(
        `Unable to parse ALTER DEFAULT PRIVILEGES: "${sql.substring(0, 120)}"`,
      );
    }

    // Extract captured groups
    const targetRole = match[2] || undefined;
    const schemaName = match[4] || undefined;
    const action = match[5].toUpperCase(); // GRANT or REVOKE
    const rawPrivileges = match[6].trim();
    const objectType = match[7].toUpperCase();
    const toFrom = match[8].toUpperCase();
    const grantee = match[9];

    // Normalize privilege type
    let privilegeType = rawPrivileges.toUpperCase();
    // Strip "PRIVILEGES" suffix (e.g. "ALL PRIVILEGES" → "ALL")
    privilegeType = privilegeType.replace(/\s+PRIVILEGES$/, '');
    // Normalize whitespace in comma-separated lists
    privilegeType = privilegeType.replace(/\s*,\s*/g, ', ');

    // Validate TO/FROM matches GRANT/REVOKE
    if (action === 'GRANT' && toFrom !== 'TO') {
      throw new Error('GRANT must use TO, not FROM');
    }
    if (action === 'REVOKE' && toFrom !== 'FROM') {
      throw new Error('REVOKE must use FROM, not TO');
    }

    const targetRoleVal = targetRole || null;
    const schemaNameVal = schemaName || null;

    this.logger.debug(
      { action, privilegeType, objectType, targetRole: targetRoleVal, schemaName: schemaNameVal, grantee },
      'Parsed ALTER DEFAULT PRIVILEGES',
    );

    return {
      targetRole: targetRoleVal,
      schemaName: schemaNameVal,
      objectType,
      privilegeType,
      isGrant: action === 'GRANT',
      grantee,
    };
  }

  /**
   * Handle an ALTER DEFAULT PRIVILEGES SQL statement.
   *
   * For GRANT: parses and stores the rule.
   * For REVOKE: parses and removes matching rules.
   *
   * @returns The result of the operation.
   */
  handle(sql: string): { handled: boolean; rule?: DefaultPrivilegeRule; deletedCount?: number } {
    if (!this.detect(sql)) {
      return { handled: false };
    }

    if (!this.isReady()) {
      throw new Error('DefaultPrivilegeManager not initialized — call init(db) first');
    }

    const rule = this.parse(sql);

    let deletedCount = 0;

    if (rule.isGrant) {
      // GRANT variant — store the rule
      const stored = this.storeRule(rule);
      return { handled: true, rule: stored, deletedCount: 0 };
    } else {
      // REVOKE variant — remove matching rules
      deletedCount = this.removeMatchingRules(rule);
      return { handled: true, rule, deletedCount };
    }
  }

  // ── Database Operations ────────────────────────────────────────

  /**
   * Store a parsed rule in the database.
   * For comma-separated privileges (e.g. "SELECT, INSERT"), creates one row per privilege.
   */
  storeRule(rule: DefaultPrivilegeRule): DefaultPrivilegeRule {
    if (!this.isReady() || !this.db) throw new Error('DefaultPrivilegeManager not initialized');

    const privileges = rule.privilegeType
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    const insertStmt = this.db.prepare(`
      INSERT INTO ${SYSTEM_TABLE}
        (grantor_role, target_role, schema_name, object_type, privilege_type, is_grant, grantee)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    if (privileges.length > 1) {
      // Multiple privileges → one row per privilege
      const insertMany = this.db.transaction(() => {
        for (const priv of privileges) {
          insertStmt.run(
            rule.grantorRole ?? null,
            rule.targetRole ?? null,
            rule.schemaName ?? null,
            rule.objectType,
            priv,
            rule.isGrant ? 1 : 0,
            rule.grantee,
          );
        }
      });
      insertMany();
    } else {
      insertStmt.run(
        rule.grantorRole ?? null,
        rule.targetRole ?? null,
        rule.schemaName ?? null,
        rule.objectType,
        privileges[0] || rule.privilegeType,
        rule.isGrant ? 1 : 0,
        rule.grantee,
      );
    }

    // Return the stored rule (with id from last insert)
    const lastId = (this.db.prepare('SELECT last_insert_rowid() as id').get() as { id: number }).id;
    const stored = { ...rule, id: lastId, privilegeType: privileges[0] || rule.privilegeType };
    this.logger.debug({ id: lastId, rule: stored }, 'Default privilege rule stored');
    return stored;
  }

  /**
   * Remove rules matching the given criteria (for REVOKE).
   * Matching is based on: targetRole, schemaName, objectType, privilegeType, grantee.
   * Null fields are treated as wildcards.
   *
   * @returns The number of deleted rows.
   */
  removeMatchingRules(rule: DefaultPrivilegeRule): number {
    if (!this.isReady() || !this.db) throw new Error('DefaultPrivilegeManager not initialized');

    const conditions: string[] = [];
    const params: any[] = [];

    if (rule.targetRole !== null && rule.targetRole !== undefined) {
      conditions.push('target_role = ?');
      params.push(rule.targetRole);
    }
    if (rule.schemaName !== null && rule.schemaName !== undefined) {
      conditions.push('schema_name = ?');
      params.push(rule.schemaName);
    }
    conditions.push('object_type = ?');
    params.push(rule.objectType);

    // Handle comma-separated privilege types for revoke
    const privileges = rule.privilegeType
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    if (privileges.length > 1) {
      conditions.push(`privilege_type IN (${privileges.map(() => '?').join(',')})`);
      params.push(...privileges);
    } else if (privileges.length === 1 && privileges[0] === 'ALL') {
      // ALL matches all privileges — no privilege_type filter
      // (all privileges on this object type are revoked)
    } else {
      conditions.push('privilege_type = ?');
      params.push(privileges[0] || rule.privilegeType);
    }

    conditions.push('grantee = ?');
    params.push(rule.grantee);

    // Only delete GRANT rules (default privileges are defined as GRANT rules)
    conditions.push('is_grant = 1');

    const whereClause = conditions.join(' AND ');
    const deleteStmt = this.db.prepare(
      `DELETE FROM ${SYSTEM_TABLE} WHERE ${whereClause}`,
    );

    const result = deleteStmt.run(...params);
    this.logger.debug({ deletedCount: result.changes }, 'Default privilege rules removed');
    return result.changes;
  }

  /**
   * Remove a single rule by ID.
   */
  removeRuleById(id: number): boolean {
    if (!this.isReady() || !this.db) return false;
    const stmt = this.db.prepare(`DELETE FROM ${SYSTEM_TABLE} WHERE id = ?`);
    const result = stmt.run(id);
    return result.changes > 0;
  }

  // ── Application ────────────────────────────────────────────────

  /**
   * Apply default privileges for a newly created object.
   *
   * Called when a table/view/sequence/function is created.
   * Finds matching rules and generates GRANT SQL for each.
   *
   * @param objectType - Type of object created (TABLES, SEQUENCES, FUNCTIONS, TYPES)
   * @param schemaName - Schema the object was created in
   * @param ownerRole  - Role that created the object
   * @param objectName - Name of the created object
   * @returns Array of GRANT SQL statements that should be applied, or empty if none
   */
  getGrantSqlForObject(
    objectType: string,
    schemaName: string,
    ownerRole: string,
    objectName: string,
  ): string[] {
    if (!this.isReady() || !this.db) return [];

    const objectTypeUp = objectType.toUpperCase();
    let objectTypeDb = objectTypeUp;
    // Normalize: TABLE → TABLES, VIEW → TABLES, SEQUENCE → SEQUENCES
    if (objectTypeUp === 'TABLE' || objectTypeUp === 'VIEW' || objectTypeUp === 'INDEX') {
      objectTypeDb = 'TABLES';
    } else if (objectTypeUp === 'SEQUENCE') {
      objectTypeDb = 'SEQUENCES';
    } else if (objectTypeUp === 'FUNCTION' || objectTypeUp === 'PROCEDURE') {
      objectTypeDb = 'FUNCTIONS';
    }

    const rules = this.findMatchingRules(ownerRole, schemaName, objectTypeDb);

    const grantStatements: string[] = [];
    for (const rule of rules) {
      if (rule.isGrant) {
        grantStatements.push(
          `GRANT ${rule.privilegeType} ON ${objectName} TO ${rule.grantee}`,
        );
      }
    }

    return grantStatements;
  }

  /**
   * Find rules that match the given owner role, schema, and object type.
   */
  private findMatchingRules(
    ownerRole: string,
    schemaName: string,
    objectType: string,
  ): DefaultPrivilegeRule[] {
    if (!this.isReady() || !this.db) return [];

    const conditions: string[] = [];
    const params: any[] = [];

    // Match if: target_role is NULL (any role) OR matches the owner
    conditions.push('(target_role IS NULL OR target_role = ?)');
    params.push(ownerRole);

    // Match if: schema_name is NULL (any schema) OR matches
    conditions.push('(schema_name IS NULL OR schema_name = ?)');
    params.push(schemaName);

    conditions.push('object_type = ?');
    params.push(objectType);

    // Only GRANT rules apply (REVOKE rules are for removing existing privileges)
    conditions.push('is_grant = 1');

    const rows = this.db
      .prepare(
        `SELECT * FROM ${SYSTEM_TABLE} WHERE ${conditions.join(' AND ')}`,
      )
      .all(...params) as any[];

    return rows.map(this.rowToRule);
  }

  // ── Utility ────────────────────────────────────────────────────

  /**
   * Get all stored rules.
   */
  getAllRules(): DefaultPrivilegeRule[] {
    if (!this.isReady() || !this.db) return [];
    const rows = this.db.prepare(`SELECT * FROM ${SYSTEM_TABLE} ORDER BY id`).all() as any[];
    return rows.map(this.rowToRule);
  }

  /**
   * Get rules matching the given critera.
   */
  getRules(filter: {
    targetRole?: string;
    schemaName?: string;
    objectType?: string;
    grantee?: string;
  }): DefaultPrivilegeRule[] {
    if (!this.isReady() || !this.db) return [];

    const conditions: string[] = [];
    const params: any[] = [];

    if (filter.targetRole) {
      conditions.push('target_role = ?');
      params.push(filter.targetRole);
    }
    if (filter.schemaName) {
      conditions.push('schema_name = ?');
      params.push(filter.schemaName);
    }
    if (filter.objectType) {
      conditions.push('object_type = ?');
      params.push(filter.objectType.toUpperCase());
    }
    if (filter.grantee) {
      conditions.push('grantee = ?');
      params.push(filter.grantee);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM ${SYSTEM_TABLE} ${whereClause} ORDER BY id`)
      .all(...params) as any[];

    return rows.map(this.rowToRule);
  }

  /**
   * Clear all rules (for testing).
   */
  clearAllRules(): void {
    if (!this.isReady() || !this.db) return;
    this.db.exec(`DELETE FROM ${SYSTEM_TABLE}`);
    this.logger.debug('All default privilege rules cleared');
  }

  /**
   * Reset the manager state (close and clear).
   */
  reset(): void {
    this.db = null;
    this.ready = false;
  }

  // ── Private Helpers ────────────────────────────────────────────

  private rowToRule(row: any): DefaultPrivilegeRule {
    return {
      id: row.id,
      grantorRole: row.grantor_role,
      targetRole: row.target_role,
      schemaName: row.schema_name,
      objectType: row.object_type,
      privilegeType: row.privilege_type,
      isGrant: row.is_grant === 1,
      grantee: row.grantee,
      createdAt: row.created_at,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Standalone functions (for use by SetResetShim / DDLTriggerManager)
// ═══════════════════════════════════════════════════════════════════

/**
 * Detect whether a SQL string is an ALTER DEFAULT PRIVILEGES statement.
 *
 * @returns `true` if the statement is ALTER DEFAULT PRIVILEGES.
 */
export function detectAlterDefaultPrivileges(sql: string): boolean {
  return ALTER_DEFAULT_START_RE.test(sql.trim());
}
