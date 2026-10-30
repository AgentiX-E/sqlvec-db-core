import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { buildPgFunctions, PgFunctionMap, setBlockingPidsLockMgr } from '../system/PgFunctions';
import {
  setCurrentDbRef,
  type DatabaseRef,
} from '../system/SystemFunctions';
import { GucSystem } from '../core/GucSystem';

let map: PgFunctionMap;
const fn = (name: string, ...args: unknown[]) => map.get(name)!.fn(...args);

beforeAll(() => {
  map = buildPgFunctions();
  GucSystem.getInstance().registry.resetAllToDefaults();
});

afterEach(() => {
  setBlockingPidsLockMgr(null);
  setCurrentDbRef(null);
});

describe('PgFunctions — remaining executable branches (full coverage)', () => {
  it('pg_blocking_pids returns hashed blockers when lock manager has waiters', () => {
    setBlockingPidsLockMgr({
      getWaitInfo: () => [{ waitingFor: 'relation 16384' }, { waitingFor: 'relation 16384' }],
    } as any);
    const out = fn('pg_blocking_pids', 42);
    // Two identical waitingFor collapse to a single hashed pid (dedup via Set).
    expect(out).toMatch(/^\{-?\d+\}$/);
  });

  it('pg_blocking_pids falls through when getWaitInfo throws', () => {
    setBlockingPidsLockMgr({ getWaitInfo: () => { throw new Error('boom'); } } as any);
    expect(fn('pg_blocking_pids', 1)).toBe('{}');
  });

  it('regexp_matches returns null on no match (both global and non-global)', () => {
    expect(fn('regexp_matches', 'hello', 'z')).toBeNull();
    expect(fn('regexp_matches', 'hello', 'z', 'g')).toBeNull();
  });

  it('regexp_replace / split catch invalid patterns', () => {
    expect(fn('regexp_replace', 'abc', '(', 'x')).toBeNull();
    expect(fn('regexp_split_to_array', 'abc', '(')).toBeNull();
    expect(fn('regexp_split_to_table', 'abc', '(')).toEqual([]);
  });

  it('encode handles Buffer and Uint8Array inputs', () => {
    expect(fn('encode', Buffer.from('abc'), 'hex')).toBe('616263');
    expect(fn('encode', new Uint8Array([97, 98, 99]), 'hex')).toBe('616263');
  });

  it('decode escape branch', () => {
    expect(fn('decode', 'abc', 'escape')).toBe('abc');
  });

  it('getRelationSize uses db.prepare PRAGMA branch (real db ref)', () => {
    const db: DatabaseRef = {
      prepare: (sql: string) => {
        if (sql.includes('page_size')) return { get: () => ({ page_size: 4096 }), all: () => [] };
        if (sql.includes('page_count')) return { get: () => ({ page_count: 4 }), all: () => [] };
        if (sql.includes('type=\'table\'')) return { get: () => ({ cnt: 2 }), all: () => [] };
        return { get: () => undefined, all: () => [] };
      },
      exec: () => undefined,
    };
    setCurrentDbRef(db);
    // totalPages(page_count=4) * pageSize(4096) / tableCount(2) = 8192
    expect(fn('pg_relation_size', 'users')).toBe(8192);
    expect(fn('pg_table_size', 'users')).toBe(8192);
  });

  it('getRelationSize returns 0 when no db ref (fallthrough)', () => {
    setCurrentDbRef(null);
    expect(fn('pg_relation_size', 'users')).toBe(0);
    expect(fn('pg_indexes_size', 'users')).toBe(0);
  });

  it('make_interval singular mon/min/sec and zero-value parts', () => {
    expect(fn('make_interval', 0, 1, 0, 0, 0, 0, 0)).toBe('1 mon');
    expect(fn('make_interval', 0, 0, 0, 0, 0, 1, 0)).toBe('1 min');
    expect(fn('make_interval', 0, 0, 0, 0, 0, 0, 1)).toBe('1 sec');
    // fractional/non-unity seconds exercise the `Math.abs(s) !== 1` branch
    expect(fn('make_interval', 0, 0, 0, 0, 0, 0, 2.5)).toBe('2.5 secs');
    // all-zero → falls back to a zero-second part (plural 's' since 0 !== 1)
    expect(fn('make_interval')).toBe('0 secs');
  });

  it('justify_interval singular month branch', () => {
    // 30 days → 1 mon (singular, no 's')
    expect(fn('justify_interval', 30 * 24)).toBe('1 mon');
    // zero → '0 hours'
    expect(fn('justify_interval', 0)).toBe('0 hours');
  });

  it('extract(date_part) parses failed source → null', () => {
    expect(fn('extract', 'year', 'not-a-date')).toBeNull();
  });

  it('extract isodow uses `|| 7` when day is Sunday', () => {
    // 1970-01-04 is a Sunday (day-of-week 0).
    expect(fn('extract', 'isodow', '1970-01-04')).toBe(7);
  });

  it('trim defaults where to BOTH when omitted', () => {
    expect(fn('trim', '  spaced  ', ' ')).toBe('spaced');
  });

  it('substring positional edge cases (isNaN / empty escape)', () => {
    // substring(text, from) with non-numeric from → NaN → ''
    expect(fn('substring', 'hello', 'abc')).toBe('');
    // substring with regex-like from and no match → ''
    expect(fn('substring', 'hello', 'zz')).toBe('');
  });

  // ── regexp_match / regexp_replace boundary tests ──
  it('regexp_match returns null when str is null', () => {
    expect(fn('regexp_match', null, 'a')).toBeNull();
  });

  it('regexp_match returns null when pattern is null', () => {
    expect(fn('regexp_match', 'a', null)).toBeNull();
  });

  it('regexp_match: no matches returns null', () => {
    expect(fn('regexp_match', 'hello', 'z')).toBeNull();
  });

  // ── jsonb_build_object / jsonb_build_array boundaries ──
  it('jsonb_build_object with null key skips that entry', () => {
    const r = fn('jsonb_build_object', 'a', 1, null, 2, 'c', 3);
    expect(JSON.parse(r)).toEqual({ a: 1, c: 3 });
  });

  it('jsonb_build_object with undefined value → null', () => {
    const r = fn('jsonb_build_object', 'a', undefined);
    expect(JSON.parse(r)).toEqual({ a: null });
  });

  it('jsonb_build_array maps undefined args to null', () => {
    const r = fn('jsonb_build_array', 1, undefined, 3);
    expect(JSON.parse(r)).toEqual([1, null, 3]);
  });

  // ── greatest / least edge cases ──
  it('greatest with empty args returns null', () => {
    expect(fn('greatest')).toBeNull();
  });

  it('least with empty args returns null', () => {
    expect(fn('least')).toBeNull();
  });

  it('greatest with string args does lexical comparison', () => {
    expect(fn('greatest', 'apple', 'banana', 'apricot')).toBe('banana');
  });

  it('least with string args does lexical comparison', () => {
    expect(fn('least', 'banana', 'apple')).toBe('apple');
  });

  // ── pg_size_pretty zero edge ──
  it('pg_size_pretty with zero returns 0 bytes', () => {
    expect(fn('pg_size_pretty', 0)).toBe('0 bytes');
  });

  // ── regexp_replace with flags ──
  it('regexp_replace with global flag replaces all occurrences', () => {
    expect(fn('regexp_replace', 'abab', 'a', 'X', 'g')).toBe('XbXb');
  });
});
