/**
 * partition-pruning-shim.test.ts — Coverage tests for PartitionPruningShim
 * (PostgreSQL enable_partition_pruning / constraint_exclusion GUC → no-op rewrite).
 */

import { describe, expect, it } from 'vitest';
import { detectPartitionPruning, rewritePartitionPruning } from '../query/PartitionPruningShim';

describe('detectPartitionPruning', () => {
  it('returns false for empty / whitespace / non-string input', () => {
    expect(detectPartitionPruning('')).toBe(false);
    expect(detectPartitionPruning('   ')).toBe(false);
    expect(detectPartitionPruning(undefined as unknown as string)).toBe(false);
    expect(detectPartitionPruning(null as unknown as string)).toBe(false);
  });

  it('returns false for plain SQL without the token', () => {
    expect(detectPartitionPruning('SELECT 1')).toBe(false);
    expect(detectPartitionPruning('SELECT * FROM users')).toBe(false);
  });

  it('returns false when the token is only an identifier or comment', () => {
    expect(detectPartitionPruning('SELECT enable_partition_pruning FROM t;')).toBe(false);
    expect(detectPartitionPruning('-- enable_partition_pruning')).toBe(false);
    expect(detectPartitionPruning('SELECT constraint_exclusion FROM t;')).toBe(false);
  });

  it('detects SET enable_partition_pruning variants', () => {
    expect(detectPartitionPruning('SET enable_partition_pruning = on;')).toBe(true);
    expect(detectPartitionPruning('SET enable_partition_pruning = off;')).toBe(true);
    expect(detectPartitionPruning('SET SESSION enable_partition_pruning = on;')).toBe(true);
    expect(detectPartitionPruning('SET LOCAL enable_partition_pruning TO off;')).toBe(true);
    expect(detectPartitionPruning('SET TEMPORARY enable_partition_pruning = on;')).toBe(true);
    expect(detectPartitionPruning('SET enable_partition_pruning TO on;')).toBe(true);
  });

  it('detects SET constraint_exclusion variants', () => {
    expect(detectPartitionPruning('SET constraint_exclusion = on;')).toBe(true);
    expect(detectPartitionPruning('SET constraint_exclusion = off;')).toBe(true);
    expect(detectPartitionPruning('SET constraint_exclusion = partition;')).toBe(true);
    expect(detectPartitionPruning('SET SESSION constraint_exclusion TO partition;')).toBe(true);
  });

  it('detects SHOW variants', () => {
    expect(detectPartitionPruning('SHOW enable_partition_pruning;')).toBe(true);
    expect(detectPartitionPruning('SHOW constraint_exclusion;')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectPartitionPruning('SET ENABLE_PARTITION_PRUNING = ON;')).toBe(true);
    expect(detectPartitionPruning('SHOW CONSTRAINT_EXCLUSION;')).toBe(true);
  });
});

describe('rewritePartitionPruning', () => {
  it('returns unchanged for empty / whitespace / non-string input', () => {
    expect(rewritePartitionPruning('')).toEqual({ sql: '', rewritten: false });
    expect(rewritePartitionPruning('   ')).toEqual({ sql: '   ', rewritten: false });
    expect(rewritePartitionPruning(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewritePartitionPruning(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('passes through plain SQL with no token', () => {
    expect(rewritePartitionPruning('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
    expect(rewritePartitionPruning('  SELECT * FROM users  ')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('passes through SQL with the token as an identifier (not SET/SHOW)', () => {
    expect(rewritePartitionPruning('SELECT enable_partition_pruning FROM t;')).toEqual({
      sql: 'SELECT enable_partition_pruning FROM t;',
      rewritten: false,
    });
    expect(rewritePartitionPruning('SELECT constraint_exclusion FROM t;')).toEqual({
      sql: 'SELECT constraint_exclusion FROM t;',
      rewritten: false,
    });
  });

  it('rewrites SET enable_partition_pruning to SELECT 1', () => {
    for (const sql of [
      'SET enable_partition_pruning = on;',
      'SET enable_partition_pruning = off;',
      'SET enable_partition_pruning TO on;',
      'SET SESSION enable_partition_pruning = on;',
      'SET LOCAL enable_partition_pruning TO off;',
      'SET TEMPORARY enable_partition_pruning = on;',
    ]) {
      expect(rewritePartitionPruning(sql)).toEqual({ sql: 'SELECT 1', rewritten: true });
    }
  });

  it('rewrites SET constraint_exclusion to SELECT 1', () => {
    for (const sql of [
      'SET constraint_exclusion = on;',
      'SET constraint_exclusion = off;',
      'SET constraint_exclusion = partition;',
      'SET constraint_exclusion TO partition;',
      'SET SESSION constraint_exclusion = on;',
      'SET LOCAL constraint_exclusion = off;',
    ]) {
      expect(rewritePartitionPruning(sql)).toEqual({ sql: 'SELECT 1', rewritten: true });
    }
  });

  it('rewrites SHOW enable_partition_pruning to a constant SELECT', () => {
    expect(rewritePartitionPruning('SHOW enable_partition_pruning;')).toEqual({
      sql: "SELECT 'off' as enable_partition_pruning",
      rewritten: true,
    });
  });

  it('rewrites SHOW constraint_exclusion to a constant SELECT', () => {
    expect(rewritePartitionPruning('SHOW constraint_exclusion;')).toEqual({
      sql: "SELECT 'off' as constraint_exclusion",
      rewritten: true,
    });
  });

  it('preserves leading/trailing whitespace by trimming', () => {
    expect(rewritePartitionPruning('  SET enable_partition_pruning = on;  ')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });
});
