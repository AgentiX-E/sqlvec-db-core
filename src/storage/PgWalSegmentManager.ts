/**
 * PgWalSegmentManager — PostgreSQL-compatible WAL segment lifecycle management.
 *
 * PostgreSQL maintains a Write-Ahead Log (WAL) as a sequence of fixed-size
 * segment files.  Each segment is identified by a 24-hex-digit name:
 *
 *   TTTTTTTTLLLLLLLLSSSSSSSS
 *
 * Where:
 *   - T = timeline ID  (8 hex digits, zero-padded; default 1)
 *   - L = log segment   (upper 32 bits of LSN)
 *   - S = segment number (lower 32 bits / segment_size)
 *
 * Segments are created sequentially.  When the current segment is filled,
 * a WAL switch occurs, advancing the LSN by `segmentSize` bytes and
 * opening a new segment.  Archived segments that are no longer needed can
 * be marked for removal (recycling).
 *
 * This manager is a singleton that integrates with:
 *   - WALStateManager — called on every `switchWAL()`
 *   - WALArchiver     — consumes `getPendingArchiveSegments()`
 *
 * @module PgWalSegmentManager
 */

import { PinoLogger } from '../logger/PinoLogger';

const logger = PinoLogger.forComponent('PgWalSegmentManager');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/**
 * Describes a single WAL segment file in the segment timeline.
 *
 * Segments proceed through four lifecycle states:
 *   1. **Active**     — Current write target.  Exactly one active segment exists.
 *   2. **Closed**     — No longer the active segment, pending archive.
 *   3. **Archived**   — `markArchived()` called; file safely archived.
 *   4. **Removed**    — `markRemoved()` called; file recycled / deleted.
 */
export interface WalSegment {
  /** PG-format segment name, e.g. `000000010000000000000001` */
  name: string;

  /** Human-readable LSN string at the start of this segment, e.g. `0/1000000` */
  lsn: string;

  /** Timeline ID (default 1) */
  timelineId: number;

  /** Segment number within the current logId (SS component) */
  segmentNumber: number;

  /** Internal byte-position LSN at the start of this segment */
  startLSN: number;

  /** Segment file size in bytes (default 16 MB) */
  size: number;

  /** Absolute file path on disk */
  path: string;

  /** Unix timestamp when this segment was created (ms since epoch) */
  createdAt: number;

  /** Whether this segment's WAL data has been safely archived */
  archived: boolean;

  /** Whether this segment has been recycled / removed from disk */
  removed: boolean;
}

// ──────────────────────────────────────────────
//  Callback type
// ──────────────────────────────────────────────

/**
 * Callback invoked when a segment transitions into the "archived" state.
 */
export type OnArchivedCallback = (segment: WalSegment) => void;

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** PostgreSQL default WAL segment size: 16 MB */
const DEFAULT_SEGMENT_SIZE = 16 * 1024 * 1024;

/** Default timeline ID (PG always starts at timeline 1) */
const DEFAULT_TIMELINE_ID = 1;

// ──────────────────────────────────────────────
//  PgWalSegmentManager
// ──────────────────────────────────────────────

export class PgWalSegmentManager {
  private static instance: PgWalSegmentManager;

  /** All known segments, keyed by the 24-hex-digit name */
  private segments: Map<string, WalSegment> = new Map();

  /** Index into `allSegmentNames()` of the current active segment */
  private currentSegmentIndex: number = 0;

  /** Ordered list of segment names (insertion order) */
  private segmentNames: string[] = [];

  /** Directory where WAL segment files are stored */
  private walDirectory: string = './wal-segments';

  /** Segment size in bytes (default 16 MB) */
  private segmentSize: number = DEFAULT_SEGMENT_SIZE;

  /** Timeline ID (default 1) */
  private timelineId: number = DEFAULT_TIMELINE_ID;

  /**
   * Optional callback invoked when a segment transitions to the
   * "archived" state.  Used by WALArchiver integration.
   */
  private onArchived: OnArchivedCallback | null = null;

  // ── Construction ──────────────────────────────

  private constructor() {
    // Singleton — use getInstance()
  }

  /**
   * Get the singleton instance.
   */
  static getInstance(): PgWalSegmentManager {
    if (!PgWalSegmentManager.instance) {
      PgWalSegmentManager.instance = new PgWalSegmentManager();
    }
    return PgWalSegmentManager.instance;
  }

  // ── Configuration ──────────────────────────────

  /**
   * Configure the segment manager.
   *
   * @param dir          Directory for WAL segment files
   * @param segmentSize  Segment size in bytes (default 16 MB)
   * @param timelineId   Timeline ID (default 1)
   */
  configure(dir?: string, segmentSize?: number, timelineId?: number): void {
    if (dir !== undefined) {
      this.walDirectory = dir;
    }
    if (segmentSize !== undefined) {
      if (segmentSize < 1024) {
        throw new Error(`segmentSize must be >= 1024, got ${segmentSize}`);
      }
      this.segmentSize = segmentSize;
    }
    if (timelineId !== undefined) {
      this.timelineId = timelineId;
    }
    logger.debug(
      { walDirectory: this.walDirectory, segmentSize: this.segmentSize, timelineId: this.timelineId },
      'PgWalSegmentManager configured',
    );
  }

  // ── Segment initialization ─────────────────────

  /**
   * Initialize the first WAL segment at LSN 0/0.
   *
   * If a first segment already exists (non-empty manager), this is a no-op.
   */
  init(): void {
    if (this.segments.size > 0) {
      logger.debug('PgWalSegmentManager already initialized, skipping');
      return;
    }

    const startLSN = 0;
    const segment = this.createSegment(startLSN);
    this.segments.set(segment.name, segment);
    this.segmentNames.push(segment.name);
    this.currentSegmentIndex = 0;
    logger.info({ segmentName: segment.name }, 'First WAL segment initialized');
  }

  // ── Segment switching ──────────────────────────

  /**
   * Switch to a new WAL segment.
   *
   * This closes the current segment (making it pending archive) and creates
   * a new one at the next LSN boundary.
   *
   * @returns  The newly created segment
   */
  switchSegment(): WalSegment {
    const currentSegment = this.getCurrentSegment();
    const newLSN = currentSegment.startLSN + this.segmentSize;

    const newSegment = this.createSegment(newLSN);
    this.segments.set(newSegment.name, newSegment);
    this.segmentNames.push(newSegment.name);
    this.currentSegmentIndex = this.segmentNames.length - 1;

    logger.debug(
      { previousSegment: currentSegment.name, newSegment: newSegment.name },
      'WAL segment switched',
    );
    return newSegment;
  }

  /**
   * Calculate the segment number for a given internal LSN byte value.
   *
   * Segment number = floor(lsn / segmentSize).  This corresponds to the
   * `SSSSSSSS` component of a PG WAL file name.
   *
   * @param lsn  Internal byte-position LSN value
   * @returns    Segment number (non-negative integer)
   */
  segmentNumberForLSN(lsn: number): number {
    return Math.floor(lsn / this.segmentSize);
  }

  // ── Segment retrieval ──────────────────────────

  /**
   * Get the currently active WAL segment.
   *
   * @throws  If no segments have been initialized
   */
  getCurrentSegment(): WalSegment {
    if (this.segmentNames.length === 0) {
      throw new Error('No WAL segments initialized. Call init() first.');
    }
    const name = this.segmentNames[this.currentSegmentIndex];
    const segment = this.segments.get(name);
    /* istanbul ignore next -- segmentNames and segments are kept in sync by init/switchSegment, so a name always resolves */
    if (!segment) {
      throw new Error(`Current segment "${name}" not found in segment map`);
    }
    return segment;
  }

  /**
   * Look up a segment by its 24-hex-digit name.
   *
   * @param name  Segment name, e.g. `000000010000000000000001`
   * @returns     The segment, or `undefined` if not found
   */
  getSegment(name: string): WalSegment | undefined {
    return this.segments.get(name);
  }

  /**
   * Get all segments that have been closed (superseded by a newer segment)
   * but have NOT yet been archived.
   *
   * @returns  Array of pending-archive segments, ordered oldest-first
   */
  getPendingArchiveSegments(): WalSegment[] {
    const result: WalSegment[] = [];
    const currentName = this.segmentNames[this.currentSegmentIndex];

    for (const name of this.segmentNames) {
      if (name === currentName) break; // current segment is still active
      const segment = this.segments.get(name);
      if (segment && !segment.archived && !segment.removed) {
        result.push(segment);
      }
    }
    return result;
  }

  // ── State transitions ──────────────────────────

  /**
   * Mark a segment as archived.
   *
   * If an `onArchived` callback has been registered, it is invoked to
   * notify the archiver (e.g. WALArchiver).
   *
   * @param name  Segment name
   */
  markArchived(name: string): void {
    const segment = this.segments.get(name);
    if (!segment) {
      logger.warn({ segmentName: name }, 'markArchived: segment not found');
      return;
    }
    if (segment.archived) {
      logger.debug({ segmentName: name }, 'markArchived: segment already archived');
      return;
    }
    segment.archived = true;
    logger.debug({ segmentName: name }, 'WAL segment marked as archived');

    // Notify any registered callback (e.g. for WALArchiver integration)
    if (this.onArchived) {
      this.onArchived(segment);
    }
  }

  /**
   * Register a callback that fires when a segment is marked as archived.
   *
   * At most one callback can be registered (last wins).
   */
  setOnArchivedCallback(callback: OnArchivedCallback | null): void {
    this.onArchived = callback;
  }

  /**
   * Mark a segment as removed (recycled).  This should only be called
   * on segments that have already been archived.
   *
   * @param name  Segment name
   */
  markRemoved(name: string): void {
    const segment = this.segments.get(name);
    if (!segment) {
      logger.warn({ segmentName: name }, 'markRemoved: segment not found');
      return;
    }
    if (!segment.archived) {
      logger.warn(
        { segmentName: name },
        'markRemoved: segment is not yet archived — recycling unarchived segments is unsafe',
      );
    }
    segment.removed = true;
    logger.debug({ segmentName: name }, 'WAL segment marked as removed');
  }

  // ── WALStateManager integration ────────────────

  /**
   * Called by WALStateManager.switchWAL() when a WAL switch occurs.
   *
   * This performs a segment switch and returns the new segment.  If
   * the manager has not been initialized yet, `init()` is called first.
   *
   * @param newLSN  The new internal LSN byte position after the switch
   * @returns       The new (now-current) segment
   */
  onWalSwitch(newLSN: number): WalSegment {
    // Auto-initialize if no segments exist
    if (this.segmentNames.length === 0) {
      this.init();
      // After init, current LSN is 0. If newLSN > 0, switch to catch up.
      if (newLSN > 0) {
        return this.switchSegment();
      }
      return this.getCurrentSegment();
    }

    const currentSegment = this.getCurrentSegment();

    // If the new LSN is within the current segment (strictly less than its end),
    // just return the current segment without switching
    if (newLSN < currentSegment.startLSN + this.segmentSize) {
      return currentSegment;
    }

    return this.switchSegment();
  }

  // ── LSN ↔ Segment name resolution ──────────────

  /**
   * Resolve an LSN string to the name of the segment that contains it.
   *
   * @param lsn  LSN in PG format, e.g. `'0/1000000'`
   * @returns    Segment name, e.g. `'000000010000000000000001'`
   * @throws     If the LSN string is invalid
   */
  resolveSegmentName(lsn: string): string {
    const bytes = this.parseLSN(lsn);
    return this.resolveSegmentNameFromValue(bytes);
  }

  /**
   * Resolve an internal LSN byte value to the name of the segment that
   * contains it.
   *
   * @param lsnVal  Internal LSN byte position
   * @returns       Segment name
   */
  resolveSegmentNameFromValue(lsnVal: number): string {
    const segmentNum = this.segmentNumberForLSN(lsnVal);
    const upper = Math.floor(lsnVal / 0x100000000);
    const lower = lsnVal % 0x100000000;
    return this.formatSegmentName(this.timelineId, upper, segmentNum);
  }

  /**
   * Reverse-resolve a segment name back to its starting LSN byte position.
   *
   * @param name  24-hex-digit segment name
   * @returns     LSN byte position at the start of the segment
   * @throws      If the name format is invalid
   */
  resolveSegmentLSN(name: string): number {
    if (!/^[0-9A-Fa-f]{24}$/.test(name)) {
      throw new Error(`Invalid segment name format: "${name}"`);
    }
    const upper = parseInt(name.substring(8, 16), 16);
    const segmentNum = parseInt(name.substring(16, 24), 16);
    // LSN = (upper << 32) + (segmentNum * segmentSize)
    return upper * 0x100000000 + segmentNum * this.segmentSize;
  }

  // ── Diagnostic ─────────────────────────────────

  /**
   * Get all known segments as an array, ordered by creation.
   */
  getAllSegments(): WalSegment[] {
    return this.segmentNames
      .map(name => this.segments.get(name))
      .filter((s): s is WalSegment => s !== undefined);
  }

  /**
   * Reset the manager to its initial (uninitialized) state.
   *
   * Used primarily in tests.  All segment data is discarded and
   * configuration is restored to defaults.
   */
  reset(): void {
    this.segments.clear();
    this.segmentNames = [];
    this.currentSegmentIndex = 0;
    this.onArchived = null;
    this.walDirectory = './wal-segments';
    this.segmentSize = DEFAULT_SEGMENT_SIZE;
    this.timelineId = DEFAULT_TIMELINE_ID;
    logger.debug('PgWalSegmentManager reset');
  }

  /**
   * Get the current segment size in bytes.
   */
  getSegmentSize(): number {
    return this.segmentSize;
  }

  /**
   * Get the WAL directory path.
   */
  getWalDirectory(): string {
    return this.walDirectory;
  }

  // ── Internal helpers ───────────────────────────

  /**
   * Create a new segment descriptor at the given starting LSN byte position.
   * Does NOT insert it into the segment map — caller is responsible for that.
   */
  private createSegment(startLSN: number): WalSegment {
    const upper = Math.floor(startLSN / 0x100000000);
    const lower = startLSN % 0x100000000;
    const segmentNum = this.segmentNumberForLSN(startLSN);

    const name = this.formatSegmentName(this.timelineId, upper, segmentNum);
    const lsnStr = this.formatLSN(startLSN);
    const segPath = `${this.walDirectory}/${name}.wal`;

    return {
      name,
      lsn: lsnStr,
      timelineId: this.timelineId,
      segmentNumber: segmentNum,
      startLSN,
      size: this.segmentSize,
      path: segPath,
      createdAt: Date.now(),
      archived: false,
      removed: false,
    };
  }

  /**
   * Format a PG WAL segment name from its components.
   *
   *   TTTTTTTTLLLLLLLLSSSSSSSS
   */
  private formatSegmentName(timeline: number, logId: number, segmentNum: number): string {
    const t = timeline.toString(16).toUpperCase().padStart(8, '0');
    const l = logId.toString(16).toUpperCase().padStart(8, '0');
    const s = segmentNum.toString(16).toUpperCase().padStart(8, '0');
    return `${t}${l}${s}`;
  }

  /**
   * Convert an internal byte-count LSN to the PG display format
   * `XXXXXXXX/YYYYYYYY`.
   */
  private formatLSN(lsnBytes: number): string {
    const upper = Math.floor(lsnBytes / 0x100000000);
    const lower = lsnBytes % 0x100000000;
    return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
  }

  /**
   * Parse a PG-format LSN string `XXXXXXXX/YYYYYYYY` to a byte count.
   */
  private parseLSN(lsn: string): number {
    const parts = lsn.split('/');
    if (parts.length !== 2) {
      throw new Error(`Invalid LSN format: "${lsn}"`);
    }
    const upper = parseInt(parts[0], 16);
    const lower = parseInt(parts[1], 16);
    if (isNaN(upper) || isNaN(lower)) {
      throw new Error(`Invalid LSN format: "${lsn}" (non-hex parts)`);
    }
    return upper * 0x100000000 + lower;
  }
}

export default PgWalSegmentManager;
