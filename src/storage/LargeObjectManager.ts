/**
 * LargeObjectManager — PostgreSQL Large Object support (pg_largeobject).
 *
 * Manages large objects stored in SQLite via the `__large_objects` table.
 * Implements the PG Large Object API:
 *   - lo_create / lo_open / loread / lowrite
 *   - lo_lseek / lo_close / lo_unlink
 *   - lo_truncate / lo_export / lo_import
 *
 * Each large object is stored as a single row in the SQLite table,
 * with the OID as primary key, and the complete data as a BLOB.
 *
 * @module storage/LargeObjectManager
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('LargeObjectManager');

// ── Constants ────────────────────────────────────────────────────

const LO_TABLE_NAME = '__large_objects';

const LO_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ${LO_TABLE_NAME} (
  oid INTEGER PRIMARY KEY,
  data BLOB,
  size INTEGER
);
`;

// ── File descriptor tracking ────────────────────────────────────

interface LoFdEntry {
  oid: number;
  mode: number;
  /** Current read/write position (offset) */
  position: number;
  /** Cached data buffer for this FD */
  data: Buffer;
  /** Size of the large object at open time */
  size: number;
}

// ── LargeObjectManager ──────────────────────────────────────────

export class LargeObjectManager {
  private db: Database.Database;
  private loDir: string;

  /** Monotonically increasing FD counter */
  private nextFd = 1;
  /** fd → LoFdEntry */
  private openFds = new Map<number, LoFdEntry>();
  /** oid → LoFdEntry (reverse lookup for truncate/unlink) */
  private oidToFds = new Map<number, Set<number>>();

  /**
   * @param basePath - Base directory for the SQLite database file
   */
  constructor(basePath: string) {
    // Ensure directory exists
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }

    this.loDir = basePath;
    const dbPath = path.join(basePath, 'large_objects.db');

    // Open (or create) the large object database
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(LO_TABLE_SCHEMA);

    logger.info({ dbPath }, 'LargeObjectManager initialized');
  }

  /**
   * Create a new large object. If oid is provided, use it; otherwise
   * auto-assign a new OID (highest existing + 1, or 1 if empty).
   *
   * @param oid - Optional requested OID
   * @returns The OID of the created large object
   */
  create(oid?: number): number {
    let loOid: number;

    if (oid !== undefined && oid !== null) {
      // Check if OID already exists
      const existing = this.db.prepare(
        `SELECT oid FROM ${LO_TABLE_NAME} WHERE oid = ?`
      ).get(oid);
      if (existing) {
        throw new Error(`large object ${oid} already exists`);
      }
      loOid = oid;
    } else {
      // Auto-assign OID
      const row = this.db.prepare(
        `SELECT COALESCE(MAX(oid), 0) + 1 AS next_oid FROM ${LO_TABLE_NAME}`
      ).get() as { next_oid: number };
      loOid = row.next_oid;
    }

    this.db.prepare(
      `INSERT INTO ${LO_TABLE_NAME} (oid, data, size) VALUES (?, ?, 0)`
    ).run(loOid, Buffer.alloc(0));

    logger.debug({ oid: loOid }, 'Large object created');
    return loOid;
  }

  /**
   * Open an existing large object for reading/writing.
   *
   * @param oid - The OID of the large object
   * @param mode - Bitmask: 0x20000=INV_READ, 0x40000=INV_WRITE
   * @returns File descriptor (fd) for subsequent operations
   */
  open(oid: number, mode: number): number {
    const row = this.db.prepare(
      `SELECT data, size FROM ${LO_TABLE_NAME} WHERE oid = ?`
    ).get(oid) as { data: Buffer; size: number } | undefined;

    if (!row) {
      throw new Error(`large object ${oid} does not exist`);
    }

    const fd = this.nextFd++;
    const data = row.data || Buffer.alloc(0);

    const entry: LoFdEntry = {
      oid,
      mode,
      position: 0,
      data: Buffer.from(data), // Copy to allow mutation
      size: row.size,
    };

    this.openFds.set(fd, entry);

    // Track reverse mapping for cleanup
    if (!this.oidToFds.has(oid)) {
      this.oidToFds.set(oid, new Set());
    }
    this.oidToFds.get(oid)!.add(fd);

    logger.debug({ oid, fd, mode }, 'Large object opened');
    return fd;
  }

  /**
   * Read data from a large object at the current file position.
   *
   * @param fd - File descriptor from open()
   * @param len - Number of bytes to read
   * @returns Buffer containing the read data (may be shorter than len at EOF)
   */
  read(fd: number, len: number): Buffer {
    const entry = this.openFds.get(fd);
    if (!entry) {
      throw new Error(`invalid large object descriptor: ${fd}`);
    }

    const start = entry.position;
    const end = Math.min(start + len, entry.data.length);
    const readData = entry.data.subarray(start, end);
    entry.position = end;

    return Buffer.from(readData);
  }

  /**
   * Write data to a large object at the current file position.
   *
   * @param fd - File descriptor from open()
   * @param buf - Data to write
   * @returns Number of bytes written
   */
  write(fd: number, buf: Buffer): number {
    const entry = this.openFds.get(fd);
    if (!entry) {
      throw new Error(`invalid large object descriptor: ${fd}`);
    }

    if (!(entry.mode & 0x40000)) {
      throw new Error('large object not opened for write');
    }

    const pos = entry.position;
    const newSize = Math.max(entry.data.length, pos + buf.length);

    // Extend buffer if needed
    if (pos + buf.length > entry.data.length) {
      const newData = Buffer.alloc(newSize);
      entry.data.copy(newData);
      buf.copy(newData, pos);
      entry.data = newData;
    } else {
      buf.copy(entry.data, pos);
    }

    entry.position = pos + buf.length;
    entry.size = Math.max(entry.size, entry.position);

    return buf.length;
  }

  /**
   * Seek to a position in a large object.
   *
   * @param fd - File descriptor from open()
   * @param offset - Offset relative to whence
   * @param whence - 0=SEEK_SET, 1=SEEK_CUR, 2=SEEK_END
   * @returns New position from the beginning of the object
   */
  seek(fd: number, offset: number, whence: number): number {
    const entry = this.openFds.get(fd);
    if (!entry) {
      throw new Error(`invalid large object descriptor: ${fd}`);
    }

    let newPos: number;
    switch (whence) {
      case 0: // SEEK_SET
        newPos = offset;
        break;
      case 1: // SEEK_CUR
        newPos = entry.position + offset;
        break;
      case 2: // SEEK_END
        newPos = entry.data.length + offset;
        break;
      default:
        throw new Error(`invalid whence: ${whence}`);
    }

    if (newPos < 0) {
      throw new Error('negative seek position');
    }

    entry.position = newPos;
    return newPos;
  }

  /**
   * Close a large object descriptor, flushing data to the database.
   *
   * @param fd - File descriptor from open()
   */
  close(fd: number): void {
    const entry = this.openFds.get(fd);
    if (!entry) {
      throw new Error(`invalid large object descriptor: ${fd}`);
    }

    // Flush data to database
    this.db.prepare(
      `UPDATE ${LO_TABLE_NAME} SET data = ?, size = ? WHERE oid = ?`
    ).run(entry.data, entry.size, entry.oid);

    // Clean up tracking
    this.openFds.delete(fd);
    const fdSet = this.oidToFds.get(entry.oid);
    if (fdSet) {
      fdSet.delete(fd);
      if (fdSet.size === 0) {
        this.oidToFds.delete(entry.oid);
      }
    }

    logger.debug({ fd, oid: entry.oid }, 'Large object closed');
  }

  /**
   * Delete a large object by OID. Closes all open FDs for this OID first.
   *
   * @param oid - The OID to unlink
   */
  unlink(oid: number): void {
    // Close any open FDs for this OID
    const fdSet = this.oidToFds.get(oid);
    if (fdSet) {
      for (const fd of [...fdSet]) {
        this.openFds.delete(fd);
      }
      this.oidToFds.delete(oid);
    }

    const result = this.db.prepare(
      `DELETE FROM ${LO_TABLE_NAME} WHERE oid = ?`
    ).run(oid);

    if (result.changes === 0) {
      throw new Error(`large object ${oid} does not exist`);
    }

    logger.debug({ oid }, 'Large object deleted');
  }

  /**
   * Truncate a large object to the specified length.
   *
   * @param fd - File descriptor from open()
   * @param len - New length (truncation point)
   */
  truncate(fd: number, len: number): void {
    const entry = this.openFds.get(fd);
    if (!entry) {
      throw new Error(`invalid large object descriptor: ${fd}`);
    }

    if (len >= entry.data.length) {
      // Extend with zeros
      const newData = Buffer.alloc(len);
      entry.data.copy(newData);
      entry.data = newData;
    } else {
      // Truncate
      entry.data = entry.data.subarray(0, len);
    }

    entry.size = len;
    if (entry.position > len) {
      entry.position = len;
    }

    logger.debug({ fd, oid: entry.oid, len }, 'Large object truncated');
  }

  /**
   * Export a large object to a file on disk.
   *
   * @param oid - OID of the large object
   * @param filePath - Path to write the file
   */
  export(oid: number, filePath: string): void {
    const row = this.db.prepare(
      `SELECT data FROM ${LO_TABLE_NAME} WHERE oid = ?`
    ).get(oid) as { data: Buffer } | undefined;

    if (!row) {
      throw new Error(`large object ${oid} does not exist`);
    }

    const data = row.data || Buffer.alloc(0);
    fs.writeFileSync(filePath, data);

    logger.debug({ oid, filePath, bytes: data.length }, 'Large object exported');
  }

  /**
   * Import a file from disk as a new large object.
   *
   * @param filePath - Path of the file to import
   * @returns The OID assigned to the new large object
   */
  import(filePath: string): number {
    const data = fs.readFileSync(filePath);
    const oid = this.create();
    this.db.prepare(
      `UPDATE ${LO_TABLE_NAME} SET data = ?, size = ? WHERE oid = ?`
    ).run(data, data.length, oid);

    logger.debug({ oid, filePath, bytes: data.length }, 'Large object imported');
    return oid;
  }

  /**
   * Check if a large object exists.
   */
  exists(oid: number): boolean {
    const row = this.db.prepare(
      `SELECT 1 FROM ${LO_TABLE_NAME} WHERE oid = ?`
    ).get(oid);
    return !!row;
  }

  /**
   * Get the size of a large object.
   */
  size(oid: number): number {
    const row = this.db.prepare(
      `SELECT size FROM ${LO_TABLE_NAME} WHERE oid = ?`
    ).get(oid) as { size: number } | undefined;
    return row?.size ?? 0;
  }

  /**
   * Close all open descriptors and release resources.
   */
  closeAll(): void {
    // Flush all open FDs to database
    for (const [fd, entry] of this.openFds) {
      try {
        this.db.prepare(
          `UPDATE ${LO_TABLE_NAME} SET data = ?, size = ? WHERE oid = ?`
        ).run(entry.data, entry.size, entry.oid);
      } catch (err: any) {
        logger.error({ fd, oid: entry.oid, err: err.message }, 'Failed to flush large object on close');
      }
    }
    this.openFds.clear();
    this.oidToFds.clear();
    this.db.close();
    logger.info('LargeObjectManager closed');
  }
}
