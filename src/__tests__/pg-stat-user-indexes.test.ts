/**
 * Unit tests for PgStatUserIndexes.
 *
 * Verifies index-scan/tuple-read/block-hit counters, the process-wide default
 * collector, and both export names (`getIndexStatsCollector` and the
 * `getDefaultCollector` alias PlanExecutor imports).  The previous stub
 * returned `null`, so index usage tracking was silently disabled (BUG #161).
 */
import { describe, it, expect } from 'vitest';
import {
  PgStatUserIndexes,
  getIndexStatsCollector,
  getDefaultCollector,
} from '../monitoring/PgStatUserIndexes';

describe('PgStatUserIndexes — counters', () => {
  it('records index scans', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexScan('idx_a', 'tbl');
    c.recordIndexScan('idx_a');
    expect(c.getIndexStats('idx_a')?.idx_scan).toBe(2);
  });

  it('records tuple reads (accumulating)', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexTuplesRead('idx_a', 5);
    c.recordIndexTuplesRead('idx_a', 3);
    expect(c.getIndexStats('idx_a')?.idx_tup_read).toBe(8);
  });

  it('ignores non-positive tuple reads', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexTuplesRead('idx_a', 0);
    c.recordIndexTuplesRead('idx_a', -3);
    expect(c.getIndexStats('idx_a')).toBeUndefined();
  });

  it('records block hits only on hit', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexBlock('idx_a', true);
    c.recordIndexBlock('idx_a', false); // miss — not counted
    expect(c.getIndexStats('idx_a')?.idx_blks_hit).toBe(1);
  });

  it('returns undefined for unknown indexes', () => {
    const c = new PgStatUserIndexes();
    expect(c.getIndexStats('nope')).toBeUndefined();
  });

  it('getAll returns all entries', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexScan('a');
    c.recordIndexScan('b');
    expect(c.getAll()).toHaveLength(2);
    expect(c.size).toBe(2);
  });
});

describe('PgStatUserIndexes — defensive copies & reset', () => {
  it('getIndexStats returns a detached copy', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexScan('idx_a');
    const snapshot = c.getIndexStats('idx_a')!;
    snapshot.idx_scan = 999;
    expect(c.getIndexStats('idx_a')?.idx_scan).toBe(1);
  });

  it('getAll returns detached copies', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexScan('a');
    const all = c.getAll();
    all[0].idx_scan = 999;
    expect(c.getIndexStats('a')?.idx_scan).toBe(1);
  });

  it('reset clears all counters', () => {
    const c = new PgStatUserIndexes();
    c.recordIndexScan('a');
    c.reset();
    expect(c.size).toBe(0);
  });
});

describe('collector factories', () => {
  it('getIndexStatsCollector returns the same process-wide collector', () => {
    expect(getIndexStatsCollector()).toBe(getIndexStatsCollector());
  });

  it('getDefaultCollector aliases getIndexStatsCollector', () => {
    expect(getDefaultCollector()).toBe(getIndexStatsCollector());
  });
});
