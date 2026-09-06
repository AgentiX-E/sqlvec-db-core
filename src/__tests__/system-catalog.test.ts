/**
 * SystemCatalog unit tests.
 *
 * Exercises the information_schema view registry: static view definitions
 * (tables/columns/schemata/routines/views/sequences) and the dynamic
 * constraint/privilege/parameter generators, which are driven by a mocked
 * SQLite-style `DatabaseRef` (prepare().all()/.get()).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SystemCatalog } from '../system/SystemCatalog';
import { setCurrentDbRef, getCurrentDbRef, type DatabaseRef } from '../system/SystemFunctions';

/** Minimal SQLite-style result set row. */
type Row = Record<string, any>;

/** Build a mock SQLite DatabaseRef backed by simple tables. */
function makeDb(): DatabaseRef & { resetTables: () => void } {
  const state: {
    tables: Row[];           // sqlite_master tables
    indexes: Row[];          // sqlite_master indexes
    tableInfo: Record<string, Row[]>;      // PRAGMA table_info
    fkList: Record<string, Row[]>;         // PRAGMA foreign_key_list
    indexInfo: Record<string, Row[]>;      // PRAGMA index_info
  } = {
    tables: [],
    indexes: [],
    tableInfo: {},
    fkList: {},
    indexInfo: {},
  };

  const prepare = (sql: string) => {
    const s = sql.toUpperCase();
    let match: RegExpMatchArray | null;

    if (s.includes('SELECT NAME, SQL FROM SQLITE_MASTER')) {
      return {
        all: (..._a: any[]) => state.tables,
        get: () => state.tables[0],
      };
    }
    if (s.includes("SELECT NAME, SQL FROM SQLITE_MASTER WHERE TYPE='INDEX'") && s.includes('TBL_NAME=?')) {
      const tbl = (match = sql.match(/TBL_NAME=\?\s*AND/i)) ? null : null;
      // extract the bound table arg at call time
      return {
        all: (...args: any[]) => state.indexes.filter(i => i.tbl_name === args[0]),
        get: () => state.indexes[0],
      };
    }
    if (s.includes("TYPE='INDEX' AND TBL_NAME=? AND SQL IS NOT NULL")) {
      return {
        all: (...args: any[]) => state.indexes.filter(i => i.tbl_name === args[0] && i.sql != null),
        get: () => state.indexes[0],
      };
    }
    if (s.includes("TYPE='INDEX' AND TBL_NAME=? AND SQL IS NOT NULL AND SQL LIKE '%UNIQUE%'")) {
      return {
        all: (...args: any[]) => state.indexes.filter(
          i => i.tbl_name === args[0] && i.sql != null && String(i.sql).toUpperCase().includes('UNIQUE'),
        ),
        get: () => state.indexes[0],
      };
    }
    if (s.includes('PRAGMA TABLE_INFO')) {
      const tbl = (sql.match(/table_info\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return {
        all: () => state.tableInfo[tbl] ?? [],
        get: () => (state.tableInfo[tbl] ?? [])[0],
      };
    }
    if (s.includes('PRAGMA FOREIGN_KEY_LIST')) {
      const tbl = (sql.match(/foreign_key_list\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return {
        all: () => state.fkList[tbl] ?? [],
        get: () => (state.fkList[tbl] ?? [])[0],
      };
    }
    if (s.includes('PRAGMA INDEX_INFO')) {
      const idx = (sql.match(/index_info\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return {
        all: () => state.indexInfo[idx] ?? [],
        get: () => (state.indexInfo[idx] ?? [])[0],
      };
    }
    return { all: () => [], get: () => undefined };
  };

  return {
    prepare,
    exec: () => undefined,
    resetTables() {
      state.tables = [];
      state.indexes = [];
      state.tableInfo = {};
      state.fkList = {};
      state.indexInfo = {};
    },
  };
}

describe('SystemCatalog — static view registry', () => {
  it('init() is idempotent and registers the core views', () => {
    SystemCatalog.init();
    SystemCatalog.init(); // second call is a no-op
    const names = SystemCatalog.getViewNames();
    expect(names).toContain('information_schema.tables');
    expect(names).toContain('information_schema.columns');
    expect(names).toContain('information_schema.schemata');
    expect(names).toContain('information_schema.routines');
  });

  it('isSystemView matches qualified names', () => {
    expect(SystemCatalog.isSystemView('information_schema', 'tables')).toBe(true);
    expect(SystemCatalog.isSystemView('information_schema', 'nope')).toBe(false);
  });

  it('isSystemViewByName matches case-insensitively', () => {
    expect(SystemCatalog.isSystemViewByName('TABLES')).toBe(true);
    expect(SystemCatalog.isSystemViewByName('TABLE_CONSTRAINTS')).toBe(true);
    expect(SystemCatalog.isSystemViewByName('not_a_view')).toBe(false);
  });

  it('getView / getViewByFullName return definitions', () => {
    const v = SystemCatalog.getView('information_schema', 'tables');
    expect(v?.name).toBe('tables');
    expect(v?.type).toBe('SYSTEM VIEW');
    expect(v?.columns.length).toBeGreaterThan(0);

    expect(SystemCatalog.getViewByFullName('INFORMATION_SCHEMA.TABLES')?.name).toBe('tables');
    expect(SystemCatalog.getViewByFullName('information_schema.missing')).toBeUndefined();
  });
});

describe('SystemCatalog — getViewRows for static views', () => {
  it('tables view lists user + meta + pg_catalog tables', () => {
    const rows = SystemCatalog.getViewRows('information_schema', 'tables');
    expect(rows.length).toBeGreaterThan(0);
    const hasPgClass = rows.some(r => r.table_name === 'pg_class');
    expect(hasPgClass).toBe(true);
    const base = rows.find(r => r.table_type === 'BASE TABLE');
    if (base) expect(base.is_insertable_into).toBe('YES');
  });

  it('views view only includes SYSTEM VIEW entries', () => {
    const rows = SystemCatalog.getViewRows('information_schema', 'views');
    for (const r of rows) {
      expect(r.view_definition).toContain('SELECT');
      expect(r.check_option).toBe('NONE');
      expect(r.is_updatable).toBe('NO');
    }
  });

  it('routines view is regenerated from the function registry', () => {
    const rows = SystemCatalog.getViewRows('information_schema', 'routines');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('routine_name');
    expect(rows[0]).toHaveProperty('specific_name');
  });

  it('schemata view contains the three standard schemas', () => {
    const rows = SystemCatalog.getViewRows('information_schema', 'schemata');
    const names = rows.map(r => r.schema_name);
    expect(names).toEqual(expect.arrayContaining(['public', 'information_schema', 'pg_catalog']));
  });

  it('unknown view returns an empty array', () => {
    expect(SystemCatalog.getViewRows('information_schema', 'does_not_exist')).toEqual([]);
  });
});

describe('SystemCatalog — columns view', () => {
  it('builds column rows for registered views', () => {
    const rows = SystemCatalog.getViewRows('information_schema', 'columns');
    expect(rows.length).toBeGreaterThan(0);
    // tables view column metadata flows through
    expect(rows.some(r => r.column_name === 'table_name')).toBe(true);
  });

  it('addUserTable updates the tables view dynamically', () => {
    SystemCatalog.addUserTable('public', 'users_custom');
    const rows = SystemCatalog.getViewRows('information_schema', 'tables');
    expect(rows.some(r => r.table_name === 'users_custom' && r.table_type === 'BASE TABLE')).toBe(true);
  });

  it('addUserTable is idempotent for an existing table', () => {
    SystemCatalog.addUserTable('public', 'users_custom', 5);
    const before = SystemCatalog.getViewRows('information_schema', 'tables')
      .filter(r => r.table_name === 'users_custom').length;
    SystemCatalog.addUserTable('public', 'users_custom', 9);
    const after = SystemCatalog.getViewRows('information_schema', 'tables')
      .filter(r => r.table_name === 'users_custom').length;
    expect(after).toBe(before); // no duplicate entry created
  });
});

describe('SystemCatalog — dynamic constraint/privilege generators', () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    setCurrentDbRef(db);
  });

  afterEach(() => {
    setCurrentDbRef(null);
  });

  it('returns empty when no DB ref is set', () => {
    setCurrentDbRef(null);
    expect(SystemCatalog.getViewRows('information_schema', 'table_constraints')).toEqual([]);
    expect(SystemCatalog.getViewRows('information_schema', 'key_column_usage')).toEqual([]);
    expect(SystemCatalog.getViewRows('information_schema', 'referential_constraints')).toEqual([]);
    expect(SystemCatalog.getViewRows('information_schema', 'constraint_column_usage')).toEqual([]);
    // table_privileges still lists Meta/system tables even without a live DB.
    const privs = SystemCatalog.getViewRows('information_schema', 'table_privileges');
    expect(privs.length).toBeGreaterThan(0);
  });

  it('generateTableConstraints discovers PK/UNIQUE/FK/CHECK from DDL', () => {
    // Build tables covering both branches of every constraint probe:
    // a fully-constrained table and a bare table (sql present but no
    // UNIQUE/FK/CHECK keywords, plus a CHECK keyword without a match).
    const tables = [
      { name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT UNIQUE, org_id INTEGER REFERENCES orgs(id), age INTEGER CHECK (age > 0))' },
      { name: 'plain', sql: null },
      { name: 'bare', sql: 'CREATE TABLE bare (id INTEGER PRIMARY KEY)' },
      { name: 'checkless', sql: 'CREATE TABLE checkless (id INTEGER PRIMARY KEY CHECK)' },
    ];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'table_constraints');
    const types = rows.map(r => r.constraint_type);
    expect(types).toContain('PRIMARY KEY');
    expect(types).toContain('UNIQUE');
    expect(types).toContain('FOREIGN KEY');
    expect(types).toContain('CHECK');
  });

  it('generateCheckConstraints extracts CHECK clauses', () => {
    const tables = [
      { name: 't1', sql: 'CREATE TABLE t1 (a INTEGER CHECK (a > 10))' },
      { name: 't2', sql: null },
    ];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'check_constraints');
    expect(rows.length).toBe(1);
    expect(rows[0].check_clause).toBe('a > 10');
  });

  it('drives every dynamic view generator against a populated DB', () => {
    const tables = [
      { name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT UNIQUE, org_id INTEGER REFERENCES orgs(id), age INTEGER CHECK (age > 0))' },
    ];
    setCurrentDbRef(makeDbWithTables(tables));

    for (const name of [
      'table_constraints',
      'key_column_usage',
      'referential_constraints',
      'constraint_column_usage',
      'table_privileges',
      'role_table_grants',
      'column_privileges',
      'role_column_grants',
      'domain_constraints',
      'column_domain_usage',
      'parameters',
    ]) {
      const rows = SystemCatalog.getViewRows('information_schema', name);
      expect(Array.isArray(rows)).toBe(true);
      for (const r of rows) {
        expect(typeof r).toBe('object');
        expect(r).not.toBeNull();
      }
    }
  });

  it('getDbTables swallows prepare() errors and returns []', () => {
    const throwingDb: DatabaseRef = {
      prepare: () => {
        throw new Error('boom');
      },
    };
    setCurrentDbRef(throwingDb);
    // table_constraints calls getDbTables which catches the throw.
    expect(SystemCatalog.getViewRows('information_schema', 'table_constraints')).toEqual([]);
  });

  it('key_column_usage emits PK, FK, and UNIQUE index columns', () => {
    const tables = [{ name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, org_id INTEGER REFERENCES orgs(id))' }];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'key_column_usage');
    const names = rows.map(r => r.column_name);
    expect(names).toContain('id');       // PK column
    expect(names).toContain('org_id');   // FK column
    expect(names).toContain('email');    // UNIQUE index column
    expect(rows.some(r => r.constraint_name === 'accounts_pkey')).toBe(true);
  });

  it('key_column_usage sorts a composite PK by position', () => {
    const tables = [{ name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER, tenant_id INTEGER, PRIMARY KEY (tenant_id, id))' }];
    setCurrentDbRef(makeDbWithTables(tables, {}, { compositePk: true }));
    const rows = SystemCatalog.getViewRows('information_schema', 'key_column_usage');
    // Two PK columns present, ordered by their pk position.
    const pkRows = rows.filter(r => r.constraint_name === 'accounts_pkey');
    expect(pkRows.length).toBe(2);
    expect(pkRows.map(r => r.ordinal_position)).toEqual([1, 2]);
  });

  it('generateReferentialConstraints maps unknown rules to NO ACTION', () => {
    // fk.on_update/on_delete values outside the ruleMap fall back to 'NO ACTION'.
    const tables = [{ name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY)' }];
    setCurrentDbRef(makeDbWithTables(tables, { on_update: 'WEIRD', on_delete: 'STRANGE', to: '' }));
    const rows = SystemCatalog.getViewRows('information_schema', 'referential_constraints');
    expect(rows.length).toBe(1);
    expect(rows[0].update_rule).toBe('NO ACTION');
    expect(rows[0].delete_rule).toBe('NO ACTION');
  });

  it('generateConstraintColumnUsage falls back to "id" when fk.to is empty', () => {
    const tables = [{ name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY)' }];
    setCurrentDbRef(makeDbWithTables(tables, { to: '' }));
    const rows = SystemCatalog.getViewRows('information_schema', 'constraint_column_usage');
    const fkRows = rows.filter(r => r.constraint_name === 'accounts_fk');
    expect(fkRows.some(r => r.column_name === 'id')).toBe(true);
  });

  it('generateTablePrivileges merges DB tables not already known', () => {
    const tables = [
      { name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY)' },
      { name: 'mystery_table', sql: 'CREATE TABLE mystery_table (x INT)' },
    ];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'table_privileges');
    const mysteryPrivs = rows.filter(r => r.table_name === 'mystery_table');
    // 7 privilege types expected per table.
    expect(mysteryPrivs.length).toBe(7);
  });

  it('column_privileges returns [] when db lacks prepare', () => {
    setCurrentDbRef({ exec: () => {} } as DatabaseRef);
    // META_TABLES columns still populate, but user-table PRAGMA path is skipped.
    const rows = SystemCatalog.getViewRows('information_schema', 'column_privileges');
    expect(Array.isArray(rows)).toBe(true);
  });

  it('generateCheckConstraints skips a CHECK keyword without a parenthesised clause', () => {
    const tables = [
      { name: 'accounts', sql: 'CREATE TABLE accounts (id INTEGER PRIMARY KEY CHECK)' },
    ];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'check_constraints');
    expect(rows.length).toBe(0);
  });

  it('generateTablePrivileges skips DB tables already known to allTables', () => {
    // A DB table whose name collides with a META_TABLE (columns) hits the
    // `allTables.find(...)` true branch and is not re-added.
    const tables = [
      { name: 'columns', sql: 'CREATE TABLE columns (x INT)' },
      { name: 'fresh_table', sql: 'CREATE TABLE fresh_table (x INT)' },
    ];
    setCurrentDbRef(makeDbWithTables(tables));
    const rows = SystemCatalog.getViewRows('information_schema', 'table_privileges');
    // fresh_table is added (7 privileges); columns already exists so is not duplicated.
    const fresh = rows.filter(r => r.table_name === 'fresh_table');
    expect(fresh.length).toBe(7);
  });
});

/** Build a mock DatabaseRef whose sqlite_master returns specific table rows. */
function makeDbWithTables(tables: Row[], fkOverrides: Partial<Row> = {}, opts: { compositePk?: boolean } = {}): DatabaseRef {
  const tableInfo: Record<string, Row[]> = {
    accounts: opts.compositePk
      ? [
          { cid: 0, name: 'tenant_id', pk: 1 },
          { cid: 1, name: 'id', pk: 2 },
          { cid: 2, name: 'email', pk: 0 },
          { cid: 3, name: 'org_id', pk: 0 },
        ]
      : [
          { cid: 0, name: 'id', pk: 1 },
          { cid: 1, name: 'email', pk: 0 },
          { cid: 2, name: 'org_id', pk: 0 },
        ],
  };
  const fkList: Record<string, Row[]> = {
    accounts: [{ id: 0, seq: 0, table: 'orgs', from: 'org_id', to: 'id', on_update: 'CASCADE', on_delete: 'NO ACTION', ...fkOverrides }],
  };
  const indexes: Row[] = [
    { name: 'accounts_email_idx', tbl_name: 'accounts', sql: 'CREATE UNIQUE INDEX accounts_email_idx ON accounts(email)' },
  ];
  const indexInfo: Record<string, Row[]> = {
    accounts_email_idx: [{ seqno: 0, cid: 1, name: 'email' }],
  };

  const prepare = (sql: string) => {
    const s = sql.toUpperCase();
    if (s.includes('SELECT NAME, SQL FROM SQLITE_MASTER')) {
      return { all: () => tables, get: () => tables[0] };
    }
    if (s.includes('PRAGMA TABLE_INFO')) {
      const tbl = (sql.match(/table_info\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return { all: () => tableInfo[tbl] ?? [], get: () => (tableInfo[tbl] ?? [])[0] };
    }
    if (s.includes('PRAGMA FOREIGN_KEY_LIST')) {
      const tbl = (sql.match(/foreign_key_list\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return { all: () => fkList[tbl] ?? [], get: () => (fkList[tbl] ?? [])[0] };
    }
    if (s.includes('PRAGMA INDEX_INFO')) {
      const idx = (sql.match(/index_info\("([^"]+)"\)/i)?.[1] ?? '').toLowerCase();
      return { all: () => indexInfo[idx] ?? [], get: () => (indexInfo[idx] ?? [])[0] };
    }
    if (s.includes('TBL_NAME=? AND SQL IS NOT NULL')) {
      return { all: (...a: any[]) => indexes.filter(i => i.tbl_name === a[0] && i.sql != null), get: () => indexes[0] };
    }
    if (s.includes("SQL LIKE '%UNIQUE%'")) {
      return { all: (...a: any[]) => indexes.filter(i => i.tbl_name === a[0] && i.sql != null && String(i.sql).toUpperCase().includes('UNIQUE')), get: () => indexes[0] };
    }
    if (s.includes("TYPE='INDEX' AND TBL_NAME=?")) {
      return { all: (...a: any[]) => indexes.filter(i => i.tbl_name === a[0]), get: () => indexes[0] };
    }
    return { all: () => [], get: () => undefined };
  };
  return { prepare, exec: () => undefined };
}
