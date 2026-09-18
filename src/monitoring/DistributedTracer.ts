/**
 * DistributedTracer — lightweight, self-contained trace/span recorder.
 *
 * Produces OpenTelemetry-style trace and span lifecycle events so the query
 * router can annotate request paths with correlation IDs.  A single trace
 * corresponds to one top-level query execution; spans represent phases within
 * that execution (e.g. `execute`).
 *
 * The implementation is intentionally dependency-free (no OTLP exporter) and
 * keeps an in-memory record of finished traces for observability/testing.  A
 * trace is identified by a UUID v4 id; spans are opened and closed in LIFO
 * order and carry a millisecond duration.
 *
 * @module monitoring/DistributedTracer
 */

import { v4 as uuidv4 } from 'uuid';

/** A completed span within a trace. */
export interface TraceSpan {
  /** Span name (phase identifier). */
  name: string;
  /** Elapsed span duration in milliseconds. */
  durationMs: number;
}

/** A completed trace with its spans. */
export interface TraceRecord {
  /** Trace correlation id. */
  traceId: string;
  /** Trace top-level name (e.g. `SQL query`). */
  name: string;
  /** Spans in completion order. */
  spans: TraceSpan[];
  /** Epoch-millis when the trace started. */
  startedAt: number;
  /** Total trace duration in milliseconds. */
  durationMs: number;
}

/** Internal open trace: keeps both open (LIFO) and finished spans. */
interface OpenTrace {
  traceId: string;
  name: string;
  startedAt: number;
  openSpans: { name: string; startedAt: number }[];
  finishedSpans: TraceSpan[];
}

/**
 * Distributed trace/span recorder with a process-wide singleton.
 *
 * `startTrace` returns a trace id (a string), which callers pass along as the
 * correlation id for a request.  Spans are opened/closed in strict LIFO order;
 * closing a span when none is open is a no-op to keep the tracer defensive.
 */
export class DistributedTracer {
  private static instance: DistributedTracer | null = null;

  private activeTrace: OpenTrace | null = null;
  private readonly finished: TraceRecord[] = [];

  /** Return the process-wide singleton, creating it on first use. */
  static getInstance(): DistributedTracer {
    if (!DistributedTracer.instance) {
      DistributedTracer.instance = new DistributedTracer();
    }
    return DistributedTracer.instance;
  }

  /** Create a new isolated tracer for tests/boundaries. */
  static create(): DistributedTracer {
    return new DistributedTracer();
  }

  /**
   * Begin a new trace and return its correlation id.
   *
   * Any still-open trace is implicitly closed first (a tracer tracks one
   * active trace at a time), which mirrors the router's request-per-execution
   * model.
   *
   * @param name - Trace name (e.g. `SQL query`).
   * @returns The new trace id.
   */
  startTrace(name: string): string {
    if (this.activeTrace) {
      this.endTrace();
    }

    const traceId = uuidv4();
    this.activeTrace = {
      traceId,
      name,
      startedAt: Date.now(),
      openSpans: [],
      finishedSpans: [],
    };
    return traceId;
  }

  /**
   * Open a span inside the current trace.
   *
   * @param name - Span name (e.g. `execute`).
   * @returns `this` to allow optional chaining (retained for backwards
   *   compatibility with the previous stub signature).
   */
  startSpan(name: string): this {
    this.activeTrace?.openSpans.push({ name, startedAt: Date.now() });
    return this;
  }

  /** Close the most recently opened span (LIFO). No-op when no span is open. */
  endSpan(): void {
    const trace = this.activeTrace;
    if (!trace) {
      return;
    }
    const open = trace.openSpans.pop();
    if (!open) {
      return;
    }
    trace.finishedSpans.push({
      name: open.name,
      durationMs: Date.now() - open.startedAt,
    });
  }

  /**
   * Close the current trace and archive it for later inspection.
   *
   * @returns `true` if a trace was closed, otherwise `false`.
   */
  endTrace(): boolean {
    if (!this.activeTrace) {
      return false;
    }
    const trace = this.activeTrace;
    this.activeTrace = null;
    this.finished.push({
      traceId: trace.traceId,
      name: trace.name,
      startedAt: trace.startedAt,
      durationMs: Date.now() - trace.startedAt,
      spans: [...trace.finishedSpans],
    });
    return true;
  }

  /** Return the current trace id, or `undefined` when no trace is active. */
  get currentTraceId(): string | undefined {
    return this.activeTrace?.traceId;
  }

  /** Number of open spans in the current trace. */
  get openSpanCount(): number {
    return this.activeTrace?.openSpans.length ?? 0;
  }

  /** Defensive snapshot of all finished traces. */
  get finishedTraces(): TraceRecord[] {
    return this.finished.map((t) => ({ ...t, spans: [...t.spans] }));
  }

  /** Reset internal state (primarily for tests). */
  reset(): void {
    this.activeTrace = null;
    this.finished.length = 0;
  }
}
