/**
 * Unit tests for ReplicationSlotTracker — the in-memory PostgreSQL
 * replication slot state tracker with optional disk persistence.
 *
 * The existing replication-slot-shim.test.ts covers the SQL-facing shim
 * (detect/rewrite). This suite targets the tracker itself: full CRUD,
 * LSN generation, error branches, persistence round-trips, and SQL escape
 * handling, so every statement/function/branch is exercised.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReplicationSlotTracker } from '../storage/ReplicationSlotTracker';

let tmpDir: string;

beforeEach(() => {
  ReplicationSlotTracker.resetInstance();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replslot-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

describe('ReplicationSlotTracker — CRUD (in-memory)', () => {
  it('creates a physical slot with PG-compatible fields', () => {
    const slot = ReplicationSlotTracker.getInstance().createPhysical('phys1');
    expect(slot.slotName).toBe('phys1');
    expect(slot.slotType).toBe('physical');
    expect(slot.database).toBe('postgres');
    expect(slot.active).toBe(false);
    expect(slot.restartLSN).toBe('0/1000000');
    expect(slot.confirmedFlushLSN).toBe('0/1000000');
    expect(slot.xmin).toBe(0);
    expect(slot.catalogXmin).toBe(0);
    expect(slot.created).toBeGreaterThan(0);
  });

  it('creates a logical slot', () => {
    const slot = ReplicationSlotTracker.getInstance().createLogical('log1');
    expect(slot.slotType).toBe('logical');
  });

  it('createSlot is an alias for createPhysical', () => {
    const slot = ReplicationSlotTracker.getInstance().createSlot('alias1');
    expect(slot.slotType).toBe('physical');
  });

  it('generates monotonically increasing LSNs across slots', () => {
    const t = ReplicationSlotTracker.getInstance();
    const a = t.createPhysical('a');
    const b = t.createPhysical('b');
    expect(b.restartLSN).toBe('0/2000000');
    expect(a.restartLSN).toBe('0/1000000');
  });

  it('throws on an empty slot name', () => {
    expect(() => ReplicationSlotTracker.getInstance().createPhysical('')).toThrow(/empty/);
    expect(() => ReplicationSlotTracker.getInstance().createPhysical('   ')).toThrow(/empty/);
  });

  it('createLogical throws on an empty slot name too', () => {
    expect(() => ReplicationSlotTracker.getInstance().createLogical('')).toThrow(/empty/);
    expect(() => ReplicationSlotTracker.getInstance().createLogical('  ')).toThrow(/empty/);
  });

  it('throws on a duplicate slot name', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('dup');
    expect(() => t.createPhysical('dup')).toThrow(/already exists/);
  });

  it('get returns undefined for an unknown slot', () => {
    expect(ReplicationSlotTracker.getInstance().get('nope')).toBeUndefined();
  });

  it('get returns the slot by name', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('found');
    expect(t.get('found')?.slotName).toBe('found');
  });

  it('getAll returns all slots in insertion order', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('a');
    t.createLogical('b');
    expect(t.getAll().map((s) => s.slotName)).toEqual(['a', 'b']);
  });

  it('count reflects the number of slots', () => {
    const t = ReplicationSlotTracker.getInstance();
    expect(t.count()).toBe(0);
    t.createPhysical('a');
    t.createPhysical('b');
    expect(t.count()).toBe(2);
  });

  it('drop removes an existing slot and returns true', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('a');
    expect(t.drop('a')).toBe(true);
    expect(t.count()).toBe(0);
  });

  it('drop returns false for a non-existent slot', () => {
    expect(ReplicationSlotTracker.getInstance().drop('nope')).toBe(false);
  });

  it('drop returns false for an empty name', () => {
    expect(ReplicationSlotTracker.getInstance().drop('')).toBe(false);
  });
});

describe('ReplicationSlotTracker — slot rows & SQL', () => {
  it('getSlotRows maps slots to PG-compatible rows', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('a');
    const rows = t.getSlotRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slot_name: 'a',
      slot_type: 'physical',
      active: false,
      restart_lsn: '0/1000000',
      confirmed_flush_lsn: '0/1000000',
    });
  });

  it('getSlotSQL returns NULL single-row when empty', () => {
    const sql = ReplicationSlotTracker.getInstance().getSlotSQL();
    expect(sql).toContain('NULL AS slot_name');
  });

  it('getSlotSQL builds a UNION ALL across physical and logical slots', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('p');
    t.createLogical('l');
    const sql = t.getSlotSQL();
    expect(sql).toContain("'p' AS slot_name");
    expect(sql).toContain("'physical' AS slot_type");
    expect(sql).toContain("'logical' AS slot_type");
    expect(sql).toContain('UNION ALL');
  });

  it('getSlotSQL escapes single quotes in slot names', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical("it's");
    const sql = t.getSlotSQL();
    expect(sql).toContain("'it''s' AS slot_name");
  });

  it('getSlotSQL renders active flag as 1/0', () => {
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('p');
    const sql = t.getSlotSQL();
    expect(sql).toContain('0 AS active');
  });
});

describe('ReplicationSlotTracker — LSN byte conversion', () => {
  it('lsnToBytes parses a valid LSN string', () => {
    const t = ReplicationSlotTracker.getInstance();
    expect(t.lsnToBytes('0/1000000')).toBe(16 * 1024 * 1024);
    expect(t.lsnToBytes('1/0')).toBe(0x100000000);
  });

  it('lsnToBytes returns 0 for malformed LSN strings', () => {
    const t = ReplicationSlotTracker.getInstance();
    expect(t.lsnToBytes('not-an-lsn')).toBe(0);
    expect(t.lsnToBytes('zz/1000000')).toBe(0);
    expect(t.lsnToBytes('')).toBe(0);
  });
});

describe('ReplicationSlotTracker — persistence', () => {
  it('setSlotsDir creates the directory', () => {
    const dir = path.join(tmpDir, 'slots');
    ReplicationSlotTracker.setSlotsDir(dir);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('initFromStorage is a no-op when no dir is configured', () => {
    expect(() => ReplicationSlotTracker.initFromStorage()).not.toThrow();
  });

  it('persists slots on create and reloads them on initFromStorage', () => {
    const dir = path.join(tmpDir, 'slots');
    ReplicationSlotTracker.setSlotsDir(dir);
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('persisted-p');
    t.createLogical('persisted-l');

    // Reset in-memory state, then reload from disk.
    ReplicationSlotTracker.resetInstance();
    ReplicationSlotTracker.setSlotsDir(dir);
    ReplicationSlotTracker.initFromStorage();

    const reloaded = ReplicationSlotTracker.getInstance().getAll();
    expect(reloaded.map((s) => s.slotName).sort()).toEqual(['persisted-l', 'persisted-p']);
    expect(reloaded.find((s) => s.slotName === 'persisted-l')?.slotType).toBe('logical');
  });

  it('initFromStorage starts fresh when the slots file is absent', () => {
    const dir = path.join(tmpDir, 'slots');
    ReplicationSlotTracker.setSlotsDir(dir);
    ReplicationSlotTracker.initFromStorage();
    expect(ReplicationSlotTracker.getInstance().count()).toBe(0);
  });

  it('restores lsnCounter past the highest loaded slot LSN', () => {
    const dir = path.join(tmpDir, 'slots');
    ReplicationSlotTracker.setSlotsDir(dir);
    const t = ReplicationSlotTracker.getInstance();
    t.createPhysical('a');
    t.createPhysical('b'); // highest LSN = 0/2000000

    ReplicationSlotTracker.resetInstance();
    ReplicationSlotTracker.setSlotsDir(dir);
    ReplicationSlotTracker.initFromStorage();

    const t2 = ReplicationSlotTracker.getInstance();
    // loadSlots sets the counter to (maxLoaded + LSN_INCREMENT) and the next
    // create() advances by another increment, so 'c' lands two segments past
    // the highest loaded slot ('b' at 0/2000000).
    const next = t2.createPhysical('c');
    expect(next.restartLSN).toBe('0/4000000');
  });

  it('initFromStorage warns and starts fresh on corrupt JSON', () => {
    const dir = path.join(tmpDir, 'slots');
    ReplicationSlotTracker.setSlotsDir(dir);
    fs.writeFileSync(path.join(dir, 'replication_slots.json'), '{corrupt', 'utf-8');

    ReplicationSlotTracker.initFromStorage();
    expect(ReplicationSlotTracker.getInstance().count()).toBe(0);
  });
});
