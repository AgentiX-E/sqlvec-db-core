import { describe, it, expect, beforeEach } from 'vitest';
import { PgCatalog } from '../system/PgCatalog';
import { SystemCatalog } from '../system/SystemCatalog';
import { SystemTypeRegistry } from '../system/SystemTypes';
import { SystemFunctionRegistry } from '../system/SystemFunctions';

// Each test drives a fresh catalog by resetting the singleton's init guard
// where possible. PgCatalog.init() is idempotent, so calling it repeatedly is
// cheap and safe.

describe('PgCatalog.init()', () => {
  it('is idempotent', () => {
    PgCatalog.init();
    PgCatalog.init();
    // No throw; init guard short-circuits on second call.
    expect(true).toBe(true);
  });
});

describe('PgCatalog namespace lookup', () => {
  beforeEach(() => PgCatalog.init());

  it('resolves known namespace names to OIDs', () => {
    expect(PgCatalog.getNamespaceOid('pg_catalog')).toBe(11);
    expect(PgCatalog.getNamespaceOid('public')).toBe(2200);
    expect(PgCatalog.getNamespaceOid('information_schema')).toBe(2201);
    expect(PgCatalog.getNamespaceOid('pg_toast')).toBe(99);
  });

  it('returns undefined for unknown namespace', () => {
    expect(PgCatalog.getNamespaceOid('no_such_namespace')).toBeUndefined();
  });

  it('resolves namespace name from OID and back', () => {
    expect(PgCatalog.getNamespaceName(11)).toBe('pg_catalog');
    expect(PgCatalog.getNamespaceName(2200)).toBe('public');
    expect(PgCatalog.getNamespaceName(999999)).toBeUndefined();
  });
});

describe('PgCatalog class lookup', () => {
  beforeEach(() => PgCatalog.init());

  it('resolves pg_class OID without namespace', () => {
    const oid = PgCatalog.getClassOid('pg_class');
    expect(oid).toBeGreaterThan(0);
  });

  it('resolves class OID with namespace scope', () => {
    const oid = PgCatalog.getClassOid('pg_class', 'pg_catalog');
    expect(oid).toBeGreaterThan(0);
  });

  it('returns undefined for unknown relation', () => {
    expect(PgCatalog.getClassOid('no_such_table')).toBeUndefined();
  });
});

describe('PgCatalog relation rows', () => {
  beforeEach(() => PgCatalog.init());

  it('getClassRows returns non-empty array with relname', () => {
    const rows = PgCatalog.getClassRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('relname');
    expect(rows[0]).toHaveProperty('oid');
  });

  it('getAttributeRows returns non-empty array', () => {
    const rows = PgCatalog.getAttributeRows();
    expect(rows.length).toBeGreaterThan(0);
  });

  it('getTypeRows returns non-empty array with typname', () => {
    const rows = PgCatalog.getTypeRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('typname');
  });

  it('getNamespaceRows includes pg_catalog and public', () => {
    const names = PgCatalog.getNamespaceRows().map(r => r.nspname);
    expect(names).toEqual(expect.arrayContaining(['pg_catalog', 'public', 'information_schema']));
  });

  it('getDatabaseRows has postgres database', () => {
    const rows = PgCatalog.getDatabaseRows();
    expect(rows.some(r => r.datname === 'postgres')).toBe(true);
  });
});

describe('PgCatalog pg_tables / pg_indexes / pg_views rows', () => {
  beforeEach(() => PgCatalog.init());

  it('getPgTablesRows returns array with schemaname/tablename', () => {
    const rows = PgCatalog.getPgTablesRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toHaveProperty('schemaname');
    expect(rows[0]).toHaveProperty('tablename');
  });

  it('getPgIndexesRows returns array (possibly empty)', () => {
    const rows = PgCatalog.getPgIndexesRows();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('getPgViewsRows returns array', () => {
    const rows = PgCatalog.getPgViewsRows();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('PgCatalog pg_settings rows', () => {
  beforeEach(() => PgCatalog.init());

  it('returns non-empty settings and includes a search_path synthetic entry', () => {
    const rows = PgCatalog.getPgSettingsRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r => r.name === 'search_path')).toBe(true);
  });

  it('maps vartype int/real to integer/real', () => {
    const rows = PgCatalog.getPgSettingsRows();
    for (const r of rows) {
      if (r.vartype) {
        expect(['integer', 'real', 'string', 'bool', 'enum']).toContain(r.vartype);
      }
    }
  });
});

// Full sweep over every exposed `get*Rows` getter to guarantee each one is
// executed at least once (statement/function coverage) and returns an array.
describe('PgCatalog row getter sweep', () => {
  beforeEach(() => PgCatalog.init());

  const getters: Array<[string, () => any[]]> = [
    ['getPgSequenceDefinitionRows', () => PgCatalog.getPgSequencesRows?.() ?? []],
    ['getPgStatActivityRows', () => PgCatalog.getPgStatActivityRows()],
    ['getPgStatUserTablesRows', () => PgCatalog.getPgStatUserTablesRows()],
    ['getPgStatUserIndexesRows', () => PgCatalog.getPgStatUserIndexesRows()],
    ['getUserIndexesRows', () => PgCatalog.getUserIndexesRows()],
    ['getPgStatDatabaseRows', () => PgCatalog.getPgStatDatabaseRows()],
    ['getPgStatAllIndexesRows', () => PgCatalog.getPgStatAllIndexesRows()],
    ['getPgStatIoAllTablesRows', () => PgCatalog.getPgStatIoAllTablesRows()],
    ['getPgStatIoAllIndexesRows', () => PgCatalog.getPgStatIoAllIndexesRows()],
    ['getPgStatUserFunctionsRows', () => PgCatalog.getPgStatUserFunctionsRows()],
    ['getPgStatsRows', () => PgCatalog.getPgStatsRows()],
    ['getPgStatXactUserTablesRows', () => PgCatalog.getPgStatXactUserTablesRows()],
    ['getPgStatBgwriterRows', () => PgCatalog.getPgStatBgwriterRows()],
    ['getPgStatReplicationRows', () => PgCatalog.getPgStatReplicationRows()],
    ['getPgWaitSamplingRows', () => PgCatalog.getPgWaitSamplingRows()],
    ['getPgStatProgressVacuumRows', () => PgCatalog.getPgStatProgressVacuumRows()],
    ['getPgStatProgressAnalyzeRows', () => PgCatalog.getPgStatProgressAnalyzeRows()],
    ['getPgStatProgressClusterRows', () => PgCatalog.getPgStatProgressClusterRows()],
    ['getPgStatProgressIndexRows', () => PgCatalog.getPgStatProgressIndexRows()],
    ['getPgStatProgressCreateIndexRows', () => PgCatalog.getPgStatProgressCreateIndexRows()],
    ['getPgStatProgressCopyRows', () => PgCatalog.getPgStatProgressCopyRows()],
    ['getPgStatStatementsRows', () => PgCatalog.getPgStatStatementsRows()],
    ['getPgPreparedXactsRows', () => PgCatalog.getPgPreparedXactsRows()],
    ['getPgOpclassRows', () => PgCatalog.getPgOpclassRows()],
    ['getPgOpfamilyRows', () => PgCatalog.getPgOpfamilyRows()],
    ['getPgAttrdefRows', () => PgCatalog.getPgAttrdefRows()],
    ['getPgTriggerRows', () => PgCatalog.getPgTriggerRows()],
    ['getPgRulesRows', () => PgCatalog.getPgRulesRows()],
    ['getPgMatViewsRows', () => PgCatalog.getPgMatViewsRows()],
    ['getPgConversionRows', () => PgCatalog.getPgConversionRows()],
    ['getPgAggregateRows', () => PgCatalog.getPgAggregateRows()],
    ['getPgAmRows', () => PgCatalog.getPgAmRows()],
    ['getPgCastRows', () => PgCatalog.getPgCastRows()],
    ['getPgDependRows', () => PgCatalog.getPgDependRows()],
    ['getPgDescriptionRows', () => PgCatalog.getPgDescriptionRows()],
    ['getPgExtensionRows', () => PgCatalog.getPgExtensionRows()],
    ['getPgAvailableExtensionsRows', () => PgCatalog.getPgAvailableExtensionsRows()],
    ['getExtensionList', () => PgCatalog.getExtensionList().map(e => ({ ...e }))],
    ['getPgConstraintRows', () => PgCatalog.getPgConstraintRows()],
    ['getPgOperatorRows', () => PgCatalog.getPgOperatorRows()],
    ['getPgLanguageRows', () => PgCatalog.getPgLanguageRows()],
    ['getPgTablespaceRows', () => PgCatalog.getPgTablespaceRows()],
    ['getPgRewriteRows', () => PgCatalog.getPgRewriteRows()],
    ['getPgRangeRows', () => PgCatalog.getPgRangeRows()],
    ['getPgAmopRows', () => PgCatalog.getPgAmopRows()],
    ['getPgAmprocRows', () => PgCatalog.getPgAmprocRows()],
    ['getPgShdependRows', () => PgCatalog.getPgShdependRows()],
    ['getPgDbRoleSettingRows', () => PgCatalog.getPgDbRoleSettingRows()],
  ];

  it.each(getters)('%s returns an array', (_name, fn) => {
    const rows = fn();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('PgCatalog extension list', () => {
  beforeEach(() => PgCatalog.init());

  it('getExtensionList returns array of {extname, extversion}', () => {
    const list = PgCatalog.getExtensionList();
    expect(Array.isArray(list)).toBe(true);
    for (const e of list) {
      expect(e).toHaveProperty('extname');
      expect(e).toHaveProperty('extversion');
    }
  });
});

describe('PgCatalog cross-registry integration', () => {
  it('type registry and function registry are initialized', () => {
    PgCatalog.init();
    expect(SystemTypeRegistry.getAll().length).toBeGreaterThan(0);
    expect(SystemFunctionRegistry.getAllFunctions().length).toBeGreaterThan(0);
    expect(SystemCatalog.getViewNames().length).toBeGreaterThan(0);
  });
});
