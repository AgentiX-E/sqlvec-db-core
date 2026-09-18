/**
 * Unit tests for the distributed tracer.
 *
 * Verifies the trace/span lifecycle (start → span → end → archive), the
 * process-wide singleton, defensive-copy guarantees, and the key contract that
 * `startTrace` returns a trace id *string* (the previous 4-line stub returned
 * `this`, so `traceId` in QueryRouter was a DistributedTracer object, not a
 * correlation id — BUG #159).
 */
import { describe, it, expect } from 'vitest';
import { DistributedTracer } from '../monitoring/DistributedTracer';

describe('DistributedTracer — factories & singleton', () => {
  it('getInstance returns the same singleton', () => {
    expect(DistributedTracer.getInstance()).toBe(DistributedTracer.getInstance());
  });

  it('create returns a fresh, isolated tracer', () => {
    expect(DistributedTracer.create()).not.toBe(DistributedTracer.getInstance());
  });
});

describe('DistributedTracer — trace lifecycle', () => {
  it('startTrace returns a string trace id', () => {
    const t = DistributedTracer.create();
    const id = t.startTrace('SQL query');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(t.currentTraceId).toBe(id);
  });

  it('startTrace closes a still-open previous trace', () => {
    const t = DistributedTracer.create();
    t.startTrace('first');
    const second = t.startTrace('second');
    // The first trace was implicitly closed; finishedTraces should contain it.
    expect(t.finishedTraces).toHaveLength(1);
    expect(t.finishedTraces[0].name).toBe('first');
    expect(t.currentTraceId).toBe(second);
  });

  it('two traces get distinct ids', () => {
    const t = DistributedTracer.create();
    const a = t.startTrace('a');
    t.endTrace();
    const b = t.startTrace('b');
    expect(a).not.toBe(b);
  });
});

describe('DistributedTracer — span lifecycle', () => {
  it('open and close a span within a trace', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.startSpan('execute');
    expect(t.openSpanCount).toBe(1);
    t.endSpan();
    expect(t.openSpanCount).toBe(0);
  });

  it('endSpan is a no-op without an active trace', () => {
    const t = DistributedTracer.create();
    expect(() => t.endSpan()).not.toThrow();
  });

  it('endSpan is a no-op when no span is open', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.endSpan(); // no span open
    expect(t.openSpanCount).toBe(0);
  });

  it('spans close in LIFO order', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.startSpan('outer');
    t.startSpan('inner');
    t.endSpan(); // closes inner
    t.endSpan(); // closes outer
    expect(t.openSpanCount).toBe(0);
  });

  it('finished trace records spans with a non-negative duration', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.startSpan('s');
    t.endSpan();
    expect(t.endTrace()).toBe(true);
    const rec = t.finishedTraces[0];
    expect(rec.spans).toHaveLength(1);
    expect(rec.spans[0].name).toBe('s');
    expect(rec.spans[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(rec.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('endTrace returns false without an active trace', () => {
    const t = DistributedTracer.create();
    expect(t.endTrace()).toBe(false);
  });
});

describe('DistributedTracer — defensive copies & reset', () => {
  it('finishedTraces returns a detached snapshot', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.endTrace();
    const snapshot = t.finishedTraces;
    snapshot.length = 0; // must not affect internal state
    expect(t.finishedTraces).toHaveLength(1);
  });

  it('reset clears active trace and finished records', () => {
    const t = DistributedTracer.create();
    t.startTrace('t');
    t.endTrace();
    t.reset();
    expect(t.currentTraceId).toBeUndefined();
    expect(t.finishedTraces).toHaveLength(0);
  });

  it('startSpan without active trace is a safe no-op', () => {
    const t = DistributedTracer.create();
    expect(t.startSpan('orphan')).toBe(t);
    expect(t.openSpanCount).toBe(0);
  });
});
