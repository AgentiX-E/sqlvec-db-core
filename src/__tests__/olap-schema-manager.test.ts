import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OLAPSchemaManager } from '../analytics/OLAPSchemaManager';
import { DuckDBAnalyticsManager } from '../analytics/DuckDBAnalyticsManager';
import type { ShardHandle } from '../storage/ShardManager';

/**
 * Tests for OLAPSchemaManager. All DuckDB interaction goes through the
 * injected DuckDBAnalyticsManager, so we mock it (recording raw SQL + returning
 * canned query results) and drive the schema manager through its real logic:
 * table lifecycle, type mapping, checksum verification, and cache handling.
 */

interface MockDuck {
  raw: string[];
  queries: { q: string; result: any[] }[];
  execRaw: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

function makeDuck(available = true): any {
  const m: MockDuck = {
    raw: [],
    queries: [],
    execRaw: vi.fn(async (sql: string) => {
      m.raw.push(sql);
      return { rows: [] };
    }),
    queryRaw: vi.fn(async (sql: string): Promise<any[]> => {
      m.queries.push({ q: sql, result: [] });
      // return empty by default; tests may override via mockResolvedValue
      throw new Error('queryRaw not stubbed for: ' + sql);
    }),
    execute: vi.fn(async (sql: string) => ({ rows: [] })),
  };
  const duck = Object.create(DuckDBAnalyticsManager.prototype) as any;
  Object.defineProperty(duck, 'isAvailable', { get: () => available, configurable: true });
  duck.execRaw = m.execRaw;
  duck.queryRaw = m.queryRaw;
  duck.execute = m.execute;
  (duck as any).__mock = m;
  return duck;
}

describe('OLAPSchemaManager — mapType', () => {
  const mgr = new OLAPSchemaManager(makeDuck());

  const cases: [string, string][] = [
    ['INTEGER', 'BIGINT'],
    ['INT', 'BIGINT'],
    ['INT2', 'SMALLINT'],
    ['INT4', 'INTEGER'],
    ['INT8', 'BIGINT'],
    ['TINYINT', 'TINYINT'],
    ['SMALLINT', 'SMALLINT'],
    ['BIGINT', 'BIGINT'],
    ['REAL', 'FLOAT'],
    ['FLOAT', 'DOUBLE'],
    ['DOUBLE', 'DOUBLE'],
    ['DOUBLE PRECISION', 'DOUBLE'],
    ['NUMERIC', 'DECIMAL(38,10)'],
    ['DECIMAL', 'DECIMAL(38,10)'],
    ['BOOLEAN', 'BOOLEAN'],
    ['TEXT', 'VARCHAR'],
    ['VARCHAR', 'VARCHAR'],
    ['CHAR', 'VARCHAR'],
    ['CLOB', 'VARCHAR'],
    ['BLOB', 'BLOB'],
    ['DATE', 'DATE'],
    ['DATETIME', 'TIMESTAMP'],
    ['TIMESTAMP', 'TIMESTAMP'],
  ];
  for (const [inp, out] of cases) {
    it(`maps ${inp} → ${out}`, () => {
      expect(mgr.mapType(inp)).toBe(out);
    });
  }

  it('falls back to VARCHAR for unknown types', () => {
    expect(mgr.mapType('MYSTERY_TYPE')).toBe('VARCHAR');
  });

  it('strips precision/scale suffix before lookup', () => {
    expect(mgr.mapType('DECIMAL(10,2)')).toBe('DECIMAL(38,10)');
    expect(mgr.mapType('VARCHAR(255)')).toBe('VARCHAR');
    expect(mgr.mapType('numeric(38)')).toBe('DECIMAL(38,10)');
  });
});

describe('OLAPSchemaManager — naming & cache', () => {
  it('resolveTableName returns the DuckDB columnar name (fallback convention)', () => {
    const mgr = new OLAPSchemaManager(makeDuck());
    // No table registered yet → fallback convention
    expect(mgr.resolveTableName(0, 'users')).toBe('olap_shard_0_users');
  });

  it('getMonitoredTables / listOLAPTables / getOLAPTable reflect registrations', () => {
    const mgr = new OLAPSchemaManager(makeDuck());
    expect(mgr.getMonitoredTables(0)).toEqual([]);
    expect(mgr.listOLAPTables()).toEqual([]);
    expect(mgr.getOLAPTable(0, 'users')).toBeUndefined();
  });
});

describe('OLAPSchemaManager — ensureOLAPTable', () => {
  let duck: any;

  beforeEach(() => {
    duck = makeDuck();
    // duckTableExists returns false (no existing table) → forces CREATE
    duck.queryRaw.mockResolvedValue([]);
  });

  it('creates a columnar table + view and caches the definition', async () => {
    const mgr = new OLAPSchemaManager(duck);

    // getTableColumns / getTableRowCount also use queryRaw; return empty columns + count
    // We rely on queryRaw being called multiple times; set a per-call queue.
    const qr = duck.queryRaw;
    qr
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([{ column_name: 'id', data_type: 'BIGINT', is_nullable: 'NO' }]) // getTableColumns
      .mockResolvedValueOnce([{ cnt: 3 }]); // getTableRowCount

    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');

    expect(def.shardId).toBe(0);
    expect(def.sqliteTableName).toBe('users');
    expect(def.duckDBTableName).toBe('olap_shard_0_users');
    expect(def.rowCount).toBe(3);
    expect(def.columns).toEqual([{ name: 'id', type: 'BIGINT', nullable: false }]);

    // CREATE TABLE + CREATE VIEW issued
    expect(duck.__mock.raw.some(s => s.startsWith('CREATE TABLE "olap_shard_0_users"'))).toBe(true);
    expect(duck.__mock.raw.some(s => s.includes('CREATE OR REPLACE VIEW "users"'))).toBe(true);

    // cached: second call returns same instance without new CREATE
    const again = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(again).toBe(def);
    expect(mgr.getMonitoredTables(0)).toEqual(['users']);
  });

  it('returns cached def without re-querying when already registered', async () => {
    const mgr = new OLAPSchemaManager(duck);
    const qr = duck.queryRaw;
    qr
      .mockResolvedValueOnce([{ table_name: 'olap_shard_0_users' }]) // duckTableExists → true (exists)
      .mockResolvedValueOnce([]) // getTableColumns
      .mockResolvedValueOnce([{ cnt: 0 }]); // getTableRowCount

    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    // existing table → no CREATE TABLE issued (only view)
    expect(duck.__mock.raw.some(s => s.startsWith('CREATE TABLE "olap_shard_0_users"'))).toBe(false);
    expect(def).toBeTruthy();
  });
});

describe('OLAPSchemaManager — ensureOLAPTableFromHandle', () => {
  it('sources schema+data from the server SQLite handle (bypasses scanner)', async () => {
    const duck = makeDuck();
    duck.queryRaw.mockResolvedValue([]); // duckTableExists false

    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a'), ('b')");
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    const mgr = new OLAPSchemaManager(duck);
    // getTableColumns via queryRaw (fromHandle reads schema from shard.db pragma)
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([{ column_name: 'id', data_type: 'BIGINT', is_nullable: 'NO' }])
      .mockResolvedValueOnce([{ cnt: 2 }]);

    const def = await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    expect(def.duckDBTableName).toBe('olap_shard_0_users');
    expect(def.rowCount).toBe(2);
    db.close();
  });
});

describe('OLAPSchemaManager — fullSyncTable', () => {
  it('drops, recreates, and returns the new row count', async () => {
    const duck = makeDuck();
    duck.queryRaw.mockResolvedValue([]);

    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    const mgr = new OLAPSchemaManager(duck);
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 5 }]); // row count

    const n = await mgr.fullSyncTable(0, 'users', ':memory:', shard);
    expect(n).toBe(5);
    expect(duck.__mock.raw.some(s => s.startsWith('DROP TABLE IF EXISTS "olap_shard_0_users"'))).toBe(true);
    db.close();
  });
});

describe('OLAPSchemaManager — computeTableChecksum', () => {
  it('returns a SHA256 checksum for a populated table (chunked)', async () => {
    const duck = makeDuck();
    // count = 2, then one chunk of 2 rows, then empty chunk → stop
    duck.execute
      .mockResolvedValueOnce({ rows: [{ cnt: 2 }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] })
      .mockResolvedValueOnce({ rows: [] });

    const mgr = new OLAPSchemaManager(duck);
    const cs = await mgr.computeTableChecksum('olap_shard_0_users');
    expect(cs).not.toBeNull();
    expect(cs!.rowCount).toBe(2);
    expect(cs!.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a checksum of the empty hash for zero rows', async () => {
    const duck = makeDuck();
    duck.execute.mockResolvedValueOnce({ rows: [{ cnt: 0 }] });

    const mgr = new OLAPSchemaManager(duck);
    const cs = await mgr.computeTableChecksum('olap_shard_0_users');
    expect(cs!.rowCount).toBe(0);
    expect(cs!.checksum).toBe(require('node:crypto').createHash('sha256').digest('hex'));
  });

  it('returns null when the DuckDB query throws', async () => {
    const duck = makeDuck();
    duck.execute.mockRejectedValue(new Error('boom'));

    const mgr = new OLAPSchemaManager(duck);
    const cs = await mgr.computeTableChecksum('olap_shard_0_users');
    expect(cs).toBeNull();
  });
});

describe('OLAPSchemaManager — verifyChecksum', () => {
  it('returns false when SQLite and DuckDB row counts differ', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a'), ('b'), ('c')");

    duck.queryRaw.mockResolvedValueOnce([{ cnt: 2 }]); // DuckDB fewer rows

    const mgr = new OLAPSchemaManager(duck);
    const ok = await mgr.verifyChecksum(0, 'users', db);
    expect(ok).toBe(false);
    db.close();
  });

  it('returns true when both row count and content match', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a'), ('b')");

    duck.queryRaw
      .mockResolvedValueOnce([{ cnt: 2 }]) // count matches
      .mockResolvedValueOnce([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]); // duck rows

    const mgr = new OLAPSchemaManager(duck);
    const ok = await mgr.verifyChecksum(0, 'users', db);
    expect(ok).toBe(true);
    db.close();
  });

  it('returns false when content checksum differs despite equal counts', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a'), ('b')");

    duck.queryRaw
      .mockResolvedValueOnce([{ cnt: 2 }]) // count matches
      .mockResolvedValueOnce([{ id: 1, name: 'X' }, { id: 2, name: 'Y' }]); // different content

    const mgr = new OLAPSchemaManager(duck);
    const ok = await mgr.verifyChecksum(0, 'users', db);
    expect(ok).toBe(false);
    db.close();
  });
});

describe('OLAPSchemaManager — refreshScanner', () => {
  it('detaches and re-attaches the scanner schema', async () => {
    const duck = makeDuck();
    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    await mgr.refreshScanner(0, '/tmp/x.db');

    expect(duck.__mock.raw.some(s => s.startsWith('DETACH scanner_shard_0'))).toBe(true);
    expect(duck.__mock.raw.some(s => s.startsWith("ATTACH '/tmp/x.db' AS scanner_shard_0"))).toBe(true);
  });

  it('does not throw when the scanner re-attach fails', async () => {
    const duck = makeDuck();
    duck.execRaw.mockImplementation(async (sql: string) => {
      if (sql.startsWith('ATTACH')) throw new Error('attach boom');
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    await expect(mgr.refreshScanner(0, '/tmp/x.db')).resolves.toBeUndefined();
  });

  it('ignores a DETACH failure (already-not-attached) and still attaches', async () => {
    const duck = makeDuck();
    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('DETACH')) throw new Error('not attached');
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    await mgr.refreshScanner(0, '/tmp/x.db');
    // DETACH fired (and its .catch swallowed the error), ATTACH still issued
    expect(duck.__mock.raw.some(s => s.startsWith('DETACH'))).toBe(true);
    expect(duck.__mock.raw.some(s => s.startsWith('ATTACH'))).toBe(true);
  });
});

describe('OLAPSchemaManager — getTableRowCount failure', () => {
  it('returns 0 when the row-count query throws (table missing)', async () => {
    const duck = makeDuck();
    // duckTableExists → false, columns → [], then row-count query throws
    duck.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('no such table'));

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(def.rowCount).toBe(0);
  });
});

describe('OLAPSchemaManager — view-creation fallback paths', () => {
  it('drops the conflicting table and recreates the view on DROP TABLE error', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    let execCount = 0;
    duck.execRaw.mockImplementation(async (sql: string) => {
      execCount++;
      duck.__mock.raw.push(sql);
      // First CREATE OR REPLACE VIEW → DROP TABLE error
      if (sql.startsWith('CREATE OR REPLACE VIEW')) {
        throw new Error('dependent objects still exist, use DROP TABLE');
      }
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(duck.__mock.raw.some(s => s.startsWith('DROP TABLE IF EXISTS "users"'))).toBe(true);
    expect(duck.__mock.raw.some(s => s.startsWith('CREATE VIEW "users"'))).toBe(true);
  });

  it('tolerates a non-DROP-TABLE view error (logs and continues)', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cnt: 0 }]);

    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('CREATE OR REPLACE VIEW')) {
        throw new Error('some other view error');
      }
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(def).toBeTruthy(); // still returns a def despite the view failure
  });

  it('tolerates a failure even in the DROP TABLE retry path', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('CREATE OR REPLACE VIEW')) {
        throw new Error('dependent objects, use DROP TABLE');
      }
      if (sql.startsWith('CREATE VIEW')) {
        throw new Error('still failing');
      }
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(def).toBeTruthy(); // non-fatal — returns def despite retry failure
  });

  it('ducks a table-existence query failure (returns "not exists" path)', async () => {
    const duck = makeDuck();
    // duckTableExists query throws → returns false → forces CREATE path
    duck.queryRaw
      .mockRejectedValueOnce(new Error('db down')) // duckTableExists catch → false
      .mockResolvedValueOnce([]) // columns (getTableColumns)
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(def).toBeTruthy();
    expect(duck.__mock.raw.some(s => s.startsWith('CREATE TABLE'))).toBe(true);
  });

  it('ducks a column-info query failure (returns empty columns)', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockRejectedValueOnce(new Error('db down')) // getTableColumns catch → []
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(def.columns).toEqual([]);
  });
});

describe('OLAPSchemaManager — resolveTableName with registration', () => {
  it('returns the registered duckDBTableName when present', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([{ table_name: 'olap_shard_0_users' }]) // exists
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    const mgr = new OLAPSchemaManager(duck);
    await mgr.ensureOLAPTable(0, 'users', '/tmp/x.db');
    expect(mgr.resolveTableName(0, 'users')).toBe('olap_shard_0_users');
  });
});

describe('OLAPSchemaManager — verifyChecksum error path', () => {
  it('returns false when the DuckDB query throws', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO users (name) VALUES ('a')");

    duck.queryRaw.mockRejectedValue(new Error('duck boom'));

    const mgr = new OLAPSchemaManager(duck);
    const ok = await mgr.verifyChecksum(0, 'users', db);
    expect(ok).toBe(false);
    db.close();
  });
});

describe('OLAPSchemaManager — ensureOLAPTableFromHandle edge cases', () => {
  it('tolerates view-creation failure in the fromHandle path', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('CREATE OR REPLACE VIEW')) throw new Error('other view error');
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    expect(def).toBeTruthy();
    db.close();
  });

  it('drops the conflicting table and recreates the view in the fromHandle path', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('CREATE OR REPLACE VIEW')) throw new Error('use DROP TABLE');
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    expect(duck.__mock.raw.some(s => s.startsWith('DROP TABLE IF EXISTS "users"'))).toBe(true);
    expect(duck.__mock.raw.some(s => s.startsWith('CREATE VIEW "users"'))).toBe(true);
    db.close();
  });

  it('tolerates a failure even in the fromHandle DROP TABLE retry', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    duck.execRaw.mockImplementation(async (sql: string) => {
      duck.__mock.raw.push(sql);
      if (sql.startsWith('CREATE OR REPLACE VIEW')) throw new Error('use DROP TABLE');
      if (sql.startsWith('CREATE VIEW')) throw new Error('still failing');
      return { rows: [] };
    });

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    expect(def).toBeTruthy(); // non-fatal
    db.close();
  });

  it('returns the cached def without re-reading when already registered', async () => {
    const duck = makeDuck();
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    const shard = { shardId: 0, db, path: ':memory:' } as unknown as ShardHandle;

    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists → false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 0 }]); // row count

    const mgr = new OLAPSchemaManager(duck);
    const def = await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    // Second call hits the cache (this.tables.has(key))
    const again = await mgr.ensureOLAPTableFromHandle(0, 'users', shard);
    expect(again).toBe(def);
    db.close();
  });

  it('throws when the SQLite table has no columns', async () => {
    const duck = makeDuck();
    duck.queryRaw.mockResolvedValue([]); // duckTableExists false

    // Fake shard whose PRAGMA table_info returns zero columns (defensive branch)
    const fakeDb = {
      prepare: () => ({ all: () => [] }),
    } as unknown as Database.Database;
    const shard = { shardId: 0, db: fakeDb, path: ':memory:' } as unknown as ShardHandle;

    const mgr = new OLAPSchemaManager(duck);
    await expect(mgr.ensureOLAPTableFromHandle(0, 'users', shard)).rejects.toThrow(/no columns/);
  });

  it('renders NULL and boolean values as literal NULL / true / false', async () => {
    const duck = makeDuck();
    duck.queryRaw
      .mockResolvedValueOnce([]) // duckTableExists false
      .mockResolvedValueOnce([]) // columns
      .mockResolvedValueOnce([{ cnt: 2 }]); // row count

    // Fake shard whose PRAGMA returns a schema with a nullable + boolean column,
    // and whose SELECT produces rows with null and boolean values (defensive
    // type-rendering branches that real SQLite cannot produce natively).
    const fakeDb = {
      prepare: (sql: string) => {
        if (sql.startsWith('PRAGMA')) {
          return { all: () => [
            { name: 'id', type: 'INTEGER' },
            { name: 'v_null', type: 'TEXT' },
            { name: 'v_bool', type: 'BOOLEAN' },
          ] };
        }
        return { all: () => [
          { id: 1, v_null: null, v_bool: true },
          { id: 2, v_null: undefined, v_bool: false },
        ] };
      },
    } as unknown as Database.Database;
    const shard = { shardId: 0, db: fakeDb, path: ':memory:' } as unknown as ShardHandle;

    const mgr = new OLAPSchemaManager(duck);
    await mgr.ensureOLAPTableFromHandle(0, 't', shard);

    const insert = duck.__mock.raw.find(s => s.startsWith('INSERT INTO "olap_shard_0_t"'));
    expect(insert).toBeDefined();
    expect(insert).toContain('NULL');       // null literal
    expect(insert).toContain('true');       // boolean true
    expect(insert).toContain('false');      // boolean false
  });
});
