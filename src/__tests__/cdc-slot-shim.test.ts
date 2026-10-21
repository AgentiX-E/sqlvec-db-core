/**
 * cdc-slot-shim.test.ts — Coverage tests for CDCSlotShim
 * (PostgreSQL logical decoding / CDC slot functions → empty-result rewrite).
 */

import { describe, expect, it } from 'vitest';
import { detectCDC, rewriteCDC } from '../query/CDCSlotShim';

describe('detectCDC', () => {
  it('returns false for empty / whitespace / non-string input', () => {
    expect(detectCDC('')).toBe(false);
    expect(detectCDC('   ')).toBe(false);
    expect(detectCDC(undefined as unknown as string)).toBe(false);
    expect(detectCDC(null as unknown as string)).toBe(false);
  });

  it('returns false for plain SQL', () => {
    expect(detectCDC('SELECT 1')).toBe(false);
    expect(detectCDC('CREATE TABLE t (id INT)')).toBe(false);
  });

  it('returns false for identifiers / comments (no false positive)', () => {
    expect(detectCDC('SELECT pg_logical_slot_get_changes_x FROM t')).toBe(false);
    expect(detectCDC('-- pg_logical_slot_get_changes')).toBe(false);
    expect(detectCDC('SELECT pg_stat_replication_slots_col FROM t')).toBe(false);
  });

  it('detects pg_logical_slot_get_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_get_changes('slot')")).toBe(true);
    expect(detectCDC("SELECT pg_logical_slot_get_changes('slot', NULL, 10)")).toBe(true);
  });

  it('detects pg_logical_slot_peek_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_peek_changes('slot')")).toBe(true);
    expect(detectCDC("SELECT pg_logical_slot_peek_changes('slot', NULL, 1, 'x')")).toBe(true);
  });

  it('detects pg_logical_slot_peek_binary_changes', () => {
    expect(detectCDC("SELECT pg_logical_slot_peek_binary_changes('slot')")).toBe(true);
    expect(detectCDC("SELECT pg_logical_slot_peek_binary_changes('slot', NULL, 1)")).toBe(true);
  });

  it('detects pg_stat_replication_slots queries', () => {
    expect(detectCDC('SELECT * FROM pg_stat_replication_slots')).toBe(true);
    expect(detectCDC('SELECT * FROM pg_catalog.pg_stat_replication_slots')).toBe(true);
    expect(detectCDC('SELECT slot_name, active FROM pg_stat_replication_slots WHERE active')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectCDC("SELECT PG_LOGICAL_SLOT_GET_CHANGES('slot')")).toBe(true);
    expect(detectCDC('SELECT * FROM PG_STAT_REPLICATION_SLOTS')).toBe(true);
  });
});

describe('rewriteCDC', () => {
  it('returns unchanged for empty / whitespace / non-string input', () => {
    expect(rewriteCDC('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteCDC('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteCDC(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteCDC(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through plain SQL', () => {
    expect(rewriteCDC('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewriteCDC('CREATE TABLE t (id INT)')).toEqual({ sql: 'CREATE TABLE t (id INT)', rewritten: false });
  });

  it('rewrites pg_logical_slot_get_changes to empty changes', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_get_changes('slot')")).toEqual({
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    });
  });

  it('rewrites pg_logical_slot_peek_changes to empty changes', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_peek_changes('slot')")).toEqual({
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    });
  });

  it('rewrites pg_logical_slot_peek_binary_changes to empty data', () => {
    expect(rewriteCDC("SELECT pg_logical_slot_peek_binary_changes('slot')")).toEqual({
      sql: "SELECT '' as data",
      rewritten: true,
    });
  });

  it('rewrites pg_stat_replication_slots to a placeholder row', () => {
    expect(rewriteCDC('SELECT * FROM pg_stat_replication_slots')).toEqual({
      sql: "SELECT '' as slot_name, false as active",
      rewritten: true,
    });
    expect(rewriteCDC('SELECT * FROM pg_catalog.pg_stat_replication_slots')).toEqual({
      sql: "SELECT '' as slot_name, false as active",
      rewritten: true,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(rewriteCDC("  SELECT pg_logical_slot_get_changes('slot')  ")).toEqual({
      sql: "SELECT '{}'::text[] as changes",
      rewritten: true,
    });
  });
});
