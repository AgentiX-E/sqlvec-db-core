/**
 * ConsensusLayer — abstraction over Raft group consensus operations.
 *
 * Extracts raft-aware logic from QueryRouter into a focused interface,
 * enabling:
 *   - Single-node (null object pattern): all operations are no-ops
 *   - Multi-node Raft: delegates to RaftGroupManager
 *   - Test: MockConsensusLayer for isolated testing
 *
 * Design: faceted interface with minimal surface area.
 *   - read(): consistent read with scatter-gather
 *   - propose(): fire-and-forget log entry (async replication)
 *   - proposeAndWait(): synchronous commit + apply wait (enterprise)
 *   - Conveniences: isLeader, getLocalShardIds, getPeerCount, flushApplyQueue
 */

export interface ConsensusEntry {
  msgId: string;
  type: string;
  data: Record<string, any>;
}

export interface IConsensusLayer {
  /** Whether a real consensus backend is available (false = null-object/single-node). */
  readonly isAvailable: boolean;

  /** Propose a read-only query for consistent reads. */
  read(shardId: number, sql: string, params?: any[]): Promise<any[]>;

  /** Fire-and-forget propose (async). */
  propose(shardId: number, entry: ConsensusEntry): Promise<void>;

  /** Synchronous propose with commit+apply wait (enterprise). */
  proposeAndWait(shardId: number, entry: ConsensusEntry): Promise<void>;

  /** Number of peers in the cluster. */
  getPeerCount(): number;

  /** Check if this node is the leader for a shard. */
  isLeader(shardId: string): Promise<boolean>;

  /** Shard IDs that this node is a member of. */
  getLocalShardIds(): number[];

  /** Flush the apply queue (after DDL execution). */
  flushApplyQueue(): Promise<void>;
}

/**
 * RaflessConsensus: null-object pattern for single-node setups.
 * All operations are no-ops or return defaults.
 */
export class RaflessConsensus implements IConsensusLayer {
  readonly isAvailable = false;

  async read(_shardId: number, _sql: string, _params?: any[]): Promise<any[]> {
    return [];
  }

  async propose(_shardId: number, _entry: ConsensusEntry): Promise<void> {
    // no-op
  }

  async proposeAndWait(_shardId: number, _entry: ConsensusEntry): Promise<void> {
    // no-op
  }

  getPeerCount(): number {
    return 0;
  }

  async isLeader(_shardId: string): Promise<boolean> {
    return true;
  }

  getLocalShardIds(): number[] {
    return [];
  }

  async flushApplyQueue(): Promise<void> {
    // no-op
  }
}

/**
 * RaftConsensus: wraps a RaftGroupManager instance for multi-node operation.
 * All reads/writes go through the Raft consensus protocol.
 */
export class RaftConsensus implements IConsensusLayer {
  readonly isAvailable = true;

  constructor(private readonly raftGroupManager: any) {}

  async read(shardId: number, sql: string, params?: any[]): Promise<any[]> {
    return this.raftGroupManager.read(shardId, sql, params);
  }

  async propose(shardId: number, entry: ConsensusEntry): Promise<void> {
    await this.raftGroupManager.propose(shardId, entry);
  }

  async proposeAndWait(shardId: number, entry: ConsensusEntry): Promise<void> {
    await this.raftGroupManager.proposeAndWait(shardId, entry);
  }

  getPeerCount(): number {
    return this.raftGroupManager.getPeerCount();
  }

  async isLeader(shardId: string): Promise<boolean> {
    return this.raftGroupManager.isLeader(shardId);
  }

  getLocalShardIds(): number[] {
    return this.raftGroupManager.getLocalShardIds();
  }

  async flushApplyQueue(): Promise<void> {
    await this.raftGroupManager.flushApplyQueue();
  }
}
