/**
 * PgAttributeShim — pg_catalog.pg_attribute compatibility for SQLite.
 *
 * PostgreSQL's pg_catalog.pg_attribute catalogs column-level metadata for
 * all table columns. This shim generates pg_attribute rows from SQLite's
 * `PRAGMA table_info` output, covering all 30+ standard columns.
 *
 * PostgreSQL reference:
 *   - https://www.postgresql.org/docs/current/catalog-pg-attribute.html
 *
 * Columns:
 *   attrelid      oid         The table this column belongs to
 *   attname       name        Column name
 *   atttypid      oid         Data type of the column
 *   attstattarget int4        Controls level of detail of statistics
 *   attlen        int2        pg_type.typlen copy
 *   attnum        int2        Column number (1-based)
 *   attndims      int4        Number of array dimensions (0 if not array)
 *   attcacheoff   int4        Always -1 in memory
 *   atttypmod     int4        pg_type.typtypmod copy
 *   attbyval      bool        pg_type.typbyval copy
 *   attstorage    char        pg_type.typstorage copy
 *   attalign      char        pg_type.typalign copy
 *   attnotnull    bool        NOT NULL constraint
 *   atthasdef     bool        Has DEFAULT value
 *   atthasmissing bool        Has missing value for column addition
 *   attidentity   char        '' (not identity), 'a' (ALWAYS), 'd' (BY DEFAULT)
 *   attgenerated  char        '' (not generated), 's' (STORED)
 *   attisdropped  bool        Column has been dropped
 *   attislocal    bool        Column is local (not inherited)
 *   attinhcount   int4        Number of inheritance ancestors
 *   attcollation  oid         Column collation (0 = default)
 *   attacl        aclitem[]   Column-level access privileges
 *   attoptions    text[]      Attribute options
 *   attfdwoptions text[]      Foreign data wrapper options
 *   attmissingval anyarray    Missing value for column addition
 *
 * @module query/PgAttributeShim
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PgAttributeShim');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface PgAttributeRow {
  attrelid: number;
  attname: string;
  atttypid: number;
  attstattarget: number;
  attlen: number;
  attnum: number;
  attndims: number;
  attcacheoff: number;
  atttypmod: number;
  attbyval: boolean;
  attstorage: string;
  attalign: string;
  attnotnull: boolean;
  atthasdef: boolean;
  atthasmissing: boolean;
  attidentity: string;
  attgenerated: string;
  attisdropped: boolean;
  attislocal: boolean;
  attinhcount: number;
  attcollation: number;
  attacl: string | null;
  attoptions: string | null;
  attfdwoptions: string | null;
  attmissingval: string | null;
}

export interface PragmaTableInfoColumn {
  cid: number;
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
  hidden?: number;
}

// ──────────────────────────────────────────────
//  PG type OID mapping
// ──────────────────────────────────────────────

/**
 * Maps common SQLite column types to PostgreSQL type OIDs and metadata.
 */
const PG_TYPE_MAP: Record<string, { oid: number; len: number; byval: boolean; storage: string; align: string }> = {
  'INTEGER':   { oid: 23,   len: 4,  byval: true,  storage: 'p', align: 'i' },
  'INT':       { oid: 23,   len: 4,  byval: true,  storage: 'p', align: 'i' },
  'INT4':      { oid: 23,   len: 4,  byval: true,  storage: 'p', align: 'i' },
  'INT8':      { oid: 20,   len: 8,  byval: true,  storage: 'p', align: 'd' },
  'BIGINT':    { oid: 20,   len: 8,  byval: true,  storage: 'p', align: 'd' },
  'SMALLINT':  { oid: 21,   len: 2,  byval: true,  storage: 'p', align: 's' },
  'TINYINT':   { oid: 21,   len: 2,  byval: true,  storage: 'p', align: 's' },
  'BOOLEAN':   { oid: 16,   len: 1,  byval: true,  storage: 'p', align: 'c' },
  'BOOL':      { oid: 16,   len: 1,  byval: true,  storage: 'p', align: 'c' },
  'TEXT':      { oid: 25,   len: -1, byval: false, storage: 'x', align: 'i' },
  'VARCHAR':   { oid: 1043, len: -1, byval: false, storage: 'x', align: 'i' },
  'CHAR':      { oid: 1042, len: -1, byval: false, storage: 'x', align: 'i' },
  'REAL':      { oid: 701,  len: 8,  byval: true,  storage: 'p', align: 'd' },
  'FLOAT':     { oid: 701,  len: 8,  byval: true,  storage: 'p', align: 'd' },
  'DOUBLE':    { oid: 701,  len: 8,  byval: true,  storage: 'p', align: 'd' },
  'DECIMAL':   { oid: 1700, len: -1, byval: false, storage: 'm', align: 'i' },
  'NUMERIC':   { oid: 1700, len: -1, byval: false, storage: 'm', align: 'i' },
  'BLOB':      { oid: 17,   len: -1, byval: false, storage: 'x', align: 'i' },
  'BYTEA':     { oid: 17,   len: -1, byval: false, storage: 'x', align: 'i' },
  'DATE':      { oid: 1082, len: 4,  byval: true,  storage: 'p', align: 'i' },
  'DATETIME':  { oid: 1114, len: 8,  byval: true,  storage: 'p', align: 'd' },
  'TIMESTAMP': { oid: 1114, len: 8,  byval: true,  storage: 'p', align: 'd' },
  'JSON':      { oid: 114,  len: -1, byval: false, storage: 'x', align: 'i' },
  'JSONB':     { oid: 3802, len: -1, byval: false, storage: 'x', align: 'i' },
};

const DEFAULT_TYPE_INFO = { oid: 25, len: -1, byval: false, storage: 'x', align: 'i' };

// ──────────────────────────────────────────────
//  Helper functions
// ──────────────────────────────────────────────

/**
 * Determine PG type info from a SQLite column type string.
 */
function getTypeInfo(typeName: string): { oid: number; len: number; byval: boolean; storage: string; align: string } {
  const upper = typeName?.trim().toUpperCase() || '';
  // Handle type modifiers like VARCHAR(255), DECIMAL(10,2)
  const baseType = upper.replace(/\(.*\)/, '');
  return PG_TYPE_MAP[baseType] || DEFAULT_TYPE_INFO;
}

/**
 * Compute a pseudo-OID for a table from its name.
 * Uses a stable hash to produce the same OID across requests.
 */
function tableNameToOid(tableName: string): number {
  let hash = 0;
  for (let i = 0; i < tableName.length; i++) {
    const char = tableName.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash | 0; // Convert to 32bit integer
  }
  // Map to a range that doesn't collide with PG system catalogs
  return 100000 + Math.abs(hash);
}

// ──────────────────────────────────────────────
//  Main API
// ──────────────────────────────────────────────

export interface PgAttributeOptions {
  /** Table OID override (for integration with pg_class) */
  tableOid?: number;
  /** Custom type map for integration with pg_type */
  customTypeMap?: Record<string, { oid: number; len: number; byval: boolean; storage: string; align: string }>;
}

/**
 * Generate pg_catalog.pg_attribute rows from SQLite PRAGMA table_info.
 *
 * @param tableName - The table name to get attributes for.
 * @param columns - Column metadata from PRAGMA table_info.
 * @param options - Optional overrides (table OID, custom type map).
 * @returns Array of PgAttributeRow objects.
 */
export function getPgAttributes(
  tableName: string,
  columns: PragmaTableInfoColumn[],
  options?: PgAttributeOptions,
): PgAttributeRow[] {
  if (!tableName || !columns || columns.length === 0) {
    return [];
  }

  const tableOid = options?.tableOid ?? tableNameToOid(tableName);
  const typeMap = options?.customTypeMap ?? PG_TYPE_MAP;

  const rows: PgAttributeRow[] = [];

  for (const col of columns) {
    const typeInfo = getTypeInfo(col.type);
    const attnum = col.cid + 1; // PG uses 1-based column numbers

    // Determine if column has default
    const atthasdef = col.dflt_value !== null && col.dflt_value !== undefined;

    rows.push({
      attrelid: tableOid,
      attname: col.name,
      atttypid: typeInfo.oid,
      attstattarget: -1,    // Default statistics target
      attlen: typeInfo.len,
      attnum,
      attndims: 0,           // No array dimensions for non-array types
      attcacheoff: -1,       // Always -1 for on-disk
      atttypmod: -1,         // Default typmod
      attbyval: typeInfo.byval,
      attstorage: typeInfo.storage,
      attalign: typeInfo.align,
      attnotnull: col.notnull,
      atthasdef,
      atthasmissing: false,  // No missing values
      attidentity: '',       // Not an identity column by default
      attgenerated: '',      // Not a generated column by default
      attisdropped: false,   // Not dropped
      attislocal: true,      // Local column (not inherited)
      attinhcount: 0,        // No inheritance ancestors
      attcollation: 0,       // Default collation
      attacl: null,          // No ACL by default
      attoptions: null,      // No options
      attfdwoptions: null,   // No FDW options
      attmissingval: null,   // No missing value
    });
  }

  return rows;
}

/**
 * Generate the full pg_attribute row list for all user tables in a schema.
 *
 * @param tables - Map of table name → PRAGMA table_info columns.
 * @returns Combined array of PgAttributeRow for all tables.
 */
export function getPgAttributesForAllTables(
  tables: Map<string, PragmaTableInfoColumn[]>,
  options?: PgAttributeOptions,
): PgAttributeRow[] {
  const allRows: PgAttributeRow[] = [];
  for (const [tableName, columns] of tables.entries()) {
    const rows = getPgAttributes(tableName, columns, options);
    allRows.push(...rows);
  }
  return allRows;
}

/**
 * Format pg_attribute rows as a SQL result that can be returned by
 * QueryRouter for pg_catalog.pg_attribute queries.
 *
 * @param rows - Array of PgAttributeRow objects.
 * @returns Formatted result rows suitable for QueryRouter return.
 */
export function formatPgAttributeResult(rows: PgAttributeRow[]): any[] {
  return rows.map(row => ({
    attrelid: row.attrelid,
    attname: row.attname,
    atttypid: row.atttypid,
    attstattarget: row.attstattarget,
    attlen: row.attlen,
    attnum: row.attnum,
    attndims: row.attndims,
    attcacheoff: row.attcacheoff,
    atttypmod: row.atttypmod,
    attbyval: row.attbyval,
    attstorage: row.attstorage,
    attalign: row.attalign,
    attnotnull: row.attnotnull,
    atthasdef: row.atthasdef,
    atthasmissing: row.atthasmissing,
    attidentity: row.attidentity,
    attgenerated: row.attgenerated,
    attisdropped: row.attisdropped,
    attislocal: row.attislocal,
    attinhcount: row.attinhcount,
    attcollation: row.attcollation,
    attacl: row.attacl,
    attoptions: row.attoptions,
    attfdwoptions: row.attfdwoptions,
    attmissingval: row.attmissingval,
  }));
}
