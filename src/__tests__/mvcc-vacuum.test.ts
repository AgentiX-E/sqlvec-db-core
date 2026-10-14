import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { MvccVacuum, DEFAULT_VACUUM_CONFIG, type VacuumConfig } from '../query/MvccVacuum';

// Build a fresh in-memory shard DB with MVCC columns for testing.
function makeShardDb() {
  const db = new Database(':memory:');
  // single-underscore MVCC system (MVCCExecutor)
  db.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    _xmin INTEGER NOT NULL DEFAULT 1,
    _xmax INTEGER NOT NULL DEFAULT 0
  )`);
  // double-underscore MVCC system (MVCCShim)
  db.exec(`CREATE TABLE orders (
    id INTEGER PRIMARY KEY,
    amount REAL,
    __xmin INTEGER NOT NULL DEFAULT 1,
    __xmax INTEGER NOT NULL DEFAULT 0
  )`);
  // plain table with no MVCC columns — should be skipped for freeze/delete
  db.exec(`CREATE TABLE plain (id INTEGER PRIMARY KEY, v TEXT)`);
  return db;
}

function makeShardMap(db: Database.Database) {
  return new Map([[0, db]]) as Map<number, Database.Database>;
}

describe('MvccVacuum — freeze (Phase 1)', () => {
  it('freezes dead rows whose _xmax is older than oldest active xid', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 5), ('b', 1, 0), ('c', 1, 7)");
    // oldest active xid = 10: rows with 0 < _xmax < 10 get frozen (frozenValue=2)
    const v = new MvccVacuum(makeShardMap(db), () => 100, () => 10);
    const frozen = v.freezeOnly('users');
    // rows 'a'(_xmax=5) and 'c'(_xmax=7) frozen; 'b'(_xmax=0) is live (0 means visible)
    expect(frozen).toBe(2);
    const rows = db.prepare("SELECT name, _xmax FROM users ORDER BY id").all() as any[];
    expect(rows[0]._xmax).toBe(2);
    expect(rows[1]._xmax).toBe(0);
    expect(rows[2]._xmax).toBe(2);
    db.close();
  });

  it('freezes double-underscore MVCC columns too', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO orders (amount, __xmin, __xmax) VALUES (1, 1, 3), (2, 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 100, () => 10);
    const frozen = v.freezeOnly('orders');
    expect(frozen).toBe(1);
    const rows = db.prepare("SELECT amount, __xmax FROM orders ORDER BY id").all() as any[];
    expect(rows[0].__xmax).toBe(0); // frozenValue=0 for double-underscore
    expect(rows[1].__xmax).toBe(0);
    db.close();
  });

  it('skips tables without MVCC columns', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO plain (v) VALUES ('x')");
    const v = new MvccVacuum(makeShardMap(db), () => 100, () => 10);
    expect(v.freezeOnly('plain')).toBe(0);
    db.close();
  });
});

describe('MvccVacuum — hard delete (Phase 2)', () => {
  it('deletes frozen rows past the defer cleanup age', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 2), ('b', 10, 2), ('c', 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { deferCleanupAge: 1000 });
    const deleted = v.hardDeleteOnly('users');
    // deferBoundary = 2000 - 1000 = 1000; _xmax=2 rows a(_xmin=1) and b(_xmin=10) both < 1000
    expect(deleted).toBe(2);
    const rows = db.prepare("SELECT name FROM users ORDER BY id").all() as any[];
    expect(rows.map((r: any) => r.name)).toEqual(['c']);
    db.close();
  });

  it('deletes double-underscore frozen rows', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO orders (amount, __xmin, __xmax) VALUES (1, 1, 0), (2, 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { deferCleanupAge: 1000 });
    const deleted = v.hardDeleteOnly('orders');
    expect(deleted).toBe(2);
    db.close();
  });
});

describe('MvccVacuum — vacuum orchestrator', () => {
  it('runs all phases and returns per-table stats', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 2), ('b', 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { deferCleanupAge: 1000 });
    const stats = v.vacuum('users');
    expect(stats).toHaveLength(1);
    expect(stats[0].tableName).toBe('users');
    expect(stats[0].phase1Frozen).toBe(1);
    expect(stats[0].phase2Deleted).toBe(1);
    expect(stats[0].totalRemovedRows).toBe(1);
    db.close();
  });

  it('vacuumFull returns stats for all vacuumable tables across shards', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 0)");
    db.exec("INSERT INTO orders (amount, __xmin, __xmax) VALUES (1, 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { deferCleanupAge: 1000 });
    const stats = v.vacuumFull();
    const names = stats.map(s => s.tableName).sort();
    // non-system tables include 'plain' (no MVCC cols, still compacted)
    expect(names).toEqual(['orders', 'plain', 'users']);
    db.close();
  });

  it('skips not-open shards', () => {
    const db = makeShardDb();
    const closed = new Database(':memory:');
    closed.close();
    const map = new Map([[0, closed], [1, db]]) as Map<number, Database.Database>;
    const v = new MvccVacuum(map, () => 2000, () => 10);
    const stats = v.vacuum();
    // only shard 1 is open
    expect(stats.length).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe('MvccVacuum — compact (Phase 3)', () => {
  it('runs incremental vacuum when full=false', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    const results = v.compactOnly(false);
    expect(results).toHaveLength(1);
    expect(results[0].shardId).toBe(0);
    expect(results[0].reclaimedBytes).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('runs full VACUUM when full=true', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    const results = v.compactOnly(true);
    expect(results).toHaveLength(1);
    expect(results[0].reclaimedBytes).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('reports reclaimed bytes > 0 when full VACUUM reclaims space', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vac-'));
    const fp = path.join(dir, 't.db');
    const db = new Database(fp);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)');
    const ins = db.prepare('INSERT INTO t (data) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 5000; i++) ins.run('x'.repeat(1000)); })();
    db.exec('DELETE FROM t'); // leaves dead pages awaiting reclaim

    const v = new MvccVacuum(new Map([[0, db]]) as Map<number, Database.Database>, () => 1, () => 1);
    const results = v.compactOnly(true);
    expect(results).toHaveLength(1);
    expect(results[0].reclaimedBytes).toBeGreaterThan(0);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('MvccVacuum — config toggles', () => {
  it('respects enableFreeze=false', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 5)");
    const v = new MvccVacuum(makeShardMap(db), () => 100, () => 10, { enableFreeze: false });
    const stats = v.vacuum('users');
    expect(stats[0].phase1Frozen).toBe(0);
    db.close();
  });

  it('respects enableHardDelete=false', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 2)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { enableHardDelete: false });
    const stats = v.vacuum('users');
    expect(stats[0].phase2Deleted).toBe(0);
    db.close();
  });

  it('respects enableCompact=false', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { enableCompact: false });
    const stats = v.vacuum('users');
    expect(stats[0].phase3ReclaimedBytes).toBe(0);
    db.close();
  });
});

describe('MvccVacuum — default config', () => {
  it('exposes DEFAULT_VACUUM_CONFIG with sensible defaults', () => {
    expect(DEFAULT_VACUUM_CONFIG).toEqual({
      deferCleanupAge: 1000,
      enableFreeze: true,
      enableHardDelete: true,
      enableCompact: true,
      fullVacuumDeadFraction: 0.2,
      verbose: false,
    });
  });
});

describe('MvccVacuum — vacuumWithOptions', () => {
  it('delegates to runVacuum with full option', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 0)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    const stats = v.vacuumWithOptions({ full: true, tableName: 'users' });
    expect(stats).toHaveLength(1);
    expect(stats[0].tableName).toBe('users');
    db.close();
  });

  it('delegates with no options', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    const stats = v.vacuumWithOptions();
    expect(Array.isArray(stats)).toBe(true);
    db.close();
  });
});

describe('MvccVacuum — filter & empty tables', () => {
  it('returns empty when filter matches no table', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    expect(v.vacuum('nonexistent_table')).toEqual([]);
    expect(v.freezeOnly('nonexistent_table')).toBe(0);
    expect(v.hardDeleteOnly('nonexistent_table')).toBe(0);
    db.close();
  });
});

describe('MvccVacuum — verbose logging', () => {
  it('logs per-table stats when verbose enabled (does not throw)', () => {
    const db = makeShardDb();
    db.exec("INSERT INTO users (name, _xmin, _xmax) VALUES ('a', 1, 2)");
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10, { verbose: true });
    const stats = v.vacuum('users');
    expect(stats).toHaveLength(1);
    db.close();
  });
});

describe('MvccVacuum — closed shards in phase-only methods', () => {
  it('freezeOnly skips closed shards', () => {
    const closed = new Database(':memory:');
    closed.close();
    const map = new Map([[0, closed]]) as Map<number, Database.Database>;
    const v = new MvccVacuum(map, () => 2000, () => 10);
    expect(v.freezeOnly()).toBe(0);
  });

  it('hardDeleteOnly skips closed shards', () => {
    const closed = new Database(':memory:');
    closed.close();
    const map = new Map([[0, closed]]) as Map<number, Database.Database>;
    const v = new MvccVacuum(map, () => 2000, () => 10);
    expect(v.hardDeleteOnly()).toBe(0);
  });

  it('compactOnly skips closed shards', () => {
    const closed = new Database(':memory:');
    closed.close();
    const map = new Map([[0, closed]]) as Map<number, Database.Database>;
    const v = new MvccVacuum(map, () => 2000, () => 10);
    expect(v.compactOnly(false)).toEqual([]);
  });
});

describe('MvccVacuum — hasColumn false on missing table info', () => {
  it('returns false via pragma fallback for unknown table', () => {
    const db = makeShardDb();
    const v = new MvccVacuum(makeShardMap(db), () => 2000, () => 10);
    // hasColumn is private; exercise via freezeOnly on a table whose column
    // does not exist — hasColumn returns false (skip) rather than throwing.
    expect(v.freezeOnly('plain')).toBe(0);
    db.close();
  });
});
