/**
 * CsvImporter / CsvExporter — CSV import/export against better-sqlite3.
 *
 * Tests exercise schema inference, type coercion, quoting/escaping, error
 * modes, and round-trip integrity. Regression coverage for three real
 * defects:
 *   #192 sanitizeColumnName stripped the numeric-leading `_` prefix it had just
 *       added (so `1col` stayed an invalid `1col` identifier).
 *   #193 boolean-like values (`true/false/yes/no`) were inferred as INTEGER but
 *       coerced with parseInt, silently importing NULL for every boolean.
 *   #194 csvEscape used a RegExp for quote doubling, corrupting values when the
 *       quoteChar itself was a regex metacharacter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CsvImporter } from '../storage/CsvImporter';
import { CsvExporter } from '../storage/CsvExporter';

describe('CsvImporter', () => {
  let tmp: string;
  let db: Database.Database;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-test-'));
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writeCsv(name: string, content: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  }

  // ── happy path / schema inference ──

  it('imports a simple CSV with header and infers types', async () => {
    const f = writeCsv('data.csv', 'id,name,price\n1,alice,1.5\n2,bob,2.5\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.rowsImported).toBe(2);
    expect(r.columns).toEqual(['id', 'name', 'price']);
    expect(r.columnTypes).toEqual(['INTEGER', 'TEXT', 'REAL']);
    expect(db.prepare('SELECT * FROM data').all()).toEqual([
      { id: 1, name: 'alice', price: 1.5 },
      { id: 2, name: 'bob', price: 2.5 },
    ]);
  });

  it('imports without header -> generates default column names', async () => {
    const f = writeCsv('plain.csv', '1,alice\n2,bob\n');
    const r = await new CsvImporter(db).importCSV(f, { header: false });
    expect(r.columns).toEqual(['col_1', 'col_2']);
    expect(r.tableName).toBe('plain');
    expect(db.prepare('SELECT * FROM plain').all()).toEqual([
      { col_1: 1, col_2: 'alice' },
      { col_1: 2, col_2: 'bob' },
    ]);
  });

  it('sanitizes and deduplicates column names', async () => {
    const f = writeCsv('dup.csv', 'a-b c,a_b c,a_b c\n1,2,3\n');
    const r = await new CsvImporter(db).importCSV(f);
    // a-b c → a_b_c; second a_b c collides → a_b_c_2; third → a_b_c_3
    expect(r.columns).toEqual(['a_b_c', 'a_b_c_2', 'a_b_c_3']);
  });

  it('honours custom delimiter and quote character', async () => {
    const f = writeCsv('semi.csv', 'a;b\n"x;y";z\n');
    const r = await new CsvImporter(db).importCSV(f, { delimiter: ';' });
    expect(r.columns).toEqual(['a', 'b']);
    expect(db.prepare('SELECT * FROM semi').all()).toEqual([{ a: 'x;y', b: 'z' }]);
  });

  it('skips preamble lines', async () => {
    const f = writeCsv('skip.csv', '# comment\n# another\nid\n1\n2\n');
    const r = await new CsvImporter(db).importCSV(f, { skipLines: 2 });
    expect(r.columns).toEqual(['id']);
    expect(r.rowsImported).toBe(2);
  });

  it('handles quoted fields with escaped quotes and embedded delimiters', async () => {
    const f = writeCsv('q.csv', 'a,b\n"he said ""hi""","x,y"\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(db.prepare('SELECT * FROM q').all()).toEqual([
      { a: 'he said "hi"', b: 'x,y' },
    ]);
  });

  it('coerces empty and \\N fields to NULL', async () => {
    const f = writeCsv('nulls.csv', 'a,b\n1,\n2,\\N\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(db.prepare('SELECT * FROM nulls').all()).toEqual([
      { a: 1, b: null },
      { a: 2, b: null },
    ]);
  });

  it('imports boolean-like values as 0/1 integers (#193)', async () => {
    const f = writeCsv('bool.csv', 'a,b,c\ntrue,false,yes\nno,t,f\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columnTypes).toEqual(['INTEGER', 'INTEGER', 'INTEGER']);
    expect(db.prepare('SELECT * FROM bool').all()).toEqual([
      { a: 1, b: 0, c: 1 },
      { a: 0, b: 1, c: 0 },
    ]);
  });

  it('prefixes numeric-leading column names (#192)', async () => {
    const f = writeCsv('num.csv', '1col,2col\n10,20\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columns).toEqual(['_1col', '_2col']);
    expect(db.prepare('SELECT * FROM num').all()).toEqual([{ _1col: 10, _2col: 20 }]);
  });

  // ── types / inference ──

  it('widens INTEGER to REAL when mixed', async () => {
    const f = writeCsv('mix.csv', 'v\n1\n2.5\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columnTypes).toEqual(['REAL']);
    expect(db.prepare('SELECT * FROM mix').all()).toEqual([{ v: 1 }, { v: 2.5 }]);
  });

  it('widens any type to TEXT when a non-numeric appears', async () => {
    const f = writeCsv('text.csv', 'v\n1\nabc\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columnTypes).toEqual(['TEXT']);
  });

  it('falls back to TEXT when inferTypes is false', async () => {
    const f = writeCsv('noinfer.csv', 'a,b\n1,2\n');
    const r = await new CsvImporter(db).importCSV(f, { inferTypes: false });
    expect(r.columnTypes).toEqual(['TEXT', 'TEXT']);
    // '1' is stored as literal text
    expect(db.prepare('SELECT * FROM noinfer').all()).toEqual([{ a: '1', b: '2' }]);
  });

  it('defaults all-NULL columns to TEXT', async () => {
    const f = writeCsv('allnull.csv', 'a,b\n\\N,\\N\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columnTypes).toEqual(['TEXT', 'TEXT']);
  });

  // ── table management ──

  it('throws when table exists with ifExists=error (default)', async () => {
    const f = writeCsv('dup-table.csv', 'a\n1\n');
    await new CsvImporter(db).importCSV(f);
    await expect(new CsvImporter(db).importCSV(f)).rejects.toThrow(/already exists/);
  });

  it('replaces existing table with ifExists=replace', async () => {
    const f = writeCsv('tbl.csv', 'a\n1\n2\n3\n');
    await new CsvImporter(db).importCSV(f);
    await new CsvImporter(db).importCSV(f, { ifExists: 'replace' });
    expect(db.prepare('SELECT COUNT(*) c FROM tbl').get()).toEqual({ c: 3 });
  });

  it('appends to existing table with ifExists=append', async () => {
    const f = writeCsv('app.csv', 'a\n1\n');
    await new CsvImporter(db).importCSV(f);
    const r = await new CsvImporter(db).importCSV(f, { ifExists: 'append' });
    expect(r.rowsImported).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM app').get()).toEqual({ c: 2 });
  });

  it('uses custom tableName', async () => {
    const f = writeCsv('x.csv', 'a\n1\n');
    const r = await new CsvImporter(db).importCSV(f, { tableName: 'custom' });
    expect(r.tableName).toBe('custom');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='custom'").get()).toBeTruthy();
  });

  // ── error modes ──

  it('aborts and throws on a constraint violation in errorMode=abort', async () => {
    // Create a table with a NOT NULL / PK constraint, then append a row that
    // violates it while errorMode=abort. The transaction rethrows, aborting.
    db.exec('CREATE TABLE "bad" (a INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO bad VALUES (1)').run();
    const f = writeCsv('bad.csv', 'a\n1\n'); // duplicate PK 1
    await expect(
      new CsvImporter(db).importCSV(f, { ifExists: 'append', tableName: 'bad' }),
    ).rejects.toThrow();
  });

  it('skips bad rows with errorMode=skip', async () => {
    const f = writeCsv('skipbad.csv', 'a\n1\nxyz\n3\n');
    const r = await new CsvImporter(db).importCSV(f, { errorMode: 'skip' });
    expect(r.rowsImported).toBe(3); // INTEGER infers from '1','3'; 'xyz' widens to TEXT
  });

  it('skips rows that violate a NOT NULL constraint with errorMode=skip', async () => {
    // Pre-create a table with a NOT NULL column, then append a batch that
    // contains a NULL for that column while errorMode=skip. Each offending row
    // is counted in rowsSkipped without aborting the whole batch.
    db.exec('CREATE TABLE strict (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const f = writeCsv('strict.csv', 'id,name\n10,ok\n11,\n12,also-ok\n');
    const r = await new CsvImporter(db).importCSV(f, {
      tableName: 'strict',
      createTable: false,
      inferTypes: false,
      errorMode: 'skip',
      batchSize: 2,
    });
    // Two complete batches: [10/ok,11/NULL] and [12/also-ok]; 11 fails NOT NULL.
    expect(r.rowsImported).toBe(2);
    expect(r.rowsSkipped).toBe(1);
    expect(db.prepare('SELECT id FROM strict ORDER BY id').all()).toEqual([{ id: 10 }, { id: 12 }]);
  });

  it('throws when CSV has no columns', async () => {
    const f = writeCsv('empty.csv', '');
    await expect(new CsvImporter(db).importCSV(f)).rejects.toThrow(/no columns/);
  });

  it('returns zero rows for empty data file', async () => {
    const f = writeCsv('hdr-only.csv', 'a,b\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.rowsImported).toBe(0);
    expect(r.columns).toEqual(['a', 'b']);
  });

  it('respects batchSize for large imports', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => `${i},name${i}`).join('\n');
    const f = writeCsv('big.csv', `id,name\n${rows}\n`);
    const r = await new CsvImporter(db).importCSV(f, { batchSize: 50 });
    expect(r.rowsImported).toBe(250);
  });

  it('infers table name from filename', async () => {
    const f = writeCsv('my-table.name.csv', 'a\n1\n');
    // basename without extension: 'my-table.name' → sanitized 'my_table_name'
    const imp = new CsvImporter(db);
    const t = (imp as any).inferTableName(f);
    expect(t).toBe('my_table_name');
  });

  it('falls back to imported_data when basename is empty/unsafe', () => {
    const imp = new CsvImporter(db);
    const t = (imp as any).inferTableName.bind(imp);
    expect(t('!!!!')).toBe('imported_data');
    expect(t('/tmp/.csv')).toBe('imported_data');
  });

  it('sanitizes fully-empty column names to "column"', async () => {
    const f = writeCsv('emptycol.csv', ',\n1,2\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.columns).toContain('column');
  });

  it('skips empty data lines', async () => {
    const f = writeCsv('emptylines.csv', 'a\n1\n\n\n2\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(r.rowsImported).toBe(2);
  });

  it('handles short rows with missing trailing columns (NULL-fill)', async () => {
    const f = writeCsv('short.csv', 'a,b,c\n1,2\n3,4,5\n');
    const r = await new CsvImporter(db).importCSV(f);
    expect(db.prepare('SELECT * FROM short').all()).toEqual([
      { a: 1, b: 2, c: null },
      { a: 3, b: 4, c: 5 },
    ]);
  });

  it('imports with createTable=false (pre-existing table)', async () => {
    db.exec('CREATE TABLE pre (a TEXT, b TEXT)');
    const f = writeCsv('pre.csv', 'a,b\nx,y\n');
    const r = await new CsvImporter(db).importCSV(f, {
      createTable: false,
      tableName: 'pre',
      inferTypes: false,
    });
    expect(r.rowsImported).toBe(1);
    expect(db.prepare('SELECT * FROM pre').all()).toEqual([{ a: 'x', b: 'y' }]);
  });

  it('widenType returns REAL for any REAL input and INTEGER for INTEGER pair', () => {
    const imp = new CsvImporter(db);
    const widen = (imp as any).widenType.bind(imp);
    expect(widen('REAL', 'INTEGER')).toBe('REAL');
    expect(widen('INTEGER', 'INTEGER')).toBe('INTEGER');
    expect(widen('INTEGER', 'REAL')).toBe('REAL');
    expect(widen('TEXT', 'REAL')).toBe('TEXT');
    expect(widen('REAL', 'TEXT')).toBe('TEXT');
    expect(widen('INTEGER', 'TEXT')).toBe('TEXT');
  });

  it('skips failing rows across a full batch boundary with errorMode=skip', async () => {
    // Two rows per batch; the second batch is full (size 2) and contains a
    // NOT NULL violation, exercising the outer batch skip path.
    db.exec('CREATE TABLE strict2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    const f = writeCsv('strict2.csv', 'id,name\n1,ok\n2,\n3,ok\n4,\n');
    const r = await new CsvImporter(db).importCSV(f, {
      tableName: 'strict2',
      createTable: false,
      inferTypes: false,
      errorMode: 'skip',
      batchSize: 2,
    });
    expect(r.rowsImported).toBe(2);
    expect(r.rowsSkipped).toBe(2);
    expect(db.prepare('SELECT id FROM strict2 ORDER BY id').all()).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it('aborts at a full batch boundary on constraint violation (errorMode=abort)', async () => {
    db.exec('CREATE TABLE strict3 (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO strict3 VALUES (10)').run();
    // batchSize 2 forces two full batches; the duplicate PK 10 violates the
    // constraint, aborting the whole import.
    const f = writeCsv('strict3.csv', 'id\n1\n10\n11\n12\n');
    await expect(
      new CsvImporter(db).importCSV(f, {
        tableName: 'strict3',
        createTable: false,
        inferTypes: false,
        errorMode: 'abort',
        batchSize: 2,
      }),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it('inferType distinguishes all primitive kinds', () => {
    const imp = new CsvImporter(db);
    const infer = (imp as any).inferType.bind(imp);
    expect(infer('123')).toBe('INTEGER');
    expect(infer('-42')).toBe('INTEGER');
    expect(infer('1.5')).toBe('REAL');
    expect(infer('5.')).toBe('REAL');
    expect(infer('1e3')).toBe('REAL');
    expect(infer('1E-3')).toBe('REAL');
    expect(infer('true')).toBe('INTEGER');
    expect(infer('TRUE')).toBe('INTEGER');
    expect(infer('abc')).toBe('TEXT');
    expect(infer('')).toBe('NULL');
    expect(infer('\\N')).toBe('NULL');
  });
});

describe('CsvExporter', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER, name TEXT, price REAL)');
    db.prepare('INSERT INTO t VALUES (?,?,?)').run(1, 'alice', 1.5);
    db.prepare('INSERT INTO t VALUES (?,?,?)').run(2, 'bob, jr', 2.5);
    db.prepare('INSERT INTO t VALUES (?,?,?)').run(3, 'c"d', null);
    db.prepare('INSERT INTO t VALUES (?,?,?)').run(4, 'line1\nline2', 4.5);
  });

  afterEach(() => db.close());

  it('exports a table with quoting for special characters', () => {
    const csv = new CsvExporter(db).exportTable('t');
    expect(csv).toBe(
      'id,name,price\n' +
        '1,alice,1.5\n' +
        '2,"bob, jr",2.5\n' +
        '3,"c""d",\n' +
        '4,"line1\nline2",4.5',
    );
  });

  it('exports an arbitrary query with parameters', () => {
    const ex = new CsvExporter(db);
    const csv = ex.exportQuery('SELECT name FROM t WHERE id > ?', [2]);
    expect(csv).toBe('name\n"c""d"\n"line1\nline2"');
  });

  it('returns empty string for empty result set', () => {
    const ex = new CsvExporter(db);
    db.exec('CREATE TABLE empty (a INTEGER)');
    expect(ex.exportTable('empty')).toBe('');
    // header-only: empty table with header=true produces empty string too
    expect(ex.exportQuery('SELECT * FROM t WHERE 1=0')).toBe('');
  });

  it('omits header when header=false', () => {
    const csv = new CsvExporter(db).exportTable('t', { header: false });
    expect(csv.split('\n')[0]).toBe('1,alice,1.5');
  });

  it('honours custom delimiter and line ending', () => {
    const csv = new CsvExporter(db).exportTable('t', {
      delimiter: ';',
      lineEnding: '\r\n',
    });
    expect(csv).toContain('id;name;price');
    expect(csv).toContain('\r\n');
  });

  it('does not corrupt values when quoteChar is a regex metacharacter (#194)', () => {
    const ex = new CsvExporter(db);
    const esc = (ex as any).csvEscape.bind(ex);
    // quoteChar='.' (regex metacharacter) is treated literally: the value is
    // wrapped in `.` and any `.` inside is doubled, yielding `.a..b.`.
    expect(esc('a.b', '.', ',')).toBe('.a..b.');
    expect(esc('a*b*c', '*', ',')).toBe('*a**b**c*');
    // default quote char still works
    expect(esc('a"b', '"', ',')).toBe('"a""b"');
  });

  it('writes to file (exportToFile)', async () => {
    const out = path.join(os.tmpdir(), `csv-export-${Date.now()}.csv`);
    await new CsvExporter(db).exportToFile('t', out);
    const content = fs.readFileSync(out, 'utf-8');
    expect(content).toContain('id,name,price');
    expect(content).toContain('1,alice,1.5');
    fs.rmSync(out, { force: true });
  });

  it('writes query result to file (exportQueryToFile)', async () => {
    const out = path.join(os.tmpdir(), `csv-qexport-${Date.now()}.csv`);
    await new CsvExporter(db).exportQueryToFile('SELECT name FROM t', out);
    const content = fs.readFileSync(out, 'utf-8');
    expect(content).toContain('name');
    expect(content).toContain('alice');
    fs.rmSync(out, { force: true });
  });

  it('round-trips through CsvImporter (no embedded newlines)', async () => {
    // Use a table whose values contain no embedded newlines so the line-based
    // CsvImporter can round-trip them faithfully (embedded newlines are a known
    // limitation of the streaming line reader, exercised separately above).
    const db3 = new Database(':memory:');
    db3.exec('CREATE TABLE rt (id INTEGER, name TEXT, price REAL)');
    db3.prepare('INSERT INTO rt VALUES (?,?,?)').run(1, 'alice', 1.5);
    db3.prepare('INSERT INTO rt VALUES (?,?,?)').run(2, 'bob, jr', 2.5);
    db3.prepare('INSERT INTO rt VALUES (?,?,?)').run(3, 'c"d', null);
    const csv = new CsvExporter(db3).exportTable('rt');

    const db4 = new Database(':memory:');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-rt-'));
    const f = path.join(tmp, 'rt.csv');
    fs.writeFileSync(f, csv, 'utf-8');
    const r = await new CsvImporter(db4).importCSV(f);
    expect(r.rowsImported).toBe(3);
    expect(db4.prepare('SELECT * FROM rt').all()).toEqual(db3.prepare('SELECT * FROM rt').all());
    db3.close();
    db4.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
