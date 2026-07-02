/**
 * SqlVec DB — Protocol Interfaces
 *
 * Shared protocol-level types that are referenced by both
 * the protocol layer (node) and the consensus/replication layers (cluster).
 * Extracted here to break cross-layer import cycles.
 *
 * @module interfaces/protocol
 */

// ── Two-Phase Commit ──

export interface PreparedXact {
  gid: string;           // Global transaction identifier
  owner: string;         // User who prepared the transaction
  database: string;      // Database name
  prepared: string;      // ISO timestamp
}

export interface TwoPhaseWALEntry {
  type: 'prepare' | 'commit_prepared' | 'rollback_prepared';
  gid: string;
  xid: number;
  timestamp: number;
}

// ── Replication Slot ──

export interface ReplicationSlot {
  slot_name: string;
  plugin: string;
  slot_type: 'physical' | 'logical';
  datoid: number;
  database: string;
  active: boolean;
  active_pid: number | null;
  xmin: number | null;
  catalog_xmin: number | null;
  restart_lsn: string;
  confirmed_flush_lsn: string;
  wal_status: string;
  safe_wal_size: number | null;
  two_phase: boolean;
  conflicting: boolean;
}

// ── Idle Transaction Timeout ──

export const DEFAULT_IDLE_TXN_TIMEOUT_MS = 0; // 0 = disabled

export interface IdleTxnTimeoutConfig {
  timeoutMs: number;
  checkIntervalMs: number;
}
