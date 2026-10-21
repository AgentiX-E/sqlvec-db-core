/**
 * isolation-shim.test.ts — Coverage tests for IsolationShim
 * (PostgreSQL transaction isolation level statements → no-op rewrite).
 */

import { describe, expect, it } from 'vitest';
import { detectIsolation, rewriteIsolation } from '../query/IsolationShim';

describe('detectIsolation', () => {
  it('returns false for empty / whitespace / non-string input', () => {
    expect(detectIsolation('')).toBe(false);
    expect(detectIsolation('   ')).toBe(false);
    expect(detectIsolation(undefined as unknown as string)).toBe(false);
    expect(detectIsolation(null as unknown as string)).toBe(false);
  });

  it('returns false for non-SET/SHOW statements (fast prefix check)', () => {
    expect(detectIsolation('SELECT 1')).toBe(false);
    expect(detectIsolation('INSERT INTO t VALUES (1)')).toBe(false);
    expect(detectIsolation('UPDATE t SET x = 1')).toBe(false);
    expect(detectIsolation('BEGIN TRANSACTION')).toBe(false);
  });

  it('returns false for SERIALIZABLE isolation level', () => {
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(false);
  });

  it('detects SET TRANSACTION ISOLATION LEVEL variants', () => {
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED')).toBe(true);
    expect(detectIsolation('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectIsolation('SET LOCAL TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
  });

  it('detects SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL', () => {
    expect(detectIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
    expect(detectIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
  });

  it('detects SET default_transaction_isolation', () => {
    expect(detectIsolation("SET default_transaction_isolation = 'read committed'")).toBe(true);
    expect(detectIsolation("SET SESSION default_transaction_isolation TO 'repeatable read'")).toBe(true);
    expect(detectIsolation("SET LOCAL default_transaction_isolation = 'serializable'")).toBe(true);
  });

  it('detects SHOW transaction_isolation', () => {
    expect(detectIsolation('SHOW transaction_isolation')).toBe(true);
  });

  it('detects SHOW default_transaction_isolation', () => {
    expect(detectIsolation('SHOW default_transaction_isolation')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectIsolation('set transaction isolation level read committed')).toBe(true);
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL READ COMMITTED;')).toBe(true);
  });
});

describe('rewriteIsolation', () => {
  it('returns unchanged for empty / whitespace / non-string input', () => {
    expect(rewriteIsolation('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteIsolation('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewriteIsolation(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteIsolation(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through non-isolation SQL', () => {
    expect(rewriteIsolation('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewriteIsolation('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toEqual({
      sql: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      rewritten: false,
    });
  });

  it('rewrites SET TRANSACTION ISOLATION LEVEL (non-SERIALIZABLE) to SELECT 1', () => {
    for (const sql of [
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED',
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
      'SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'SET LOCAL TRANSACTION ISOLATION LEVEL REPEATABLE READ',
    ]) {
      expect(rewriteIsolation(sql)).toEqual({ sql: 'SELECT 1', rewritten: true });
    }
  });

  it('rewrites SET SESSION CHARACTERISTICS to SELECT 1', () => {
    expect(rewriteIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites SET default_transaction_isolation to SELECT 1', () => {
    expect(rewriteIsolation("SET default_transaction_isolation = 'read committed'")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
    expect(rewriteIsolation("SET SESSION default_transaction_isolation TO 'repeatable read'")).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites SHOW transaction_isolation to a constant response', () => {
    expect(rewriteIsolation('SHOW transaction_isolation')).toEqual({
      sql: "SELECT 'serializable' AS transaction_isolation",
      rewritten: true,
    });
  });

  it('rewrites SHOW default_transaction_isolation to a constant response', () => {
    expect(rewriteIsolation('SHOW default_transaction_isolation')).toEqual({
      sql: "SELECT 'serializable' AS default_transaction_isolation",
      rewritten: true,
    });
  });
});
