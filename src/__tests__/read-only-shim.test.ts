import { describe, it, expect, beforeEach } from 'vitest';
import { GucSystem } from '../core/GucSystem';
import { detectReadOnly, rewriteReadOnly, isReadOnlyMode } from '../query/ReadOnlyShim';

describe('detectReadOnly', () => {
  it('detects SET default_transaction_read_only', () => {
    expect(detectReadOnly('SET default_transaction_read_only = on')).toBe(true);
    expect(detectReadOnly('SET default_transaction_read_only = off')).toBe(true);
    expect(detectReadOnly('SET default_transaction_read_only = true')).toBe(true);
    expect(detectReadOnly('SET default_transaction_read_only = 1')).toBe(true);
    expect(detectReadOnly('SET default_transaction_read_only = 0')).toBe(true);
  });

  it('detects SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY/WRITE', () => {
    expect(detectReadOnly('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')).toBe(true);
    expect(detectReadOnly('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE')).toBe(true);
  });

  it('detects SHOW of read-only GUCs', () => {
    expect(detectReadOnly('SHOW transaction_read_only')).toBe(true);
    expect(detectReadOnly('SHOW default_transaction_read_only')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectReadOnly('set default_transaction_read_only = on')).toBe(true);
    expect(detectReadOnly('Show Transaction_Read_Only')).toBe(true);
  });

  it('returns false for unrelated statements', () => {
    expect(detectReadOnly('SELECT * FROM t')).toBe(false);
    expect(detectReadOnly('CREATE TABLE t (id INT)')).toBe(false);
    expect(detectReadOnly('SET enable_seqscan = on')).toBe(false);
  });

  it('returns false for non-string and blank input', () => {
    expect(detectReadOnly(undefined as unknown as string)).toBe(false);
    expect(detectReadOnly('')).toBe(false);
    expect(detectReadOnly('   ')).toBe(false);
  });
});

describe('rewriteReadOnly', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('returns original for empty or non-string input', () => {
    expect(rewriteReadOnly('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteReadOnly(undefined as unknown as string)).toEqual({
      sql: undefined,
      rewritten: false,
    });
  });

  it('rewrites SET default_transaction_read_only = on with PRAGMA hint', () => {
    const r = rewriteReadOnly('SET default_transaction_read_only = on');
    expect(r).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      needsPrisma: 'PRAGMA query_only = 1',
    });
    expect(isReadOnlyMode()).toBe(true);
  });

  it('rewrites SET default_transaction_read_only = off with PRAGMA disable', () => {
    const r = rewriteReadOnly('SET default_transaction_read_only = off');
    expect(r).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
      needsPrisma: 'PRAGMA query_only = 0',
    });
    expect(isReadOnlyMode()).toBe(false);
  });

  it('rewrites SET SESSION CHARACTERISTICS READ ONLY', () => {
    const r = rewriteReadOnly('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    expect(r.rewritten).toBe(true);
    expect(r.needsPrisma).toBe('PRAGMA query_only = 1');
    expect(isReadOnlyMode()).toBe(true);
  });

  it('rewrites SET SESSION CHARACTERISTICS READ WRITE', () => {
    const r = rewriteReadOnly('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
    expect(r.rewritten).toBe(true);
    expect(r.needsPrisma).toBe('PRAGMA query_only = 0');
    expect(isReadOnlyMode()).toBe(false);
  });

  it('rewrites SHOW transaction_read_only from stored state', () => {
    guc.set('transaction_read_only', 'on');
    const r = rewriteReadOnly('SHOW transaction_read_only');
    expect(r).toEqual({
      sql: "SELECT 'on' AS transaction_read_only",
      rewritten: true,
    });
  });

  it('rewrites SHOW default_transaction_read_only from stored state', () => {
    guc.set('default_transaction_read_only', 'off');
    const r = rewriteReadOnly('SHOW default_transaction_read_only');
    expect(r.sql).toBe("SELECT 'off' AS default_transaction_read_only");
  });

  it('falls back to off for SHOW when GUC has no stored value', () => {
    const r = rewriteReadOnly('SHOW transaction_read_only');
    expect(r.sql).toBe("SELECT 'off' AS transaction_read_only");
  });

  it('passes through non-read-only statements unchanged', () => {
    const r = rewriteReadOnly('SELECT * FROM users');
    expect(r).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });
});

describe('isReadOnlyMode', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('returns false by default', () => {
    expect(isReadOnlyMode()).toBe(false);
  });

  it('returns true when default_transaction_read_only is on', () => {
    guc.set('default_transaction_read_only', 'on');
    expect(isReadOnlyMode()).toBe(true);
  });

  it('returns true when transaction_read_only is on', () => {
    guc.set('transaction_read_only', 'on');
    expect(isReadOnlyMode()).toBe(true);
  });

  it('returns false when both are off', () => {
    guc.set('default_transaction_read_only', 'off');
    guc.set('transaction_read_only', 'off');
    expect(isReadOnlyMode()).toBe(false);
  });
});
