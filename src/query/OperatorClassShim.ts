/**
 * OperatorClassShim — Metadata-only PostgreSQL operator class/family shim.
 *
 * PostgreSQL allows creating operator classes and families to define how
 * index access methods (e.g. btree, hash, gin) handle custom data types.
 * SQLite has no equivalent concept, so this shim stores operator class
 * and family definitions as metadata only — strategies are not enforced.
 *
 * ## Supported DDL
 *
 * ```sql
 * CREATE OPERATOR CLASS name FOR TYPE type USING index_method AS [
 *   OPERATOR strategy_number op_name [(op_type, op_type)] [FOR SEARCH|FOR ORDER BY],
 *   FUNCTION support_number func_name (arg_types),
 *   STORAGE storage_type
 * ];
 *
 * CREATE OPERATOR FAMILY name USING index_method;
 *
 * DROP OPERATOR CLASS name USING index_method;
 * DROP OPERATOR FAMILY name USING index_method;
 * ```
 *
 * All DDL is parsed and stored in internal tables. No actual index behaviour
 * is changed (SQLite limitation).
 *
 * ## Storage
 *
 * Operator classes are stored in `_sqlvec_opclasses`:
 *   - opclass_name, type_name, index_method, owner, created_at
 *
 * Operator families are stored in `_sqlvec_opfamilies`:
 *   - opfamily_name, index_method, owner, created_at
 *
 * ## Catalog exposure
 *
 * Metadata is exposed via `pg_opclass` and `pg_opfamily` catalog entries
 * in PgCatalog.ts, allowing clients (psql, DBeaver) to query them.
 *
 * @module query/OperatorClassShim
 */

import { PinoLogger } from '../logger/PinoLogger';

// ============================================================
//  Types
// ============================================================

export interface OperatorClassDef {
  opclassName: string;
  typeName: string;
  indexMethod: string;
  owner: string;
  createdAt: Date;
}

export interface OperatorFamilyDef {
  opfamilyName: string;
  indexMethod: string;
  owner: string;
  createdAt: Date;
}

export interface OperatorClassResult {
  rewritten: boolean;
  sql: string;
  error?: string;
}

// ============================================================
//  Constants — Regex patterns
// ============================================================

/**
 * Matches CREATE OPERATOR CLASS name FOR TYPE type USING method AS ...
 *
 * Groups:
 *   1 – Operator class name
 *   2 – Type name (the FOR TYPE argument)
 *   3 – Index method name (the USING argument)
 */
const CREATE_OPCLASS_RE =
  /^\s*CREATE\s+OPERATOR\s+CLASS\s+(\w+(?:\.\w+)?)\s+(?:DEFAULT\s+)?FOR\s+TYPE\s+(\w+(?:\.\w+)?)\s+USING\s+(\w+)(?:\s+FAMILY\s+\w+(?:\.\w+)?)?\s+AS\b/i;

/**
 * Matches CREATE OPERATOR FAMILY name USING method
 *
 * Groups:
 *   1 – Operator family name
 *   2 – Index method name
 */
const CREATE_OPFAMILY_RE =
  /^\s*CREATE\s+OPERATOR\s+FAMILY\s+(\w+(?:\.\w+)?)\s+USING\s+(\w+)\s*;?\s*$/i;

/**
 * Matches DROP OPERATOR CLASS name USING method
 *
 * Groups:
 *   1 – Operator class name
 *   2 – Index method name
 */
const DROP_OPCLASS_RE =
  /^\s*DROP\s+OPERATOR\s+CLASS\s+(\w+(?:\.\w+)?)\s+USING\s+(\w+)\s*;?\s*$/i;

/**
 * Matches DROP OPERATOR FAMILY name USING method
 *
 * Groups:
 *   1 – Operator family name
 *   2 – Index method name
 */
const DROP_OPFAMILY_RE =
  /^\s*DROP\s+OPERATOR\s+FAMILY\s+(\w+(?:\.\w+)?)\s+USING\s+(\w+)\s*;?\s*$/i;

/**
 * Match SET/DROP for operator classes/families.
 * Fast prefix check before attempting the detailed regex.
 */
const OPCLASS_PREFIX_RE = /^\s*(?:CREATE|DROP)\s+OPERATOR\s+(CLASS|FAMILY)\b/i;

// ============================================================
//  OperatorClassShim
// ============================================================

export class OperatorClassShim {
  private static instance: OperatorClassShim;
  private logger: PinoLogger;

  /** In-memory registry of operator classes, keyed by "method/name" */
  private opclasses: Map<string, OperatorClassDef> = new Map();

  /** In-memory registry of operator families, keyed by "method/name" */
  private opfamilies: Map<string, OperatorFamilyDef> = new Map();

  /** Database handle for persisting metadata to SQLite */
  private db: any | null = null;

  private tableInitialized = false;

  constructor() {
    this.logger = PinoLogger.forComponent('OperatorClassShim');
  }

  static getInstance(): OperatorClassShim {
    if (!OperatorClassShim.instance) {
      OperatorClassShim.instance = new OperatorClassShim();
    }
    return OperatorClassShim.instance;
  }

  /**
   * Set the database handle for persisting metadata to SQLite tables.
   */
  setDb(db: any): void {
    this.db = db;
    this.ensureTables();
  }

  /**
   * Create the underlying SQLite tables for operator class/family metadata.
   */
  private ensureTables(): void {
    if (this.tableInitialized || !this.db) return;

    try {
      const executor = this.db.exec || this.db.execute;
      if (typeof executor !== 'function') return;

      executor(
        `CREATE TABLE IF NOT EXISTS _sqlvec_opclasses (
          opclass_name TEXT NOT NULL,
          type_name TEXT NOT NULL,
          index_method TEXT NOT NULL,
          owner TEXT NOT NULL DEFAULT 'postgres',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (opclass_name, index_method)
        )`,
      );
      executor(
        `CREATE TABLE IF NOT EXISTS _sqlvec_opfamilies (
          opfamily_name TEXT NOT NULL,
          index_method TEXT NOT NULL,
          owner TEXT NOT NULL DEFAULT 'postgres',
          created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
          PRIMARY KEY (opfamily_name, index_method)
        )`,
      );

      this.tableInitialized = true;
      this.logger.debug('Operator class/family metadata tables initialised');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to create operator class/family tables');
    }
  }

  // ── DDL handlers ──────────────────────────────────

  /**
   * Handle CREATE OPERATOR CLASS statement.
   */
  handleCreateOperatorClass(sql: string): OperatorClassResult {
    const match = sql.match(CREATE_OPCLASS_RE);
    if (!match) {
      return {
        rewritten: false,
        sql,
        error: 'Invalid CREATE OPERATOR CLASS syntax',
      };
    }

    const opclassName = match[1];
    const typeName = match[2];
    const indexMethod = match[3];
    const key = `${indexMethod}/${opclassName}`;

    if (this.opclasses.has(key)) {
      return {
        rewritten: true,
        sql: 'SELECT 1',
        error: `Operator class '${opclassName}' already exists for method '${indexMethod}'`,
      };
    }

    const def: OperatorClassDef = {
      opclassName,
      typeName,
      indexMethod,
      owner: 'postgres',
      createdAt: new Date(),
    };

    this.opclasses.set(key, def);
    this.persistOpclass(def);

    this.logger.info(
      { opclassName, typeName, indexMethod },
      'Operator class created (metadata only)',
    );

    return { rewritten: true, sql: 'SELECT 1' };
  }

  /**
   * Handle CREATE OPERATOR FAMILY statement.
   */
  handleCreateOperatorFamily(sql: string): OperatorClassResult {
    const match = sql.match(CREATE_OPFAMILY_RE);
    if (!match) {
      return {
        rewritten: false,
        sql,
        error: 'Invalid CREATE OPERATOR FAMILY syntax',
      };
    }

    const opfamilyName = match[1];
    const indexMethod = match[2];
    const key = `${indexMethod}/${opfamilyName}`;

    if (this.opfamilies.has(key)) {
      return {
        rewritten: true,
        sql: 'SELECT 1',
        error: `Operator family '${opfamilyName}' already exists for method '${indexMethod}'`,
      };
    }

    const def: OperatorFamilyDef = {
      opfamilyName,
      indexMethod,
      owner: 'postgres',
      createdAt: new Date(),
    };

    this.opfamilies.set(key, def);
    this.persistOpfamily(def);

    this.logger.info(
      { opfamilyName, indexMethod },
      'Operator family created (metadata only)',
    );

    return { rewritten: true, sql: 'SELECT 1' };
  }

  /**
   * Handle DROP OPERATOR CLASS statement.
   */
  handleDropOperatorClass(sql: string): OperatorClassResult {
    const match = sql.match(DROP_OPCLASS_RE);
    if (!match) {
      return {
        rewritten: false,
        sql,
        error: 'Invalid DROP OPERATOR CLASS syntax',
      };
    }

    const opclassName = match[1];
    const indexMethod = match[2];
    const key = `${indexMethod}/${opclassName}`;

    if (!this.opclasses.has(key)) {
      return {
        rewritten: true,
        sql: 'SELECT 1',
        error: `Operator class '${opclassName}' does not exist for method '${indexMethod}'`,
      };
    }

    this.opclasses.delete(key);
    this.removePersistedOpclass(opclassName, indexMethod);

    this.logger.info(
      { opclassName, indexMethod },
      'Operator class dropped (metadata only)',
    );

    return { rewritten: true, sql: 'SELECT 1' };
  }

  /**
   * Handle DROP OPERATOR FAMILY statement.
   */
  handleDropOperatorFamily(sql: string): OperatorClassResult {
    const match = sql.match(DROP_OPFAMILY_RE);
    if (!match) {
      return {
        rewritten: false,
        sql,
        error: 'Invalid DROP OPERATOR FAMILY syntax',
      };
    }

    const opfamilyName = match[1];
    const indexMethod = match[2];
    const key = `${indexMethod}/${opfamilyName}`;

    if (!this.opfamilies.has(key)) {
      return {
        rewritten: true,
        sql: 'SELECT 1',
        error: `Operator family '${opfamilyName}' does not exist for method '${indexMethod}'`,
      };
    }

    this.opfamilies.delete(key);
    this.removePersistedOpfamily(opfamilyName, indexMethod);

    this.logger.info(
      { opfamilyName, indexMethod },
      'Operator family dropped (metadata only)',
    );

    return { rewritten: true, sql: 'SELECT 1' };
  }

  /**
   * Detect whether the given SQL is an operator class/family DDL statement.
   *
   * @param sql  The raw SQL string to inspect
   * @returns    The type of operator DDL detected, or false
   */
  static detect(sql: string): 'create_opclass' | 'create_opfamily' | 'drop_opclass' | 'drop_opfamily' | false {
    if (typeof sql !== 'string' || sql.trim().length === 0) return false;
    const trimmed = sql.trim();

    if (!OPCLASS_PREFIX_RE.test(trimmed)) return false;

    if (CREATE_OPCLASS_RE.test(trimmed)) return 'create_opclass';
    if (CREATE_OPFAMILY_RE.test(trimmed)) return 'create_opfamily';
    if (DROP_OPCLASS_RE.test(trimmed)) return 'drop_opclass';
    if (DROP_OPFAMILY_RE.test(trimmed)) return 'drop_opfamily';

    return false;
  }

  /**
   * Process an operator class/family DDL statement.
   * Returns a rewritten result (no-op SELECT 1 with metadata stored).
   */
  process(sql: string): OperatorClassResult {
    const type = OperatorClassShim.detect(sql);
    if (!type) {
      return { rewritten: false, sql };
    }

    switch (type) {
      case 'create_opclass':
        return this.handleCreateOperatorClass(sql);
      case 'create_opfamily':
        return this.handleCreateOperatorFamily(sql);
      case 'drop_opclass':
        return this.handleDropOperatorClass(sql);
      case 'drop_opfamily':
        return this.handleDropOperatorFamily(sql);
    }
  }

  // ── Query helpers ──────────────────────────────────

  /**
   * Get all stored operator classes.
   */
  getAllOpclasses(): OperatorClassDef[] {
    return Array.from(this.opclasses.values());
  }

  /**
   * Get all stored operator families.
   */
  getAllOpfamilies(): OperatorFamilyDef[] {
    return Array.from(this.opfamilies.values());
  }

  /**
   * Load operator classes from the SQLite table (crash recovery).
   */
  loadFromDb(): void {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare
        ? this.db.prepare('SELECT * FROM _sqlvec_opclasses')
        : null;
      if (!stmt) return;

      const rows = stmt.all() as any[];
      for (const row of rows) {
        const key = `${row.index_method}/${row.opclass_name}`;
        if (!this.opclasses.has(key)) {
          this.opclasses.set(key, {
            opclassName: String(row.opclass_name),
            typeName: String(row.type_name),
            indexMethod: String(row.index_method),
            owner: String(row.owner),
            createdAt: new Date(Number(row.created_at) * 1000),
          });
        }
      }

      const famStmt = this.db.prepare('SELECT * FROM _sqlvec_opfamilies');
      const famRows = famStmt.all() as any[];
      for (const row of famRows) {
        const key = `${row.index_method}/${row.opfamily_name}`;
        if (!this.opfamilies.has(key)) {
          this.opfamilies.set(key, {
            opfamilyName: String(row.opfamily_name),
            indexMethod: String(row.index_method),
            owner: String(row.owner),
            createdAt: new Date(Number(row.created_at) * 1000),
          });
        }
      }

      this.logger.debug(
        { opclasses: this.opclasses.size, opfamilies: this.opfamilies.size },
        'Loaded operator class/family metadata from DB',
      );
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load operator class/family from DB');
    }
  }

  // ── Persistence helpers ────────────────────────────

  private persistOpclass(def: OperatorClassDef): void {
    if (!this.db) return;
    try {
      const stmt =
        this.db.prepare(
          `INSERT OR REPLACE INTO _sqlvec_opclasses (opclass_name, type_name, index_method, owner, created_at) VALUES (?, ?, ?, ?, strftime('%s','now'))`,
        );
      stmt.run(def.opclassName, def.typeName, def.indexMethod, def.owner);
    } catch (err) {
      this.logger.warn({ err, opclassName: def.opclassName }, 'Failed to persist opclass');
    }
  }

  private persistOpfamily(def: OperatorFamilyDef): void {
    if (!this.db) return;
    try {
      const stmt =
        this.db.prepare(
          `INSERT OR REPLACE INTO _sqlvec_opfamilies (opfamily_name, index_method, owner, created_at) VALUES (?, ?, ?, strftime('%s','now'))`,
        );
      stmt.run(def.opfamilyName, def.indexMethod, def.owner);
    } catch (err) {
      this.logger.warn({ err, opfamilyName: def.opfamilyName }, 'Failed to persist opfamily');
    }
  }

  private removePersistedOpclass(opclassName: string, indexMethod: string): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(
        `DELETE FROM _sqlvec_opclasses WHERE opclass_name = ? AND index_method = ?`,
      );
      stmt.run(opclassName, indexMethod);
    } catch (err) {
      this.logger.warn({ err, opclassName }, 'Failed to remove persisted opclass');
    }
  }

  private removePersistedOpfamily(opfamilyName: string, indexMethod: string): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(
        `DELETE FROM _sqlvec_opfamilies WHERE opfamily_name = ? AND index_method = ?`,
      );
      stmt.run(opfamilyName, indexMethod);
    } catch (err) {
      this.logger.warn({ err, opfamilyName }, 'Failed to remove persisted opfamily');
    }
  }
}
