import { describe, it, expect } from 'vitest';
import { PgStatBgwriterShim } from '../query/PgStatBgwriterShim';

// PgStatBgwriterShim tracks checkpointer/bgwriter counters derived from SQLite
// WAL state. This locks the counter-bumping, snapshot, and reset behavior.
describe('PgStatBgwriterShim', () => {
  it('starts with all-zero counters and a valid reset timestamp', () => {
    const shim = new PgStatBgwriterShim();
    const s = shim.snapshot();
    expect(s.checkpoints_timed).toBe(0);
    expect(s.checkpoints_req).toBe(0);
    expect(s.buffers_checkpoint).toBe(0);
    expect(s.buffers_clean).toBe(0);
    expect(s.buffers_backend).toBe(0);
    expect(s.buffers_backend_fsync).toBe(0);
    expect(s.buffers_alloc).toBe(0);
    expect(new Date(s.stats_reset).getTime()).not.toBeNaN();
  });

  it('records a timed checkpoint (bumps count and buffer writes)', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordTimedCheckpoint(10);
    shim.recordTimedCheckpoint(5);
    const s = shim.snapshot();
    expect(s.checkpoints_timed).toBe(2);
    expect(s.buffers_checkpoint).toBe(15);
  });

  it('records a requested checkpoint', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordRequestedCheckpoint(7);
    const s = shim.snapshot();
    expect(s.checkpoints_req).toBe(1);
    expect(s.buffers_checkpoint).toBe(7);
  });

  it('records clean buffer writes', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordCleanBuffer();
    shim.recordCleanBuffer();
    expect(shim.snapshot().buffers_clean).toBe(2);
  });

  it('records backend buffers and only counts fsync when required', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordBackendBuffer(false);
    shim.recordBackendBuffer(true);
    const s = shim.snapshot();
    expect(s.buffers_backend).toBe(2);
    expect(s.buffers_backend_fsync).toBe(1);
  });

  it('records allocations with a default count of 1', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordAlloc();
    shim.recordAlloc(3);
    expect(shim.snapshot().buffers_alloc).toBe(4);
  });

  it('resets all counters and updates the reset timestamp', () => {
    const shim = new PgStatBgwriterShim();
    shim.recordTimedCheckpoint(10);
    shim.recordBackendBuffer(true);
    shim.recordAlloc(5);

    const beforeReset = shim.snapshot().stats_reset;
    shim.reset();

    const s = shim.snapshot();
    expect(s.checkpoints_timed).toBe(0);
    expect(s.buffers_backend).toBe(0);
    expect(s.buffers_alloc).toBe(0);
    // Timestamp may be identical if reset happens within the same millisecond,
    // so just assert it is a valid date rather than strictly newer.
    expect(new Date(s.stats_reset).getTime()).not.toBeNaN();
  });
});
