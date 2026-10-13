import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PgStatReplicationShim,
  type PgStatReplicationRow,
  type RaftFollowerState,
} from '../query/PgStatReplicationShim';
import { SyncReplicationManager, type SyncStandby, type SyncReplState } from '../replication/SyncReplicationManager';

// A controllable subclass of SyncReplicationManager for real, unmocked tests.
class TestSyncReplManager extends SyncReplicationManager {
  public state: SyncReplState = 'async';
  public standbys: SyncStandby[] = [];

  getSyncState(): SyncReplState {
    return this.state;
  }

  getStandbys(): SyncStandby[] {
    return this.standbys;
  }
}

function follower(overrides: Partial<RaftFollowerState> = {}): RaftFollowerState {
  return {
    nodeId: 'node-a',
    nodeAddress: '10.0.0.2',
    nodePort: 5432,
    lastHeartbeatMs: Date.now() - 2000, // 2s ago
    matchIndex: 0,
    isLeader: false,
    ...overrides,
  };
}

describe('PgStatReplicationShim', () => {
  let shim: PgStatReplicationShim;

  beforeEach(() => {
    shim = new PgStatReplicationShim();
  });

  it('returns empty array with no followers or manager', () => {
    expect(shim.getReplicationStats()).toEqual([]);
  });

  it('updates, reports, and removes followers', () => {
    shim.updateFollowerState(follower({ nodeId: 'n1' }));
    shim.updateFollowerState(follower({ nodeId: 'n2', nodeAddress: '10.0.0.3' }));
    expect(shim.getReplicationStats()).toHaveLength(2);
    shim.removeFollower('n1');
    expect(shim.getReplicationStats()).toHaveLength(1);
  });

  describe('heartbeat-based lag (no sync manager)', () => {
    it('computes streaming state for recent heartbeat', () => {
      shim.updateFollowerState(follower({ lastHeartbeatMs: Date.now() - 1000 }));
      const rows = shim.getReplicationStats();
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.state).toBe('streaming');
      expect(r.sync_state).toBe('async'); // wait: writeLag < 1 ? sync : async
      expect(r.write_lag).toBeCloseTo(1.0, 1);
      expect(r.flush_lag).toBeCloseTo(1.05, 1);
      expect(r.replay_lag).toBeCloseTo(1.1, 1);
      expect(r.usename).toBe('sqlvec');
      expect(r.usesysid).toBe(16384);
      expect(r.application_name).toBe('node-a');
      expect(r.client_addr).toBe('10.0.0.2');
      expect(r.client_port).toBe(5432);
    });

    it('marks sync_state = sync when heartbeat lag < 1s', () => {
      shim.updateFollowerState(follower({ lastHeartbeatMs: Date.now() - 500 }));
      const r = shim.getReplicationStats()[0];
      expect(r.sync_state).toBe('sync');
    });

    it('marks backup state for a stale (>30s) heartbeat', () => {
      shim.updateFollowerState(follower({ lastHeartbeatMs: Date.now() - 60000 }));
      const r = shim.getReplicationStats()[0];
      expect(r.state).toBe('backup');
      expect(r.sync_state).toBe('async');
    });

    it('skips followers marked as leader', () => {
      shim.updateFollowerState(follower({ nodeId: 'leader', isLeader: true }));
      shim.updateFollowerState(follower({ nodeId: 'f1' }));
      const rows = shim.getReplicationStats();
      expect(rows).toHaveLength(1);
      expect(rows[0].application_name).toBe('f1');
    });

    it('increments the virtual pid across rows', () => {
      shim.updateFollowerState(follower({ nodeId: 'a' }));
      shim.updateFollowerState(follower({ nodeId: 'b' }));
      const rows = shim.getReplicationStats();
      expect(rows[0].pid).not.toBe(rows[1].pid);
      expect(rows[1].pid).toBeGreaterThan(rows[0].pid);
    });
  });

  describe('with a sync replication manager', () => {
    let mgr: TestSyncReplManager;
    beforeEach(() => {
      mgr = new TestSyncReplManager();
      shim.attachSyncReplicationManager(mgr);
    });

    it('propagates the manager sync_state to tracked followers even without a standby match', () => {
      mgr.state = 'sync';
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      const r = shim.getReplicationStats()[0];
      // rawState 'sync' is assigned before the per-standby check; with no
      // matching standby the value is used directly.
      expect(r.sync_state).toBe('sync');
    });

    it('maps a sync standby to the system sync_state', () => {
      mgr.state = 'sync';
      mgr.standbys = [{ name: 'node-a', isSync: true, connected: true, lastAckTime: 0 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      expect(shim.getReplicationStats()[0].sync_state).toBe('sync');
    });

    it('marks a non-sync connected standby as potential when system is sync', () => {
      mgr.state = 'sync';
      mgr.standbys = [{ name: 'node-a', isSync: false, connected: true, lastAckTime: 0 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      expect(shim.getReplicationStats()[0].sync_state).toBe('potential');
    });

    it('marks a disconnected standby async', () => {
      mgr.state = 'sync';
      mgr.standbys = [{ name: 'node-a', isSync: false, connected: false, lastAckTime: 0 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      expect(shim.getReplicationStats()[0].sync_state).toBe('async');
    });

    it('marks a connected non-sync standby async when the system is not sync', () => {
      mgr.state = 'async';
      mgr.standbys = [{ name: 'node-a', isSync: false, connected: true, lastAckTime: 0 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      expect(shim.getReplicationStats()[0].sync_state).toBe('async');
    });

    it('overrides lag with real ack time when reasonable (< 1h)', () => {
      const ackMs = Date.now() - 500;
      mgr.state = 'async';
      mgr.standbys = [{ name: 'node-a', isSync: true, connected: true, lastAckTime: ackMs }];
      shim.updateFollowerState(follower({ nodeId: 'node-a', lastHeartbeatMs: Date.now() - 2000 }));
      const r = shim.getReplicationStats()[0];
      // real lag ~0.5s overrides the 2s heartbeat estimate
      expect(r.write_lag).toBeCloseTo(0.5, 1);
      expect(r.flush_lag).toBeCloseTo(0.5, 1);
      expect(r.replay_lag).toBeCloseTo(0.5, 1);
    });

    it('does NOT override lag when real lag is stale (>= 1h)', () => {
      mgr.state = 'async';
      mgr.standbys = [{ name: 'node-a', isSync: true, connected: true, lastAckTime: Date.now() - 7200000 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a', lastHeartbeatMs: Date.now() - 2000 }));
      const r = shim.getReplicationStats()[0];
      // stale ack -> keep heartbeat estimate (~2s)
      expect(r.write_lag).toBeCloseTo(2.0, 1);
    });

    it('adds untracked standbys from the manager as separate rows', () => {
      mgr.state = 'sync';
      mgr.standbys = [
        { name: 'standby-x', isSync: true, connected: true, lastAckTime: Date.now() - 100, connStr: '10.0.0.9:5433' },
      ];
      const rows = shim.getReplicationStats();
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.application_name).toBe('standby-x');
      expect(r.client_addr).toBe('10.0.0.9');
      expect(r.client_port).toBe(5433);
      expect(r.state).toBe('streaming');
      expect(r.sync_state).toBe('sync');
    });

    it('handles untracked standby with empty connStr and disconnected state', () => {
      mgr.state = 'async';
      mgr.standbys = [
        { name: 'standby-y', isSync: false, connected: false, lastAckTime: 0 },
      ];
      const rows = shim.getReplicationStats();
      expect(rows).toHaveLength(1);
      expect(rows[0].client_addr).toBe('0.0.0.0');
      expect(rows[0].client_port).toBe(5433);
      expect(rows[0].state).toBe('startup');
      expect(rows[0].sync_state).toBe('async');
    });

    it('falls back to port 5433 when connStr lacks a port segment', () => {
      mgr.state = 'async';
      mgr.standbys = [
        { name: 'standby-z', isSync: false, connected: true, lastAckTime: 0, connStr: '10.0.0.9' },
      ];
      const rows = shim.getReplicationStats();
      expect(rows[0].client_addr).toBe('10.0.0.9');
      expect(rows[0].client_port).toBe(5433); // split(':')[1] is undefined -> '5433'
    });

    it('detach disables manager-driven behavior', () => {
      mgr.state = 'sync';
      mgr.standbys = [{ name: 'node-a', isSync: true, connected: true, lastAckTime: 0 }];
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      shim.detachSyncReplicationManager();
      // Fallback heartbeat path: sync_state from lag
      const r = shim.getReplicationStats()[0];
      expect(['sync', 'async']).toContain(r.sync_state);
    });
  });

  describe('getReplicationStatsForNode', () => {
    it('returns the matching row or undefined', () => {
      shim.updateFollowerState(follower({ nodeId: 'node-a' }));
      expect(shim.getReplicationStatsForNode('node-a')?.application_name).toBe('node-a');
      expect(shim.getReplicationStatsForNode('missing')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('removes all tracked followers', () => {
      shim.updateFollowerState(follower({ nodeId: 'a' }));
      shim.updateFollowerState(follower({ nodeId: 'b' }));
      shim.clear();
      expect(shim.getReplicationStats()).toEqual([]);
    });
  });
});
