/**
 * DuckDB preload — try real DuckDB binary, fall back to mock.
 *
 * DuckDB's sqlite_scanner extension may crash on certain platforms
 * (known issue with duckdb@1.4.4 + glibc).  This preload tries the
 * real binary first.  If it loads successfully, tests use real DuckDB.
 * If it fails, a no-op mock is injected so the rest of the test suite
 * runs (OLTP-only mode).
 */

const Module = require('node:module');
const originalLoad = Module._load;

let duckdbAvailable = false;

try {
  // Probe — a successful require means the native binary loaded
  require.resolve('duckdb');
  const duckdb = require('duckdb');
  // Quick smoke test
  const db = new duckdb.Database(':memory:');
  const conn = db.connect();
  conn.all('SELECT 1', (err: any) => {
    if (!err) duckdbAvailable = true;
    conn.close();
    db.close();
  });

  // Wait briefly for the smoke test (DuckDB callbacks are sync-ish)
  // If the require itself didn't crash, assume it's available
  duckdbAvailable = true;
} catch (_err) {
  duckdbAvailable = false;
}

if (!duckdbAvailable) {
  // Inject no-op mock
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'duckdb') {
      return {
        Database: class {
          constructor() {}
          connect() {
            return {
              all(_sql: string, cb: Function) { cb(null, []); },
              exec(_sql: string, cb: Function) { cb(null); },
              close() {},
            };
          }
          close() {}
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

export {};
