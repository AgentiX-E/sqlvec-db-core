/**
 * MvccWalLogger — Bridge between MVCC DML operations and WAL record writing.
 *
 * When MVCC operations (insert, delete, update, commit, abort) execute,
 * this logger translates them into PostgreSQL-compatible WAL records
 * via the PgWalWriter.
 *
 * ## Record type mapping
 * | MVCC operation | ResourceManager | RecordType    | Data format    |
 * |----------------|-----------------|---------------|----------------|
 * | INSERT         | Heap            | HEAP_INSERT   | XlHeapInsert   |
 * | DELETE         | Heap            | HEAP_DELETE   | XlHeapDelete   |
 * | UPDATE         | Heap            | HEAP_UPDATE   | XlHeapUpdate   |
 * | COMMIT         | Transaction     | XACT_COMMIT   | XlXactCommit   |
 * | ABORT          | Transaction     | XACT_ABORT    | XlXactAbort    |
 *
 * ## Binary payload format
 *
 * Heap INSERT/DELETE/UPDATE payloads include a table name prefix:
 *   [tableLen:2][tableName:tableLen][rest...]
 *
 * Transaction COMMIT/ABORT and CHECKPOINT payloads have no table prefix.
 *
 * ## Integration
 * Call `logInsert` / `logDelete` / `logUpdate` right after the corresponding
 * MVCC executor operation completes.  Call `logCommit` / `logAbort` when a
 * transaction commits or rolls back.
 *
 * @module MvccWalLogger
 */

import { PgWalWriter, HEAP_RECORD_TYPES, XACT_RECORD_TYPES } from '../storage/PgWalWriter';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('MvccWalLogger');

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Size of the table name length prefix in bytes */
export const TABLE_NAME_PREFIX_SIZE = 2;

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

export interface LogInsertParams {
  sessionId: string;
  table: string;
  data: any;
  xmin: number;
}

export interface LogDeleteParams {
  sessionId: string;
  table: string;
  oldData: any;
  xmin: number;
  xmax: number;
}

export interface LogUpdateParams {
  sessionId: string;
  table: string;
  oldData: any;
  newData: any;
  xmin: number;
  xmax: number;
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Encode a table name into a buffer prefix: [tableLen:2][tableName:tableLen].
 * Returns the encoded buffer.
 */
export function encodeTableName(table: string): Buffer {
  const tableBuf = Buffer.from(table, 'utf-8');
  const prefix = Buffer.alloc(TABLE_NAME_PREFIX_SIZE + tableBuf.length);
  prefix.writeUInt16BE(tableBuf.length, 0);
  tableBuf.copy(prefix, TABLE_NAME_PREFIX_SIZE);
  return prefix;
}

/**
 * Decode a table name from a buffer at the given offset.
 * Returns [tableName, offset after the table name bytes].
 */
export function decodeTableName(buf: Buffer, offset: number = 0): [string, number] {
  const tableLen = buf.readUInt16BE(offset);
  const tableName = buf.toString('utf-8', offset + TABLE_NAME_PREFIX_SIZE, offset + TABLE_NAME_PREFIX_SIZE + tableLen);
  return [tableName, offset + TABLE_NAME_PREFIX_SIZE + tableLen];
}

// ──────────────────────────────────────────────
//  MvccWalLogger
// ──────────────────────────────────────────────

export class MvccWalLogger {
  private writer: PgWalWriter;

  /**
   * @param writer  A configured PgWalWriter instance
   */
  constructor(writer: PgWalWriter) {
    this.writer = writer;
  }

  // ── Insert ────────────────────────────────────

  /**
   * Log an INSERT operation to the WAL.
   *
   * Writes a Heap/HEAP_INSERT record with table name prefix and row data.
   * Binary layout:
   *   [tableLen:2][tableName:tableLen][offnum:4][flags:4][xmin:4][xmax:4][jsonData:N]
   *
   * @param params  Insert parameters (session, table, data, xmin)
   */
  logInsert(params: LogInsertParams): void {
    const serialized = JSON.stringify(params.data);
    const serializedLen = Buffer.byteLength(serialized, 'utf-8');

    // Build the table name prefix
    const tablePrefix = encodeTableName(params.table);

    // Allocate buffer: tablePrefix + offnum(4) + flags(4) + xmin(4) + xmax(4) + json(N)
    const dataBuf = Buffer.alloc(tablePrefix.length + 4 + 4 + 4 + 4 + serializedLen);
    let offset = 0;

    // Copy table name prefix
    tablePrefix.copy(dataBuf, offset);
    offset += tablePrefix.length;

    // offnum: 0 (simulated, no real page management)
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // flags: 0
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // xmin
    dataBuf.writeUInt32BE(params.xmin, offset); offset += 4;
    // xmax: 0 (not deleted)
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // serialized data
    dataBuf.write(serialized, offset, serializedLen, 'utf-8');

    this.writer.writeRecord({
      resourceManager: 'Heap',
      recordType: HEAP_RECORD_TYPES.HEAP_INSERT,
      xid: params.xmin,
      data: dataBuf,
      table: params.table,
    });

    logger.trace(
      { table: params.table, xmin: params.xmin },
      'WAL: INSERT logged',
    );
  }

  // ── Delete ────────────────────────────────────

  /**
   * Log a DELETE operation to the WAL.
   *
   * Writes a Heap/HEAP_DELETE record with table name prefix and row data.
   * Binary layout:
   *   [tableLen:2][tableName:tableLen][offnum:4][flags:4][xmax:4][jsonData:N]
   *
   * @param params  Delete parameters (session, table, oldData, xmin, xmax)
   */
  logDelete(params: LogDeleteParams): void {
    const serialized = JSON.stringify(params.oldData);
    const serializedLen = Buffer.byteLength(serialized, 'utf-8');

    // Build the table name prefix
    const tablePrefix = encodeTableName(params.table);

    // Allocate buffer: tablePrefix + offnum(4) + flags(4) + xmax(4) + json(N)
    const dataBuf = Buffer.alloc(tablePrefix.length + 4 + 4 + 4 + serializedLen);
    let offset = 0;

    // Copy table name prefix
    tablePrefix.copy(dataBuf, offset);
    offset += tablePrefix.length;

    // offnum: 0
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // flags: 0
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // xmax: deleting transaction
    dataBuf.writeUInt32BE(params.xmax, offset); offset += 4;
    // serialized old data (extra, used for recovery/undo)
    dataBuf.write(serialized, offset, serializedLen, 'utf-8');

    this.writer.writeRecord({
      resourceManager: 'Heap',
      recordType: HEAP_RECORD_TYPES.HEAP_DELETE,
      xid: params.xmax,
      data: dataBuf,
      table: params.table,
    });

    logger.trace(
      { table: params.table, xmax: params.xmax },
      'WAL: DELETE logged',
    );
  }

  // ── Update ────────────────────────────────────

  /**
   * Log an UPDATE operation to the WAL.
   *
   * Writes a Heap/HEAP_UPDATE record containing both old and new tuple data.
   * Binary layout:
   *   [tableLen:2][tableName:tableLen][offnum:4][newOffnum:4][flags:4][newXmax:4]
   *   [oldLen:4][oldData:N][newLen:4][newData:M]
   *
   * @param params  Update parameters (session, table, oldData, newData, xmin, xmax)
   */
  logUpdate(params: LogUpdateParams): void {
    const oldSerialized = JSON.stringify(params.oldData);
    const newSerialized = JSON.stringify(params.newData);
    const oldLen = Buffer.byteLength(oldSerialized, 'utf-8');
    const newLen = Buffer.byteLength(newSerialized, 'utf-8');

    // Build the table name prefix
    const tablePrefix = encodeTableName(params.table);

    // Allocate buffer: tablePrefix + offnum(4) + newOffnum(4) + flags(4) + newXmax(4) + oldLen(4) + oldData(N) + newLen(4) + newData(M)
    const dataBuf = Buffer.alloc(tablePrefix.length + 4 + 4 + 4 + 4 + 4 + oldLen + 4 + newLen);
    let offset = 0;

    // Copy table name prefix
    tablePrefix.copy(dataBuf, offset);
    offset += tablePrefix.length;

    // offnum
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // newOffnum
    dataBuf.writeUInt32BE(1, offset); offset += 4;
    // flags
    dataBuf.writeUInt32BE(0, offset); offset += 4;
    // newXmax
    dataBuf.writeUInt32BE(params.xmax, offset); offset += 4;
    // oldLen
    dataBuf.writeUInt32BE(oldLen, offset); offset += 4;
    // oldData
    dataBuf.write(oldSerialized, offset, oldLen, 'utf-8'); offset += oldLen;
    // newLen
    dataBuf.writeUInt32BE(newLen, offset); offset += 4;
    // newData
    dataBuf.write(newSerialized, offset, newLen, 'utf-8');

    this.writer.writeRecord({
      resourceManager: 'Heap',
      recordType: HEAP_RECORD_TYPES.HEAP_UPDATE,
      xid: params.xmax,
      data: dataBuf,
      table: params.table,
    });

    logger.trace(
      { table: params.table, xmax: params.xmax },
      'WAL: UPDATE logged',
    );
  }

  // ── Commit ────────────────────────────────────

  /**
   * Log a transaction COMMIT to the WAL.
   *
   * @param sessionId  Session identifier
   * @param xid        Committed transaction ID
   */
  logCommit(sessionId: string, xid: number): void {
    this.writer.writeCommit(xid);
    logger.debug({ sessionId, xid }, 'WAL: COMMIT logged');
  }

  // ── Abort ─────────────────────────────────────

  /**
   * Log a transaction ABORT to the WAL.
   *
   * @param sessionId  Session identifier
   * @param xid        Aborted transaction ID
   */
  logAbort(sessionId: string, xid: number): void {
    this.writer.writeAbort(xid);
    logger.debug({ sessionId, xid }, 'WAL: ABORT logged');
  }

  /**
   * Get the underlying PgWalWriter instance (for direct access).
   */
  getWriter(): PgWalWriter {
    return this.writer;
  }
}

export default MvccWalLogger;
