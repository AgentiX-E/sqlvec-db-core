/**
 * cdc-slot-shim.test.ts — Coverage tests for CDCSlotShim (logical decoding /
 * CDC compatibility shim).
 */

import { describe, it, expect } from 'vitest';
import { detectCDC, rewriteCDC } from '../query/CDCSlotShim';

describe('detectCDC', () => {
  it('returns false for non-string input', () => {
    expect(detectCDC(undefined as unknown as string)).toBe(false);
    expect(detectCDC(null as unknown as string)).toBe(false);
    expect(detectCDC(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectCDC('')).toBe(false);
    expect(detectCDC('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectCDC('SELECT 1')).toBe(false);
    expect(detectCDC('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('detects pg_logical_slot_get_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_get_changes('slot')")).toBe(true);
    expect(detectCDC("select pg_logical_slot_get_changes('slot');")).toBe(true);
  });

  it('detects pg_logical_slot_peek_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_peek_changes('slot')")).toBe(true);
  });

  it('detects pg_logical_slot_peek_binary_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_peek_binary_changes('slot')")).toBe(true);
  });

  it('detects pg_stat_replication_slots queries', () => {
    expect(detectCDC('SELECT * FROM pg_stat_replication_slots')).toBe(true);
    expect(detectCDC('SELECT slot_name, active FROM pg_stat_replication_slots')).toBe(true);
    expect(detectCDC('SELECT * FROM pg_catalog.pg_stat_replication_slots')).toBe(true);
    expect(detectCDC('SELECT * FROM pg_stat_replication_slots WHERE active')).toBe(true);
  });
});

describe('rewriteCDC', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteCDC(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteCDC(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteCDC('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteCDC('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites get_changes to empty changes array', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_get_changes('slot')")).toEqual({
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    });
  });

  it('rewrites peek_changes to empty changes array', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_peek_changes('slot')")).toEqual({
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    });
  });

  it('rewrites pg_stat_replication_slots to placeholder row', () => {
    expect(rewriteCDC('SELECT * FROM pg_stat_replication_slots')).toEqual({
      sql: "SELECT '' as slot_name, false as active",
      rewritten: true,
    });
  });

  it('rewrites peek_binary_changes to empty data', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_peek_binary_changes('slot')")).toEqual({
      sql: "SELECT '' as data",
      rewritten: true,
    });
  });
});
