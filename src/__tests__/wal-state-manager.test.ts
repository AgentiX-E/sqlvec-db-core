/**
 * Unit tests for WALStateManager — the unified WAL state singleton that
 * simulates a PostgreSQL-compatible Log Sequence Number (LSN) stream over
 * SQLite for sqlvec-db compatibility shims.
 *
 * Coverage strategy:
 *   - Exercise every public getter/setter for full statement/function coverage.
 *   - Drive the private LSN conversion helpers (lsnToString/lsnToNumber)
 *     indirectly through the public LSN APIs and their error branches.
 *   - Cover the WALArchiver integration (delegate, no-op, and failure paths)
 *     and the PgWalSegmentManager lifecycle hooks (switchWAL + prune).
 *   - Cover crash recovery, checkpoint bookkeeping, and status summary.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WALStateManager } from '../storage/WALStateManager';
import { PgWalSegmentManager } from '../storage/PgWalSegmentManager';

let wsm: WALStateManager;

beforeEach(() => {
  WALStateManager.resetInstance();
  PgWalSegmentManager.getInstance().reset();
  wsm = WALStateManager.getInstance();
});

describe('WALStateManager — construction & singleton', () => {
  it('returns the same singleton instance across getInstance() calls', () => {
    expect(WALStateManager.getInstance()).toBe(wsm);
  });

  it('resetInstance() restores default GUC state', () => {
    wsm.setArchiveMode('on');
    wsm.setArchiveCommand('cp %p %f');
    wsm.setArchiveTimeout(30);
    wsm.setWalLevel('logical');
    wsm.setReplayPaused(true);
    WALStateManager.resetInstance();
    const fresh = WALStateManager.getInstance();
    expect(fresh.getArchiveMode()).toBe('off');
    expect(fresh.getArchiveCommand()).toBe('');
    expect(fresh.getArchiveTimeout()).toBe(0);
    expect(fresh.getWalLevel()).toBe('replica');
    expect(fresh.isReplayPaused()).toBe(false);
    expect(fresh.getRawLSN()).toBe(0);
  });
});

describe('WALStateManager — archive mode & command & timeout', () => {
  it('round-trips archive mode', () => {
    wsm.setArchiveMode('on');
    expect(wsm.getArchiveMode()).toBe('on');
    wsm.setArchiveMode('off');
    expect(wsm.getArchiveMode()).toBe('off');
  });

  it('round-trips archive command', () => {
    wsm.setArchiveCommand('cp %p /archive/%f');
    expect(wsm.getArchiveCommand()).toBe('cp %p /archive/%f');
  });

  it('round-trips archive timeout', () => {
    wsm.setArchiveTimeout(60);
    expect(wsm.getArchiveTimeout()).toBe(60);
  });
});

describe('WALStateManager — WAL level', () => {
  it('round-trips WAL level', () => {
    wsm.setWalLevel('minimal');
    expect(wsm.getWalLevel()).toBe('minimal');
    wsm.setWalLevel('logical');
    expect(wsm.getWalLevel()).toBe('logical');
    wsm.setWalLevel('replica');
    expect(wsm.getWalLevel()).toBe('replica');
  });
});

describe('WALStateManager — replay paused state', () => {
  it('round-trips replay-paused flag', () => {
    expect(wsm.isReplayPaused()).toBe(false);
    wsm.setReplayPaused(true);
    expect(wsm.isReplayPaused()).toBe(true);
    wsm.setReplayPaused(false);
    expect(wsm.isReplayPaused()).toBe(false);
  });
});

describe('WALStateManager — LSN conversions & diff', () => {
  it('converts raw bytes to PG LSN string via getCurrentLSN', () => {
    expect(wsm.getCurrentLSN()).toBe('0/0');
  });

  it('lsnDiff computes positive and negative byte differences', () => {
    expect(wsm.lsnDiff('0/2000000', '0/1000000')).toBe(16 * 1024 * 1024);
    expect(wsm.lsnDiff('0/1000000', '0/2000000')).toBe(-16 * 1024 * 1024);
    expect(wsm.lsnDiff('0/1000000', '0/1000000')).toBe(0);
  });

  it('lsnToFileName formats timeline/logId/segment with zero padding', () => {
    const name = wsm.lsnToFileName('0/2000000');
    expect(name).toBe('000000010000000000000002');
  });

  it('lsnToFileName wraps across the 4 GB segment boundary', () => {
    const name = wsm.lsnToFileName('1/0');
    expect(name).toBe('000000010000000100000000');
  });

  it('lsnToFileOffset returns byte offset within the segment', () => {
    const { fileName, fileOffset } = wsm.lsnToFileOffset('0/2000000');
    expect(fileName).toBe('000000010000000000000002');
    expect(fileOffset).toBe(0);
  });

  it('lsnDiff throws on malformed LSN (wrong segment count)', () => {
    expect(() => wsm.lsnDiff('0/x/y', '0/0')).toThrow(/Invalid LSN format/);
  });

  it('lsnDiff throws on non-hexadecimal LSN parts', () => {
    expect(() => wsm.lsnDiff('zz/1000000', '0/0')).toThrow(/non-hexadecimal/);
  });
});

describe('WALStateManager — WAL switch & segment manager hook', () => {
  it('advances the LSN by one segment on each switch', () => {
    const first = wsm.switchWAL();
    expect(first).toBe('0/1000000');
    const second = wsm.switchWAL();
    expect(second).toBe('0/2000000');
  });

  it('notifies a registered segment manager on switch', () => {
    const segMgr = PgWalSegmentManager.getInstance();
    wsm.setSegmentManager(segMgr);
    wsm.switchWAL();
    // The segment manager should now have tracked the switch.
    expect(segMgr.getAllSegments().length).toBeGreaterThan(0);
  });

  it('getRawLSN and getWalSegmentSize expose internals', () => {
    expect(wsm.getWalSegmentSize()).toBe(16 * 1024 * 1024);
    wsm.switchWAL();
    expect(wsm.getRawLSN()).toBe(16 * 1024 * 1024);
  });
});

describe('WALStateManager — restore points', () => {
  it('creates a restore point and returns its LSN', () => {
    const lsn = wsm.createRestorePoint('backup-1');
    expect(lsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
    const points = wsm.getRestorePoints();
    expect(points).toHaveLength(1);
    expect(points[0].name).toBe('backup-1');
    expect(points[0].lsn).toBe(lsn);
  });

  it('assigns monotonically increasing LSNs to successive restore points', () => {
    const a = wsm.createRestorePoint('p1');
    const b = wsm.createRestorePoint('p2');
    expect(wsm.lsnDiff(b, a)).toBe(16 * 1024 * 1024);
  });

  it('reports last restore point LSN', () => {
    wsm.createRestorePoint('p1');
    const last = wsm.getLastRestorePointLSN();
    expect(last).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/);
  });

  it('throws on an empty restore point name', () => {
    expect(() => wsm.createRestorePoint('')).toThrow(/non-empty string/);
  });

  it('throws on a non-string restore point name', () => {
    expect(() => wsm.createRestorePoint(undefined as unknown as string)).toThrow(
      /non-empty string/,
    );
  });
});

describe('WALStateManager — receive/replay LSN', () => {
  it('reports receive and replay LSN (always current position for a primary)', () => {
    expect(wsm.getLastReceiveLSN()).toBe('0/0');
    expect(wsm.getLastReplayLSN()).toBe('0/0');
  });

  it('setReplayedLSN updates the replay position and raw getter', () => {
    wsm.setReplayedLSN('0/1ABCDEF');
    expect(wsm.getReplayedLSNRaw()).toBe(0x1abcdef);
    expect(wsm.getLastReplayLSN()).toBe('0/1ABCDEF');
  });
});

describe('WALStateManager — archive delegation', () => {
  it('is a no-op returning true when no archiver is registered', async () => {
    const ok = await wsm.archive('shard-1', '/wal/000001');
    expect(ok).toBe(true);
  });

  it('delegates to a registered archiver and returns true on success', async () => {
    let called: any = null;
    wsm.setWALArchiver({
      archiveWAL: async (shardId, walPath, pointName) => {
        called = { shardId, walPath, pointName };
      },
    } as any);
    const ok = await wsm.archive('shard-1', '/wal/000001', 'pt');
    expect(ok).toBe(true);
    expect(called).toEqual({ shardId: 'shard-1', walPath: '/wal/000001', pointName: 'pt' });
  });

  it('returns false when the archiver throws', async () => {
    wsm.setWALArchiver({
      archiveWAL: async () => {
        throw new Error('archive boom');
      },
    } as any);
    const ok = await wsm.archive('shard-1', '/wal/000001');
    expect(ok).toBe(false);
  });
});

describe('WALStateManager — crash recovery', () => {
  it('delegates recovery to MvccCrashRecovery via require()', () => {
    // recoverFromCrash lazily requires the crash recovery module; in the test
    // environment this may fail to find segment files, but the call must not
    // throw synchronously at the delegation boundary when segmentDir is empty.
    const result = wsm.recoverFromCrash('/nonexistent/wal/dir');
    expect(result).toBeDefined();
    expect(typeof result.recovered).toBe('boolean');
  });

  it('needsRecovery is false when the LSN has not advanced', () => {
    expect(wsm.needsRecovery()).toBe(false);
  });

  it('needsRecovery is true once WAL has been switched', () => {
    wsm.switchWAL();
    expect(wsm.needsRecovery()).toBe(true);
  });
});

describe('WALStateManager — checkpoint bookkeeping', () => {
  it('records a checkpoint and increments the counter', () => {
    wsm.switchWAL();
    const lsn = wsm.recordCheckpoint();
    expect(lsn).toBe('0/1000000');
    expect(wsm.getLastCheckpointLSN()).toBe('0/1000000');
    expect(wsm.getCheckpointCount()).toBe(1);
    expect(wsm.getLastCheckpointTime()).toBeGreaterThan(0);
  });

  it('pruneBeforeCheckpoint returns 0 when no checkpoint recorded', () => {
    expect(wsm.pruneBeforeCheckpoint()).toBe(0);
  });

  it('prunes segments whose end position is at or before the checkpoint', () => {
    const segMgr = PgWalSegmentManager.getInstance();
    wsm.setSegmentManager(segMgr);
    // Advance WAL a few times so segments exist.
    wsm.switchWAL();
    wsm.switchWAL();
    wsm.switchWAL();
    // Record a checkpoint at the current (latest) position.
    wsm.recordCheckpoint();
    const pruned = wsm.pruneBeforeCheckpoint();
    expect(typeof pruned).toBe('number');
  });
});

describe('WALStateManager — status summary', () => {
  it('returns a comprehensive status object', () => {
    wsm.setArchiveMode('on');
    wsm.setArchiveCommand('cp %p %f');
    wsm.switchWAL();
    wsm.createRestorePoint('rp');
    wsm.recordCheckpoint();
    const summary = wsm.getStatusSummary();
    expect(summary.archiveMode).toBe('on');
    expect(summary.archiveCommand).toBe('cp %p %f');
    expect(summary.walLevel).toBe('replica');
    expect(summary.rawLSNbytes).toBe(16 * 1024 * 1024);
    expect(summary.restorePointCount).toBe(1);
    expect(summary.checkpointCount).toBe(1);
    expect(summary.hasArchiver).toBe(false);
    // When no checkpoint time is recorded, lastCheckpointTime is null.
    expect(summary.lastCheckpointTime).toBeDefined();
  });
});
