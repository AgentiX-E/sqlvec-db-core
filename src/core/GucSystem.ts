export interface GucSetting {
  name: string;
  setting: string;
  unit: string | null;
  category: string;
  short_desc: string;
  extra_desc: string | null;
  context: string;
  vartype: string;
  source: string;
  min_val: string | null;
  max_val: string | null;
  enumvals: string[] | null;
  boot_val: string;
  reset_val: string;
  sourcefile: string | null;
  sourceline: number | null;
  pending_restart: boolean;
}

/**
 * Default pg_settings catalog snapshot.
 *
 * GucSystem is intentionally minimal for now: it exposes a static view of the
 * standard PostgreSQL settings so that `pg_settings` catalog queries succeed.
 * The dynamic registry (SET/RESET/current_setting) is layered on separately.
 */
const DEFAULT_PG_SETTINGS: GucSetting[] = [
  {
    name: 'max_connections', setting: '100', unit: null,
    category: 'Connections and Authentication', short_desc: 'Sets the maximum number of concurrent connections.',
    extra_desc: null, context: 'postmaster', vartype: 'integer', source: 'default',
    min_val: '1', max_val: '262143', enumvals: null, boot_val: '100', reset_val: '100',
    sourcefile: null, sourceline: null, pending_restart: false,
  },
  {
    name: 'shared_buffers', setting: '16384', unit: '8kB',
    category: 'Resource Usage', short_desc: 'Sets the number of shared memory buffers.',
    extra_desc: null, context: 'postmaster', vartype: 'integer', source: 'default',
    min_val: '16', max_val: '1073741823', enumvals: null, boot_val: '1024', reset_val: '16384',
    sourcefile: null, sourceline: null, pending_restart: false,
  },
  {
    name: 'port', setting: '5432', unit: null,
    category: 'Connections and Authentication', short_desc: 'Sets the TCP port the server listens on.',
    extra_desc: null, context: 'postmaster', vartype: 'integer', source: 'default',
    min_val: '1', max_val: '65535', enumvals: null, boot_val: '5432', reset_val: '5432',
    sourcefile: null, sourceline: null, pending_restart: false,
  },
  {
    name: 'listen_addresses', setting: '*', unit: null,
    category: 'Connections and Authentication', short_desc: 'Sets the host name(s) to listen to.',
    extra_desc: null, context: 'postmaster', vartype: 'string', source: 'default',
    min_val: null, max_val: null, enumvals: null, boot_val: 'localhost', reset_val: '*',
    sourcefile: null, sourceline: null, pending_restart: false,
  },
  {
    name: 'timezone', setting: 'Etc/UTC', unit: null,
    category: 'Client Connection Defaults', short_desc: 'Sets the time zone for displaying and interpreting time stamps.',
    extra_desc: null, context: 'user', vartype: 'string', source: 'default',
    min_val: null, max_val: null, enumvals: null, boot_val: 'GMT', reset_val: 'Etc/UTC',
    sourcefile: null, sourceline: null, pending_restart: false,
  },
  {
    name: 'default_transaction_isolation', setting: 'read committed', unit: null,
    category: 'Client Connection Defaults', short_desc: 'Sets the transaction isolation level.',
    extra_desc: null, context: 'user', vartype: 'enum', source: 'default',
    min_val: null, max_val: null, enumvals: ['read committed', 'repeatable read', 'serializable'],
    boot_val: 'read committed', reset_val: 'read committed', sourcefile: null,
    sourceline: null, pending_restart: false,
  },
  {
    name: 'search_path', setting: '"$user", public', unit: null,
    category: 'Client Connection Defaults', short_desc: 'Sets the schema search order for names.',
    extra_desc: null, context: 'user', vartype: 'string', source: 'default',
    min_val: null, max_val: null, enumvals: null, boot_val: '"$user", public',
    reset_val: '"$user", public', sourcefile: null, sourceline: null, pending_restart: false,
  },
];

export class GucSystem {
  static getDefaultInstance() { return new GucSystem(); }
  static getInstance() { return new GucSystem(); }
  get(_k: string) { return {}; }
  set(_k: string, _v: string) {}
  getAll() { return {}; }

  /**
   * Return the standard pg_settings catalog rows.
   * Replaces the previous undefined-method call that crashed pg_settings.
   */
  getPgSettingsView(): GucSetting[] {
    return DEFAULT_PG_SETTINGS;
  }
}
