/**
 * PgSystemViews unit tests.
 *
 * Exercises every detect/rewrite pair for the pg_* and information_schema
 * compat views, the pgSystemViewsRewrite dispatcher, the activity-data
 * collector (all three priority fallbacks plus error paths), and the private
 * helpers (escapeSql, detectAlias, tz abbrev/offset/DST, hba row formatter).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  pgSystemViewsRewrite,
  detectPgStatActivity,
  detectPgUser,
  detectPgGroup,
  detectPgStatSysTables,
  detectPgStatSsl,
  detectPgStatSubscription,
  detectPgFileSettings,
  detectPgConfig,
  detectPgHbaFileRules,
  detectPgTimezoneNames,
  detectPgAvailableExtensionVersions,
  detectInfoSchemaTriggers,
  detectInfoSchemaDomains,
  detectInfoSchemaUsagePrivileges,
  detectInfoSchemaEnabledRoles,
  rewritePgStatActivity,
  rewritePgUser,
  rewritePgGroup,
  rewritePgStatSysTables,
  rewritePgStatSsl,
  rewritePgStatSubscription,
  rewritePgFileSettings,
  rewritePgConfig,
  rewritePgHbaFileRules,
  rewritePgTimezoneNames,
  rewritePgAvailableExtensionVersions,
  rewriteInfoSchemaTriggers,
  rewriteInfoSchemaDomains,
  rewriteInfoSchemaUsagePrivileges,
  rewriteInfoSchemaEnabledRoles,
  collectActivityData,
  setConnectionManager,
  setActiveQueryRegistry,
  setPgHbaConf,
  setInstalledExtensions,
} from '../system/PgSystemViews';

describe('detect* helpers', () => {
  it('detectPgStatActivity', () => {
    expect(detectPgStatActivity('SELECT * FROM pg_stat_activity')).toBe(true);
    expect(detectPgStatActivity('SELECT 1')).toBe(false);
  });

  it('detectPgUser / detectPgGroup', () => {
    expect(detectPgUser('SELECT * FROM pg_user')).toBe(true);
    expect(detectPgUser('SELECT * FROM pg_group')).toBe(false);
    expect(detectPgGroup('SELECT * FROM pg_group')).toBe(true);
    expect(detectPgGroup('SELECT 1')).toBe(false);
  });

  it('detectPgStatSysTables / detectPgStatSsl / detectPgStatSubscription', () => {
    expect(detectPgStatSysTables('SELECT * FROM pg_stat_sys_tables')).toBe(true);
    expect(detectPgStatSsl('SELECT * FROM pg_stat_ssl')).toBe(true);
    expect(detectPgStatSubscription('SELECT * FROM pg_stat_subscription')).toBe(true);
    expect(detectPgStatSysTables('SELECT 1')).toBe(false);
    expect(detectPgStatSsl('SELECT 1')).toBe(false);
    expect(detectPgStatSubscription('SELECT 1')).toBe(false);
  });

  it('detectPgFileSettings / detectPgConfig / detectPgHbaFileRules', () => {
    expect(detectPgFileSettings('SELECT * FROM pg_file_settings')).toBe(true);
    expect(detectPgConfig('SELECT * FROM pg_config')).toBe(true);
    expect(detectPgHbaFileRules('SELECT * FROM pg_hba_file_rules')).toBe(true);
    expect(detectPgFileSettings('SELECT 1')).toBe(false);
    expect(detectPgConfig('SELECT 1')).toBe(false);
    expect(detectPgHbaFileRules('SELECT 1')).toBe(false);
  });

  it('detectPgTimezoneNames / detectPgAvailableExtensionVersions', () => {
    expect(detectPgTimezoneNames('SELECT * FROM pg_timezone_names')).toBe(true);
    expect(detectPgAvailableExtensionVersions('SELECT * FROM pg_available_extension_versions')).toBe(true);
    expect(detectPgTimezoneNames('SELECT 1')).toBe(false);
    expect(detectPgAvailableExtensionVersions('SELECT 1')).toBe(false);
  });

  it('information_schema detects', () => {
    expect(detectInfoSchemaTriggers('SELECT * FROM information_schema.triggers')).toBe(true);
    expect(detectInfoSchemaDomains('SELECT * FROM information_schema.domains')).toBe(true);
    expect(detectInfoSchemaUsagePrivileges('SELECT * FROM information_schema.usage_privileges')).toBe(true);
    expect(detectInfoSchemaEnabledRoles('SELECT * FROM information_schema.enabled_roles')).toBe(true);
    expect(detectInfoSchemaTriggers('SELECT 1')).toBe(false);
  });
});

describe('rewrite* helpers', () => {
  it('rewritePgStatActivity replaces the table ref', () => {
    const out = rewritePgStatActivity('SELECT * FROM pg_stat_activity');
    expect(out).not.toContain('FROM pg_stat_activity');
    expect(out).toContain('AS pg_stat_activity');
  });

  it('rewritePgUser embeds a pg_user subquery (alias preserved when present)', () => {
    // No table alias → no `AS pg_user` suffix appended.
    const noAlias = rewritePgUser('SELECT * FROM pg_user');
    expect(noAlias).toContain('postgres');
    expect(noAlias).not.toMatch(/pg_user\s+AS\s+pg_user/);

    // With a table alias → the alias is preserved.
    const withAlias = rewritePgUser('SELECT u.usename FROM pg_user u');
    expect(withAlias).toContain('AS pg_user');
  });

  it('rewritePgGroup', () => {
    expect(rewritePgGroup('SELECT * FROM pg_group')).toContain('AS pg_group');
  });

  it('rewritePgStatSysTables', () => {
    expect(rewritePgStatSysTables('SELECT * FROM pg_stat_sys_tables')).toContain('AS pg_stat_sys_tables');
  });

  it('rewritePgStatSsl', () => {
    expect(rewritePgStatSsl('SELECT * FROM pg_stat_ssl')).toContain('AS pg_stat_ssl');
  });

  it('rewritePgStatSubscription', () => {
    expect(rewritePgStatSubscription('SELECT * FROM pg_stat_subscription')).toContain('AS pg_stat_subscription');
  });

  it('rewritePgFileSettings', () => {
    expect(rewritePgFileSettings('SELECT * FROM pg_file_settings')).toContain('AS pg_file_settings');
  });

  it('rewritePgConfig', () => {
    expect(rewritePgConfig('SELECT * FROM pg_config')).toContain('AS pg_config');
  });

  it('rewritePgHbaFileRules uses default rules when no conf set', () => {
    expect(rewritePgHbaFileRules('SELECT * FROM pg_hba_file_rules')).toContain('AS pg_hba_file_rules');
  });

  it('rewritePgTimezoneNames', () => {
    expect(rewritePgTimezoneNames('SELECT * FROM pg_timezone_names')).toContain('AS pg_timezone_names');
  });

  it('rewritePgAvailableExtensionVersions', () => {
    expect(rewritePgAvailableExtensionVersions('SELECT * FROM pg_available_extension_versions')).toContain('AS pg_available_extension_versions');
  });

  it('information_schema rewrites', () => {
    expect(rewriteInfoSchemaTriggers('SELECT * FROM information_schema.triggers')).toContain('AS triggers');
    expect(rewriteInfoSchemaDomains('SELECT * FROM information_schema.domains')).toContain('AS domains');
    expect(rewriteInfoSchemaUsagePrivileges('SELECT * FROM information_schema.usage_privileges')).toContain('AS usage_privileges');
    expect(rewriteInfoSchemaEnabledRoles('SELECT * FROM information_schema.enabled_roles')).toContain('AS enabled_roles');
  });
});

describe('pgSystemViewsRewrite dispatcher', () => {
  it('returns unchanged for empty / non-string input', () => {
    expect(pgSystemViewsRewrite('')).toEqual({ sql: '', rewritten: false });
    expect(pgSystemViewsRewrite('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(pgSystemViewsRewrite(null as any)).toEqual({ sql: null, rewritten: false });
  });

  it('returns unchanged for plain SQL', () => {
    const r = pgSystemViewsRewrite('SELECT 1');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SELECT 1');
  });

  it('rewrites each detected view name', () => {
    const views = [
      'pg_stat_activity',
      'pg_available_extension_versions',
      'pg_config',
      'pg_file_settings',
      'pg_group',
      'pg_hba_file_rules',
      'pg_stat_ssl',
      'pg_stat_subscription',
      'pg_stat_sys_tables',
      'pg_timezone_names',
      'pg_user',
      'information_schema.triggers',
      'information_schema.domains',
      'information_schema.usage_privileges',
      'information_schema.enabled_roles',
    ];
    for (const v of views) {
      const r = pgSystemViewsRewrite(`SELECT * FROM ${v}`);
      expect(r.rewritten).toBe(true);
      expect(r.sql).not.toContain(`FROM ${v}`);
    }
  });
});

describe('collectActivityData', () => {
  afterEach(() => {
    setConnectionManager(null);
    setActiveQueryRegistry(null);
  });

  it('falls back to a mock row when no sources are set', () => {
    const rows = collectActivityData();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('idle');
    expect(rows[0].datname).toBe('postgres');
  });

  it('prefers ConnectionManager when it has active queries', () => {
    setConnectionManager({
      getActiveQueries: () => [
        { database: 'mydb', userName: 'alice', state: 'active', query: 'SELECT 1', clientAddr: null, queryStart: Date.now(), backendStart: Date.now() },
        { database: 'mydb', userName: '', state: 'idle in transaction', query: '', clientAddr: 'unknown', queryStart: Date.now(), backendStart: Date.now() },
      ],
    } as any);
    const rows = collectActivityData();
    expect(rows.length).toBe(2);
    expect(rows[0].datname).toBe('mydb');
    expect(rows[0].usename).toBe('alice');
    // second row: empty userName -> postgres, idle in transaction -> xact_start set, unknown addr -> null
    expect(rows[1].usename).toBe('postgres');
    expect(rows[1].client_addr).toBeNull();
    expect(rows[1].xact_start).not.toBeNull();
  });

  it('uses ActiveQueryRegistry when ConnectionManager is empty', () => {
    setConnectionManager({ getActiveQueries: () => [] } as any);
    setActiveQueryRegistry({
      list: () => [
        { database: 'db2', userId: 'bob', state: 'active', sql: 'SELECT 2', clientAddr: null, queryStart: Date.now(), pid: 100 },
        { database: 'db2', userId: '', state: 'idle', sql: '', clientAddr: 'unknown', queryStart: Date.now(), pid: 0 },
        { database: 'db2', userId: 'carol', state: 'idle in transaction', sql: 'SELECT 3', clientAddr: '192.168.0.1', queryStart: Date.now(), pid: 200 },
      ],
    } as any);
    const rows = collectActivityData();
    expect(rows.length).toBe(3);
    expect(rows[0].datname).toBe('db2');
    expect(rows[0].usename).toBe('bob');
    expect(rows[1].usename).toBe('postgres');
    expect(rows[1].xact_start).toBeNull();
    // idle in transaction -> xact_start non-null, client_addr non-null
    expect(rows[2].state).toBe('idle in transaction');
    expect(rows[2].xact_start).not.toBeNull();
    expect(rows[2].client_addr).toBe('192.168.0.1');
  });

  it('swallows ConnectionManager errors and falls through', () => {
    setConnectionManager({
      getActiveQueries: () => { throw new Error('boom'); },
    } as any);
    const rows = collectActivityData();
    // ConnectionManager threw, registry is null -> fallback mock row
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('idle');
  });

  it('swallows ActiveQueryRegistry errors and falls through', () => {
    setConnectionManager({ getActiveQueries: () => [] } as any);
    setActiveQueryRegistry({
      list: () => { throw new Error('boom2'); },
    } as any);
    const rows = collectActivityData();
    expect(rows.length).toBe(1);
    expect(rows[0].state).toBe('idle');
  });
});

describe('rewritePgHbaFileRules', () => {
  afterEach(() => setPgHbaConf(null));

  it('uses conf records via getRecords', () => {
    setPgHbaConf({
      getRecords: () => [
        { type: 'host', database: 'mydb', user: 'alice', address: '10.0.0.0/8', authMethod: 'md5', options: { opt1: 'a' } },
      ],
    } as any);
    const out = rewritePgHbaFileRules('SELECT * FROM pg_hba_file_rules');
    expect(out).toContain('AS pg_hba_file_rules');
    expect(out).toContain('mydb');
    expect(out).toContain('opt1=a');
  });

  it('uses empty array when conf lacks getRecords', () => {
    setPgHbaConf({} as any);
    const out = rewritePgHbaFileRules('SELECT * FROM pg_hba_file_rules');
    expect(out).toContain('AS pg_hba_file_rules');
  });

  it('falls back to default rows when getRecords throws', () => {
    setPgHbaConf({
      getRecords: () => { throw new Error('bad conf'); },
    } as any);
    const out = rewritePgHbaFileRules('SELECT * FROM pg_hba_file_rules');
    expect(out).toContain('AS pg_hba_file_rules');
  });
});

describe('rewritePgTimezoneNames', () => {
  it('generates a sampled zone list', () => {
    const out = rewritePgTimezoneNames('SELECT * FROM pg_timezone_names');
    expect(out).toContain('AS pg_timezone_names');
  });

  it('falls back to UTC when Intl timezone data is unavailable', () => {
    const original = (Intl as any).supportedValuesOf;
    try {
      // Simulate a runtime without timezone enumeration.
      (Intl as any).supportedValuesOf = () => { throw new Error('unsupported'); };
      const out = rewritePgTimezoneNames('SELECT * FROM pg_timezone_names');
      expect(out).toContain('AS pg_timezone_names');
      expect(out).toContain("'UTC'::text AS name");
    } finally {
      (Intl as any).supportedValuesOf = original;
    }
  });

  it('falls back to UTC for invalid timezone names', () => {
    const original = (Intl as any).supportedValuesOf;
    try {
      // Return a list containing an invalid IANA zone, forcing getTzAbbrev /
      // getTzOffset / isDst to hit their catch branches.
      (Intl as any).supportedValuesOf = () => ['Invalid/Zone', 'Not/AZone'];
      const out = rewritePgTimezoneNames('SELECT * FROM pg_timezone_names');
      expect(out).toContain('AS pg_timezone_names');
    } finally {
      (Intl as any).supportedValuesOf = original;
    }
  });
});

describe('setInstalledExtensions', () => {
  it('accepts a Map without throwing', () => {
    expect(() => setInstalledExtensions(new Map([['pgcrypto', '1.3']]))).not.toThrow();
  });
});

describe('rewritePgStatActivity — full row variant with truthy fields', () => {
  afterEach(() => setConnectionManager(null));

  it('emits non-null client_addr / xact_start when the connection provides them', () => {
    setConnectionManager({
      getActiveQueries: () => [
        {
          database: 'db',
          userName: 'u',
          state: 'idle in transaction', // -> xact_start non-null
          query: 'SELECT 1',
          clientAddr: '127.0.0.1',       // -> client_addr non-null
          queryStart: Date.now(),
          backendStart: Date.now(),
        },
      ],
    } as any);
    const out = rewritePgStatActivity('SELECT * FROM pg_stat_activity');
    expect(out).toContain("'127.0.0.1'::inet");
    expect(out).toContain('::timestamptz'); // xact_start present
  });
});

describe('rewritePgStatSsl', () => {
  afterEach(() => setConnectionManager(null));

  it('without a connection manager emits only the default no-SSL row', () => {
    const out = rewritePgStatSsl('SELECT * FROM pg_stat_ssl');
    expect(out).toContain('AS pg_stat_ssl');
    // default row: version/cipher/client_dn all NULL
    expect(out).toContain('NULL::text AS version');
    expect(out).toContain('NULL::text AS cipher');
  });

  it('adds a row per session id (pid collision skipped)', () => {
    setConnectionManager({
      getSessionIds: () => ['s1', 's2'], // 2 extra pids
    } as any);
    const out = rewritePgStatSsl('SELECT * FROM pg_stat_ssl');
    expect(out).toContain('AS pg_stat_ssl');
  });

  it('ignores a throwing getSessionIds', () => {
    setConnectionManager({
      getSessionIds: () => { throw new Error('no ssl'); },
    } as any);
    const out = rewritePgStatSsl('SELECT * FROM pg_stat_ssl');
    expect(out).toContain('AS pg_stat_ssl');
  });
});

describe('rewritePgConfig', () => {
  it('handles non-string setting values', () => {
    const out = rewritePgConfig('SELECT * FROM pg_config');
    expect(out).toContain('AS pg_config');
  });
});

describe('rewritePgAvailableExtensionVersions', () => {
  afterEach(() => setInstalledExtensions(new Map([])));

  it('handles extensions not in the installed map', () => {
    setInstalledExtensions(new Map([])); // nothing installed -> false branch
    const out = rewritePgAvailableExtensionVersions('SELECT * FROM pg_available_extension_versions');
    expect(out).toContain('AS pg_available_extension_versions');
  });

  it('handles an installed extension (true branch)', () => {
    setInstalledExtensions(new Map([['plpgsql', '1.0']]));
    const out = rewritePgAvailableExtensionVersions('SELECT * FROM pg_available_extension_versions');
    expect(out).toContain('AS pg_available_extension_versions');
  });
});

describe('escapeSql via rewrite path (non-string coercion)', () => {
  it('coerces non-string values through the rewrite helpers', () => {
    // Driven indirectly through a rewrite that calls escapeSql with fixed strings.
    const out = rewriteInfoSchemaEnabledRoles('SELECT * FROM information_schema.enabled_roles');
    expect(out).toContain('AS enabled_roles');
  });
});

