import { describe, it, expect } from 'vitest';
import {
  SyncReplicationManager,
  lsnToBytes,
  type SyncReplMode,
  type SyncStandby,
} from '../replication/SyncReplicationManager';

// SyncReplicationManager is the null-object default for single-node
// deployments.  It must expose the full contract consumed by the
// pg_stat_replication / synchronous_standby_names compatibility shims,
// reporting `async` state and an empty standby list.
describe('SyncReplicationManager (null-object default)', () => {
  it('reports async state by default', () => {
    const mgr = new SyncReplicationManager();
    expect(mgr.getSyncState()).toBe('async');
  });

  it('reports an empty standby list by default', () => {
    const mgr = new SyncReplicationManager();
    expect(mgr.getStandbys()).toEqual([]);
  });

  it('returns an empty standby-names string by default', () => {
    const mgr = new SyncReplicationManager();
    expect(mgr.getStandbyNamesString()).toBe('');
  });

  it('derives sync state from the configured mode', () => {
    const modes: SyncReplMode[] = ['off', 'async', 'sync', 'quorum', 'potential'];
    const expected: Record<string, string> = {
      off: 'async',
      async: 'async',
      sync: 'sync',
      quorum: 'quorum',
      potential: 'potential',
    };
    for (const mode of modes) {
      const mgr = new SyncReplicationManager();
      // The class exposes `mode` as protected; use a subclass to set it.
      (mgr as unknown as { mode: SyncReplMode }).mode = mode;
      expect(mgr.getSyncState()).toBe(expected[mode]);
    }
  });

  it('builds standby-names from sync standbys via subclass override', () => {
    class Clustered extends SyncReplicationManager {
      getStandbys(): SyncStandby[] {
        return [
          { name: 'standby1', isSync: true, connected: true, lastAckTime: 1, connStr: 'host:5433' },
          { name: 'standby2', isSync: false, connected: true, lastAckTime: 2 },
          { name: 'standby3', isSync: true, connected: false, lastAckTime: 0 },
        ];
      }
      getSyncState() {
        return 'sync';
      }
    }
    const mgr = new Clustered();
    expect(mgr.getStandbyNamesString()).toBe('standby1, standby3');
    expect(mgr.getSyncState()).toBe('sync');
  });
});

describe('lsnToBytes', () => {
  it('converts an LSN string to its 64-bit byte value', () => {
    // "0/1" → (0 << 32) + 1 = 1
    expect(lsnToBytes('0/1')).toBe(1);
    // "1/0" → (1 << 32) = 4294967296
    expect(lsnToBytes('1/0')).toBe(0x100000000);
    // "0/16B6C50" → 0x16B6C50
    expect(lsnToBytes('0/16B6C50')).toBe(0x16b6c50);
  });

  it('returns 0 for malformed input', () => {
    expect(lsnToBytes('')).toBe(0);
    expect(lsnToBytes('nonsense')).toBe(0);
    expect(lsnToBytes('0/1/2')).toBe(0);
    expect(lsnToBytes('zzz/qqq')).toBe(0);
    expect(lsnToBytes(undefined as unknown as string)).toBe(0);
  });
});
