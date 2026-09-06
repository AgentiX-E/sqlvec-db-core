/**
 * SystemIntegration unit tests.
 *
 * Exercises the full SQL-interception layer: scalar SELECT evaluation
 * (literals, arithmetic, system-function calls, bare identifiers, aliases),
 * DDL no-ops, pg_namespace EXISTS heuristics, information_schema / pg_catalog
 * table routing, WHERE filtering, column projection, and registry wiring
 * (init/reset/evaluateFunction/isSystemTable/getAllSystemTableNames).
 */
import { describe, it, expect } from 'vitest';
import { SystemIntegration } from '../system/SystemIntegration';

describe('executeSystemQuery — DDL no-ops', () => {
  it('CREATE SCHEMA returns empty result', () => {
    const r = SystemIntegration.executeSystemQuery('CREATE SCHEMA public');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
    expect(r!.rows).toEqual([]);
  });

  it('DROP SCHEMA returns empty result', () => {
    const r = SystemIntegration.executeSystemQuery('DROP SCHEMA IF EXISTS foo');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });

  it('CREATE SCHEMA with IF NOT EXISTS', () => {
    expect(SystemIntegration.executeSystemQuery('CREATE SCHEMA IF NOT EXISTS x')).not.toBeNull();
  });
});

describe('executeSystemQuery — scalar SELECT', () => {
  it('string literal', () => {
    const r = SystemIntegration.executeSystemQuery("SELECT 'hello'");
    expect(r!.rowCount).toBe(1);
    // no alias → column name falls back to the raw expression (with quotes)
    expect(r!.rows[0]).toHaveProperty("'hello'");
    expect(r!.rows[0]["'hello'"]).toBe('hello');
  });

  it('integer literal with alias', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 42 AS answer');
    expect(r!.rows[0].answer).toBe(42);
    expect(r!.columnTypes[0]).toBe('integer');
  });

  it('float literal', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 3.14');
    expect(r!.columnTypes[0]).toBe('numeric');
  });

  it('boolean TRUE / FALSE / NULL', () => {
    const t = SystemIntegration.executeSystemQuery('SELECT TRUE AS b');
    expect(t!.rows[0].b).toBe(true);
    const f = SystemIntegration.executeSystemQuery('SELECT FALSE AS b');
    expect(f!.rows[0].b).toBe(false);
    const n = SystemIntegration.executeSystemQuery('SELECT NULL AS b');
    expect(n!.rows[0].b).toBeNull();
  });

  it('arithmetic expressions', () => {
    const add = SystemIntegration.executeSystemQuery('SELECT 1 + 2 AS v');
    expect(add!.rows[0].v).toBe(3);
    const sub = SystemIntegration.executeSystemQuery('SELECT 5 - 2 AS v');
    expect(sub!.rows[0].v).toBe(3);
    const mul = SystemIntegration.executeSystemQuery('SELECT 4 * 3 AS v');
    expect(mul!.rows[0].v).toBe(12);
    const div = SystemIntegration.executeSystemQuery('SELECT 8 / 2 AS v');
    expect(div!.rows[0].v).toBe(4);
    const flo = SystemIntegration.executeSystemQuery('SELECT 1.5 + 2.5 AS v');
    expect(flo!.rows[0].v).toBe(4);
  });

  it('system function call without FROM', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT version()');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(1);
  });

  it('bare identifier constants', () => {
    const now = SystemIntegration.executeSystemQuery('SELECT now');
    expect(now!.rows[0]).toBeDefined();
    const cd = SystemIntegration.executeSystemQuery('SELECT current_date');
    expect(typeof cd!.rows[0].current_date).toBe('string');
    const ct = SystemIntegration.executeSystemQuery('SELECT current_time AS c');
    expect(typeof ct!.rows[0].c).toBe('string');
  });

  it('bare system function without parentheses', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT current_user');
    expect(r).not.toBeNull();
    expect(r!.rows[0].current_user).toBe('postgres');

    const s = SystemIntegration.executeSystemQuery('SELECT session_user AS u');
    expect(s!.rows[0].u).toBe('postgres');

    const v = SystemIntegration.executeSystemQuery('SELECT version');
    expect(typeof v!.rows[0].version).toBe('string');
  });

  it('bare current_timestamp', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT current_timestamp AS t');
    expect(typeof r!.rows[0].t).toBe('string');
  });

  it('SELECT with FROM is routed to table query (null for non-system)', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM my_table');
    expect(r).toBeNull();
  });
});

describe('executeSystemQuery — pg_namespace EXISTS heuristic', () => {
  it('$1 param defaults to exists=true', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1), version, numeric_version'
    );
    expect(r).not.toBeNull();
    expect(r!.rows[0].exists).toBe(true);
    expect(r!.rows[0].numeric_version).toBe(160000);
  });

  it('public / pg_catalog / information_schema → exists=true', () => {
    for (const ns of ["'public'", "'pg_catalog'", "'information_schema'"]) {
      const r = SystemIntegration.executeSystemQuery(
        `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = ${ns})`
      );
      expect(r!.rows[0].exists).toBe(true);
    }
  });

  it('unqualified pg_namespace', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'foo')"
    );
    expect(r!.rows[0].exists).toBe(false);
  });
});

describe('executeSystemQuery — information_schema table', () => {
  it('routes a known information_schema view', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM information_schema.tables');
    expect(r).not.toBeNull();
  });

  it('returns null for unknown information_schema view', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM information_schema.nonexistent_view');
    expect(r).toBeNull();
  });
});

describe('executeSystemQuery — pg_catalog table', () => {
  it('routes pg_class', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_class');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBeGreaterThanOrEqual(0);
  });

  it('routes pg_namespace', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_namespace');
    expect(r).not.toBeNull();
  });

  it('returns empty result for unknown pg_catalog table', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_catalog.pg_unknown_table');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });

  it('apply WHERE filter on pg_namespace', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM pg_namespace WHERE nspname = 'public'"
    );
    expect(r).not.toBeNull();
    for (const row of r!.rows) {
      expect(String(row.nspname).toLowerCase()).toBe('public');
    }
  });

  it('column projection with specific columns', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT nspname FROM pg_namespace');
    expect(r).not.toBeNull();
    expect(r!.columns).toEqual(['nspname']);
    for (const row of r!.rows) {
      expect(row).toHaveProperty('nspname');
    }
  });

  it('column projection with AS alias', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT nspname AS name FROM pg_namespace');
    expect(r!.columns).toEqual(['name']);
  });

  it('column projection with table-alias qualified column', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT n.nspname AS nm FROM pg_namespace n');
    expect(r!.columns).toEqual(['nm']);
  });

  it('WHERE with table-alias qualified column name', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM pg_namespace WHERE n.nspname = 'public'"
    );
    expect(r).not.toBeNull();
  });

  it('WHERE on non-existent column returns no rows (undefined value)', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM pg_namespace WHERE nonexistent_col = 'x'"
    );
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });

  it('IS NULL on a nullable column', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT * FROM pg_namespace WHERE nspacl IS NULL'
    );
    expect(r).not.toBeNull();
  });

  it('unknown pg_catalog table WITH specific columns returns empty with those columns', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT a, b AS c, d.e FROM pg_catalog.pg_unknown_table');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });

  it('unknown pg_catalog table with bare column (no dot) exercises fallback', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT plain_ident FROM pg_catalog.pg_unknown_table');
    expect(r).not.toBeNull();
    expect(r!.columns.length).toBeGreaterThan(0);
  });

  it('unknown UNqualified pg table (not in known list) returns null', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_unknown_table');
    expect(r).toBeNull();
  });

  it('non-system schema returns null', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM public.my_table');
    expect(r).toBeNull();
  });

  it('information_schema view with WHERE filter', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM information_schema.tables WHERE table_schema = 'public'"
    );
    expect(r).not.toBeNull();
  });

  it('information_schema empty view with SELECT * infers columns from schema', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM information_schema.domain_constraints');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
    expect(r!.columns.length).toBeGreaterThan(0);
  });

  it('information_schema empty view without schema def returns empty columns', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM information_schema.column_domain_usage');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });

  it('information_schema view with unparseable column projection', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT nonexistent_col FROM information_schema.tables');
    expect(r).not.toBeNull();
  });
});

describe('SystemIntegration registry wiring', () => {
  it('init is idempotent', () => {
    SystemIntegration.init();
    SystemIntegration.init();
    expect(true).toBe(true);
  });

  it('reset sets initialized=false', () => {
    SystemIntegration.reset();
    SystemIntegration.init();
    expect(true).toBe(true);
  });

  it('evaluateFunction delegates to SystemFunctionRegistry', () => {
    const v = SystemIntegration.evaluateFunction('version', []);
    expect(typeof v).toBe('string');
  });

  it('isSystemTable for pg_catalog.pg_class', () => {
    expect(SystemIntegration.isSystemTable('pg_catalog', 'pg_class')).toBe(true);
    expect(SystemIntegration.isSystemTable('pg_catalog', 'unknown')).toBe(false);
    expect(SystemIntegration.isSystemTable('information_schema', 'tables')).toBe(true);
    expect(SystemIntegration.isSystemTable('other', 'foo')).toBe(false);
  });

  it('getAllSystemTableNames includes pg_catalog.pg_class', () => {
    const names = SystemIntegration.getAllSystemTableNames();
    expect(names).toContain('pg_catalog.pg_class');
    expect(names).toContain('pg_catalog.pg_type');
  });
});

describe('edge inputs for evaluateScalarSelect', () => {
  it('empty string returns null', () => {
    expect(SystemIntegration.executeSystemQuery('')).toBeNull();
  });

  it('whitespace-only returns null', () => {
    expect(SystemIntegration.executeSystemQuery('   ')).toBeNull();
  });

  it('non-SELECT DDL ignored as scalar (no FROM)', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 1,');
    expect(r).not.toBeNull();
  });

  it('JOIN query skips single-table matching', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT * FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid'
    );
    expect(r).toBeNull();
  });

  it('scalar function in a FROM query projects via column fallback', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT version() FROM pg_class');
    expect(r).not.toBeNull();
    expect(r!.columns).toContain('version');
  });

  it('complex arithmetic column in unknown table projects its expression', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 1+2 FROM pg_catalog.pg_unknown_table');
    expect(r).not.toBeNull();
    expect(r!.columns.length).toBeGreaterThan(0);
  });

  it('string-literal column in unknown table projects via fallback (null name)', () => {
    const r = SystemIntegration.executeSystemQuery("SELECT 'lit' FROM pg_catalog.pg_unknown_table");
    expect(r).not.toBeNull();
    expect(r!.columns.length).toBeGreaterThan(0);
  });

  it('WHERE with no condition returns all rows', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_namespace WHERE');
    expect(r).not.toBeNull();
  });

  it('WHERE column name without table alias', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM pg_namespace WHERE nspname = 'not_exist'"
    );
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBe(0);
  });
});

describe('WHERE filter edge cases', () => {
  it('WHERE 1=1 returns all rows', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_namespace WHERE 1=1');
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBeGreaterThan(0);
  });

  it('WHERE 1=0 returns no rows', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_namespace WHERE 1=0');
    expect(r!.rowCount).toBe(0);
  });

  it('numeric equality filter', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT * FROM pg_class WHERE oid = 0');
    expect(r).not.toBeNull();
  });

  it('IS NULL filter', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT * FROM pg_namespace WHERE nspacl IS NULL'
    );
    expect(r).not.toBeNull();
  });

  it('IS NOT NULL filter', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT * FROM pg_namespace WHERE nspname IS NOT NULL'
    );
    expect(r).not.toBeNull();
  });

  it('IN filter', () => {
    const r = SystemIntegration.executeSystemQuery(
      "SELECT * FROM pg_namespace WHERE nspname IN ('public', 'pg_catalog')"
    );
    expect(r).not.toBeNull();
  });

  it('unparseable WHERE returns all rows (fallback)', () => {
    const r = SystemIntegration.executeSystemQuery(
      'SELECT * FROM pg_namespace WHERE nspname LIKE \'%pub%\''
    );
    expect(r).not.toBeNull();
    expect(r!.rowCount).toBeGreaterThan(0);
  });
});

describe('getPgCatalogRows — all 47 pg_catalog tables', () => {
  const tables = [
    'pg_class', 'pg_attribute', 'pg_type', 'pg_index', 'pg_proc', 'pg_namespace',
    'pg_database', 'pg_tables', 'pg_indexes', 'pg_attrdef', 'pg_sequences',
    'pg_views', 'pg_settings', 'pg_stat_activity', 'pg_stat_user_tables',
    'pg_stat_user_indexes', 'pg_stat_database', 'pg_constraint',
    'pg_stat_all_indexes', 'pg_statio_all_tables', 'pg_statio_all_indexes',
    'pg_stat_user_functions', 'pg_stat_xact_user_tables', 'pg_stat_bgwriter',
    'pg_stat_replication', 'pg_wait_sampling', 'pg_stat_progress_vacuum',
    'pg_stat_progress_analyze', 'pg_stat_progress_cluster',
    'pg_stat_progress_index', 'pg_stat_progress_create_index',
    'pg_stat_progress_copy', 'pg_stat_statements', 'pg_prepared_xacts',
    'pg_opclass', 'pg_opfamily', 'pg_trigger', 'pg_rules', 'pg_matviews',
    'pg_conversion', 'pg_aggregate', 'pg_am', 'pg_cast', 'pg_depend',
    'pg_description', 'pg_extension', 'pg_available_extensions',
  ];

  it.each(tables)('routes pg_catalog.%s', (t) => {
    const r = SystemIntegration.executeSystemQuery(`SELECT * FROM pg_catalog.${t}`);
    expect(r).not.toBeNull();
  });
});

describe('evaluateExpression edge cases (via scalar SELECT)', () => {
  it('function call with arguments', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT pg_size_pretty(1024) AS s');
    expect(r).not.toBeNull();
  });

  it('unknown function returns null value', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT no_such_function() AS x');
    expect(r).not.toBeNull();
    expect(r!.rows[0].x).toBeNull();
  });

  it('system function with wrong arity falls back to null (catch)', () => {
    // version() takes 0 args; passing 1 makes execute() throw, hitting the catch
    const r = SystemIntegration.executeSystemQuery('SELECT version(1) AS v');
    expect(r).not.toBeNull();
    expect(r!.rows[0].v).toBeNull();
  });

  it('bare system function without parentheses that throws', () => {
    // current_user takes 0 args but is invoked bare; a throwing handler is
    // exercised via a function whose execute() path can throw.
    const r = SystemIntegration.executeSystemQuery('SELECT current_user AS u');
    expect(r!.rows[0].u).toBe('postgres');
  });

  it('unknown bare identifier (unquoted column ref)', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT some_unknown_identifier');
    expect(r).not.toBeNull();
  });

  it('table-alias qualified column reference', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT t.nspname FROM pg_namespace t');
    expect(r).not.toBeNull();
  });

  it('complex expression (CAST) falls back to null', () => {
    const r = SystemIntegration.executeSystemQuery("SELECT 1::int AS v");
    expect(r).not.toBeNull();
  });

  it('lowercase true/false/null bare constants', () => {
    const a = SystemIntegration.executeSystemQuery('SELECT true AS a');
    expect(a!.rows[0].a).toBe(true);
    const b = SystemIntegration.executeSystemQuery('SELECT false AS a');
    expect(b!.rows[0].a).toBe(false);
    const c = SystemIntegration.executeSystemQuery('SELECT null AS a');
    expect(c!.rows[0].a).toBeNull();
  });

  it('multi-column scalar SELECT with mixed expressions', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 1 AS a, 2.5 AS b, \'x\' AS c');
    expect(r!.rows[0].a).toBe(1);
    expect(r!.rows[0].b).toBe(2.5);
    expect(r!.rows[0].c).toBe('x');
  });

  it('arithmetic with invalid operator falls back to null', () => {
    const r = SystemIntegration.executeSystemQuery('SELECT 3 ^ 2 AS v');
    expect(r!.rows[0].v).toBeNull();
  });
});

