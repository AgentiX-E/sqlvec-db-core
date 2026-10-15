import { beforeEach, describe, it, expect } from 'vitest';
import { pgCatalogShim, syncShimToPgCatalog } from '../index/PgCatalogShim';
import { PgCatalog } from '../system/PgCatalog';

describe('PgCatalogShim', () => {
  beforeEach(() => {
    pgCatalogShim.reset();
    PgCatalog.userTableStats.clear();
    PgCatalog.userIndexStats.clear();
  });

  describe('table counters', () => {
    it('incrementSeqScan initializes and increments', () => {
      expect(pgCatalogShim.incrementSeqScan('MyTable')).toBe(1);
      expect(pgCatalogShim.incrementSeqScan('mytable')).toBe(2); // case-insensitive
      expect(pgCatalogShim.getTableStats('MYTABLE').seq_scan).toBe(2);
    });

    it('incrementSeqTupRead adds a count (default 1)', () => {
      pgCatalogShim.incrementSeqTupRead('t');
      pgCatalogShim.incrementSeqTupRead('t', 5);
      expect(pgCatalogShim.getTableStats('t').seq_tup_read).toBe(6);
    });

    it('getTableStats returns zeroed stats for an unknown table', () => {
      expect(pgCatalogShim.getTableStats('nope')).toEqual({
        seq_scan: 0,
        seq_tup_read: 0,
        idx_scan: 0,
        idx_tup_fetch: 0,
      });
    });

    it('getAllTableStats returns a defensive copy', () => {
      pgCatalogShim.incrementSeqScan('a');
      const copy = pgCatalogShim.getAllTableStats();
      copy.clear();
      expect(pgCatalogShim.getTableStats('a').seq_scan).toBe(1); // original intact
    });
  });

  describe('index counters', () => {
    it('incrementIdxScan initializes and increments', () => {
      expect(pgCatalogShim.incrementIdxScan('Idx')).toBe(1);
      expect(pgCatalogShim.incrementIdxScan('idx')).toBe(2);
      expect(pgCatalogShim.getIndexStats('IDX').idx_scan).toBe(2);
    });

    it('incrementIdxTupRead adds a count', () => {
      pgCatalogShim.incrementIdxTupRead('i', 3);
      pgCatalogShim.incrementIdxTupRead('i');
      expect(pgCatalogShim.getIndexStats('i').idx_tup_read).toBe(4);
    });

    it('incrementIdxTupFetch adds a count', () => {
      pgCatalogShim.incrementIdxTupFetch('i', 7);
      expect(pgCatalogShim.getIndexStats('i').idx_tup_fetch).toBe(7);
    });

    it('getIndexStats returns zeroed stats for an unknown index', () => {
      expect(pgCatalogShim.getIndexStats('nope')).toEqual({
        idx_scan: 0,
        idx_tup_read: 0,
        idx_tup_fetch: 0,
      });
    });

    it('getAllIndexStats returns a defensive copy', () => {
      pgCatalogShim.incrementIdxScan('x');
      const copy = pgCatalogShim.getAllIndexStats();
      copy.clear();
      expect(pgCatalogShim.getIndexStats('x').idx_scan).toBe(1);
    });
  });

  describe('syncShimToPgCatalog', () => {
    it('syncs new table stats into PgCatalog', () => {
      pgCatalogShim.incrementSeqScan('t');
      pgCatalogShim.incrementSeqScan('t');
      pgCatalogShim.incrementSeqTupRead('t', 10);
      syncShimToPgCatalog();
      const t = PgCatalog.userTableStats.get('t')!;
      expect(t.seq_scan).toBe(2);
      expect(t.seq_tup_read).toBe(10);
      expect(t.n_tup_ins).toBe(0); // default fields populated
    });

    it('accumulates into an existing table entry', () => {
      PgCatalog.userTableStats.set('t', {
        seq_scan: 100,
        seq_tup_read: 200,
        idx_scan: 0,
        idx_tup_fetch: 0,
        n_tup_ins: 0,
        n_tup_upd: 0,
        n_tup_del: 0,
        n_live_tup: 0,
        n_dead_tup: 0,
        n_mod_since_analyze: 0,
        last_analyze: null,
        last_autoanalyze: null,
      });
      pgCatalogShim.incrementSeqScan('t');
      pgCatalogShim.incrementSeqTupRead('t', 5);
      syncShimToPgCatalog();
      expect(PgCatalog.userTableStats.get('t')!.seq_scan).toBe(101);
      expect(PgCatalog.userTableStats.get('t')!.seq_tup_read).toBe(205);
    });

    it('syncs new index stats into PgCatalog', () => {
      pgCatalogShim.incrementIdxScan('i');
      pgCatalogShim.incrementIdxTupRead('i', 4);
      pgCatalogShim.incrementIdxTupFetch('i', 2);
      syncShimToPgCatalog();
      const i = PgCatalog.userIndexStats.get('i')!;
      expect(i.idx_scan).toBe(1);
      expect(i.idx_tup_read).toBe(4);
      expect(i.idx_tup_fetch).toBe(2);
    });

    it('accumulates into an existing index entry', () => {
      PgCatalog.userIndexStats.set('i', { idx_scan: 10, idx_tup_read: 20, idx_tup_fetch: 30 });
      pgCatalogShim.incrementIdxScan('i');
      syncShimToPgCatalog();
      expect(PgCatalog.userIndexStats.get('i')!.idx_scan).toBe(11);
    });

    it('resets shim counters after syncing (idempotent incremental sync)', () => {
      pgCatalogShim.incrementSeqScan('t');
      pgCatalogShim.incrementSeqScan('t');
      syncShimToPgCatalog();
      expect(PgCatalog.userTableStats.get('t')!.seq_scan).toBe(2);

      // A second sync without new increments must NOT re-add the counts.
      syncShimToPgCatalog();
      expect(PgCatalog.userTableStats.get('t')!.seq_scan).toBe(2);
    });
  });
});
