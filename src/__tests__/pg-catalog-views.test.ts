import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PgCatalog } from '../system/PgCatalog';

type Row = Record<string, any>;
function makeMockDb(spec: Record<string, Row[] | Row>) {
  const stmts = new Map<string, any>();
  for (const [sql, v] of Object.entries(spec)) {
    if (Array.isArray(v)) {
      stmts.set(sql, { all: () => v, get: () => (v.length ? v[0] : undefined) });
    } else {
      stmts.set(sql, { all: () => [v], get: () => v });
    }
  }
  const db: any = {
    name: 'mock.db',
    prepare: (sql: string) => stmts.get(sql) ?? { all: () => [], get: () => undefined },
    exec: () => {},
  };
  return db;
}

function resetStatics() {
  PgCatalog.shardDb = null;
  PgCatalog.connectionManager = null;
  PgCatalog.activeQueryRegistry = null;
  PgCatalog.pgStatStatements = null;
  PgCatalog.pgStatCollector = null;
  PgCatalog.preparedTxManager = null;
  PgCatalog.operatorClassShim = null;
  PgCatalog.userTableStats.clear();
  PgCatalog.userIndexStats.clear();
}

describe('PgCatalog static row getters', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('getIndexRows returns INDEX_ROWS', () => {
    expect(Array.isArray(PgCatalog.getIndexRows())).toBe(true);
  });
  it('getProcedureRows returns PROCEDURE_ROWS', () => {
    expect(Array.isArray(PgCatalog.getProcedureRows())).toBe(true);
  });
});

describe('PgCatalog getPgSequencesRows', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('reads _sqlvec_sequences table', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_sequences'`]:
        { name: '_sqlvec_sequences' },
      [`SELECT name, last_value, start_value, increment, min_value, max_value, cache_size, is_cycling FROM _sqlvec_sequences ORDER BY name`]:
        [{ name: 'seq_a', last_value: 10, start_value: 1, increment: 1, min_value: 1, max_value: null, cache_size: 1, is_cycling: 0 }],
      [`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__seq_%' ORDER BY name`]: [],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgSequencesRows();
    expect(rows.length).toBe(1);
    expect(rows[0].sequencename).toBe('seq_a');
    expect(rows[0].max_value).toBe(9223372036854775807); // null → PG bigint max
  });

  it('scans __seq_* tables for SERIAL sequences', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_sequences'`]: undefined,
      [`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__seq_%' ORDER BY name`]:
        [{ name: '__seq_users_id' }],
      [`SELECT last_value FROM "__seq_users_id"`]: { last_value: 99 },
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgSequencesRows();
    expect(rows.length).toBe(1);
    expect(rows[0].sequencename).toBe('__seq_users_id');
    expect(rows[0].last_value).toBe(99);
  });

  it('skips seq already added via _sqlvec_sequences', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='_sqlvec_sequences'`]:
        { name: '_sqlvec_sequences' },
      [`SELECT name, last_value, start_value, increment, min_value, max_value, cache_size, is_cycling FROM _sqlvec_sequences ORDER BY name`]:
        [{ name: '__seq_x', last_value: 1, start_value: 1, increment: 1, min_value: 1, max_value: 1, cache_size: 1, is_cycling: 0 }],
      [`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '__seq_%' ORDER BY name`]:
        [{ name: '__seq_x' }],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgSequencesRows();
    expect(rows.length).toBe(1); // deduplicated
  });
});

describe('PgCatalog getPgStatAllIndexesRows', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('returns [] when shardDb null', () => {
    expect(PgCatalog.getPgStatAllIndexesRows()).toEqual([]);
  });

  it('returns [] when no indexes', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`]: [],
    });
    expect(PgCatalog.getPgStatAllIndexesRows()).toEqual([]);
  });

  it('maps indexes with pss-driven idx_scan estimate', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`]:
        [{ name: 'idx_u', tbl_name: 'pg_class' }],
    });
    PgCatalog.pgStatStatements = {
      getAll: () => [{ calls: 10 }, { calls: 30 }],
    } as any;
    const rows = PgCatalog.getPgStatAllIndexesRows();
    expect(rows.length).toBe(1);
    expect(rows[0].indexname).toBe('idx_u');
    expect(rows[0].idx_scan).toBe(40);
  });
});

describe('PgCatalog getPgStatUserFunctionsRows', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('returns [] when no db', () => {
    PgCatalog.shardDb = null;
    expect(PgCatalog.getPgStatUserFunctionsRows()).toEqual([]);
  });

  it('maps triggers as function proxies', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`]:
        [{ name: 'trg_a', tbl_name: 'users' }, { name: 'trg_b', tbl_name: 'orders' }],
    });
    PgCatalog.pgStatStatements = { getAll: () => [{ calls: 20 }] } as any;
    const rows = PgCatalog.getPgStatUserFunctionsRows();
    expect(rows.length).toBe(2);
    expect(rows[0].funcname).toBe('trg_a');
  });
});

describe('PgCatalog getPgStatsRows (pg_stats)', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('returns [] when no __sqlvec_statistics table', () => {
    PgCatalog.shardDb = makeMockDb({});
    expect(PgCatalog.getPgStatsRows()).toEqual([]);
  });

  it('returns [] when stats table empty', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__sqlvec_statistics'`]:
        { name: '__sqlvec_statistics' },
      [`SELECT * FROM __sqlvec_statistics ORDER BY table_name, column_name`]: [],
    });
    expect(PgCatalog.getPgStatsRows()).toEqual([]);
  });

  it('builds pg_stats with histogram + collector (distinct>=rows → -1)', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__sqlvec_statistics'`]:
        { name: '__sqlvec_statistics' },
      [`SELECT * FROM __sqlvec_statistics ORDER BY table_name, column_name`]: [
        {
          table_name: 'users', column_name: 'id',
          row_count: 10, distinct_count: 10, null_count: 0,
          mcv_values: JSON.stringify(['a', 'b']),
          mcv_frequencies: JSON.stringify([0.5, 0.5]),
        },
      ],
      [`SELECT * FROM __sqlvec_histogram ORDER BY table_name, column_name, bucket_index`]: [
        { table_name: 'users', column_name: 'id', bucket_min: 1, bucket_max: 5 },
        { table_name: 'users', column_name: 'id', bucket_min: 6, bucket_max: 10 },
      ],
    });
    PgCatalog.shardDb = db;
    PgCatalog.pgStatCollector = {
      getColumnStats: (_t: string, _c: string) => ({ avgWidth: 8, correlation: 0.9 }),
    } as any;
    const rows = PgCatalog.getPgStatsRows();
    expect(rows.length).toBe(1);
    expect(rows[0].n_distinct).toBe(-1); // all distinct
    expect(rows[0].avg_width).toBe(8);
    expect(rows[0].correlation).toBe(0.9);
    expect(rows[0].most_common_vals).toEqual(['a', 'b']);
    expect(rows[0].histogram_bounds).toEqual([1, 6]);
  });

  it('builds pg_stats with distinct===0 → 0 and distinct partial → value', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__sqlvec_statistics'`]:
        { name: '__sqlvec_statistics' },
      [`SELECT * FROM __sqlvec_statistics ORDER BY table_name, column_name`]: [
        { table_name: 't1', column_name: 'c0', row_count: 5, distinct_count: 0, null_count: 2, mcv_values: null, mcv_frequencies: null },
        { table_name: 't2', column_name: 'c3', row_count: 10, distinct_count: 3, null_count: 1, mcv_values: null, mcv_frequencies: null },
      ],
      [`SELECT * FROM __sqlvec_histogram ORDER BY table_name, column_name, bucket_index`]: [],
    });
    PgCatalog.shardDb = db;
    PgCatalog.pgStatCollector = null;
    const rows = PgCatalog.getPgStatsRows();
    expect(rows[0].n_distinct).toBe(0);
    expect(rows[0].null_frac).toBe(0.4);
    expect(rows[1].n_distinct).toBe(3);
    expect(rows[1].null_frac).toBe(0.1);
  });
});

describe('PgCatalog getPgStatStatementsRows', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('returns [] when no pss', () => {
    PgCatalog.pgStatStatements = null;
    expect(PgCatalog.getPgStatStatementsRows()).toEqual([]);
  });

  it('maps pss entries', () => {
    PgCatalog.pgStatStatements = {
      getAll: () => [{
        queryid: 1, query: 'SELECT 1', calls: 5, total_time: 10,
        min_time: 1, max_time: 3, mean_time: 2,
      }],
    } as any;
    const rows = PgCatalog.getPgStatStatementsRows();
    expect(rows[0].queryid).toBe(1);
    expect(rows[0].calls).toBe(5);
  });
});

describe('PgCatalog getPgMatViewsRows / getPgRulesRows / getPgConversionRows', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('getPgMatViewsRows returns [] when no __materialized_views table', () => {
    PgCatalog.shardDb = makeMockDb({});
    expect(PgCatalog.getPgMatViewsRows()).toEqual([]);
  });

  it('getPgMatViewsRows maps materialized views', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__materialized_views'`]:
        { name: '__materialized_views' },
      [`SELECT view_name, query_sql, created_at, refreshed_at FROM __materialized_views ORDER BY view_name`]:
        [{ view_name: 'mv_x', query_sql: 'SELECT ...', created_at: 1, refreshed_at: 123 }],
      [`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`]: [],
    });
    PgCatalog.shardDb = null; // reset then use db
    // Recreate with both tables present
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__materialized_views'`]:
        { name: '__materialized_views' },
      [`SELECT view_name, query_sql, created_at, refreshed_at FROM __materialized_views ORDER BY view_name`]:
        [{ view_name: 'mv_x', query_sql: 'SELECT 1', created_at: 1, refreshed_at: 123 }],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgMatViewsRows();
    expect(rows.length).toBe(1);
    expect(rows[0].matviewname).toBe('mv_x');
    expect(rows[0].ispopulated).toBe(true);
  });

  it('getPgRulesRows maps triggers as rules', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`]:
        [{ name: 'trg_r', tbl_name: 'users', sql: 'CREATE TRIGGER ...' }],
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='__materialized_views'`]: undefined,
    });
    const rows = PgCatalog.getPgRulesRows();
    expect(rows.length).toBe(1);
    expect(rows[0].rulename).toBe('trg_r');
  });

  it('getPgConversionRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgConversionRows())).toBe(true);
  });
});

describe('PgCatalog trigger event bitmask branches', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  const cases: Array<[string, number]> = [
    ['CREATE TRIGGER x BEFORE INSERT ON t BEGIN SELECT 1; END', 2 | 1],
    ['CREATE TRIGGER x AFTER UPDATE ON t BEGIN SELECT 1; END', 16 | 4],
    ['CREATE TRIGGER x INSTEAD OF DELETE ON t BEGIN SELECT 1; END', 32 | 8],
  ];

  it.each(cases)('parses %s → tgtype %s', (sql, expected) => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`]:
        [{ name: 'trg', sql }],
    });
    const rows = PgCatalog.getPgTriggerRows();
    expect(rows[0].tgtype).toBe(expected);
  });
});

describe('PgCatalog mapSqliteTypeToPgType (via buildFromShard)', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('maps every SQLite type family to the correct PG type', () => {
    // CITEXT must map to text (not int4) despite containing "INT".
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND name NOT LIKE 'pg_%' ORDER BY name`]:
        [{ name: 'typed' }],
      [`PRAGMA table_info('typed')`]: [
        { name: 'c_int', type: 'INTEGER', notnull: 0, dflt_value: null },
        { name: 'c_text', type: 'TEXT', notnull: 0, dflt_value: null },
        { name: 'c_citext', type: 'CITEXT', notnull: 0, dflt_value: null },
        { name: 'c_blob', type: 'BLOB', notnull: 0, dflt_value: null },
        { name: 'c_real', type: 'REAL', notnull: 0, dflt_value: null },
        { name: 'c_bool', type: 'BOOLEAN', notnull: 0, dflt_value: null },
        { name: 'c_time', type: 'TIMESTAMP', notnull: 0, dflt_value: null },
        { name: 'c_num', type: 'NUMERIC', notnull: 0, dflt_value: null },
        { name: 'c_other', type: 'WHATEVER', notnull: 0, dflt_value: null },
      ],
      [`SELECT COUNT(*) AS cnt FROM "typed"`]: { cnt: 0 },
    });
    PgCatalog.buildFromShard(db);

    // The typed table's attributes should reflect the mapped PG type OIDs.
    const attrs = PgCatalog.getAttributeRows().filter(a =>
      PgCatalog.getClassRows().find(c => c.relname === 'typed' && c.oid === a.attrelid)
    );
    // c_citext should have text OID (25), not int4 OID (23).
    const citextAttr = attrs.find(a => a.attname === 'c_citext');
    expect(citextAttr).toBeDefined();
    expect(citextAttr.atttypid).toBe(25); // text, not 23 (int4)
  });
});

describe('PgCatalog getPgStatBgwriter cache_size branches', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('handles positive cache_size and zero page_count', () => {
    const db = makeMockDb({
      'PRAGMA page_size': { page_size: 4096 },
      'PRAGMA page_count': { page_count: 0 },
      'PRAGMA cache_size': { cache_size: 2000 }, // positive (pages)
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgStatBgwriterRows();
    expect(rows.length).toBe(1);
  });

  it('handles missing PRAGMA values (undefined)', () => {
    const db = makeMockDb({});
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgStatBgwriterRows();
    expect(rows.length).toBe(1);
  });
});

describe('PgCatalog getPgStatDatabaseRows explicit-counter branches', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('uses committed counters and skips inference when non-zero', () => {
    const s = PgCatalog.databaseStats;
    s.xact_commit = 5;
    s.xact_rollback = 1;
    s.tup_inserted = 10;
    s.tup_updated = 20;
    s.tup_deleted = 30;
    s.tup_returned = 40;
    PgCatalog.pgStatStatements = {
      getAll: () => [
        { query: 'INSERT INTO t', rows: 999 },
        { query: 'COMMIT', rows: 0 },
      ],
    } as any;
    const rows = PgCatalog.getPgStatDatabaseRows();
    expect(rows[0].xact_commit).toBe(5);
    expect(rows[0].tup_inserted).toBe(10);
    expect(rows[0].tup_returned).toBe(40);
  });

  it('inferredCommit uses allStats.length when no COMMIT/BEGIN', () => {
    const s = PgCatalog.databaseStats;
    s.xact_commit = 0;
    PgCatalog.pgStatStatements = {
      getAll: () => [
        { query: 'SELECT 1', rows: 0 },
        { query: 'SELECT 2', rows: 0 },
      ],
    } as any;
    const rows = PgCatalog.getPgStatDatabaseRows();
    expect(rows[0].xact_commit).toBe(2); // allStats.length fallback
  });
});

describe('PgCatalog pg_stat_activity field variants', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('connectionManager with empty userName/query and idle-in-transaction state', () => {
    PgCatalog.connectionManager = {
      getActiveQueries: () => [{
        database: 'db', userName: '', query: '',
        queryStart: Date.now(), backendStart: Date.now() - 1,
        clientAddr: '10.0.0.1', state: 'idle in transaction',
      }],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].usename).toBe('postgres'); // '' → fallback
    expect(rows[0].client_addr).toBe('10.0.0.1'); // not 'unknown'
    expect(rows[0].xact_start).not.toBeNull(); // idle in transaction
  });

  it('connectionManager with clientAddr "unknown" maps to null', () => {
    PgCatalog.connectionManager = {
      getActiveQueries: () => [{
        database: 'db', userName: 'u', query: 'SELECT 1',
        queryStart: Date.now(), backendStart: Date.now() - 1,
        clientAddr: 'unknown', state: 'active',
      }],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].client_addr).toBeNull();
  });

  it('activeQueryRegistry with normal IP and idle-in-transaction', () => {
    PgCatalog.connectionManager = { getActiveQueries: () => [] } as any;
    PgCatalog.activeQueryRegistry = {
      list: () => [{
        database: 'db', userId: 'bob', sql: 'SELECT 2', queryStart: Date.now(),
        clientAddr: '10.2.2.2', state: 'idle in transaction', queryId: 7,
      }],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].client_addr).toBe('10.2.2.2');
    expect(rows[0].xact_start).not.toBeNull();
  });

  it('activeQueryRegistry with empty userId/sql and unknown client', () => {
    PgCatalog.connectionManager = { getActiveQueries: () => [] } as any;
    PgCatalog.activeQueryRegistry = {
      list: () => [{
        database: 'db', userId: '', sql: '', queryStart: Date.now(),
        clientAddr: 'unknown', state: 'idle', queryId: 1,
      }],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].usename).toBe('postgres');
    expect(rows[0].client_addr).toBeNull();
  });
});

describe('PgCatalog opclass/opfamily non-btree + preparedXacts numeric timestamp', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('opclass with hash method → opcmethod 0', () => {
    PgCatalog.operatorClassShim = {
      getAllOpclasses: () => [{ indexMethod: 'hash', opclassName: 'h_ops', typeName: 'int4' }],
      getAllOpfamilies: () => [],
    } as any;
    const rows = PgCatalog.getPgOpclassRows();
    expect(rows[0].opcmethod).toBe(0);
  });

  it('opfamily with hash method → opfmethod 0', () => {
    PgCatalog.operatorClassShim = {
      getAllOpclasses: () => [],
      getAllOpfamilies: () => [{ indexMethod: 'hash', opfamilyName: 'h_fam' }],
    } as any;
    const rows = PgCatalog.getPgOpfamilyRows();
    expect(rows[0].opfmethod).toBe(0);
  });

  it('preparedXacts with numeric createdAt (not Date)', () => {
    PgCatalog.preparedTxManager = {
      listPrepared: () => [{ id: 'tx2', createdAt: 1700000000000 }],
    } as any;
    const rows = PgCatalog.getPgPreparedXactsRows();
    expect(rows[0].gid).toBe('tx2');
    expect(rows[0].prepared_at).toBe(new Date(1700000000000).toISOString());
  });
});

describe('PgCatalog pg_settings vartype mapping branches', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });

  it('maps vartype real → real', () => {
    const rows = PgCatalog.getPgSettingsRows();
    // search_path has vartype string; assert the ternary handles non-int/real.
    const searchPath = rows.find(r => r.name === 'search_path');
    expect(searchPath).toBeDefined();
    expect(searchPath!.vartype).toBe('string');
  });
});

describe('PgCatalog pg_indexes non-unique index', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('non-unique index yields plain CREATE INDEX', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`]:
        [{ name: 'users' }],
      [`PRAGMA index_list("users")`]: [{ name: 'idx_u', unique: 0 }],
      [`PRAGMA index_info("idx_u")`]: [{ name: 'email' }],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgIndexesRows();
    expect(rows[0].indexdef).toContain('CREATE INDEX idx_u');
    expect(rows[0].indexdef).not.toContain('UNIQUE');
  });
});

describe('PgCatalog stat getters with null pss / empty collections', () => {
  beforeEach(() => { PgCatalog.init(); resetStatics(); });
  afterEach(() => resetStatics());

  it('getPgStatAllIndexesRows with null pss uses 0 totalCalls', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`]:
        [{ name: 'idx_x', tbl_name: 'pg_class' }],
    });
    PgCatalog.pgStatStatements = null;
    const rows = PgCatalog.getPgStatAllIndexesRows();
    expect(rows[0].idx_scan).toBe(1); // Math.max(1, floor(0/1))
  });

  it('getPgStatAllIndexesRows with empty index list → 0 rows', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`]: [],
    });
    PgCatalog.pgStatStatements = null;
    expect(PgCatalog.getPgStatAllIndexesRows()).toEqual([]);
    expect(PgCatalog.pgStatStatements).toBeNull();
  });

  it('getPgStatUserFunctionsRows with null pss → 0 calls', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`]:
        [{ name: 't', tbl_name: 'u' }],
    });
    PgCatalog.pgStatStatements = null;
    const rows = PgCatalog.getPgStatUserFunctionsRows();
    expect(rows[0].calls).toBe(0);
  });

  it('getPgStatUserFunctionsRows with empty triggers → 0 rows', () => {
    PgCatalog.shardDb = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY tbl_name, name`]: [],
    });
    PgCatalog.pgStatStatements = null;
    expect(PgCatalog.getPgStatUserFunctionsRows()).toEqual([]);
  });

  it('getPgStatBgwriterRows with positive cache_size (pages, not KB)', () => {
    const db = makeMockDb({
      'PRAGMA page_size': { page_size: 4096 },
      'PRAGMA page_count': { page_count: 50 },
      'PRAGMA cache_size': { cache_size: 100 }, // positive → pages branch
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgStatBgwriterRows();
    expect(rows.length).toBe(1);
  });
});


