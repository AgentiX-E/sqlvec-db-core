/**
 * PgWalWriter — Physical WAL writer for PostgreSQL-compatible WAL segments.
 *
 * Writes DML operations as binary WAL records into segment buffers, managing
 * LSN tracking, segment auto-switching, and record serialization in a format
 * that mimics PostgreSQL's WAL record layout.
 *
 * ## Binary record format (30-byte header + variable data)
 * ```
 * [8 bytes] LSN (uint64, big-endian)
 * [8 bytes] Prev-LSN (uint64, big-endian)
 * [4 bytes] XID (uint32, big-endian)
 * [4 bytes] ResourceManager enum (uint32, big-endian)
 * [2 bytes] RecordType (uint16, big-endian)
 * [4 bytes] DataLength (uint32, big-endian)
 * [N bytes] Data
 * ```
 *
 * ## ResourceManager enum values
 * | Name          | Value | Description          |
 * |---------------|-------|----------------------|
 * | XLOG          | 0     | XLOG self ops        |
 * | Transaction   | 10    | RM_XACT              |
 * | Heap2         | 11    | RM_HEAP2             |
 * | Heap          | 12    | RM_HEAP              |
 * | Btree         | 13    | RM_BTREE             |
 *
 * ## Integration
 * Connects to `PgWalSegmentManager` (segment lifecycle) and
 * `WALStateManager` (LSN tracking).  For DML → WAL bridging, see
 * `MvccWalLogger`.
 *
 * @module PgWalWriter
 */

import { PinoLogger } from '../logger/PinoLogger';
import { PgWalSegmentManager } from './PgWalSegmentManager';
import { WALStateManager } from './WALStateManager';

const logger = PinoLogger.forComponent('PgWalWriter');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** PG default XLOG page size */
const XLOG_PAGE_SIZE = 8192;

/** Binary header size per WAL record: 8+8+4+4+2+4 = 30 bytes */
export const RECORD_HEADER_SIZE = 30;

/** ResourceManager enum values (PG-compatible) */
export const RESOURCE_MANAGERS = {
  XLOG: 0,
  Transaction: 10,
  Heap2: 11,
  Heap: 12,
  Btree: 13,
} as const;

/** RM_XLOG record subtypes */
export const XLOG_RECORD_TYPES = {
  CHECKPOINT_SHUTDOWN: 0,
  CHECKPOINT_ONLINE: 1,
  SWITCH: 2,
  NEXTOID: 3,
} as const;

/** RM_XACT record subtypes */
export const XACT_RECORD_TYPES = {
  XACT_COMMIT: 0,
  XACT_ABORT: 1,
  XACT_PREPARE: 2,
  XACT_COMMIT_PREPARED: 3,
  XACT_ABORT_PREPARED: 4,
} as const;

/** RM_HEAP record subtypes */
export const HEAP_RECORD_TYPES = {
  HEAP_INSERT: 0,
  HEAP_DELETE: 1,
  HEAP_UPDATE: 2,
  HEAP_HOT_UPDATE: 3,
} as const;

/** Default LSN for "no previous record" */
const LSN_ZERO = '0/0';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/**
 * A single WAL record in logical form.
 */
export interface WalRecord {
  /** LSN string in PG format (XXXXXXXX/YYYYYYYY) */
  lsn: string;
  /** Previous record's LSN */
  prevLsn: string;
  /** Transaction ID */
  xid: number;
  /** PG resource manager type name */
  resourceManager: string;
  /** Record subtype within the resource manager */
  recordType: number;
  /** Actual binary payload */
  data: Buffer;
  /** Timestamp when the record was created (epoch ms) */
  timestamp: number;
}

/**
 * Parameters for writing a WAL record.
 */
export interface WriteRecordParams {
  /** Resource manager name (e.g., "XLOG", "Transaction", "Heap") */
  resourceManager: string;
  /** Record subtype */
  recordType: number;
  /** Transaction ID */
  xid: number;
  /** Binary payload */
  data: Buffer;
  /** Optional table name (stored as metadata, not in binary format) */
  table?: string;
  /** Optional schema name */
  schema?: string;
}

/**
 * Callback invoked after a WAL record is written.
 * Receives the fully-formed WalRecord with its assigned LSN.
 */
export type WalRecordCallback = (record: WalRecord) => void;

// ──── Internal types ─────────────────────────────────────────────

/**
 * Raw binary record as deserialized from a segment buffer.
 * Internal representation before converting to WalRecord.
 */
interface RawRecord {
  lsnValue: number;
  prevLsnValue: number;
  xid: number;
  resourceManagerValue: number;
  recordType: number;
  data: Buffer;
}

// ──────────────────────────────────────────────
//  PgWalWriter
// ──────────────────────────────────────────────

export class PgWalWriter {
  private static instance: PgWalWriter;

  private segmentManager!: PgWalSegmentManager;
  private walState!: WALStateManager;
  private configured = false;

  /** Memory buffer for the current WAL segment */
  private currentSegment: Buffer = Buffer.alloc(0);

  /** PG default XLOG page size */
  private xlogPageSize = XLOG_PAGE_SIZE;

  /** All records written since last reset (or segment initialization) */
  private records: WalRecord[] = [];

  /** Listeners for wal:record events */
  private recordListeners: WalRecordCallback[] = [];

  /** Current byte offset within the current segment */
  private currentLSNOffset = 0;

  /** LSN of the last written record (as byte value) */
  private lastLSNBytes = 0;

  // ── Construction ──────────────────────────────

  private constructor() {
    // Singleton — use getInstance()
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): PgWalWriter {
    if (!PgWalWriter.instance) {
      PgWalWriter.instance = new PgWalWriter();
    }
    return PgWalWriter.instance;
  }

  // ── Configuration ──────────────────────────────

  /**
   * Configure the WAL writer with the segment manager and WAL state manager.
   * Must be called before any write operations.
   */
  configure(
    segmentManager: PgWalSegmentManager,
    walState: WALStateManager,
  ): void {
    this.segmentManager = segmentManager;
    this.walState = walState;
    this.configured = true;

    // Ensure the segment manager has at least one segment initialized
    if (this.segmentManager.getAllSegments().length === 0) {
      this.segmentManager.init();
    }

    // Allocate a fresh segment buffer
    this.allocateSegmentBuffer();
    this.currentLSNOffset = 0;
    this.lastLSNBytes = 0;

    logger.debug('PgWalWriter configured');
  }

  /**
   * Register a callback to be invoked after each WAL record is written.
   * The callback receives the fully-formed WalRecord (with LSN assigned).
   * Can be used to bridge WAL records to other subsystems (e.g., PITR archive).
   */
  onRecord(cb: WalRecordCallback): void {
    this.recordListeners.push(cb);
  }

  /**
   * Remove a previously registered record callback.
   * Uses reference equality to find and remove the callback.
   *
   * @returns true if the callback was found and removed, false otherwise
   */
  removeRecordListener(cb: WalRecordCallback): boolean {
    const idx = this.recordListeners.indexOf(cb);
    if (idx === -1) return false;
    this.recordListeners.splice(idx, 1);
    return true;
  }

  // ── Writing records ────────────────────────────

  /**
   * Write a single WAL record.
   *
   * Automatically switches to a new segment if the current one is full.
   * Returns the written WalRecord with its assigned LSN.
   */
  writeRecord(params: WriteRecordParams): WalRecord {
    this.ensureConfigured();

    const seg = this.segmentManager.getCurrentSegment();
    const rmValue = this.resourceManagerNameToValue(params.resourceManager);
    const recordSize = RECORD_HEADER_SIZE + params.data.length;

    // Auto-switch if record doesn't fit in the remaining segment space
    if (this.currentLSNOffset + recordSize > this.currentSegment.length) {
      // Pad remaining space in current segment (simulated)
      this.padSegment(seg);
      // Switch to a new segment
      const newSeg = this.segmentManager.switchSegment();
      this.allocateSegmentBuffer();
      this.currentLSNOffset = 0;
      logger.debug(
        { newSegmentName: newSeg.name, oldLSN: this.lastLSNBytes },
        'WAL segment auto-switched (segment full)',
      );
    }

    // Compute LSN for this record
    const segLsn = this.getCurrentSegmentLSN();
    const lsnBytes = segLsn + this.currentLSNOffset;
    const lsn = this.lsnBytesToString(lsnBytes);
    const prevLsn =
      this.lastLSNBytes === 0
        ? LSN_ZERO
        : this.lsnBytesToString(this.lastLSNBytes);

    // Serialize the record header + data into the segment buffer
    this.serializeRecord(
      this.currentSegment,
      this.currentLSNOffset,
      {
        lsnValue: lsnBytes,
        prevLsnValue: this.lastLSNBytes,
        xid: params.xid,
        resourceManagerValue: rmValue,
        recordType: params.recordType,
        data: params.data,
      },
    );

    // Create the logical record
    const record: WalRecord = {
      lsn,
      prevLsn,
      xid: params.xid,
      resourceManager: params.resourceManager,
      recordType: params.recordType,
      data: params.data,
      timestamp: Date.now(),
    };

    this.records.push(record);
    this.currentLSNOffset += recordSize;
    this.lastLSNBytes = lsnBytes;

    logger.trace({ lsn, rm: params.resourceManager, type: params.recordType }, 'WAL record written');

    // Notify all registered listeners (PITR bridge, etc.)
    for (const cb of this.recordListeners) {
      try {
        cb(record);
      } catch (err: any) {
        logger.warn({ lsn, error: err.message }, 'WAL record listener failed');
      }
    }

    return record;
  }

  /**
   * Write a CHECKPOINT record (XLOG resource manager).
   */
  writeCheckpoint(xid: number): WalRecord {
    const data = Buffer.alloc(16);
    data.writeBigUInt64BE(BigInt(this.lastLSNBytes || 0), 0); // redoLSN
    data.writeBigUInt64BE(BigInt(Date.now()), 8);             // checkpointTime
    return this.writeRecord({
      resourceManager: 'XLOG',
      recordType: XLOG_RECORD_TYPES.CHECKPOINT_ONLINE,
      xid,
      data,
    });
  }

  /**
   * Write a COMMIT record (Transaction resource manager, XACT_COMMIT).
   */
  writeCommit(xid: number): WalRecord {
    const data = Buffer.alloc(12);
    data.writeBigUInt64BE(BigInt(Date.now()), 0); // xactTime
    data.writeUInt32BE(0, 8);                     // nsubxacts (default 0)
    return this.writeRecord({
      resourceManager: 'Transaction',
      recordType: XACT_RECORD_TYPES.XACT_COMMIT,
      xid,
      data,
    });
  }

  /**
   * Write an ABORT record (Transaction resource manager, XACT_ABORT).
   */
  writeAbort(xid: number): WalRecord {
    const data = Buffer.alloc(12);
    data.writeBigUInt64BE(BigInt(Date.now()), 0); // xactTime
    data.writeUInt32BE(0, 8);                     // nsubxacts
    return this.writeRecord({
      resourceManager: 'Transaction',
      recordType: XACT_RECORD_TYPES.XACT_ABORT,
      xid,
      data,
    });
  }

  // ── Segment management ─────────────────────────

  /**
   * Flush the current segment buffer to disk.
   * Writes the data up to `currentLSNOffset` bytes to the segment's file path.
   */
  flushSegment(): void {
    this.ensureConfigured();

    const seg = this.segmentManager.getCurrentSegment();
    const dataToWrite = this.currentSegment.subarray(0, this.currentLSNOffset);

    // Write the segment data to disk
    const fs = require('fs');
    const dir = this.segmentManager.getWalDirectory();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(seg.path, dataToWrite);

    logger.debug(
      { path: seg.path, bytesWritten: dataToWrite.length },
      'WAL segment flushed to disk',
    );
  }

  // ── Accessors ──────────────────────────────────

  /**
   * Get a read-only snapshot of all records written since the last reset.
   */
  getRecords(): ReadonlyArray<WalRecord> {
    return [...this.records];
  }

  /**
   * Get the current segment's binary data (only the portion written so far).
   */
  getSegmentData(): Buffer {
    return this.currentSegment.subarray(0, this.currentLSNOffset);
  }

  /**
   * Parse a binary WAL segment buffer into an array of WalRecord objects.
   *
   * @param data  Raw binary segment data
   * @returns     Array of deserialized WalRecord instances
   */
  static parseSegment(data: Buffer): WalRecord[] {
    const records: WalRecord[] = [];
    let offset = 0;

    while (offset + RECORD_HEADER_SIZE <= data.length) {
      const lsnValue = Number(data.readBigUInt64BE(offset));
      const prevLsnValue = Number(data.readBigUInt64BE(offset + 8));
      const xid = data.readUInt32BE(offset + 16);
      const rmValue = data.readUInt32BE(offset + 20);
      const recordType = data.readUInt16BE(offset + 24);
      const dataLength = data.readUInt32BE(offset + 26);

      // Check if we have enough data for the payload
      if (offset + RECORD_HEADER_SIZE + dataLength > data.length) {
        break; // Partial/corrupt record at end of buffer
      }

      const payload = Buffer.alloc(dataLength);
      data.copy(payload, 0, offset + RECORD_HEADER_SIZE, offset + RECORD_HEADER_SIZE + dataLength);

      const rmName = PgWalWriter.resourceManagerValueToName(rmValue);

      records.push({
        lsn: PgWalWriter.lsnBytesToString(lsnValue),
        prevLsn: PgWalWriter.lsnBytesToString(prevLsnValue),
        xid,
        resourceManager: rmName,
        recordType,
        data: payload,
        timestamp: 0, // Not stored in binary format
      });

      offset += RECORD_HEADER_SIZE + dataLength;
    }

    return records;
  }

  /**
   * Reset the writer to its initial state (primarily for testing).
   */
  reset(): void {
    this.records = [];
    this.currentSegment = Buffer.alloc(0);
    this.currentLSNOffset = 0;
    this.lastLSNBytes = 0;
    this.configured = false;
    this.segmentManager = undefined as any;
    this.walState = undefined as any;
    logger.debug('PgWalWriter reset');
  }

  // ── Resource manager name ↔ value ──────────────

  /**
   * Convert a resource manager name to its enum value.
   */
  private resourceManagerNameToValue(name: string): number {
    const map: Record<string, number> = {
      XLOG: RESOURCE_MANAGERS.XLOG,
      Transaction: RESOURCE_MANAGERS.Transaction,
      Heap2: RESOURCE_MANAGERS.Heap2,
      Heap: RESOURCE_MANAGERS.Heap,
      Btree: RESOURCE_MANAGERS.Btree,
    };
    const value = map[name];
    if (value === undefined) {
      throw new Error(`Unknown resource manager: "${name}"`);
    }
    return value;
  }

  /**
   * Convert a resource manager enum value to its name.
   */
  static resourceManagerValueToName(value: number): string {
    const map: Record<number, string> = {
      [RESOURCE_MANAGERS.XLOG]: 'XLOG',
      [RESOURCE_MANAGERS.Transaction]: 'Transaction',
      [RESOURCE_MANAGERS.Heap2]: 'Heap2',
      [RESOURCE_MANAGERS.Heap]: 'Heap',
      [RESOURCE_MANAGERS.Btree]: 'Btree',
    };
    return map[value] || `UNKNOWN(${value})`;
  }

  // ── LSN utilities ──────────────────────────────

  /**
   * Convert a byte-position LSN to PG display format `XXXXXXXX/YYYYYYYY`.
   */
  private static lsnBytesToString(lsnBytes: number): string {
    const upper = Math.floor(lsnBytes / 0x100000000);
    const lower = lsnBytes % 0x100000000;
    return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
  }

  /**
   * Instance wrapper for the static lsnBytesToString.
   */
  private lsnBytesToString(lsnBytes: number): string {
    return PgWalWriter.lsnBytesToString(lsnBytes);
  }

  /**
   * Serialize a raw record into the segment buffer at the given offset.
   */
  private serializeRecord(
    buffer: Buffer,
    offset: number,
    raw: RawRecord,
  ): void {
    buffer.writeBigUInt64BE(BigInt(raw.lsnValue), offset);
    buffer.writeBigUInt64BE(BigInt(raw.prevLsnValue), offset + 8);
    buffer.writeUInt32BE(raw.xid, offset + 16);
    buffer.writeUInt32BE(raw.resourceManagerValue, offset + 20);
    buffer.writeUInt16BE(raw.recordType, offset + 24);
    buffer.writeUInt32BE(raw.data.length, offset + 26);
    raw.data.copy(buffer, offset + RECORD_HEADER_SIZE);
  }

  // ── Helpers ────────────────────────────────────

  /**
   * Ensure the writer has been configured before any operation.
   */
  private ensureConfigured(): void {
    if (!this.configured) {
      throw new Error(
        'PgWalWriter is not configured. Call configure() first.',
      );
    }
  }

  /**
   * Get the LSN byte position at the start of the current segment.
   */
  private getCurrentSegmentLSN(): number {
    const seg = this.segmentManager.getCurrentSegment();
    return seg.startLSN;
  }

  /**
   * Allocate a fresh buffer for the current segment.
   */
  private allocateSegmentBuffer(): void {
    const segSize = this.segmentManager.getSegmentSize();
    this.currentSegment = Buffer.alloc(segSize);
  }

  /**
   * Pad remaining space in the current segment (simulated).
   * In real PG, this would fill with XLOG page headers / padding.
   */
  private padSegment(_seg: any): void {
    // In a real implementation, we'd write XLOG page headers at
    // 8KB boundaries. For our simulation, we just zero-fill.
    // The important thing is that currentLSNOffset is known.
    // No action needed — the segment buffer is pre-allocated.
  }

  /**
   * Get the current byte offset within the segment (for diagnostics).
   */
  getCurrentOffset(): number {
    return this.currentLSNOffset;
  }

  /**
   * Get the last written LSN as a byte value (for diagnostics).
   */
  getLastLSNBytes(): number {
    return this.lastLSNBytes;
  }
}

export default PgWalWriter;
