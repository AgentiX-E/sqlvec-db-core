/**
 * SystemTypes — PostgreSQL built-in type mappings for system catalogs
 *
 * Maps PostgreSQL type names (oid, xid, regclass, etc.) to their
 * compatible TypeScript/SQL types and provides a registry for name-based
 * lookup. All types return static, schema-compatible mappings.
 */

export enum PgTypeCategory {
  NUMERIC = 'numeric',
  STRING = 'string',
  DATETIME = 'datetime',
  BOOLEAN = 'boolean',
  BINARY = 'binary',
  GEOMETRY = 'geometry',
  NETWORK = 'network',
  MISC = 'misc',
  PSEUDO = 'pseudo',
}

export interface PgTypeInfo {
  /** OID (PostgreSQL internal type number) */
  oid: number;
  /** Type name as known in SQL */
  name: string;
  /** Compatible TypeScript/JSON type for results */
  tsType: string;
  /** SQL-compatible type string for column definitions */
  sqlType: string;
  /** Category for pg_type view */
  category: PgTypeCategory;
  /** Whether this type can be used in table definitions */
  isBaseType: boolean;
  /** Length/precision hint (0 = variable) */
  length: number;
}

/**
 * Registry of all PostgreSQL built-in types relevant to system catalogs.
 */
export class SystemTypeRegistry {
  private static types: Map<number, PgTypeInfo> = new Map();
  private static byName: Map<string, PgTypeInfo> = new Map();
  private static initialized = false;

  /**
   * Initialize the type registry with all PG base types.
   * Safe to call multiple times.
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const entries: PgTypeInfo[] = [
      // Standard numeric types
      { oid: 16, name: 'bool', tsType: 'boolean', sqlType: 'BOOLEAN', category: PgTypeCategory.BOOLEAN, isBaseType: true, length: 1 },
      { oid: 17, name: 'bytea', tsType: 'string', sqlType: 'BYTEA', category: PgTypeCategory.BINARY, isBaseType: true, length: 0 },
      { oid: 18, name: 'char', tsType: 'string', sqlType: 'CHAR', category: PgTypeCategory.STRING, isBaseType: true, length: 1 },
      { oid: 19, name: 'name', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: true, length: 64 },
      { oid: 20, name: 'int8', tsType: 'number', sqlType: 'BIGINT', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 8 },
      { oid: 21, name: 'int2', tsType: 'number', sqlType: 'SMALLINT', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 2 },
      { oid: 22, name: 'int2vector', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: false, length: 0 },
      { oid: 23, name: 'int4', tsType: 'number', sqlType: 'INTEGER', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },
      { oid: 24, name: 'regproc', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 25, name: 'text', tsType: 'string', sqlType: 'TEXT', category: PgTypeCategory.STRING, isBaseType: true, length: 0 },
      { oid: 26, name: 'oid', tsType: 'number', sqlType: 'INTEGER', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },
      { oid: 27, name: 'tid', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: false, length: 0 },
      { oid: 28, name: 'xid', tsType: 'number', sqlType: 'INTEGER', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },
      { oid: 29, name: 'cid', tsType: 'number', sqlType: 'INTEGER', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },

      // Numeric types
      { oid: 700, name: 'float4', tsType: 'number', sqlType: 'REAL', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },
      { oid: 701, name: 'float8', tsType: 'number', sqlType: 'DOUBLE PRECISION', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 8 },
      { oid: 790, name: 'money', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 8 },
      { oid: 1700, name: 'numeric', tsType: 'number', sqlType: 'NUMERIC', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 0 },

      // Character types
      { oid: 1042, name: 'bpchar', tsType: 'string', sqlType: 'CHAR', category: PgTypeCategory.STRING, isBaseType: true, length: 0 },
      { oid: 1043, name: 'varchar', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: true, length: 0 },

      // Date/time types
      { oid: 702, name: 'abstime', tsType: 'string', sqlType: 'TIMESTAMP', category: PgTypeCategory.DATETIME, isBaseType: true, length: 8 },
      { oid: 703, name: 'reltime', tsType: 'number', sqlType: 'INTEGER', category: PgTypeCategory.NUMERIC, isBaseType: true, length: 4 },
      { oid: 704, name: 'tinterval', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.DATETIME, isBaseType: false, length: 0 },
      { oid: 1082, name: 'date', tsType: 'string', sqlType: 'DATE', category: PgTypeCategory.DATETIME, isBaseType: true, length: 4 },
      { oid: 1083, name: 'time', tsType: 'string', sqlType: 'TIME', category: PgTypeCategory.DATETIME, isBaseType: true, length: 8 },
      { oid: 1114, name: 'timestamp', tsType: 'string', sqlType: 'TIMESTAMP', category: PgTypeCategory.DATETIME, isBaseType: true, length: 8 },
      { oid: 1184, name: 'timestamptz', tsType: 'string', sqlType: 'TIMESTAMPTZ', category: PgTypeCategory.DATETIME, isBaseType: true, length: 8 },
      { oid: 1266, name: 'timetz', tsType: 'string', sqlType: 'TIMETZ', category: PgTypeCategory.DATETIME, isBaseType: true, length: 12 },
      { oid: 1186, name: 'interval', tsType: 'string', sqlType: 'INTERVAL', category: PgTypeCategory.DATETIME, isBaseType: true, length: 16 },

      // Network types
      { oid: 650, name: 'inet', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.NETWORK, isBaseType: true, length: 0 },
      { oid: 651, name: 'cidr', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.NETWORK, isBaseType: true, length: 0 },
      { oid: 829, name: 'macaddr', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.NETWORK, isBaseType: true, length: 0 },
      { oid: 869, name: 'macaddr8', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.NETWORK, isBaseType: true, length: 0 },

      // JSON types
      { oid: 114, name: 'json', tsType: 'string', sqlType: 'JSON', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },
      { oid: 3802, name: 'jsonb', tsType: 'string', sqlType: 'JSONB', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },

      // Bit types
      { oid: 1560, name: 'bit', tsType: 'string', sqlType: 'BIT', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },
      { oid: 1562, name: 'varbit', tsType: 'string', sqlType: 'VARBIT', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },

      // UUID
      { oid: 2950, name: 'uuid', tsType: 'string', sqlType: 'UUID', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },

      // pg_lsn
      { oid: 3220, name: 'pg_lsn', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: true, length: 8 },

      // Geometry
      { oid: 600, name: 'point', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },
      { oid: 601, name: 'lseg', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },
      { oid: 602, name: 'path', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },
      { oid: 603, name: 'box', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },
      { oid: 604, name: 'polygon', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },
      { oid: 718, name: 'circle', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.GEOMETRY, isBaseType: true, length: 0 },

      // Range types
      { oid: 3904, name: 'int4range', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },
      { oid: 3926, name: 'tstzrange', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: true, length: 0 },

      // Pseudo types (used for function signatures, not base types)
      { oid: 2275, name: 'cstring', tsType: 'string', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2276, name: 'any', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2277, name: 'anyarray', tsType: 'any[]', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2278, name: 'void', tsType: 'undefined', sqlType: 'VOID', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2279, name: 'trigger', tsType: 'any', sqlType: 'TRIGGER', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2280, name: 'event_trigger', tsType: 'any', sqlType: 'EVENT_TRIGGER', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2281, name: 'language_handler', tsType: 'any', sqlType: 'LANGUAGE_HANDLER', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2282, name: 'fdw_handler', tsType: 'any', sqlType: 'FDW_HANDLER', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2283, name: 'anyelement', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2287, name: 'anynonarray', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 2400, name: 'anysubarray', tsType: 'any[]', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 3115, name: 'fdw_handler', tsType: 'any', sqlType: 'FDW_HANDLER', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 3500, name: 'anyenum', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 3831, name: 'anycompatible', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 3832, name: 'anycompatiblearray', tsType: 'any[]', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },
      { oid: 3833, name: 'anycompatiblenonarray', tsType: 'any', sqlType: 'TEXT', category: PgTypeCategory.PSEUDO, isBaseType: false, length: 0 },

      // Registration types (oid aliases as VARCHAR for user-facing display)
      { oid: 2202, name: 'regprocedure', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 2203, name: 'regoper', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 2204, name: 'regoperator', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 2205, name: 'regclass', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 2206, name: 'regtype', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 4096, name: 'regrole', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },
      { oid: 4089, name: 'regnamespace', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.STRING, isBaseType: false, length: 0 },

      // ACL
      { oid: 1033, name: 'aclitem', tsType: 'string', sqlType: 'VARCHAR', category: PgTypeCategory.MISC, isBaseType: false, length: 0 },
    ];

    for (const info of entries) {
      this.types.set(info.oid, info);
      this.byName.set(info.name.toLowerCase(), info);
    }
  }

  /** Get type info by OID */
  static getByOid(oid: number): PgTypeInfo | undefined {
    this.init();
    return this.types.get(oid);
  }

  /** SQL standard type names to PG internal names mapping */
  private static typeAliases: Record<string, string> = {
    'integer': 'int4',
    'int': 'int4',
    'smallint': 'int2',
    'bigint': 'int8',
    'real': 'float4',
    'double precision': 'float8',
    'decimal': 'numeric',
    'boolean': 'bool',
    'character varying': 'varchar',
    'character': 'bpchar',
    'varchar': 'varchar',
    'char': 'bpchar',
    'citext': 'text',
    'hstore': 'text',
  };

  /** Get type info by type name (case-insensitive, supports SQL aliases) */
  static getByName(name: string): PgTypeInfo | undefined {
    this.init();
    const lower = name.toLowerCase().replace(/^_/, '');
    const alias = this.typeAliases[lower];
    if (alias) {
      return this.byName.get(alias);
    }
    return this.byName.get(lower);
  }

  /** Get all registered types */
  static getAll(): PgTypeInfo[] {
    this.init();
    return Array.from(this.types.values());
  }

  /** Get all base types (usable in table definitions) */
  static getBaseTypes(): PgTypeInfo[] {
    this.init();
    return Array.from(this.types.values()).filter(t => t.isBaseType);
  }

  /** Get OID for a type name */
  static getOid(name: string): number | undefined {
    this.init();
    return this.byName.get(name.toLowerCase())?.oid;
  }

  /** Get the SQL-compatible type string */
  static getSqlType(name: string): string | undefined {
    this.init();
    return this.byName.get(name.toLowerCase())?.sqlType;
  }
}
