/**
 * ReplicationSlotTracker — PostgreSQL replication slot state tracking for
 * sqlvec-db.
 *
 * PostgreSQL replication slots ensure that WAL segments are not removed
 * before they are consumed by all standbys.  Since sqlvec-db uses
 * SQLite (which has no replication concept), this tracker simulates the
 * slot lifecycle with in-memory state, providing PG-compatible slot
 * names, types, LSN positions, and status fields.
 *
 * ## LSN generation
 *
 * Each slot creation assigns a monotonically-increasing LSN in PostgreSQL's
 * `XXXXXXXX/YYYYYYYY` format (two 32-bit hex values).  This is independent
 * of WALStateManager's LSN counter — replication slot LSNs represent the
 * WAL position at which the slot was created, not the current WAL write
 * position.
 *
 * ## Thread-safety
 *
 * Designed for single-threaded JavaScript.  In multi-shard setups, each
 * worker should create its own ReplicationSlotTracker instance or share
 * via a synchronized context.
 *
 * @module ReplicationSlotTracker
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PinoLogger } from '../monitoring/PinoLogger';

const logger = PinoLogger.forComponent('ReplicationSlotTracker');

// ──────────────────────────────────────────────
//  Types
// ──────────────────────────────────────────────

/**
 * A replication slot record, mirroring key fields from PostgreSQL's
 * `pg_replication_slots` system catalog.
 */
export interface ReplicationSlot {
  /** Name of the replication slot (unique) */
  slotName: string;
  /** Type of replication slot */
  slotType: 'physical' | 'logical';
  /** Database name (always 'postgres' for single-db SQLite mode) */
  database: string;
  /** Whether the slot is currently active (connected to a consumer) */
  active: boolean;
  /** LSN position up to which WAL is retained for this slot */
  restartLSN: string;
  /** LSN position up to which data has been flushed by consumer */
  confirmedFlushLSN: string;
  /** Minimum transaction ID that must be retained (always 0 for SQLite) */
  xmin: number;
  /** Catalog minimum transaction ID (always 0 for SQLite) */
  catalogXmin: number;
  /** Unix timestamp when the slot was created (ms since epoch) */
  created: number;
}

/**
 * PG-compatible row format for `pg_replication_slots` queries.
 */
export interface SlotRow {
  slot_name: string;
  slot_type: string;
  active: boolean;
  restart_lsn: string;
  confirmed_flush_lsn: string;
}

// ──────────────────────────────────────────────
//  Constants
// ──────────────────────────────────────────────

/** Initial LSN byte counter for the first slot */
const INITIAL_LSN = 0;

/** LSN increment per slot creation (16 MB, matching PG WAL segment size) */
const LSN_INCREMENT = 16 * 1024 * 1024;

// ──────────────────────────────────────────────
//  ReplicationSlotTracker
// ──────────────────────────────────────────────

export class ReplicationSlotTracker {
  private static instance: ReplicationSlotTracker;

  /** In-memory slot storage: slotName → ReplicationSlot */
  private slots: Map<string, ReplicationSlot> = new Map();

  /**
   * Monotonically increasing byte counter for generating slot LSNs.
   * Each new slot creation advances this by LSN_INCREMENT (16 MB).
   */
  private lsnCounter: number = INITIAL_LSN;

  /** Directory for slot persistence (null = no persistence) */
  private static slotsDir: string | null = null;

  /** Filename for the persistent slot state */
  private static readonly SLOTS_FILENAME = 'replication_slots.json';

  // ── Construction ───────────────────────────

  private constructor() {
    // Private constructor — use getInstance()
  }

  /**
   * Set the persistence directory for replication slots.
   * Must be called before initFromStorage() or before any create/drop
   * operations to enable auto-persistence.
   */
  static setSlotsDir(dir: string): void {
    ReplicationSlotTracker.slotsDir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Load replication slots from persistent storage.
   * Called automatically on startup after setSlotsDir().
   * Replaces all in-memory state with persisted data.
   */
  static initFromStorage(): void {
    const dir = ReplicationSlotTracker.slotsDir;
    if (!dir) {
      logger.debug('No slots dir configured — skipping load');
      return;
    }
    ReplicationSlotTracker.loadSlots();
  }

  /**
   * Persist all current slots to disk atomically.
   * No-op if no slots dir is configured.
   */
  private static persistSlots(): void {
    const dir = ReplicationSlotTracker.slotsDir;
    if (!dir) return;

    const instance = ReplicationSlotTracker.getInstance();
    const slotsArray = Array.from(instance.slots.values());

    const filePath = path.join(dir, ReplicationSlotTracker.SLOTS_FILENAME);
    const tmpPath = filePath + '.tmp';
    const tmpDir = path.dirname(tmpPath);

    fs.writeFileSync(tmpPath, JSON.stringify(slotsArray, null, 2), 'utf-8');
    try {
      // fsync the file
      const fd = fs.openSync(tmpPath, 'r');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch { /* best-effort fsync */ }
    fs.renameSync(tmpPath, filePath);
    try {
      const dirFd = fs.openSync(tmpDir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    } catch { /* best-effort */ }

    logger.trace({ count: slotsArray.length, path: filePath }, 'Replication slots persisted');
  }

  /**
   * Load replication slots from disk, replacing in-memory state.
   * If the file doesn't exist, loads an empty state.
   */
  private static loadSlots(): void {
    const dir = ReplicationSlotTracker.slotsDir;
    if (!dir) return;

    const filePath = path.join(dir, ReplicationSlotTracker.SLOTS_FILENAME);
    if (!fs.existsSync(filePath)) {
      logger.debug('No replication slots file found — starting fresh');
      return;
    }

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ReplicationSlot[];

      const instance = ReplicationSlotTracker.getInstance();
      instance.slots.clear();

      // Restore lsnCounter from the highest slot LSN
      let maxCounter = instance.lsnCounter;
      for (const slot of parsed) {
        instance.slots.set(slot.slotName, slot);
        const slotBytes = instance.lsnToBytes(slot.restartLSN);
        if (slotBytes > maxCounter) {
          maxCounter = slotBytes;
        }
      }
      // Advance counter past the highest loaded slot
      instance.lsnCounter = Math.max(instance.lsnCounter, maxCounter + LSN_INCREMENT);

      logger.info({ count: parsed.length, path: filePath }, 'Replication slots loaded from disk');
    } catch (err: any) {
      logger.warn({ err: err.message, path: filePath }, 'Failed to load replication slots — starting fresh');
    }
  }

  /**
   * Convert an LSN string to its byte counter value.
   */
  lsnToBytes(lsn: string): number {
    const parts = lsn.split('/');
    if (parts.length !== 2) return 0;
    const upper = parseInt(parts[0], 16);
    const lower = parseInt(parts[1], 16);
    if (isNaN(upper) || isNaN(lower)) return 0;
    return upper * 0x100000000 + lower;
  }

  /**
   * Get the singleton instance.  Created lazily on first access.
   */
  static getInstance(): ReplicationSlotTracker {
    if (!ReplicationSlotTracker.instance) {
      ReplicationSlotTracker.instance = new ReplicationSlotTracker();
    }
    return ReplicationSlotTracker.instance;
  }

  /**
   * Reset the singleton to its initial state.  Used primarily in tests.
   */
  static resetInstance(): void {
    const inst = ReplicationSlotTracker.getInstance();
    inst.slots.clear();
    inst.lsnCounter = INITIAL_LSN;
    ReplicationSlotTracker.slotsDir = null;
    logger.debug('ReplicationSlotTracker reset to initial state');
  }

  // ── Slot creation ──────────────────────────

  /**
   * Create a physical replication slot.
   *
   * @param name  Slot name (must be non-empty)
   * @returns     The newly created ReplicationSlot
   * @throws      If the slot name already exists
   */
  createPhysical(name: string): ReplicationSlot {
    if (!name || name.trim().length === 0) {
      throw new Error('Slot name cannot be empty');
    }

    if (this.slots.has(name)) {
      throw new Error(`Replication slot "${name}" already exists`);
    }

    const lsn = this.generateLSN();
    const now = Date.now();

    const slot: ReplicationSlot = {
      slotName: name,
      slotType: 'physical',
      database: 'postgres',
      active: false,
      restartLSN: lsn,
      confirmedFlushLSN: lsn,
      xmin: 0,
      catalogXmin: 0,
      created: now,
    };

    this.slots.set(name, slot);
    logger.debug({ slotName: name, slotType: 'physical', restartLSN: lsn }, 'Physical replication slot created');
    ReplicationSlotTracker.persistSlots();
    return slot;
  }

  /**
   * Create a logical replication slot.
   *
   * @param name  Slot name (must be non-empty)
   * @returns     The newly created ReplicationSlot
   * @throws      If the slot name already exists
   */
  createLogical(name: string): ReplicationSlot {
    if (!name || name.trim().length === 0) {
      throw new Error('Slot name cannot be empty');
    }

    if (this.slots.has(name)) {
      throw new Error(`Replication slot "${name}" already exists`);
    }

    const lsn = this.generateLSN();
    const now = Date.now();

    const slot: ReplicationSlot = {
      slotName: name,
      slotType: 'logical',
      database: 'postgres',
      active: false,
      restartLSN: lsn,
      confirmedFlushLSN: lsn,
      xmin: 0,
      catalogXmin: 0,
      created: now,
    };

    this.slots.set(name, slot);
    logger.debug({ slotName: name, slotType: 'logical', restartLSN: lsn }, 'Logical replication slot created');
    ReplicationSlotTracker.persistSlots();
    return slot;
  }

  /**
   * Create a replication slot (alias for createPhysical).
   * Provided for backward compatibility with tests.
   *
   * @param name      Slot name (must be non-empty)
   * @param _lsn      Optional LSN string (ignored — LSN is auto-generated)
   * @returns         The newly created ReplicationSlot
   * @throws          If the slot name already exists
   */
  createSlot(name: string, _lsn?: string): ReplicationSlot {
    return this.createPhysical(name);
  }

  /**
   * Drop (remove) a replication slot by name.
   *
   * @param name  Slot name to remove
   * @returns     `true` if the slot was found and removed, `false` if it
   *              did not exist
   */
  drop(name: string): boolean {
    if (!name || name.trim().length === 0) {
      return false;
    }

    const existed = this.slots.has(name);
    if (!existed) {
      logger.warn({ slotName: name }, 'Attempted to drop non-existent replication slot');
      return false;
    }

    this.slots.delete(name);
    logger.debug({ slotName: name }, 'Replication slot dropped');
    ReplicationSlotTracker.persistSlots();
    return true;
  }

  /**
   * Look up a slot by name.
   */
  get(name: string): ReplicationSlot | undefined {
    return this.slots.get(name);
  }

  /**
   * Return all tracked replication slots.
   */
  getAll(): ReplicationSlot[] {
    return Array.from(this.slots.values());
  }

  /**
   * Return the number of tracked replication slots.
   */
  count(): number {
    return this.slots.size;
  }

  /**
   * Return all slots as PG-compatible row objects suitable for constructing
   * a `pg_replication_slots` query result.
   */
  getSlotRows(): SlotRow[] {
    const rows: SlotRow[] = [];
    for (const slot of this.slots.values()) {
      rows.push({
        slot_name: slot.slotName,
        slot_type: slot.slotType,
        active: slot.active,
        restart_lsn: slot.restartLSN,
        confirmed_flush_lsn: slot.confirmedFlushLSN,
      });
    }
    return rows;
  }

  /**
   * Return all slots as a PG-compatible UNION ALL SQL query that returns
   * `slot_name`, `slot_type`, `active`, `restart_lsn`, and
   * `confirmed_flush_lsn` columns.
   *
   * If no slots exist, returns `SELECT NULL AS slot_name` (a single row
   * with NULL values, matching PG behavior for empty slot views).
   */
  getSlotSQL(): string {
    const rows = this.getSlotRows();
    if (rows.length === 0) {
      return 'SELECT NULL AS slot_name, NULL AS slot_type, NULL AS active, NULL AS restart_lsn, NULL AS confirmed_flush_lsn';
    }

    const parts = rows.map((row) => {
      const activeVal = row.active ? '1' : '0';
      const slotType = row.slot_type === 'logical' ? 'logical' : 'physical';
      return [
        `SELECT '${this.escapeSqlString(row.slot_name)}' AS slot_name`,
        `'${slotType}' AS slot_type`,
        `${activeVal} AS active`,
        `'${row.restart_lsn}' AS restart_lsn`,
        `'${row.confirmed_flush_lsn}' AS confirmed_flush_lsn`,
      ].join(', ');
    });

    return parts.join(' UNION ALL ');
  }

  // ── LSN generation ─────────────────────────

  /**
   * Generate the next LSN string in PG `XXXXXXXX/YYYYYYYY` format.
   *
   * The LSN counter advances by `LSN_INCREMENT` (16 MB) on each call,
   * producing a byte-counter-based LSN identical in format to
   * WALStateManager but tracked independently.
   *
   * @returns LSN string (e.g. `'0/1000000'`)
   */
  private generateLSN(): string {
    this.lsnCounter += LSN_INCREMENT;
    const lsn = this.lsnToString(this.lsnCounter);
    logger.trace({ lsn, lsnBytes: this.lsnCounter }, 'Generated new slot LSN');
    return lsn;
  }

  /**
   * Convert a byte count to PG LSN display format `XXXXXXXX/YYYYYYYY`.
   *
   * @param lsnBytes  Byte count
   * @returns         LSN string
   */
  private lsnToString(lsnBytes: number): string {
    const upper = Math.floor(lsnBytes / 0x100000000);
    const lower = lsnBytes % 0x100000000;
    return `${upper.toString(16).toUpperCase()}/${lower.toString(16).toUpperCase()}`;
  }

  /**
   * Escape a string for safe inclusion in a SQL query.
   *
   * Replaces single quotes (`'`) with two single quotes (`''`) to prevent
   * SQL injection.
   */
  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }
}
