// @ts-nocheck
/**
 * PgSystemViews — pg_catalog system view rewrites for SQLVec QueryRouter.
 *
 * Implements 11 missing system views using the detect + rewrite pattern.
 * Each view:
 *   1. detectViewName(sql) — returns true if the SQL queries this view
 *   2. rewriteViewName(sql) — rewrites to an inline UNION SELECT or VALUES subquery
 *
 * Views share runtime data through static references set during SystemIntegration.init:
 *   - ActiveQueryRegistry → pg_stat_activity
 *   - ConnectionManager   → pg_stat_activity, pg_stat_ssl
 *   - PgHbaConf           → pg_hba_file_rules
 *   - ExtensionShim       → pg_available_extension_versions
 */

import { PinoLogger } from '../logger/PinoLogger';
import type { ActiveQueryRegistry } from '../monitoring/ActiveQueryRegistry';
import type { ConnectionManager } from '../monitoring/ConnectionManager';
import type { PgHbaConf, HbaRecord } from '../auth/pgHbaConf';

const logger = PinoLogger.forComponent('PgSystemViews');

// ════════════════════════════════════════════════
//  Static data source references
// ════════════════════════════════════════════════

/**
 * Reference to ActiveQueryRegistry for pg_stat_activity data.
 * Set during SystemIntegration.init or wired by QueryRouter.
 */
export let activeQueryRegistry: ActiveQueryRegistry | null = null;

export function setActiveQueryRegistry(registry: ActiveQueryRegistry | null): void {
  activeQueryRegistry = registry;
}

/**
 * Reference to ConnectionManager for connection-level data.
 * Set during SystemIntegration.init or wired by QueryRouter.
 */
export let connectionManager: ConnectionManager | null = null;

export function setConnectionManager(cm: ConnectionManager | null): void {
  connectionManager = cm;
}

/**
 * Reference to PgHbaConf for pg_hba_file_rules data.
 * Set during SystemIntegration.init or wired by QueryRouter.
 */
export let pgHbaConf: PgHbaConf | null = null;

export function setPgHbaConf(conf: PgHbaConf | null): void {
  pgHbaConf = conf;
}

/**
 * List of installed extensions (name → version) for pg_available_extension_versions.
 * Set during SystemIntegration.init.
 */
export let installedExtensions: Map<string, string> = new Map();

export function setInstalledExtensions(exts: Map<string, string>): void {
  installedExtensions = exts;
}

// ════════════════════════════════════════════════
//  1. pg_stat_activity
// ════════════════════════════════════════════════

export interface PgStatActivityRow {
  datid: number;
  datname: string;
  pid: number;
  usesysid: number;
  usename: string;
  application_name: string;
  client_addr: string | null;
  client_hostname: string | null;
  client_port: number;
  backend_start: string;
  xact_start: string | null;
  query_start: string;
  state_change: string;
  wait_event_type: string | null;
  wait_event: string | null;
  state: string;
  backend_xid: string | null;
  backend_xmin: string | null;
  query: string;
  backend_type: string;
}

const PG_STAT_ACTIVITY_RE = /\bpg_stat_activity\b/i;

export function detectPgStatActivity(sql: string): boolean {
  return PG_STAT_ACTIVITY_RE.test(sql);
}

/**
 * Collect real activity data from runtime sources.
 */
export function collectActivityData(): PgStatActivityRow[] {
  const rows: PgStatActivityRow[] = [];
  const now = new Date().toISOString();

  // Priority 1: Use ConnectionManager (richest source)
  if (connectionManager) {
    try {
      const connQueries = connectionManager.getActiveQueries();
      for (let i = 0; i < connQueries.length; i++) {
        const cq = connQueries[i];
        rows.push({
          datid: 1,
          datname: cq.database,
          pid: process.pid + i + 1,
          usesysid: 10,
          usename: cq.userName || 'postgres',
          application_name: 'psql',
          client_addr: cq.clientAddr === 'unknown' ? null : cq.clientAddr,
          client_hostname: null,
          client_port: -1,
          backend_start: new Date(cq.backendStart).toISOString(),
          xact_start: cq.state === 'idle in transaction' ? new Date(cq.queryStart).toISOString() : null,
          query_start: new Date(cq.queryStart).toISOString(),
          state_change: now,
          wait_event_type: null,
          wait_event: null,
          state: cq.state,
          backend_xid: null,
          backend_xmin: null,
          query: cq.query || '',
          backend_type: 'client backend',
        });
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'collectActivityData: ConnectionManager failed');
    }
  }

  // Priority 2: Use ActiveQueryRegistry
  if (rows.length === 0 && activeQueryRegistry) {
    try {
      const queries = activeQueryRegistry.list();
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        const queryStart = new Date(q.queryStart).toISOString();
        rows.push({
          datid: 1,
          datname: q.database,
          pid: (q.pid || process.pid) + i,
          usesysid: 10,
          usename: q.userId || 'postgres',
          application_name: 'psql',
          client_addr: q.clientAddr === 'unknown' ? null : q.clientAddr,
          client_hostname: null,
          client_port: -1,
          backend_start: new Date(q.backendStart ?? q.queryStart).toISOString(),
          xact_start: q.state === 'idle in transaction' ? queryStart : null,
          query_start: queryStart,
          state_change: now,
          wait_event_type: null,
          wait_event: null,
          state: q.state,
          backend_xid: null,
          backend_xmin: null,
          query: q.sql || '',
          backend_type: 'client backend',
        });
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, 'collectActivityData: ActiveQueryRegistry failed');
    }
  }

  // Priority 3: Fallback mock row
  if (rows.length === 0) {
    rows.push({
      datid: 1,
      datname: 'postgres',
      pid: process.pid,
      usesysid: 10,
      usename: 'postgres',
      application_name: 'psql',
      client_addr: null,
      client_hostname: null,
      client_port: -1,
      backend_start: now,
      xact_start: null,
      query_start: now,
      state_change: now,
      wait_event_type: null,
      wait_event: null,
      state: 'idle',
      backend_xid: null,
      backend_xmin: null,
      query: '',
      backend_type: 'client backend',
    });
  }

  return rows;
}

/**
 * Build a VALUES-based UNION SELECT for pg_stat_activity.
 */
function buildPgStatActivityValues(rows: PgStatActivityRow[]): string {
  // The only caller (rewritePgStatActivity) always feeds a non-empty list
  // via collectActivityData's fallback row, so the empty branch is defensive.
  /* v8 ignore next */
  if (rows.length === 0) {
    return `SELECT
  1::oid AS datid,
  ''::name AS datname,
  0::int4 AS pid,
  0::oid AS usesysid,
  ''::name AS usename,
  ''::text AS application_name,
  NULL::inet AS client_addr,
  NULL::text AS client_hostname,
  -1::int4 AS client_port,
  NULL::timestamptz AS backend_start,
  NULL::timestamptz AS xact_start,
  NULL::timestamptz AS query_start,
  NULL::timestamptz AS state_change,
  NULL::text AS wait_event_type,
  NULL::text AS wait_event,
  'idle'::text AS state,
  NULL::xid AS backend_xid,
  NULL::xid AS backend_xmin,
  ''::text AS query,
  ''::text AS backend_type
WHERE false`;
  }

  const parts = rows.map(r => {
    const clientAddr = r.client_addr ? `'${r.client_addr}'::inet` : 'NULL::inet';
    const backendStart = `'${r.backend_start}'::timestamptz`;
    const xactStart = r.xact_start ? `'${r.xact_start}'::timestamptz` : 'NULL::timestamptz';
    const queryStart = `'${r.query_start}'::timestamptz`;
    const stateChange = `'${r.state_change}'::timestamptz`;
    // wait_event fields are hardcoded to null in collectActivityData, so the
    // truthy limbs are unreachable defensive SQL-fidelity branches.
    /* v8 ignore next */
    const waitEventType = r.wait_event_type ? `'${escapeSql(r.wait_event_type)}'::text` : 'NULL::text';
    /* v8 ignore next */
    const waitEvent = r.wait_event ? `'${escapeSql(r.wait_event)}'::text` : 'NULL::text';

    return `SELECT
  ${r.datid}::oid AS datid,
  '${escapeSql(r.datname)}'::name AS datname,
  ${r.pid}::int4 AS pid,
  ${r.usesysid}::oid AS usesysid,
  '${escapeSql(r.usename)}'::name AS usename,
  '${escapeSql(r.application_name)}'::text AS application_name,
  ${clientAddr} AS client_addr,
  NULL::text AS client_hostname,
  ${r.client_port}::int4 AS client_port,
  ${backendStart} AS backend_start,
  ${xactStart} AS xact_start,
  ${queryStart} AS query_start,
  ${stateChange} AS state_change,
  ${waitEventType} AS wait_event_type,
  ${waitEvent} AS wait_event,
  '${escapeSql(r.state)}'::text AS state,
  NULL::xid AS backend_xid,
  NULL::xid AS backend_xmin,
  '${escapeSql(r.query)}'::text AS query,
  '${escapeSql(r.backend_type)}'::text AS backend_type`;
  });

  return parts.join('\nUNION ALL\n');
}

export function rewritePgStatActivity(sql: string): string {
  const data = collectActivityData();
  const values = buildPgStatActivityValues(data);
  // Wrap original query around the values subquery
  return sql.replace(
    /\bpg_stat_activity\b/i,
    `(${values}) AS pg_stat_activity`
  );
}

// ════════════════════════════════════════════════
//  2. pg_user (alias for pg_shadow)
// ════════════════════════════════════════════════

const PG_USER_RE = /\bpg_user\b/i;

export function detectPgUser(sql: string): boolean {
  return PG_USER_RE.test(sql);
}

export function rewritePgUser(sql: string): string {
  const rows = [
    { usename: 'postgres', usesysid: 10, usecreatedb: true, usesuper: true, userepl: true, usebypassrls: true },
    { usename: 'pg_database_owner', usesysid: 6175, usecreatedb: false, usesuper: false, userepl: false, usebypassrls: false },
  ];

  const parts = rows.map(r => {
    return `SELECT
  '${r.usename}'::name AS usename,
  ${r.usesysid}::oid AS usesysid,
  ${r.usecreatedb}::bool AS usecreatedb,
  ${r.usesuper}::bool AS usesuper,
  ${r.userepl}::bool AS userepl,
  ${r.usebypassrls}::bool AS usebypassrls,
  '********'::text AS passwd,
  NULL::timestamptz AS valuntil,
  NULL::_text AS useconfig`;
  });

  // Use pg_catalog.pg_user → Subquery rewrite
  const alias = detectAlias(sql, 'pg_user');
  return sql.replace(
    /\bpg_user\b/gi,
    `(${parts.join('\nUNION ALL\n')})${alias ? ` AS pg_user` : ''}`
  );
}

// ════════════════════════════════════════════════
//  3. pg_group (deprecated alias for pg_roles)
// ════════════════════════════════════════════════

const PG_GROUP_RE = /\bpg_group\b/i;

export function detectPgGroup(sql: string): boolean {
  return PG_GROUP_RE.test(sql);
}

export function rewritePgGroup(sql: string): string {
  // pg_group columns: groname, grosysid, grolist
  // Roles that act as groups would have member roles
  // For sqlvec we return known roles
  const parts = [
    `SELECT 'postgres'::name AS groname, 10::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_read_all_data'::name AS groname, 6181::oid AS grosysid, ARRAY[10]::oid[] AS grolist`,
    `SELECT 'pg_write_all_data'::name AS groname, 6182::oid AS grosysid, ARRAY[10]::oid[] AS grolist`,
    `SELECT 'pg_database_owner'::name AS groname, 6175::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_read_all_settings'::name AS groname, 6183::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_read_all_stats'::name AS groname, 6184::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_monitor'::name AS groname, 6185::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_signal_backend'::name AS groname, 6186::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_read_server_files'::name AS groname, 6187::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_write_server_files'::name AS groname, 6188::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
    `SELECT 'pg_execute_server_program'::name AS groname, 6189::oid AS grosysid, ARRAY[]::oid[] AS grolist`,
  ];
  return sql.replace(
    /\bpg_group\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_group`
  );
}

// ════════════════════════════════════════════════
//  4. pg_stat_sys_tables
// ════════════════════════════════════════════════

const PG_STAT_SYS_TABLES_RE = /\bpg_stat_sys_tables\b/i;

export function detectPgStatSysTables(sql: string): boolean {
  return PG_STAT_SYS_TABLES_RE.test(sql);
}

export function rewritePgStatSysTables(sql: string): string {
  // System tables belong to pg_catalog and information_schema schemas
  // Return stats rows for known system catalog tables (all zeros)
  const sysTables = [
    'pg_class', 'pg_attribute', 'pg_type', 'pg_index', 'pg_proc',
    'pg_namespace', 'pg_database', 'pg_settings', 'pg_tables',
    'pg_indexes', 'pg_views', 'pg_user', 'pg_group',
    'pg_stat_activity', 'pg_stat_user_tables', 'pg_stat_user_indexes',
    'pg_stat_database', 'pg_stat_all_indexes', 'pg_statio_all_tables',
    'pg_statio_all_indexes', 'pg_stat_user_functions',
    'pg_stat_xact_user_tables', 'pg_stat_statements',
    'pg_prepared_xacts', 'pg_opclass', 'pg_opfamily',
    'pg_attrdef', 'pg_sequences', 'pg_trigger', 'pg_rules',
    'pg_matviews', 'pg_conversion', 'pg_aggregate', 'pg_am',
    'pg_cast', 'pg_depend', 'pg_description', 'pg_extension',
    'pg_available_extensions',
  ];

  const infoSchemaTables = [
    'tables', 'columns', 'schemata', 'routines', 'views', 'sequences',
  ];

  const allSysTables = [
    ...sysTables.map(t => ({ schemaname: 'pg_catalog', relname: t })),
    ...infoSchemaTables.map(t => ({ schemaname: 'information_schema', relname: t })),
  ];

  const parts = allSysTables.map((t, i) => {
    return `SELECT
  ${i + 1 + 10000}::oid AS relid,
  '${t.schemaname}'::name AS schemaname,
  '${t.relname}'::name AS relname,
  0::int8 AS seq_scan,
  0::int8 AS seq_tup_read,
  0::int8 AS idx_scan,
  0::int8 AS idx_tup_fetch,
  0::int8 AS n_tup_ins,
  0::int8 AS n_tup_upd,
  0::int8 AS n_tup_del,
  0::int8 AS n_tup_hot_upd,
  0::int8 AS n_live_tup,
  0::int8 AS n_dead_tup,
  0::int8 AS n_mod_since_analyze,
  0::int8 AS n_ins_since_vacuum,
  NULL::timestamptz AS last_vacuum,
  NULL::timestamptz AS last_autovacuum,
  NULL::timestamptz AS last_analyze,
  NULL::timestamptz AS last_autoanalyze,
  0::int8 AS vacuum_count,
  0::int8 AS autovacuum_count,
  0::int8 AS analyze_count,
  0::int8 AS autoanalyze_count`;
  });

  const subquery = parts.join('\nUNION ALL\n');
  return sql.replace(
    /\bpg_stat_sys_tables\b/gi,
    `(${subquery}) AS pg_stat_sys_tables`
  );
}

// ════════════════════════════════════════════════
//  5. pg_stat_ssl
// ════════════════════════════════════════════════

const PG_STAT_SSL_RE = /\bpg_stat_ssl\b/i;

export function detectPgStatSsl(sql: string): boolean {
  return PG_STAT_SSL_RE.test(sql);
}

export function rewritePgStatSsl(sql: string): string {
  // Use connectionManager data to produce SSL status per backend
  const sslRows: Array<{
    pid: number;
    ssl: boolean;
    version: string | null;
    cipher: string | null;
    bits: number;
    client_dn: string | null;
    client_serial: string | null;
    issuer_dn: string | null;
  }> = [];

  // Default: one row for the current process (no SSL)
  sslRows.push({
    pid: process.pid,
    ssl: false,
    version: null,
    cipher: null,
    bits: 0,
    client_dn: null,
    client_serial: null,
    issuer_dn: null,
  });

  // If ConnectionManager has connections, add SSL data for each
  if (connectionManager) {
    try {
      // We can't directly access TLS socket info from ConnectionEntry
      // because socket type is net.Socket, not tls.TLSSocket.
      // For now, report no SSL for all connections.
      // This will be enhanced when TLS support is added.
      const sessionIds = connectionManager.getSessionIds();
      for (let i = 0; i < sessionIds.length; i++) {
        const pid = process.pid + i + 1;
        // pid is always process.pid+i+1 which never equals the default row's
        // process.pid (i >= 0), so the collision-check true limb is unreachable.
        /* v8 ignore next */
        if (!sslRows.some(r => r.pid === pid)) {
          sslRows.push({
            pid,
            ssl: false,
            version: null,
            cipher: null,
            bits: 0,
            client_dn: null,
            client_serial: null,
            issuer_dn: null,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  const parts = sslRows.map(r => {
    // TLS fields are hardcoded to null (no TLS socket access yet), so the
    // truthy limbs are unreachable defensive SQL-fidelity branches.
    /* v8 ignore next */
    const version = r.version ? `'${r.version}'::text` : 'NULL::text';
    /* v8 ignore next */
    const cipher = r.cipher ? `'${r.cipher}'::text` : 'NULL::text';
    /* v8 ignore next */
    const clientDn = r.client_dn ? `'${r.client_dn}'::text` : 'NULL::text';
    /* v8 ignore next */
    const clientSerial = r.client_serial ? `'${r.client_serial}'::text` : 'NULL::text';
    /* v8 ignore next */
    const issuerDn = r.issuer_dn ? `'${r.issuer_dn}'::text` : 'NULL::text';

    return `SELECT
  ${r.pid}::int4 AS pid,
  ${r.ssl}::bool AS ssl,
  ${version} AS version,
  ${cipher} AS cipher,
  ${r.bits}::int4 AS bits,
  ${clientDn} AS client_dn,
  ${clientSerial} AS client_serial,
  ${issuerDn} AS issuer_dn`;
  });

  return sql.replace(
    /\bpg_stat_ssl\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_stat_ssl`
  );
}

// ════════════════════════════════════════════════
//  6. pg_stat_subscription
// ════════════════════════════════════════════════

const PG_STAT_SUBSCRIPTION_RE = /\bpg_stat_subscription\b/i;

export function detectPgStatSubscription(sql: string): boolean {
  return PG_STAT_SUBSCRIPTION_RE.test(sql);
}

export function rewritePgStatSubscription(sql: string): string {
  // No subscriptions configured → return empty set with correct schema
  return sql.replace(
    /\bpg_stat_subscription\b/gi,
    `(SELECT
  NULL::oid AS subid,
  NULL::name AS subname,
  NULL::int4 AS pid,
  NULL::oid AS relid,
  NULL::pg_lsn AS received_lsn,
  NULL::timestamptz AS last_msg_send_time,
  NULL::timestamptz AS last_msg_receipt_time,
  NULL::pg_lsn AS latest_end_lsn,
  NULL::timestamptz AS latest_end_time
WHERE false) AS pg_stat_subscription`
  );
}

// ════════════════════════════════════════════════
//  7. pg_file_settings
// ════════════════════════════════════════════════

const PG_FILE_SETTINGS_RE = /\bpg_file_settings\b/i;

export function detectPgFileSettings(sql: string): boolean {
  return PG_FILE_SETTINGS_RE.test(sql);
}

export function rewritePgFileSettings(sql: string): string {
  // Return known configuration entries from pg_settings
  // pg_file_settings columns: sourcefile, sourceline, seqno, name, setting, applied, error
  const settings = [
    { name: 'max_connections', setting: '100' },
    { name: 'shared_buffers', setting: '16384' },
    { name: 'port', setting: '5432' },
    { name: 'listen_addresses', setting: '*' },
    { name: 'password_encryption', setting: 'scram-sha-256' },
    { name: 'ssl', setting: 'off' },
    { name: 'timezone', setting: 'Etc/UTC' },
    { name: 'lc_messages', setting: 'en_US.UTF-8' },
    { name: 'lc_monetary', setting: 'en_US.UTF-8' },
    { name: 'lc_numeric', setting: 'en_US.UTF-8' },
    { name: 'lc_time', setting: 'en_US.UTF-8' },
    { name: 'default_transaction_isolation', setting: 'read committed' },
    { name: 'statement_timeout', setting: '0' },
    { name: 'log_statement', setting: 'none' },
    { name: 'search_path', setting: '"$user", public' },
    { name: 'autovacuum', setting: 'on' },
    { name: 'autovacuum_vacuum_threshold', setting: '50' },
    { name: 'autovacuum_analyze_threshold', setting: '50' },
    { name: 'autovacuum_max_workers', setting: '3' },
    { name: 'autovacuum_naptime', setting: '60' },
  ];

  const parts = settings.map((s, i) => {
    // Every pg_file_settings entry above uses a string literal, so the
    // non-string (numeric) limb is unreachable defensive code.
    /* v8 ignore next */
    const settingVal = typeof s.setting === 'string' ? `'${escapeSql(s.setting)}'` : `${s.setting}`;
    return `SELECT
  '/etc/postgresql/postgresql.conf'::text AS sourcefile,
  ${(i + 1) * 10}::int4 AS sourceline,
  ${i + 1}::int4 AS seqno,
  '${escapeSql(s.name)}'::text AS name,
  ${settingVal}::text AS setting,
  true::bool AS applied,
  NULL::text AS error`;
  });

  return sql.replace(
    /\bpg_file_settings\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_file_settings`
  );
}

// ════════════════════════════════════════════════
//  8. pg_config
// ════════════════════════════════════════════════

const PG_CONFIG_RE = /\bpg_config\b/i;

export function detectPgConfig(sql: string): boolean {
  return PG_CONFIG_RE.test(sql);
}

export function rewritePgConfig(sql: string): string {
  const configEntries = [
    { name: 'CONFIGURE', setting: '--enable-thread-safety --with-icu' },
    { name: 'VERSION', setting: 'PostgreSQL 16.0 (sqlvec 0.1.0)' },
    { name: 'VERSION_NUM', setting: '160000' },
    { name: 'BINDIR', setting: '/usr/lib/postgresql/16/bin' },
    { name: 'DOCDIR', setting: '/usr/share/doc/postgresql' },
    { name: 'HTMLDIR', setting: '/usr/share/doc/postgresql' },
    { name: 'INCLUDEDIR', setting: '/usr/include/postgresql' },
    { name: 'PKGINCLUDEDIR', setting: '/usr/include/postgresql/16' },
    { name: 'INCLUDEDIR-SERVER', setting: '/usr/include/postgresql/16/server' },
    { name: 'LIBDIR', setting: '/usr/lib/postgresql/16/lib' },
    { name: 'PKGLIBDIR', setting: '/usr/lib/postgresql/16/lib' },
    { name: 'LOCALEDIR', setting: '/usr/share/locale' },
    { name: 'MANDIR', setting: '/usr/share/man' },
    { name: 'SHAREDIR', setting: '/usr/share/postgresql/16' },
    { name: 'SYSCONFDIR', setting: '/etc/postgresql/16' },
    { name: 'PGXS', setting: '/usr/lib/postgresql/16/lib/pgxs/src/makefiles/pgxs.mk' },
    { name: 'CC', setting: 'gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0' },
    { name: 'CPPFLAGS', setting: '-D_GNU_SOURCE -D_XOPEN_SOURCE=600' },
    { name: 'CFLAGS', setting: '-O2 -Wall -Wmissing-prototypes -Wpointer-arith' },
    { name: 'CFLAGS_SL', setting: '-fPIC' },
    { name: 'LDFLAGS', setting: '-Wl,--as-needed' },
    { name: 'LDFLAGS_EX', setting: '' },
    { name: 'LDFLAGS_SL', setting: '' },
    { name: 'LIBS', setting: '-lpgcommon -lpgport -lssl -lcrypto -lz -lreadline -lcrypt' },
  ];

  const parts = configEntries.map(e => {
    return `SELECT '${escapeSql(e.name)}'::text AS name, '${escapeSql(e.setting)}'::text AS setting`;
  });

  return sql.replace(
    /\bpg_config\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_config`
  );
}

// ════════════════════════════════════════════════
//  9. pg_hba_file_rules
// ════════════════════════════════════════════════

const PG_HBA_FILE_RULES_RE = /\bpg_hba_file_rules\b/i;

export function detectPgHbaFileRules(sql: string): boolean {
  return PG_HBA_FILE_RULES_RE.test(sql);
}

/**
 * Convert an HbaRecord to a SQL VALUES row for pg_hba_file_rules.
 */
function hbaRecordToRow(record: HbaRecord, lineNum: number): string {
  const type = escapeSql(record.type);
  const database = escapeSql(record.database);
  const user = escapeSql(record.user);
  const address = record.address ? `'${escapeSql(record.address)}'::text` : 'NULL::text';
  const netmask = 'NULL::text'; // PG uses address field combined
  const authMethod = escapeSql(record.authMethod);

  // Serialize options to JSON-compatible string
  let optionsVal = 'NULL::text';
  if (record.options && Object.keys(record.options).length > 0) {
    const optsStr = Object.entries(record.options)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    optionsVal = `'${escapeSql(optsStr)}'::text`;
  }

  return `SELECT
  ${lineNum}::int4 AS line_number,
  '${type}'::text AS type,
  '${database}'::text AS database,
  '${user}'::text AS user_name,
  ${address} AS address,
  ${netmask} AS netmask,
  '${authMethod}'::text AS auth_method,
  ${optionsVal} AS options,
  NULL::text AS error`;
}

export function rewritePgHbaFileRules(sql: string): string {
  let rows: string[];

  if (pgHbaConf) {
    try {
      const records = (pgHbaConf as any).getRecords ? (pgHbaConf as any).getRecords() : [];
      rows = records.map((r: HbaRecord, i: number) => hbaRecordToRow(r, i + 1));
    } catch {
      rows = [];
    }
  } else {
    // Default rules if no PgHbaConf provided
    const defaultRules: HbaRecord[] = [
      { type: 'local', database: 'all', user: 'all', authMethod: 'trust', address: null },
      { type: 'host', database: 'all', user: 'all', address: '127.0.0.1/32', authMethod: 'trust' },
      { type: 'host', database: 'all', user: 'all', address: '::1/128', authMethod: 'trust' },
    ];
    rows = defaultRules.map((r, i) => hbaRecordToRow(r, i + 1));
  }

  if (rows.length === 0) {
    rows.push(`SELECT
  1::int4 AS line_number,
  'local'::text AS type,
  'all'::text AS database,
  'all'::text AS user_name,
  NULL::text AS address,
  NULL::text AS netmask,
  'trust'::text AS auth_method,
  NULL::text AS options,
  NULL::text AS error`);
  }

  return sql.replace(
    /\bpg_hba_file_rules\b/gi,
    `(${rows.join('\nUNION ALL\n')}) AS pg_hba_file_rules`
  );
}

// ════════════════════════════════════════════════
//  10. pg_timezone_names
// ════════════════════════════════════════════════

const PG_TIMEZONE_NAMES_RE = /\bpg_timezone_names\b/i;

export function detectPgTimezoneNames(sql: string): boolean {
  return PG_TIMEZONE_NAMES_RE.test(sql);
}

/**
 * Get timezone abbreviation for a given timezone at the current date.
 */
function getTzAbbrev(tzName: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzName,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    // formatToParts always emits a timeZoneName part for a valid zone, so the
    // 'UTC' fallback is upstream defensive code (the try/catch already covers
    // the throw path).
    /* v8 ignore next */
    return tzPart?.value || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Get UTC offset string like '+08:00' for a timezone.
 */
function getTzOffset(tzName: string): string {
  try {
    const now = new Date();
    const utcDate = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(now.toLocaleString('en-US', { timeZone: tzName }));
    const diffMs = tzDate.getTime() - utcDate.getTime();
    const hours = Math.floor(Math.abs(diffMs) / 3600000);
    const minutes = Math.floor((Math.abs(diffMs) % 3600000) / 60000);
    const sign = diffMs >= 0 ? '+' : '-';
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  } catch {
    return '+00:00';
  }
}

/**
 * Check if a timezone is currently in DST.
 */
function isDst(tzName: string): boolean {
  try {
    const jan = new Date(Date.UTC(2026, 0, 1));
    const jul = new Date(Date.UTC(2026, 6, 1));
    const janOffset = jan.toLocaleString('en-US', { timeZone: tzName, timeZoneName: 'short' });
    const julOffset = jul.toLocaleString('en-US', { timeZone: tzName, timeZoneName: 'short' });
    return janOffset !== julOffset;
  } catch {
    return false;
  }
}

export function rewritePgTimezoneNames(sql: string): string {
  let tzNames: string[] = [];
  try {
    // supportedValuesOf('timeZone') returns a non-empty list on all modern
    // runtimes; the [] fallback is defensive only.
    /* v8 ignore next */
    tzNames = (Intl as any).supportedValuesOf('timeZone') || [];
  } catch {
    tzNames = ['UTC'];
  }

  // Only include a representative subset to avoid massive SQL strings
  // Include all major zones (one per region) for completeness
  // The <=50 limb is unreachable on modern runtimes which expose 400+ zones.
  /* v8 ignore next */
  const sampledZones = tzNames.length <= 50
    ? tzNames
    : tzNames.filter(tz => {
        // Include all major timezones (not all sub-regions)
        const parts = tz.split('/');
        return parts.length <= 2 || parts[0] === 'Etc';
      });

  const parts = sampledZones.map(tz => {
    const abbrev = escapeSql(getTzAbbrev(tz));
    const offset = getTzOffset(tz);
    const dst = isDst(tz);
    return `SELECT '${escapeSql(tz)}'::text AS name, '${abbrev}'::text AS abbrev, '${offset}'::interval AS utc_offset, ${dst}::bool AS is_dst`;
  });

  // Fallback if empty (unreachable: sampledZones is non-empty whenever
  // supportedValuesOf returns a list).
  /* v8 ignore next */
  if (parts.length === 0) {
    return sql.replace(
      /\bpg_timezone_names\b/gi,
      `(SELECT 'UTC'::text AS name, 'UTC'::text AS abbrev, '+00:00'::interval AS utc_offset, false::bool AS is_dst) AS pg_timezone_names`
    );
  }

  return sql.replace(
    /\bpg_timezone_names\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_timezone_names`
  );
}

// ════════════════════════════════════════════════
//  11. pg_available_extension_versions
// ════════════════════════════════════════════════

const PG_AVAILABLE_EXTENSION_VERSIONS_RE = /\bpg_available_extension_versions\b/i;

export function detectPgAvailableExtensionVersions(sql: string): boolean {
  return PG_AVAILABLE_EXTENSION_VERSIONS_RE.test(sql);
}

export function rewritePgAvailableExtensionVersions(sql: string): string {
  // Known extensions with version info
  const extensions: Array<{
    name: string;
    version: string;
    superuser: boolean;
    relocatable: boolean;
    schema: string;
    requires: string[];
    comment: string;
  }> = [
    { name: 'citext', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'data type for case-insensitive character strings' },
    { name: 'hstore', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'data type for storing sets of (key, value) pairs' },
    { name: 'pgcrypto', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'cryptographic functions' },
    { name: 'fuzzystrmatch', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'determine similarities and distance between strings' },
    { name: 'pg_trgm', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'text similarity measurement and index searching based on trigrams' },
    { name: 'uuid-ossp', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'generate universally unique identifiers (UUIDs)' },
    { name: 'intarray', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'functions, operators, and index support for 1-D arrays of integers' },
    { name: 'ltree', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'data type for hierarchical tree-like structures' },
    { name: 'btree_gin', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'support for B-tree indexable data types in GIN' },
    { name: 'btree_gist', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'support for B-tree indexable data types in GiST' },
    { name: 'earthdistance', version: '1.0', superuser: false, relocatable: true, schema: 'public', requires: ['cube'], comment: 'calculate great-circle distances on the surface of the Earth' },
    { name: 'postgis', version: '3.0', superuser: false, relocatable: true, schema: 'public', requires: [], comment: 'PostGIS geometry and geography spatial types and functions' },
    { name: 'plpgsql', version: '1.0', superuser: false, relocatable: true, schema: 'pg_catalog', requires: [], comment: 'PL/pgSQL procedural language' },
  ];

  // Determine installed status from installedExtensions map
  const parts = extensions.map(e => {
    const installed = installedExtensions.has(e.name) ? `'${escapeSql(installedExtensions.get(e.name)!)}'::text` : 'NULL::text';
    const requiresArr = e.requires.length > 0
      ? `ARRAY[${e.requires.map(r => `'${escapeSql(r)}'`).join(', ')}]`
      : 'ARRAY[]::text[]';
    return `SELECT
  '${escapeSql(e.name)}'::name AS name,
  '${escapeSql(e.version)}'::text AS version,
  ${installed} AS installed,
  ${e.superuser}::bool AS superuser,
  ${e.relocatable}::bool AS relocatable,
  '${escapeSql(e.schema)}'::name AS schema,
  ${requiresArr}::text[] AS requires,
  '${escapeSql(e.comment)}'::text AS comment`;
  });

  return sql.replace(
    /\bpg_available_extension_versions\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS pg_available_extension_versions`
  );
}

// ════════════════════════════════════════════════
//  Combined pipeline entry point
// ════════════════════════════════════════════════

/**
 * Master rewrite function for all 11 system views.
 * Returns the rewritten SQL or the original if no view was detected.
 *
 * Order is important: pg_stat_activity first (most common query),
 * then others alphabetically.
 */
export function pgSystemViewsRewrite(sql: string): { sql: string; rewritten: boolean } {
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    return { sql, rewritten: false };
  }

  // pg_stat_activity — most common, check first
  if (detectPgStatActivity(sql)) {
    logger.debug('pg_system_views: detected pg_stat_activity');
    return { sql: rewritePgStatActivity(sql), rewritten: true };
  }

  // pg_available_extension_versions
  if (detectPgAvailableExtensionVersions(sql)) {
    logger.debug('pg_system_views: detected pg_available_extension_versions');
    return { sql: rewritePgAvailableExtensionVersions(sql), rewritten: true };
  }

  // pg_config
  if (detectPgConfig(sql)) {
    logger.debug('pg_system_views: detected pg_config');
    return { sql: rewritePgConfig(sql), rewritten: true };
  }

  // pg_file_settings
  if (detectPgFileSettings(sql)) {
    logger.debug('pg_system_views: detected pg_file_settings');
    return { sql: rewritePgFileSettings(sql), rewritten: true };
  }

  // pg_group
  if (detectPgGroup(sql)) {
    logger.debug('pg_system_views: detected pg_group');
    return { sql: rewritePgGroup(sql), rewritten: true };
  }

  // pg_hba_file_rules
  if (detectPgHbaFileRules(sql)) {
    logger.debug('pg_system_views: detected pg_hba_file_rules');
    return { sql: rewritePgHbaFileRules(sql), rewritten: true };
  }

  // pg_stat_ssl
  if (detectPgStatSsl(sql)) {
    logger.debug('pg_system_views: detected pg_stat_ssl');
    return { sql: rewritePgStatSsl(sql), rewritten: true };
  }

  // pg_stat_subscription
  if (detectPgStatSubscription(sql)) {
    logger.debug('pg_system_views: detected pg_stat_subscription');
    return { sql: rewritePgStatSubscription(sql), rewritten: true };
  }

  // pg_stat_sys_tables
  if (detectPgStatSysTables(sql)) {
    logger.debug('pg_system_views: detected pg_stat_sys_tables');
    return { sql: rewritePgStatSysTables(sql), rewritten: true };
  }

  // pg_timezone_names
  if (detectPgTimezoneNames(sql)) {
    logger.debug('pg_system_views: detected pg_timezone_names');
    return { sql: rewritePgTimezoneNames(sql), rewritten: true };
  }

  // pg_user
  if (detectPgUser(sql)) {
    logger.debug('pg_system_views: detected pg_user');
    return { sql: rewritePgUser(sql), rewritten: true };
  }

  // ── information_schema views ──

  // information_schema.triggers
  if (detectInfoSchemaTriggers(sql)) {
    logger.debug('pg_system_views: detected information_schema.triggers');
    return { sql: rewriteInfoSchemaTriggers(sql), rewritten: true };
  }

  // information_schema.domains
  if (detectInfoSchemaDomains(sql)) {
    logger.debug('pg_system_views: detected information_schema.domains');
    return { sql: rewriteInfoSchemaDomains(sql), rewritten: true };
  }

  // information_schema.usage_privileges
  if (detectInfoSchemaUsagePrivileges(sql)) {
    logger.debug('pg_system_views: detected information_schema.usage_privileges');
    return { sql: rewriteInfoSchemaUsagePrivileges(sql), rewritten: true };
  }

  // information_schema.enabled_roles
  if (detectInfoSchemaEnabledRoles(sql)) {
    logger.debug('pg_system_views: detected information_schema.enabled_roles');
    return { sql: rewriteInfoSchemaEnabledRoles(sql), rewritten: true };
  }

  return { sql, rewritten: false };
}

// ════════════════════════════════════════════════
//  12. information_schema.triggers
// ════════════════════════════════════════════════

const INFO_SCHEMA_TRIGGERS_RE = /\binformation_schema\.triggers\b/i;

export function detectInfoSchemaTriggers(sql: string): boolean {
  return INFO_SCHEMA_TRIGGERS_RE.test(sql);
}

export function rewriteInfoSchemaTriggers(sql: string): string {
  // No triggers registered in sqlvec — return empty set with correct schema
  const emptyValues = `SELECT
  'postgres'::information_schema.sql_identifier AS trigger_catalog,
  ''::information_schema.sql_identifier AS trigger_schema,
  ''::information_schema.sql_identifier AS trigger_name,
  'INSERT'::information_schema.character_data AS event_manipulation,
  'postgres'::information_schema.sql_identifier AS event_object_catalog,
  ''::information_schema.sql_identifier AS event_object_schema,
  ''::information_schema.sql_identifier AS event_object_table,
  0::information_schema.cardinal_number AS action_order,
  NULL::information_schema.character_data AS action_condition,
  ''::information_schema.character_data AS action_statement,
  'ROW'::information_schema.character_data AS action_orientation,
  'BEFORE'::information_schema.character_data AS action_timing,
  NULL::information_schema.sql_identifier AS action_reference_old_table,
  NULL::information_schema.sql_identifier AS action_reference_new_table,
  'OLD'::information_schema.character_data AS action_reference_old_row,
  'NEW'::information_schema.character_data AS action_reference_new_row,
  NULL::information_schema.time_stamp AS created
WHERE false`;

  return sql.replace(
    /\binformation_schema\.triggers\b/gi,
    `(${emptyValues}) AS triggers`
  );
}

// ════════════════════════════════════════════════
//  13. information_schema.domains
// ════════════════════════════════════════════════

const INFO_SCHEMA_DOMAINS_RE = /\binformation_schema\.domains\b/i;

export function detectInfoSchemaDomains(sql: string): boolean {
  return INFO_SCHEMA_DOMAINS_RE.test(sql);
}

export function rewriteInfoSchemaDomains(sql: string): string {
  // No domains created — return empty set with correct columns
  const emptyValues = `SELECT
  'postgres'::information_schema.sql_identifier AS domain_catalog,
  ''::information_schema.sql_identifier AS domain_schema,
  ''::information_schema.sql_identifier AS domain_name,
  ''::information_schema.character_data AS data_type,
  NULL::information_schema.cardinal_number AS character_maximum_length,
  NULL::information_schema.cardinal_number AS character_octet_length,
  NULL::information_schema.sql_identifier AS character_set_catalog,
  NULL::information_schema.sql_identifier AS character_set_schema,
  NULL::information_schema.sql_identifier AS character_set_name,
  NULL::information_schema.sql_identifier AS collation_catalog,
  NULL::information_schema.sql_identifier AS collation_schema,
  NULL::information_schema.sql_identifier AS collation_name,
  NULL::information_schema.cardinal_number AS numeric_precision,
  NULL::information_schema.cardinal_number AS numeric_precision_radix,
  NULL::information_schema.cardinal_number AS numeric_scale,
  NULL::information_schema.cardinal_number AS datetime_precision,
  NULL::information_schema.character_data AS interval_type,
  NULL::information_schema.cardinal_number AS interval_precision,
  NULL::information_schema.character_data AS domain_default,
  'postgres'::information_schema.sql_identifier AS udt_catalog,
  'pg_catalog'::information_schema.sql_identifier AS udt_schema,
  ''::information_schema.sql_identifier AS udt_name,
  NULL::information_schema.sql_identifier AS scope_catalog,
  NULL::information_schema.sql_identifier AS scope_schema,
  NULL::information_schema.sql_identifier AS scope_name,
  NULL::information_schema.cardinal_number AS maximum_cardinality,
  ''::information_schema.character_data AS dtd_identifier
WHERE false`;

  return sql.replace(
    /\binformation_schema\.domains\b/gi,
    `(${emptyValues}) AS domains`
  );
}

// ════════════════════════════════════════════════
//  14. information_schema.usage_privileges
// ════════════════════════════════════════════════

const INFO_SCHEMA_USAGE_PRIVILEGES_RE = /\binformation_schema\.usage_privileges\b/i;

export function detectInfoSchemaUsagePrivileges(sql: string): boolean {
  return INFO_SCHEMA_USAGE_PRIVILEGES_RE.test(sql);
}

export function rewriteInfoSchemaUsagePrivileges(sql: string): string {
  // Return USAGE privilege rows for each schema
  const schemas = [
    { schemaName: 'pg_catalog', objectType: 'SCHEMA' },
    { schemaName: 'public', objectType: 'SCHEMA' },
    { schemaName: 'information_schema', objectType: 'SCHEMA' },
  ];

  const parts = schemas.map(s => {
    return `SELECT
  'postgres'::information_schema.sql_identifier AS grantor,
  'postgres'::information_schema.sql_identifier AS grantee,
  'postgres'::information_schema.sql_identifier AS object_catalog,
  '${escapeSql(s.schemaName)}'::information_schema.sql_identifier AS object_schema,
  '${escapeSql(s.schemaName)}'::information_schema.sql_identifier AS object_name,
  '${s.objectType}'::information_schema.character_data AS object_type,
  'USAGE'::information_schema.character_data AS privilege_type,
  'YES'::information_schema.yes_or_no AS is_grantable`;
  });

  return sql.replace(
    /\binformation_schema\.usage_privileges\b/gi,
    `(${parts.join('\nUNION ALL\n')}) AS usage_privileges`
  );
}

// ════════════════════════════════════════════════
//  15. information_schema.enabled_roles
// ════════════════════════════════════════════════

const INFO_SCHEMA_ENABLED_ROLES_RE = /\binformation_schema\.enabled_roles\b/i;

export function detectInfoSchemaEnabledRoles(sql: string): boolean {
  return INFO_SCHEMA_ENABLED_ROLES_RE.test(sql);
}

export function rewriteInfoSchemaEnabledRoles(sql: string): string {
  // Return current user's role name(s)
  // Default: postgres role is enabled
  return sql.replace(
    /\binformation_schema\.enabled_roles\b/gi,
    `(SELECT 'postgres'::information_schema.sql_identifier AS role_name) AS enabled_roles`
  );
}

// ════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════

/**
 * Escape single quotes in SQL string values.
 */
function escapeSql(val: string): string {
  // Every call site passes a string literal; the coercion limb is defensive.
  /* v8 ignore next */
  if (typeof val !== 'string') return String(val);
  return val.replace(/'/g, "''");
}

/**
 * Detect if the SQL has a table alias for a given table name.
 * Simple heuristic: if the pattern "table_name alias" or "table_name as alias" appears.
 */
function detectAlias(sql: string, tableName: string): string | null {
  const escaped = tableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aliasRe = new RegExp(`\\b${escaped}\\s+(?:AS\\s+)?(\\w+)`, 'i');
  const match = sql.match(aliasRe);
  return match ? match[1] : null;
}
