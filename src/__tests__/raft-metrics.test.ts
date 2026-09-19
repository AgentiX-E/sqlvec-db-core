/**
 * Unit tests for RaftMetrics.
 *
 * Verifies singleton identity, per-database throughput recording/reading,
 * snapshot semantics, forgetting databases, and reset behaviour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RaftMetrics } from '../monitoring/RaftMetrics';

describe('RaftMetrics', () => {
  beforeEach(() => {
    RaftMetrics.getInstance().reset();
  });

  it('returns the same singleton instance', () => {
    const a = RaftMetrics.getInstance();
    const b = RaftMetrics.getInstance();
    expect(a).toBe(b);
  });

  it('records and reads a single database throughput', () => {
    const metrics = RaftMetrics.getInstance();
    const before = Date.now();
    metrics.setQueryThroughput('db-1', 123.5);

    const sample = metrics.getQueryThroughput('db-1');
    expect(sample).toBeDefined();
    expect(sample!.database).toBe('db-1');
    expect(sample!.qps).toBe(123.5);
    expect(sample!.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('overwrites the latest sample for a database', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('db-1', 10);
    metrics.setQueryThroughput('db-1', 20);
    expect(metrics.getQueryThroughput('db-1')!.qps).toBe(20);
    expect(metrics.trackedDatabaseCount).toBe(1);
  });

  it('returns undefined for an untracked database', () => {
    expect(RaftMetrics.getInstance().getQueryThroughput('missing')).toBeUndefined();
  });

  it('returns a snapshot of all samples', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('a', 1);
    metrics.setQueryThroughput('b', 2);
    metrics.setQueryThroughput('c', 3);

    const all = metrics.getAllQueryThroughput();
    expect(all).toHaveLength(3);
    const names = all.map((s) => s.database).sort();
    expect(names).toEqual(['a', 'b', 'c']);
    expect(all.map((s) => s.qps).sort((x, y) => x - y)).toEqual([1, 2, 3]);
  });

  it('lists tracked database names', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('db-x', 1);
    metrics.setQueryThroughput('db-y', 1);
    expect(metrics.getDatabaseNames().sort()).toEqual(['db-x', 'db-y']);
  });

  it('counts total samples across all writes', () => {
    const metrics = RaftMetrics.getInstance();
    expect(metrics.totalSampleCount).toBe(0);
    metrics.setQueryThroughput('a', 1);
    metrics.setQueryThroughput('b', 1);
    metrics.setQueryThroughput('a', 2);
    expect(metrics.totalSampleCount).toBe(3);
  });

  it('reports zero tracked databases when empty', () => {
    expect(RaftMetrics.getInstance().trackedDatabaseCount).toBe(0);
  });

  it('records a zero QPS sample (idle interval)', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('idle-db', 0);
    expect(metrics.getQueryThroughput('idle-db')!.qps).toBe(0);
  });

  it('forgets a database sample', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('db-1', 5);
    expect(metrics.forget('db-1')).toBe(true);
    expect(metrics.getQueryThroughput('db-1')).toBeUndefined();
    expect(metrics.forget('db-1')).toBe(false);
  });

  it('reset clears samples and counts but keeps identity', () => {
    const metrics = RaftMetrics.getInstance();
    metrics.setQueryThroughput('a', 1);
    metrics.setQueryThroughput('b', 2);
    metrics.reset();

    expect(metrics.trackedDatabaseCount).toBe(0);
    expect(metrics.totalSampleCount).toBe(0);
    expect(metrics.getAllQueryThroughput()).toEqual([]);
    expect(RaftMetrics.getInstance()).toBe(metrics);
  });
});
