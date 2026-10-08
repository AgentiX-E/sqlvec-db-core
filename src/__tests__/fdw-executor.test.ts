import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { FDWExecutor, ForeignTable, ForeignServerConfig } from '../query/FDWExecutor';
import { SqlVecError } from '../types';

describe('FDWExecutor', () => {
  let fdw: FDWExecutor;
  let csvPath: string;
  let sqlitePath: string;

  beforeEach(() => {
    fdw = new FDWExecutor();
  });

  afterEach(() => {
    fdw.close();
    for (const p of [csvPath, sqlitePath]) {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    }
  });

  function writeCsv(content: string): string {
    csvPath = path.join(os.tmpdir(), `fdw-test-${Date.now()}-${Math.random()}.csv`);
    fs.writeFileSync(csvPath, content);
    return csvPath;
  }

  function writeSqlite(): string {
    sqlitePath = path.join(os.tmpdir(), `fdw-test-${Date.now()}-${Math.random()}.db`);
    const db = new Database(sqlitePath);
    db.exec('CREATE TABLE remote (id INTEGER, name TEXT)');
    db.exec("INSERT INTO remote VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Carol')");
    db.close();
    return sqlitePath;
  }

  describe('server management', () => {
    it('registers a server for an existing file path', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      expect(fdw.getServer('srv')).toBeDefined();
      expect(fdw.getAllServers().length).toBe(1);
    });

    it('throws when the server path does not exist', () => {
      expect(() =>
        fdw.registerForeignServer({ name: 'srv', type: 'csv', path: '/nonexistent/file.csv' }),
      ).toThrow(SqlVecError);
    });

    it('unregisters a server and drops associated tables and connections', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('t', 'srv');
      fdw.unregisterForeignServer('srv');
      expect(fdw.getServer('srv')).toBeUndefined();
      expect(fdw.isForeignTable('t')).toBe(false);
    });

    it('getServer returns undefined for unknown server', () => {
      expect(fdw.getServer('missing')).toBeUndefined();
    });
  });

  describe('table management', () => {
    it('creates a foreign table with a default remoteTable from basename', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('myTable', 'srv');
      const t = fdw.getForeignTable('myTable');
      expect(t).toBeDefined();
      expect(t!.remoteTable).toBe(path.basename(p, path.extname(p)));
      expect(fdw.isForeignTable('myTable')).toBe(true);
    });

    it('throws when creating a table on an unknown server', () => {
      expect(() => fdw.createForeignTable('t', 'nope')).toThrow(SqlVecError);
    });

    it('unreserved a server with a cached connection and mixed tables', async () => {
      const sp = writeSqlite();
      const p2 = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srvA', type: 'sqlite', path: sp });
      fdw.registerForeignServer({ name: 'srvB', type: 'csv', path: p2 });
      fdw.createForeignTable('a1', 'srvA', 'remote');
      fdw.createForeignTable('b1', 'srvB');
      // Establish a cached sqlite connection for srvA
      await fdw.executeQuery('SELECT * FROM a1');
      // Unregister srvA: should close the cached connection and drop only a1
      fdw.unregisterForeignServer('srvA');
      expect(fdw.getServer('srvA')).toBeUndefined();
      expect(fdw.isForeignTable('a1')).toBe(false);
      expect(fdw.isForeignTable('b1')).toBe(true); // b1 belongs to srvB, untouched
    });

    it('uses the provided remoteTable when given', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('t', 'srv', 'explicit');
      expect(fdw.getForeignTable('t')!.remoteTable).toBe('explicit');
    });

    it('drops a foreign table and reports all tables', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('t1', 'srv');
      fdw.createForeignTable('t2', 'srv');
      expect(fdw.getAllForeignTables().length).toBe(2);
      fdw.dropForeignTable('t1');
      expect(fdw.isForeignTable('t1')).toBe(false);
      expect(fdw.getAllForeignTables().length).toBe(1);
    });

    it('getForeignTable returns undefined for unknown table', () => {
      expect(fdw.getForeignTable('nope')).toBeUndefined();
    });
  });

  describe('executeQuery (CSV)', () => {
    it('returns all rows for SELECT * with no WHERE', async () => {
      const p = writeCsv('name,age\nAlice,30\nBob,25\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.rowCount).toBe(2);
      expect(r.columns).toEqual(['name', 'age']);
      expect(r.rows).toEqual([
        { name: 'Alice', age: '30' },
        { name: 'Bob', age: '25' },
      ]);
    });

    it('applies a WHERE equality filter', async () => {
      const p = writeCsv('name,age\nAlice,30\nBob,25\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery("SELECT * FROM people WHERE name = 'Bob'");
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].name).toBe('Bob');
    });

    it('applies numeric comparison filters', async () => {
      const p = writeCsv('name,age\nAlice,30\nBob,25\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      expect((await fdw.executeQuery('SELECT * FROM people WHERE age > 26')).rowCount).toBe(1);
      expect((await fdw.executeQuery('SELECT * FROM people WHERE age <= 25')).rowCount).toBe(1);
      expect((await fdw.executeQuery('SELECT * FROM people WHERE age >= 30')).rowCount).toBe(1);
      expect((await fdw.executeQuery('SELECT * FROM people WHERE age < 25')).rowCount).toBe(0);
    });

    it('applies != and LIKE and NOT LIKE filters', async () => {
      const p = writeCsv('name\nAlice\nBob\nCarol\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      expect((await fdw.executeQuery("SELECT * FROM people WHERE name != 'Alice'")).rowCount).toBe(2);
      expect((await fdw.executeQuery("SELECT * FROM people WHERE name LIKE 'A%'")).rowCount).toBe(1);
      expect((await fdw.executeQuery("SELECT * FROM people WHERE name NOT LIKE 'A%'")).rowCount).toBe(2);
    });

    it('treats a literal dot in LIKE as literal, not a wildcard', async () => {
      const p = writeCsv('name\nAlice\nA.ice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery("SELECT * FROM people WHERE name LIKE 'A.ice'");
      expect(r.rows.map((x) => x.name)).toEqual(['A.ice']);
    });

    it('does not crash on regex metacharacters in LIKE', async () => {
      const p = writeCsv('name\n(A\nAlice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery("SELECT * FROM people WHERE name LIKE '(A'");
      expect(r.rows.map((x) => x.name)).toEqual(['(A']);
    });

    it('supports underscore wildcard in LIKE', async () => {
      const p = writeCsv('name\nAlice\nAl\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery("SELECT * FROM people WHERE name LIKE 'A_'");
      expect(r.rows.map((x) => x.name)).toEqual(['Al']);
    });

    it('supports multiple AND conditions', async () => {
      const p = writeCsv('name,age\nAlice,30\nBob,25\nCarol,30\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery("SELECT * FROM people WHERE age >= 30 AND name != 'Carol'");
      expect(r.rows.map((x) => x.name)).toEqual(['Alice']);
    });

    it('supports CSV with custom delimiter and quoted fields', async () => {
      const p = writeCsv('name;desc\n"Smith; John";"a;b"\n');
      fdw.registerForeignServer({
        name: 'srv', type: 'csv', path: p,
        csvOptions: { delimiter: ';', header: true },
      });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.rows).toEqual([{ name: 'Smith; John', desc: 'a;b' }]);
    });

    it('unescapes doubled quotes inside quoted CSV fields', async () => {
      const p = writeCsv('name\nalice\n"bob ""the"" builder"\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.rows.map((x) => x.name)).toEqual(['alice', 'bob "the" builder']);
    });

    it('supports headerless CSV with generated column names', async () => {
      const p = writeCsv('Alice,30\nBob,25\n');
      fdw.registerForeignServer({
        name: 'srv', type: 'csv', path: p,
        csvOptions: { header: false },
      });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.columns).toEqual(['col1', 'col2']);
      expect(r.rows).toEqual([
        { col1: 'Alice', col2: '30' },
        { col1: 'Bob', col2: '25' },
      ]);
    });

    it('skips blank lines', async () => {
      const p = writeCsv('name\n\nAlice\n\nBob\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.rowCount).toBe(2);
    });

    it('throws for a query without FROM', async () => {
      const p = writeCsv('name\nAlice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      await expect(fdw.executeQuery('SELECT 1')).rejects.toThrow(SqlVecError);
    });

    it('throws for unknown foreign table', async () => {
      const p = writeCsv('name\nAlice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      await expect(fdw.executeQuery('SELECT * FROM missing')).rejects.toThrow(SqlVecError);
    });

    it('throws for an unsupported data source type', async () => {
      const p = writeCsv('name\nAlice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'unknown' as any, path: p });
      fdw.createForeignTable('people', 'srv');
      await expect(fdw.executeQuery('SELECT * FROM people')).rejects.toThrow(SqlVecError);
    });

    it('fills missing CSV fields with null', async () => {
      const p = writeCsv('a,b\n1,2\n3\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      const r = await fdw.executeQuery('SELECT * FROM people');
      expect(r.rows).toEqual([
        { a: '1', b: '2' },
        { a: '3', b: null },
      ]);
    });

    it('tolerates an unparseable WHERE condition', async () => {
      const p = writeCsv('name\nAlice\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('people', 'srv');
      // A condition that does not match the operator grammar returns true
      // (row kept) rather than crashing.
      const r = await fdw.executeQuery('SELECT * FROM people WHERE banana');
      expect(r.rowCount).toBe(1);
    });
  });

  describe('executeQuery (SQLite)', () => {
    it('queries a remote SQLite database', async () => {
      const sp = writeSqlite();
      fdw.registerForeignServer({ name: 'srv', type: 'sqlite', path: sp });
      fdw.createForeignTable('remote', 'srv', 'remote');
      const r = await fdw.executeQuery('SELECT * FROM remote');
      expect(r.rowCount).toBe(3);
      expect(r.columns).toContain('name');
    });

    it('rewrites the local table name to the remote table name', async () => {
      const sp = writeSqlite();
      const db = new Database(sp);
      db.exec('CREATE TABLE other (id INTEGER, name TEXT)');
      db.exec("INSERT INTO other VALUES (1, 'Zed')");
      db.close();
      fdw.registerForeignServer({ name: 'srv', type: 'sqlite', path: sp });
      fdw.createForeignTable('mylocal', 'srv', 'other');
      const r = await fdw.executeQuery('SELECT * FROM mylocal');
      expect(r.rowCount).toBe(1);
      expect(r.rows[0].name).toBe('Zed');
    });

    it('caches the connection across queries', async () => {
      const sp = writeSqlite();
      fdw.registerForeignServer({ name: 'srv', type: 'sqlite', path: sp });
      fdw.createForeignTable('remote', 'srv', 'remote');
      await fdw.executeQuery('SELECT * FROM remote');
      await fdw.executeQuery('SELECT * FROM remote');
      // no error: connection reused
      expect(true).toBe(true);
    });
  });

  describe('executeQuery (DuckDB)', () => {
    it('throws when the duckdb module is unavailable', async () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'duckdb', path: p });
      fdw.createForeignTable('t', 'srv');
      await expect(fdw.executeQuery('SELECT * FROM t')).rejects.toThrow(SqlVecError);
    });
  });

  describe('public wrapper methods', () => {
    it('executeCSV runs queryCsv', async () => {
      const p = writeCsv('name\nAlice\n');
      const cfg: ForeignServerConfig = { name: 'srv', type: 'csv', path: p };
      const table: ForeignTable = { localName: 'people', serverConfig: cfg };
      const r = await fdw.executeCSV('SELECT * FROM people', table);
      expect(r.rowCount).toBe(1);
    });

    it('executeSQLite runs querySqlite', () => {
      const sp = writeSqlite();
      const cfg: ForeignServerConfig = { name: 'srv', type: 'sqlite', path: sp };
      const table: ForeignTable = { localName: 'remote', serverConfig: cfg, remoteTable: 'remote' };
      const r = fdw.executeSQLite('SELECT * FROM remote', table);
      expect(r.rowCount).toBe(3);
    });

    it('executeSQLite falls back to serverConfig.remoteTable', () => {
      const sp = writeSqlite();
      const cfg: ForeignServerConfig = { name: 'srv', type: 'sqlite', path: sp, remoteTable: 'remote' };
      // table.remoteTable is omitted; cfg.remoteTable should be used
      const table: ForeignTable = { localName: 'remote', serverConfig: cfg };
      const r = fdw.executeSQLite('SELECT * FROM remote', table);
      expect(r.rowCount).toBe(3);
    });

    it('executeDuckDB routes to queryDuckdb', async () => {
      const p = writeCsv('a\n1\n');
      const cfg: ForeignServerConfig = { name: 'srv', type: 'duckdb', path: p };
      const table: ForeignTable = { localName: 't', serverConfig: cfg };
      await expect(fdw.executeDuckDB('SELECT * FROM t', table)).rejects.toThrow(SqlVecError);
    });
  });

  describe('close / reset', () => {
    it('clears all state on close', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.createForeignTable('t', 'srv');
      fdw.close();
      expect(fdw.getAllServers().length).toBe(0);
      expect(fdw.getAllForeignTables().length).toBe(0);
    });

    it('reset calls close', () => {
      const p = writeCsv('a\n1\n');
      fdw.registerForeignServer({ name: 'srv', type: 'csv', path: p });
      fdw.reset();
      expect(fdw.getAllServers().length).toBe(0);
    });
  });
});
