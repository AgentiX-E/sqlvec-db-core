/**
 * SqlVec DB — Consensus Interfaces
 *
 * Defines the contract for the consensus layer. All packages depend on
 * this interface, never on concrete implementations (RaftGroupManager
 * or NoOpConsensusLayer).
 *
 * @module interfaces/consensus
 */

import type { ApplyEntry } from './storage';

// ── Consensus Entry ──

export interface ConsensusEntry {
  msgId: string;
  shardId: number;
  type: 'upsert' | 'delete' | 'ddl' | 'exec';
  data: Record<string, unknown>;
  raftIndex?: number;
  raftTerm?: number;
}

export interface TopologyChange {
  type: 'peer_added' | 'peer_removed' | 'leader_changed';
  nodeId: string;
  shardId?: string;
  timestamp: number;
}

export interface RaftHealthStatus {
  node: string;
  shardId: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
  isLeader: boolean;
  term: number;
  commitIndex: number;
  appliedIndex: number;
  pipelineDepth?: number;
}

// ── Consensus Layer Interface ──

/**
 * Abstraction over distributed consensus.
 *
 * Implementations:
 * - RaftGroupManager (cluster): full Raft consensus via raft-logic WASM
 * - NoOpConsensusLayer (core): single-node stub, all writes go directly to SQLite
 */
export interface IConsensusLayer {
  readonly isAvailable: boolean;

  /** Start the consensus layer */
  start(): Promise<void>;

  /** Stop the consensus layer */
  stop(): Promise<void>;

  /** Propose a value to a shard's Raft group */
  propose(shardId: number | string, value: ConsensusEntry | string): Promise<number>;

  /** Check if this node is the leader for a shard */
  isLeader(shardId: number | string): Promise<boolean> | boolean;

  /** Get the leader for a shard */
  getLeader(shardId: number | string): string | null;

  /** Get the commit index for a shard */
  getCommitIndex(shardId: number | string): number;

  /** Register a shard with the consensus layer */
  registerShard(
    shardId: string,
    config?: { replica?: unknown; peers?: unknown[]; localRaftIndex?: number }
  ): void;

  /** Remove a shard from the consensus layer */
  removeShard(shardId: string): Promise<void>;

  /** Notify of topology changes */
  notifyTopologyChange(peers: unknown[], localRaftIndex: number): void;

  /** Campaign to become leader */
  campaign(shardId: string): void;

  /** Force leader mode (HA failover) */
  setForceLeader(enabled: boolean): void;

  /** Health status of all shards */
  getHealthStatus(): RaftHealthStatus[];

  /** Get local shard IDs managed by this node */
  getLocalShardIds(): number[];

  /** Subscribe to leader change events */
  onLeaderChange(handler: (nodeId: string, term: number, shardId: string) => void): () => void;

  /** Subscribe to health change events */
  onHealthChange(
    handler: (nodeId: string, healthy: boolean, shardId: string) => void
  ): () => void;
}

// ── Cluster Topology Interface ──

/**
 * Abstraction over cluster topology information.
 * Consensus layer queries this to know about peer status.
 */
export interface IClusterTopology {
  getNodeId(): string;
  getPeerIds(): string[];
  isPeerAlive(peerId: string): boolean;
  onTopologyChange(handler: (change: TopologyChange) => void): () => void;
}
