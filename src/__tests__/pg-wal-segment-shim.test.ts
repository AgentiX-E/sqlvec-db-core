import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getWalSegmentSize,
  getWalSegmentStats,
  getCurrentWalInsertLSN,
  getCurrentWalFlushLSN,
  findSegmentForLSN,
  getSegmentSummary,
} from '../query/PgWalSegmentShim';
import { WALStateManager } from '../storage/WALStateManager';
import { PgWalSegmentManager, WalSegment } from '../storage/PgWalSegmentManager';

// PgWalSegmentShim is a thin delegating facade over the WALStateManager and
// PgWalSegmentManager singletons. It performs no SQL-string rewriting and has
// no literal-protection surface; tests stub both singletons and lock the
// mapping/fallback contract exactly.

function makeSegment(over: Partial<WalSegment> = {}): WalSegment {
  return {
    name: '000000010000000000000001',
    lsn: '0/1000000',
    size: 16000000,
    createdAt: 1690000000000,
    archived: false,
    removed: false,
    ...over,
  };
}

let wsmGetInstance: ReturnType<typeof vi.spyOn>;
let psmGetInstance: ReturnType<typeof vi.spyOn>;

function stubSingletons(wsm: Partial<WALStateManager>, psm: Partial<PgWalSegmentManager>) {
  wsmGetInstance = vi.spyOn(WALStateManager, 'getInstance').mockReturnValue(wsm as WALStateManager);
  psmGetInstance = vi.spyOn(PgWalSegmentManager, 'getInstance').mockReturnValue(psm as PgWalSegmentManager);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PgWalSegmentShim', () => {
  describe('getWalSegmentSize', () => {
    it('prefers the segment-manager size when non-zero', () => {
      stubSingletons(
        { getWalSegmentSize: vi.fn(() => 1000) } as any,
        { getSegmentSize: vi.fn(() => 16777216) } as any,
      );
      expect(getWalSegmentSize()).toEqual({ wal_segment_size: 16777216 });
    });

    it('falls back to the state-manager size when the manager reports 0', () => {
      stubSingletons(
        { getWalSegmentSize: vi.fn(() => 4096) } as any,
        { getSegmentSize: vi.fn(() => 0) } as any,
      );
      expect(getWalSegmentSize()).toEqual({ wal_segment_size: 4096 });
    });
  });

  describe('getWalSegmentStats', () => {
    it('maps each segment to a WalStatResult', () => {
      stubSingletons({} as any, {
        getAllSegments: vi.fn(() => [
          makeSegment({ name: 'a', lsn: '0/1', size: 10, archived: true, removed: false, createdAt: 1 }),
          makeSegment({ name: 'b', lsn: '0/2', size: 20, archived: false, removed: true, createdAt: 2 }),
        ]),
      } as any);
      expect(getWalSegmentStats()).toEqual([
        { wal_name: 'a', lsn: '0/1', size: 10, archived: true, removed: false, created_at: 1 },
        { wal_name: 'b', lsn: '0/2', size: 20, archived: false, removed: true, created_at: 2 },
      ]);
    });

    it('returns an empty array when there are no segments', () => {
      stubSingletons({} as any, { getAllSegments: vi.fn(() => []) } as any);
      expect(getWalSegmentStats()).toEqual([]);
    });
  });

  describe('getCurrentWalInsertLSN / getCurrentWalFlushLSN', () => {
    it('delegates to WALStateManager.getCurrentLSN', () => {
      stubSingletons({ getCurrentLSN: vi.fn(() => '0/2000000') } as any, {} as any);
      expect(getCurrentWalInsertLSN()).toBe('0/2000000');
      expect(getCurrentWalFlushLSN()).toBe('0/2000000');
    });
  });

  describe('findSegmentForLSN', () => {
    const seg = makeSegment({ name: '0000000100000000000000A0' });

    it('resolves the segment name and returns the matching segment', () => {
      stubSingletons({} as any, {
        resolveSegmentName: vi.fn(() => '0000000100000000000000A0'),
        getSegment: vi.fn((_n: string) => seg),
      } as any);
      expect(findSegmentForLSN('0/1000000')).toBe(seg);
    });

    it('returns undefined when the LSN matches no known segment', () => {
      stubSingletons({} as any, {
        resolveSegmentName: vi.fn(() => 'unknown'),
        getSegment: vi.fn((_n: string) => undefined),
      } as any);
      expect(findSegmentForLSN('0/9999999')).toBeUndefined();
    });
  });

  describe('getSegmentSummary', () => {
    it('aggregates current, total, pending, archived and removed counts', () => {
      const current = makeSegment({ name: 'cur', lsn: '0/5' });
      stubSingletons({} as any, {
        getCurrentSegment: vi.fn(() => current),
        getPendingArchiveSegments: vi.fn(() => [makeSegment(), makeSegment()]),
        getAllSegments: vi.fn(() => [
          makeSegment({ name: 'a', archived: true, removed: false }),
          makeSegment({ name: 'b', archived: true, removed: false }),
          makeSegment({ name: 'c', archived: false, removed: true }),
          makeSegment({ name: 'd', archived: false, removed: false }),
        ]),
      } as any);
      expect(getSegmentSummary()).toEqual({
        currentSegment: 'cur',
        currentLSN: '0/5',
        segmentSize: current.size,
        totalSegments: 4,
        pendingArchive: 2,
        archived: 2,
        removed: 1,
      });
    });
  });
});
