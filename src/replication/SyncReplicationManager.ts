/**
 * SyncReplicationManager — synchronous replication state model.
 *
 * Models the PostgreSQL synchronous-replication state for a single-node
 * SQLite deployment.  In a single-node setup there are no standbys, so the
 * manager always reports `async` replication state with an empty standby
 * list.  The concrete multi-node implementation (standby tracking, quorum
 * commit, sync-state transitions) is injected by the cluster layer via
 * {@link setSyncReplicationManager}; this module provides the null-object
 * default plus the shared contracts consumed by the compatibility shims.
 *
 * @module replication/SyncReplicationManager
 */

/** Synchronous-replication mode as reported by `synchronous_standby_names`. */
export type SyncReplMode =
  | 'off'
  | 'async'
  | 'sync'
  | 'quorum'
  | 'potential';

/** Synchronous-replication state exposed to the `pg_stat_replication` shim. */
export type SyncReplState = 'sync' | 'async' | 'quorum' | 'potential';

/** A single registered standby for synchronous-replication tracking. */
export interface SyncStandby {
  /** Application name of the standby (matches `application_name`). */
  name: string;
  /** Whether the standby participates in synchronous replication. */
  isSync: boolean;
  /** Whether the standby currently has an open replication connection. */
  connected: boolean;
  /** Epoch milliseconds of the standby's last acknowledgement. */
  lastAckTime: number;
  /** Connection string used to reach the standby. */
  connStr?: string;
}

/**
 * Convert a PostgreSQL LSN string (e.g. `"0/16B6C50"`) to its 64-bit byte
 * counter value.
 *
 * LSNs are stored as `XLogRecPtr` — a 64-bit log position composed of a
 * 32-bit segment (high) and 32-bit offset (low), separated by `/`.
 * Returns `0` for malformed input.
 */
export function lsnToBytes(lsn: string): number {
  if (typeof lsn !== 'string') return 0;
  const parts = lsn.split('/');
  if (parts.length !== 2) return 0;
  const upper = parseInt(parts[0], 16);
  const lower = parseInt(parts[1], 16);
  if (isNaN(upper) || isNaN(lower)) return 0;
  return upper * 0x100000000 + lower;
}

/**
 * Synchronous-replication manager.
 *
 * The default (single-node) implementation always reports `async` state and
 * no standbys, which is the correct behavior when no replication backend is
 * attached.  A cluster deployment supplies a concrete subclass/instance that
 * overrides these getters with live standby data.
 */
export class SyncReplicationManager {
  /** Current synchronous-replication mode. */
  protected mode: SyncReplMode = 'async';

  /**
   * Current synchronous-replication state.
   *
   * Single-node default: `async` (no synchronous standby exists).
   */
  getSyncState(): SyncReplState {
    return this.mode === 'sync' || this.mode === 'quorum' || this.mode === 'potential'
      ? this.mode
      : 'async';
  }

  /** Registered standbys (empty for single-node). */
  getStandbys(): SyncStandby[] {
    return [];
  }

  /**
   * Comma-separated list of synchronous standby application names, matching
   * the value returned by `SHOW synchronous_standby_names`.
   */
  getStandbyNamesString(): string {
    return this.getStandbys()
      .filter((sb) => sb.isSync)
      .map((sb) => sb.name)
      .join(', ');
  }
}
