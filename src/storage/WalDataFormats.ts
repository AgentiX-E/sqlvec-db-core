/**
 * WalDataFormats — PG-style WAL record data format interfaces.
 *
 * These interfaces mirror the PostgreSQL WAL record payload structures
 * for transaction commit/abort, heap operations (insert, delete, update),
 * and checkpoint records.
 *
 * Each interface describes the structured data that is serialized into
 * the Data portion of a PG WAL record binary format.
 *
 * @module WalDataFormats
 */

/**
 * RM_XACT: commit record payload.
 * Mirrors PG's xl_xact_commit (STM_SNAPSHOT/COMMIT).
 */
export interface XlXactCommit {
  /** Commit timestamp (epoch ms) */
  xactTime: number;
  /** Number of subtransactions */
  nsubxacts: number;
  /** Number of registered relations */
  nrels: number;
  /** Number of shared invalidation messages */
  nmsgs: number;
}

/**
 * RM_XACT: abort record payload.
 * Mirrors PG's xl_xact_abort.
 */
export interface XlXactAbort {
  /** Abort timestamp (epoch ms) */
  xactTime: number;
  /** Number of subtransactions aborted */
  nsubxacts: number;
}

/**
 * RM_XLOG: checkpoint record payload.
 * Mirrors PG's xl_checkpoint (simplified).
 */
export interface XlCheckpoint {
  /** Redo LSN (byte position) */
  redoLSN: number;
  /** Checkpoint timestamp (epoch ms) */
  checkpointTime: number;
  /** Next XID after the checkpoint */
  nextXid: number;
  /** Number of registered relations */
  nrels: number;
}

/**
 * RM_HEAP: insert record payload.
 * Mirrors PG's xl_heap_insert.
 */
export interface XlHeapInsert {
  /** Offset number within the page */
  offnum: number;
  /** Flags (XLH_INSERT_IS_SPECULATIVE, etc.) */
  flags: number;
  /** Tuple data (visibility + columns) */
  tuple: {
    xmin: number;
    xmax: number;
    /** Serialized column data (JSON string) */
    data: string;
  };
}

/**
 * RM_HEAP: delete record payload.
 * Mirrors PG's xl_heap_delete.
 */
export interface XlHeapDelete {
  /** Offset number within the page */
  offnum: number;
  /** Flags (XLH_DELETE_IS_PARTITION, etc.) */
  flags: number;
  /** Deleting transaction ID */
  xmax: number;
}

/**
 * RM_HEAP: update record payload.
 * Mirrors PG's xl_heap_update (simplified).
 */
export interface XlHeapUpdate {
  /** Old tuple offset number */
  offnum: number;
  /** New tuple offset number */
  newOffnum: number;
  /** Flags */
  flags: number;
  /** New xmax (updating transaction) */
  newXmax: number;
  /** Old tuple visibility + data */
  oldTuple: { xmin: number; data: string };
  /** New tuple visibility + data */
  newTuple: { xmin: number; data: string };
}
