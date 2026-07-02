/**
 * SystemFunctions — PostgreSQL core system function implementations
 *
 * Provides static, pure-function implementations of PG system functions
 * that return metadata values without querying actual storage.
 * Functions return plain values suitable for inclusion in result rows.
 *
 * ⚠️  pg_size_* functions now compute real file sizes via DB reference.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { SystemTypeRegistry } from './SystemTypes';
import { GucSystem } from '../core/GucSystem';
import { PinoLogger } from '../logger/PinoLogger';
import {
  setMasklen, inetMerge, inetSameFamily,
  inetClientAddr, inetClientPort, inetServerAddr, inetServerPort,
  parseIp, ipToInt, intToIp, cidrToMask,
} from '../query/InetShim';

const logger = PinoLogger.forComponent('SystemFunctions');

export type SysFnHandler = (...args: any[]) => any;

export interface SysFnInfo {
  /** Function name (lowercase, with optional args suffix for overloads) */
  name: string;
  /** Handler function */
  handler: SysFnHandler;
  /** Minimum argument count */
  minArgs: number;
  /** Maximum argument count */
  maxArgs: number;
  /** Return type description */
  returnType: string;
}

// ──────────────────────────────────────────────
//  DB ref for real size computation
// ──────────────────────────────────────────────

/** Database reference interface for size functions */
export interface DatabaseRef {
  path?: string;
  exec?: (sql: string) => any;
  prepare?: (sql: string) => { get: (...args: any[]) => any; all: (...args: any[]) => any[] };
  name?: string;
}

let currentDbRef: DatabaseRef | null = null;

/**
 * Set the current database reference for real size computation.
 * Called once at startup by SqlVecDatabase.
 */
export function setCurrentDbRef(ref: DatabaseRef | null): void {
  currentDbRef = ref;
}

/**
 * Get the current database reference.
 */
export function getCurrentDbRef(): DatabaseRef | null {
  return currentDbRef;
}

// ── Global singleton refs for role/activity/backup lookups ──

import type { RoleManager as RoleMgrType } from '../auth/RoleManager';
import type { ActiveQueryRegistry as ActiveQryRegType } from '../monitoring/ActiveQueryRegistry';
import type { PITRManager as PitrMgrType } from '../pitr/PITRManager';

let currentRoleManager: RoleMgrType | null = null;
let currentActiveQueryRegistry: ActiveQryRegType | null = null;
let currentPitrManager: PitrMgrType | null = null;

export function setRoleManager(ref: RoleMgrType | null): void {
  currentRoleManager = ref;
}

export function getRoleManager(): RoleMgrType | null {
  return currentRoleManager;
}

export function setActiveQueryRegistry(ref: ActiveQryRegType | null): void {
  currentActiveQueryRegistry = ref;
}

export function getActiveQueryRegistry(): ActiveQryRegType | null {
  return currentActiveQueryRegistry;
}

export function setPitrManager(ref: PitrMgrType | null): void {
  currentPitrManager = ref;
}

export function getPitrManager(): PitrMgrType | null {
  return currentPitrManager;
}

// ──────────────────────────────────────────────
//  Singleton helpers
// ──────────────────────────────────────────────

/** Start timestamp cached once */
const START_TIME = new Date();

/** Version string (lazy-computed) */
let versionString: string | null = null;

function getVersion(): string {
  if (!versionString) {
    const platform = `${os.type()} ${os.release()} (${os.arch()})`;
    versionString = `PostgreSQL 16.0 (SqlVec DB 0.1.0) on ${platform}`;
  }
  return versionString;
}

// ──────────────────────────────────────────────
//  Function handlers
// ──────────────────────────────────────────────

const handlers: Record<string, SysFnHandler> = {};

// SQL/JSON standard functions (no-op handlers — rewritten at SQL level by JsonStandardFuncShim)
handlers['json_exists'] = (_json: any, _path: any) => {
  logger.debug('JSON_EXISTS called as system function (should have been rewritten)');
  return false;
};

handlers['json_value'] = (_json: any, _path: any) => {
  logger.debug('JSON_VALUE called as system function (should have been rewritten)');
  return null;
};

handlers['json_query'] = (_json: any, _path: any) => {
  logger.debug('JSON_QUERY called as system function (should have been rewritten)');
  return null;
};

handlers['json_scalar'] = (_json: any) => {
  logger.debug('JSON_SCALAR called as system function (should have been rewritten)');
  return null;
};

handlers['json_serialize'] = (_json: any) => {
  logger.debug('JSON_SERIALIZE called as system function (should have been rewritten)');
  return String(_json);
};

handlers['json_object'] = (..._args: any[]) => {
  logger.debug('JSON_OBJECT called as system function (should have been rewritten)');
  return '{}';
};

handlers['json_array'] = (..._args: any[]) => {
  logger.debug('JSON_ARRAY called as system function (should have been rewritten)');
  return '[]';
};

// current_schema()
handlers['current_schema'] = () => 'public';

// current_database()
handlers['current_database'] = () => 'postgres';

// current_user (oracle-style: no args needed, usable as column name)
handlers['current_user'] = () => 'postgres';

// session_user
handlers['session_user'] = () => 'postgres';

// pg_backend_pid() → backend process ID
handlers['pg_backend_pid'] = () => process.pid;

// pg_is_in_recovery() → false (always primary)
handlers['pg_is_in_recovery'] = () => false;

// current_setting(name) → GUC value from GucSystem
handlers['current_setting'] = (name: string) => {
  if (name === null || name === undefined) return null;
  const guc = GucSystem.getDefaultInstance().registry.get(String(name));
  return guc?.value ?? null;
};

// current_query() → returns current query text or empty
handlers['current_query'] = () => '';

// current_schemas(include_implicit) → schema name array
handlers['current_schemas'] = (includeImplicit: boolean) => {
  if (includeImplicit) {
    return ['pg_catalog', 'public'];
  }
  return ['public'];
};

// pg_cancel_backend(pid) → cancel query (return true)
handlers['pg_cancel_backend'] = (_pid: number) => true;

// pg_terminate_backend(pid) → terminate backend (return true)
handlers['pg_terminate_backend'] = (_pid: number) => true;

// pg_reload_conf() → reload configuration (return true)
handlers['pg_reload_conf'] = () => true;

// pg_rotate_logfile() → rotate log file (return true)
handlers['pg_rotate_logfile'] = () => true;

// pg_rotate_logfile_v2() → rotate log file v2 (return true)
handlers['pg_rotate_logfile_v2'] = () => true;

// pg_block_backend(pid) → block a backend from executing (return true)
handlers['pg_block_backend'] = (_pid: number) => true;

// version()
handlers['version'] = () => getVersion();

// pg_postmaster_start_time()
handlers['pg_postmaster_start_time'] = () => START_TIME.toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '+00');

// pg_conf_load_time()
handlers['pg_conf_load_time'] = () => START_TIME.toISOString().replace('T', ' ').replace(/\.\d{3}Z/, '+00');

// pg_encoding_to_char(id: number) → string
handlers['pg_encoding_to_char'] = (id: number) => {
  const encodings: Record<number, string> = {
    0: '', // SQL_ASCII
    1: 'UTF8',
    2: 'LATIN1',
    3: 'LATIN2',
    4: 'LATIN3',
    5: 'LATIN4',
    6: 'ISO_8859_5',
    7: 'ISO_8859_6',
    8: 'ISO_8859_7',
    9: 'ISO_8859_8',
    10: 'LATIN5',
    11: 'LATIN6',
    12: 'LATIN7',
    13: 'LATIN8',
    14: 'LATIN9',
    15: 'LATIN10',
    16: 'WIN1256',
    17: 'WIN1258',
    18: 'WIN866',
    19: 'WIN874',
    20: 'KOI8R',
    21: 'WIN1251',
    22: 'WIN1252',
    23: 'ISO_8859_13',
    24: 'LATIN11',
    25: 'ISO_8859_9',
    26: 'WIN1250',
    27: 'WIN1253',
    28: 'WIN1254',
    29: 'WIN1255',
    30: 'WIN1257',
    31: 'KOI8U',
    32: 'SJIS',
    33: 'BIG5',
    34: 'GBK',
    35: 'UHC',
    36: 'JOHAB',
    37: 'EUC_JP',
    38: 'EUC_CN',
    39: 'EUC_KR',
    40: 'EUC_TW',
    41: 'MULE_INTERNAL',
    42: 'LATIN',
    43: 'LATIN',
    44: 'LATIN',
    45: 'LATIN',
  };
  return encodings[id] || 'UTF8';
};

// pg_char_to_encoding(name: string) → number
handlers['pg_char_to_encoding'] = (name: string) => {
  const names: Record<string, number> = {
    '': 0,
    'sql_ascii': 0,
    'utf8': 1,
    'unicode': 1,
    'latin1': 2,
    'latin2': 3,
    'latin9': 14,
    'win1252': 22,
    'gbk': 34,
    'euc_cn': 38,
    'euc_jp': 37,
    'euc_kr': 39,
    'euc_tw': 40,
    'sjis': 32,
    'big5': 33,
    'koi8r': 20,
    'koi8u': 31,
  };
  return names[name?.toLowerCase()] ?? -1;
};

// has_schema_privilege(user, schema, privilege)
handlers['has_schema_privilege'] = (_user: string, _schema: string, privilege: string) => {
  const priv = (privilege || '').toUpperCase();
  if (['USAGE', 'CREATE', 'ALL'].includes(priv)) return true;
  return false;
};

// has_table_privilege(user, table, privilege)
handlers['has_table_privilege'] = (_user: string, _table: string, privilege: string) => {
  const priv = (privilege || '').toUpperCase();
  if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL'].includes(priv)) return true;
  return false;
};

// pg_tablespace_location(oid)
handlers['pg_tablespace_location'] = (_oid: number) => {
  return 'pg_default';
};

// ── Real pg_size_* helpers ──────────────────────────

/**
 * Get database file size in bytes.
 * Falls back to 0 if the db ref or path is missing.
 */
function realDbSize(name?: string): number {
  const db = currentDbRef;
  if (!db) return 0;
  try {
    // If a path is available, stat it
    if (db.path) {
      const stat = fs.statSync(db.path);
      return stat.size;
    }
  } catch {
    // stat failed — fall through
  }
  return 0;
}

/**
 * Estimate relation (table/index) size from sqlite_master + COUNT(*).
 * For SQLite, the entire DB is one file. We approximate per-table size
 * as (totalDbSize * tableRowFraction) + overhead.
 * Returns at least 8192 (1 page).
 */
function realRelationSize(relation: string): number {
  const db = currentDbRef;
  if (!db) return 8192;
  const totalSize = realDbSize();
  if (totalSize <= 0) return 8192;

  // If db.prepare is available, estimate row fraction
  let rowFraction = 0.5; // fallback
  try {
    if (db.prepare) {
      const totalRows = db.prepare(
        "SELECT COALESCE(SUM(cnt), 0) AS total FROM (SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' UNION ALL SELECT COUNT(*) FROM sqlite_master)"
      ).get() as { total: number } | undefined;
      const tableRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM "${relation.replace(/"/g, '""')}"`
      ).get() as { cnt: number } | undefined;

      if (tableRow && totalRows) {
        const total = totalRows.total || 1;
        rowFraction = (tableRow.cnt + 1) / (total + 100); // avoid 0
      }
    }
  } catch {
    rowFraction = 0.5;
  }

  const estimated = Math.max(8192, Math.round(totalSize * rowFraction));
  return estimated;
}

function realIndexesSize(relation: string): number {
  const db = currentDbRef;
  if (!db) return 8192;
  // Count indexes for this table, estimate proportionally
  try {
    if (db.prepare) {
      const idxCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`
      ).get(relation) as { cnt: number } | undefined;
      const totalIndexes = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`
      ).get() as { cnt: number } | undefined;

      const total = realDbSize();
      if (total > 0 && idxCount && totalIndexes && totalIndexes.cnt > 0) {
        return Math.max(8192, Math.round(total * idxCount.cnt / totalIndexes.cnt));
      }
    }
  } catch {
    // fall through
  }
  return 8192;
}

// pg_table_size(relation) → bytes (real file size estimate)
handlers['pg_table_size'] = (relation: any) => {
  const name = String(relation ?? '');
  return name ? realRelationSize(name) : 8192;
};

// pg_total_relation_size(relation) → bytes (table + indexes)
handlers['pg_total_relation_size'] = (relation: any) => {
  const name = String(relation ?? '');
  if (!name) return 16384;
  const tableSize = realRelationSize(name);
  const idxSize = realIndexesSize(name);
  return tableSize + idxSize;
};

// pg_relation_size(relation) → bytes
handlers['pg_relation_size'] = (relation: any) => {
  return realRelationSize(String(relation ?? ''));
};

// pg_indexes_size(relation) → bytes
handlers['pg_indexes_size'] = (relation: any) => {
  return realIndexesSize(String(relation ?? ''));
};

// pg_database_size(name) → bytes (real file size)
handlers['pg_database_size'] = (name: string) => {
  return realDbSize(name ?? undefined);
};

// pg_size_pretty(bytes) → human-readable size
handlers['pg_size_pretty'] = (bytes: number) => {
  if (typeof bytes !== 'number' || isNaN(bytes)) return '0 bytes';
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let unitIdx = 0;
  let value = bytes;
  if (value === 0) return '0 bytes';
  if (value < 0) value = Math.abs(value);

  // PG-compatible: round to nearest integer
  while (Math.abs(value) >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }

  if (unitIdx === 0) return `${Math.round(value)} ${units[unitIdx]}`;
  // PG rounds: 1024 → 1 kB, 1048576 → 1 MB, etc.
  if (Number.isInteger(value) || value === Math.round(value)) {
    return `${Math.round(value)} ${units[unitIdx]}`;
  }
  return `${value.toFixed(1)} ${units[unitIdx]}`;
};

// pg_size_bytes(text) → number
handlers['pg_size_bytes'] = (text: string) => {
  if (typeof text !== 'string') return 0;
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(bytes|kB|MB|GB|TB|PB)?$/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = (match[2] || 'bytes').toLowerCase();
  switch (unit) {
    case 'pb': return value * 1024 * 1024 * 1024 * 1024 * 1024;
    case 'tb': return value * 1024 * 1024 * 1024 * 1024;
    case 'gb': return value * 1024 * 1024 * 1024;
    case 'mb': return value * 1024 * 1024;
    case 'kb': return value * 1024;
    case 'bytes':
    default: return Math.round(value);
  }
};

// obj_description(oid) → description
handlers['obj_description'] = (_oid: number) => {
  return null; // No descriptions by default
};

// col_description(tableOid, columnNumber) → description
handlers['col_description'] = (_tableOid: number, _columnNumber: number) => {
  return null; // No column descriptions by default
};

// object_name oid → name
handlers['pg_get_userbyid'] = (roleOid: number) => {
  if (roleOid === 10) return 'postgres';
  return `role_${roleOid}`;
};

// ── pg_get_* metadata functions (real sqlite_master queries) ─────────

/**
 * OID ↔ name cache (lazy, populated by oidToName on first query).
 * Maps relname → oid (forward) and oid → relname (reverse).
 */
let oidForwardCache: Map<string, number> | null = null;
let oidReverseCache: Map<number, string> | null = null;

function buildOidCache(): void {
  const db = currentDbRef;
  if (!db || !db.prepare) { return; }
  try {
    const rows = db.prepare(
      `SELECT name, type FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as { name: string; type: string }[];
    oidForwardCache = new Map();
    oidReverseCache = new Map();
    let oid = 10000;
    for (const r of rows) {
      if (r.type === 'table') { oid = Math.max(oid, 10000); } // tables: 10000+
      oidForwardCache.set(r.name, oid);
      oidReverseCache.set(oid, r.name);
      oid++;
    }
  } catch {
    // ignore
  }
}

function oidToName(oid: number): string | undefined {
  if (!oidReverseCache) buildOidCache();
  return oidReverseCache?.get(oid);
}

function nameToOid(name: string): number | undefined {
  if (!oidForwardCache) buildOidCache();
  return oidForwardCache?.get(name);
}

/** Query sqlite_master for a single object's SQL. */
function masterSql(name: string): string | null {
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE name=? ORDER BY type DESC LIMIT 1`
    ).get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  } catch { return null; }
}

/** Query sqlite_master for a trigger's SQL. */
function masterTriggerSql(name: string): string | null {
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='trigger' AND name=? LIMIT 1`
    ).get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  } catch { return null; }
}

/**
 * Look up a relation by name or OID and return its name.
 * If called with a number, resolve via oid cache.
 * If called with a string, use as-is.
 */
function resolveRelation(rel: any): string | null {
  if (rel === null || rel === undefined) return null;
  if (typeof rel === 'number') return oidToName(rel) ?? null;
  if (typeof rel === 'string') return rel || null;
  return String(rel);
}

// pg_get_indexdef(index_rel_oid) → CREATE INDEX SQL
handlers['pg_get_indexdef'] = (indexOid: any) => {
  const name = resolveRelation(indexOid);
  if (!name) return null;
  // Return the full CREATE INDEX/UNIQUE INDEX SQL from sqlite_master
  const sql = masterSql(name);
  if (sql && sql.toUpperCase().includes('CREATE INDEX')) return sql;
  // Fallback: reconstruct from sqlite_master
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    const row = db.prepare(
      `SELECT tbl_name, sql, name FROM sqlite_master WHERE type='index' AND name=? LIMIT 1`
    ).get(name) as { tbl_name: string; sql: string | null; name: string } | undefined;
    if (!row) return null;
    // If we have the full SQL, use it
    if (row.sql && row.sql.toUpperCase().includes('CREATE INDEX')) return row.sql;
    // Reconstruct
    const idxInfo = db.prepare(
      `SELECT cid, name FROM pragma_index_info(?) ORDER BY seqno`
    ).all(name) as { cid: number; name: string }[];
    if (idxInfo.length === 0) return null;
    const cols = idxInfo.map(c => `"${c.name}"`).join(', ');
    return `CREATE INDEX "${row.name}" ON "${row.tbl_name}" (${cols})`;
  } catch { return null; }
};

// pg_get_triggerdef(trigger_oid, show_before = false) → CREATE TRIGGER SQL
handlers['pg_get_triggerdef'] = (triggerOid: any, _showBefore?: boolean) => {
  const name = resolveRelation(triggerOid);
  if (!name) return null;
  const sql = masterTriggerSql(name);
  return sql ?? null;
};

// pg_get_viewdef(view_oid_or_name) → SELECT SQL
handlers['pg_get_viewdef'] = (viewOid: any) => {
  const name = resolveRelation(viewOid);
  if (!name) return null;
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    const row = db.prepare(
      `SELECT sql FROM sqlite_master WHERE type='view' AND name=? LIMIT 1`
    ).get(name) as { sql: string | null } | undefined;
    return row?.sql ?? null;
  } catch { return null; }
};

// pg_get_constraintdef(constraint_oid) → constraint text
// Constraints in SQLite are embedded in CREATE TABLE SQL.
handlers['pg_get_constraintdef'] = (constraintOid: any) => {
  const name = resolveRelation(constraintOid);
  if (!name) return null;
  // Try to find a constraint-like entry or reconstruct from schema
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    // Look in _sqlvec_constraints if it exists
    const crec = db.prepare(
      `SELECT sql FROM sqlite_master WHERE name=? AND (sql LIKE '%CHECK%' OR sql LIKE '%UNIQUE%' OR sql LIKE '%FOREIGN KEY%') LIMIT 1`
    ).get(name) as { sql: string | null } | undefined;
    if (crec?.sql) return crec.sql;
    // Fallback: check if name matches a known constraint pattern
    return null;
  } catch { return null; }
};

// pg_get_functiondef(function_oid) → function definition
handlers['pg_get_functiondef'] = (funcOid: any) => {
  const oid = typeof funcOid === 'number' ? funcOid : parseInt(String(funcOid), 10);
  const fnInfo = SystemFunctionRegistry.getFunctionByOid(oid);
  if (!fnInfo) return null;
  const params: string[] = [];
  const args = [];
  // Generate a synthetic CREATE FUNCTION definition
  return `CREATE OR REPLACE FUNCTION ${fnInfo.name}(${params.join(', ')}) RETURNS ${fnInfo.returnType} LANGUAGE sql IMMUTABLE`;
};

// pg_get_function_arguments(function_oid) → arg list string
handlers['pg_get_function_arguments'] = (funcOid: any) => {
  const oid = typeof funcOid === 'number' ? funcOid : parseInt(String(funcOid), 10);
  const fnInfo = SystemFunctionRegistry.getFunctionByOid(oid);
  if (!fnInfo) return '';
  const args: string[] = [];
  // Generate synthetic arg names: a1, a2, ...
  for (let i = 0; i < fnInfo.maxArgs; i++) {
    args.push('text');
  }
  return args.join(', ');
};

// pg_get_function_result(function_oid) → return type string
handlers['pg_get_function_result'] = (funcOid: any) => {
  const oid = typeof funcOid === 'number' ? funcOid : parseInt(String(funcOid), 10);
  const fnInfo = SystemFunctionRegistry.getFunctionByOid(oid);
  return fnInfo?.returnType;
};

// pg_get_function_identity_arguments(function_oid) → arg list for overload resolution
handlers['pg_get_function_identity_arguments'] = (funcOid: any) => {
  const oid = typeof funcOid === 'number' ? funcOid : parseInt(String(funcOid), 10);
  const fnInfo = SystemFunctionRegistry.getFunctionByOid(oid);
  if (!fnInfo) return '';
  const args: string[] = [];
  for (let i = 0; i < fnInfo.maxArgs; i++) {
    args.push(fnInfo.returnType === 'bigint' ? 'integer' : 'text');
  }
  return args.join(', ');
};

// pg_column_type(relation_oid_or_name, column_name) → type name string
handlers['pg_column_type'] = (relationOid: any, colName: string) => {
  const name = resolveRelation(relationOid);
  if (!name || !colName) return 'text';
  const db = currentDbRef;
  if (!db || !db.prepare) return 'text';
  try {
    const cols = db.prepare(
      `SELECT cid, name, type FROM pragma_table_info(?)`
    ).all(name) as { cid: number; name: string; type: string }[];
    const col = cols.find(c => c.name === colName);
    if (col?.type && col.type !== '') return col.type;
    return 'text';
  } catch { return 'text'; }
};

// pg_get_serial_sequence(table_name, column_name) → sequence name
handlers['pg_get_serial_sequence'] = (tableName: string, colName: string) => {
  if (!tableName || !colName) return null;
  const db = currentDbRef;
  if (!db || !db.prepare) return null;
  try {
    // Check _sqlvec_identity_columns table (managed by SequenceManager for IDENTITY columns)
    const identityTables = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_identity_columns'`
    ).get() as { name: string } | undefined;

    if (identityTables) {
      const row = db.prepare(
        `SELECT sequence_name FROM _sqlvec_identity_columns WHERE table_name=? AND column_name=? LIMIT 1`
      ).get(tableName.toLowerCase(), colName.toLowerCase()) as { sequence_name: string } | undefined;
      if (row) return row.sequence_name;
    }

    // Fallback: use PG naming convention
    return `${tableName}_${colName}_seq`;
  } catch { return `${tableName}_${colName}_seq`; }
};

// pg_get_keywords() → array of {word, catcode, catdesc}
handlers['pg_get_keywords'] = () => {
  // Return a subset of PG reserved/unreserved keywords
  const keywords: { word: string; catcode: string; catdesc: string }[] = [
    { word: 'ABORT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ABSOLUTE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ACTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ADD', catcode: 'U', catdesc: 'unreserved' },
    { word: 'AFTER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ALL', catcode: 'R', catdesc: 'reserved' },
    { word: 'ALTER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ALWAYS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ANALYSE', catcode: 'R', catdesc: 'reserved' },
    { word: 'ANALYZE', catcode: 'R', catdesc: 'reserved' },
    { word: 'AND', catcode: 'R', catdesc: 'reserved' },
    { word: 'ANY', catcode: 'R', catdesc: 'reserved' },
    { word: 'ARRAY', catcode: 'R', catdesc: 'reserved' },
    { word: 'AS', catcode: 'R', catdesc: 'reserved' },
    { word: 'ASC', catcode: 'R', catdesc: 'reserved' },
    { word: 'ASYMMETRIC', catcode: 'R', catdesc: 'reserved' },
    { word: 'AT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ATTACH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'AUTHORIZATION', catcode: 'R', catdesc: 'reserved' },
    { word: 'BEFORE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'BEGIN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'BETWEEN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'BIGINT', catcode: 'R', catdesc: 'reserved' },
    { word: 'BIT', catcode: 'R', catdesc: 'reserved' },
    { word: 'BOTH', catcode: 'R', catdesc: 'reserved' },
    { word: 'BY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CACHE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CALL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CALLED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CASCADE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CASCADED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CASE', catcode: 'R', catdesc: 'reserved' },
    { word: 'CAST', catcode: 'R', catdesc: 'reserved' },
    { word: 'CHECK', catcode: 'R', catdesc: 'reserved' },
    { word: 'CLOSE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'COALESCE', catcode: 'R', catdesc: 'reserved' },
    { word: 'COLLATE', catcode: 'R', catdesc: 'reserved' },
    { word: 'COLUMN', catcode: 'R', catdesc: 'reserved' },
    { word: 'COLUMNS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'COMMENT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'COMMIT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'COMMITTED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CONCURRENTLY', catcode: 'R', catdesc: 'reserved' },
    { word: 'CONFLICT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CONNECTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CONSTRAINT', catcode: 'R', catdesc: 'reserved' },
    { word: 'CONTAINS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'COPY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CREATE', catcode: 'R', catdesc: 'reserved' },
    { word: 'CROSS', catcode: 'R', catdesc: 'reserved' },
    { word: 'CUBE', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CURRENT_CATALOG', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_DATE', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_ROLE', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_SCHEMA', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_TIME', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_TIMESTAMP', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURRENT_USER', catcode: 'R', catdesc: 'reserved' },
    { word: 'CURSOR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'CYCLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DATA', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DATABASE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DAY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DEALLOCATE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DECLARE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DEFAULT', catcode: 'R', catdesc: 'reserved' },
    { word: 'DEFAULTS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DEFERRABLE', catcode: 'R', catdesc: 'reserved' },
    { word: 'DEFERRED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DELETE', catcode: 'R', catdesc: 'reserved' },
    { word: 'DESC', catcode: 'R', catdesc: 'reserved' },
    { word: 'DETACH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DISABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'DISTINCT', catcode: 'R', catdesc: 'reserved' },
    { word: 'DO', catcode: 'R', catdesc: 'reserved' },
    { word: 'DROP', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EACH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ELSE', catcode: 'R', catdesc: 'reserved' },
    { word: 'ENABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'END', catcode: 'R', catdesc: 'reserved' },
    { word: 'ESCAPE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EVENT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXCEPT', catcode: 'R', catdesc: 'reserved' },
    { word: 'EXCLUDE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXCLUDING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXECUTE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXISTS', catcode: 'R', catdesc: 'reserved' },
    { word: 'EXPLAIN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXTENSION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'EXTERNAL', catcode: 'R', catdesc: 'reserved' },
    { word: 'EXTRACT', catcode: 'R', catdesc: 'reserved' },
    { word: 'FALSE', catcode: 'R', catdesc: 'reserved' },
    { word: 'FETCH', catcode: 'R', catdesc: 'reserved' },
    { word: 'FILTER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'FIRST', catcode: 'U', catdesc: 'unreserved' },
    { word: 'FOLLOWING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'FOR', catcode: 'R', catdesc: 'reserved' },
    { word: 'FOREIGN', catcode: 'R', catdesc: 'reserved' },
    { word: 'FREEZE', catcode: 'R', catdesc: 'reserved' },
    { word: 'FROM', catcode: 'R', catdesc: 'reserved' },
    { word: 'FULL', catcode: 'R', catdesc: 'reserved' },
    { word: 'FUNCTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'FUNCTIONS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'GENERATED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'GLOBAL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'GRANT', catcode: 'R', catdesc: 'reserved' },
    { word: 'GROUP', catcode: 'R', catdesc: 'reserved' },
    { word: 'GROUPING', catcode: 'R', catdesc: 'reserved' },
    { word: 'GROUPS', catcode: 'R', catdesc: 'reserved' },
    { word: 'HAVING', catcode: 'R', catdesc: 'reserved' },
    { word: 'HOUR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'IDENTITY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'IF', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ILIKE', catcode: 'R', catdesc: 'reserved' },
    { word: 'IMMEDIATE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'IMMUTABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'IN', catcode: 'R', catdesc: 'reserved' },
    { word: 'INCLUDING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INDEX', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INDEXES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INHERIT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INITIALLY', catcode: 'R', catdesc: 'reserved' },
    { word: 'INLINE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INNER', catcode: 'R', catdesc: 'reserved' },
    { word: 'INOUT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INPUT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INSERT', catcode: 'R', catdesc: 'reserved' },
    { word: 'INSTEAD', catcode: 'U', catdesc: 'unreserved' },
    { word: 'INTERSECT', catcode: 'R', catdesc: 'reserved' },
    { word: 'INTO', catcode: 'R', catdesc: 'reserved' },
    { word: 'IS', catcode: 'R', catdesc: 'reserved' },
    { word: 'ISNULL', catcode: 'R', catdesc: 'reserved' },
    { word: 'ISOLATION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'JOIN', catcode: 'R', catdesc: 'reserved' },
    { word: 'KEY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'LATERAL', catcode: 'R', catdesc: 'reserved' },
    { word: 'LEADING', catcode: 'R', catdesc: 'reserved' },
    { word: 'LEFT', catcode: 'R', catdesc: 'reserved' },
    { word: 'LEVEL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'LIKE', catcode: 'R', catdesc: 'reserved' },
    { word: 'LIMIT', catcode: 'R', catdesc: 'reserved' },
    { word: 'LIST', catcode: 'U', catdesc: 'unreserved' },
    { word: 'LOCAL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'LOCALTIME', catcode: 'R', catdesc: 'reserved' },
    { word: 'LOCALTIMESTAMP', catcode: 'R', catdesc: 'reserved' },
    { word: 'MATCH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'MATERIALIZED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'MERGE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'MINUTE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'MONTH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'MOVE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'NATURAL', catcode: 'R', catdesc: 'reserved' },
    { word: 'NEXT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'NO', catcode: 'U', catdesc: 'unreserved' },
    { word: 'NOT', catcode: 'R', catdesc: 'reserved' },
    { word: 'NOTHING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'NOTNULL', catcode: 'R', catdesc: 'reserved' },
    { word: 'NULL', catcode: 'R', catdesc: 'reserved' },
    { word: 'NULLIF', catcode: 'R', catdesc: 'reserved' },
    { word: 'NULLS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OF', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OFF', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OFFSET', catcode: 'R', catdesc: 'reserved' },
    { word: 'ON', catcode: 'R', catdesc: 'reserved' },
    { word: 'ONLY', catcode: 'R', catdesc: 'reserved' },
    { word: 'OPERATOR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OPTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OR', catcode: 'R', catdesc: 'reserved' },
    { word: 'ORDER', catcode: 'R', catdesc: 'reserved' },
    { word: 'ORDINALITY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OTHERS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OUT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OUTER', catcode: 'R', catdesc: 'reserved' },
    { word: 'OVER', catcode: 'R', catdesc: 'reserved' },
    { word: 'OVERLAPS', catcode: 'R', catdesc: 'reserved' },
    { word: 'OVERLAY', catcode: 'R', catdesc: 'reserved' },
    { word: 'OVERRIDING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OWNED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'OWNER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PARALLEL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PARTIAL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PARTITION', catcode: 'R', catdesc: 'reserved' },
    { word: 'PASSING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PASSWORD', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PLACING', catcode: 'R', catdesc: 'reserved' },
    { word: 'POLICY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'POSITION', catcode: 'R', catdesc: 'reserved' },
    { word: 'PRECEDING', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PRESERVE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PRIMARY', catcode: 'R', catdesc: 'reserved' },
    { word: 'PRIOR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PRIVILEGES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PROCEDURE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PROCEDURES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PUBLIC', catcode: 'U', catdesc: 'unreserved' },
    { word: 'PUBLICATION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RANGE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'READ', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REAL', catcode: 'R', catdesc: 'reserved' },
    { word: 'RECURSIVE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REFERENCES', catcode: 'R', catdesc: 'reserved' },
    { word: 'REFRESH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REINDEX', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REJECT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RELATIVE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RELEASE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RENAME', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REPEATABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REPLACE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REPLICA', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RESET', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RESTART', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RESTRICT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'RETURNING', catcode: 'R', catdesc: 'reserved' },
    { word: 'RETURNS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'REVOKE', catcode: 'R', catdesc: 'reserved' },
    { word: 'RIGHT', catcode: 'R', catdesc: 'reserved' },
    { word: 'ROLLBACK', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ROLLUP', catcode: 'R', catdesc: 'reserved' },
    { word: 'ROW', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ROWS', catcode: 'R', catdesc: 'reserved' },
    { word: 'RULE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SAVEPOINT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SCHEMA', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SCHEMAS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SCROLL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SEARCH', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SECOND', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SECURITY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SELECT', catcode: 'R', catdesc: 'reserved' },
    { word: 'SEQUENCE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SEQUENCES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SERIALIZABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SESSION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SESSION_USER', catcode: 'R', catdesc: 'reserved' },
    { word: 'SET', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SETOF', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SHARE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SHOW', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SIMILAR', catcode: 'R', catdesc: 'reserved' },
    { word: 'SIMPLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SKIP', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SMALLINT', catcode: 'R', catdesc: 'reserved' },
    { word: 'SNAPSHOT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SOME', catcode: 'R', catdesc: 'reserved' },
    { word: 'SPLIT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STABLE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'START', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STATEMENT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STATISTICS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STORAGE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STORED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STRICT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'STRIP', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SUBSCRIPTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'SUBSTRING', catcode: 'R', catdesc: 'reserved' },
    { word: 'SYMMETRIC', catcode: 'R', catdesc: 'reserved' },
    { word: 'TABLE', catcode: 'R', catdesc: 'reserved' },
    { word: 'TABLES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TABLESAMPLE', catcode: 'R', catdesc: 'reserved' },
    { word: 'TEMP', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TEMPLATE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TEMPORARY', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TEXT', catcode: 'R', catdesc: 'reserved' },
    { word: 'THEN', catcode: 'R', catdesc: 'reserved' },
    { word: 'TIES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TIME', catcode: 'R', catdesc: 'reserved' },
    { word: 'TIMESTAMP', catcode: 'R', catdesc: 'reserved' },
    { word: 'TO', catcode: 'R', catdesc: 'reserved' },
    { word: 'TRAILING', catcode: 'R', catdesc: 'reserved' },
    { word: 'TRANSACTION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TRIGGER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TRIGGERS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TRUE', catcode: 'R', catdesc: 'reserved' },
    { word: 'TRUNCATE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TRUSTED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TYPE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'TYPES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UESCAPE', catcode: 'R', catdesc: 'reserved' },
    { word: 'UNBOUNDED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UNCOMMITTED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UNION', catcode: 'R', catdesc: 'reserved' },
    { word: 'UNIQUE', catcode: 'R', catdesc: 'reserved' },
    { word: 'UNKNOWN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UNLISTEN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UNLOGGED', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UNTIL', catcode: 'U', catdesc: 'unreserved' },
    { word: 'UPDATE', catcode: 'R', catdesc: 'reserved' },
    { word: 'UPSERT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'USER', catcode: 'R', catdesc: 'reserved' },
    { word: 'USING', catcode: 'R', catdesc: 'reserved' },
    { word: 'VACUUM', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VALID', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VALIDATE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VALIDATOR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VALUE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VALUES', catcode: 'R', catdesc: 'reserved' },
    { word: 'VARCHAR', catcode: 'R', catdesc: 'reserved' },
    { word: 'VARIADIC', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VERBOSE', catcode: 'R', catdesc: 'reserved' },
    { word: 'VERSION', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VIEW', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VIEWS', catcode: 'U', catdesc: 'unreserved' },
    { word: 'VOLATILE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WHEN', catcode: 'R', catdesc: 'reserved' },
    { word: 'WHERE', catcode: 'R', catdesc: 'reserved' },
    { word: 'WHITESPACE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WINDOW', catcode: 'R', catdesc: 'reserved' },
    { word: 'WITH', catcode: 'R', catdesc: 'reserved' },
    { word: 'WITHIN', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WITHOUT', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WORK', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WRAPPER', catcode: 'U', catdesc: 'unreserved' },
    { word: 'WRITE', catcode: 'U', catdesc: 'unreserved' },
    { word: 'XML', catcode: 'U', catdesc: 'unreserved' },
    { word: 'XMLATTRIBUTES', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLCONCAT', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLELEMENT', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLEXISTS', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLFOREST', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLNAMESPACES', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLPARSE', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLPI', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLROOT', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLSERIALIZE', catcode: 'R', catdesc: 'reserved' },
    { word: 'XMLTABLE', catcode: 'R', catdesc: 'reserved' },
    { word: 'YEAR', catcode: 'U', catdesc: 'unreserved' },
    { word: 'YES', catcode: 'U', catdesc: 'unreserved' },
    { word: 'ZONE', catcode: 'U', catdesc: 'unreserved' },
  ];
  return keywords;
};

// pg_get_expr(pg_node_tree, relation_oid)
handlers['pg_get_expr'] = (pgNodeTree: string, _relationOid: number) => {
  if (!pgNodeTree) return null;
  // If it looks like a simple expression, return it
  const cleaned = String(pgNodeTree).replace(/^"|"$/g, '');
  if (cleaned.length > 0 && cleaned.length < 500) return cleaned;
  return null;
};

// format_type(type_oid, typemod)
handlers['format_type'] = (typeOid: number, _typemod: number | null) => {
  const info = SystemTypeRegistry.getByOid(typeOid);
  return info?.name || 'text';
};

// pg_typeof(any) → type name
handlers['pg_typeof'] = (val: any) => {
  if (val === null || val === undefined) return 'text';
  if (typeof val === 'boolean') return 'boolean';
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return 'integer';
    return 'numeric';
  }
  if (typeof val === 'string') return 'text';
  return 'text';
};

// ── to_char, to_date, to_number, to_timestamp helpers ──────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function pad3(n: number): string { return String(n).padStart(3, '0'); }
function pad4(n: number): string { return String(n).padStart(4, '0'); }
function pad6(n: number): string { return String(n).padStart(6, '0'); }

const MONTHS = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Try to parse a value as a Date object.
 * Accepts: Date, number (ms epoch), ISO string, common SQL formats.
 */
function parseDate(value: any): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value.trim());
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/**
 * Format a Date using PG to_char date/time format tokens.
 */
function formatTimestamp(ts: Date, fmt: string): string {
  const year = ts.getFullYear();
  const month = ts.getMonth() + 1;
  const day = ts.getDate();
  const hour = ts.getHours();
  const min = ts.getMinutes();
  const sec = ts.getSeconds();
  const ms = ts.getMilliseconds();

  const hasFM = fmt.includes('FM');
  let result = fmt;

  // Token replacement — longer/boundary patterns first to avoid partial overlap
  result = result.replace(/YYYY/g, pad4(year));
  result = result.replace(/YY(?=\D|$)/g, pad2(year % 100));
  result = result.replace(/Month/g, MONTHS[month] || '');
  result = result.replace(/mon\b/g, (MONTHS[month] || '').slice(0, 3));
  result = result.replace(/\bMM\b/g, pad2(month));
  result = result.replace(/DAY/g, DAYS[ts.getDay()].toUpperCase());
  result = result.replace(/\bDay\b/g, DAYS[ts.getDay()]);
  result = result.replace(/\bday\b/g, DAYS[ts.getDay()].toLowerCase());
  result = result.replace(/DY(?=\D|$)/g, DAYS[ts.getDay()].slice(0, 3).toUpperCase());
  result = result.replace(/\bDy\b/g, DAYS[ts.getDay()].slice(0, 3));
  result = result.replace(/\bdy\b/g, DAYS[ts.getDay()].slice(0, 3).toLowerCase());
  result = result.replace(/DD(?=\D|$)/g, pad2(day));

  result = result.replace(/HH24/g, pad2(hour));
  result = result.replace(/HH12/g, pad2(hour % 12 || 12));
  result = result.replace(/\bHH\b/g, pad2(hour % 12 || 12));
  result = result.replace(/\bMI\b/g, pad2(min));
  result = result.replace(/\bSS\b/g, pad2(sec));
  result = result.replace(/\bMS\b/g, pad3(ms));
  result = result.replace(/\bUS\b/g, pad6(ms * 1000));

  result = result.replace(/\bAM\b/g, hour < 12 ? 'AM' : 'PM');
  result = result.replace(/\bPM\b/g, hour < 12 ? 'AM' : 'PM');
  result = result.replace(/\bam\b/g, hour < 12 ? 'am' : 'pm');
  result = result.replace(/\bpm\b/g, hour < 12 ? 'am' : 'pm');

  result = result.replace(/\bTZ\b/g, '+08');

  if (hasFM) {
    result = result.trim();
    result = result.replace(/\s+/g, ' ');
  }

  return result;
}

/**
 * Format a number using PG to_char numeric format tokens.
 */
function formatNumeric(val: number, fmt: string): string {
  const isNegative = val < 0;
  const absVal = Math.abs(val);

  const hasPR = fmt.includes('PR');
  const cleanFmt = fmt.replace(/PR/g, '');

  const parts = cleanFmt.split('.');
  const intPart = parts[0] || '';
  const fracPart = parts[1] || '';

  const intStr = Math.floor(absVal).toString();
  const fracVal = Math.round((absVal - Math.floor(absVal)) * Math.pow(10, fracPart.length));
  const fracStr = fracVal.toString().padStart(fracPart.length, '0').slice(0, fracPart.length);

  const intDigits = intPart.replace(/[^90]/g, '');
  const width = intDigits.length;
  const padded = intStr.padStart(width, '0');

  // Build integer portion by walking format chars
  let formattedInt = '';
  let di = 0;
  const leadingZeroCount = width - intStr.length;
  for (const ch of intPart) {
    if (ch === '9' || ch === '0') {
      if (di < leadingZeroCount) {
        // Leading zone: 0 shows '0', 9 shows blank
        formattedInt += ch === '0' ? padded[di] : ' ';
      } else {
        formattedInt += padded[di];
      }
      di++;
    } else if (ch === ',') {
      const remainingDigits = intDigits.slice(di);
      if (isNegative || remainingDigits.replace(/0/g, '').length > 0 || intStr.length > remainingDigits.length) {
        formattedInt += ',';
      } else {
        formattedInt += ' ';
      }
    } else {
      formattedInt += ch;
    }
  }

  // PR: parentheses for negatives
  if (hasPR) {
    if (isNegative) {
      return `(${formattedInt.trim()}${fracPart ? '.' + fracStr : ''})`;
    }
    return formattedInt + (fracPart ? '.' + fracStr : '');
  }

  // S: sign anchor
  let signStr = '';
  if (cleanFmt.includes('S')) {
    signStr = isNegative ? '-' : '+';
  } else if (isNegative) {
    signStr = '-';
  }

  return signStr + formattedInt + (fracPart ? '.' + fracStr : '');
}

// ── to_char handler ────────────────────────────────────────────────────

handlers['to_char'] = (value: any, fmt: string) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || value instanceof Number) return formatNumeric(Number(value), String(fmt));
  // Try parsing as date
  const ts = parseDate(value);
  if (ts !== null) return formatTimestamp(ts, String(fmt));
  return String(value);
};

// ── Build regex from PG format template for reverse parsing ────────────

function buildParseRegex(fmt: string): { regex: RegExp; tokens: string[] } | null {
  const tokenMap: Array<{ token: string; pattern: string }> = [
    { token: 'YYYY', pattern: '(\\d{4})' },
    { token: 'YY', pattern: '(\\d{2})' },
    { token: 'Month', pattern: '([A-Za-z]+)' },
    { token: 'Mon', pattern: '([A-Za-z]{3})' },
    { token: 'mon', pattern: '([A-Za-z]{3})' },
    { token: 'MM', pattern: '(\\d{2})' },
    { token: 'DAY', pattern: '([A-Za-z]+)' },
    { token: 'Day', pattern: '([A-Za-z]+)' },
    { token: 'day', pattern: '([A-Za-z]+)' },
    { token: 'DY', pattern: '([A-Za-z]{3})' },
    { token: 'Dy', pattern: '([A-Za-z]{3})' },
    { token: 'dy', pattern: '([A-Za-z]{3})' },
    { token: 'DD', pattern: '(\\d{2})' },
    { token: 'HH24', pattern: '(\\d{2})' },
    { token: 'HH12', pattern: '(\\d{2})' },
    { token: 'HH', pattern: '(\\d{2})' },
    { token: 'MI', pattern: '(\\d{2})' },
    { token: 'SS', pattern: '(\\d{2})' },
    { token: 'MS', pattern: '(\\d{3})' },
    { token: 'US', pattern: '(\\d{6})' },
    { token: 'AM', pattern: '(AM|PM)' },
    { token: 'PM', pattern: '(AM|PM)' },
    { token: 'am', pattern: '(am|pm)' },
    { token: 'pm', pattern: '(am|pm)' },
  ];

  // Longer tokens first so YYYY wins over YY, HH24 over HH, etc.
  tokenMap.sort((a, b) => b.token.length - a.token.length);

  let regexStr = '';
  const tokens: string[] = [];
  let i = 0;
  while (i < fmt.length) {
    let matched = false;
    for (const { token, pattern } of tokenMap) {
      if (fmt.slice(i, i + token.length) === token) {
        regexStr += pattern;
        tokens.push(token);
        i += token.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      const ch = fmt[i];
      if (/[.*+?^${}()|[\]\\]/.test(ch)) {
        regexStr += '\\' + ch;
      } else {
        regexStr += ch;
      }
      i++;
    }
  }

  return { regex: new RegExp('^' + regexStr + '$'), tokens };
}

const MONTH_NAMES: Record<string, number> = {
  'january': 1, 'february': 2, 'march': 3, 'april': 4, 'may': 5, 'june': 6,
  'july': 7, 'august': 8, 'september': 9, 'october': 10, 'november': 11, 'december': 12,
};
const MONTH_ABBRS: Record<string, number> = {
  'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
  'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
};

/**
 * Parse text using a PG format template and return a Date.
 */
function parseDateWithFormat(text: string, fmt: string): Date | null {
  const built = buildParseRegex(fmt);
  if (!built) return null;

  const match = text.match(built.regex);
  if (!match) return null;

  let year = 2024, month = 1, day = 1, hour = 0, min = 0, sec = 0, ms = 0;
  let capIdx = 1;

  for (const token of built.tokens) {
    const val = match[capIdx++];
    if (!val) continue;

    switch (token) {
      case 'YYYY': year = parseInt(val, 10); break;
      case 'YY': year = 2000 + parseInt(val, 10); break;
      case 'MM': month = parseInt(val, 10); break;
      case 'Month':
      case 'Mon':
      case 'mon':
        month = MONTH_NAMES[val.toLowerCase()] || MONTH_ABBRS[val.toLowerCase()] || month;
        break;
      case 'DD': day = parseInt(val, 10); break;
      case 'HH24':
      case 'HH12':
      case 'HH':
        hour = parseInt(val, 10);
        break;
      case 'MI': min = parseInt(val, 10); break;
      case 'SS': sec = parseInt(val, 10); break;
      case 'MS': ms = parseInt(val, 10); break;
      case 'US': ms = Math.round(parseInt(val, 10) / 1000); break;
      case 'AM':
      case 'PM':
        if (val.toUpperCase() === 'PM' && hour < 12) hour += 12;
        if (val.toUpperCase() === 'AM' && hour >= 12) hour -= 12;
        break;
      case 'am':
      case 'pm':
        if (val.toLowerCase() === 'pm' && hour < 12) hour += 12;
        if (val.toLowerCase() === 'am' && hour >= 12) hour -= 12;
        break;
    }
  }

  const d = new Date(year, month - 1, day, hour, min, sec, ms);
  return isNaN(d.getTime()) ? null : d;
}

// ── to_date, to_number, to_timestamp handlers ──────────────────────────

handlers['to_date'] = (text: string, fmt: string) => {
  if (text === null || text === undefined) return null;
  const ts = parseDateWithFormat(String(text), String(fmt));
  if (ts === null) throw new Error('invalid date');
  return `${ts.getFullYear()}-${pad2(ts.getMonth() + 1)}-${pad2(ts.getDate())}`;
};

handlers['to_number'] = (text: string, _fmt: string) => {
  if (text === null || text === undefined) return null;
  const digits = String(text).replace(/[^0-9.\-]/g, '');
  const num = parseFloat(digits);
  return isNaN(num) ? 0 : num;
};

handlers['to_timestamp'] = (text: string, fmt: string) => {
  if (text === null || text === undefined) return null;
  const ts = parseDateWithFormat(String(text), String(fmt));
  if (ts === null) throw new Error('invalid timestamp');
  const y = ts.getFullYear();
  const M = pad2(ts.getMonth() + 1);
  const d = pad2(ts.getDate());
  const h = pad2(ts.getHours());
  const m = pad2(ts.getMinutes());
  const s = pad2(ts.getSeconds());
  const offset = -ts.getTimezoneOffset();
  const tz = (offset >= 0 ? '+' : '-') + pad2(Math.floor(Math.abs(offset) / 60)) + ':' + pad2(Math.abs(offset) % 60);
  return `${y}-${M}-${d} ${h}:${m}:${s}${tz}`;
};

// ── FS access functions (pg_read_file, pg_ls_dir, pg_stat_file) ──────────

// pg_read_file(path, offset?, length?) → text
handlers['pg_read_file'] = (path: string, offset?: number, length?: number) => {
  if (!path || typeof path !== 'string') return null;
  const dataDir = process.env.DATA_DIR || '/tmp';
  const fullPath = path.startsWith('/') ? path : `${dataDir}/${path}`;
  // 安全检查:不能越界到 dataDir 外
  if (!fullPath.startsWith(dataDir)) return null;
  try {
    const buf = fs.readFileSync(fullPath);
    const off = (offset && typeof offset === 'number') ? Math.max(0, offset) : 0;
    const len = (length && typeof length === 'number') ? length : buf.length - off;
    if (off >= buf.length) return '';
    return buf.toString('utf8').slice(off, off + len);
  } catch { return null; }
};

// pg_ls_dir(dirname) → setof text
handlers['pg_ls_dir'] = (dirname: string) => {
  if (!dirname || typeof dirname !== 'string') return [];
  const dataDir = process.env.DATA_DIR || '/tmp';
  const fullPath = dirname.startsWith('/') ? dirname : `${dataDir}/${dirname}`;
  if (!fullPath.startsWith(dataDir)) return [];
  try {
    return fs.readdirSync(fullPath);
  } catch { return []; }
};

// pg_stat_file(filename) → record
handlers['pg_stat_file'] = (filename: string) => {
  if (!filename || typeof filename !== 'string') return null;
  const dataDir = process.env.DATA_DIR || '/tmp';
  const fullPath = filename.startsWith('/') ? filename : `${dataDir}/${filename}`;
  if (!fullPath.startsWith(dataDir)) return null;
  try {
    const stat = fs.statSync(fullPath);
    return {
      size: stat.size,
      access: stat.atime.toISOString(),
      modification: stat.mtime.toISOString(),
      change: stat.ctime.toISOString(),
      type: stat.isDirectory() ? 'd' : '-',
    };
  } catch { return null; }
};

// ── Batch 6B: PG System Functions ────────────────────────────────────

/**
 * System column names that are not updatable.
 */
const SYSTEM_COLUMN_NAMES = new Set(['_cmax', '_cmin', '_xmin', '_xmax', 'ctid', 'oid', 'xcmin', 'xcmax']);

// pg_has_role(role_oid_or_name, role_privilege) → boolean
handlers['pg_has_role'] = (role: any, privilege: string) => {
  const rm = currentRoleManager;
  if (!rm) return true; // Fallback: superuser
  const roleName = typeof role === 'number' ? `role_${role}` : String(role ?? '');
  if (!roleName) return true;
  // Superuser bypass — if the calling role (postgres) exists and is superuser, grant all
  const roleObj = rm.getRole('postgres');
  if (roleObj?.superuser) return true;
  // If no 'postgres' role registered, we're in a test context with an empty RoleManager
  // — treat as superuser
  if (!roleObj) return true;
  // Otherwise check membership
  const priv = (privilege || '').toUpperCase();
  if (priv === 'USAGE' || priv === 'MEMBER') {
    return rm.isMemberOf('postgres', roleName);
  }
  return true;
};

// pg_stat_get_activity(pid?) → array of activity records
handlers['pg_stat_get_activity'] = (pid?: number) => {
  const reg = currentActiveQueryRegistry;
  let queries: any[] = [];
  if (reg) {
    queries = reg.list();
  }

  // Map registered queries or use a default singleton activity row
  const rows = queries.length > 0
    ? queries.map(q => ({
        pid: q.pid ?? process.pid,
        datid: 5,
        datname: q.database || 'postgres',
        usesysid: 10,
        usename: q.userId || 'postgres',
        application_name: '',
        client_addr: q.clientAddr || null,
        client_hostname: null,
        client_port: -1,
        backend_start: new Date().toISOString(),
        xact_start: null,
        query_start: new Date(q.queryStart).toISOString(),
        state_change: new Date().toISOString(),
        wait_event_type: null,
        wait_event: null,
        state: q.state || 'active',
        backend_xid: null,
        backend_xmin: null,
        query_id: q.queryId || '',
        query: q.sql || '',
      }))
    : [{
        pid: process.pid,
        datid: 5,
        datname: 'postgres',
        usesysid: 10,
        usename: 'postgres',
        application_name: '',
        client_addr: null,
        client_hostname: null,
        client_port: -1,
        backend_start: new Date().toISOString(),
        xact_start: null,
        query_start: new Date().toISOString(),
        state_change: new Date().toISOString(),
        wait_event_type: null,
        wait_event: null,
        state: 'active',
        backend_xid: null,
        backend_xmin: null,
        query_id: null,
        query: '',
      }];

  return pid ? rows.filter(r => r.pid === pid) : rows;
};

// pg_table_is_visible(table_oid) → boolean
handlers['pg_table_is_visible'] = (tableOid: number) => {
  const name = oidToName(tableOid);
  if (!name) return false;
  // Check if table exists in a schema within search_path
  // search_path defaults to 'public' (and pg_catalog is implicit)
  // All known tables in our system are in public
  const db = currentDbRef;
  if (!db || !db.prepare) return true; // Conservative: visible
  try {
    const row = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name=? LIMIT 1`
    ).get(name) as any;
    return !!row;
  } catch {
    return true;
  }
};

// pg_function_is_visible(function_oid) → boolean
handlers['pg_function_is_visible'] = (_functionOid: number) => {
  return true; // All functions are visible in our implementation
};

// pg_column_is_updatable(table_oid, column_attnum) → boolean
handlers['pg_column_is_updatable'] = (tableOid: number, columnAttnum: number) => {
  // attnum < 0 → system column (not updatable)
  if (typeof columnAttnum === 'number' && columnAttnum < 1) return false;
  // Check column name from table info
  const name = oidToName(tableOid);
  if (name) {
    const db = currentDbRef;
    if (db && db.prepare) {
      try {
        const colInfo = db.prepare(
          `SELECT name FROM pragma_table_info(?) WHERE cid=? LIMIT 1`
        ).get(name, Math.abs(columnAttnum) - 1) as { name: string } | undefined;
        if (colInfo && SYSTEM_COLUMN_NAMES.has(colInfo.name)) return false;
      } catch { /* ignore */ }
    }
  }
  return true; // Non-system columns are updatable
};

// pg_describe_object(classid, objid, objsubid) → text
handlers['pg_describe_object'] = (classid: number, objid: number, objsubid: number) => {
  // Common PG catalog OIDs
  const CATALOG_NAMES: Record<number, string> = {
    1247: 'type',
    1255: 'function',
    1259: 'table',
    1260: 'authid',
    1262: 'database',
    2600: 'policy',
    2615: 'schema',
    2617: 'operator',
    2618: 'opfamily',
    2619: 'opclass',
    2838: 'procedure',
    2840: 'parameter',
  };

  const catalogName = CATALOG_NAMES[classid] || `catalog_${classid}`;

  // Resolve object name from oid cache or known patterns
  let objName: string | undefined;

  if (classid === 1259 /* pg_class */) {
    objName = oidToName(objid);
  } else if (classid === 1247 /* pg_type */) {
    const typeInfo = SystemTypeRegistry.getByOid(objid);
    objName = typeInfo?.name;
  } else if (classid === 1255 /* pg_proc */) {
    const fnInfo = SystemFunctionRegistry.getFunctionByOid(objid);
    objName = fnInfo?.name;
  } else if (classid === 2615 /* pg_namespace */) {
    objName = objid === 2200 ? 'public' : objid === 11 ? 'pg_catalog' : `schema_${objid}`;
  } else if (classid === 1262 /* pg_database */) {
    objName = 'postgres';
  }

  objName = objName ?? `obj_${objid}`;

  if (objsubid > 0) {
    // Column sub-object
    return `column ${objName}.col_${objsubid}`;
  }

  return `${catalogName} ${objName}`;
};

// pg_identify_object(classid, objid, objsubid) → record
handlers['pg_identify_object'] = (classid: number, objid: number, objsubid: number) => {
  const CATALOG_TYPES: Record<number, string> = {
    1259: 'table',
    1247: 'type',
    1255: 'function',
    1260: 'authid',
    1262: 'database',
    2615: 'schema',
  };

  const objectType = CATALOG_TYPES[classid] || 'object';
  let objName: string | undefined;
  let schemaName = 'pg_catalog';

  if (classid === 1259) { objName = oidToName(objid); schemaName = 'public'; }
  else if (classid === 2615) { objName = objid === 2200 ? 'public' : `schema_${objid}`; schemaName = 'pg_catalog'; }
  else if (classid === 1247) { const t = SystemTypeRegistry.getByOid(objid); objName = t?.name; }
  else if (classid === 1255) { const f = SystemFunctionRegistry.getFunctionByOid(objid); objName = f?.name; }
  else if (classid === 1262) { objName = 'postgres'; schemaName = 'pg_catalog'; }

  objName = objName ?? `obj_${objid}`;

  return [objectType, schemaName, objName, objName];
};

// pg_get_ruledef(rule_oid) → text
handlers['pg_get_ruledef'] = (_ruleOid: number) => {
  return '-- No rule defined';
};

// pg_control_checkpoint() → record
handlers['pg_control_checkpoint'] = () => {
  const now = Date.now();
  const checkpointLsn = '0/0';
  return {
    checkpoint_lsn: checkpointLsn,
    redo_lsn: checkpointLsn,
    timeline_id: 1,
    prev_timeline_id: 1,
    next_xid: '0:3',
    next_oid: 10000,
    next_multixact: 1,
    next_mxoff: 0,
    time: Math.floor(now / 1000),
  };
};

// pg_is_in_backup() → boolean
handlers['pg_is_in_backup'] = () => {
  return false; // No backup in progress
};

// pg_last_xact_replay_timestamp() → timestamptz
handlers['pg_last_xact_replay_timestamp'] = () => {
  return null; // Primary — no replay happening
};

// pg_is_wal_replay_paused() → boolean
handlers['pg_is_wal_replay_paused'] = () => {
  return false; // WAL replay never paused
};

// ── Type I/O functions (catalog entries so they appear in pg_proc) ──
handlers['pg_lsn_in'] = (text: string) => text;
handlers['pg_lsn_out'] = (val: any) => String(val);
handlers['money_in'] = (text: string) => text;
handlers['money_out'] = (val: any) => String(val);

// ── Batch 8A: PG Core Functions — String, Geo, Enum, etc. ──────────

// starts_with(string, prefix) → boolean
handlers['starts_with'] = (str: string, prefix: string) => {
  if (str === null || prefix === null) return null;
  return String(str).startsWith(String(prefix));
};

// to_ascii(string) → text — remove accents via NFD normalization
handlers['to_ascii'] = (str: string) => {
  if (str === null) return null;
  return String(str).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
};

// to_hex(number) → text
handlers['to_hex'] = (n: any) => {
  if (n === null || n === undefined) return null;
  const num = typeof n === 'number' ? n : Number(n);
  if (isNaN(num)) return '0';
  return Number(num).toString(16);
};

// trim_array(array, n) → any[] — remove last n elements
handlers['trim_array'] = (arr: any[], n: number) => {
  if (arr === null || n === null) return null;
  if (!Array.isArray(arr)) return arr;
  const count = typeof n === 'number' ? n : Number(n);
  if (count <= 0) return arr;
  return arr.slice(0, -count);
};

// regexp_like(string, pattern) → boolean
handlers['regexp_like'] = (str: string, pattern: string) => {
  if (str === null || pattern === null) return null;
  try {
    return new RegExp(String(pattern)).test(String(str));
  } catch {
    return false;
  }
};

// similar_to_escape(string, pattern) → text
handlers['similar_to_escape'] = (str: string, pattern: string) => {
  if (str === null || pattern === null) return null;
  // SIMILAR TO uses SQL standard regex patterns.
  // We convert PG SIMILAR TO patterns to a JavaScript regex-compatible form.
  let escaped = String(pattern);
  // Escape JS regex special chars that have different meaning in SIMILAR TO
  escaped = escaped.replace(/[.+*?^${}()|[\]\\]/g, '\\$&');
  // PG SIMILAR TO: % → .* (match any seq), _ → . (single char)
  // But they need to NOT be escaped in the context they appear.
  // Since we already escaped everything, restore % and _ unescaped
  escaped = escaped.replace(/\\%/g, '.*');
  escaped = escaped.replace(/\\_/g, '.');
  // | is alternation in SIMILAR TO
  return escaped;
};

// ── Network functions (wrappers to InetShim) ────────────────────────

handlers['set_masklen'] = (inetVal: string, prefixlen: number) => {
  if (inetVal === null || prefixlen === null) return null;
  return setMasklen(String(inetVal), Number(prefixlen));
};

handlers['inet_merge'] = (inet1: string, inet2: string) => {
  if (inet1 === null || inet2 === null) return null;
  return inetMerge(String(inet1), String(inet2));
};

handlers['inet_same_family'] = (inet1: string, inet2: string) => {
  if (inet1 === null || inet2 === null) return null;
  return inetSameFamily(String(inet1), String(inet2));
};

handlers['inet_client_addr'] = () => inetClientAddr();

handlers['inet_client_port'] = () => inetClientPort();

handlers['inet_server_addr'] = () => inetServerAddr();

handlers['inet_server_port'] = () => inetServerPort();

// ── Geometric functions ──────────────────────────────────────────

// diameter(circle) → float8 — 2 * radius
handlers['diameter'] = (circle: any) => {
  if (circle === null) return null;
  // circle format: '<(x,y),r>' or simple string with radius value
  const c = String(circle);
  const match = c.match(/<\([^)]+\),\s*([0-9.]+)\s*>/);
  if (match) return 2 * parseFloat(match[1]);
  // Try extracting last number as radius
  const nums = c.match(/[0-9.]+/g);
  if (nums && nums.length > 0) return 2 * parseFloat(nums[nums.length - 1]);
  return 0;
};

// isclosed(path) → boolean
handlers['isclosed'] = (path: any) => {
  if (path === null) return null;
  const p = String(path);
  // PG: closed path starts with '(' and ends with ')'
  return p.startsWith('(') && p.endsWith(')');
};

// isopen(path) → boolean
handlers['isopen'] = (path: any) => {
  if (path === null) return null;
  const p = String(path);
  // PG: open path starts with '[' and ends with ']'
  return p.startsWith('[') && p.endsWith(']');
};

// npoints(path|polygon) → int4
handlers['npoints'] = (geo: any) => {
  if (geo === null) return null;
  const g = String(geo);
  // Count coordinate pairs: (x,y) or point pairs
  const matches = g.match(/\([^)]+\)/g);
  if (matches) return matches.length;
  // Try comma-separated points
  const pts = g.split(',').filter(Boolean).length;
  return Math.max(1, pts);
};

// pclose(path) → path — convert to closed path
handlers['pclose'] = (path: any) => {
  if (path === null) return null;
  const p = String(path);
  if (p.startsWith('(') && p.endsWith(')')) return p; // already closed
  // Replace [ and ] with ( and )
  return p.replace(/^\[/, '(').replace(/\]$/, ')');
};

// popen(path) → path — convert to open path
handlers['popen'] = (path: any) => {
  if (path === null) return null;
  const p = String(path);
  if (p.startsWith('[') && p.endsWith(']')) return p; // already open
  // Replace ( and ) with [ and ]
  return p.replace(/^\(/, '[').replace(/\)$/, ']');
};

// ── Enum functions ──────────────────────────────────────────────

// enum_first(anyenum) → anyenum
handlers['enum_first'] = (_anyenum: any) => {
  // For synthetic enums, return the first value or 'a' as placeholder
  return 'a';
};

// enum_last(anyenum) → anyenum
handlers['enum_last'] = (_anyenum: any) => {
  return 'z';
};

// enum_range(anyenum) → anyarray
handlers['enum_range'] = (_anyenum: any) => {
  return ['a', 'b', 'c'];
};

// ── Conversion functions ────────────────────────────────────────

// convert_from(bytes, encoding_name) → text
handlers['convert_from'] = (bytes: any, encodingName: string) => {
  if (bytes === null || encodingName === null) return null;
  const enc = String(encodingName).toUpperCase();
  // Use Node.js Buffer for encoding conversion
  const buf = Buffer.from(bytes);
  try {
    if (enc === 'UTF8' || enc === 'UTF-8' || enc === 'UNICODE') return buf.toString('utf8');
    if (enc === 'LATIN1' || enc === 'ISO-8859-1' || enc === 'WIN1252') return buf.toString('latin1');
    if (enc === 'ASCII' || enc === 'SQL_ASCII') return buf.toString('ascii');
    if (enc === 'UTF16LE' || enc === 'UTF-16LE') return buf.toString('utf16le');
    if (enc === 'BASE64') return buf.toString('base64');
    if (enc === 'HEX') return buf.toString('hex');
    // Default to UTF8
    return buf.toString('utf8');
  } catch {
    logger.warn({ encodingName }, 'convert_from: unsupported encoding, falling back to UTF8');
    return buf.toString('utf8');
  }
};

// convert_to(string, encoding_name) → bytea
handlers['convert_to'] = (str: string, encodingName: string) => {
  if (str === null || encodingName === null) return null;
  const enc = String(encodingName).toUpperCase();
  try {
    let buf: Buffer;
    if (enc === 'UTF8' || enc === 'UTF-8' || enc === 'UNICODE') buf = Buffer.from(String(str), 'utf8');
    else if (enc === 'LATIN1' || enc === 'ISO-8859-1' || enc === 'WIN1252') buf = Buffer.from(String(str), 'latin1');
    else if (enc === 'ASCII' || enc === 'SQL_ASCII') buf = Buffer.from(String(str), 'ascii');
    else if (enc === 'UTF16LE' || enc === 'UTF-16LE') buf = Buffer.from(String(str), 'utf16le');
    else buf = Buffer.from(String(str), 'utf8');
    // Return as Buffer (bytea)
    return buf;
  } catch {
    return Buffer.from(String(str), 'utf8');
  }
};

// ── Info/Session functions ───────────────────────────────────────

// pg_my_temp_schema() → oid — return 0 (no temp schema in our system)
handlers['pg_my_temp_schema'] = () => 0;

// pg_is_other_temp_schema(oid) → boolean — return false
handlers['pg_is_other_temp_schema'] = (_oid: number) => false;

// pg_listening_channels() → text[] — return channels (empty array if none)
handlers['pg_listening_channels'] = () => [''];

// pg_notification_queue_usage() → float8 — return 0.0
handlers['pg_notification_queue_usage'] = () => 0.0;

// pg_trigger_depth() → int4 — return 0
handlers['pg_trigger_depth'] = () => 0;

// ── Admin functions ─────────────────────────────────────────────

// pg_sleep_for(interval) → void — sleep for the given interval
handlers['pg_sleep_for'] = (_interval: string) => {
  // Parse interval like '1 second', '1000 microseconds', '500 milliseconds'
  // For simplicity, use a short microsecond sleep (minimal duration)
  const interval = String(_interval ?? '').toLowerCase();
  let ms = 0;
  const microMatch = interval.match(/(\d+)\s*microseconds?/);
  const milliMatch = interval.match(/(\d+)\s*milliseconds?/);
  const secondMatch = interval.match(/(\d+)\s*(seconds?|s\b)/);
  const minuteMatch = interval.match(/(\d+)\s*minutes?/);

  if (microMatch) ms = parseFloat(microMatch[1]) / 1000;
  else if (milliMatch) ms = parseFloat(milliMatch[1]);
  else if (secondMatch) ms = parseFloat(secondMatch[1]) * 1000;
  else if (minuteMatch) ms = parseFloat(minuteMatch[1]) * 60 * 1000;
  else {
    // Try ISO 8601 duration: PT1S, PT500M, etc.
    const isoMatch = interval.match(/pt?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?/i);
    if (isoMatch) {
      const h = parseInt(isoMatch[1] || '0', 10);
      const m = parseInt(isoMatch[2] || '0', 10);
      const s = parseFloat(isoMatch[3] || '0');
      ms = h * 3600000 + m * 60000 + s * 1000;
    }
  }

  if (ms > 0) {
    // PG sleep is synchronous — use Atomics.wait for short waits
    const start = Date.now();
    while (Date.now() - start < ms) {
      // Busy-wait for very short intervals (microseconds)
    }
  }
};

// pg_sleep_until(timestamptz) → void — sleep until specified time
handlers['pg_sleep_until'] = (targetTime: any) => {
  if (targetTime === null) return;
  const target = new Date(String(targetTime)).getTime();
  if (isNaN(target)) return;
  const now = Date.now();
  const delay = target - now;
  if (delay > 0) {
    const start = Date.now();
    while (Date.now() - start < delay) {
      // Busy-wait
    }
  }
};

// ── Size functions ──────────────────────────────────────────────

// pg_tablespace_size(name_or_oid) → int8 — return total DB size
handlers['pg_tablespace_size'] = (_nameOrOid: any) => {
  // Reuse pg_database_size logic: return total DB size
  try {
    const dbSize = handlers['pg_database_size']?.('postgres');
    return typeof dbSize === 'number' ? dbSize : 0;
  } catch {
    return 0;
  }
};

// ── UUID functions ──────────────────────────────────────────────

// uuid_generate_v1mc() → uuid — generate UUID v4 as substitute for v1mc
handlers['uuid_generate_v1mc'] = () => crypto.randomUUID();

// ── Batch 12A: pg_stat_* internal functions ────────────────────

// pg_stat_get_numscans(oid) → int8 — return 0
handlers['pg_stat_get_numscans'] = (_relid: any) => 0;

// pg_stat_get_tuples_returned(oid) → int8 — return 0
handlers['pg_stat_get_tuples_returned'] = (_relid: any) => 0;

// pg_stat_get_tuples_fetched(oid) → int8 — return 0
handlers['pg_stat_get_tuples_fetched'] = (_relid: any) => 0;

// pg_stat_get_tuples_inserted(oid) → int8 — return 0
handlers['pg_stat_get_tuples_inserted'] = (_relid: any) => 0;

// pg_stat_get_tuples_updated(oid) → int8 — return 0
handlers['pg_stat_get_tuples_updated'] = (_relid: any) => 0;

// pg_stat_get_tuples_deleted(oid) → int8 — return 0
handlers['pg_stat_get_tuples_deleted'] = (_relid: any) => 0;

// pg_stat_get_blocks_fetched(oid) → int8 — return 0
handlers['pg_stat_get_blocks_fetched'] = (_relid: any) => 0;

// pg_stat_get_blocks_hit(oid) → int8 — return 0
handlers['pg_stat_get_blocks_hit'] = (_relid: any) => 0;

// pg_stat_get_xact_numscans(oid) → int8 — return 0
handlers['pg_stat_get_xact_numscans'] = (_relid: any) => 0;

// pg_stat_get_xact_tuples_returned(oid) → int8 — return 0
handlers['pg_stat_get_xact_tuples_returned'] = (_relid: any) => 0;

// pg_stat_get_xact_tuples_fetched(oid) → int8 — return 0
handlers['pg_stat_get_xact_tuples_fetched'] = (_relid: any) => 0;

// pg_stat_get_xact_tuples_inserted(oid) → int8 — return 0
handlers['pg_stat_get_xact_tuples_inserted'] = (_relid: any) => 0;

// pg_stat_get_xact_tuples_updated(oid) → int8 — return 0
handlers['pg_stat_get_xact_tuples_updated'] = (_relid: any) => 0;

// pg_stat_get_xact_tuples_deleted(oid) → int8 — return 0
handlers['pg_stat_get_xact_tuples_deleted'] = (_relid: any) => 0;

// pg_stat_get_xact_blocks_fetched(oid) → int8 — return 0
handlers['pg_stat_get_xact_blocks_fetched'] = (_relid: any) => 0;

// pg_stat_get_xact_blocks_hit(oid) → int8 — return 0
handlers['pg_stat_get_xact_blocks_hit'] = (_relid: any) => 0;

// pg_stat_get_xact_function_calls(oid) → int8 — return 0
handlers['pg_stat_get_xact_function_calls'] = (_fid: any) => 0;

// pg_stat_get_xact_function_total_time(oid) → float8 — return 0.0
handlers['pg_stat_get_xact_function_total_time'] = (_fid: any) => 0.0;

// pg_stat_get_function_calls(oid) → int8 — return 0
handlers['pg_stat_get_function_calls'] = (_fid: any) => 0;

// pg_stat_get_function_total_time(oid) → float8 — return 0.0
handlers['pg_stat_get_function_total_time'] = (_fid: any) => 0.0;

// pg_stat_get_function_self_time(oid) → float8 — return 0.0
handlers['pg_stat_get_function_self_time'] = (_fid: any) => 0.0;

// pg_stat_reset() → boolean — return true
handlers['pg_stat_reset'] = () => true;

// pg_stat_reset_shared(text) → boolean — return true
handlers['pg_stat_reset_shared'] = (_target: any) => true;

// pg_stat_reset_single_table_counters(oid) → boolean — return true
handlers['pg_stat_reset_single_table_counters'] = (_oid: any) => true;

// pg_stat_reset_single_function_counters(oid) → boolean — return true
handlers['pg_stat_reset_single_function_counters'] = (_oid: any) => true;

// pg_stat_clear_snapshot() → boolean — return true
handlers['pg_stat_clear_snapshot'] = () => true;

// ── Batch 12B: pg_stat_get_backend_* / pg_stat_get_db_* functions ────

// pg_stat_get_backend_idset() → setof integer — handled by PgStatBackendShim rewrite (empty set)

// pg_stat_get_backend_pid(integer) → integer — return 0 (no PID for fake backend)
handlers['pg_stat_get_backend_pid'] = (_beid: any) => 0;

// pg_stat_get_backend_dbid(integer) → oid — return 0
handlers['pg_stat_get_backend_dbid'] = (_beid: any) => 0;

// pg_stat_get_backend_userid(integer) → oid — return 0
handlers['pg_stat_get_backend_userid'] = (_beid: any) => 0;

// pg_stat_get_backend_activity(integer) → text — return empty string
handlers['pg_stat_get_backend_activity'] = (_beid: any) => '';

// pg_stat_get_backend_wait_event(integer) → text — return NULL
handlers['pg_stat_get_backend_wait_event'] = (_beid: any) => null;

// pg_stat_get_backend_wait_event_type(integer) → text — return NULL
handlers['pg_stat_get_backend_wait_event_type'] = (_beid: any) => null;

// Database stat functions (all take 1 oid arg, return int8/float8/timestamptz)

// pg_stat_get_db_numbackends(oid) → int4 — 0 backends
handlers['pg_stat_get_db_numbackends'] = (_dbid: any) => 0;

// pg_stat_get_db_xact_commit(oid) → int8 — 0
handlers['pg_stat_get_db_xact_commit'] = (_dbid: any) => 0;

// pg_stat_get_db_xact_rollback(oid) → int8 — 0
handlers['pg_stat_get_db_xact_rollback'] = (_dbid: any) => 0;

// pg_stat_get_db_blocks_fetched(oid) → int8 — 0
handlers['pg_stat_get_db_blocks_fetched'] = (_dbid: any) => 0;

// pg_stat_get_db_blocks_hit(oid) → int8 — 0
handlers['pg_stat_get_db_blocks_hit'] = (_dbid: any) => 0;

// pg_stat_get_db_tuples_returned(oid) → int8 — 0
handlers['pg_stat_get_db_tuples_returned'] = (_dbid: any) => 0;

// pg_stat_get_db_tuples_fetched(oid) → int8 — 0
handlers['pg_stat_get_db_tuples_fetched'] = (_dbid: any) => 0;

// pg_stat_get_db_tuples_inserted(oid) → int8 — 0
handlers['pg_stat_get_db_tuples_inserted'] = (_dbid: any) => 0;

// pg_stat_get_db_tuples_updated(oid) → int8 — 0
handlers['pg_stat_get_db_tuples_updated'] = (_dbid: any) => 0;

// pg_stat_get_db_tuples_deleted(oid) → int8 — 0
handlers['pg_stat_get_db_tuples_deleted'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_all(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_all'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_tablespace(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_tablespace'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_lock(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_lock'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_snapshot(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_snapshot'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_bufferpin(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_bufferpin'] = (_dbid: any) => 0;

// pg_stat_get_db_conflict_startup_deadlock(oid) → int8 — 0
handlers['pg_stat_get_db_conflict_startup_deadlock'] = (_dbid: any) => 0;

// pg_stat_get_db_deadlocks(oid) → int8 — 0
handlers['pg_stat_get_db_deadlocks'] = (_dbid: any) => 0;

// pg_stat_get_db_checksum_failures(oid) → int8 — 0
handlers['pg_stat_get_db_checksum_failures'] = (_dbid: any) => 0;

// pg_stat_get_db_blk_read_time(oid) → float8 — 0.0
handlers['pg_stat_get_db_blk_read_time'] = (_dbid: any) => 0.0;

// pg_stat_get_db_blk_write_time(oid) → float8 — 0.0
handlers['pg_stat_get_db_blk_write_time'] = (_dbid: any) => 0.0;

// pg_stat_get_db_session_time(oid) → float8 — 0.0
handlers['pg_stat_get_db_session_time'] = (_dbid: any) => 0.0;

// pg_stat_get_db_active_time(oid) → float8 — 0.0
handlers['pg_stat_get_db_active_time'] = (_dbid: any) => 0.0;

// pg_stat_get_db_idle_in_transaction_time(oid) → float8 — 0.0
handlers['pg_stat_get_db_idle_in_transaction_time'] = (_dbid: any) => 0.0;

// pg_stat_get_db_sessions(oid) → int8 — 0
handlers['pg_stat_get_db_sessions'] = (_dbid: any) => 0;

// pg_stat_get_db_sessions_abandoned(oid) → int8 — 0
handlers['pg_stat_get_db_sessions_abandoned'] = (_dbid: any) => 0;

// pg_stat_get_db_sessions_fatal(oid) → int8 — 0
handlers['pg_stat_get_db_sessions_fatal'] = (_dbid: any) => 0;

// pg_stat_get_db_stat_reset_time(oid) → timestamptz — return NULL
handlers['pg_stat_get_db_stat_reset_time'] = (_dbid: any) => null;

// ──────────────────────────────────────────────
//  Registry
// ──────────────────────────────────────────────

/**
 * Registry of all available system functions.
 * Each entry includes the function name, handler, and argument metadata.
 */
export class SystemFunctionRegistry {
  private static functionMap: Map<string, SysFnInfo> = new Map();
  private static initialized = false;

  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const functions: SysFnInfo[] = [
      { name: 'current_schema', handler: handlers['current_schema'], minArgs: 0, maxArgs: 0, returnType: 'name' },
      { name: 'current_database', handler: handlers['current_database'], minArgs: 0, maxArgs: 0, returnType: 'name' },
      { name: 'current_user', handler: handlers['current_user'], minArgs: 0, maxArgs: 0, returnType: 'name' },
      { name: 'session_user', handler: handlers['session_user'], minArgs: 0, maxArgs: 0, returnType: 'name' },
      { name: 'version', handler: handlers['version'], minArgs: 0, maxArgs: 0, returnType: 'text' },
      { name: 'pg_postmaster_start_time', handler: handlers['pg_postmaster_start_time'], minArgs: 0, maxArgs: 0, returnType: 'timestamptz' },
      { name: 'pg_conf_load_time', handler: handlers['pg_conf_load_time'], minArgs: 0, maxArgs: 0, returnType: 'timestamptz' },
      { name: 'pg_encoding_to_char', handler: handlers['pg_encoding_to_char'], minArgs: 1, maxArgs: 1, returnType: 'name' },
      { name: 'pg_char_to_encoding', handler: handlers['pg_char_to_encoding'], minArgs: 1, maxArgs: 1, returnType: 'integer' },
      { name: 'has_schema_privilege', handler: handlers['has_schema_privilege'], minArgs: 2, maxArgs: 3, returnType: 'boolean' },
      { name: 'has_table_privilege', handler: handlers['has_table_privilege'], minArgs: 2, maxArgs: 3, returnType: 'boolean' },
      { name: 'pg_tablespace_location', handler: handlers['pg_tablespace_location'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_table_size', handler: handlers['pg_table_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'pg_relation_size', handler: handlers['pg_relation_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'pg_total_relation_size', handler: handlers['pg_total_relation_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'pg_indexes_size', handler: handlers['pg_indexes_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'pg_database_size', handler: handlers['pg_database_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'pg_size_pretty', handler: handlers['pg_size_pretty'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_size_bytes', handler: handlers['pg_size_bytes'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      { name: 'obj_description', handler: handlers['obj_description'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'col_description', handler: handlers['col_description'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'pg_get_userbyid', handler: handlers['pg_get_userbyid'], minArgs: 1, maxArgs: 1, returnType: 'name' },
      { name: 'pg_get_expr', handler: handlers['pg_get_expr'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'pg_get_indexdef', handler: handlers['pg_get_indexdef'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_triggerdef', handler: handlers['pg_get_triggerdef'], minArgs: 1, maxArgs: 2, returnType: 'text' },
      { name: 'pg_get_viewdef', handler: handlers['pg_get_viewdef'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_constraintdef', handler: handlers['pg_get_constraintdef'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_functiondef', handler: handlers['pg_get_functiondef'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_function_arguments', handler: handlers['pg_get_function_arguments'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_function_result', handler: handlers['pg_get_function_result'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_get_function_identity_arguments', handler: handlers['pg_get_function_identity_arguments'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_column_type', handler: handlers['pg_column_type'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'pg_get_serial_sequence', handler: handlers['pg_get_serial_sequence'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'pg_get_keywords', handler: handlers['pg_get_keywords'], minArgs: 0, maxArgs: 0, returnType: 'record' },
      { name: 'format_type', handler: handlers['format_type'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'pg_typeof', handler: handlers['pg_typeof'], minArgs: 1, maxArgs: 1, returnType: 'regtype' },
      // Backend / utility functions
      { name: 'pg_backend_pid', handler: handlers['pg_backend_pid'], minArgs: 0, maxArgs: 0, returnType: 'integer' },
      { name: 'pg_is_in_recovery', handler: handlers['pg_is_in_recovery'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'current_setting', handler: handlers['current_setting'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'current_query', handler: handlers['current_query'], minArgs: 0, maxArgs: 0, returnType: 'text' },
      { name: 'current_schemas', handler: handlers['current_schemas'], minArgs: 1, maxArgs: 1, returnType: 'text[]' },
      { name: 'pg_cancel_backend', handler: handlers['pg_cancel_backend'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_terminate_backend', handler: handlers['pg_terminate_backend'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_reload_conf', handler: handlers['pg_reload_conf'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'pg_rotate_logfile', handler: handlers['pg_rotate_logfile'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'pg_rotate_logfile_v2', handler: handlers['pg_rotate_logfile_v2'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'pg_block_backend', handler: handlers['pg_block_backend'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      // Formatting functions
      { name: 'to_char', handler: handlers['to_char'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'to_date', handler: handlers['to_date'], minArgs: 2, maxArgs: 2, returnType: 'date' },
      { name: 'to_number', handler: handlers['to_number'], minArgs: 2, maxArgs: 2, returnType: 'numeric' },
      { name: 'to_timestamp', handler: handlers['to_timestamp'], minArgs: 2, maxArgs: 2, returnType: 'timestamp' },
      // FS access functions
      { name: 'pg_read_file', handler: handlers['pg_read_file'], minArgs: 1, maxArgs: 3, returnType: 'text' },
      { name: 'pg_ls_dir', handler: handlers['pg_ls_dir'], minArgs: 1, maxArgs: 1, returnType: 'setof text' },
      { name: 'pg_stat_file', handler: handlers['pg_stat_file'], minArgs: 1, maxArgs: 1, returnType: 'record' },
      // Type I/O functions (catalog entries for pg_proc)
      { name: 'pg_lsn_in', handler: handlers['pg_lsn_in'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_lsn_out', handler: handlers['pg_lsn_out'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'money_in', handler: handlers['money_in'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'money_out', handler: handlers['money_out'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      // Batch 6B: PG System Functions
      { name: 'pg_has_role', handler: handlers['pg_has_role'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'pg_stat_get_activity', handler: handlers['pg_stat_get_activity'], minArgs: 0, maxArgs: 1, returnType: 'setof record' },
      { name: 'pg_table_is_visible', handler: handlers['pg_table_is_visible'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_function_is_visible', handler: handlers['pg_function_is_visible'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_column_is_updatable', handler: handlers['pg_column_is_updatable'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'pg_describe_object', handler: handlers['pg_describe_object'], minArgs: 3, maxArgs: 3, returnType: 'text' },
      { name: 'pg_identify_object', handler: handlers['pg_identify_object'], minArgs: 3, maxArgs: 3, returnType: 'record' },
      { name: 'pg_get_ruledef', handler: handlers['pg_get_ruledef'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_control_checkpoint', handler: handlers['pg_control_checkpoint'], minArgs: 0, maxArgs: 0, returnType: 'record' },
      { name: 'pg_is_in_backup', handler: handlers['pg_is_in_backup'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'pg_last_xact_replay_timestamp', handler: handlers['pg_last_xact_replay_timestamp'], minArgs: 0, maxArgs: 0, returnType: 'timestamptz' },
      { name: 'pg_is_wal_replay_paused', handler: handlers['pg_is_wal_replay_paused'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      // Batch 8A: PG Core Functions
      { name: 'starts_with', handler: handlers['starts_with'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'to_ascii', handler: handlers['to_ascii'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'to_hex', handler: handlers['to_hex'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'trim_array', handler: handlers['trim_array'], minArgs: 2, maxArgs: 2, returnType: 'anyarray' },
      { name: 'regexp_like', handler: handlers['regexp_like'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'similar_to_escape', handler: handlers['similar_to_escape'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      // Network functions
      { name: 'set_masklen', handler: handlers['set_masklen'], minArgs: 2, maxArgs: 2, returnType: 'inet' },
      { name: 'inet_merge', handler: handlers['inet_merge'], minArgs: 2, maxArgs: 2, returnType: 'cidr' },
      { name: 'inet_same_family', handler: handlers['inet_same_family'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'inet_client_addr', handler: handlers['inet_client_addr'], minArgs: 0, maxArgs: 0, returnType: 'inet' },
      { name: 'inet_client_port', handler: handlers['inet_client_port'], minArgs: 0, maxArgs: 0, returnType: 'integer' },
      { name: 'inet_server_addr', handler: handlers['inet_server_addr'], minArgs: 0, maxArgs: 0, returnType: 'inet' },
      { name: 'inet_server_port', handler: handlers['inet_server_port'], minArgs: 0, maxArgs: 0, returnType: 'integer' },
      // Geometric functions
      { name: 'diameter', handler: handlers['diameter'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'isclosed', handler: handlers['isclosed'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'isopen', handler: handlers['isopen'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'npoints', handler: handlers['npoints'], minArgs: 1, maxArgs: 1, returnType: 'integer' },
      { name: 'pclose', handler: handlers['pclose'], minArgs: 1, maxArgs: 1, returnType: 'path' },
      { name: 'popen', handler: handlers['popen'], minArgs: 1, maxArgs: 1, returnType: 'path' },
      // Enum functions
      { name: 'enum_first', handler: handlers['enum_first'], minArgs: 1, maxArgs: 1, returnType: 'anyenum' },
      { name: 'enum_last', handler: handlers['enum_last'], minArgs: 1, maxArgs: 1, returnType: 'anyenum' },
      { name: 'enum_range', handler: handlers['enum_range'], minArgs: 1, maxArgs: 1, returnType: 'anyarray' },
      // Conversion functions
      { name: 'convert_from', handler: handlers['convert_from'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'convert_to', handler: handlers['convert_to'], minArgs: 2, maxArgs: 2, returnType: 'bytea' },
      // Info/Session functions
      { name: 'pg_my_temp_schema', handler: handlers['pg_my_temp_schema'], minArgs: 0, maxArgs: 0, returnType: 'oid' },
      { name: 'pg_is_other_temp_schema', handler: handlers['pg_is_other_temp_schema'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_listening_channels', handler: handlers['pg_listening_channels'], minArgs: 0, maxArgs: 0, returnType: 'text[]' },
      { name: 'pg_notification_queue_usage', handler: handlers['pg_notification_queue_usage'], minArgs: 0, maxArgs: 0, returnType: 'float8' },
      { name: 'pg_trigger_depth', handler: handlers['pg_trigger_depth'], minArgs: 0, maxArgs: 0, returnType: 'integer' },
      // Admin functions
      { name: 'pg_sleep_for', handler: handlers['pg_sleep_for'], minArgs: 1, maxArgs: 1, returnType: 'void' },
      { name: 'pg_sleep_until', handler: handlers['pg_sleep_until'], minArgs: 1, maxArgs: 1, returnType: 'void' },
      // Size functions
      { name: 'pg_tablespace_size', handler: handlers['pg_tablespace_size'], minArgs: 1, maxArgs: 1, returnType: 'bigint' },
      // UUID functions
      { name: 'uuid_generate_v1mc', handler: handlers['uuid_generate_v1mc'], minArgs: 0, maxArgs: 0, returnType: 'uuid' },
      // SQL/JSON standard functions (handled by SQL-level rewrite; registered here for pg_proc completeness)
      { name: 'json_exists', handler: handlers['json_exists'], minArgs: 2, maxArgs: 2, returnType: 'boolean' },
      { name: 'json_value', handler: handlers['json_value'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'json_query', handler: handlers['json_query'], minArgs: 2, maxArgs: 2, returnType: 'text' },
      { name: 'json_scalar', handler: handlers['json_scalar'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'json_serialize', handler: handlers['json_serialize'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'json_object', handler: handlers['json_object'], minArgs: 0, maxArgs: 64, returnType: 'json' },
      { name: 'json_array', handler: handlers['json_array'], minArgs: 0, maxArgs: 64, returnType: 'json' },
      // Batch 12A: pg_stat_* internal functions
      { name: 'pg_stat_get_numscans', handler: handlers['pg_stat_get_numscans'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_tuples_returned', handler: handlers['pg_stat_get_tuples_returned'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_tuples_fetched', handler: handlers['pg_stat_get_tuples_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_tuples_inserted', handler: handlers['pg_stat_get_tuples_inserted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_tuples_updated', handler: handlers['pg_stat_get_tuples_updated'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_tuples_deleted', handler: handlers['pg_stat_get_tuples_deleted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_blocks_fetched', handler: handlers['pg_stat_get_blocks_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_blocks_hit', handler: handlers['pg_stat_get_blocks_hit'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_numscans', handler: handlers['pg_stat_get_xact_numscans'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_tuples_returned', handler: handlers['pg_stat_get_xact_tuples_returned'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_tuples_fetched', handler: handlers['pg_stat_get_xact_tuples_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_tuples_inserted', handler: handlers['pg_stat_get_xact_tuples_inserted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_tuples_updated', handler: handlers['pg_stat_get_xact_tuples_updated'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_tuples_deleted', handler: handlers['pg_stat_get_xact_tuples_deleted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_blocks_fetched', handler: handlers['pg_stat_get_xact_blocks_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_blocks_hit', handler: handlers['pg_stat_get_xact_blocks_hit'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_function_calls', handler: handlers['pg_stat_get_xact_function_calls'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_xact_function_total_time', handler: handlers['pg_stat_get_xact_function_total_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_function_calls', handler: handlers['pg_stat_get_function_calls'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_function_total_time', handler: handlers['pg_stat_get_function_total_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_function_self_time', handler: handlers['pg_stat_get_function_self_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_reset', handler: handlers['pg_stat_reset'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      { name: 'pg_stat_reset_shared', handler: handlers['pg_stat_reset_shared'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_stat_reset_single_table_counters', handler: handlers['pg_stat_reset_single_table_counters'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_stat_reset_single_function_counters', handler: handlers['pg_stat_reset_single_function_counters'], minArgs: 1, maxArgs: 1, returnType: 'boolean' },
      { name: 'pg_stat_clear_snapshot', handler: handlers['pg_stat_clear_snapshot'], minArgs: 0, maxArgs: 0, returnType: 'boolean' },
      // Batch 12B: pg_stat_get_backend_* / pg_stat_get_db_* internal functions
      { name: 'pg_stat_get_backend_pid', handler: handlers['pg_stat_get_backend_pid'], minArgs: 1, maxArgs: 1, returnType: 'int4' },
      { name: 'pg_stat_get_backend_dbid', handler: handlers['pg_stat_get_backend_dbid'], minArgs: 1, maxArgs: 1, returnType: 'oid' },
      { name: 'pg_stat_get_backend_userid', handler: handlers['pg_stat_get_backend_userid'], minArgs: 1, maxArgs: 1, returnType: 'oid' },
      { name: 'pg_stat_get_backend_activity', handler: handlers['pg_stat_get_backend_activity'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_stat_get_backend_wait_event', handler: handlers['pg_stat_get_backend_wait_event'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_stat_get_backend_wait_event_type', handler: handlers['pg_stat_get_backend_wait_event_type'], minArgs: 1, maxArgs: 1, returnType: 'text' },
      { name: 'pg_stat_get_db_numbackends', handler: handlers['pg_stat_get_db_numbackends'], minArgs: 1, maxArgs: 1, returnType: 'int4' },
      { name: 'pg_stat_get_db_xact_commit', handler: handlers['pg_stat_get_db_xact_commit'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_xact_rollback', handler: handlers['pg_stat_get_db_xact_rollback'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_blocks_fetched', handler: handlers['pg_stat_get_db_blocks_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_blocks_hit', handler: handlers['pg_stat_get_db_blocks_hit'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_tuples_returned', handler: handlers['pg_stat_get_db_tuples_returned'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_tuples_fetched', handler: handlers['pg_stat_get_db_tuples_fetched'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_tuples_inserted', handler: handlers['pg_stat_get_db_tuples_inserted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_tuples_updated', handler: handlers['pg_stat_get_db_tuples_updated'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_tuples_deleted', handler: handlers['pg_stat_get_db_tuples_deleted'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_all', handler: handlers['pg_stat_get_db_conflict_all'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_tablespace', handler: handlers['pg_stat_get_db_conflict_tablespace'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_lock', handler: handlers['pg_stat_get_db_conflict_lock'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_snapshot', handler: handlers['pg_stat_get_db_conflict_snapshot'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_bufferpin', handler: handlers['pg_stat_get_db_conflict_bufferpin'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_conflict_startup_deadlock', handler: handlers['pg_stat_get_db_conflict_startup_deadlock'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_deadlocks', handler: handlers['pg_stat_get_db_deadlocks'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_checksum_failures', handler: handlers['pg_stat_get_db_checksum_failures'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_blk_read_time', handler: handlers['pg_stat_get_db_blk_read_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_db_blk_write_time', handler: handlers['pg_stat_get_db_blk_write_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_db_session_time', handler: handlers['pg_stat_get_db_session_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_db_active_time', handler: handlers['pg_stat_get_db_active_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_db_idle_in_transaction_time', handler: handlers['pg_stat_get_db_idle_in_transaction_time'], minArgs: 1, maxArgs: 1, returnType: 'float8' },
      { name: 'pg_stat_get_db_sessions', handler: handlers['pg_stat_get_db_sessions'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_sessions_abandoned', handler: handlers['pg_stat_get_db_sessions_abandoned'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_sessions_fatal', handler: handlers['pg_stat_get_db_sessions_fatal'], minArgs: 1, maxArgs: 1, returnType: 'int8' },
      { name: 'pg_stat_get_db_stat_reset_time', handler: handlers['pg_stat_get_db_stat_reset_time'], minArgs: 1, maxArgs: 1, returnType: 'timestamptz' },
    ];

    for (const fn of functions) {
      this.functionMap.set(fn.name.toLowerCase(), fn);
    }
  }

  /** Check if a function name is a known system function */
  static isSystemFunction(name: string): boolean {
    this.init();
    return this.functionMap.has(name.toLowerCase());
  }

  /** Get info about a system function */
  static getFunction(name: string): SysFnInfo | undefined {
    this.init();
    return this.functionMap.get(name.toLowerCase());
  }

  /** Execute a system function with given arguments */
  static execute(name: string, args: any[]): any {
    this.init();
    const fn = this.functionMap.get(name.toLowerCase());
    if (!fn) {
      throw new Error(`System function '${name}' not found`);
    }
    if (args.length < fn.minArgs || args.length > fn.maxArgs) {
      throw new Error(
        `Function '${name}' requires ${fn.minArgs}-${fn.maxArgs} arguments, got ${args.length}`,
      );
    }
    return fn.handler(...args);
  }

  /** Get all registered system function names */
  static getFunctionNames(): string[] {
    this.init();
    return Array.from(this.functionMap.keys());
  }

  /** Get all registered function infos */
  static getAllFunctions(): SysFnInfo[] {
    this.init();
    return Array.from(this.functionMap.values());
  }

  /** Get function by OID (assigned sequentially from 20000). */
  static getFunctionByOid(oid: number): SysFnInfo | undefined {
    this.init();
    const all = this.getAllFunctions();
    const idx = oid - 20000;
    if (idx >= 0 && idx < all.length) return all[idx];
    return undefined;
  }
}
