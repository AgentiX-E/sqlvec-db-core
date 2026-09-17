/**
 * RaftGroupManager — Raft consensus group manager contract.
 *
 * This module defines the *contract* consumed by `RaftConsensus`
 * (`src/query/ConsensusLayer.ts`) for multi-node operation.  The full
 * implementation lives in the cluster layer
 * (`db-cluster/src/consensus/core/RaftGroupManager.ts`), driven by the
 * raft-logic WASM core.  In single-node operation `QueryRouter` never
 * constructs a `RaftGroupManager`; it falls back to `RaflessConsensus`.
 *
 * The class is therefore an injectable type carrier with no behavior — the
 * method signatures below document the surface that a cluster implementation
 * must satisfy.  They are declared (not implemented) so that core stays free
 * of any distributed consensus logic.
 *
 * @module consensus/RaftGroupManager
 */

import type { ConsensusEntry } from '../interfaces/consensus';

export class RaftGroupManager {
  /** Read a query through the Raft leader for the given shard. */
  read(shardId: number, sql: string, params?: unknown[]): unknown[] {
    throw new Error(`RaftGroupManager.read(${shardId}) not implemented in single-node core`);
  }

  /** Propose an entry to a shard's Raft group (fire-and-forget). */
  async propose(shardId: number | string, valueOrEntry: string | ConsensusEntry): Promise<number | void> {
    throw new Error(`RaftGroupManager.propose(${shardId}) not implemented in single-node core`);
  }

  /** Propose an entry and await its commit. */
  async proposeAndWait(shardId: number, entry: ConsensusEntry): Promise<void> {
    throw new Error(`RaftGroupManager.proposeAndWait(${shardId}) not implemented in single-node core`);
  }

  /** Number of peers in the local Raft group. */
  getPeerCount(): number {
    throw new Error('RaftGroupManager.getPeerCount() not implemented in single-node core');
  }

  /** Whether this node is the leader for the given shard. */
  isLeader(shardId: number | string): boolean {
    throw new Error(`RaftGroupManager.isLeader(${shardId}) not implemented in single-node core`);
  }

  /** Shard ids localized to this node. */
  getLocalShardIds(): number[] {
    throw new Error('RaftGroupManager.getLocalShardIds() not implemented in single-node core');
  }

  /** Flush any pending apply queue. */
  async flushApplyQueue(): Promise<void> {
    throw new Error('RaftGroupManager.flushApplyQueue() not implemented in single-node core');
  }
}
