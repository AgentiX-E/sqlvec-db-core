import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createRumShimTable,
  queryRumShim,
  dropRumShim,
  listRumShims,
  detectRumDDL,
  rewriteRumCreateIndex,
} from '../query/RumIndexShim';

describe('RumIndexShim', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  function seedDocs() {
    db.exec(`CREATE TABLE docs (id INTEGER PRIMARY KEY, title TEXT, body TEXT, score REAL)`);
    db.exec(`INSERT INTO docs (title, body, score) VALUES
      ('hello world', 'foo bar baz', 1.5),
      ('goodbye world', 'hello again', 3.0),
      ('hello hello', 'world world world', 2.0)`);
  }

  // ── createRumShimTable ──────────────────────────────────────

  describe('createRumShimTable', () => {
    it('creates FTS5 and metadata tables for a valid config', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title', 'body'],
        orderByColumn: 'score',
      });
      const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_fts_docs_rum'`).get();
      const meta = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_meta_docs_rum'`).get();
      expect(fts).toBeTruthy();
      expect(meta).toBeTruthy();
    });

    it('throws when the original table does not exist', () => {
      expect(() =>
        createRumShimTable(db, {
          tableName: 'missing',
          indexName: 'x',
          indexedColumns: ['a'],
        }),
      ).toThrow(/does not exist/);
    });

    it('throws when no indexed columns exist in the table', () => {
      seedDocs();
      expect(() =>
        createRumShimTable(db, {
          tableName: 'docs',
          indexName: 'x',
          indexedColumns: ['nope'],
        }),
      ).toThrow(/No valid indexed columns/);
    });

    it('skips columns that do not exist but keeps valid ones', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title', 'nonexistent'],
      });
      // FTS table exists with only the valid column
      const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_fts_docs_rum'`).get();
      expect(fts).toBeTruthy();
    });

    it('skips the metadata table when orderByColumn is missing', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title'],
        orderByColumn: 'nope',
      });
      const meta = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_meta_docs_rum'`).get();
      expect(meta).toBeFalsy();
    });

    it('creates sync triggers for the FTS5 index', () => {
      seedDocs();
      createRumShimTable(db, { tableName: 'docs', indexName: 'docs_rum', indexedColumns: ['title'] });
      const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as { name: string }[];
      const names = triggers.map(t => t.name);
      expect(names).toContain('__rum_sync_docs_rum_fts_insert');
      expect(names).toContain('__rum_sync_docs_rum_fts_delete');
      expect(names).toContain('__rum_sync_docs_rum_fts_update');
    });

    it('creates metadata sync triggers when orderByColumn is set', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title'],
        orderByColumn: 'score',
      });
      const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all() as { name: string }[];
      const names = triggers.map(t => t.name);
      expect(names).toContain('__rum_sync_docs_rum_insert');
      expect(names).toContain('__rum_sync_docs_rum_update');
      expect(names).toContain('__rum_sync_docs_rum_delete');
    });

    it('keeps inserted rows searchable via the FTS trigger', () => {
      seedDocs();
      createRumShimTable(db, { tableName: 'docs', indexName: 'docs_rum', indexedColumns: ['title'] });
      db.exec(`INSERT INTO docs (title) VALUES ('brand new word')`);
      const hit = db.prepare(`SELECT rowid FROM __rum_fts_docs_rum WHERE __rum_fts_docs_rum MATCH 'brand'`).all();
      expect(hit.length).toBeGreaterThan(0);
    });
  });

  // ── queryRumShim ────────────────────────────────────────────

  describe('queryRumShim', () => {
    it('searches and ranks by relevance without ordering column', () => {
      seedDocs();
      createRumShimTable(db, { tableName: 'docs', indexName: 'docs_rum', indexedColumns: ['title', 'body'] });
      const rows = queryRumShim(db, 'docs_rum', 'hello');
      // "hello" appears in title of rows 1 and 3, and in body of row 2.
      expect(rows.length).toBe(3);
      expect(rows[0]).toHaveProperty('_rank');
      expect(rows[0]).not.toHaveProperty('_order_value');
    });

    it('joins with the metadata table when ordering column is configured', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title', 'body'],
        orderByColumn: 'score',
      });
      const rows = queryRumShim(db, 'docs_rum', 'world');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]).toHaveProperty('_order_value');
    });

    it('throws when the FTS5 table is missing', () => {
      expect(() => queryRumShim(db, 'nope', 'x')).toThrow(/not found/);
    });

    it('throws when the config is missing despite a name-colliding table', () => {
      // An ordinary table whose name matches the FTS5 prefix but whose SQL is
      // a plain CREATE TABLE (not CREATE VIRTUAL TABLE). The existence check
      // passes, but listRumShims skips it, leaving no matching config.
      db.exec(`CREATE TABLE __rum_fts_x (a INTEGER)`);
      expect(() => queryRumShim(db, 'x', 'hello')).toThrow(/config.*not found/);
    });

    it('resolves index names that need sanitising (e.g. a hyphen)', () => {
      seedDocs();
      createRumShimTable(db, { tableName: 'docs', indexName: 'my-index', indexedColumns: ['title'] });
      const rows = queryRumShim(db, 'my-index', 'hello');
      expect(rows.length).toBeGreaterThan(0);
    });

    it('returns zero rows for a non-matching term', () => {
      seedDocs();
      createRumShimTable(db, { tableName: 'docs', indexName: 'docs_rum', indexedColumns: ['title', 'body'] });
      expect(queryRumShim(db, 'docs_rum', 'zzzzznope').length).toBe(0);
    });
  });

  // ── dropRumShim ─────────────────────────────────────────────

  describe('dropRumShim', () => {
    it('drops FTS5, metadata, and triggers', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title'],
        orderByColumn: 'score',
      });
      dropRumShim(db, 'docs_rum');
      const fts = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_fts_docs_rum'`).get();
      const meta = db.prepare(`SELECT name FROM sqlite_master WHERE name = '__rum_meta_docs_rum'`).get();
      expect(fts).toBeFalsy();
      expect(meta).toBeFalsy();
    });

    it('is a no-op for a nonexistent shim', () => {
      expect(() => dropRumShim(db, 'ghost')).not.toThrow();
    });
  });

  // ── listRumShims ────────────────────────────────────────────

  describe('listRumShims', () => {
    it('returns empty when no shims exist', () => {
      expect(listRumShims(db)).toEqual([]);
    });

    it('lists a shim with table, columns, and ordering column', () => {
      seedDocs();
      createRumShimTable(db, {
        tableName: 'docs',
        indexName: 'docs_rum',
        indexedColumns: ['title', 'body'],
        orderByColumn: 'score',
      });
      const shims = listRumShims(db);
      expect(shims.length).toBe(1);
      expect(shims[0].indexName).toBe('docs_rum');
      expect(shims[0].tableName).toBe('docs');
      expect(shims[0].indexedColumns).toEqual(expect.arrayContaining(['title', 'body']));
      expect(shims[0].orderByColumn).toBe('score');
    });

    it('tolerates a bare FTS5 table with no companion triggers or metadata', () => {
      seedDocs();
      // Manually create a prefix-matching FTS5 table without any sync triggers
      // or metadata table, to exercise the fallback inference paths.
      db.exec(`CREATE VIRTUAL TABLE __rum_fts_bare USING fts5(a, b)`);
      const shims = listRumShims(db);
      const bare = shims.find(s => s.indexName === 'bare');
      expect(bare).toBeTruthy();
      expect(bare!.tableName).toBe('');
      expect(bare!.orderByColumn).toBeUndefined();
    });

    it('tolerates a companion trigger whose SQL does not follow the expected shape', () => {
      seedDocs();
      db.exec(`CREATE VIRTUAL TABLE __rum_fts_odd USING fts5(a, b)`);
      // Triggers with the expected names but SQL bodies that do not match the
      // inference regexes (no "AFTER INSERT ON" / no "CAST(NEW.<col> AS REAL)").
      db.exec(`CREATE TRIGGER __rum_sync_odd_fts_insert AFTER UPDATE ON docs BEGIN SELECT 1; END`);
      db.exec(`CREATE TABLE __rum_meta_odd (rowid INTEGER PRIMARY KEY, order_value REAL)`);
      db.exec(`CREATE TRIGGER __rum_sync_odd_insert AFTER UPDATE ON docs BEGIN SELECT 2; END`);
      const shims = listRumShims(db);
      const odd = shims.find(s => s.indexName === 'odd');
      expect(odd).toBeTruthy();
      // tableName and orderByColumn remain unset because the trigger SQL does
      // not match the expected patterns.
      expect(odd!.tableName).toBe('');
      expect(odd!.orderByColumn).toBeUndefined();
    });
  });

  // ── detectRumDDL ────────────────────────────────────────────

  describe('detectRumDDL', () => {
    it('detects a basic RUM index DDL', () => {
      expect(detectRumDDL('CREATE INDEX idx ON t USING rum (a)')).toBe(true);
    });

    it('detects UNIQUE and IF NOT EXISTS variants', () => {
      expect(detectRumDDL('CREATE UNIQUE INDEX idx ON t USING rum (a)')).toBe(true);
      expect(detectRumDDL('CREATE INDEX IF NOT EXISTS idx ON t USING rum (a)')).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(detectRumDDL('create index idx on t using rum (a)')).toBe(true);
    });

    it('rejects non-RUM index DDL', () => {
      expect(detectRumDDL('CREATE INDEX idx ON t USING gin (a)')).toBe(false);
      expect(detectRumDDL('SELECT * FROM t')).toBe(false);
    });

    it('detects quoted identifiers', () => {
      expect(detectRumDDL('CREATE INDEX "my index" ON "my table" USING rum ("col a")')).toBe(true);
    });

    it('detects backtick-quoted identifiers', () => {
      expect(detectRumDDL('CREATE INDEX `idx` ON `t` USING rum (`a`)')).toBe(true);
    });
  });

  // ── rewriteRumCreateIndex ───────────────────────────────────

  describe('rewriteRumCreateIndex', () => {
    it('returns null for non-RUM DDL', () => {
      expect(rewriteRumCreateIndex('CREATE INDEX idx ON t USING gin (a)')).toBeNull();
      expect(rewriteRumCreateIndex('SELECT 1')).toBeNull();
    });

    it('rewrites a basic RUM index to an FTS5 virtual table', () => {
      const out = rewriteRumCreateIndex('CREATE INDEX idx ON t USING rum (a, b)');
      expect(out).toContain('CREATE VIRTUAL TABLE');
      expect(out).toContain('__rum_fts_idx');
      expect(out).toContain("content='t'");
    });

    it('captures the ORDER BY column', () => {
      const out = rewriteRumCreateIndex('CREATE INDEX idx ON t USING rum (a, b ORDER BY a)');
      expect(out).toContain('RUM_ORDER_BY(a)');
    });

    it('strips quotes from identifiers', () => {
      const out = rewriteRumCreateIndex(`CREATE INDEX "idx" ON "t" USING rum ("a")`);
      expect(out).toContain('__rum_fts_idx');
      expect(out).toContain("content='t'");
    });

    it('returns null for empty column lists', () => {
      expect(rewriteRumCreateIndex('CREATE INDEX idx ON t USING rum ()')).toBeNull();
    });

    it('returns null when the column list is unterminated', () => {
      expect(rewriteRumCreateIndex('CREATE INDEX idx ON t USING rum (a')).toBeNull();
    });

    it('rewrites backtick-quoted identifiers', () => {
      const out = rewriteRumCreateIndex('CREATE INDEX `idx` ON `t` USING rum (`a`)');
      expect(out).toContain('__rum_fts_idx');
      expect(out).toContain("content='t'");
    });

    it('rewrites double-quoted identifiers with spaces', () => {
      const out = rewriteRumCreateIndex('CREATE INDEX "my index" ON "my table" USING rum ("col a", b)');
      expect(out).toContain('__rum_fts_my index');
      expect(out).toContain("content='my table'");
      expect(out).toContain('col a, b');
    });
  });
});
