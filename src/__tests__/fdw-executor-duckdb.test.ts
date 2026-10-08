import { describe, it, expect, afterEach } from 'vitest';
import Module from 'node:module';
import { FDWExecutor, ForeignTable, ForeignServerConfig } from '../query/FDWExecutor';

// Stub the `require('duckdb')` call in queryDuckdb so we can exercise the
// error and empty-result code paths that are unreachable when the real
// duckdb module is absent.
const proto = Module.prototype;
const originalRequire = proto.require;

function stubDuckdb(allImpl: (sql: string, cb: (err: any, rows: any[]) => void) => void) {
  proto.require = function (id: string) {
    if (id === 'duckdb') {
      return {
        Database: class {
          path: string;
          constructor(path: string) {
            this.path = path;
          }
          all(sql: string, cb: (err: any, rows: any[]) => void) {
            allImpl(sql, cb);
          }
          close() {}
        },
      };
    }
    return originalRequire.apply(this, arguments as any);
  } as any;
}

describe('FDWExecutor (DuckDB backend)', () => {
  afterEach(() => {
    proto.require = originalRequire;
  });

  it('rejects with a SqlVecError when the DuckDB query fails', async () => {
    stubDuckdb((_sql, cb) => cb(new Error('syntax error'), []));
    const fdw = new FDWExecutor();
    const cfg: ForeignServerConfig = { name: 'srv', type: 'duckdb', path: '/tmp/x.duckdb' };
    const table: ForeignTable = { localName: 't', serverConfig: cfg };
    await expect(fdw.executeDuckDB('SELECT * FROM t', table)).rejects.toThrow(/DuckDB query failed/);
  });

  it('returns an empty columns list when no rows are returned', async () => {
    stubDuckdb((_sql, cb) => cb(null, []));
    const fdw = new FDWExecutor();
    const cfg: ForeignServerConfig = { name: 'srv', type: 'duckdb', path: '/tmp/x.duckdb' };
    const table: ForeignTable = { localName: 't', serverConfig: cfg };
    const r = await fdw.executeDuckDB('SELECT * FROM t', table);
    expect(r.rowCount).toBe(0);
    expect(r.columns).toEqual([]);
    expect(r.rows).toEqual([]);
  });

  it('infers columns from the first row', async () => {
    stubDuckdb((_sql, cb) =>
      cb(null, [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]),
    );
    const fdw = new FDWExecutor();
    const cfg: ForeignServerConfig = { name: 'srv', type: 'duckdb', path: '/tmp/x.duckdb' };
    const table: ForeignTable = { localName: 't', serverConfig: cfg };
    const r = await fdw.executeDuckDB('SELECT * FROM t', table);
    expect(r.rowCount).toBe(2);
    expect(r.columns).toEqual(['id', 'name']);
  });

  it('throws a SqlVecError when require duckdb fails', async () => {
    proto.require = function (id: string) {
      if (id === 'duckdb') throw new Error('Cannot find module duckdb');
      return originalRequire.apply(this, arguments as any);
    } as any;
    const fdw = new FDWExecutor();
    const cfg: ForeignServerConfig = { name: 'srv', type: 'duckdb', path: '/tmp/x.duckdb' };
    const table: ForeignTable = { localName: 't', serverConfig: cfg };
    await expect(fdw.executeDuckDB('SELECT * FROM t', table)).rejects.toThrow(
      /DuckDB module is not available/,
    );
  });
});
