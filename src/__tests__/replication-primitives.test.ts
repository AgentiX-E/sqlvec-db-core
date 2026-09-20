import { describe, it, expect } from 'vitest';
import { DedupRing } from '../replication/DedupRing';
import { compareHLT, happenedBefore, type HLCTimestamp } from '../replication/HLC';
import { HLCClockCompensator } from '../consensus/HLCClockCompensator';

// ─────────────────────────────────────────────────────────────
// DedupRing — bounded FIFO dedup used for idempotent Raft apply.
// ─────────────────────────────────────────────────────────────
describe('DedupRing', () => {
  it('accepts a key the first time and rejects duplicates', () => {
    const ring = new DedupRing(10);
    expect(ring.add('a')).toBe(true);   // new
    expect(ring.add('a')).toBe(false);  // duplicate
    expect(ring.has('a')).toBe(true);
    expect(ring.size).toBe(1);
  });

  it('tracks distinct keys independently', () => {
    const ring = new DedupRing(10);
    expect(ring.add('a')).toBe(true);
    expect(ring.add('b')).toBe(true);
    expect(ring.add('c')).toBe(true);
    expect(ring.size).toBe(3);
    expect(ring.has('b')).toBe(true);
    expect(ring.has('z')).toBe(false);
  });

  it('evicts the oldest key when capacity is reached (FIFO)', () => {
    const ring = new DedupRing(2);
    ring.add('a');
    ring.add('b');
    expect(ring.size).toBe(2);
    // Inserting 'c' at capacity evicts 'a'.
    expect(ring.add('c')).toBe(true);
    expect(ring.size).toBe(2);
    expect(ring.has('a')).toBe(false);
    expect(ring.has('b')).toBe(true);
    expect(ring.has('c')).toBe(true);
  });

  it('normalizes non-positive or fractional capacity', () => {
    expect(new DedupRing(0).size).toBe(0);
    expect(new DedupRing(-5).size).toBe(0);
    // Fractional capacity floors to 3; still accepts keys.
    const ring = new DedupRing(3.9);
    expect(ring.add('a')).toBe(true);
    expect(ring.add('b')).toBe(true);
    expect(ring.add('c')).toBe(true);
    expect(ring.size).toBe(3);
  });

  it('defaults to a large capacity when none is given', () => {
    const ring = new DedupRing();
    expect(ring.add('x')).toBe(true);
    expect(ring.size).toBe(1);
  });

  it('exposes the configured capacity via maxSize', () => {
    expect(new DedupRing(10).maxSize).toBe(10);
    expect(new DedupRing(0).maxSize).toBe(1); // normalized to a positive integer
    expect(new DedupRing().maxSize).toBe(10000); // default
  });
});

// ─────────────────────────────────────────────────────────────
// compareHLT / happenedBefore — HLC total order for LWW.
// ─────────────────────────────────────────────────────────────
describe('compareHLT (LWW conflict resolution)', () => {
  const ts = (wall: number, logical: number, nodeId: number): HLCTimestamp => ({
    wall,
    logical,
    nodeId,
  });

  it('orders by wall clock first', () => {
    expect(compareHLT(ts(100, 0, 0), ts(200, 0, 0))).toBeLessThan(0);
    expect(compareHLT(ts(200, 0, 0), ts(100, 0, 0))).toBeGreaterThan(0);
  });

  it('breaks wall ties by logical counter', () => {
    expect(compareHLT(ts(100, 1, 0), ts(100, 2, 0))).toBeLessThan(0);
    expect(compareHLT(ts(100, 5, 0), ts(100, 5, 0))).toBe(0);
  });

  it('breaks logical ties by nodeId', () => {
    expect(compareHLT(ts(100, 1, 1), ts(100, 1, 2))).toBeLessThan(0);
    expect(compareHLT(ts(100, 1, 9), ts(100, 1, 8))).toBeGreaterThan(0);
    expect(compareHLT(ts(100, 1, 9), ts(100, 1, 9))).toBe(0);
  });

  it('returns 0 for identical timestamps', () => {
    const a = ts(42, 7, 3);
    expect(compareHLT(a, { ...a })).toBe(0);
  });

  it('happenedBefore is strictly less-than', () => {
    expect(happenedBefore(ts(100, 0, 0), ts(100, 0, 1))).toBe(true);
    expect(happenedBefore(ts(100, 1, 0), ts(100, 0, 0))).toBe(false);
    expect(happenedBefore(ts(50, 0, 0), ts(50, 0, 0))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// HLCClockCompensator — peer clock drift tracking.
// ─────────────────────────────────────────────────────────────
describe('HLCClockCompensator', () => {
  it('reports zero drift with no samples', () => {
    const comp = new HLCClockCompensator(200);
    expect(comp.estimatedDriftMs).toBe(0);
    expect(comp.getClockErrorStats()).toEqual({
      maxDriftMs: 200,
      estimatedDriftMs: 0,
      samples: 0,
      lastSync: 0,
    });
  });

  it('estimates drift as the average peer-vs-local delta', () => {
    const comp = new HLCClockCompensator(200);
    // peer ahead by 10ms
    comp.recordPeerTimestamp(1, 110, 100);
    // peer behind by 20ms (i.e. -20 delta)
    comp.recordPeerTimestamp(2, 180, 200);
    const stats = comp.getClockErrorStats();
    expect(stats.samples).toBe(2);
    expect(stats.estimatedDriftMs).toBeCloseTo((10 + -20) / 2); // -5
    expect(stats.lastSync).toBeGreaterThan(0);
  });

  it('ignores non-numeric and NaN observations', () => {
    const comp = new HLCClockCompensator(200);
    comp.recordPeerTimestamp(1, NaN, 100);
    comp.recordPeerTimestamp(1, 100, NaN);
    comp.recordPeerTimestamp(1, undefined as unknown as number, 100);
    expect(comp.getClockErrorStats().samples).toBe(0);
    expect(comp.estimatedDriftMs).toBe(0);
  });

  it('clamps maxDriftMs to a non-negative value', () => {
    expect(new HLCClockCompensator(-1).getClockErrorStats().maxDriftMs).toBe(0);
    expect(new HLCClockCompensator(0).getClockErrorStats().maxDriftMs).toBe(0);
  });
});
