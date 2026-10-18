/**
 * isolation-shim.test.ts — Coverage tests for IsolationShim (transaction
 * isolation level statement rewriting for SQLite compatibility).
 */

import { describe, it, expect } from 'vitest';
import { detectIsolation, rewriteIsolation } from '../query/IsolationShim';

describe('detectIsolation', () => {
  it('returns false for non-string input', () => {
    expect(detectIsolation(undefined as unknown as string)).toBe(false);
    expect(detectIsolation(null as unknown as string)).toBe(false);
    expect(detectIsolation(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectIsolation('')).toBe(false);
    expect(detectIsolation('   ')).toBe(false);
  });

  it('returns false for non-SET/SHOW prefix', () => {
    expect(detectIsolation('SELECT 1')).toBe(false);
    expect(detectIsolation('BEGIN TRANSACTION')).toBe(false);
  });

  it('detects SET TRANSACTION ISOLATION LEVEL variants', () => {
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED')).toBe(true);
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
    expect(detectIsolation('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
    expect(detectIsolation('SET LOCAL TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
  });

  it('detects SET SESSION CHARACTERISTICS AS ...', () => {
    expect(detectIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')).toBe(true);
    expect(detectIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toBe(true);
  });

  it('detects SET default_transaction_isolation', () => {
    expect(detectIsolation("SET default_transaction_isolation = 'read committed'")).toBe(true);
    expect(detectIsolation("SET SESSION default_transaction_isolation = 'repeatable read'")).toBe(true);
    expect(detectIsolation("SET LOCAL default_transaction_isolation TO 'serializable'")).toBe(true);
  });

  it('detects SHOW transaction_isolation variants', () => {
    expect(detectIsolation('SHOW transaction_isolation')).toBe(true);
    expect(detectIsolation('SHOW default_transaction_isolation')).toBe(true);
  });

  it('does NOT detect SERIALIZABLE isolation statements', () => {
    expect(detectIsolation('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(false);
    expect(detectIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toBe(false);
  });
});

describe('rewriteIsolation', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteIsolation(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteIsolation(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteIsolation('')).toEqual({ sql: '', rewritten: false });
  });

  it('rewrites SET TRANSACTION ISOLATION LEVEL to SELECT 1', () => {
    expect(rewriteIsolation('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteIsolation('SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteIsolation('SET LOCAL TRANSACTION ISOLATION LEVEL REPEATABLE READ')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteIsolation('SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET SESSION CHARACTERISTICS AS ... to SELECT 1', () => {
    expect(rewriteIsolation('SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET default_transaction_isolation to SELECT 1', () => {
    expect(rewriteIsolation("SET default_transaction_isolation = 'read committed'")).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewriteIsolation("SET SESSION default_transaction_isolation TO 'repeatable read'")).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SHOW transaction_isolation to constant SELECT', () => {
    expect(rewriteIsolation('SHOW transaction_isolation')).toEqual({
      sql: "SELECT 'serializable' AS transaction_isolation",
      rewritten: true,
    });
  });

  it('rewrites SHOW default_transaction_isolation to constant SELECT', () => {
    expect(rewriteIsolation('SHOW default_transaction_isolation')).toEqual({
      sql: "SELECT 'serializable' AS default_transaction_isolation",
      rewritten: true,
    });
  });

  it('passes through non-isolation SQL', () => {
    expect(rewriteIsolation('SELECT * FROM t')).toEqual({ sql: 'SELECT * FROM t', rewritten: false });
    expect(rewriteIsolation('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')).toEqual({
      sql: 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      rewritten: false,
    });
  });
});
