import { describe, it, expect, beforeEach } from 'vitest';
import {
  PgRewindShim,
  type LogEntry,
  type RewindConfig,
} from '../query/PgRewindShim';

const cfg: RewindConfig = {
  divergedNodeId: 1,
  canonicalNodeId: 2,
  dataDir: '/data',
  walDir: '/wal',
};

function entries(indexes: Array<[number, number, string]>): LogEntry[] {
  return indexes.map(([index, term, data]) => ({ index, term, data }));
}

describe('PgRewindShim.detectDivergence', () => {
  it('returns no divergence for identical logs', () => {
    const log = entries([[0, 1, 'a'], [1, 1, 'b']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(false);
    expect(shim.isConsistent()).toBe(true);
  });

  it('returns no divergence (index 0) for two empty logs', () => {
    const shim = new PgRewindShim(cfg);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(false);
    expect(dp.index).toBe(0);
    expect(dp.term).toBe(0);
  });

  it('detects divergence at a prefix term mismatch', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b']]); // term 2 at index 1
    const c = entries([[0, 1, 'a'], [1, 3, 'c']]); // term 3 at index 1
    const shim = new PgRewindShim(cfg, d, c);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(true);
    expect(dp.index).toBe(1);
    expect(dp.term).toBe(2);
  });

  it('detects divergence when diverged is a strict prefix', () => {
    const d = entries([[0, 1, 'a']]);
    const c = entries([[0, 1, 'a'], [1, 1, 'b'], [2, 1, 'c']]);
    const shim = new PgRewindShim(cfg, d, c);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(true);
  });

  it('detects divergence when canonical is a strict prefix', () => {
    const d = entries([[0, 1, 'a'], [1, 1, 'b'], [2, 1, 'c']]);
    const c = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, d, c);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(true);
  });

  it('detects divergence with empty diverged vs non-empty canonical', () => {
    const c = entries([[5, 1, 'x']]);
    const shim = new PgRewindShim(cfg, [], c);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(true);
  });

  it('detects divergence with non-empty diverged vs empty canonical', () => {
    const d = entries([[5, 1, 'x']]);
    const shim = new PgRewindShim(cfg, d, []);
    const dp = shim.detectDivergence();
    expect(dp.diverged).toBe(true);
  });
});

describe('PgRewindShim.calculateChanges', () => {
  it('returns zero for identical logs', () => {
    const log = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    shim.detectDivergence();
    expect(shim.calculateChanges()).toEqual({ toRollBack: 0, toRollForward: 0 });
  });

  it('returns zero for two empty logs', () => {
    const shim = new PgRewindShim(cfg);
    expect(shim.calculateChanges()).toEqual({ toRollBack: 0, toRollForward: 0 });
  });

  it('roll-forward only when diverged is empty', () => {
    const c = entries([[0, 1, 'a'], [1, 1, 'b'], [2, 1, 'c']]);
    const shim = new PgRewindShim(cfg, [], c);
    expect(shim.calculateChanges()).toEqual({ toRollBack: 0, toRollForward: 3 });
  });

  it('roll-back only when canonical is empty', () => {
    const d = entries([[0, 1, 'a'], [1, 1, 'b']]);
    const shim = new PgRewindShim(cfg, d, []);
    expect(shim.calculateChanges()).toEqual({ toRollBack: 2, toRollForward: 0 });
  });

  it('computes symmetric rollback/rollforward around the divergence point', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b'], [2, 2, 'c']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'x'], [2, 3, 'y']]);
    const shim = new PgRewindShim(cfg, d, c);
    shim.detectDivergence();
    // common prefix = [index0]; rollback 2 (index1,2), rollforward 2
    expect(shim.calculateChanges()).toEqual({ toRollBack: 2, toRollForward: 2 });
  });
});

describe('PgRewindShim.rollback', () => {
  it('returns 0 for empty diverged log', () => {
    const shim = new PgRewindShim(cfg);
    expect(shim.rollback()).toBe(0);
  });

  it('returns 0 when no divergence', () => {
    const log = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    shim.detectDivergence();
    expect(shim.rollback()).toBe(0);
  });

  it('tombstones entries after the divergence point', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b'], [2, 2, 'c']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'x']]);
    const shim = new PgRewindShim(cfg, d, c);
    shim.detectDivergence();
    const n = shim.rollback();
    expect(n).toBe(2);
    expect(shim.getDivergedLog()).toEqual([{ index: 0, term: 1, data: 'a' }]);
  });

  it('does not double-count already-tombstoned entries', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b']]);
    const c = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, d, c);
    shim.detectDivergence();
    expect(shim.rollback()).toBe(1);
    expect(shim.rollback()).toBe(0); // already tombstoned
  });
});

describe('PgRewindShim.rollForward', () => {
  it('returns 0 for empty canonical log', () => {
    const shim = new PgRewindShim(cfg, entries([[0, 1, 'a']]), []);
    expect(shim.rollForward()).toBe(0);
  });

  it('applies all entries when diverged becomes empty', () => {
    const c = entries([[3, 1, 'x'], [4, 1, 'y']]);
    const shim = new PgRewindShim(cfg, [], c);
    const n = shim.rollForward();
    expect(n).toBe(2);
    expect(shim.getDivergedLog().map(e => e.index)).toEqual([3, 4]);
  });

  it('appends missing canonical entries after a divergence', () => {
    const d = entries([[0, 1, 'a']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'x'], [2, 3, 'y']]);
    const shim = new PgRewindShim(cfg, d, c);
    shim.detectDivergence();
    const n = shim.rollForward();
    expect(n).toBe(2);
    expect(shim.getDivergedLog().map(e => e.index)).toEqual([0, 1, 2]);
  });
});

describe('PgRewindShim.execute', () => {
  it('handles two empty logs', () => {
    const shim = new PgRewindShim(cfg);
    const r = shim.execute();
    expect(r.success).toBe(true);
    expect(r.entriesRolledBack).toBe(0);
    expect(r.entriesApplied).toBe(0);
    expect(r.newLogStartIndex).toBe(0);
    expect(r.newLogEndIndex).toBe(0);
  });

  it('rolls forward fully when diverged empty', () => {
    const c = entries([[10, 1, 'a'], [11, 1, 'b']]);
    const shim = new PgRewindShim(cfg, [], c);
    const r = shim.execute();
    expect(r.entriesApplied).toBe(2);
    expect(r.newLogStartIndex).toBe(10);
    expect(r.newLogEndIndex).toBe(11);
  });

  it('rolls back fully when canonical empty', () => {
    const d = entries([[0, 1, 'a'], [1, 1, 'b']]);
    const shim = new PgRewindShim(cfg, d, []);
    const r = shim.execute();
    expect(r.entriesRolledBack).toBe(2);
    expect(r.newLogStartIndex).toBe(0);
    expect(shim.getDivergedLog()).toEqual([]);
  });

  it('returns unchanged for identical logs', () => {
    const log = entries([[0, 1, 'a'], [1, 2, 'b']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    const r = shim.execute();
    expect(r.success).toBe(true);
    expect(r.entriesRolledBack).toBe(0);
    expect(r.entriesApplied).toBe(0);
    expect(r.newLogStartIndex).toBe(0);
    expect(r.newLogEndIndex).toBe(1);
  });

  it('performs a full rewind on divergent logs and reports stats', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b'], [2, 2, 'c'], [3, 2, 'd']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'x'], [2, 3, 'y']]);
    const shim = new PgRewindShim(cfg, d, c);
    const r = shim.execute();
    expect(r.success).toBe(true);
    expect(r.entriesRolledBack).toBe(3); // index1,2,3
    expect(r.entriesApplied).toBe(2); // canonical index1,2
    expect(shim.isConsistent()).toBe(true);

    const s = shim.getStats();
    expect(s.totalEntriesBefore).toBe(4);
    expect(s.totalEntriesAfter).toBe(3);
    expect(s.divergedEntries).toBe(3);
    expect(s.missingEntries).toBe(2);
    expect(s.rolledBack).toBe(3);
    expect(s.rolledForward).toBe(2);
    expect(s.divergencePoint?.diverged).toBe(true);
    expect(s.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('PgRewindShim.getStats / getDivergedLog / getCanonicalLog / isConsistent', () => {
  it('returns a defensive copy of stats', () => {
    const log = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    shim.execute();
    const s1 = shim.getStats();
    s1.rolledBack = 999;
    expect(shim.getStats().rolledBack).toBe(0); // not mutated
  });

  it('returns a defensive copy of diverged log', () => {
    const log = entries([[0, 1, 'a']]);
    const shim = new PgRewindShim(cfg, log);
    const g = shim.getDivergedLog();
    g[0].index = 999;
    expect(shim.getDivergedLog()[0].index).toBe(0);
  });

  it('reports consistency false when logs differ', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'c']]);
    const shim = new PgRewindShim(cfg, d, c);
    expect(shim.isConsistent()).toBe(false);
  });

  it('reports consistency false on length mismatch', () => {
    const d = entries([[0, 1, 'a']]);
    const c = entries([[0, 1, 'a'], [1, 1, 'b']]);
    expect(new PgRewindShim(cfg, d, c).isConsistent()).toBe(false);
  });
});

describe('PgRewindShim lazy-detect branches', () => {
  it('calculateChanges auto-detects when not yet detected', () => {
    const d = entries([[0, 1, 'a'], [1, 2, 'b']]);
    const c = entries([[0, 1, 'a'], [1, 3, 'x']]);
    const shim = new PgRewindShim(cfg, d, c);
    // no explicit detectDivergence() call
    expect(shim.calculateChanges()).toEqual({ toRollBack: 1, toRollForward: 1 });
  });

  it('rollback auto-detects when prefix is empty (first entry diverges)', () => {
    const d = entries([[0, 1, 'a'], [1, 1, 'b']]);
    const c = entries([[0, 5, 'z'], [1, 5, 'y']]);
    const shim = new PgRewindShim(cfg, d, c);
    // lastMatchIdx stays -1 because index 0 already diverges
    const n = shim.rollback();
    expect(n).toBe(2);
    expect(shim.getDivergedLog()).toEqual([]);
  });

  it('rollForward auto-detects from scratch', () => {
    const d = entries([[0, 1, 'a']]);
    const c = entries([[0, 1, 'a'], [1, 9, 'z']]);
    const shim = new PgRewindShim(cfg, d, c);
    const n = shim.rollForward();
    expect(n).toBe(1);
    expect(shim.getDivergedLog().map(e => e.index)).toEqual([0, 1]);
  });

  it('getStats returns null divergencePoint before execution', () => {
    const shim = new PgRewindShim(cfg, entries([[0, 1, 'a']]));
    const s = shim.getStats();
    expect(s.divergencePoint).toBeNull();
    expect(s.totalEntriesBefore).toBe(0);
  });

  it('rollForward re-detects and returns 0 when logs are identical', () => {
    const log = entries([[0, 1, 'a'], [1, 2, 'b']]);
    const shim = new PgRewindShim(cfg, log, [...log]);
    // no explicit detectDivergence; identical logs -> no divergence
    expect(shim.rollForward()).toBe(0);
    expect(shim.getDivergedLog().map(e => e.index)).toEqual([0, 1]);
  });
});
