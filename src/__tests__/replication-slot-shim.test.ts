/**
 * replication-slot-shim.test.ts — Coverage tests for ReplicationSlotShim
 * (PostgreSQL replication slot compatibility shim).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { detectReplSlot, rewriteReplSlot } from '../query/ReplicationSlotShim';
import { ReplicationSlotTracker } from '../storage/ReplicationSlotTracker';

beforeEach(() => {
  ReplicationSlotTracker.resetInstance();
});

describe('detectReplSlot', () => {
  it('returns false for non-string input', () => {
    expect(detectReplSlot(undefined as unknown as string)).toBe(false);
    expect(detectReplSlot(null as unknown as string)).toBe(false);
    expect(detectReplSlot(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectReplSlot('')).toBe(false);
    expect(detectReplSlot('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectReplSlot('SELECT 1')).toBe(false);
    expect(detectReplSlot('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects create physical replication slot', () => {
    expect(detectReplSlot("SELECT pg_create_physical_replication_slot('slot1');")).toBe(true);
  });

  it('detects create logical replication slot', () => {
    expect(detectReplSlot("SELECT pg_create_logical_replication_slot('s', 'pgoutput');")).toBe(true);
  });

  it('detects drop replication slot', () => {
    expect(detectReplSlot("SELECT pg_drop_replication_slot('slot1');")).toBe(true);
  });

  it('detects pg_replication_slots query', () => {
    expect(detectReplSlot('SELECT * FROM pg_replication_slots;')).toBe(true);
    expect(detectReplSlot("SELECT slot_name FROM pg_catalog.pg_replication_slots WHERE slot_name = 'x'")).toBe(true);
  });
});

describe('rewriteReplSlot', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteReplSlot(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteReplSlot(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteReplSlot('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteReplSlot('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('creates a physical slot (returns null SQL)', () => {
    const r = rewriteReplSlot("SELECT pg_create_physical_replication_slot('slot1');");
    expect(r).toEqual({ sql: null, rewritten: true });
    const slots = ReplicationSlotTracker.getInstance().getAll();
    expect(slots).toHaveLength(1);
    expect(slots[0].slotName).toBe('slot1');
    expect(slots[0].slotType).toBe('physical');
  });

  it('creates a logical slot', () => {
    const r = rewriteReplSlot("SELECT pg_create_logical_replication_slot('s1', 'pgoutput');");
    expect(r).toEqual({ sql: null, rewritten: true });
    const slots = ReplicationSlotTracker.getInstance().getAll();
    expect(slots[0].slotType).toBe('logical');
  });

  it('handles duplicate physical slot (catch branch)', () => {
    rewriteReplSlot("SELECT pg_create_physical_replication_slot('dup');");
    const r = rewriteReplSlot("SELECT pg_create_physical_replication_slot('dup');");
    expect(r).toEqual({ sql: null, rewritten: true });
    expect(ReplicationSlotTracker.getInstance().count()).toBe(1);
  });

  it('handles duplicate logical slot (catch branch)', () => {
    rewriteReplSlot("SELECT pg_create_logical_replication_slot('dup', 'pgoutput');");
    rewriteReplSlot("SELECT pg_create_logical_replication_slot('dup', 'pgoutput');");
    expect(ReplicationSlotTracker.getInstance().count()).toBe(1);
  });

  it('drops a slot', () => {
    rewriteReplSlot("SELECT pg_create_physical_replication_slot('s1');");
    const r = rewriteReplSlot("SELECT pg_drop_replication_slot('s1');");
    expect(r).toEqual({ sql: null, rewritten: true });
    expect(ReplicationSlotTracker.getInstance().count()).toBe(0);
  });

  it('rewrites pg_replication_slots query to slot SQL', () => {
    rewriteReplSlot("SELECT pg_create_physical_replication_slot('s1');");
    const r = rewriteReplSlot('SELECT * FROM pg_replication_slots;');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain("'s1' AS slot_name");
  });

  it('returns NULL single-row SQL for empty slot view', () => {
    const r = rewriteReplSlot('SELECT * FROM pg_replication_slots;');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toContain('NULL AS slot_name');
  });
});
