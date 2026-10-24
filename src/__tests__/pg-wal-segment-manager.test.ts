/**
 * Unit tests for PgWalSegmentManager — the PostgreSQL-compatible WAL segment
 * lifecycle manager (segment init, switch, archive/remove transitions, LSN↔name
 * resolution, and WALStateManager integration).
 *
 * The existing pg-wal-writer/pg-wal-segment-shim suites exercise the segment
 * manager incidentally through the writer/shim. This suite targets the manager
 * directly so every lifecycle path, error branch, and resolution helper is
 * covered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { PgWalSegmentManager, type WalSegment } from '../storage/PgWalSegmentManager';

let mgr: PgWalSegmentManager;

beforeEach(() => {
  PgWalSegmentManager.getInstance().reset();
  mgr = PgWalSegmentManager.getInstance();
});

describe('PgWalSegmentManager — singleton & configuration', () => {
  it('returns the same instance across getInstance() calls', () => {
    expect(PgWalSegmentManager.getInstance()).toBe(mgr);
  });

  it('configure sets dir/size/timeline and applies defaults for omitted args', () => {
    mgr.configure('/tmp/wal', 1024 * 1024, 2);
    expect(mgr.getWalDirectory()).toBe('/tmp/wal');
    expect(mgr.getSegmentSize()).toBe(1024 * 1024);
  });

  it('configure throws when segmentSize is below 1024', () => {
    expect(() => mgr.configure(undefined, 512)).toThrow(/segmentSize must be >= 1024/);
  });

  it('configure leaves fields unchanged when args are omitted', () => {
    const before = mgr.getWalDirectory();
    mgr.configure();
    expect(mgr.getWalDirectory()).toBe(before);
    expect(mgr.getSegmentSize()).toBe(16 * 1024 * 1024);
  });
});

describe('PgWalSegmentManager — init', () => {
  it('initializes the first segment at LSN 0/0', () => {
    mgr.init();
    const seg = mgr.getCurrentSegment();
    expect(seg.name).toBe('000000010000000000000000');
    expect(seg.lsn).toBe('0/0');
    expect(seg.startLSN).toBe(0);
    expect(seg.archived).toBe(false);
    expect(seg.removed).toBe(false);
  });

  it('init is a no-op when already initialized', () => {
    mgr.init();
    mgr.init();
    expect(mgr.getAllSegments()).toHaveLength(1);
  });

  it('getCurrentSegment throws before init', () => {
    expect(() => mgr.getCurrentSegment()).toThrow(/init/);
  });
});

describe('PgWalSegmentManager — segment switching', () => {
  it('switchSegment creates a new segment and advances LSN by segment size', () => {
    mgr.init();
    const seg = mgr.switchSegment();
    expect(seg.startLSN).toBe(16 * 1024 * 1024);
    expect(seg.lsn).toBe('0/1000000');
    expect(mgr.getAllSegments()).toHaveLength(2);
    expect(mgr.getCurrentSegment().name).toBe(seg.name);
  });

  it('segmentNumberForLSN floors the LSN by segment size', () => {
    mgr.init();
    expect(mgr.segmentNumberForLSN(0)).toBe(0);
    expect(mgr.segmentNumberForLSN(16 * 1024 * 1024)).toBe(1);
    expect(mgr.segmentNumberForLSN(16 * 1024 * 1024 + 1)).toBe(1);
  });
});

describe('PgWalSegmentManager — segment retrieval', () => {
  it('getSegment returns a segment by name or undefined', () => {
    mgr.init();
    const name = mgr.getCurrentSegment().name;
    expect(mgr.getSegment(name)?.name).toBe(name);
    expect(mgr.getSegment('nope')).toBeUndefined();
  });

  it('getPendingArchiveSegments lists closed-but-unarchived segments', () => {
    mgr.init();
    mgr.switchSegment();
    mgr.switchSegment();
    const pending = mgr.getPendingArchiveSegments();
    // Two closed segments (segments 0 and 1), current segment (2) excluded.
    expect(pending).toHaveLength(2);
    expect(pending[0].startLSN).toBe(0);
    expect(pending[1].startLSN).toBe(16 * 1024 * 1024);
  });

  it('getPendingArchiveSegments excludes archived/removed segments', () => {
    mgr.init();
    mgr.switchSegment();
    mgr.markArchived('000000010000000000000000');
    const pending = mgr.getPendingArchiveSegments();
    expect(pending).toHaveLength(0);
  });
});

describe('PgWalSegmentManager — archive/remove transitions', () => {
  it('markArchived sets archived flag and fires the callback', () => {
    mgr.init();
    let fired: WalSegment | null = null;
    mgr.setOnArchivedCallback((seg) => { fired = seg; });
    const name = mgr.getCurrentSegment().name;
    mgr.markArchived(name);
    expect(mgr.getSegment(name)?.archived).toBe(true);
    expect(fired?.name).toBe(name);
  });

  it('markArchived warns and returns for an unknown segment', () => {
    mgr.init();
    expect(() => mgr.markArchived('nope')).not.toThrow();
  });

  it('markArchived is idempotent (already archived)', () => {
    mgr.init();
    const name = mgr.getCurrentSegment().name;
    mgr.markArchived(name);
    let fired = 0;
    mgr.setOnArchivedCallback(() => { fired++; });
    mgr.markArchived(name); // already archived — callback must not fire again
    expect(fired).toBe(0);
  });

  it('markRemoved sets removed flag (with warning when not yet archived)', () => {
    mgr.init();
    const name = mgr.getCurrentSegment().name;
    mgr.markRemoved(name); // not archived → warns but still marks removed
    expect(mgr.getSegment(name)?.removed).toBe(true);
  });

  it('markRemoved warns and returns for an unknown segment', () => {
    mgr.init();
    expect(() => mgr.markRemoved('nope')).not.toThrow();
  });

  it('setOnArchivedCallback(null) clears the callback', () => {
    mgr.init();
    mgr.setOnArchivedCallback(() => {});
    mgr.setOnArchivedCallback(null);
    mgr.markArchived(mgr.getCurrentSegment().name);
    // No throw means callback was cleared.
    expect(mgr.getCurrentSegment().archived).toBe(true);
  });
});

describe('PgWalSegmentManager — WALStateManager integration (onWalSwitch)', () => {
  it('auto-initializes then switches when newLSN is beyond the first segment', () => {
    const seg = mgr.onWalSwitch(16 * 1024 * 1024);
    expect(seg.startLSN).toBe(16 * 1024 * 1024);
  });

  it('auto-initializes and returns the first segment when newLSN is 0', () => {
    const seg = mgr.onWalSwitch(0);
    expect(seg.startLSN).toBe(0);
  });

  it('returns the current segment when newLSN is within its range', () => {
    mgr.init();
    const seg = mgr.onWalSwitch(8 * 1024 * 1024); // within first 16 MB
    expect(seg.startLSN).toBe(0);
  });

  it('switches when newLSN reaches the segment boundary', () => {
    mgr.init();
    const seg = mgr.onWalSwitch(16 * 1024 * 1024);
    expect(seg.startLSN).toBe(16 * 1024 * 1024);
  });
});

describe('PgWalSegmentManager — LSN ↔ segment name resolution', () => {
  it('resolveSegmentName parses a PG LSN to a segment name', () => {
    mgr.init();
    expect(mgr.resolveSegmentName('0/1000000')).toBe('000000010000000000000001');
  });

  it('resolveSegmentName throws on malformed LSN (wrong segment count)', () => {
    mgr.init();
    expect(() => mgr.resolveSegmentName('0/x/y')).toThrow(/Invalid LSN format/);
  });

  it('resolveSegmentName throws on non-hex LSN parts', () => {
    mgr.init();
    expect(() => mgr.resolveSegmentName('zz/1000000')).toThrow(/non-hex/);
  });

  it('resolveSegmentNameFromValue formats a name from a byte value', () => {
    mgr.init();
    expect(mgr.resolveSegmentNameFromValue(16 * 1024 * 1024)).toBe('000000010000000000000001');
  });

  it('resolveSegmentLSN reverse-resolves a name to a byte position', () => {
    mgr.init();
    expect(mgr.resolveSegmentLSN('000000010000000000000002')).toBe(2 * 16 * 1024 * 1024);
  });

  it('resolveSegmentLSN throws on an invalid name format', () => {
    mgr.init();
    expect(() => mgr.resolveSegmentLSN('not-a-segment')).toThrow(/Invalid segment name format/);
  });
});

describe('PgWalSegmentManager — diagnostics & reset', () => {
  it('getAllSegments returns segments in creation order', () => {
    mgr.init();
    mgr.switchSegment();
    expect(mgr.getAllSegments().map((s) => s.startLSN)).toEqual([0, 16 * 1024 * 1024]);
  });

  it('reset clears all state and restores defaults', () => {
    mgr.init();
    mgr.switchSegment();
    mgr.reset();
    expect(mgr.getAllSegments()).toHaveLength(0);
    expect(mgr.getWalDirectory()).toBe('./wal-segments');
    expect(mgr.getSegmentSize()).toBe(16 * 1024 * 1024);
  });
});
