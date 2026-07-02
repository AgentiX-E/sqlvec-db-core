// @ts-nocheck
/**
 * PgCatalog — pg_catalog system table simulation
 *
 * Provides static, in-memory rows for PostgreSQL system tables
 * that clients (psql, DBeaver, etc.) expect to exist.
 * All data is static/default — no real storage queries.
 *
 * ## Dynamic views
 *
 * Some pg_catalog views return live session data. These are populated
 * via static references set during system initialisation:
 *
 * - `pg_prepared_xacts` — data from TwoPhaseCommitManager.listPrepared()
 * - `pg_opclass` — data from OperatorClassShim.getAllOpclasses()
 * - `pg_opfamily` — data from OperatorClassShim.getAllOpfamilies()
 * - `pg_stat_activity` — data from ActiveQueryRegistry / ConnectionManager
 */

import { SystemTypeRegistry, PgTypeCategory } from './SystemTypes';
import { SystemFunctionRegistry, setCurrentDbRef } from './SystemFunctions';

import { SystemCatalog } from './SystemCatalog';



import * as os from 'os';

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

let oidCounter = 10000;

function nextOid(): number {
  return oidCounter++;
}

interface PgClassRow {
  oid: number;
  relname: string;
  relnamespace: number;
  reltype: number;
  reloftype: number;
  relowner: number;
  relam: number;
  relfilenode: number;
  reltablespace: number;
  relpages: number;
  reltuples: number;
  relallvisible: number;
  reltoastrelid: number;
  relhasindex: boolean;
  relisshared: boolean;
  relpersistence: string;
  relkind: string;
  relnatts: number;
  relchecks: number;
  relhasrules: boolean;
  relhastriggers: boolean;
  relhassubclass: boolean;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
  relispartition: boolean;
  relrewrite: number;
  relfrozenxid: number;
  relminmxid: number;
  relacl: null;
  reloptions: null;
  relpartbound: null;
}

const CLASS_ROWS: PgClassRow[] = [];
const ATTRIBUTE_ROWS: any[] = [];
const INDEX_ROWS: any[] = [];
const PROCEDURE_ROWS: any[] = [];
const NAMESPACE_ROWS: Map<number, { oid: number; nspname: string; nspowner: number; nspacl: null }> = new Map();
const DATABASE_ROWS: any[] = [];
const FUNCTION_ROWS: any[] = [];

// ──────────────────────────────────────────────
//  PgCatalog class
// ──────────────────────────────────────────────

export class PgCatalog {
  private static initialized = false;

  /**
   * Optional reference to TwoPhaseCommitManager for pg_prepared_xacts view.
   * Set during system initialisation (SystemIntegration.init).
   */
  static preparedTxManager: any = null;

  /**
   * Optional reference to OperatorClassShim for pg_opclass/pg_opfamily views.
   * Set during system initialisation.
   */
  static operatorClassShim: any = null;

  /**
   * Optional reference to ActiveQueryRegistry for pg_stat_activity view.
   * Set during system initialisation.
   * Provides per-query tracking (query_id, SQL text, state).
   */
  static activeQueryRegistry: ActiveQueryRegistry | null = null;

  /**
   * Optional reference to ConnectionManager for pg_stat_activity view.
   * Set during system initialisation.
   * Provides connection-level metadata (client_addr, backend_start, database).
   */
  static connectionManager: ConnectionManager | null = null;

  /**
   * Optional reference to PgStatStatements for pg_stat_statements and
   * pg_stat_database views. Set during system initialisation.
   */
  static pgStatStatements: PgStatStatements | null = null;

  /**
   * Optional reference to PgStatCollector for pg_stats correlation data.
   * Set during system initialisation.
   */
  static pgStatCollector: any = null;

  /**
   * Reference to the SQLite database for index/trigger/statistics queries.
   * Set during buildFromShard.
   */
  static shardDb: any = null;

  /**
   * Real-time per-table statistics counters for pg_stat_user_tables.
   * Wired by SqlVecDatabase after each mutation query.
   * Keyed by table name (lowercase) → stats object.
   *
   * Fields mirror pg_stat_user_tables columns.
   */
  static userTableStats: Map<string, {
    seq_scan: number;
    seq_tup_read: number;
    idx_scan: number;
    idx_tup_fetch: number;
    n_tup_ins: number;
    n_tup_upd: number;
    n_tup_del: number;
    n_live_tup: number;
    n_dead_tup: number;
    n_mod_since_analyze: number;
    last_analyze: string | null;
    last_autoanalyze: string | null;
  }> = new Map();

  /**
   * Real-time per-index statistics counters for pg_stat_user_indexes.
   * Keyed by index name (lowercase) → stats object.
   */
  static userIndexStats: Map<string, {
    idx_scan: number;
    idx_tup_read: number;
    idx_tup_fetch: number;
  }> = new Map();

  /**
   * Real-time database-level statistics counters for pg_stat_database.
   * Mirrors pg_stat_database columns.
   */
  static databaseStats: {
    xact_commit: number;
    xact_rollback: number;
    tup_returned: number;
    tup_fetched: number;
    tup_inserted: number;
    tup_updated: number;
    tup_deleted: number;
    blks_read: number;
    blks_hit: number;
    deadlocks: number;
    temp_files: number;
    temp_bytes: number;
    conflicts: number;
    checkpoints_timed: number;
    checkpoints_req: number;
    stats_reset: string;
  } = {
    xact_commit: 0,
    xact_rollback: 0,
    tup_returned: 0,
    tup_fetched: 0,
    tup_inserted: 0,
    tup_updated: 0,
    tup_deleted: 0,
    blks_read: 0,
    blks_hit: 0,
    deadlocks: 0,
    temp_files: 0,
    temp_bytes: 0,
    conflicts: 0,
    checkpoints_timed: 0,
    checkpoints_req: 0,
    stats_reset: new Date().toISOString(),
  };

  /**
   * Initialize all pg_catalog tables.
   * Safe to call multiple times.
   */
  static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Ensure sub-registries are initialized
    SystemTypeRegistry.init();
    SystemFunctionRegistry.init();
    SystemCatalog.init();

    // ── Namespaces (pg_namespace) ──
    const namespaces = [
      { name: 'pg_catalog', owner: 10 },
      { name: 'public', owner: 10 },
      { name: 'information_schema', owner: 10 },
      { name: 'pg_toast', owner: 10 },
      { name: 'pg_temp_1', owner: 10 },
    ];

    for (const ns of namespaces) {
      const oid = ns.name === 'pg_catalog' ? 11
        : ns.name === 'public' ? 2200
        : ns.name === 'information_schema' ? 2201
        : ns.name === 'pg_toast' ? 99
        : nextOid();
      NAMESPACE_ROWS.set(oid, {
        oid,
        nspname: ns.name,
        nspowner: ns.owner,
        nspacl: null,
      });
    }

    // ── Database (pg_database) ──
    DATABASE_ROWS.push({
      oid: 1,
      datname: 'postgres',
      datdba: 10,
      encoding: 6, // UTF8
      datlocprovider: 'c',
      datistemplate: false,
      datallowconn: true,
      datconnlimit: -1,
      datlastsysoid: 10000,
      datfrozenxid: 0,
      datminmxid: 0,
      dattablespace: 1663,
      datacl: null,
      datcollate: 'en_US.UTF-8',
      datctype: 'en_US.UTF-8',
      daticulocale: 'en-US',
      datcollversion: '2.36',
    });

    // ── Relations (pg_class) ──

    // Generate class entries for all known tables
    const allTables = [
      // System catalog tables
      { name: 'pg_class', ns: 'pg_catalog', kind: 'r', natts: 31 },
      { name: 'pg_attribute', ns: 'pg_catalog', kind: 'r', natts: 20 },
      { name: 'pg_type', ns: 'pg_catalog', kind: 'r', natts: 30 },
      { name: 'pg_index', ns: 'pg_catalog', kind: 'r', natts: 19 },
      { name: 'pg_proc', ns: 'pg_catalog', kind: 'r', natts: 28 },
      { name: 'pg_namespace', ns: 'pg_catalog', kind: 'r', natts: 3 },
      { name: 'pg_database', ns: 'pg_catalog', kind: 'r', natts: 16 },
      { name: 'pg_settings', ns: 'pg_catalog', kind: 'v', natts: 15 },
      { name: 'pg_tables', ns: 'pg_catalog', kind: 'v', natts: 7 },
      { name: 'pg_indexes', ns: 'pg_catalog', kind: 'v', natts: 5 },
      { name: 'pg_views', ns: 'pg_catalog', kind: 'v', natts: 4 },
      { name: 'pg_stat_activity', ns: 'pg_catalog', kind: 'v', natts: 30 },
      { name: 'pg_stat_user_tables', ns: 'pg_catalog', kind: 'v', natts: 30 },
      { name: 'pg_stat_user_indexes', ns: 'pg_catalog', kind: 'v', natts: 10 },
      { name: 'pg_stat_database', ns: 'pg_catalog', kind: 'v', natts: 40 },
      { name: 'pg_stat_all_indexes', ns: 'pg_catalog', kind: 'v', natts: 8 },
      { name: 'pg_statio_all_tables', ns: 'pg_catalog', kind: 'v', natts: 11 },
      { name: 'pg_statio_all_indexes', ns: 'pg_catalog', kind: 'v', natts: 6 },
      { name: 'pg_stat_user_functions', ns: 'pg_catalog', kind: 'v', natts: 6 },
      { name: 'pg_stat_xact_user_tables', ns: 'pg_catalog', kind: 'v', natts: 11 },
      { name: 'pg_stat_statements', ns: 'pg_catalog', kind: 'v', natts: 14 },
      { name: 'pg_prepared_xacts', ns: 'pg_catalog', kind: 'v', natts: 6 },
      { name: 'pg_stat_progress_vacuum', ns: 'pg_catalog', kind: 'v', natts: 24 },
      { name: 'pg_stat_progress_create_index', ns: 'pg_catalog', kind: 'v', natts: 20 },
      { name: 'pg_stat_progress_copy', ns: 'pg_catalog', kind: 'v', natts: 18 },
      { name: 'pg_opclass', ns: 'pg_catalog', kind: 'r', natts: 6 },
      { name: 'pg_opfamily', ns: 'pg_catalog', kind: 'r', natts: 5 },
      { name: 'pg_attrdef', ns: 'pg_catalog', kind: 'v', natts: 5 },
      { name: 'pg_sequences', ns: 'pg_catalog', kind: 'v', natts: 9 },
      { name: 'pg_trigger', ns: 'pg_catalog', kind: 'v', natts: 14 },
      { name: 'pg_rules', ns: 'pg_catalog', kind: 'v', natts: 4 },
      { name: 'pg_matviews', ns: 'pg_catalog', kind: 'v', natts: 7 },
      { name: 'pg_conversion', ns: 'pg_catalog', kind: 'r', natts: 8 },
      { name: 'pg_aggregate', ns: 'pg_catalog', kind: 'r', natts: 13 },
      { name: 'pg_am', ns: 'pg_catalog', kind: 'r', natts: 4 },
      { name: 'pg_cast', ns: 'pg_catalog', kind: 'r', natts: 6 },
      { name: 'pg_depend', ns: 'pg_catalog', kind: 'r', natts: 7 },
      { name: 'pg_description', ns: 'pg_catalog', kind: 'r', natts: 4 },
      { name: 'pg_extension', ns: 'pg_catalog', kind: 'v', natts: 8 },
      { name: 'pg_available_extensions', ns: 'pg_catalog', kind: 'v', natts: 4 },

      // Batch 7B: Skeleton pg_catalog system tables
      { name: 'pg_constraint', ns: 'pg_catalog', kind: 'r', natts: 25 },
      { name: 'pg_operator', ns: 'pg_catalog', kind: 'r', natts: 15 },
      { name: 'pg_language', ns: 'pg_catalog', kind: 'r', natts: 9 },
      { name: 'pg_tablespace', ns: 'pg_catalog', kind: 'r', natts: 6 },
      { name: 'pg_rewrite', ns: 'pg_catalog', kind: 'r', natts: 9 },
      { name: 'pg_range', ns: 'pg_catalog', kind: 'r', natts: 6 },
      { name: 'pg_amop', ns: 'pg_catalog', kind: 'r', natts: 8 },
      { name: 'pg_amproc', ns: 'pg_catalog', kind: 'r', natts: 6 },
      { name: 'pg_shdepend', ns: 'pg_catalog', kind: 'r', natts: 8 },
      { name: 'pg_db_role_setting', ns: 'pg_catalog', kind: 'r', natts: 3 },

      // Information schema views (also appear in pg_catalog.pg_class)
      { name: 'tables', ns: 'information_schema', kind: 'v', natts: 12 },
      { name: 'columns', ns: 'information_schema', kind: 'v', natts: 22 },
      { name: 'schemata', ns: 'information_schema', kind: 'v', natts: 7 },
      { name: 'routines', ns: 'information_schema', kind: 'v', natts: 8 },
      { name: 'views', ns: 'information_schema', kind: 'v', natts: 10 },
      { name: 'sequences', ns: 'information_schema', kind: 'v', natts: 12 },
    ];

    // Add user tables
    for (const userTable of SystemCatalog.userTables) {
      if (userTable.tableType === 'BASE TABLE') {
        allTables.push({
          name: userTable.tableName,
          ns: userTable.tableSchema,
          kind: 'r',
          natts: 6,
        });
      }
    }

    for (const tbl of allTables) {
      const nsOid = PgCatalog.getNamespaceOid(tbl.ns) || 0;
      const classOid = nextOid();
      const typeOid = nextOid();

      let reltuples = 1000;
      let relpages = 10;
      if (tbl.name === 'pg_class') { reltuples = allTables.length; relpages = 1; }
      if (tbl.name === 'pg_type') { reltuples = SystemTypeRegistry.getAll().length; relpages = 5; }
      if (tbl.name === 'pg_proc' || tbl.name === 'pg_settings') { reltuples = SystemFunctionRegistry.getAllFunctions().length; relpages = 3; }
      if (tbl.kind === 'v') { reltuples = 0; relpages = 0; }

      CLASS_ROWS.push({
        oid: classOid,
        relname: tbl.name,
        relnamespace: nsOid,
        reltype: typeOid,
        reloftype: 0,
        relowner: 10,
        relam: tbl.kind === 'r' ? 2 : 0,
        relfilenode: classOid,
        reltablespace: 0,
        relpages,
        reltuples,
        relallvisible: 0,
        reltoastrelid: 0,
        relhasindex: tbl.name === 'pg_class' || tbl.name === 'pg_attribute' || tbl.name === 'pg_type' || tbl.name === 'pg_proc' || tbl.name === 'pg_namespace' || tbl.name === 'pg_database',
        relisshared: false,
        relpersistence: 'p',
        relkind: tbl.kind,
        relnatts: tbl.natts,
        relchecks: 0,
        relhasrules: false,
        relhastriggers: false,
        relhassubclass: false,
        relrowsecurity: false,
        relforcerowsecurity: false,
        relispartition: false,
        relrewrite: 0,
        relfrozenxid: 0,
        relminmxid: 0,
        relacl: null,
        reloptions: null,
        relpartbound: null,
      });
    }

    // ── Attributes (pg_attribute) ──
    // Standard attribute set for each type of relation
    const stdAttrs = [
      { name: 'tableoid', type: 'oid', nullable: false, default: null },
      { name: 'cmax', type: 'cid', nullable: false, default: null },
      { name: 'xmax', type: 'xid', nullable: false, default: null },
      { name: 'cmin', type: 'cid', nullable: false, default: null },
      { name: 'xmin', type: 'xid', nullable: false, default: null },
      { name: 'ctid', type: 'tid', nullable: false, default: null },
    ];

    for (const cls of CLASS_ROWS) {
      // System columns (-7 to -1)
      const sysCols = [
        { name: 'tableoid', type: 'oid', attnum: -7 },
        { name: 'cmax', type: 'cid', attnum: -6 },
        { name: 'xmax', type: 'xid', attnum: -5 },
        { name: 'cmin', type: 'cid', attnum: -4 },
        { name: 'xmin', type: 'xid', attnum: -3 },
        { name: 'oid', type: 'oid', attnum: -2 },
        { name: 'ctid', type: 'tid', attnum: -1 },
      ];

      for (const col of sysCols) {
        const typeOid = SystemTypeRegistry.getOid(col.type) || 26;
        ATTRIBUTE_ROWS.push(makeAttribute(cls.oid, col.attnum, col.name, typeOid, false, null));
      }

      // User columns - populate based on known view definitions
      if (cls.relname === 'pg_class') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'relname', 'name', false, null);
        addAttribute(cls.oid, 3, 'relnamespace', 'oid', false, null);
        addAttribute(cls.oid, 4, 'reltype', 'oid', false, null);
        addAttribute(cls.oid, 5, 'reloftype', 'oid', true, null);
        addAttribute(cls.oid, 6, 'relowner', 'oid', false, null);
        addAttribute(cls.oid, 7, 'relam', 'oid', false, null);
        addAttribute(cls.oid, 8, 'relfilenode', 'oid', false, null);
        addAttribute(cls.oid, 9, 'reltablespace', 'oid', false, null);
        addAttribute(cls.oid, 10, 'relpages', 'int4', false, null);
        addAttribute(cls.oid, 11, 'reltuples', 'float4', false, null);
        addAttribute(cls.oid, 12, 'relallvisible', 'int4', false, null);
        addAttribute(cls.oid, 13, 'reltoastrelid', 'oid', false, null);
        addAttribute(cls.oid, 14, 'relhasindex', 'bool', false, null);
        addAttribute(cls.oid, 15, 'relisshared', 'bool', false, null);
        addAttribute(cls.oid, 16, 'relpersistence', 'char', false, null);
        addAttribute(cls.oid, 17, 'relkind', 'char', false, null);
        addAttribute(cls.oid, 18, 'relnatts', 'int2', false, null);
        addAttribute(cls.oid, 19, 'relchecks', 'int2', false, null);
      }
      if (cls.relname === 'pg_namespace') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'nspname', 'name', false, null);
        addAttribute(cls.oid, 3, 'nspowner', 'oid', false, null);
        addAttribute(cls.oid, 4, 'nspacl', 'aclitem', true, null);
      }
      if (cls.relname === 'pg_type') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'typname', 'name', false, null);
        addAttribute(cls.oid, 3, 'typnamespace', 'oid', false, null);
        addAttribute(cls.oid, 4, 'typowner', 'oid', false, null);
        addAttribute(cls.oid, 5, 'typlen', 'int2', false, null);
        addAttribute(cls.oid, 6, 'typtype', 'char', false, null);
        addAttribute(cls.oid, 7, 'typcategory', 'char', false, null);
        addAttribute(cls.oid, 8, 'typispreferred', 'bool', false, null);
        addAttribute(cls.oid, 9, 'typisdefined', 'bool', false, null);
        addAttribute(cls.oid, 10, 'typdelim', 'char', false, null);
        addAttribute(cls.oid, 11, 'typrelid', 'oid', false, null);
        addAttribute(cls.oid, 12, 'typelem', 'oid', false, null);
        addAttribute(cls.oid, 13, 'typarray', 'oid', false, null);
        addAttribute(cls.oid, 14, 'typinput', 'regproc', false, null);
        addAttribute(cls.oid, 15, 'typoutput', 'regproc', false, null);
      }
      if (cls.relname === 'pg_database') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'datname', 'name', false, null);
        addAttribute(cls.oid, 3, 'datdba', 'oid', false, null);
        addAttribute(cls.oid, 4, 'encoding', 'int4', false, null);
        addAttribute(cls.oid, 5, 'datcollate', 'name', true, null);
        addAttribute(cls.oid, 6, 'datctype', 'name', true, null);
        addAttribute(cls.oid, 7, 'datistemplate', 'bool', false, null);
        addAttribute(cls.oid, 8, 'datallowconn', 'bool', false, null);
        addAttribute(cls.oid, 9, 'datconnlimit', 'int4', false, "-1");
        addAttribute(cls.oid, 10, 'datlastsysoid', 'oid', false, null);
        addAttribute(cls.oid, 11, 'datfrozenxid', 'xid', false, null);
        addAttribute(cls.oid, 12, 'datminmxid', 'xid', false, null);
        addAttribute(cls.oid, 13, 'dattablespace', 'oid', false, null);
        addAttribute(cls.oid, 14, 'datcollate', 'name', true, null);
        addAttribute(cls.oid, 15, 'datctype', 'name', true, null);
        addAttribute(cls.oid, 16, 'daticulocale', 'name', true, null);
        addAttribute(cls.oid, 17, 'datcollversion', 'text', true, null);
      }
      if (cls.relname === 'pg_proc') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'proname', 'name', false, null);
        addAttribute(cls.oid, 3, 'pronamespace', 'oid', false, null);
        addAttribute(cls.oid, 4, 'proowner', 'oid', false, null);
        addAttribute(cls.oid, 5, 'prolang', 'oid', false, null);
        addAttribute(cls.oid, 6, 'procost', 'float4', false, null);
        addAttribute(cls.oid, 7, 'prorows', 'float4', false, null);
        addAttribute(cls.oid, 8, 'provariadic', 'oid', false, null);
        addAttribute(cls.oid, 9, 'protransform', 'regproc', false, null);
        addAttribute(cls.oid, 10, 'prokind', 'char', false, null);
        addAttribute(cls.oid, 11, 'prosecdef', 'bool', false, null);
        addAttribute(cls.oid, 12, 'proleakproof', 'bool', false, null);
        addAttribute(cls.oid, 13, 'proisstrict', 'bool', false, null);
        addAttribute(cls.oid, 14, 'proretset', 'bool', false, null);
        addAttribute(cls.oid, 15, 'provolatile', 'char', false, null);
        addAttribute(cls.oid, 16, 'proparallel', 'char', false, null);
        addAttribute(cls.oid, 17, 'pronargs', 'int2', false, null);
        addAttribute(cls.oid, 18, 'pronargdefaults', 'int2', false, null);
        addAttribute(cls.oid, 19, 'prorettype', 'oid', false, null);
        addAttribute(cls.oid, 20, 'proargtypes', 'oidvector', false, null);
        addAttribute(cls.oid, 21, 'proallargtypes', 'oid[]', true, null);
        addAttribute(cls.oid, 22, 'proargmodes', 'char[]', true, null);
        addAttribute(cls.oid, 23, 'proargnames', 'text[]', true, null);
        addAttribute(cls.oid, 24, 'proargdefaults', 'text', true, null);
        addAttribute(cls.oid, 25, 'prosrc', 'text', true, null);
        addAttribute(cls.oid, 26, 'probin', 'text', true, null);
        addAttribute(cls.oid, 27, 'proconfig', 'text[]', true, null);
        addAttribute(cls.oid, 28, 'proacl', 'aclitem[]', true, null);
      }
      if (cls.relname === 'pg_index') {
        addAttribute(cls.oid, 1, 'indexrelid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'indrelid', 'oid', false, null);
        addAttribute(cls.oid, 3, 'indnatts', 'int2', false, null);
        addAttribute(cls.oid, 4, 'indnkeyatts', 'int2', false, null);
        addAttribute(cls.oid, 5, 'indisunique', 'bool', false, null);
        addAttribute(cls.oid, 6, 'indisprimary', 'bool', false, null);
        addAttribute(cls.oid, 7, 'indisexclusion', 'bool', false, null);
        addAttribute(cls.oid, 8, 'indimmediate', 'bool', false, null);
        addAttribute(cls.oid, 9, 'indisclustered', 'bool', false, null);
        addAttribute(cls.oid, 10, 'indisvalid', 'bool', false, null);
        addAttribute(cls.oid, 11, 'indcheckxmin', 'bool', false, null);
        addAttribute(cls.oid, 12, 'indisready', 'bool', false, null);
        addAttribute(cls.oid, 13, 'indislive', 'bool', false, null);
        addAttribute(cls.oid, 14, 'indisreplident', 'bool', false, null);
        addAttribute(cls.oid, 15, 'indkey', 'int2vector', false, null);
        addAttribute(cls.oid, 16, 'indcollation', 'oidvector', false, null);
        addAttribute(cls.oid, 17, 'indclass', 'oidvector', false, null);
        addAttribute(cls.oid, 18, 'indoption', 'int2vector', false, null);
        addAttribute(cls.oid, 19, 'indexprs', 'text', true, null);
        addAttribute(cls.oid, 20, 'indpred', 'text', true, null);
      }
      if (cls.relname === 'pg_attrdef') {
        addAttribute(cls.oid, 1, 'oid', 'oid', false, null);
        addAttribute(cls.oid, 2, 'adrelid', 'oid', false, null);
        addAttribute(cls.oid, 3, 'adnum', 'int2', false, null);
        addAttribute(cls.oid, 4, 'adbin', 'text', true, null);
        addAttribute(cls.oid, 5, 'adsrc', 'text', true, null);
      }
      if (cls.relname === 'pg_sequences') {
        addAttribute(cls.oid, 1, 'schemaname', 'name', false, null);
        addAttribute(cls.oid, 2, 'sequencename', 'name', false, null);
        addAttribute(cls.oid, 3, 'last_value', 'int8', false, null);
        addAttribute(cls.oid, 4, 'start_value', 'int8', false, null);
        addAttribute(cls.oid, 5, 'increment_by', 'int8', false, null);
        addAttribute(cls.oid, 6, 'max_value', 'int8', true, null);
        addAttribute(cls.oid, 7, 'min_value', 'int8', true, null);
        addAttribute(cls.oid, 8, 'cache_size', 'int8', false, null);
        addAttribute(cls.oid, 9, 'cycle', 'bool', false, null);
      }
    }

    // ── Type rows (pg_type) ──
    const categoryMap: Record<string, string> = {
      [PgTypeCategory.NUMERIC]: 'N',
      [PgTypeCategory.STRING]: 'S',
      [PgTypeCategory.DATETIME]: 'D',
      [PgTypeCategory.BOOLEAN]: 'B',
      [PgTypeCategory.BINARY]: 'X',
      [PgTypeCategory.GEOMETRY]: 'G',
      [PgTypeCategory.NETWORK]: 'N',
      [PgTypeCategory.MISC]: 'M',
      [PgTypeCategory.PSEUDO]: 'P',
    };

    // ── Build lookup from class name → OID (used below for additional attribute rows) ──
    const classOidMap = new Map<string, number>();
    for (const cls of CLASS_ROWS) {
      classOidMap.set(cls.relname, cls.oid);
    }

    // ── Attribute rows for newly added system tables (prepared xacts, opclass, opfamily) ──
    for (const cls of allTables) {
      const clsOid = classOidMap.get(cls.name) || 0;
      if (cls.name === 'pg_prepared_xacts') {
        addAttribute(clsOid, 1, 'transaction', 'xid', false, null);
        addAttribute(clsOid, 2, 'gid', 'text', false, null);
        addAttribute(clsOid, 3, 'prepared', 'bool', false, null);
        addAttribute(clsOid, 4, 'owner', 'name', false, null);
        addAttribute(clsOid, 5, 'database', 'name', false, null);
        addAttribute(clsOid, 6, 'prepared_at', 'timestamptz', true, null);
      }
      if (cls.name === 'pg_opclass') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'opcmethod', 'oid', false, null);
        addAttribute(clsOid, 3, 'opcname', 'name', false, null);
        addAttribute(clsOid, 4, 'opcnamespace', 'oid', false, null);
        addAttribute(clsOid, 5, 'opcowner', 'oid', false, null);
        addAttribute(clsOid, 6, 'opcintype', 'oid', false, null);
      }
      if (cls.name === 'pg_opfamily') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'opfmethod', 'oid', false, null);
        addAttribute(clsOid, 3, 'opfname', 'name', false, null);
        addAttribute(clsOid, 4, 'opfnamespace', 'oid', false, null);
        addAttribute(clsOid, 5, 'opfowner', 'oid', false, null);
      }
      // ── Batch 7B: Attribute rows for skeleton system tables ──
      if (cls.name === 'pg_constraint') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'conname', 'name', false, null);
        addAttribute(clsOid, 3, 'connamespace', 'oid', false, null);
        addAttribute(clsOid, 4, 'contype', 'char', false, null);
        addAttribute(clsOid, 5, 'condeferrable', 'bool', false, null);
        addAttribute(clsOid, 6, 'condeferred', 'bool', false, null);
        addAttribute(clsOid, 7, 'convalidated', 'bool', false, null);
        addAttribute(clsOid, 8, 'conrelid', 'oid', false, null);
        addAttribute(clsOid, 9, 'contypid', 'oid', false, null);
        addAttribute(clsOid, 10, 'conindid', 'oid', false, null);
        addAttribute(clsOid, 11, 'conparentid', 'oid', false, null);
        addAttribute(clsOid, 12, 'confrelid', 'oid', false, null);
        addAttribute(clsOid, 13, 'confupdtype', 'char', false, null);
        addAttribute(clsOid, 14, 'confdeltype', 'char', false, null);
        addAttribute(clsOid, 15, 'confmatchtype', 'char', false, null);
        addAttribute(clsOid, 16, 'conislocal', 'bool', false, null);
        addAttribute(clsOid, 17, 'coninhcount', 'int4', false, null);
        addAttribute(clsOid, 18, 'connoinherit', 'bool', false, null);
        addAttribute(clsOid, 19, 'conkey', 'int2vector', true, null);
        addAttribute(clsOid, 20, 'confkey', 'int2vector', true, null);
        addAttribute(clsOid, 21, 'conpfeqop', 'oidvector', true, null);
        addAttribute(clsOid, 22, 'conppeqop', 'oidvector', true, null);
        addAttribute(clsOid, 23, 'conffeqop', 'oidvector', true, null);
        addAttribute(clsOid, 24, 'conexclop', 'oidvector', true, null);
        addAttribute(clsOid, 25, 'conbin', 'text', true, null);
      }
      if (cls.name === 'pg_operator') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'oprname', 'name', false, null);
        addAttribute(clsOid, 3, 'oprnamespace', 'oid', false, null);
        addAttribute(clsOid, 4, 'oprowner', 'oid', false, null);
        addAttribute(clsOid, 5, 'oprkind', 'char', false, null);
        addAttribute(clsOid, 6, 'oprcanhash', 'bool', false, null);
        addAttribute(clsOid, 7, 'oprcanmerge', 'bool', false, null);
        addAttribute(clsOid, 8, 'oprleft', 'oid', false, null);
        addAttribute(clsOid, 9, 'oprright', 'oid', false, null);
        addAttribute(clsOid, 10, 'oprresult', 'oid', false, null);
        addAttribute(clsOid, 11, 'oprcom', 'oid', false, null);
        addAttribute(clsOid, 12, 'oprnegate', 'oid', false, null);
        addAttribute(clsOid, 13, 'oprcode', 'text', true, null);
        addAttribute(clsOid, 14, 'oprrest', 'text', true, null);
        addAttribute(clsOid, 15, 'oprjoin', 'text', true, null);
      }
      if (cls.name === 'pg_language') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'lanname', 'name', false, null);
        addAttribute(clsOid, 3, 'lanowner', 'oid', false, null);
        addAttribute(clsOid, 4, 'lanispl', 'bool', false, null);
        addAttribute(clsOid, 5, 'lanpltrusted', 'bool', false, null);
        addAttribute(clsOid, 6, 'lanplcallfoid', 'oid', false, null);
        addAttribute(clsOid, 7, 'laninline', 'oid', false, null);
        addAttribute(clsOid, 8, 'lanvalidator', 'oid', false, null);
        addAttribute(clsOid, 9, 'lanacl', 'aclitem', true, null);
      }
      if (cls.name === 'pg_tablespace') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'spcname', 'name', false, null);
        addAttribute(clsOid, 3, 'spcowner', 'oid', false, null);
        addAttribute(clsOid, 4, 'spclocation', 'text', false, null);
        addAttribute(clsOid, 5, 'spcacl', 'aclitem', true, null);
        addAttribute(clsOid, 6, 'spcoptions', 'text', true, null);
      }
      if (cls.name === 'pg_rewrite') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'rulename', 'name', false, null);
        addAttribute(clsOid, 3, 'ev_class', 'oid', false, null);
        addAttribute(clsOid, 4, 'ev_attr', 'int2', false, null);
        addAttribute(clsOid, 5, 'ev_type', 'char', false, null);
        addAttribute(clsOid, 6, 'ev_enabled', 'char', false, null);
        addAttribute(clsOid, 7, 'is_instead', 'bool', false, null);
        addAttribute(clsOid, 8, 'ev_qual', 'text', true, null);
        addAttribute(clsOid, 9, 'ev_action', 'text', true, null);
      }
      if (cls.name === 'pg_range') {
        addAttribute(clsOid, 1, 'rngtypid', 'oid', false, null);
        addAttribute(clsOid, 2, 'rngsubtype', 'oid', false, null);
        addAttribute(clsOid, 3, 'rngcollation', 'oid', false, null);
        addAttribute(clsOid, 4, 'rngsubopc', 'oid', false, null);
        addAttribute(clsOid, 5, 'rngcanonical', 'regproc', true, null);
        addAttribute(clsOid, 6, 'rngsubdiff', 'regproc', true, null);
      }
      if (cls.name === 'pg_amop') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'amopfamily', 'oid', false, null);
        addAttribute(clsOid, 3, 'amoplefttype', 'oid', false, null);
        addAttribute(clsOid, 4, 'amoprighttype', 'oid', false, null);
        addAttribute(clsOid, 5, 'amopstrategy', 'int2', false, null);
        addAttribute(clsOid, 6, 'amoppurpose', 'char', false, null);
        addAttribute(clsOid, 7, 'amopopr', 'oid', false, null);
        addAttribute(clsOid, 8, 'amopmethod', 'oid', false, null);
        addAttribute(clsOid, 9, 'amopsortfamily', 'oid', false, null);
      }
      if (cls.name === 'pg_amproc') {
        addAttribute(clsOid, 1, 'oid', 'oid', false, null);
        addAttribute(clsOid, 2, 'amprocfamily', 'oid', false, null);
        addAttribute(clsOid, 3, 'amproclefttype', 'oid', false, null);
        addAttribute(clsOid, 4, 'amprocrighttype', 'oid', false, null);
        addAttribute(clsOid, 5, 'amprocnum', 'int2', false, null);
        addAttribute(clsOid, 6, 'amproc', 'oid', false, null);
      }
      if (cls.name === 'pg_shdepend') {
        addAttribute(clsOid, 1, 'dbid', 'oid', false, null);
        addAttribute(clsOid, 2, 'classid', 'oid', false, null);
        addAttribute(clsOid, 3, 'objid', 'oid', false, null);
        addAttribute(clsOid, 4, 'objsubid', 'int4', false, null);
        addAttribute(clsOid, 5, 'refclassid', 'oid', false, null);
        addAttribute(clsOid, 6, 'refobjid', 'oid', false, null);
        addAttribute(clsOid, 7, 'refobjsubid', 'int4', false, null);
        addAttribute(clsOid, 8, 'deptype', 'char', false, null);
      }
      if (cls.name === 'pg_db_role_setting') {
        addAttribute(clsOid, 1, 'setdatabase', 'oid', false, null);
        addAttribute(clsOid, 2, 'setrole', 'oid', false, null);
        addAttribute(clsOid, 3, 'setconfig', 'text', true, null);
      }
    }

    // ── Procedure rows (pg_proc) ──
    const pgNsOid = PgCatalog.getNamespaceOid('pg_catalog') || 11;
    for (const fn of SystemFunctionRegistry.getAllFunctions()) {
      const procOid = nextOid();
      PROCEDURE_ROWS.push({
        oid: procOid,
        proname: fn.name,
        pronamespace: pgNsOid,
        proowner: 10,
        prolang: 12, // SQL
        procost: 1,
        prorows: 1000,
        provariadic: 0,
        protransform: 0,
        prokind: 'f',
        prosecdef: false,
        proleakproof: false,
        proisstrict: true,
        proretset: false,
        provolatile: fn.name.startsWith('pg_') ? 's' : 'v',
        proparallel: 's',
        pronargs: fn.maxArgs,
        pronargdefaults: 0,
        prorettype: SystemTypeRegistry.getOid(
          fn.returnType === 'text' ? 'text'
            : fn.returnType === 'integer' ? 'int4'
            : fn.returnType === 'bigint' ? 'int8'
            : fn.returnType === 'boolean' ? 'bool'
            : fn.returnType === 'name' ? 'name'
            : fn.returnType === 'timestamptz' ? 'timestamptz'
            : fn.returnType === 'regtype' ? 'regtype'
            : 'text'
        ) || 25,
        proargtypes: '', // needs proper oidvector
        proallargtypes: null,
        proargmodes: null,
        proargnames: null,
        proargdefaults: null,
        prosrc: `@system ${fn.name}`,
        probin: null,
        proconfig: null,
        proacl: null,
      });
    }

    // ── Index rows (pg_index) ──
    // Add a primary key index for pg_class
    const classRow = CLASS_ROWS.find(c => c.relname === 'pg_class');
    if (classRow) {
      INDEX_ROWS.push({
        indexrelid: nextOid(),
        indrelid: classRow.oid,
        indnatts: 1,
        indnkeyatts: 1,
        indisunique: true,
        indisprimary: true,
        indisexclusion: false,
        indimmediate: true,
        indisclustered: false,
        indisvalid: true,
        indcheckxmin: false,
        indisready: true,
        indislive: true,
        indisreplident: true,
        indkey: '1',
        indcollation: '0',
        indclass: '0',
        indoption: '0',
        indexprs: null,
        indpred: null,
      });
    }
  }

  // ──────────────────────────────────────────────
  //  Query helpers (called by SystemIntegration)
  // ──────────────────────────────────────────────

  /** Get namespace OID by name */
  static getNamespaceOid(name: string): number | undefined {
    for (const [oid, ns] of NAMESPACE_ROWS) {
      if (ns.nspname === name) return oid;
    }
    return undefined;
  }

  /** Get namespace name by OID */
  static getNamespaceName(oid: number): string | undefined {
    return NAMESPACE_ROWS.get(oid)?.nspname;
  }

  /** Get class row by relname + namespace */
  static getClassOid(relname: string, namespace?: string): number | undefined {
    const nsOid = namespace ? PgCatalog.getNamespaceOid(namespace) : undefined;
    return CLASS_ROWS.find(c =>
      c.relname === relname &&
      (nsOid === undefined || c.relnamespace === nsOid)
    )?.oid;
  }

  /** Get pg_class rows */
  static getClassRows(): any[] {
    return CLASS_ROWS.map(r => ({
      ...r,
      relnamespace: r.relnamespace, // already numeric
    }));
  }

  /** Get pg_attribute rows */
  static getAttributeRows(): any[] {
    return ATTRIBUTE_ROWS;
  }

  /**
   * Map of type name → { typinput, typoutput } for types whose I/O function
   * names differ from the default int4in/int4out.
   */
  private static readonly typeIOMap: Record<string, { typinput: string; typoutput: string }> = {
    pg_lsn:  { typinput: 'pg_lsn_in',  typoutput: 'pg_lsn_out' },
    money:   { typinput: 'money_in',   typoutput: 'money_out' },
    bool:    { typinput: 'boolin',     typoutput: 'boolout' },
    int2:    { typinput: 'int2in',     typoutput: 'int2out' },
    int4:    { typinput: 'int4in',     typoutput: 'int4out' },
    int8:    { typinput: 'int8in',     typoutput: 'int8out' },
    float4:  { typinput: 'float4in',   typoutput: 'float4out' },
    float8:  { typinput: 'float8in',   typoutput: 'float8out' },
    numeric: { typinput: 'numeric_in', typoutput: 'numeric_out' },
    text:    { typinput: 'textin',     typoutput: 'textout' },
    varchar: { typinput: 'varcharin',  typoutput: 'varcharout' },
    bpchar:  { typinput: 'bpcharin',   typoutput: 'bpcharout' },
    name:    { typinput: 'namein',     typoutput: 'nameout' },
    bytea:   { typinput: 'byteain',    typoutput: 'byteaout' },
    oid:     { typinput: 'oidin',      typoutput: 'oidout' },
    xid:     { typinput: 'xidin',      typoutput: 'xidout' },
    cid:     { typinput: 'cidin',      typoutput: 'cidout' },
    tid:     { typinput: 'tidin',      typoutput: 'tidout' },
    date:    { typinput: 'date_in',    typoutput: 'date_out' },
    time:    { typinput: 'time_in',    typoutput: 'time_out' },
    timestamp:  { typinput: 'timestamp_in',  typoutput: 'timestamp_out' },
    timestamptz:{ typinput: 'timestamptz_in',typoutput: 'timestamptz_out' },
    timetz:  { typinput: 'timetz_in',  typoutput: 'timetz_out' },
    interval:{ typinput: 'interval_in',typoutput: 'interval_out' },
    uuid:    { typinput: 'uuid_in',    typoutput: 'uuid_out' },
    inet:    { typinput: 'inet_in',    typoutput: 'inet_out' },
    cidr:    { typinput: 'cidr_in',    typoutput: 'cidr_out' },
    macaddr: { typinput: 'macaddr_in', typoutput: 'macaddr_out' },
    json:    { typinput: 'json_in',    typoutput: 'json_out' },
    jsonb:   { typinput: 'jsonb_in',   typoutput: 'jsonb_out' },
    point:   { typinput: 'point_in',   typoutput: 'point_out' },
    lseg:    { typinput: 'lseg_in',    typoutput: 'lseg_out' },
    box:     { typinput: 'box_in',     typoutput: 'box_out' },
    path:    { typinput: 'path_in',    typoutput: 'path_out' },
    polygon: { typinput: 'polygon_in', typoutput: 'polygon_out' },
    circle:  { typinput: 'circle_in',  typoutput: 'circle_out' },
  };

  /** Get pg_type rows */
  static getTypeRows(): any[] {
    const pgNs = PgCatalog.getNamespaceOid('pg_catalog') || 11;
    return SystemTypeRegistry.getAll().map(t => {
      const io = PgCatalog.typeIOMap[t.name] || { typinput: 'int4in', typoutput: 'int4out' };
      return {
        oid: t.oid,
        typname: t.name,
        typnamespace: t.name === 'void' ? pgNs : PgCatalog.getNamespaceOid('pg_catalog') || 11,
        typowner: 10,
        typlen: t.length || -1,
        typtype: t.isBaseType ? 'b' : 'p',
        typcategory: t.name === 'oid' ? 'N' : t.name === 'name' ? 'S' : t.category === PgTypeCategory.PSEUDO ? 'P' : 'N',
        typispreferred: false,
        typisdefined: true,
        typdelim: ',',
        typrelid: 0,
        typbasetype: 0,
        typelem: t.name === 'int2vector' ? 21 : t.name === 'oidvector' ? 26 : 0,
        typarray: 0,
        typinput: io.typinput,
        typoutput: io.typoutput,
      };
    });
  }

  /** Get pg_index rows */
  static getIndexRows(): any[] {
    return INDEX_ROWS;
  }

  /** Get pg_proc rows */
  static getProcedureRows(): any[] {
    return PROCEDURE_ROWS;
  }

  /** Get pg_namespace rows */
  static getNamespaceRows(): any[] {
    return Array.from(NAMESPACE_ROWS.values());
  }

  /** Get pg_database rows */
  static getDatabaseRows(): any[] {
    return DATABASE_ROWS;
  }

  // ── View-level queries (return flat results for pg_catalog views) ──

  /** pg_tables view */
  static getPgTablesRows(): any[] {
    return CLASS_ROWS
      .filter(c => c.relkind === 'r')
      .map(c => ({
        schemaname: PgCatalog.getNamespaceName(c.relnamespace) || 'public',
        tablename: c.relname,
        tableowner: 'postgres',
        tablespace: null,
        hasindexes: c.relhasindex,
        hasrules: c.relhasrules,
        hastriggers: c.relhastriggers,
        rowsecurity: c.relrowsecurity,
      }));
  }

  /** pg_indexes view — dynamically queries sqlite_master + PRAGMA index_info */
  static getPgIndexesRows(): any[] {
    const db = PgCatalog.shardDb;
    const rows: any[] = [];

    if (db) {
      try {
        // Get all tables that have indexes (user + system)
        const tables = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        ).all() as { name: string }[];

        for (const tbl of tables) {
          const indexList = db.prepare(`PRAGMA index_list("${tbl.name}")`).all() as any[];
          for (const idx of indexList) {
            const indexInfo = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as any[];
            const cols = indexInfo.map((c: any) => c.name).filter(Boolean);

            const unique = idx.unique ? 'UNIQUE ' : '';
            const ns = 'public';
            const colList = cols.join(', ');
            const indexdef = `CREATE ${unique}INDEX ${idx.name} ON ${ns}.${tbl.name} (${colList})`;

            rows.push({
              schemaname: ns,
              tablename: tbl.name,
              indexname: idx.name,
              tablespace: null,
              indexdef,
            });
          }
        }
      } catch {
        // fall through
      }
    }

    // Fall back to static INDEX_ROWS if db not available or empty
    if (rows.length === 0) {
      for (const idx of INDEX_ROWS) {
        const classRow = CLASS_ROWS.find(c => c.oid === idx.indrelid);
        const ns = classRow ? PgCatalog.getNamespaceName(classRow.relnamespace) : 'public';
        rows.push({
          schemaname: ns,
          tablename: classRow?.relname || 'unknown',
          indexname: `idx_${classRow?.relname || 'unknown'}`,
          tablespace: null,
          indexdef: `CREATE INDEX idx_${classRow?.relname || 'unknown'} ON ${ns}.${classRow?.relname || 'unknown'} (id)`,
        });
      }
    }

    return rows;
  }

  /** pg_attrdef view — dynamically queries PRAGMA table_info for column defaults */
  static getPgAttrdefRows(): any[] {
    const db = PgCatalog.shardDb;
    const rows: any[] = [];

    // Build table OID map from class rows
    const tableOidMap = new Map<string, number>();
    for (const c of CLASS_ROWS) {
      if (c.relkind === 'r') {
        tableOidMap.set(c.relname, c.oid);
      }
    }

    if (db) {
      try {
        const tables = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        ).all() as { name: string }[];

        for (const tbl of tables) {
          const columns = db.prepare(`PRAGMA table_info("${tbl.name}")`).all() as any[];
          let attrOid = 20000;
          for (const col of columns) {
            if (col.dflt_value !== null && col.dflt_value !== undefined) {
              const adrelid = tableOidMap.get(tbl.name) || 0;
              attrOid++;
              rows.push({
                oid: attrOid,
                adrelid,
                adnum: col.cid + 1, // 1-based column index
                adbin: null,
                adsrc: String(col.dflt_value),
              });
            }
          }
        }
      } catch {
        // fall through
      }
    }

    return rows;
  }

  /** pg_sequences view — dynamically queries _sqlvec_sequences and __seq_* tables */
  static getPgSequencesRows(): any[] {
    const db = PgCatalog.shardDb;
    const rows: any[] = [];

    if (db) {
      try {
        // Query _sqlvec_sequences table (managed by SequenceManager)
        const seqTable = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_sequences'`
        ).get() as { name: string } | undefined;

        if (seqTable) {
          const sequences = db.prepare(
            `SELECT name, last_value, start_value, increment, min_value, max_value, cache_size, is_cycling FROM _sqlvec_sequences ORDER BY name`
          ).all() as any[];

          for (const seq of sequences) {
            rows.push({
              schemaname: 'public',
              sequencename: seq.name,
              last_value: seq.last_value,
              start_value: seq.start_value,
              increment_by: seq.increment,
              max_value: seq.max_value !== null ? seq.max_value : 9223372036854775807,
              min_value: seq.min_value,
              cache_size: seq.cache_size,
              cycle: seq.is_cycling === 1 || seq.is_cycling === true,
            });
          }
        }

        // Also scan for any tables matching __seq_* naming pattern (SERIAL columns)
        const seqTables = db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__seq_%' ORDER BY name`
        ).all() as { name: string }[];

        for (const st of seqTables) {
          // Skip if already added via _sqlvec_sequences
          if (rows.some(r => r.sequencename === st.name)) continue;

          // Try to read last_value from the sequence table
          try {
            const valRow = db.prepare(
              `SELECT last_value FROM "${st.name}"`
            ).get() as { last_value: number } | undefined;

            rows.push({
              schemaname: 'public',
              sequencename: st.name,
              last_value: valRow?.last_value ?? 1,
              start_value: 1,
              increment_by: 1,
              max_value: 9223372036854775807,
              min_value: 1,
              cache_size: 1,
              cycle: false,
            });
          } catch {
            // table might not have the expected schema
          }
        }
      } catch {
        // fall through
      }
    }

    return rows;
  }

  /** pg_views view */
  static getPgViewsRows(): any[] {
    return CLASS_ROWS
      .filter(c => c.relkind === 'v')
      .map(c => ({
        schemaname: PgCatalog.getNamespaceName(c.relnamespace) || 'public',
        viewname: c.relname,
        viewowner: 'postgres',
        definition: `-- System view: ${c.relname}`,
      }));
  }

  /** pg_settings view - dynamically generated from GucSystem */
  static getPgSettingsRows(): any[] {
    const gucSystem = GucSystem.getDefaultInstance();
    const rows = gucSystem.getPgSettingsView().map(g => ({
      name: g.name,
      setting: g.setting,
      unit: g.unit || null,
      category: g.category,
      short_desc: g.short_desc,
      extra_desc: g.extra_desc || null,
      context: g.context,
      vartype: g.vartype === 'int' ? 'integer' : g.vartype === 'real' ? 'real' : g.vartype,
      source: g.source,
      min_val: g.min_val,
      max_val: g.max_val,
      enumvals: g.enumvals || null,
      boot_val: g.boot_val,
      reset_val: g.reset_val,
      sourcefile: g.sourcefile,
      sourceline: g.sourceline,
      pending_restart: g.pending_restart,
    }));

    // Add synthetic pg_settings entries not tracked in GucSystem
    rows.push({
      name: 'search_path',
      setting: '"$user", public',
      unit: null,
      category: 'Client Connection Defaults',
      short_desc: 'Schema search path',
      extra_desc: null,
      context: 'user',
      vartype: 'string',
      source: 'default',
      min_val: null,
      max_val: null,
      enumvals: null,
      boot_val: '"$user", public',
      reset_val: '"$user", public',
      sourcefile: null,
      sourceline: null,
      pending_restart: false,
    });

    return rows;
  }

  /** pg_stat_activity view */
  static getPgStatActivityRows(): any[] {
    const rows: any[] = [];

    // ── Priority 1: Use ConnectionManager (richest source) ──
    if (PgCatalog.connectionManager) {
      const connInfoRows = PgCatalog.connectionManager.getActiveQueries();
      for (const ci of connInfoRows) {
        const queryStart = new Date(ci.queryStart).toISOString();
        rows.push({
          datid: 1,
          datname: ci.database,
          pid: process.pid + (rows.length + 1),
          leader_pid: null,
          usesysid: 10,
          usename: ci.userName || 'postgres',
          application_name: 'psql',
          client_addr: ci.clientAddr === 'unknown' ? null : ci.clientAddr,
          client_hostname: null,
          client_port: -1,
          backend_start: new Date(ci.backendStart).toISOString(),
          xact_start: ci.state === 'idle in transaction' ? queryStart : null,
          query_start: queryStart,
          state_change: new Date().toISOString(),
          wait_event_type: null,
          wait_event: null,
          state: ci.state,
          backend_xid: null,
          backend_xmin: null,
          query_id: null,
          query: ci.query || '',
          backend_type: 'client backend',
        });
      }
    }

    // ── Priority 2: Use ActiveQueryRegistry (when ConnectionManager not available) ──
    if (rows.length === 0 && PgCatalog.activeQueryRegistry) {
      const queries = PgCatalog.activeQueryRegistry.list();
      for (const q of queries) {
        const queryStart = new Date(q.queryStart).toISOString();
        rows.push({
          datid: 1,
          datname: q.database,
          pid: process.pid + (rows.length + 1),
          leader_pid: null,
          usesysid: 10,
          usename: q.userId || 'postgres',
          application_name: 'psql',
          client_addr: q.clientAddr === 'unknown' ? null : q.clientAddr,
          client_hostname: null,
          client_port: -1,
          backend_start: new Date(q.queryStart - 5000).toISOString(),
          xact_start: q.state === 'idle in transaction' ? queryStart : null,
          query_start: queryStart,
          state_change: new Date().toISOString(),
          wait_event_type: null,
          wait_event: null,
          state: q.state,
          backend_xid: null,
          backend_xmin: null,
          query_id: q.queryId,
          query: q.sql || '',
          backend_type: 'client backend',
        });
      }
    }

    // ── Priority 3: Fall back to mock when no data sources available ──
    if (rows.length === 0) {
      rows.push({
        datid: 1,
        datname: 'postgres',
        pid: process.pid,
        leader_pid: null,
        usesysid: 10,
        usename: 'postgres',
        application_name: 'psql',
        client_addr: null,
        client_hostname: null,
        client_port: -1,
        backend_start: new Date().toISOString(),
        xact_start: null,
        query_start: new Date().toISOString(),
        state_change: new Date().toISOString(),
        wait_event_type: null,
        wait_event: null,
        state: 'idle',
        backend_xid: null,
        backend_xmin: null,
        query_id: null,
        query: '',
        backend_type: 'client backend',
      });
    }

    return rows;
  }

  /** pg_stat_user_tables view */
  static getPgStatUserTablesRows(): any[] {
    const userTables = SystemCatalog.userTables.filter(t => t.tableType === 'BASE TABLE');
    return userTables.map(t => {
      const stats = PgCatalog.userTableStats.get(t.tableName.toLowerCase());
      return {
        relid: 0,
        schemaname: t.tableSchema,
        relname: t.tableName,
        seq_scan: stats?.seq_scan ?? 0,
        seq_tup_read: stats?.seq_tup_read ?? 0,
        idx_scan: stats?.idx_scan ?? 0,
        idx_tup_fetch: stats?.idx_tup_fetch ?? 0,
        n_tup_ins: stats?.n_tup_ins ?? 0,
        n_tup_upd: stats?.n_tup_upd ?? 0,
        n_tup_del: stats?.n_tup_del ?? 0,
        n_tup_hot_upd: 0,
        n_live_tup: stats?.n_live_tup ?? t.rowEstimate,
        n_dead_tup: stats?.n_dead_tup ?? 0,
        n_mod_since_analyze: stats?.n_mod_since_analyze ?? 0,
        n_ins_since_vacuum: 0,
        last_vacuum: null,
        last_autovacuum: null,
        last_analyze: stats?.last_analyze ?? null,
        last_autoanalyze: stats?.last_autoanalyze ?? null,
        vacuum_count: 0,
        autovacuum_count: 0,
        analyze_count: 0,
        autoanalyze_count: 0,
      };
    });
  }

  /** pg_stat_user_indexes view */
  static getPgStatUserIndexesRows(): any[] {
    const db = PgCatalog.shardDb;
    const rows: any[] = [];
    if (!db) return rows;

    try {
      const indexes = db.prepare(
        `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`
      ).all() as Array<{ name: string; tbl_name: string }>;

      const tableOids = new Map<string, number>();
      for (const c of CLASS_ROWS) {
        if (c.relkind === 'r' || c.relkind === 'v') {
          tableOids.set(c.relname, c.oid);
        }
      }
      const ns = PgCatalog.getNamespaceName(CLASS_ROWS[0]?.relnamespace ?? 2200) || 'public';

      for (const idx of indexes) {
        const idxStats = PgCatalog.userIndexStats.get(idx.name.toLowerCase());
        rows.push({
          relid: tableOids.get(idx.tbl_name) || 0,
          indexrelid: nextOid(),
          schemaname: ns,
          relname: idx.tbl_name,
          indexrelname: idx.name,
          idx_scan: idxStats?.idx_scan ?? 0,
          idx_tup_read: idxStats?.idx_tup_read ?? 0,
          idx_tup_fetch: idxStats?.idx_tup_fetch ?? 0,
        });
      }
    } catch {
      // fall through
    }
    return rows;
  }

  /** pg_stat_user_indexes — backwards-compatible alias */
  static getUserIndexesRows(): any[] {
    return PgCatalog.getPgStatUserIndexesRows();
  }

  /** pg_stat_database view — returns database-level statistics.
   *
   * Derives metrics from:
   *   - PgCatalog.databaseStats counter map (wired by QueryRouter)
   *   - PgStatStatements data for additional query-level details
   *
   * Standard columns: datid, datname, numbackends, xact_commit, xact_rollback,
   * blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated,
   * tup_deleted, conflicts, temp_files, temp_bytes, deadlocks, stats_reset.
   */
  static getPgStatDatabaseRows(): any[] {
    const s = PgCatalog.databaseStats;
    const pss = PgCatalog.pgStatStatements;
    const allStats = pss?.getAll() || [];

    // Use real counters from databaseStats as base, supplement with PgStatStatements
    let xact_commit = s.xact_commit;
    let xact_rollback = s.xact_rollback;
    let tup_inserted = s.tup_inserted;
    let tup_updated = s.tup_updated;
    let tup_deleted = s.tup_deleted;
    let tup_returned = s.tup_returned;

    // When databaseStats counters are zero, infer from PgStatStatements by query classification
    if (allStats.length > 0) {
      let inferredCommit = 0;
      let inferredRollback = 0;
      let inferredInserted = 0;
      let inferredUpdated = 0;
      let inferredDeleted = 0;

      for (const stat of allStats) {
        const q = stat.query.toUpperCase();
        if (q.startsWith('COMMIT') || q.startsWith('BEGIN')) {
          inferredCommit++;
        }
        if (q.startsWith('ROLLBACK')) {
          inferredRollback++;
        }
        if (q.startsWith('INSERT')) inferredInserted += stat.rows;
        if (q.startsWith('UPDATE')) inferredUpdated += stat.rows;
        if (q.startsWith('DELETE')) inferredDeleted += stat.rows;
      }

      if (!xact_commit) {
        xact_commit = inferredCommit > 0 ? inferredCommit : allStats.length;
      }
      if (!xact_rollback) xact_rollback = inferredRollback;
      if (!tup_inserted) tup_inserted = inferredInserted;
      if (!tup_updated) tup_updated = inferredUpdated;
      if (!tup_deleted) tup_deleted = inferredDeleted;
    }

    // Fall back to allStats for tup_returned and tup_fetched
    if (!tup_returned) {
      tup_returned = allStats.reduce((sum: number, stat: any) => sum + (stat.rows || 0), 0);
    }
    const tup_fetched = s.tup_fetched || tup_returned;
    const blks_read = s.blks_read || 0;
    const blks_hit = s.blks_hit || 0;
    const deadlocks = s.deadlocks || 0;
    const temp_files = s.temp_files || 0;
    const temp_bytes = s.temp_bytes || 0;
    const conflicts = s.conflicts || 0;

    // Infer additional stats from PgStatStatements if counters are zero
    let extraBlksHit = blks_hit;
    let extraBlksRead = blks_read;
    if (allStats.length > 0 && blks_hit === 0 && blks_read === 0) {
      extraBlksHit = allStats.reduce((sum: number, stat: any) => sum + (stat.sharedBlksHit || 0), 0);
      extraBlksRead = allStats.reduce((sum: number, stat: any) => sum + (stat.sharedBlksRead || 0), 0);
    }

    return [{
      datid: 1,
      datname: 'postgres',
      numbackends: 1,
      xact_commit,
      xact_rollback,
      blks_read: extraBlksRead,
      blks_hit: extraBlksHit,
      tup_returned,
      tup_fetched,
      tup_inserted,
      tup_updated,
      tup_deleted,
      conflicts,
      temp_files,
      temp_bytes,
      deadlocks,
      checksum_failures: 0,
      checksum_last_failure: null,
      blk_read_time: 0,
      blk_write_time: 0,
      session_time: xact_commit > 0 ? xact_commit * 1000 : 0,
      active_time: xact_commit > 0 ? xact_commit * 800 : 0,
      idle_in_transaction_time: 0,
      sessions: 1,
      sessions_abandoned: 0,
      sessions_fatal: 0,
      sessions_killed: 0,
      stats_reset: s.stats_reset || new Date().toISOString(),
    }];
  }

  // ──────────────────────────────────────────────
  //  PG Stat Views (P2)
  // ──────────────────────────────────────────────

  /**
   * pg_stat_all_indexes — returns index statistics from sqlite_master.
   *
   * Standard columns: relid, indexrelid, schemaname, tablename, indexname,
   * idx_scan, idx_tup_read, idx_tup_fetch.
   *
   * Uses PgCatalog.shardDb to query sqlite_master for index metadata.
   * Returns estimated stats when real data is unavailable.
   */
  static getPgStatAllIndexesRows(): any[] {
    const db = PgCatalog.shardDb;
    if (!db) return [];

    try {
      // Get all indexes from sqlite_master (excluding sqlite_ internal)
      const indexes = db.prepare(
        `SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`
      ).all() as Array<{ name: string; tbl_name: string }>;

      if (indexes.length === 0) return [];

      // Find relids for the tables in CLASS_ROWS
      const tableOids = new Map<string, number>();
      for (const c of CLASS_ROWS) {
        if (c.relkind === 'r' || c.relkind === 'v') {
          tableOids.set(c.relname, c.oid);
        }
      }

      // Get total query counts from pgStatStatements for rough idx_scan estimate
      const pss = PgCatalog.pgStatStatements;
      const totalCalls = pss ? pss.getAll().reduce((sum, e) => sum + e.calls, 0) : 0;
      const perIndex = indexes.length > 0 ? Math.max(1, Math.floor(totalCalls / indexes.length)) : 0;

      return indexes.map(idx => {
        const relid = tableOids.get(idx.tbl_name) || 0;
        const schemaname = PgCatalog.getNamespaceName(
          CLASS_ROWS.find(c => c.oid === relid)?.relnamespace ?? 2200
        ) || 'public';
        const indexrelid = nextOid();

        return {
          relid,
          indexrelid,
          schemaname,
          tablename: idx.tbl_name,
          indexname: idx.name,
          idx_scan: perIndex,
          idx_tup_read: perIndex * 5,   // estimated
          idx_tup_fetch: perIndex * 3, // estimated
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * pg_statio_all_tables — returns I/O statistics for all base tables.
   * Standard columns: relid, schemaname, tablename, heap_blks_read, heap_blks_hit,
   * idx_blks_read, idx_blks_hit, toast_blks_read, toast_blks_hit,
   * tidx_blks_read, tidx_blks_hit.
   */
  static getPgStatIoAllTablesRows(): any[] {
    const userTables = SystemCatalog.userTables.filter(t => t.tableType === 'BASE TABLE');
    return userTables.map(t => ({
      relid: 0,
      schemaname: t.tableSchema,
      tablename: t.tableName,
      heap_blks_read: 0,
      heap_blks_hit: 0,
      idx_blks_read: 0,
      idx_blks_hit: 0,
      toast_blks_read: 0,
      toast_blks_hit: 0,
      tidx_blks_read: 0,
      tidx_blks_hit: 0,
    }));
  }

  /**
   * pg_statio_all_indexes — returns empty I/O statistics for all indexes.
   * Standard columns: relid, indexrelid, schemaname, indexname, idx_blks_read, idx_blks_hit.
   */
  static getPgStatIoAllIndexesRows(): any[] {
    return [];
  }

  /**
   * pg_stat_user_functions — returns function-level statistics.
   *
   * Standard columns: funcid, schemaname, funcname, calls, total_time, self_time.
   *
   * Scans sqlite_master for triggers (used as a proxy for user-defined functions)
   * and queries the system function registry for known SQL functions.
   * Returns estimated call counts when PgStatStatements has query data.
   */
  static getPgStatUserFunctionsRows(): any[] {
    const db = PgCatalog.shardDb;
    const rows: any[] = [];

    try {
      // Scan triggers from sqlite_master as function proxies
      if (db) {
        const triggers = db.prepare(
          `SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`
        ).all() as Array<{ name: string; tbl_name: string }>;

        const pss = PgCatalog.pgStatStatements;
        const totalCalls = pss ? pss.getAll().reduce((sum, e) => sum + e.calls, 0) : 0;
        const perTrigger = triggers.length > 0 ? Math.ceil(totalCalls / (triggers.length + 1)) : 0;

        for (const trg of triggers) {
          rows.push({
            funcid: nextOid(),
            schemaname: 'public',
            funcname: trg.name,
            calls: perTrigger,
            total_time: perTrigger * 0.5,
            self_time: perTrigger * 0.3,
          });
        }
      }

      return rows;
    } catch {
      return [];
    }
  }

  /**
   * pg_stats view — returns per-column statistics from AnalyzeStatsCollector
   * and PgStatCollector data.
   *
   * Reads from __sqlvec_statistics (populated by analyzeTable) and
   * __sqlvec_histogram tables, then enriches with:
   *   - correlation: from PgStatCollector's column stats
   *   - avg_width: from avg_width in column stats
   *   - null_frac: from null_count / total_count
   *   - n_distinct: from distinct_count
   *   - most_common_vals / most_common_freqs: from mcv_items
   *   - histogram_bounds: from equi-height histogram buckets
   *
   * Returns empty array if no statistics tables exist or no collector is active.
   */
  static getPgStatsRows(): any[] {
    const db = PgCatalog.shardDb;
    if (!db) return [];

    try {
      // Check if the statistics internal tables exist
      const statsTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='__sqlvec_statistics'`
      ).get() as { name: string } | undefined;
      if (!statsTable) return [];

      const statRows = db.prepare(
        `SELECT * FROM __sqlvec_statistics ORDER BY table_name, column_name`
      ).all() as any[];

      if (statRows.length === 0) return [];

      // Read histogram data grouped by table+column
      const histRows = db.prepare(
        `SELECT * FROM __sqlvec_histogram ORDER BY table_name, column_name, bucket_index`
      ).all() as any[];

      const histByCol = new Map<string, Array<{ bucket_min: any; bucket_max: any }>>();
      for (const hb of histRows) {
        const key = `${hb.table_name}|${hb.column_name}`;
        if (!histByCol.has(key)) histByCol.set(key, []);
        histByCol.get(key)!.push({ bucket_min: hb.bucket_min, bucket_max: hb.bucket_max });
      }

      const result: any[] = [];

      for (const sr of statRows) {
        // Parse MCV values/frequencies
        let mcvVals: any[] = [];
        let mcvFreqs: number[] = [];
        try {
          mcvVals = JSON.parse(sr.mcv_values || '[]');
          mcvFreqs = JSON.parse(sr.mcv_frequencies || '[]');
        } catch {
          // Parsing failed — use defaults
        }

        const histKey = `${sr.table_name}|${sr.column_name}`;
        const buckets = histByCol.get(histKey) || [];

        // Build histogram bounds: extract bucket_min values for the bounds array
        const histBounds = buckets.map(b => b.bucket_min).filter(v => v !== null && v !== undefined);

        // n_distinct: positive = absolute count, negative = fraction, -1 = unique
        const totalRows = Number(sr.row_count) || 0;
        const distinct = Number(sr.distinct_count) || 0;
        let nDistinct: number;
        if (distinct >= totalRows) {
          nDistinct = -1; // all values are distinct
        } else if (distinct === 0) {
          nDistinct = 0;
        } else {
          nDistinct = distinct;
        }

        // null_frac
        const nullCount = Number(sr.null_count) || 0;
        const nullFrac = totalRows > 0 ? nullCount / totalRows : 0;

        // avg_width: default to 4 for ints, try to compute from PgStatCollector
        let avgWidth = 4;
        let correlation: number | null = null;

        if (PgCatalog.pgStatCollector) {
          try {
            const colStats = PgCatalog.pgStatCollector.getColumnStats(sr.table_name, sr.column_name);
            if (colStats) {
              avgWidth = colStats.avgWidth || 4;
              correlation = colStats.correlation ?? null;
            }
          } catch {
            // Collector unavailable
          }
        }

        result.push({
          schemaname: 'public',
          tablename: sr.table_name,
          attname: sr.column_name,
          inherited: false,
          null_frac: nullFrac,
          avg_width: avgWidth,
          n_distinct: nDistinct,
          most_common_vals: mcvVals.length > 0 ? mcvVals : null,
          most_common_freqs: mcvFreqs.length > 0 ? mcvFreqs : null,
          histogram_bounds: histBounds.length > 0 ? histBounds : null,
          correlation: correlation,
          most_common_elems: null,
          most_common_elem_freqs: null,
          elem_count_histogram: null,
        });
      }

      return result;
    } catch {
      return [];
    }
  }

  /**
   * pg_stat_xact_user_tables — returns empty result set.
   * Standard columns: relid, schemaname, tablename, seq_scan, seq_tup_read,
   * idx_scan, idx_tup_fetch, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd.
   */
  static getPgStatXactUserTablesRows(): any[] {
    return [];
  }

  // ──────────────────────────────────────────────
  //  PG Stat View Stubs (P3)
  // ──────────────────────────────────────────────

  /**
   * pg_stat_bgwriter — returns empty result set.
   * Standard columns: checkpoints_timed, checkpoints_req, buffers_checkpoint,
   * buffers_clean, maxwritten_clean, buffers_backend, buffers_alloc, stats_reset.
   */
  static getPgStatBgwriterRows(): any[] {
    const db = PgCatalog.shardDb;
    let buffersAlloc = 0;
    let pageSize = 4096;
    let pageCount = 0;
    try {
      if (db) {
        const ps = db.prepare('PRAGMA page_size').get() as any;
        pageSize = ps?.page_size || 4096;
        const pc = db.prepare('PRAGMA page_count').get() as any;
        pageCount = pc?.page_count || 0;
        const cache = db.prepare('PRAGMA cache_size').get() as any;
        const cacheNeg = cache?.cache_size || -2000;
        buffersAlloc = cacheNeg < 0 ? Math.abs(cacheNeg) * pageSize / pageSize : (cacheNeg || 2000);
      }
    } catch { /* keep defaults */ }
    // Use databaseStats counters for real accumulated values
    const s = PgCatalog.databaseStats;
    return [{
      checkpoints_timed: s.checkpoints_timed || 1,
      checkpoints_req: s.checkpoints_req || 0,
      buffers_checkpoint: Math.max(1, Math.round(buffersAlloc / 4)),
      buffers_clean: Math.max(0, Math.round(buffersAlloc / 10)),
      maxwritten_clean: 0,
      buffers_backend: Math.max(0, Math.round(buffersAlloc / 2)),
      buffers_alloc: Math.round(buffersAlloc),
      stats_reset: new Date().toISOString(),
    }];
  }

  /** pg_stat_replication — returns replication state for the primary node.
   *
   * Since sqlvec-db runs as a single-node primary (not a standby),
   * returns one row with 'streaming' state for local awareness.
   * Standard columns: pid, usesysid, usename, application_name, client_addr,
   * client_hostname, client_port, backend_start, state, sent_lsn, write_lsn,
   * flush_lsn, replay_lsn, write_lag, flush_lag, replay_lag, sync_priority,
   * sync_state, reply_time.
   */
  static getPgStatReplicationRows(): any[] {
    const pgLsn = (lsn: number) => {
      const hi = Math.floor(lsn / 0x100000000);
      const lo = lsn % 0x100000000;
      return `${hi.toString(16).padStart(8, '0')}/${lo.toString(16).padStart(8, '0')}`;
    };
    const now = new Date().toISOString();
    // Use WAL state for LSN if available, else default values
    let currentLsnNum = 0;
    try {
      const { WALStateManager } = require('../storage/WALStateManager');
      currentLsnNum = (WALStateManager as any).getInstance().currentLsn;
    } catch { currentLsnNum = 0xDEAD0000; }
    return [{
      pid: process.pid,
      usesysid: 10,
      usename: 'postgres',
      application_name: 'wal_sender',
      client_addr: '127.0.0.1',
      client_hostname: null,
      client_port: -1,
      backend_start: now,
      backend_xmin: null,
      state: 'streaming',
      sent_lsn: pgLsn(currentLsnNum),
      write_lsn: pgLsn(currentLsnNum),
      flush_lsn: pgLsn(currentLsnNum),
      replay_lsn: pgLsn(currentLsnNum),
      write_lag: null,
      flush_lag: null,
      replay_lag: null,
      sync_priority: 1,
      sync_state: 'sync',
      reply_time: now,
    }];
  }

  /**
   * pg_wait_sampling — returns empty result set (extension not loaded).
   */
  static getPgWaitSamplingRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_vacuum — returns empty result set (no VACUUM in progress).
   */
  static getPgStatProgressVacuumRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_analyze — returns empty result set (no ANALYZE in progress).
   */
  static getPgStatProgressAnalyzeRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_cluster — returns empty result set (no CLUSTER in progress).
   */
  static getPgStatProgressClusterRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_index — returns empty result set (no CREATE INDEX in progress).
   */
  static getPgStatProgressIndexRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_create_index — returns empty result set (no CREATE INDEX in progress).
   */
  static getPgStatProgressCreateIndexRows(): any[] {
    return [];
  }

  /**
   * pg_stat_progress_copy — returns empty result set (no COPY in progress).
   */
  static getPgStatProgressCopyRows(): any[] {
    return [];
  }

  /**
   * pg_stat_statements view — returns data from PgStatStatements singleton.
   *
   * Standard columns: queryid, query, calls, total_time, min_time, max_time,
   * mean_time, rows, shared_blks_hit, shared_blks_read,
   * blk_read_time, blk_write_time, first_call, last_call, local_blks_hit.
   *
   * Requires PgCatalog.pgStatStatements to be set during initialisation.
   * Returns empty array if no PgStatStatements instance is registered.
   */
  static getPgStatStatementsRows(): any[] {
    const pss = PgCatalog.pgStatStatements;
    if (!pss) return [];

    return pss.getAll().map(s => ({
      queryid: s.queryid,
      query: s.query,
      calls: s.calls,
      total_time: s.total_time,
      min_time: s.min_time,
      max_time: s.max_time,
      mean_time: s.mean_time,
      rows: s.rows,
      shared_blks_hit: s.shared_blks_hit,
      shared_blks_read: s.shared_blks_read,
      blk_read_time: 0,
      blk_write_time: 0,
      local_blks_hit: 0,
      local_blks_read: 0,
      temp_blks_read: 0,
      temp_blks_written: 0,
      first_call: '',
      last_call: '',
    }));
  }

  /**
   * pg_prepared_xacts view — returns data from TwoPhaseCommitManager.
   *
   * Standard columns: transaction (xid), gid (text), prepared (bool),
   * owner (name), database (name), prepared_at (timestamptz).
   *
   * Returns empty array if no TwoPhaseCommitManager is registered.
   */
  static getPgPreparedXactsRows(): any[] {
    if (!PgCatalog.preparedTxManager) return [];

    try {
      const prepared = PgCatalog.preparedTxManager.listPrepared();
      return prepared.map((tx: any) => ({
        transaction: 0, // xid placeholder; not tracked by pg_prepared_xacts in SQLite
        gid: tx.id,
        prepared: true,
        owner: 'postgres',
        database: 'postgres',
        prepared_at: tx.createdAt instanceof Date
          ? tx.createdAt.toISOString()
          : new Date(tx.createdAt).toISOString(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * pg_opclass view — returns operator class metadata from OperatorClassShim.
   *
   * Standard columns: oid, opcmethod, opcname, opcnamespace, opcowner, opcintype.
   *
   * Returns empty array if no OperatorClassShim is registered.
   */
  static getPgOpclassRows(): any[] {
    if (!PgCatalog.operatorClassShim) return [];

    try {
      const opclasses = PgCatalog.operatorClassShim.getAllOpclasses();
      let oidCounter = 20000;
      return opclasses.map((opc: any) => ({
        oid: oidCounter++,
        opcmethod: opc.indexMethod === 'btree' ? 403 : 0, // btree = 403, hash = 405
        opcname: opc.opclassName,
        opcnamespace: PgCatalog.getNamespaceOid('pg_catalog') || 11,
        opcowner: 10,
        opcintype: SystemTypeRegistry.getOid(opc.typeName) || 0,
      }));
    } catch {
      return [];
    }
  }

  /**
   * pg_opfamily view — returns operator family metadata from OperatorClassShim.
   *
   * Standard columns: oid, opfmethod, opfname, opfnamespace, opfowner.
   *
   * Returns empty array if no OperatorClassShim is registered.
   */
  static getPgOpfamilyRows(): any[] {
    if (!PgCatalog.operatorClassShim) return [];

    try {
      const opfamilies = PgCatalog.operatorClassShim.getAllOpfamilies();
      let oidCounter = 21000;
      return opfamilies.map((opcf: any) => ({
        oid: oidCounter++,
        opfmethod: opcf.indexMethod === 'btree' ? 403 : 0,
        opfname: opcf.opfamilyName,
        opfnamespace: PgCatalog.getNamespaceOid('pg_catalog') || 11,
        opfowner: 10,
      }));
    } catch {
      return [];
    }
  }

  // ──────────────────────────────────────────────
  //  New pg_catalog views (pg_trigger, pg_rules, etc.)
  // ──────────────────────────────────────────────

  /**
   * pg_trigger view — returns trigger metadata from sqlite_master.
   *
   * Standard columns: tgrelid, tgname, tgfoid, tgtype, tgenabled,
   * tgisinternal, tgdeferrable, tginitdeferred, tgnargs, tgattr,
   * tgqual, tgoldtable, tgnewtable.
   *
   * SQLite stores triggers in sqlite_master with type='trigger'.
   * We parse the `sql` column to extract table name and event type.
   */
  static getPgTriggerRows(): any[] {
    const rows: any[] = [];
    const db = PgCatalog.shardDb;
    if (!db) return rows;

    try {
      const triggers = db.prepare(
        `SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`
      ).all() as Array<{ name: string; sql: string }>;

      for (const trg of triggers) {
        const sql = trg.sql || '';
        // Parse trigger SQL to extract table name and event type
        // Pattern: CREATE TRIGGER name [BEFORE|AFTER|INSTEAD OF] event ON table ...
        const tableMatch = sql.match(/\bON\s+["']?(\w+)["']?\s*/i);
        const eventMatch = sql.match(/\b(BEFORE|AFTER|INSTEAD\s+OF)\s+(DELETE|INSERT|UPDATE)\b/i);

        const tgrelid = 0; // Table OID not tracked in SQLite
        let tgtype = 0;    // Bitmask: 1=INSERT, 2=BEFORE, 4=UPDATE, 8=DELETE, 16=AFTER, 32=INSTEAD OF
        if (eventMatch) {
          if (eventMatch[1].toUpperCase() === 'BEFORE') tgtype |= 2;
          else if (eventMatch[1].toUpperCase() === 'AFTER') tgtype |= 16;
          else if (/INSTEAD/i.test(eventMatch[1])) tgtype |= 32;

          const event = eventMatch[2].toUpperCase();
          if (event === 'INSERT') tgtype |= 1;
          else if (event === 'UPDATE') tgtype |= 4;
          else if (event === 'DELETE') tgtype |= 8;
        }

        rows.push({
          tgrelid,
          tgname: trg.name,
          tgfoid: 0,
          tgtype,
          tgenabled: 'O', // 'O' = enabled, 'D' = disabled
          tgisinternal: false,
          tgdeferrable: false,
          tginitdeferred: false,
          tgnargs: 0,
          tgattr: null,
          tgqual: sql || null,
          tgoldtable: null,
          tgnewtable: null,
        });
      }
    } catch {
      // Return empty array on error
    }

    return rows;
  }

  /**
   * pg_rules view — SQLite has no PG CREATE RULE concept.
   * SQLite triggers are the closest equivalent. Return them as rules.
   *
   * Standard columns: schemaname, tablename, rulename, definition.
   */
  static getPgRulesRows(): any[] {
    const rows: any[] = [];
    const db = PgCatalog.shardDb;
    if (!db) return rows;

    try {
      const triggers = db.prepare(
        `SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`
      ).all() as Array<{ name: string; tbl_name: string; sql: string }>;

      for (const trg of triggers) {
        rows.push({
          schemaname: 'public',
          tablename: trg.tbl_name,
          rulename: trg.name,
          definition: trg.sql || '',
        });
      }
    } catch {
      // Return empty on error
    }

    return rows;
  }

  /**
   * pg_matviews view — returns materialized view metadata.
   *
   * Queries the __materialized_views system table for real data.
   * If the table doesn't exist or is empty, returns empty result set.
   *
   * Standard columns: schemaname, matviewname, matviewowner,
   * tablespace, hasindexes, ispopulated, definition.
   */
  static getPgMatViewsRows(): any[] {
    const rows: any[] = [];
    const db = PgCatalog.shardDb;
    if (!db) return rows;

    try {
      // Check if __materialized_views table exists
      const metaTable = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='__materialized_views'`
      ).get() as { name: string } | undefined;

      if (!metaTable) return rows;

      const matViews = db.prepare(
        `SELECT view_name, query_sql, created_at, refreshed_at FROM __materialized_views ORDER BY view_name`
      ).all() as Array<{ view_name: string; query_sql: string; created_at: number; refreshed_at: number | null }>;

      for (const mv of matViews) {
        rows.push({
          schemaname: 'public',
          matviewname: mv.view_name,
          matviewowner: 'postgres',
          tablespace: null,
          hasindexes: false,
          ispopulated: mv.refreshed_at !== null,
          definition: mv.query_sql || '',
        });
      }
    } catch {
      // Return empty on error
    }

    return rows;
  }

  /**
   * pg_conversion view — SQLite has no encoding conversion.
   * Returns empty result set.
   *
   * Standard columns: oid, conname, connamespace, conowner,
   * conforencoding, contoencoding, conproc, condefault.
   */
  static getPgConversionRows(): any[] {
    return [];
  }

  /**
   * pg_aggregate view — returns registered aggregate functions.
   *
   * Standard columns: aggfnoid, aggkind, aggnumdirectargs,
   * aggtransfn, aggfinalfn, aggtranstype, aggtransspace,
   * agginitval, aggminitval, aggmfinalfn, aggsortop,
   * aggtranstype, aggserialfn, aggdeserialfn.
   *
   * If SystemFunctionRegistry has aggregate functions registered,
   * return them; otherwise return empty result set.
   */
  static getPgAggregateRows(): any[] {
    const rows: any[] = [];
    try {
      const allFns = SystemFunctionRegistry.getAllFunctions();
      const aggregateFns = allFns.filter(fn =>
        fn.name.startsWith('count') ||
        fn.name.startsWith('sum') ||
        fn.name.startsWith('avg') ||
        fn.name.startsWith('min') ||
        fn.name.startsWith('max') ||
        fn.name.startsWith('string_agg') ||
        fn.name.startsWith('array_agg') ||
        fn.name.startsWith('json_agg')
      );

      for (const fn of aggregateFns) {
        rows.push({
          aggfnoid: SystemTypeRegistry.getOid(fn.returnType) || 0,
          aggkind: 'n', // normal aggregate
          aggnumdirectargs: 0,
          aggtransfn: `@system ${fn.name}`,
          aggfinalfn: null,
          aggtranstype: 2281, // internal
          aggtransspace: 0,
          agginitval: null,
          aggminitval: null,
          aggmfinalfn: null,
          aggsortop: 0,
          aggserialfn: null,
          aggdeserialfn: null,
        });
      }
    } catch {
      // Return empty on error
    }
    return rows;
  }

  /**
   * pg_am (Access Methods) view — returns supported access methods.
   *
   * Standard columns: oid, amname, amhandler, amtype.
   * amtype: 'i' = index, 't' = table
   */
  static getPgAmRows(): any[] {
    return [
      { oid: 403, amname: 'btree', amhandler: 'bthandler', amtype: 'i' },
      { oid: 405, amname: 'hash', amhandler: 'hashhandler', amtype: 'i' },
    ];
  }

  /**
   * pg_cast view — SQLite has no PG-style cast function registry.
   * Returns empty result set.
   *
   * Standard columns: oid, castsource, casttarget, castfunc,
   * castcontext, castmethod.
   */
  static getPgCastRows(): any[] {
    return [];
  }

  /**
   * pg_depend view — SQLite has no object dependency tracking.
   * Returns empty result set.
   *
   * Standard columns: classid, objid, objsubid, refclassid,
   * refobjid, refobjsubid, deptype.
   */
  static getPgDependRows(): any[] {
    return [];
  }

  /**
   * pg_description view — SQLite has no object comment system.
   * Returns empty result set.
   *
   * Standard columns: objoid, classoid, objsubid, description.
   */
  static getPgDescriptionRows(): any[] {
    return [];
  }

  /**
   * pg_extension view — returns installed extension metadata.
   *
   * Standard columns: extname, extversion, extowner, extnamespace,
   * extrelocatable, extversion (duplicated in PG).
   *
   * Returns a realistic list of available extensions.
   */
  static getPgExtensionRows(): any[] {
    return PgCatalog.getExtensionList();
  }

  /**
   * pg_available_extensions view — returns all available extensions.
   *
   * Standard columns: name, default_version, comment, installed_version.
   */
  static getPgAvailableExtensionsRows(): any[] {
    return PgCatalog.getExtensionList().map(e => ({
      name: e.extname,
      default_version: e.extversion,
      comment: `SQLVec compatibility shim for ${e.extname}`,
      installed_version: e.extversion, // mark as installed
    }));
  }

  /**
   * Shared helper: returns the list of supported extensions with versions.
   */
  static getExtensionList(): Array<{ extname: string; extversion: string }> {
    return [
      { extname: 'citext', extversion: '1.0' },
      { extname: 'hstore', extversion: '1.0' },
      { extname: 'pgcrypto', extversion: '1.0' },
      { extname: 'fuzzystrmatch', extversion: '1.0' },
      { extname: 'pg_trgm', extversion: '1.0' },
      { extname: 'uuid-ossp', extversion: '1.0' },
      { extname: 'intarray', extversion: '1.0' },
      { extname: 'ltree', extversion: '1.0' },
      { extname: 'btree_gin', extversion: '1.0' },
      { extname: 'btree_gist', extversion: '1.0' },
      { extname: 'earthdistance', extversion: '1.0' },
      { extname: 'postgis', extversion: '3.0' },
      { extname: 'plpgsql', extversion: '1.0' },
    ];
  }

  // ──────────────────────────────────────────────
  //  Batch 7B: Skeleton pg_catalog tables
  // ──────────────────────────────────────────────

  /**
   * pg_constraint — constraint metadata.
   * Returns known primary key and foreign key constraints on system catalogs.
   */
  static getPgConstraintRows(): any[] {
    const rows: any[] = [];
    const pgNsOid = PgCatalog.getNamespaceOid('pg_catalog') || 11;

    // PK on pg_class (oid)
    const classRow = CLASS_ROWS.find(c => c.relname === 'pg_class');
    if (classRow) {
      rows.push({
        oid: nextOid(),
        conname: 'pg_class_pkey',
        connamespace: pgNsOid,
        contype: 'p',
        condeferrable: false,
        condeferred: false,
        convalidated: true,
        conrelid: classRow.oid,
        contypid: 0,
        conindid: 0,
        conparentid: 0,
        confrelid: 0,
        confupdtype: ' ',
        confdeltype: ' ',
        confmatchtype: 's',
        conislocal: true,
        coninhcount: 0,
        connoinherit: true,
        conkey: [1],
        confkey: null,
        conpfeqop: null,
        conppeqop: null,
        conffeqop: null,
        conexclop: null,
        conbin: null,
      });
    }

    // PK on pg_attribute (attrelid, attnum)
    const attrRow = CLASS_ROWS.find(c => c.relname === 'pg_attribute');
    if (attrRow) {
      rows.push({
        oid: nextOid(),
        conname: 'pg_attribute_pkey',
        connamespace: pgNsOid,
        contype: 'p',
        condeferrable: false,
        condeferred: false,
        convalidated: true,
        conrelid: attrRow.oid,
        contypid: 0,
        conindid: 0,
        conparentid: 0,
        confrelid: 0,
        confupdtype: ' ',
        confdeltype: ' ',
        confmatchtype: 's',
        conislocal: true,
        coninhcount: 0,
        connoinherit: true,
        conkey: [1, 2],
        confkey: null,
        conpfeqop: null,
        conppeqop: null,
        conffeqop: null,
        conexclop: null,
        conbin: null,
      });
    }

    return rows;
  }

  /**
   * pg_operator — operator metadata.
   * Returns common comparison and arithmetic operators with correct type OIDs.
   */
  static getPgOperatorRows(): any[] {
    const pgNsOid = PgCatalog.getNamespaceOid('pg_catalog') || 11;
    const int4Oid = SystemTypeRegistry.getOid('int4') || 23;
    const int8Oid = SystemTypeRegistry.getOid('int8') || 20;
    const float8Oid = SystemTypeRegistry.getOid('float8') || 701;
    const textOid = SystemTypeRegistry.getOid('text') || 25;
    const boolOid = SystemTypeRegistry.getOid('bool') || 16;
    const numericOid = SystemTypeRegistry.getOid('numeric') || 1700;
    const oidOid = SystemTypeRegistry.getOid('oid') || 26;

    const operators: Array<{
      oprname: string; oprkind: string; oprcanhash: boolean; oprcanmerge: boolean;
      oprleft: number; oprright: number; oprresult: number;
      oprcom?: number; oprnegate?: number; oprcode?: string;
    }> = [
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4eq' },
      { oprname: '<>', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4ne' },
      { oprname: '<', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4lt' },
      { oprname: '<=', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4le' },
      { oprname: '>', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4gt' },
      { oprname: '>=', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: int4Oid, oprright: int4Oid, oprresult: boolOid, oprcode: 'int4ge' },
      { oprname: '+', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int4Oid, oprright: int4Oid, oprresult: int4Oid, oprcode: 'int4pl' },
      { oprname: '-', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int4Oid, oprright: int4Oid, oprresult: int4Oid, oprcode: 'int4mi' },
      { oprname: '*', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int4Oid, oprright: int4Oid, oprresult: int4Oid, oprcode: 'int4mul' },
      { oprname: '/', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int4Oid, oprright: int4Oid, oprresult: int4Oid, oprcode: 'int4div' },
      // text operators
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'texteq' },
      { oprname: '<>', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'textne' },
      { oprname: '<', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'text_lt' },
      { oprname: '<=', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'text_le' },
      { oprname: '>', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'text_gt' },
      { oprname: '>=', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: textOid, oprright: textOid, oprresult: boolOid, oprcode: 'text_ge' },
      // int8 operators
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: int8Oid, oprright: int8Oid, oprresult: boolOid, oprcode: 'int8eq' },
      { oprname: '<', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: int8Oid, oprright: int8Oid, oprresult: boolOid, oprcode: 'int8lt' },
      { oprname: '+', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: int8Oid, oprright: int8Oid, oprresult: int8Oid, oprcode: 'int8pl' },
      // float8 operators
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: float8Oid, oprright: float8Oid, oprresult: boolOid, oprcode: 'float8eq' },
      { oprname: '<', oprkind: 'b', oprcanhash: false, oprcanmerge: true, oprleft: float8Oid, oprright: float8Oid, oprresult: boolOid, oprcode: 'float8lt' },
      // numeric operators
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: numericOid, oprright: numericOid, oprresult: boolOid, oprcode: 'numeric_eq' },
      { oprname: '<>', oprkind: 'b', oprcanhash: false, oprcanmerge: false, oprleft: numericOid, oprright: numericOid, oprresult: boolOid, oprcode: 'numeric_ne' },
      // oid operators
      { oprname: '=', oprkind: 'b', oprcanhash: true, oprcanmerge: true, oprleft: oidOid, oprright: oidOid, oprresult: boolOid, oprcode: 'oideq' },
    ];

    return operators.map(op => ({
      oid: nextOid(),
      oprname: op.oprname,
      oprnamespace: pgNsOid,
      oprowner: 10,
      oprkind: op.oprkind,
      oprcanhash: op.oprcanhash,
      oprcanmerge: op.oprcanmerge,
      oprleft: op.oprleft,
      oprright: op.oprright,
      oprresult: op.oprresult,
      oprcom: op.oprcom || 0,
      oprnegate: op.oprnegate || 0,
      oprcode: op.oprcode || '',
      oprrest: null,
      oprjoin: null,
    }));
  }

  /**
   * pg_language — registered procedural languages.
   * Returns the 4 known PG languages: internal, c, sql, plpgsql.
   */
  static getPgLanguageRows(): any[] {
    return [
      {
        oid: 12,
        lanname: 'internal',
        lanowner: 10,
        lanispl: false,
        lanpltrusted: true,
        lanplcallfoid: 0,
        laninline: 0,
        lanvalidator: 0,
        lanacl: null,
      },
      {
        oid: 13,
        lanname: 'c',
        lanowner: 10,
        lanispl: false,
        lanpltrusted: true,
        lanplcallfoid: 0,
        laninline: 0,
        lanvalidator: 0,
        lanacl: null,
      },
      {
        oid: 14,
        lanname: 'sql',
        lanowner: 10,
        lanispl: false,
        lanpltrusted: true,
        lanplcallfoid: 0,
        laninline: 0,
        lanvalidator: 0,
        lanacl: null,
      },
      {
        oid: 115,
        lanname: 'plpgsql',
        lanowner: 10,
        lanispl: true,
        lanpltrusted: true,
        lanplcallfoid: 0,
        laninline: 0,
        lanvalidator: 0,
        lanacl: null,
      },
    ];
  }

  /**
   * pg_tablespace — tablespace metadata.
   * Returns the 2 default tablespaces: pg_default (1663), pg_global (1664).
   */
  static getPgTablespaceRows(): any[] {
    return [
      {
        oid: 1663,
        spcname: 'pg_default',
        spcowner: 10,
        spclocation: '',
        spcacl: null,
        spcoptions: null,
      },
      {
        oid: 1664,
        spcname: 'pg_global',
        spcowner: 10,
        spclocation: '',
        spcacl: null,
        spcoptions: null,
      },
    ];
  }

  /**
   * pg_rewrite — rewrite rule metadata.
   * Returns one row per registered view with ev_type='1' (SELECT) and is_instead=true.
   */
  static getPgRewriteRows(): any[] {
    const viewClasses = CLASS_ROWS.filter(c => c.relkind === 'v');
    return viewClasses.map(v => ({
      oid: nextOid(),
      rulename: `_RETURN`,
      ev_class: v.oid,
      ev_attr: 0,
      ev_type: '1', // SELECT
      ev_enabled: 'O', // enabled
      is_instead: true,
      ev_qual: null,
      ev_action: null,
    }));
  }

  /**
   * pg_range — range type mappings.
   * Returns range types if registered in SystemTypeRegistry.
   */
  static getPgRangeRows(): any[] {
    const rows: any[] = [];
    // Check known range types
    const int4rangeOid = SystemTypeRegistry.getOid('int4range');
    const int4Oid = SystemTypeRegistry.getOid('int4') || 23;
    const tstzrangeOid = SystemTypeRegistry.getOid('tstzrange');
    const timestamptzOid = SystemTypeRegistry.getOid('timestamptz') || 1184;

    if (int4rangeOid) {
      rows.push({
        rngtypid: int4rangeOid,
        rngsubtype: int4Oid,
        rngcollation: 0,
        rngsubopc: 0,
        rngcanonical: null,
        rngsubdiff: null,
      });
    }
    if (tstzrangeOid) {
      rows.push({
        rngtypid: tstzrangeOid,
        rngsubtype: timestamptzOid,
        rngcollation: 0,
        rngsubopc: 0,
        rngcanonical: null,
        rngsubdiff: null,
      });
    }
    return rows;
  }

  /**
   * pg_amop — operator family to operator mappings.
   * Links pg_operator entries to btree and hash operator families.
   */
  static getPgAmopRows(): any[] {
    const rows: any[] = [];
    const pgNsOid = PgCatalog.getNamespaceOid('pg_catalog') || 11;

    // btree family OIDs (conventional: 421 for int4_ops, etc.)
    const btreeInt4Ops = 421;
    const btreeTextOps = 1999;
    const hashInt4Ops = 2222;

    const int4Oid = SystemTypeRegistry.getOid('int4') || 23;
    const textOid = SystemTypeRegistry.getOid('text') || 25;

    // btree strategies: 1=lt, 2=le, 3=eq, 4=ge, 5=gt
    for (let strategy = 1; strategy <= 5; strategy++) {
      rows.push({
        oid: nextOid(),
        amopfamily: btreeInt4Ops,
        amoplefttype: int4Oid,
        amoprighttype: int4Oid,
        amopstrategy: strategy,
        amoppurpose: 's',
        amopopr: nextOid(), // placeholder - links to operator OID
        amopmethod: 403, // btree
        amopsortfamily: 0,
      });
    }

    // hash strategy: 3=eq
    rows.push({
      oid: nextOid(),
      amopfamily: hashInt4Ops,
      amoplefttype: int4Oid,
      amoprighttype: int4Oid,
      amopstrategy: 1, // eq for hash
      amoppurpose: 's',
      amopopr: nextOid(),
      amopmethod: 405, // hash
      amopsortfamily: 0,
    });

    return rows;
  }

  /**
   * pg_amproc — support procedures for operator families.
   * For btree: amprocnum 1=comparison function, 2=sort support.
   */
  static getPgAmprocRows(): any[] {
    const rows: any[] = [];
    const int4Oid = SystemTypeRegistry.getOid('int4') || 23;
    const textOid = SystemTypeRegistry.getOid('text') || 25;
    const btreeInt4Ops = 421;
    const btreeTextOps = 1999;

    // btree comparison function (amprocnum=1) for int4
    rows.push({
      oid: nextOid(),
      amprocfamily: btreeInt4Ops,
      amproclefttype: int4Oid,
      amprocrighttype: int4Oid,
      amprocnum: 1,
      amproc: nextOid(), // placeholder - links to pg_proc OID
    });

    // btree comparison function (amprocnum=1) for text
    rows.push({
      oid: nextOid(),
      amprocfamily: btreeTextOps,
      amproclefttype: textOid,
      amprocrighttype: textOid,
      amprocnum: 1,
      amproc: nextOid(),
    });

    return rows;
  }

  /**
   * pg_shdepend — shared object dependencies.
   * Returns dependency entries for shared catalog objects (tablespaces, languages, etc.).
   */
  static getPgShdependRows(): any[] {
    const rows: any[] = [];
    const dbOid = 1; // postgres database OID
    const pgClassOid = PgCatalog.getClassOid('pg_class') || 0;

    // Dependency for pg_default tablespace
    rows.push({
      dbid: dbOid,
      classid: pgClassOid,
      objid: 1663, // pg_default
      objsubid: 0,
      refclassid: pgClassOid,
      refobjid: 1663,
      refobjsubid: 0,
      deptype: 'a', // pinned
    });

    // Dependency for pg_global tablespace
    rows.push({
      dbid: dbOid,
      classid: pgClassOid,
      objid: 1664, // pg_global
      objsubid: 0,
      refclassid: pgClassOid,
      refobjid: 1664,
      refobjsubid: 0,
      deptype: 'a', // pinned
    });

    return rows;
  }

  /**
   * pg_db_role_setting — per-database/per-role configuration.
   * Returns empty result set (no custom per-role settings).
   */
  static getPgDbRoleSettingRows(): any[] {
    return [];
  }

  // ──────────────────────────────────────────────
  //  Dynamic Catalog Building (P1-6/SYS-001)
  // ──────────────────────────────────────────────

  /**
   * Build pg_class and pg_attribute rows dynamically from a live SQLite database.
   *
   * Queries:
   *   1. sqlite_master → user tables (type='table' and not starting with 'sqlite_', '__', 'pg_')
   *   2. PRAGMA table_info('xxx') → column names, types, notnull, defaults
   *
   * This replaces the hardcoded user-table entries with real data from the database.
   * System catalog tables (pg_class, pg_type, etc.) remain hardcoded for stability.
   */
  static buildFromShard(db: any): void {
    if (!db) return;

    // Save reference for index/trigger queries in pg_stat_* views
    PgCatalog.shardDb = db;

    // Wire the DB reference into SystemFunctions for real pg_size_* computation
    try {
      setCurrentDbRef({
        path: db.name || '',
        prepare: (sql: string) => db.prepare(sql),
        exec: (sql: string) => db.exec(sql),
        name: db.name || 'sqlvec',
      });
    } catch {
      // Non-fatal: pg_size_* will fall back to defaults
    }

    try {
      // Remove previously dynamically-built entries (those with relkind='r' and not hardcoded system)
      // We track which OIDs were generated in buildFromShard to allow clean refreshes
      const dynamicOids = new Set<number>();

      // Also track how many were already dynamic to recalculate
      const existingDynamicRows = CLASS_ROWS.filter(c => dynamicOids.has(c.oid));
      const dynamicClassStart = CLASS_ROWS.length - existingDynamicRows.length;

      // Query all user tables from sqlite_master
      const userTables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND name NOT LIKE 'pg_%' ORDER BY name`
      ).all() as { name: string }[];

      const pgNsOid = PgCatalog.getNamespaceOid('pg_catalog') || 11;
      const publicNsOid = PgCatalog.getNamespaceOid('public') || 2200;
      const infSchemaNsOid = PgCatalog.getNamespaceOid('information_schema') || 2201;

      // Remove stale dynamic entries (those not in current sqlite_master)
      const currentTableNames = new Set(userTables.map((t: { name: string }) => t.name));
      for (let i = CLASS_ROWS.length - 1; i >= 0; i--) {
        const row = CLASS_ROWS[i];
        if (row.relnamespace !== publicNsOid && row.relnamespace !== infSchemaNsOid) continue;
        if (currentTableNames.has(row.relname)) continue;
        // Remove stale dynamic rows
        const removedOid = row.oid;
        CLASS_ROWS.splice(i, 1);
        // Also remove corresponding attribute rows
        for (let a = ATTRIBUTE_ROWS.length - 1; a >= 0; a--) {
          if (ATTRIBUTE_ROWS[a].attrelid === removedOid) {
            ATTRIBUTE_ROWS.splice(a, 1);
          }
        }
      }

      // Add current user tables dynamically
      for (const tbl of userTables) {
        // Skip if already exists
        if (CLASS_ROWS.some(c => c.relname === tbl.name && c.relnamespace === publicNsOid)) continue;

        // Query PRAGMA table_info for columns
        const columns = db.prepare(`PRAGMA table_info('${tbl.name}')`).all() as any[];
        const natts = columns.length;

        // Estimate row count
        let rowCount = 0;
        try {
          const countRow = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tbl.name}"`).get() as any;
          rowCount = countRow ? countRow.cnt : 0;
        } catch {
          rowCount = 0;
        }

        const classOid = nextOid();
        const typeOid = nextOid();

        const classRow: PgClassRow = {
          oid: classOid,
          relname: tbl.name,
          relnamespace: publicNsOid,
          reltype: typeOid,
          reloftype: 0,
          relowner: 10,
          relam: 2,
          relfilenode: classOid,
          reltablespace: 0,
          relpages: Math.max(1, Math.ceil(rowCount / 100)),
          reltuples: rowCount,
          relallvisible: 0,
          reltoastrelid: 0,
          relhasindex: false,
          relisshared: false,
          relpersistence: 'p',
          relkind: 'r',
          relnatts: natts,
          relchecks: 0,
          relhasrules: false,
          relhastriggers: false,
          relhassubclass: false,
          relrowsecurity: false,
          relforcerowsecurity: false,
          relispartition: false,
          relrewrite: 0,
          relfrozenxid: 0,
          relminmxid: 0,
          relacl: null,
          reloptions: null,
          relpartbound: null,
        };
        CLASS_ROWS.push(classRow);
        dynamicOids.add(classOid);

        // Add system columns
        const sysColDefs = [
          { name: 'tableoid', type: 'oid', attnum: -7 },
          { name: 'cmax', type: 'cid', attnum: -6 },
          { name: 'xmax', type: 'xid', attnum: -5 },
          { name: 'cmin', type: 'cid', attnum: -4 },
          { name: 'xmin', type: 'xid', attnum: -3 },
          { name: 'oid', type: 'oid', attnum: -2 },
          { name: 'ctid', type: 'tid', attnum: -1 },
        ];
        for (const col of sysColDefs) {
          const typeOid = SystemTypeRegistry.getOid(col.type) || 26;
          ATTRIBUTE_ROWS.push(makeAttribute(classOid, col.attnum, col.name, typeOid, false, null));
        }

        // Add user columns from PRAGMA table_info
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const pgTypeName = mapSqliteTypeToPgType(col.type);
          const typeOid = SystemTypeRegistry.getOid(pgTypeName) || 25; // default text
          ATTRIBUTE_ROWS.push(makeAttribute(
            classOid,
            i + 1,
            col.name,
            typeOid,
            col.notnull === 1,
            col.dflt_value,
          ));
        }
      }
    } catch (err: any) {
      // Non-fatal: dynamic building is best-effort
      const { PinoLogger } = require('../monitoring/PinoLogger');
      const innerLogger = PinoLogger.forComponent('PgCatalog');
      innerLogger.warn({ error: err.message }, 'PgCatalog.buildFromShard failed');
    }
  }

  /**
   * Refresh the dynamic catalog entries.
   * Re-queries sqlite_master and PRAGMA table_info to rebuild user table entries.
   */
  static refresh(db: any): void {
    PgCatalog.buildFromShard(db);
  }
}

// ──────────────────────────────────────────────
//  Helper functions
// ──────────────────────────────────────────────

function makeAttribute(
  attrelid: number,
  attnum: number,
  attname: string,
  atttypid: number,
  attnotnull: boolean,
  atthasdef: any,
): any {
  return {
    attrelid,
    attname,
    atttypid,
    attstattarget: -1,
    attlen: -1,
    attnum,
    attndims: 0,
    attcacheoff: -1,
    atttypmod: -1,
    attbyval: false,
    attstorage: 'x',
    attalign: 'i',
    attnotnull,
    atthasdef: !!atthasdef,
    atthasmissing: false,
    attidentity: '',
    attgenerated: '',
    attisdropped: false,
    attislocal: true,
    attinhcount: 0,
    attcollation: 0,
    attacl: null,
    attoptions: null,
    attfdwoptions: null,
    attmissingval: null,
  };
}

function addAttribute(
  attrelid: number,
  attnum: number,
  attname: string,
  typeName: string,
  nullable: boolean,
  defaultValue: any,
): void {
  const typeOid = SystemTypeRegistry.getOid(typeName) || 23; // default int4
  ATTRIBUTE_ROWS.push(makeAttribute(attrelid, attnum, attname, typeOid, nullable, defaultValue));
}

/**
 * Map SQLite column type names to PostgreSQL type names for pg_catalog.
 */
function mapSqliteTypeToPgType(sqliteType: string): string {
  const upper = sqliteType ? sqliteType.toUpperCase() : '';
  if (upper.includes('INT')) return 'int4';
  if (upper.includes('CITEXT')) return 'text';
  if (upper.includes('CHAR') || upper.includes('TEXT') || upper.includes('CLOB')) return 'text';
  if (upper.includes('BLOB')) return 'bytea';
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB')) return 'float8';
  if (upper.includes('BOOLEAN') || upper.includes('BOOL')) return 'bool';
  if (upper.includes('DATE') || upper.includes('TIME')) return 'timestamptz';
  if (upper.includes('NUMERIC') || upper.includes('DECIMAL')) return 'numeric';
  return 'text'; // default
}

/**
 * Simple FNV-1a hash for generating a stable queryid from normalized SQL.
 * PostgreSQL uses hashtext() for pg_stat_statements.queryid.
 */
function hashString(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    hash = hash >>> 0; // force unsigned 32-bit
  }
  return hash;
}
