/**
 * partition-pruning-shim.test.ts — Coverage tests for PartitionPruningShim
 * (SET/SHOW enable_partition_pruning & constraint_exclusion GUC rewriting).
 */

import { describe, it, expect } from 'vitest';
import { detectPartitionPruning, rewritePartitionPruning } from '../query/PartitionPruningShim';

describe('detectPartitionPruning', () => {
  it('returns false for non-string input', () => {
    expect(detectPartitionPruning(undefined as unknown as string)).toBe(false);
    expect(detectPartitionPruning(null as unknown as string)).toBe(false);
    expect(detectPartitionPruning(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectPartitionPruning('')).toBe(false);
    expect(detectPartitionPruning('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectPartitionPruning('SELECT * FROM users')).toBe(false);
  });

  it('returns false when token present but not a SET/SHOW', () => {
    expect(detectPartitionPruning('SELECT enable_partition_pruning FROM t')).toBe(false);
    expect(detectPartitionPruning('INSERT INTO constraint_exclusion VALUES (1)')).toBe(false);
  });

  it('detects SET enable_partition_pruning variants', () => {
    expect(detectPartitionPruning('SET enable_partition_pruning = on')).toBe(true);
    expect(detectPartitionPruning('SET enable_partition_pruning = off')).toBe(true);
    expect(detectPartitionPruning('SET enable_partition_pruning TO on')).toBe(true);
    expect(detectPartitionPruning('SET SESSION enable_partition_pruning = on')).toBe(true);
    expect(detectPartitionPruning('SET LOCAL enable_partition_pruning = off')).toBe(true);
    expect(detectPartitionPruning('SET TEMP enable_partition_pruning = on')).toBe(true);
    expect(detectPartitionPruning('SET TEMPORARY enable_partition_pruning = off')).toBe(true);
  });

  it('detects SET constraint_exclusion variants', () => {
    expect(detectPartitionPruning('SET constraint_exclusion = on')).toBe(true);
    expect(detectPartitionPruning('SET constraint_exclusion = off')).toBe(true);
    expect(detectPartitionPruning('SET constraint_exclusion = partition')).toBe(true);
    expect(detectPartitionPruning('SET constraint_exclusion TO partition')).toBe(true);
    expect(detectPartitionPruning('SET SESSION constraint_exclusion = on')).toBe(true);
    expect(detectPartitionPruning('SET LOCAL constraint_exclusion = off')).toBe(true);
  });

  it('detects SHOW variants', () => {
    expect(detectPartitionPruning('SHOW enable_partition_pruning')).toBe(true);
    expect(detectPartitionPruning('SHOW constraint_exclusion')).toBe(true);
  });
});

describe('rewritePartitionPruning', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewritePartitionPruning(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewritePartitionPruning(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewritePartitionPruning('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewritePartitionPruning('SELECT * FROM users')).toEqual({ sql: 'SELECT * FROM users', rewritten: false });
  });

  it('rewrites SHOW enable_partition_pruning', () => {
    expect(rewritePartitionPruning('SHOW enable_partition_pruning')).toEqual({
      sql: "SELECT 'off' as enable_partition_pruning",
      rewritten: true,
    });
  });

  it('rewrites SHOW constraint_exclusion', () => {
    expect(rewritePartitionPruning('SHOW constraint_exclusion')).toEqual({
      sql: "SELECT 'off' as constraint_exclusion",
      rewritten: true,
    });
  });

  it('rewrites SET enable_partition_pruning to SELECT 1', () => {
    expect(rewritePartitionPruning('SET enable_partition_pruning = on')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET enable_partition_pruning TO off')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET SESSION enable_partition_pruning = on')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET LOCAL enable_partition_pruning = off')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites SET constraint_exclusion to SELECT 1', () => {
    expect(rewritePartitionPruning('SET constraint_exclusion = on')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET constraint_exclusion = partition')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET constraint_exclusion TO off')).toEqual({ sql: 'SELECT 1', rewritten: true });
    expect(rewritePartitionPruning('SET SESSION constraint_exclusion = partition')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('passes through token present but not handled', () => {
    expect(rewritePartitionPruning('SELECT enable_partition_pruning FROM t')).toEqual({
      sql: 'SELECT enable_partition_pruning FROM t',
      rewritten: false,
    });
  });
});
