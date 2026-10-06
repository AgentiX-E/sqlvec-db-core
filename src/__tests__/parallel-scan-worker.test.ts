import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock better-sqlite3 to capture the prepared SQL and return canned rows.
const prepareMock = vi.fn();
const allMock = vi.fn();
const closeMock = vi.fn();
const pragmaMock = vi.fn();

// When true, the (mocked) Database constructor throws, leaving `db` null.
let constructorThrows = false;

const dbInstance = {
  pragma: pragmaMock,
  prepare: prepareMock,
  close: closeMock,
};

vi.mock('better-sqlite3', () => {
  return {
    default: class MockDatabase {
      constructor() {
        if (constructorThrows) {
          throw new Error('connect failed');
        }
        return dbInstance;
      }
    },
  };
});

import scanChunk, { type ScanWorkerResult } from '../query/parallel-scan-worker';

describe('scanChunk', () => {
  beforeEach(() => {
    prepareMock.mockReset();
    allMock.mockReset();
    closeMock.mockReset();
    pragmaMock.mockReset();
    constructorThrows = false;
  });

  function runTask(overrides: Record<string, unknown> = {}): ScanWorkerResult {
    prepareMock.mockReturnValue({ all: allMock });
    allMock.mockReturnValue([{ a: 1 }, { a: 2 }]);

    return scanChunk({
      dbPath: '/tmp/test.db',
      baseSql: 'SELECT * FROM t',
      params: [],
      startRowId: 1,
      endRowId: 100,
      ...overrides,
    });
  }

  it('introduces a WHERE clause when baseSql has none', () => {
    const r = runTask({ baseSql: 'SELECT * FROM t' });
    expect(r.success).toBe(true);
    expect(r.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(prepareMock).toHaveBeenCalledWith('SELECT * FROM t WHERE rowid >= ? AND rowid <= ?');
  });

  it('appends to an existing WHERE clause', () => {
    runTask({ baseSql: 'SELECT * FROM t WHERE a > ?', params: [5] });
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM t WHERE a > ? AND rowid >= ? AND rowid <= ?',
    );
  });

  it('inserts the predicate BEFORE an ORDER BY clause', () => {
    runTask({ baseSql: 'SELECT * FROM t WHERE a > ? ORDER BY b' });
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM t WHERE a > ? AND rowid >= ? AND rowid <= ? ORDER BY b',
    );
  });

  it('inserts the predicate BEFORE a GROUP BY clause', () => {
    runTask({ baseSql: 'SELECT * FROM t WHERE a > ? GROUP BY b' });
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM t WHERE a > ? AND rowid >= ? AND rowid <= ? GROUP BY b',
    );
  });

  it('inserts the predicate BEFORE a LIMIT clause', () => {
    runTask({ baseSql: 'SELECT * FROM t LIMIT 10' });
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM t WHERE rowid >= ? AND rowid <= ? LIMIT 10',
    );
  });

  it('inserts the predicate BEFORE a GROUP BY ... HAVING clause', () => {
    runTask({ baseSql: 'SELECT * FROM t GROUP BY a HAVING count(*) > 1' });
    expect(prepareMock).toHaveBeenCalledWith(
      'SELECT * FROM t WHERE rowid >= ? AND rowid <= ? GROUP BY a HAVING count(*) > 1',
    );
  });

  it('passes params plus the rowid bounds in order', () => {
    runTask({ baseSql: 'SELECT * FROM t WHERE a > ?', params: [5, 6], startRowId: 10, endRowId: 20 });
    expect(allMock).toHaveBeenCalledWith(5, 6, 10, 20);
  });

  it('returns a failure result when the database throws', () => {
    prepareMock.mockImplementation(() => {
      throw new Error('no such table');
    });
    const r = scanChunk({
      dbPath: '/tmp/test.db',
      baseSql: 'SELECT * FROM t',
      params: [],
      startRowId: 1,
      endRowId: 100,
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('no such table');
    expect(r.rows).toEqual([]);
    expect(r.rowCount).toBe(0);
  });

  it('reports the retrieved row count and null error on success', () => {
    const r = runTask();
    expect(r.rowCount).toBe(2);
    expect(r.error).toBeNull();
  });

  it('tolerates a close() failure in the finally block', () => {
    closeMock.mockImplementation(() => {
      throw new Error('close failed');
    });
    const r = runTask();
    expect(r.success).toBe(true);
    expect(r.rowCount).toBe(2);
  });

  it('handles an error before the connection is assigned (db stays null)', () => {
    // Force the Database constructor to throw so `db` remains null and the
    // finally block's `if (db)` guard takes the false branch.
    constructorThrows = true;
    const r = runTask();
    expect(r.success).toBe(false);
    expect(r.error).toBe('connect failed');
    expect(r.rows).toEqual([]);
  });
});
