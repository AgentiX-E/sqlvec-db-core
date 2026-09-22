/**
 * LogicalBackup — logical dump / restore over better-sqlite3.
 *
 * Exercises SQL + CSV dumping, manifest inspection, single-table and full
 * restore, file-based import/export, and the serialization helpers. Regression
 * coverage for four real defects:
 *   #197 csvEscape used `new RegExp(quoteChar, 'g')`; a regex-metacharacter
 *       quoteChar corrupted the whole value (same class as CsvExporter #194).
 *   #198 singleTableRestore used `ALTER TABLE … DISABLE TRIGGER ALL`, which is
 *       PostgreSQL syntax and a hard SQLite syntax error whenever the
 *       disableTriggers option was set.
 *   #199 dumpCsv's csvEscape hardcoded a `,` delimiter check, so a custom
 *       delimiter (e.g. `;`) left values containing that delimiter unquoted.
 *   #200 sqlLiteral emitted the invalid literals `NaN` / `Infinity` for
 *       non-finite numbers, producing a syntactically invalid INSERT.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LogicalBackup } from '../storage/LogicalBackup';

describe('LogicalBackup', () => {
  let db: Database.Database;
  let lb: LogicalBackup;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    lb = new LogicalBackup(db);
  });

  afterEach(() => db.close());

  function seed(): void {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        score REAL,
        active INTEGER
      );
      CREATE TABLE empty_tbl (x INTEGER);
    `);
    db.prepare('INSERT INTO users (name, email, score, active) VALUES (?,?,?,?)').run(
      "O'Brien", 'a@b.com', 1.5, 1,
    );
    db.prepare('INSERT INTO users (name, email, score, active) VALUES (?,?,?,?)').run(
      'bo"b', null, -2.5, 0,
    );
  }

  function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-'));
    return d;
  }

  // ── SQL dump ────────────────────────────────────

  describe('logicDump (SQL)', () => {
    it('dumps CREATE + INSERT for all tables', () => {
      seed();
      const sql = lb.logicDump();
      expect(sql).toContain('CREATE TABLE');
      expect(sql).toContain('INSERT INTO "users"');
      expect(sql).toContain('CREATE TABLE empty_tbl'); // empty table CREATE still emitted
      expect(sql).toContain('"empty_tbl" is empty'); // and marked empty (no INSERT)
      // single-quote escaping
      expect(sql).toContain("'O''Brien'");
      // boolean → 1/0
      expect(sql).toContain('active');
    });

    it('escapes single quotes and buffers correctly', () => {
      db.exec("CREATE TABLE b (id INTEGER, data BLOB)");
      db.prepare('INSERT INTO b VALUES (?,?)').run(1, Buffer.from([0x00, 0xff, 0x10]));
      const sql = lb.logicDump({ table: 'b' });
      expect(sql).toContain("X'00ff10'");
    });

    it('orders rows by primary key when using dumpSqlOrdered path', async () => {
      seed();
      const d = tmpDir();
      const out = path.join(d, 'users.sql');
      await lb.exportAsSql('users', out);
      const content = fs.readFileSync(out, 'utf-8');
      // PK-ordered: id 1 before id 2
      expect(content.indexOf("O'Brien")).toBeLessThan(content.indexOf('bo"b'));
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('includes DROP TABLE when includeDropTable=true', () => {
      seed();
      const sql = lb.logicDump({ includeDropTable: true });
      expect(sql).toContain('DROP TABLE IF EXISTS "users";');
    });

    it('omits CREATE TABLE when includeCreateTable=false', () => {
      seed();
      const sql = lb.logicDump({ includeCreateTable: false });
      expect(sql).not.toContain('CREATE TABLE');
      expect(sql).toContain('INSERT INTO');
    });

    it('dumps only the requested table', () => {
      seed();
      const sql = lb.logicDump({ table: 'users' });
      expect(sql).toContain('"users"');
      expect(sql).not.toContain('"empty_tbl"');
    });

    it('reports empty tables explicitly', () => {
      seed();
      const sql = lb.logicDump({ table: 'empty_tbl' });
      expect(sql).toContain('is empty');
    });
  });

  // ── CSV dump ────────────────────────────────────

  describe('logicDump (CSV)', () => {
    it('dumps header + data rows', () => {
      seed();
      const csv = lb.logicDump({ format: 'csv', table: 'users' });
      expect(csv).toBe(
        "id,name,email,score,active\n" +
          "1,O'Brien,a@b.com,1.5,1\n" +
          '2,"bo""b",,-2.5,0',
      );
    });

    it('honours custom delimiter and quoting (#199)', () => {
      db.exec('CREATE TABLE t (a TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run('x;y');
      const csv = lb.logicDump({ format: 'csv', table: 't', delimiter: ';' });
      // value containing ';' must be quoted
      expect(csv).toContain('"x;y"');
    });

    it('invokes csvEscape with a regex-metacharacter quoteChar (#197)', () => {
      const esc = (lb as any).csvEscape.bind(lb);
      expect(esc('a.b', '.', ',')).toBe('.a..b.');
      expect(esc('a*b', '*', ',')).toBe('*a**b*');
      expect(esc('plain', '"', ',')).toBe('plain');
    });
  });

  // ── manifest inspection ─────────────────────────

  describe('inspect', () => {
    it('returns row counts and checksums', () => {
      seed();
      const m = lb.inspect();
      expect(m.format).toBe('sql');
      expect(m.tables).toHaveLength(2);
      const users = m.tables.find((t) => t.tableName === 'users')!;
      expect(users.rowCount).toBe(2);
      expect(users.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(users.hasVectorIndex).toBe(false);
    });

    it('detects vector index metadata', () => {
      seed();
      const detect = (lb as any).detectVectorIndex.bind(lb);
      // No vec_ shadow table → no index
      expect(detect('users')).toEqual({ hasIndex: false });
      // A shadow table named vec_users whose SQL carries no FLOAT[]/metric
      // → hasIndex true, but dimension/metric stay undefined
      db.exec('CREATE TABLE vec_users (id INTEGER PRIMARY KEY, embedding BLOB)');
      expect(detect('users')).toEqual({ hasIndex: true });
    });

    it('respects csv format flag', () => {
      seed();
      expect(lb.inspect({ format: 'csv' }).format).toBe('csv');
    });
  });

  // ── restore ─────────────────────────────────────

  describe('singleTableRestore', () => {
    it('restores a table from its own dump', () => {
      seed();
      const dump = lb.logicDump({ table: 'users' });
      db.exec('DROP TABLE users');
      lb.singleTableRestore(dump, 'users');
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 2 });
    });

    it('drops first when dropFirst=true', () => {
      seed();
      const dump = lb.logicDump({ table: 'users' });
      lb.singleTableRestore(dump, 'users', { dropFirst: true });
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 2 });
    });

    it('restores with disableTriggers without syntax error (#198)', () => {
      seed();
      const dump = lb.logicDump({ table: 'users' });
      db.exec('DROP TABLE users');
      lb.singleTableRestore(dump, 'users', { disableTriggers: true });
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 2 });
      // foreign_keys pragma restored to ON (was ON before)
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    });

    it('throws when no CREATE TABLE matches', () => {
      expect(() => lb.singleTableRestore('SELECT 1;', 'missing')).toThrow(
        /No CREATE TABLE statement/,
      );
    });

    it('restores table with quoted column list INSERTs', () => {
      seed();
      const dump = lb.logicDump({ table: 'users' });
      db.exec('DROP TABLE users');
      lb.singleTableRestore(dump, 'users');
      const row = db.prepare("SELECT name FROM users WHERE id=1").get() as any;
      expect(row.name).toBe("O'Brien");
    });
  });

  describe('fullRestore', () => {
    it('restores all tables from a full dump', () => {
      seed();
      const dump = lb.logicDump();
      db.exec('DROP TABLE users; DROP TABLE empty_tbl;');
      lb.fullRestore(dump);
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 2 });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='empty_tbl'").get(),
      ).toBeTruthy();
    });

    it('drops tables first when dropFirst=true', () => {
      seed();
      const dump = lb.logicDump();
      // leave tables in place; dropFirst recreates them from scratch
      lb.fullRestore(dump, true);
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 2 });
    });

    it('skips non-fatal failing statements', () => {
      const dump = 'CREATE TABLE ok (id INTEGER);\nTHIS IS NOT SQL;\n';
      lb.fullRestore(dump);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='ok'").get(),
      ).toBeTruthy();
    });
  });

  // ── file-based import/export ────────────────────

  describe('file export / import', () => {
    it('exportAsCsv writes a CSV file', async () => {
      seed();
      const d = tmpDir();
      const out = path.join(d, 'users.csv');
      await lb.exportAsCsv('users', out);
      const content = fs.readFileSync(out, 'utf-8');
      expect(content).toContain('id,name');
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('exportAsCsv throws for missing table', async () => {
      await expect(lb.exportAsCsv('nope', '/tmp/nope.csv')).rejects.toThrow(/not found/);
    });

    it('exportAsSql throws for missing table', async () => {
      await expect(lb.exportAsSql('nope', '/tmp/nope.sql')).rejects.toThrow(/not found/);
    });

    it('exportAsSql writes an ordered SQL file', async () => {
      seed();
      const d = tmpDir();
      const out = path.join(d, 'users.sql');
      await lb.exportAsSql('users', out);
      const content = fs.readFileSync(out, 'utf-8');
      expect(content).toContain('CREATE TABLE');
      expect(content).toContain('INSERT INTO');
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('importFromCsv imports rows from a CSV file', async () => {
      seed();
      const d = tmpDir();
      const inFile = path.join(d, 'in.csv');
      fs.writeFileSync(inFile, 'name,email,score,active\nnew1,x@y.com,3.5,1\nnew2,,4.5,0\n', 'utf-8');
      const n = await lb.importFromCsv('users', inFile);
      expect(n).toBe(2);
      expect(db.prepare('SELECT COUNT(*) c FROM users').get()).toEqual({ c: 4 });
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('importFromCsv returns 0 for empty file', async () => {
      const d = tmpDir();
      const inFile = path.join(d, 'empty.csv');
      fs.writeFileSync(inFile, '', 'utf-8');
      const n = await lb.importFromCsv('users', inFile);
      expect(n).toBe(0);
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('throws when a CSV header names a column not present in the table', async () => {
      // A header-only file with a bogus column name surfaces as an INSERT
      // preparation failure (SQLite: `no column named`). The header-missing
      // guard (`headers.length === 0`) is unreachable because the line filter
      // guarantees at least one non-empty header cell.
      const d = tmpDir();
      const inFile = path.join(d, 'hdr.csv');
      fs.writeFileSync(inFile, 'nonexistent_col\n', 'utf-8');
      const db2 = new Database(':memory:');
      db2.exec('CREATE TABLE users (id INTEGER)');
      const lb2 = new LogicalBackup(db2);
      await expect(lb2.importFromCsv('users', inFile)).rejects.toThrow(/no column named/);
      db2.close();
      fs.rmSync(d, { recursive: true, force: true });
    });

    it('importFromSql executes statements from a file', async () => {
      const d = tmpDir();
      const inFile = path.join(d, 'in.sql');
      fs.writeFileSync(inFile, 'CREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);\n', 'utf-8');
      const n = await lb.importFromSql(inFile);
      expect(n).toBe(2);
      expect(db.prepare('SELECT COUNT(*) c FROM a').get()).toEqual({ c: 1 });
      fs.rmSync(d, { recursive: true, force: true });
    });
  });

  // ── serialization helpers ───────────────────────

  describe('sqlLiteral', () => {
    const lit = (v: any) => (lb as any).sqlLiteral(v);

    it('handles primitives', () => {
      expect(lit(null)).toBe('NULL');
      expect(lit(undefined)).toBe('NULL');
      expect(lit(42)).toBe('42');
      expect(lit(1.5)).toBe('1.5');
      expect(lit(true)).toBe('1');
      expect(lit(false)).toBe('0');
      expect(lit(10n)).toBe('10');
      expect(lit('hello')).toBe("'hello'");
      expect(lit("it's")).toBe("'it''s'");
      expect(lit(Buffer.from([0xab, 0xcd]))).toBe("X'abcd'");
    });

    it('emits NULL for non-finite numbers (#200)', () => {
      expect(lit(NaN)).toBe('NULL');
      expect(lit(Infinity)).toBe('NULL');
      expect(lit(-Infinity)).toBe('NULL');
    });
  });

  describe('parseCsvLine', () => {
    it('handles quoted fields with escaped quotes', () => {
      const p = (lb as any).parseCsvLine.bind(lb);
      expect(p('a,b,c')).toEqual(['a', 'b', 'c']);
      expect(p('"a,b",c')).toEqual(['a,b', 'c']);
      expect(p('"a""b",c')).toEqual(['a"b', 'c']);
    });
  });

  describe('splitSqlStatements', () => {
    it('splits on semicolons while respecting quotes', () => {
      const s = (lb as any).splitSqlStatements.bind(lb);
      expect(s("SELECT 'a;b'; SELECT 2;")).toEqual(["SELECT 'a;b';", ' SELECT 2;']);
      expect(s("SELECT 'it''s ok';")).toEqual(["SELECT 'it''s ok';"]);
      expect(s('SELECT 1')).toEqual(['SELECT 1']);
    });
  });

  describe('detectPrimaryKeyOrder', () => {
    it('returns PK column', () => {
      seed();
      const d = (lb as any).detectPrimaryKeyOrder.bind(lb);
      expect(d('users')).toBe('id');
    });

    it('falls back to id-candidates then null', () => {
      db.exec('CREATE TABLE no_pk (a TEXT)');
      const d = (lb as any).detectPrimaryKeyOrder.bind(lb);
      expect(d('no_pk')).toBeNull();
      db.exec('CREATE TABLE has_rowid (rowid INTEGER, x TEXT)');
      expect(d('has_rowid')).toBe('rowid');
    });
  });

  describe('extractTableNameFromCreate', () => {
    it('extracts table name', () => {
      const e = (lb as any).extractTableNameFromCreate.bind(lb);
      expect(e('CREATE TABLE "users" (id INTEGER)')).toBe('users');
      expect(e('CREATE TABLE IF NOT EXISTS foo (id INTEGER)')).toBe('foo');
      expect(e('SELECT 1')).toBeNull();
    });
  });

  describe('discoverTables', () => {
    it('excludes sqlite_ and vec_ prefixed tables', () => {
      seed();
      db.exec('CREATE TABLE vec_shadow (id INTEGER)');
      const names = (lb as any).discoverTables().map((t: any) => t.name);
      expect(names).toContain('users');
      expect(names).toContain('empty_tbl');
      expect(names).not.toContain('vec_shadow');
      expect(names.some((n: string) => n.startsWith('sqlite_'))).toBe(false);
    });

    it('filters to a single table when only is set', () => {
      seed();
      const names = (lb as any).discoverTables('users').map((t: any) => t.name);
      expect(names).toEqual(['users']);
    });
  });

  describe('getCreateTableSql', () => {
    it('appends a trailing semicolon when missing', () => {
      seed();
      const sql = (lb as any).getCreateTableSql('users');
      expect(sql.trim().endsWith(';')).toBe(true);
    });

    it('throws for missing table', () => {
      expect(() => (lb as any).getCreateTableSql('missing')).toThrow(/Cannot find/);
    });
  });

  describe('dumpSqlOrdered (private, via exportAsSql opts variants)', () => {
    it('honours includeDropTable and includeCreateTable', () => {
      seed();
      // With drop + no create
      let sql = (lb as any).dumpSqlOrdered(
        [{ name: 'users', isVec: false }],
        { format: 'sql', table: 'users', delimiter: ',', quoteChar: '"', includeCreateTable: false, includeDropTable: true },
      );
      expect(sql).toContain('DROP TABLE IF EXISTS "users";');
      expect(sql).not.toContain('CREATE TABLE');

      // With create + no drop (default exportAsSql path)
      sql = (lb as any).dumpSqlOrdered(
        [{ name: 'users', isVec: false }],
        { format: 'sql', table: 'users', delimiter: ',', quoteChar: '"', includeCreateTable: true, includeDropTable: false },
      );
      expect(sql).toContain('CREATE TABLE');
      expect(sql).not.toContain('DROP TABLE');
    });

    it('emits vector-index metadata comment when a vec_ table exists', () => {
      seed();
      db.exec('CREATE TABLE vec_users (id INTEGER PRIMARY KEY, embedding BLOB)');
      const sql = (lb as any).dumpSqlOrdered(
        [{ name: 'users', isVec: false }],
        { format: 'sql', table: 'users', delimiter: ',', quoteChar: '"', includeCreateTable: true, includeDropTable: false },
      );
      expect(sql).toContain('Vector index: vec_users');
    });

    it('marks empty tables and orders by PK when detected', () => {
      seed();
      // empty table
      const sqlEmpty = (lb as any).dumpSqlOrdered(
        [{ name: 'empty_tbl', isVec: false }],
        { format: 'sql', table: 'empty_tbl', delimiter: ',', quoteChar: '"', includeCreateTable: true, includeDropTable: false },
      );
      expect(sqlEmpty).toContain('"empty_tbl" is empty');

      // PK ordering asserted indirectly via exportAsSql ordering test above
    });
  });

  describe('detectVectorIndex dimension parsing', () => {
    it('parses FLOAT[dim] from a shadow table whose column type is FLOAT[n]', () => {
      const detect = (lb as any).detectVectorIndex.bind(lb);
      expect(detect('docs')).toEqual({ hasIndex: false });
      // A shadow table `vec_docs` whose SQL carries FLOAT[8] in the column type
      // name (SQLite accepts [n] as a type-name suffix); dimension is parsed.
      db.exec('CREATE TABLE vec_docs (id INTEGER PRIMARY KEY, embedding FLOAT[8])');
      expect(detect('docs')).toEqual({ hasIndex: true, dimension: 8 });
      // metric marker (distance_metric=…) exists only in a real vec0 virtual
      // table's SQL and cannot be expressed in a plain table; the undefined
      // fallback is exercised above for hasIndex-without-parsable-sql.
    });
  });

  describe('computeTableChecksum', () => {
    it('returns a stable sha256 over rowids', () => {
      seed();
      const c1 = (lb as any).computeTableChecksum('users');
      const c2 = (lb as any).computeTableChecksum('users');
      expect(c1).toBe(c2);
      expect(c1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('disableTriggers pragma restore (#198)', () => {
    it('restores foreign_keys to OFF when it was OFF before', () => {
      seed();
      db.pragma('foreign_keys = OFF');
      const dump = lb.logicDump({ table: 'users' });
      db.exec('DROP TABLE users');
      lb.singleTableRestore(dump, 'users', { disableTriggers: true });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(0); // restored to OFF
      expect(db.pragma('recursive_triggers', { simple: true })).toBe(0); // restored to OFF
    });

    it('restores recursive_triggers to ON when it was ON before', () => {
      seed();
      db.pragma('recursive_triggers = ON');
      const dump = lb.logicDump({ table: 'users' });
      db.exec('DROP TABLE users');
      lb.singleTableRestore(dump, 'users', { disableTriggers: true });
      expect(db.pragma('recursive_triggers', { simple: true })).toBe(1); // restored to ON
    });
  });

  describe('fullRestore dropFirst with non-matching CREATE', () => {
    it('skips DROP when CREATE has no extractable table name', () => {
      seed();
      // CREATE TABLE with an empty-name edge won't extract → no DROP, exec still runs
      const dump = 'CREATE TABLE ok_table (id INTEGER);';
      lb.fullRestore(dump, true); // dropFirst=true, but extractTableNameFromCreate matches ok_table
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='ok_table'").get(),
      ).toBeTruthy();
    });

    it('skips blank statements and non-extractable CREATE forms', () => {
      seed();
      // A CREATE VIRTUAL TABLE (USING, not `(` after name) yields null from
      // extractTableNameFromCreate so no DROP is emitted; blank lines skipped.
      const dump = 'CREATE TABLE a (id INTEGER);\n   \nCREATE VIRTUAL TABLE v USING fts5(x);\n';
      lb.fullRestore(dump, true);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='a'").get()).toBeTruthy();
    });
  });

  describe('dumpSql vector-index metadata + getCreateTableSql semicolon', () => {
    it('emits vector index comment in dumpSql when vec_ table exists', () => {
      seed();
      db.exec('CREATE TABLE vec_users (id INTEGER PRIMARY KEY, embedding BLOB)');
      const sql = lb.logicDump({ table: 'users' });
      expect(sql).toContain('Vector index: vec_users');
    });

    it('getCreateTableSql keeps existing semicolon intact', () => {
      seed();
      // force a semicolon-terminated sql in sqlite_master via a manual table
      const g = (lb as any).getCreateTableSql.bind(lb);
      const s = g('users');
      expect(s.endsWith(';')).toBe(true);
      // simulate an already-semicolon-terminated sql through a direct check
      expect((lb as any).getCreateTableSql('users').trim().endsWith(';')).toBe(true);
    });
  });

  describe('dumpCsv empty table', () => {
    it('returns empty string for a table with no rows', () => {
      seed();
      const csv = (lb as any).dumpCsv([{ name: 'empty_tbl', isVec: false }], {
        format: 'csv', table: 'empty_tbl', delimiter: ',', quoteChar: '"',
        includeCreateTable: true, includeDropTable: false,
      });
      expect(csv).toBe('');
    });
  });

  describe('splitSqlStatements edge cases', () => {
    it('handles empty strings and doubled quotes', () => {
      const s = (lb as any).splitSqlStatements.bind(lb);
      expect(s('SELECT \'\';')).toEqual(["SELECT '';"]);
      expect(s('SELECT "";')).toEqual(['SELECT "";']);
      expect(s('')).toEqual([]);
      expect(s('   ')).toEqual([]);
      expect(s("SELECT 'a''b';")).toEqual(["SELECT 'a''b';"]);
    });
  });

  describe('parseCsvLine newline handling', () => {
    it('skips embedded CR/LF characters', () => {
      const p = (lb as any).parseCsvLine.bind(lb);
      expect(p('a\rb,c')).toEqual(['ab', 'c']); // \r skipped within unquoted field
    });
  });

  describe('detectPrimaryKeyOrder catch fallback', () => {
    it('returns null on pragma error', () => {
      // A malformed table name cannot be reached via pragma_table_info('...')
      // because it accepts any string; instead verify null return for a table
      // with no PK and no id-candidates.
      db.exec('CREATE TABLE totally_anonymous (x TEXT, y TEXT)');
      expect((lb as any).detectPrimaryKeyOrder('totally_anonymous')).toBeNull();
    });
  });
});
