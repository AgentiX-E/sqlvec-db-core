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

/**
 * A single dynamically-registered GUC entry in the in-memory registry.
 *
 * The dynamic registry is layered on top of the static {@link DEFAULT_PG_SETTINGS}
 * snapshot. A value that has been SET at runtime is recorded here so that
 * `current_setting(name)`, `SHOW`, and the read-only/serializable/query-hint shims
 * can observe it.
 */
export interface GucRegistryEntry {
  name: string;
  value: string;
  description?: string;
  vartype?: string;
  unit?: string;
  context?: string;
  default?: string;
}

/**
 * In-memory runtime configuration store.
 *
 * GucSystem serves two roles:
 *
 * 1. A static snapshot of the standard PostgreSQL `pg_settings` catalog rows
 *    (via {@link getPgSettingsView}), so that `pg_settings` catalog queries resolve.
 * 2. A dynamic registry layered on top (SET/RESET/current_setting/query-hint), so
 *    that runtime `SET` statements are observable through `current_setting(name)`,
 *    `SHOW`, and the read-only / serializable / query-hint shims.
 *
 * The dynamic registry is intentionally minimal: it records the last value of any
 * `SET` parameter and exposes it through a small, stable API surface
 * (`set`/`get`/`handleSet`/`handleShow`/`registry`) that several shims consume.
 * `getDefaultInstance()` and `getInstance()` return a shared singleton so that
 * values survive across independent call sites (previously each call constructed a
 * fresh, state-less instance, which silently dropped every runtime setting).
 */
export class GucSystem {
  private static _instance: GucSystem | null = null;

  /**
   * Single source of truth for all runtime GUC state.
   *
   * Every write path (`set`, `handleSet`, `registry.set`) funnels values into this
   * one map, and every read path (`get`, `handleShow`, `registry.get`) reads from
   * it. A previous split into `values` and `registryMap` let `set`/`handleSet`
   * record into one map while `current_setting`/`registry.get` read the other, so
   * a runtime `SET` became invisible to `current_setting(name)` and `SHOW`.
   */
  private readonly registryMap = new Map<string, GucRegistryEntry>();

  static getDefaultInstance(): GucSystem {
    return GucSystem.getInstance();
  }

  static getInstance(): GucSystem {
    if (!GucSystem._instance) {
      GucSystem._instance = new GucSystem();
    }
    return GucSystem._instance;
  }

  /**
   * Record a runtime GUC value, upserting the registry entry and preserving any
   * metadata (description/vartype/unit/context/default) already registered.
   */
  set(k: string, v: string): void {
    const existing = this.registryMap.get(k);
    if (existing) {
      existing.value = v;
    } else {
      this.registryMap.set(k, { name: k, value: v });
    }
  }

  /**
   * Look up a runtime GUC value as a `{ value }` shape, or an empty object when the
   * parameter was never set.
   */
  get(k: string): { value?: string } {
    const entry = this.registryMap.get(k);
    if (entry) return { value: entry.value };
    return {};
  }

  /** Return a shallow snapshot of all runtime-set values. */
  getAll(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, entry] of this.registryMap) {
      out[k] = entry.value;
    }
    return out;
  }

  /**
   * Set a runtime GUC and report success. Returns `null` when the value was stored
   * (the {@link set} path never fails), preserving the `string | null` contract that
   * callers such as `GucPersistence` / `PgDumpCompatibilityShim` already rely on.
   */
  handleSet(name: string, value: string): string | null {
    this.set(name, value);
    return null;
  }

  /**
   * Read a runtime GUC for `SHOW`. Returns `{ ok: true, value }` when the parameter
   * has a recorded value, otherwise `{ ok: false, value: '' }`.
   */
  handleShow(name: string): { ok: boolean; value: string } {
    const entry = this.registryMap.get(name);
    if (entry && entry.value !== undefined) {
      return { ok: true, value: entry.value };
    }
    return { ok: false, value: '' };
  }

  /**
   * Dynamic registry facade.
   *
   * Several shims (QueryHintShim, PgDumpCompatibilityShim) and the
   * `current_setting` system functions access the registry through a `.registry`
   * property rather than the top-level `set`/`get` methods. This getter exposes a
   * stable object that delegates to the same underlying map, so both access styles
   * observe identical state.
   */
  get registry() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get: (name: string): GucRegistryEntry | undefined => self.registryMap.get(name),
      set: (name: string, value: string): string | null => {
        self.set(name, value);
        return null;
      },
      register: (entry: GucRegistryEntry): void => {
        const existing = self.registryMap.get(entry.name);
        self.registryMap.set(entry.name, existing ? { ...existing, ...entry } : { ...entry });
      },
      resetAllToDefaults: (): void => {
        self.registryMap.clear();
      },
    };
  }

  /**
   * Return the standard pg_settings catalog rows.
   * Replaces the previous undefined-method call that crashed pg_settings.
   */
  getPgSettingsView(): GucSetting[] {
    return DEFAULT_PG_SETTINGS;
  }
}
