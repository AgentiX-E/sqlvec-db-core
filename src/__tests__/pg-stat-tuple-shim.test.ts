import { describe, it, expect } from 'vitest';
import {
  PgStatTupleShim,
  DEFAULT_PAGE_SIZE,
  PG_STAT_TUPLE_FUNC_RE,
  PG_STAT_TUPLE_FUNCTIONS,
  PG_STAT_TUPLE_FN_MAP,
  detectPgStatTupleFunction,
} from '../query/PgStatTupleShim';

const tableStats = (rowCount: number, pageCount = 0) => ({ rowCount, pageCount });
const indexStats = (rowCount: number, distinctKeys: number) => ({ rowCount, distinctKeys });

describe('PgStatTupleShim.pgstattuple', () => {
  it('returns zeros for an empty/unknown table', () => {
    const r = PgStatTupleShim.pgstattuple('ghost', () => null);
    expect(r.tuple_count).toBe(0);
    expect(r.dead_tuple_count).toBe(0);
    expect(r.dead_tuple_len).toBe(0);
    expect(r.dead_tuple_percent).toBe(0);
    expect(r.tuple_len).toBe(0);
  });

  it('uses provided pageCount when available', () => {
    const r = PgStatTupleShim.pgstattuple('t', () => tableStats(500, 10));
    const expectedLen = 10 * DEFAULT_PAGE_SIZE;
    expect(r.table_len).toBe(expectedLen);
    expect(r.tuple_len).toBe(500 * 128);
    expect(r.tuple_count).toBe(500);
  });

  it('estimates pageCount from rowCount when pageCount is zero', () => {
    const r = PgStatTupleShim.pgstattuple('t', () => tableStats(250, 0));
    // ceil(250 / 100) = 3
    expect(r.table_len).toBe(3 * DEFAULT_PAGE_SIZE);
  });

  it('clamps percent fields to [0, 100] and rounds to 2 decimals', () => {
    // A tiny pageCount with a huge rowCount drives tupleLen >> tableLen.
    const r = PgStatTupleShim.pgstattuple('t', () => tableStats(100000, 1));
    expect(r.tuple_percent).toBeLessThanOrEqual(100);
    expect(r.free_percent).toBeGreaterThanOrEqual(0);
    expect(r.free_space).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(r.tuple_percent * 100)).toBe(true); // rounded to 2dp
  });

  it('computes free space as table_len - tuple_len (clamped to 0)', () => {
    const r = PgStatTupleShim.pgstattuple('t', () => tableStats(0, 0));
    expect(r.free_space).toBeGreaterThanOrEqual(0);
  });
});

describe('PgStatTupleShim.pgstatindex', () => {
  it('defaults to 1000 rows when index stats are missing', () => {
    const r = PgStatTupleShim.pgstatindex('ghost', () => null);
    expect(r.leaf_pages).toBe(Math.ceil(1000 / 100));
    expect(r.version).toBe(4);
    expect(r.root_block_no).toBe(0);
    expect(r.deleted_pages).toBe(0);
    expect(r.empty_pages).toBe(0);
    expect(r.avg_leaf_density).toBe(100);
    expect(r.leaf_fragmentation).toBe(0);
  });

  it('computes internal/leaf pages from row count', () => {
    const r = PgStatTupleShim.pgstatindex('i', () => indexStats(500, 40));
    const leaf = Math.ceil(500 / 100);
    const internal = Math.max(1, Math.ceil(leaf / 100));
    expect(r.leaf_pages).toBe(leaf);
    expect(r.internal_pages).toBe(internal);
    expect(r.index_size).toBe(DEFAULT_PAGE_SIZE * (leaf + internal + 1));
  });

  it('tree_level becomes 2 only when internal pages exceed 1', () => {
    const shallow = PgStatTupleShim.pgstatindex('i', () => indexStats(100, 10));
    expect(shallow.internal_pages).toBe(1);
    expect(shallow.tree_level).toBe(1);
    // A very large index drives internal_pages > 1.
    const deep = PgStatTupleShim.pgstatindex('i', () => indexStats(1_000_000, 1000));
    expect(deep.internal_pages).toBeGreaterThan(1);
    expect(deep.tree_level).toBe(2);
  });
});

describe('PgStatTupleShim.pgRelpages', () => {
  it('returns the real pageCount when positive', () => {
    expect(PgStatTupleShim.pgRelpages('t', () => tableStats(100, 7))).toBe(7);
  });

  it('falls back to an estimate from rowCount', () => {
    expect(PgStatTupleShim.pgRelpages('t', () => tableStats(250, 0))).toBe(3);
  });

  it('returns at least 1 for empty tables', () => {
    expect(PgStatTupleShim.pgRelpages('t', () => null)).toBe(1);
  });
});

describe('PgStatTupleShim.pgstattupleApprox', () => {
  it('mirrors pgstattuple with scanned_percent 100', () => {
    const r = PgStatTupleShim.pgstattupleApprox('t', () => tableStats(300, 4));
    expect(r.scanned_percent).toBe(100);
    expect(r.table_len).toBe(4 * DEFAULT_PAGE_SIZE);
    expect(r.tuple_count).toBe(300);
    expect(r.dead_tuple_count).toBe(0);
  });

  it('estimates page count for zero pageCount', () => {
    const r = PgStatTupleShim.pgstattupleApprox('t', () => tableStats(0, 0));
    expect(r.table_len).toBe(1 * DEFAULT_PAGE_SIZE);
  });
});

describe('PgStatTupleShim.pgstatginindex', () => {
  it('defaults pending tuples to 0 when stats missing', () => {
    const r = PgStatTupleShim.pgstatginindex('g', () => null);
    expect(r.pending_tuples).toBe(0);
    expect(r.pending_pages).toBe(1);
    expect(r.version).toBe(1);
  });

  it('computes pending pages from row count', () => {
    const r = PgStatTupleShim.pgstatginindex('g', () => ({ rowCount: 250 }));
    expect(r.pending_tuples).toBe(250);
    expect(r.pending_pages).toBe(3);
  });
});

describe('PgStatTupleShim.detect', () => {
  it('detects each function name (case-insensitive)', () => {
    expect(PgStatTupleShim.detect("SELECT * FROM pgstattuple('t')")).toBe(true);
    expect(PgStatTupleShim.detect('SELECT pgstatindex')).toBe(false); // needs '('
    expect(PgStatTupleShim.detect("pgstattuple_approx('t')")).toBe(true);
    expect(PgStatTupleShim.detect("PGSTATGININDEX('g')")).toBe(true);
    expect(PgStatTupleShim.detect("pg_relpages('t')")).toBe(true);
  });

  it('does not false-positive on substrings', () => {
    // "pgstattuple_approx" must NOT match the bare "pgstattuple" alt first.
    expect(PgStatTupleShim.detect("SELECT pgstattuple_approx('t')")).toBe(true);
    expect(PgStatTupleShim.detect("SELECT pgstattupleX('t')")).toBe(false);
    expect(PgStatTupleShim.detect('SELECT mypgstattuple FROM x')).toBe(false);
  });

  it('resets lastIndex between calls', () => {
    // Global regex with lastIndex must not carry state between detections.
    expect(PgStatTupleShim.detect("pgstattuple('t')")).toBe(true);
    expect(PgStatTupleShim.detect("pgstattuple('t')")).toBe(true);
  });
});

describe('PgStatTupleShim.evaluate', () => {
  it('returns null for non-matching SQL', () => {
    expect(PgStatTupleShim.evaluate('SELECT 1')).toBeNull();
    expect(PgStatTupleShim.evaluate('')).toBeNull();
  });

  it('evaluates pgstattuple with single and double quotes', () => {
    const a = PgStatTupleShim.evaluate("pgstattuple('t')", () => tableStats(100, 2), () => null);
    expect(a.tuple_count).toBe(100);
    const b = PgStatTupleShim.evaluate('pgstattuple("t")', () => tableStats(50, 1), () => null);
    expect(b.tuple_count).toBe(50);
  });

  it('strips trailing semicolons', () => {
    const a = PgStatTupleShim.evaluate("pgstattuple('t');", () => tableStats(10, 1), () => null);
    expect(a.tuple_count).toBe(10);
  });

  it('evaluates pgstatindex', () => {
    const r = PgStatTupleShim.evaluate(
      "pgstatindex('i')",
      () => null,
      () => indexStats(200, 10),
    );
    expect(r.leaf_pages).toBe(2);
  });

  it('evaluates pg_relpages', () => {
    const r = PgStatTupleShim.evaluate("pg_relpages('t')", () => tableStats(0, 5), () => null);
    expect(r).toBe(5);
  });

  it('evaluates pgstattuple_approx (disambiguated from pgstattuple)', () => {
    const r = PgStatTupleShim.evaluate(
      "pgstattuple_approx('t')",
      () => tableStats(100, 2),
      () => null,
    );
    expect(r.scanned_percent).toBe(100);
  });

  it('evaluates pgstatginindex', () => {
    const r = PgStatTupleShim.evaluate("pgstatginindex('g')", () => null, () => ({ rowCount: 150 }));
    expect(r.pending_tuples).toBe(150);
  });

  it('is case-insensitive', () => {
    const r = PgStatTupleShim.evaluate("PGSTATTUPLE('t')", () => tableStats(7, 1), () => null);
    expect(r.tuple_count).toBe(7);
  });
});

describe('catalog exports', () => {
  it('registers all five functions with correct metadata', () => {
    expect(PG_STAT_TUPLE_FUNCTIONS).toHaveLength(5);
    const names = PG_STAT_TUPLE_FUNCTIONS.map((f) => f.name);
    expect(names).toEqual([
      'pgstattuple',
      'pgstatindex',
      'pg_relpages',
      'pgstattuple_approx',
      'pgstatginindex',
    ]);
    for (const f of PG_STAT_TUPLE_FUNCTIONS) {
      expect(typeof f.name).toBe('string');
      expect(f.argCount).toBe(1);
    }
  });

  it('maps every function name to a callable dispatch fn', () => {
    for (const name of Object.keys(PG_STAT_TUPLE_FN_MAP)) {
      expect(typeof PG_STAT_TUPLE_FN_MAP[name]).toBe('function');
    }
  });

  it('FN_MAP dispatch produces the same result as the static method', () => {
    const viaMap = PG_STAT_TUPLE_FN_MAP['pgstattuple'].call(
      PgStatTupleShim,
      't',
      () => tableStats(10, 2),
    );
    expect(viaMap.tuple_count).toBe(10);
  });

  it('detectPgStatTupleFunction delegates to the shim', () => {
    expect(detectPgStatTupleFunction("pgstattuple('t')")).toBe(true);
    expect(detectPgStatTupleFunction('SELECT 1')).toBe(false);
  });

  it('exposes the func regex', () => {
    expect(PG_STAT_TUPLE_FUNC_RE).toBeInstanceOf(RegExp);
    expect(PG_STAT_TUPLE_FUNC_RE.flags).toContain('i');
  });
});

describe('default callback parameters', () => {
  it('pgstattuple uses the default null stats callback when omitted', () => {
    // No stats callback -> defaults to () => null, yielding all-zero output.
    const r = PgStatTupleShim.pgstattuple('t');
    expect(r.tuple_count).toBe(0);
    expect(r.table_len).toBe(DEFAULT_PAGE_SIZE); // pageCount estimated to 1
  });

  it('pgstatindex uses the default null stats callback when omitted', () => {
    const r = PgStatTupleShim.pgstatindex('i');
    expect(r.leaf_pages).toBe(10); // ceil(1000 / 100)
  });

  it('pgRelpages uses the default null stats callback when omitted', () => {
    expect(PgStatTupleShim.pgRelpages('t')).toBe(1);
  });

  it('pgstattupleApprox uses the default null stats callback when omitted', () => {
    const r = PgStatTupleShim.pgstattupleApprox('t');
    expect(r.tuple_count).toBe(0);
  });

  it('pgstatginindex uses the default null stats callback when omitted', () => {
    const r = PgStatTupleShim.pgstatginindex('g');
    expect(r.pending_tuples).toBe(0);
  });

  it('evaluate uses both default callbacks when omitted', () => {
    expect(PgStatTupleShim.evaluate("pg_relpages('t')")).toBe(1);
    expect(PgStatTupleShim.evaluate("pgstatginindex('g')")).toEqual({
      version: 1,
      pending_pages: 1,
      pending_tuples: 0,
    });
  });

  it('pgstattupleApprox handles a null stats result (?? 0 fallback)', () => {
    const r = PgStatTupleShim.pgstattupleApprox('ghost', () => null);
    expect(r.tuple_count).toBe(0);
    expect(r.table_len).toBe(DEFAULT_PAGE_SIZE);
  });
});
