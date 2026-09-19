/**
 * WALArchiver — archives WAL segment files to durable storage for
 * point-in-time recovery (PITR), mirroring PostgreSQL's `archive_command`.
 *
 * The archiver copies a WAL segment into a shard-scoped archive directory so
 * that a later restore can replay the exact sequence of segments.  The copy
 * is written to a temporary file and atomically renamed into place so a crash
 * mid-write never leaves a partially-written segment that could be mistaken
 * for a valid archive.
 *
 * The target directory is injectable (`opts.directory`) so tests and
 * deployments can redirect archive output without touching the filesystem's
 * real archive location; when omitted, archives land under `./wal_archive`.
 *
 * @module backup/WALArchiver
 */

import { promises as fs } from 'fs';
import * as path from 'path';

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/** Configuration for a {@link WALArchiver}. */
export interface WALArchiverOptions {
  /** Root directory under which archived segments are stored. */
  directory?: string;
}

/** Summary of a single archive operation. */
export interface ArchiveResult {
  /** Source path that was archived. */
  source: string;
  /** Destination path the segment was copied to. */
  destination: string;
  /** Whether the destination already existed (idempotent archive). */
  existed: boolean;
}

// ──────────────────────────────────────────────
//  WALArchiver
// ──────────────────────────────────────────────

/**
 * Archiver that persists WAL segment files for point-in-time recovery.
 *
 * The destination layout is:
 *
 * ```
 * <directory>/<shardId>/<pointName-or-segments>/<basename>
 * ```
 *
 * where `<pointName>` is used when a named restore point is supplied,
 * otherwise the fixed directory `segments` is used so the archive has a
 * stable, discoverable location for replay.
 */
export class WALArchiver {
  private readonly directory: string;

  /**
   * @param opts - Optional configuration.  Defaults the archive root to
   *               `./wal_archive`.
   */
  constructor(opts: WALArchiverOptions = {}) {
    this.directory = opts.directory ?? path.resolve('wal_archive');
  }

  /** Absolute root directory archives are written under. */
  get archiveDirectory(): string {
    return this.directory;
  }

  /**
   * Archive a single WAL file.
   *
   * @param shardId   Shard the WAL belongs to (scopes the destination).
   * @param walPath   Path to the WAL segment file to archive.
   * @param pointName Optional named restore point (subdirectory).
   * @throws When the source does not exist or the copy fails.
   */
  async archiveWAL(shardId: string, walPath: string, pointName?: string): Promise<ArchiveResult> {
    const source = path.resolve(walPath);
    const basename = path.basename(source);

    // Guard against a degenerate/empty shard or filename, which would escape
    // the intended archive layout via path traversal.
    if (!shardId || /[/\\]/.test(shardId)) {
      throw new Error(`Invalid shard identifier: ${JSON.stringify(shardId)}`);
    }
    if (!basename || basename === '.' || basename === '..') {
      throw new Error(`Invalid WAL path: ${JSON.stringify(walPath)}`);
    }

    const subdir = pointName ?? 'segments';
    if (/[/\\]/.test(subdir)) {
      throw new Error(`Invalid restore point name: ${JSON.stringify(pointName)}`);
    }

    const dest = path.join(this.directory, shardId, subdir, basename);

    // Idempotent: if the destination already exists and has the same size,
    // treat the archive as already complete.
    const [srcStat, destStat] = await Promise.all([
      fs.stat(source).catch(() => null),
      fs.stat(dest).catch(() => null),
    ]);

    if (!srcStat) {
      throw new Error(`WAL source does not exist: ${source}`);
    }

    if (destStat && destStat.size === srcStat.size) {
      return { source, destination: dest, existed: true };
    }

    await fs.mkdir(path.dirname(dest), { recursive: true });

    // Copy to a temporary sibling then rename for atomicity.
    const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fs.copyFile(source, tmp);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }

    return { source, destination: dest, existed: false };
  }
}
