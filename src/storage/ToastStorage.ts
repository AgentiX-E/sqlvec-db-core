/**
 * TOAST (The Oversized-Attribute Storage Technique) implementation.
 *
 * Automatically compresses and chunk-stores values > 8 KB.
 * Uses @mongodb-js/zstd for compression when available.
 *
 * @module ToastStorage
 */

import type { Database } from 'better-sqlite3';
import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('ToastStorage');

const TOAST_THRESHOLD = 8192; // 8 KB
const CHUNK_SIZE = 65536; // 64 KB per chunk

/** Supported value types that can be stored/retrieved. */
export type ToastValue = string | Buffer | null;

/**
 * TOAST storage manager.
 *
 * Stores large values in an internal `__toast` table with chunking and
 * optional zstd compression.  Small values are returned inline.
 */
export class ToastStorage {
  private db: Database;
  private zstdReady = false;

  constructor(db: Database) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS __toast (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      oid TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      data BLOB NOT NULL,
      UNIQUE(oid, chunk_index)
    )`);
    // Try to initialise zstd asynchronously — failure is non-fatal.
    import('@mongodb-js/zstd').then(() => { this.zstdReady = true; }).catch(() => {});
  }

  /**
   * Store a value.
   *
   * Returns the inline value for small payloads or a TOAST pointer string
   * (`__TOAST:oid:totalLen:numChunks:type`) for large payloads.
   */
  async store(value: string | Buffer | null): Promise<string | null> {
    if (value === null || value === undefined) return null;

    const buf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;

    if (buf.length < TOAST_THRESHOLD) {
      // Store inline — no compression needed.
      return typeof value === 'string' ? value : buf.toString('base64');
    }

    // TOAST: compress (if zstd ready) and chunk.
    let compressed: Buffer;
    if (this.zstdReady) {
      const zstd = await import('@mongodb-js/zstd');
      compressed = await zstd.compress(buf);
      logger.info(
        { originalSize: buf.length, compressedSize: compressed.length, ratio: (compressed.length / buf.length).toFixed(3) },
        'TOAST: value compressed with zstd',
      );
    } else {
      compressed = buf; // fallback: store uncompressed
      logger.debug(
        { size: buf.length },
        'TOAST: zstd not available, storing uncompressed',
      );
    }

    const oid = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO __toast (oid, chunk_index, data) VALUES (?, ?, ?)',
    );

    const insertMany = this.db.transaction((chunks: Buffer[]) => {
      for (let i = 0; i < chunks.length; i++) {
        stmt.run(oid, i, chunks[i]);
      }
    });

    const chunks: Buffer[] = [];
    for (let offset = 0; offset < compressed.length; offset += CHUNK_SIZE) {
      chunks.push(compressed.subarray(offset, offset + CHUNK_SIZE));
    }
    insertMany(chunks);

    const dataType = typeof value === 'string' ? 'text' : 'binary';
    return `__TOAST:${oid}:${compressed.length}:${chunks.length}:${dataType}`;
  }

  /**
   * Garbage-collect orphaned TOAST entries.
   *
   * Scans all user tables for `__TOAST:` OID references, then deletes
   * any OIDs from `__toast` that are no longer referenced by any
   * user table row.  Should be called periodically (e.g. during VACUUM).
   *
   * @returns The number of orphaned OIDs deleted.
   */
  deleteOrphans(): number {
    const allOids = this.db
      .prepare('SELECT DISTINCT oid FROM __toast')
      .all() as Array<{ oid: string }>;

    if (allOids.length === 0) return 0;

    // Collect all OIDs still referenced in user table columns
    const referencedOids = new Set<string>();
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'")
      .all() as Array<{ name: string }>;

    for (const { name } of tables) {
      // Get text-type columns that could contain TOAST pointers
      const cols = this.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string; type: string }>;
      const toastCandidateCols = cols.filter(c =>
        /text|varchar|char|clob/i.test(c.type) && c.name !== '_xmin' && c.name !== '_xmax'
      );
      if (toastCandidateCols.length === 0) continue;

      // Scan all rows for __TOAST: pointers
      const selectClause = toastCandidateCols.map(c => `"${c.name}"`).join(', ');
      const rows = this.db.prepare(`SELECT ${selectClause} FROM "${name}"`).all() as Record<string, unknown>[];

      for (const row of rows) {
        for (const col of toastCandidateCols) {
          const val = row[col.name];
          if (typeof val === 'string' && val.startsWith('__TOAST:')) {
            referencedOids.add(val.split(':')[1]);
          }
        }
      }
    }

    // Find and delete orphaned OIDs
    let deleted = 0;
    const deleteStmt = this.db.prepare('DELETE FROM __toast WHERE oid = ?');
    for (const { oid } of allOids) {
      if (!referencedOids.has(oid)) {
        deleteStmt.run(oid);
        deleted++;
      }
    }

    if (deleted > 0) {
      logger.info({ deletedOids: deleted, remainingOids: allOids.length - deleted }, 'TOAST GC completed');
    }
    return deleted;
  }

  /**
   * Retrieve a value from TOAST or inline.
   *
   * Automatically decompresses and reassembles chunked data.
   */
  async retrieve(pointer: string | null): Promise<Buffer | string | null> {
    if (pointer === null || pointer === undefined) return null;

    if (!pointer.startsWith('__TOAST:')) {
      // Inline value.
      return pointer;
    }

    const parts = pointer.split(':');
    if (parts.length < 4) return pointer;

    const oid = parts[1];
    const totalLen = parseInt(parts[2], 10);
    const numChunks = parseInt(parts[3], 10);
    const dataType = parts[4] || 'text';

    // Read all chunks in order.
    const rows = this.db
      .prepare('SELECT chunk_index, data FROM __toast WHERE oid = ? ORDER BY chunk_index')
      .all(oid) as Array<{ chunk_index: number; data: Buffer }>;

    const chunks = rows.map((r) => r.data);

    // Reassemble.
    const full = Buffer.concat(chunks);

    // Decompress.
    let decompressed: Buffer;
    if (this.zstdReady) {
      const zstd = await import('@mongodb-js/zstd');
      decompressed = await zstd.decompress(full);
      logger.info(
        { compressedSize: full.length, decompressedSize: decompressed.length, dataType },
        'TOAST: value decompressed with zstd',
      );
    } else {
      decompressed = full;
    }

    if (dataType === 'text') {
      return decompressed.toString('utf8');
    }
    return decompressed;
  }
}
