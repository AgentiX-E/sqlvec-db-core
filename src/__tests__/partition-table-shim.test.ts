/**
 * partition-table-shim.test.ts — Coverage tests for PartitionTableShim.
 *
 * Covers SQL classification/rewriting (create PARTITION BY / PARTITION OF /
 * ATTACH / DETACH / pass-through), partition-info extraction, bound-value
 * parsing, and the real better-sqlite3 shard-table create/drop operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectPartitionDDL,
  handlePartitionDDL,
  _isCreateTablePartitionBy,
  _isCreateTablePartitionOf,
  _extractPartitionType,
  extractPartitionInfo,
  createShardTable,
  dropShardTable,
} from '../query/PartitionTableShim';
import type { ShardTableInfo } from '../query/PartitionTableShim';

let db: Database.Database;
let dbPath: string;

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `sqlvec-partition-${Date.now()}-${Math.random()}.db`);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(dbPath, { force: true });
});

describe('detectPartitionDDL', () => {
  it('returns false for non-string / empty', () => {
    expect(detectPartitionDDL('')).toBe(false);
    expect(detectPartitionDDL('   ')).toBe(false);
    expect(detectPartitionDDL(undefined as any)).toBe(false);
  });

  it('returns false for SQL without PARTITION keyword', () => {
    expect(detectPartitionDDL('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('returns false for PARTITION keyword but non-DDL (identifier)', () => {
    expect(detectPartitionDDL('CREATE TABLE partition_id (id INT)')).toBe(false);
  });

  it('detects CREATE TABLE ... PARTITION BY RANGE', () => {
    expect(detectPartitionDDL('CREATE TABLE t (id INT) PARTITION BY RANGE (id)')).toBe(true);
  });

  it('detects CREATE TABLE ... PARTITION OF', () => {
    expect(detectPartitionDDL('CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (1) TO (10)')).toBe(true);
  });

  it('detects ALTER TABLE ... ATTACH PARTITION', () => {
    expect(detectPartitionDDL('ALTER TABLE t ATTACH PARTITION t_p1')).toBe(true);
  });

  it('detects ALTER TABLE ... DETACH PARTITION', () => {
    expect(detectPartitionDDL('ALTER TABLE t DETACH PARTITION t_p1')).toBe(true);
  });
});

describe('handlePartitionDDL', () => {
  it('returns none for non-string / empty', () => {
    expect(handlePartitionDDL('').operation).toBe('none');
    expect(handlePartitionDDL(undefined as any).operation).toBe('none');
  });

  it('strips PARTITION BY RANGE clause', () => {
    const r = handlePartitionDDL('CREATE TABLE t (id INT) PARTITION BY RANGE (id)');
    expect(r.operation).toBe('create');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('CREATE TABLE t (id INT);');
  });

  it('strips PARTITION BY LIST clause', () => {
    const r = handlePartitionDDL('CREATE TABLE t (id INT) PARTITION BY LIST (id)');
    expect(r.sql).toBe('CREATE TABLE t (id INT);');
  });

  it('strips PARTITION BY HASH clause', () => {
    const r = handlePartitionDDL('CREATE TABLE t (id INT) PARTITION BY HASH (id)');
    expect(r.sql).toBe('CREATE TABLE t (id INT);');
  });

  it('rewrites PARTITION OF to plain CREATE TABLE', () => {
    const r = handlePartitionDDL('CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (1) TO (10)');
    expect(r.operation).toBe('create');
    expect(r.sql).toBe('CREATE TABLE t_p1;');
  });

  it('rewrites quoted PARTITION OF table name', () => {
    const r = handlePartitionDDL('CREATE TABLE "t_p1" PARTITION OF t FOR VALUES IN (1, 2)');
    expect(r.sql).toBe('CREATE TABLE "t_p1";');
  });

  it('suppresses ATTACH PARTITION as no-op', () => {
    const r = handlePartitionDDL('ALTER TABLE t ATTACH PARTITION t_p1 FOR VALUES IN (1)');
    expect(r.operation).toBe('attach');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBeNull();
  });

  it('suppresses DETACH PARTITION as no-op', () => {
    const r = handlePartitionDDL('ALTER TABLE t DETACH PARTITION t_p1');
    expect(r.operation).toBe('detach');
    expect(r.sql).toBeNull();
  });

  it('passes through non-partition DDL', () => {
    const r = handlePartitionDDL('ALTER TABLE t ADD COLUMN x INT');
    expect(r.operation).toBe('none');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('ALTER TABLE t ADD COLUMN x INT');
  });
});

describe('_isCreateTablePartitionBy / _isCreateTablePartitionOf', () => {
  it('returns false for non-string', () => {
    expect(_isCreateTablePartitionBy(undefined as any)).toBe(false);
    expect(_isCreateTablePartitionOf(undefined as any)).toBe(false);
  });

  it('detects PARTITION BY', () => {
    expect(_isCreateTablePartitionBy('CREATE TABLE t (id INT) PARTITION BY RANGE (id)')).toBe(true);
    expect(_isCreateTablePartitionBy('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects PARTITION OF', () => {
    expect(_isCreateTablePartitionOf('CREATE TABLE t_p1 PARTITION OF t')).toBe(true);
    expect(_isCreateTablePartitionOf('CREATE TABLE t (id INT)')).toBe(false);
  });
});

describe('_extractPartitionType', () => {
  it('returns null for non-string', () => {
    expect(_extractPartitionType(undefined as any)).toBeNull();
  });

  it('returns RANGE / LIST / HASH (case-insensitive)', () => {
    expect(_extractPartitionType('CREATE TABLE t (id INT) PARTITION BY RANGE (id)')).toBe('RANGE');
    expect(_extractPartitionType('CREATE TABLE t (id INT) PARTITION BY list (id)')).toBe('LIST');
    expect(_extractPartitionType('CREATE TABLE t (id INT) PARTITION BY HASH (id)')).toBe('HASH');
  });

  it('returns null for non-partition SQL', () => {
    expect(_extractPartitionType('SELECT 1')).toBeNull();
  });
});

describe('extractPartitionInfo', () => {
  it('extracts RANGE attach info', () => {
    const info = extractPartitionInfo(
      'ALTER TABLE parent ATTACH PARTITION child FOR VALUES FROM (1) TO (100)',
    );
    expect(info).not.toBeNull();
    expect(info!.parentTable).toBe('parent');
    expect(info!.partitionName).toBe('child');
    expect(info!.partitionMethod).toBe('RANGE');
    expect(info!.partitionColumn).toBe('');
  });

  it('extracts LIST attach info', () => {
    const info = extractPartitionInfo(
      'ALTER TABLE parent ATTACH PARTITION child FOR VALUES IN (1, 2, 3)',
    );
    expect(info!.partitionMethod).toBe('LIST');
  });

  it('extracts HASH attach info', () => {
    const info = extractPartitionInfo(
      'ALTER TABLE parent ATTACH PARTITION child FOR VALUES WITH (MODULUS 4, REMAINDER 0)',
    );
    expect(info).not.toBeNull();
    expect(info!.partitionMethod).toBe('HASH');
    expect(info!.partitionBounds).toBe('{"modulus":4,"remainder":0}');
  });

  it('extracts RANGE via CREATE TABLE ... PARTITION OF', () => {
    const info = extractPartitionInfo(
      'CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM (1) TO (10)',
    );
    expect(info).not.toBeNull();
    expect(info!.parentTable).toBe('t');
    expect(info!.partitionName).toBe('t_p1');
    expect(info!.partitionMethod).toBe('RANGE');
  });

  it('extracts LIST via PARTITION OF', () => {
    const info = extractPartitionInfo(
      'CREATE TABLE t_p1 PARTITION OF t FOR VALUES IN (1, 2)',
    );
    expect(info!.partitionMethod).toBe('LIST');
  });

  it('returns null for non-partition SQL', () => {
    expect(extractPartitionInfo('SELECT 1')).toBeNull();
  });

  it('returns null when values clause cannot be parsed', () => {
    expect(extractPartitionInfo('ALTER TABLE p ATTACH PARTITION c FOR VALUES SOMETHING')).toBeNull();
  });

  it('returns null when CREATE OF values clause cannot be parsed', () => {
    expect(extractPartitionInfo('CREATE TABLE t_p1 PARTITION OF t FOR VALUES SOMETHING')).toBeNull();
  });

  it('parses string/number/null literals in LIST bounds', () => {
    const info = extractPartitionInfo(
      'CREATE TABLE t_p1 PARTITION OF t FOR VALUES IN (1, \'a\', "b", null, xyz)',
    );
    expect(info).not.toBeNull();
    expect(info!.partitionMethod).toBe('LIST');
    expect(info!.partitionBounds).toBe(
      JSON.stringify({ values: [1, 'a', 'b', null, 'xyz'] }),
    );
  });

  it('parses RANGE literals', () => {
    const info = extractPartitionInfo(
      "CREATE TABLE t_p1 PARTITION OF t FOR VALUES FROM ('a') TO ('b')",
    );
    expect(info!.partitionMethod).toBe('RANGE');
    expect(info!.partitionBounds).toBe(JSON.stringify({ from: 'a', to: 'b' }));
  });
});

describe('createShardTable', () => {
  it('creates RANGE shard with CHECK constraint when column provided', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_p1',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      partitionMethod: 'RANGE',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, '(id INT, name TEXT)');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "t_p1"');
    expect(ddl).toContain('CHECK');
    expect(ddl).toContain('"id" >= 0 AND "id" < 100');
    // Table actually created
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_p1'").all();
    expect(tables.length).toBe(1);
  });

  it('creates RANGE shard without CHECK when no column', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_p2',
      partitionBounds: JSON.stringify({ from: 0, to: 100 }),
      partitionMethod: 'RANGE',
      partitionColumn: '',
    };
    const ddl = createShardTable(db, info, '(id INT)');
    expect(ddl).not.toContain('CHECK');
  });

  it('creates LIST shard with IN constraint', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_l1',
      partitionBounds: JSON.stringify({ values: [1, 2, 3] }),
      partitionMethod: 'LIST',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, '(id INT)');
    expect(ddl).toContain('"id" IN (1, 2, 3)');
  });

  it('creates LIST shard with string/null literals and single-quote escape', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_l2',
      partitionBounds: JSON.stringify({ values: ['a', null, "o'brien"] }),
      partitionMethod: 'LIST',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, '(id TEXT)');
    expect(ddl).toContain("'a', NULL, 'o''brien'");
  });

  it('creates LIST shard without CHECK when no column', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_l3',
      partitionBounds: JSON.stringify({ values: [1, 2] }),
      partitionMethod: 'LIST',
      partitionColumn: '',
    };
    const ddl = createShardTable(db, info, '(id INT)');
    expect(ddl).not.toContain('CHECK');
  });

  it('creates LIST shard when bounds has no values array', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_l4',
      partitionBounds: JSON.stringify({}),
      partitionMethod: 'LIST',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, '(id INT)');
    // bounds.values ?? [] → empty IN clause
    expect(ddl).toContain('"id" IN ()');
  });

  it('creates HASH shard with no CHECK', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_h1',
      partitionBounds: JSON.stringify({ modulus: 4, remainder: 0 }),
      partitionMethod: 'HASH',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, '(id INT)');
    expect(ddl).not.toContain('CHECK');
  });

  it('creates empty table when schema has no parens', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_e1',
      partitionBounds: JSON.stringify({ from: 0, to: 1 }),
      partitionMethod: 'RANGE',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info, 'no-parens-schema');
    expect(ddl).toBe('CREATE TABLE IF NOT EXISTS "t_e1" (__placeholder INTEGER)');
    // Table actually created (placeholder column)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_e1'").all();
    expect(tables.length).toBe(1);
  });

  it('creates empty table when schema omitted', () => {
    const info: ShardTableInfo = {
      parentTable: 't',
      partitionName: 't_e2',
      partitionBounds: JSON.stringify({ from: 0, to: 1 }),
      partitionMethod: 'RANGE',
      partitionColumn: 'id',
    };
    const ddl = createShardTable(db, info);
    expect(ddl).toBe('CREATE TABLE IF NOT EXISTS "t_e2" (__placeholder INTEGER)');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_e2'").all();
    expect(tables.length).toBe(1);
  });
});

describe('dropShardTable', () => {
  it('drops a shard table', () => {
    db.exec('CREATE TABLE "t_drop" (id INT)');
    dropShardTable(db, 't_drop');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t_drop'").all();
    expect(tables.length).toBe(0);
  });
});
