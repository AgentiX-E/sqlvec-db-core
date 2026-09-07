import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PgCatalog } from '../system/PgCatalog';
import { getCurrentDbRef } from '../system/SystemFunctions';

// A minimal in-memory mock of the SQLite DatabaseRef contract. Each prepare()
// returns a statement whose all()/get() is backed by a map keyed on the SQL.
type Row = Record<string, any>;
function makeMockDb(spec: Record<string, Row[] | Row | { rows: Row[]; get?: Row }>) {
  const stmts = new Map<string, any>();
  for (const [sql, v] of Object.entries(spec)) {
    if (Array.isArray(v)) {
      stmts.set(sql, { all: () => v, get: () => (v.length ? v[0] : undefined) });
    } else if (v && 'rows' in v) {
      // Object wrapper form for get-only or explicit rows/get
      stmts.set(sql, {
        all: () => (v as any).rows ?? [],
        get: () => (v as any).get ?? ((v as any).rows?.[0]),
      });
    } else {
      // Single object → get() returns it, all() returns [it]
      stmts.set(sql, { all: () => [v], get: () => v });
    }
  }
  const db: any = {
    name: 'mock.db',
    prepare: (sql: string) => {
      if (stmts.has(sql)) return stmts.get(sql);
      // Fallback: return a matched statement by heuristics (tables/indexes).
      return { all: () => [], get: () => undefined };
    },
    exec: () => {},
  };
  return db;
}

// Isolate static mutable state between tests by resetting what we can.
function resetStatics() {
  PgCatalog.shardDb = null;
  PgCatalog.connectionManager = null;
  PgCatalog.activeQueryRegistry = null;
  PgCatalog.pgStatStatements = null;
  PgCatalog.pgStatCollector = null;
  PgCatalog.preparedTxManager = null;
  PgCatalog.operatorClassShim = null;
  // Reset databaseStats counters to a zeroed baseline.
  const s = PgCatalog.databaseStats;
  s.xact_commit = 0;
  s.xact_rollback = 0;
  s.tup_returned = 0;
  s.tup_fetched = 0;
  s.tup_inserted = 0;
  s.tup_updated = 0;
  s.tup_deleted = 0;
  s.blks_read = 0;
  s.blks_hit = 0;
  s.deadlocks = 0;
  s.temp_files = 0;
  s.temp_bytes = 0;
  s.conflicts = 0;
  s.checkpoints_timed = 0;
  s.checkpoints_req = 0;
  PgCatalog.userTableStats.clear();
  PgCatalog.userIndexStats.clear();
}

describe('PgCatalog shard-backed index/attrdef/sequence getters', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('getPgIndexesRows falls back to static INDEX_ROWS when shardDb is null', () => {
    PgCatalog.shardDb = null;
    const rows = PgCatalog.getPgIndexesRows();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('getPgIndexesRows queries sqlite_master + PRAGMA when shardDb present', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`]:
        [{ name: 'users' }, { name: 'orders' }],
      [`PRAGMA index_list("users")`]: [{ name: 'idx_users_email', unique: 1 }],
      [`PRAGMA index_info("idx_users_email")`]: [{ name: 'email' }],
      [`PRAGMA index_list("orders")`]: [],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgIndexesRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].indexname).toBe('idx_users_email');
    expect(rows[0].indexdef).toContain('UNIQUE INDEX');
  });

  it('getPgAttrdefRows queries PRAGMA table_info for defaults', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`]:
        [{ name: 'users' }],
      [`PRAGMA table_info("users")`]: [
        { name: 'id', type: 'INTEGER', dflt_value: null },
        { name: 'email', type: 'TEXT', dflt_value: 'default@x.com' },
      ],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgAttrdefRows();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('getPgSequencesRows handles sqlite_sequence', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'`]: { name: 'sqlite_sequence' },
      [`SELECT * FROM sqlite_sequence`]: [{ name: 'users', seq: 42 }],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgSequencesRows();
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('PgCatalog pg_stat_activity data sources', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('uses the mock fallback when no data source is set', () => {
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows.length).toBeGreaterThan(0);
  });

  it('prefers connectionManager.getActiveQueries (priority 1)', () => {
    PgCatalog.connectionManager = {
      getActiveQueries: () => [
        {
          database: 'mydb',
          userName: 'alice',
          query: 'SELECT 1',
          queryStart: Date.now(),
          backendStart: Date.now() - 1000,
          clientAddr: '127.0.0.1',
          state: 'active',
        },
      ],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].datname).toBe('mydb');
    expect(rows[0].usename).toBe('alice');
  });

  it('falls back to activeQueryRegistry when connectionManager empty (priority 2)', () => {
    PgCatalog.connectionManager = { getActiveQueries: () => [] } as any;
    PgCatalog.activeQueryRegistry = {
      list: () => [
        {
          database: 'otherdb',
          userId: 'bob',
          sql: 'SELECT 2',
          queryStart: Date.now(),
          clientAddr: 'unknown',
          state: 'idle',
          queryId: 123,
        },
      ],
    } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows[0].datname).toBe('otherdb');
    expect(rows[0].client_addr).toBeNull(); // 'unknown' → null
  });

  it('falls back to mock row when both sources return empty (priority 3)', () => {
    PgCatalog.connectionManager = { getActiveQueries: () => [] } as any;
    PgCatalog.activeQueryRegistry = { list: () => [] } as any;
    const rows = PgCatalog.getPgStatActivityRows();
    expect(rows.length).toBe(1);
    expect(rows[0].datname).toBe('postgres');
  });
});

describe('PgCatalog pg_stat_database inference', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('infers commit/insert/update/delete from PgStatStatements', () => {
    PgCatalog.pgStatStatements = {
      getAll: () => [
        { query: 'COMMIT', rows: 0 },
        { query: 'BEGIN', rows: 0 },
        { query: 'INSERT INTO t VALUES', rows: 5 },
        { query: 'UPDATE t SET', rows: 3 },
        { query: 'DELETE FROM t', rows: 2 },
        { query: 'ROLLBACK', rows: 0 },
      ],
    } as any;
    const rows = PgCatalog.getPgStatDatabaseRows();
    expect(rows[0].xact_commit).toBeGreaterThan(0);
    expect(rows[0].tup_inserted).toBe(5);
    expect(rows[0].tup_updated).toBe(3);
    expect(rows[0].tup_deleted).toBe(2);
  });

  it('uses explicit databaseStats counters when non-zero', () => {
    const s = PgCatalog.databaseStats;
    s.xact_commit = 99;
    s.tup_inserted = 100;
    PgCatalog.pgStatStatements = null;
    const rows = PgCatalog.getPgStatDatabaseRows();
    expect(rows[0].xact_commit).toBe(99);
    expect(rows[0].tup_inserted).toBe(100);
  });
});

describe('PgCatalog pg_stat_bgwriter + prepared xacts + opclass/opfamily', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('getPgStatBgwriterRows reads PRAGMA page_size/page_count', () => {
    const db = makeMockDb({
      'PRAGMA page_size': { page_size: 4096 },
      'PRAGMA page_count': { page_count: 100 },
      'PRAGMA cache_size': { cache_size: -2000 },
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgStatBgwriterRows();
    expect(rows.length).toBe(1);
  });

  it('getPgPreparedXactsRows uses preparedTxManager', () => {
    PgCatalog.preparedTxManager = {
      listPrepared: () => [{ id: 'tx1', createdAt: new Date('2026-01-01T00:00:00Z') }],
    } as any;
    const rows = PgCatalog.getPgPreparedXactsRows();
    expect(rows[0].gid).toBe('tx1');
    expect(rows[0].prepared).toBe(true);
  });

  it('getPgPreparedXactsRows returns [] when no manager', () => {
    PgCatalog.preparedTxManager = null;
    expect(PgCatalog.getPgPreparedXactsRows()).toEqual([]);
  });

  it('getPgOpclassRows uses operatorClassShim', () => {
    PgCatalog.operatorClassShim = {
      getAllOpclasses: () => [{ indexMethod: 'btree', opclassName: 'int4_ops', typeName: 'int4' }],
      getAllOpfamilies: () => [],
    } as any;
    const rows = PgCatalog.getPgOpclassRows();
    expect(rows[0].opcname).toBe('int4_ops');
    expect(rows[0].opcmethod).toBe(403);
  });

  it('getPgOpclassRows returns [] when no shim', () => {
    PgCatalog.operatorClassShim = null;
    expect(PgCatalog.getPgOpclassRows()).toEqual([]);
  });

  it('getPgOpfamilyRows uses operatorClassShim', () => {
    PgCatalog.operatorClassShim = {
      getAllOpclasses: () => [],
      getAllOpfamilies: () => [{ indexMethod: 'btree', opfamilyName: 'integer_ops' }],
    } as any;
    const rows = PgCatalog.getPgOpfamilyRows();
    expect(rows[0].opfname).toBe('integer_ops');
  });
});

describe('PgCatalog trigger/rules/matviews/statall/pgstats getters (shard-backed)', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('getPgTriggerRows parses trigger SQL', () => {
    const db = makeMockDb({
      [`SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name`]: [
        {
          name: 'trg_audit',
          sql: 'CREATE TRIGGER trg_audit AFTER INSERT ON users BEGIN SELECT 1; END',
        },
      ],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgTriggerRows();
    expect(rows.length).toBe(1);
    expect(rows[0].tgname).toBe('trg_audit');
    expect(rows[0].tgtype).toBe(16 | 1); // AFTER(16) + INSERT(1)
  });

  it('getPgRulesRows returns [] when no triggers matched', () => {
    const db = makeMockDb({
      [`SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'`]: [],
    });
    PgCatalog.shardDb = db;
    expect(PgCatalog.getPgRulesRows()).toEqual([]);
  });

  it('getPgMatViewsRows returns [] when no meta table', () => {
    PgCatalog.shardDb = makeMockDb({});
    expect(PgCatalog.getPgMatViewsRows()).toEqual([]);
  });

  it('getPgStatAllIndexesRows returns [] when shardDb null', () => {
    PgCatalog.shardDb = null;
    expect(PgCatalog.getPgStatAllIndexesRows()).toEqual([]);
  });

  it('getPgStatsRows returns [] when no stats table', () => {
    PgCatalog.shardDb = makeMockDb({});
    expect(PgCatalog.getPgStatsRows()).toEqual([]);
  });
});

describe('PgCatalog pg_stat_user_tables / user indexes', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('getPgStatUserTablesRows returns base-table stats', () => {
    const rows = PgCatalog.getPgStatUserTablesRows();
    expect(Array.isArray(rows)).toBe(true);
  });

  it('getPgStatUserIndexesRows returns [] when no shardDb', () => {
    PgCatalog.shardDb = null;
    expect(PgCatalog.getPgStatUserIndexesRows()).toEqual([]);
  });

  it('getPgStatUserIndexesRows queries sqlite_master for indexes', () => {
    const db = makeMockDb({
      [`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name`]:
        [{ name: 'idx_x', tbl_name: 'users' }],
    });
    PgCatalog.shardDb = db;
    const rows = PgCatalog.getPgStatUserIndexesRows();
    expect(rows.length).toBe(1);
    expect(rows[0].indexrelname).toBe('idx_x');
  });
});

describe('PgCatalog buildFromShard', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('no-ops on null db', () => {
    const before = PgCatalog.getClassRows().length;
    PgCatalog.buildFromShard(null);
    expect(PgCatalog.getClassRows().length).toBe(before);
  });

  it('builds dynamic user-table entries from sqlite_master', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND name NOT LIKE 'pg_%' ORDER BY name`]:
        [{ name: 'accounts' }],
      [`PRAGMA table_info('accounts')`]: [
        { name: 'id', type: 'INTEGER', notnull: 1, dflt_value: null },
        { name: 'balance', type: 'REAL', notnull: 0, dflt_value: '0' },
      ],
      [`SELECT COUNT(*) AS cnt FROM "accounts"`]: { cnt: 42 },
    });
    PgCatalog.buildFromShard(db);
    const names = PgCatalog.getClassRows().map(r => r.relname);
    expect(names).toContain('accounts');
    // shardDb is wired for subsequent index/trigger queries
    expect(PgCatalog.shardDb).toBe(db);
  });

  it('wires currentDbRef prepare/exec wrappers for pg_size_* functions', () => {
    let prepared = '';
    let executed = '';
    const db: any = {
      name: 'wire.db',
      prepare: (sql: string) => { prepared = sql; return { all: () => [], get: () => undefined }; },
      exec: (sql: string) => { executed = sql; },
    };
    PgCatalog.buildFromShard(db);
    const ref = getCurrentDbRef();
    expect(ref).not.toBeNull();

    // Exercising the prepare/exec arrow wrappers created inside buildFromShard.
    ref!.prepare('SELECT 1');
    ref!.exec('VACUUM');
    expect(prepared).toBe('SELECT 1');
    expect(executed).toBe('VACUUM');
    // name/path fallback to db.name when present
    expect(ref!.name).toBe('wire.db');
  });

  it('refresh delegates to buildFromShard', () => {
    const db = makeMockDb({
      [`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 2) != '__' AND name NOT LIKE 'pg_%' ORDER BY name`]:
        [],
    });
    PgCatalog.refresh(db);
    expect(PgCatalog.shardDb).toBe(db);
  });
});

describe('PgCatalog io + xact + progress + conversion/aggregate getters', () => {
  beforeEach(() => {
    PgCatalog.init();
    resetStatics();
  });
  afterEach(() => resetStatics());

  it('getPgStatIoAllTablesRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatIoAllTablesRows())).toBe(true);
  });
  it('getPgStatIoAllIndexesRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatIoAllIndexesRows())).toBe(true);
  });
  it('getPgStatXactUserTablesRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatXactUserTablesRows())).toBe(true);
  });
  it('getPgStatReplicationRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatReplicationRows())).toBe(true);
  });
  it('getPgWaitSamplingRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgWaitSamplingRows())).toBe(true);
  });
  it('getPgStatProgressVacuumRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressVacuumRows())).toBe(true);
  });
  it('getPgStatProgressAnalyzeRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressAnalyzeRows())).toBe(true);
  });
  it('getPgStatProgressClusterRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressClusterRows())).toBe(true);
  });
  it('getPgStatProgressIndexRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressIndexRows())).toBe(true);
  });
  it('getPgStatProgressCreateIndexRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressCreateIndexRows())).toBe(true);
  });
  it('getPgStatProgressCopyRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgStatProgressCopyRows())).toBe(true);
  });
  it('getPgConversionRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgConversionRows())).toBe(true);
  });
  it('getPgAggregateRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgAggregateRows())).toBe(true);
  });
  it('getPgAmRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgAmRows())).toBe(true);
  });
  it('getPgCastRows returns array', () => {
    expect(Array.isArray(PgCatalog.getPgCastRows())).toBe(true);
  });
});
