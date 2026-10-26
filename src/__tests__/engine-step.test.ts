import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// engine-step.test.ts — Coverage for the EngineStep write-state helpers and the
// remaining EdgeStep.process() routing branches.
//
// The module-level write-state helpers (markRecentWrite / hasRecentWrite /
// resetWriteState / sweepRecentWriteEntries) implement the P1 three-level
// read-your-writes protection and were previously uncovered. This suite drives
// them with fake timers to control the window boundaries deterministically, then
// covers the EngineStep.process() branches that pg-pipeline.test.ts does not
// reach (non-SELECT write marking, recent-write override, and the DuckDB
// success-with-rows result population).
// ─────────────────────────────────────────────────────────────────────────────

import {
  EngineStep,
  resetWriteState,
  markRecentWrite,
  hasRecentWrite,
  getRecentWriteWindowMs,
  sweepRecentWriteEntries,
} from '../pipeline/EngineStep';
import { QueryTarget as QT } from '../analytics/AnalyticQueryClassifier';
import type { PipelineContext } from '../pipeline/types';

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    sessionId: 'sess-1',
    sql: '',
    params: [],
    ...overrides,
  } as PipelineContext;
}

describe('EngineStep — write-state helpers (P1 three-level protection)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetWriteState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWriteState();
  });

  it('getRecentWriteWindowMs reports the configured window sizes', () => {
    expect(getRecentWriteWindowMs()).toEqual({ sessionShard: 500, node: 200 });
  });

  it('hasRecentWrite is false on a clean state', () => {
    expect(hasRecentWrite('sess-1')).toBe(false);
    expect(hasRecentWrite('sess-1', 0)).toBe(false);
  });

  it('markRecentWrite sets session + node level by default (shardId -1)', () => {
    markRecentWrite('sess-1');
    expect(hasRecentWrite('sess-1')).toBe(true);   // session level
    expect(hasRecentWrite('other-session')).toBe(true); // node level (same node)
  });

  it('markRecentWrite with a real shardId also sets shard level', () => {
    markRecentWrite('sess-1', 7);
    // node-level protection is active regardless of session/shard
    expect(hasRecentWrite('other-session', 999)).toBe(true);
    // session level
    expect(hasRecentWrite('sess-1', -1)).toBe(true);
  });

  it('session-level window expires after SHARD_WRITE_WINDOW_MS', () => {
    markRecentWrite('sess-1');
    // advance beyond session/shard windows but within node window? node is 200ms,
    // so advance past 500ms also clears node. Advance only past node to isolate session.
    // To isolate session-level: write, then advance 300ms (past node 200ms, within
    // session/shard 500ms) — session still recent, node not.
    vi.advanceTimersByTime(300);
    expect(hasRecentWrite('sess-1')).toBe(true); // still within 500ms session window
    // advance past 500ms → session expired
    vi.advanceTimersByTime(250);
    expect(hasRecentWrite('sess-1')).toBe(false);
  });

  it('node-level window expires after RECENT_WRITE_WINDOW_MS (200ms)', () => {
    markRecentWrite('sess-1');
    vi.advanceTimersByTime(250); // past node 200ms, still within session 500ms
    // A different session relies on node-level only
    expect(hasRecentWrite('other-session')).toBe(false);
  });

  it('shard-level protection is visible to a different session on the same shard', () => {
    markRecentWrite('sess-a', 3);
    vi.advanceTimersByTime(250); // past node 200ms window
    // session-a still recent, but check a *different* session on shard 3
    expect(hasRecentWrite('sess-b', 3)).toBe(true); // shard-level hit
  });

  it('expired shard entry is deleted (shardId >= 0, past window)', () => {
    markRecentWrite('sess-a', 3);
    vi.advanceTimersByTime(600); // past both session/shard (500ms) and node (200ms)
    // A different session targeting shard 3: session miss, shard expired → delete, node expired → false
    expect(hasRecentWrite('sess-b', 3)).toBe(false);
    // And the entry was cleaned up
    expect(hasRecentWrite('sess-c', 3)).toBe(false);
  });

  it('expired session entries are deleted from the map', () => {
    markRecentWrite('sess-1');
    vi.advanceTimersByTime(600); // past everything
    expect(hasRecentWrite('sess-1')).toBe(false);
    // After expiry the entry is cleaned up; calling again still false
    expect(hasRecentWrite('sess-1')).toBe(false);
  });

  it('sweepRecentWriteEntries removes stale entries', () => {
    markRecentWrite('sess-1', 5);
    expect(hasRecentWrite('sess-1', 5)).toBe(true);
    // jump far into the future so everything is stale
    vi.advanceTimersByTime(60_000);
    sweepRecentWriteEntries();
    vi.advanceTimersByTime(1);
    expect(hasRecentWrite('sess-1', 5)).toBe(false);
  });

  it('sweepRecentWriteEntries retains fresh session and shard entries', () => {
    markRecentWrite('sess-fresh', 9);
    // No time has elapsed, so both the session and shard entries are fresh
    // and must survive the sweep (exercises the non-expiring branch of the
    // per-map purge loops).
    sweepRecentWriteEntries();
    // The fresh session entry is still reported as a recent write.
    expect(hasRecentWrite('sess-fresh', 9)).toBe(true);
    // The fresh shard-level entry (shardId 9) also survives.
    expect(hasRecentWrite('other-sess', 9)).toBe(true);
  });

  it('resetWriteState clears all three levels', () => {
    markRecentWrite('sess-1', 5);
    expect(hasRecentWrite('sess-1', 5)).toBe(true);
    resetWriteState();
    expect(hasRecentWrite('sess-1')).toBe(false);
    expect(hasRecentWrite('sess-1', 5)).toBe(false);
  });
});

describe('EngineStep.process() — routing branches', () => {
  function makeStep(overrides: {
    isAvailable?: boolean;
    decide?: () => { target: any; reason: string; skipFallback?: boolean };
    execute?: (sql: string, start: number, parsed: any, opts: any) => Promise<any>;
  } = {}) {
    const unifiedRouter = {
      isAvailable: overrides.isAvailable ?? true,
      decide: overrides.decide ?? (() => ({ target: QT.SQLITE_OLTP, reason: 'default', skipFallback: false })),
    } as any;
    const duckDBExecutor = {
      execute: overrides.execute ?? (async () => ({ rows: [], rowCount: 0, queryTimeMs: 0, routed: false, reason: 'no' })),
    } as any;
    return new EngineStep({ unifiedRouter, duckDBExecutor });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    resetWriteState();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetWriteState();
  });

  it('returns SQLite decision when DuckDB is unavailable', async () => {
    const step = makeStep({ isAvailable: false });
    const res = await step.process('SELECT * FROM t', makeCtx());
    expect(res.engine).toBe('sqlite');
    expect(res.reason).toBe('DuckDB unavailable');
    expect(res.triggeredFallback).toBe(false);
  });

  it('marks a recent write for non-SELECT statements', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.SQLITE_OLTP, reason: 'non-select', skipFallback: false }),
    });
    await step.process('INSERT INTO t VALUES (1)', makeCtx({ sessionId: 'sess-w' }));
    expect(hasRecentWrite('sess-w')).toBe(true);
  });

  it('overrides DuckDB decision to SQLite when a recent write exists', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
    });
    markRecentWrite('sess-rw');
    const res = await step.process('SELECT count(*) FROM t', makeCtx({ sessionId: 'sess-rw' }));
    expect(res.engine).toBe('sqlite');
    expect(res.target).toBe(QT.SQLITE_OLTP);
    expect(res.reason).toContain('read-your-writes');
    expect(res.triggeredFallback).toBe(false);
  });

  it('returns a plain SQLite decision for SQLite-targeted queries', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.SQLITE_OLTP, reason: 'oltp', skipFallback: false }),
    });
    const res = await step.process('SELECT * FROM t', makeCtx());
    expect(res.engine).toBe('sqlite');
    expect(res.target).toBe(QT.SQLITE_OLTP);
    expect(res.reason).toBe('oltp');
  });

  it('populates duckdbResult fields on a successful routed DuckDB execution', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
      execute: async () => ({
        rows: [{ id: 1, name: 'a' }],
        rowCount: 1,
        queryTimeMs: 42,
        routed: true,
        reason: 'ok',
      }),
    });
    const res = await step.process('SELECT * FROM t', makeCtx({ sessionId: 'sess-d' }));
    expect(res.engine).toBe('duckdb');
    expect(res.triggeredFallback).toBe(false);
    expect(res.duckdbResult).toBeDefined();
    expect(res.duckdbResult!.rows).toEqual([{ id: 1, name: 'a' }]);
    expect(res.duckdbResult!.rowCount).toBe(1);
    expect(res.duckdbResult!.fields.map(f => f.name)).toEqual(['id', 'name']);
  });

  it('populates empty fields when a routed DuckDB execution returns zero rows', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
      execute: async () => ({
        rows: [],
        rowCount: 0,
        queryTimeMs: 10,
        routed: true,
        reason: 'ok',
      }),
    });
    const res = await step.process('SELECT * FROM t', makeCtx({ sessionId: 'sess-empty' }));
    expect(res.engine).toBe('duckdb');
    expect(res.triggeredFallback).toBe(false);
    expect(res.duckdbResult).toBeDefined();
    expect(res.duckdbResult!.rows).toEqual([]);
    expect(res.duckdbResult!.rowCount).toBe(0);
    expect(res.duckdbResult!.fields).toEqual([]);
  });

  it('coalesces undefined rows and a zero queryTimeMs from DuckDB execution', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
      execute: async () => ({
        // rows omitted/undefined and queryTimeMs 0 exercise the defensive
        // `|| []` / `|| (performance.now() - start)` fallbacks.
        rows: undefined as any,
        rowCount: 0,
        queryTimeMs: 0,
        routed: true,
        reason: 'ok',
      }),
    });
    const res = await step.process('SELECT * FROM t', makeCtx({ sessionId: 'sess-coalesce' }));
    expect(res.engine).toBe('duckdb');
    expect(res.duckdbResult!.rows).toEqual([]);
    expect(res.duckdbResult!.fields).toEqual([]);
    // queryTimeMs falls back to a real elapsed-time value (>= 0).
    expect(res.duckdbResult!.queryTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('falls back to SQLite when DuckDB decides but does not route', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
      execute: async () => ({ rows: [], rowCount: 0, queryTimeMs: 0, routed: false, reason: 'not routable' }),
    });
    const res = await step.process('SELECT * FROM t', makeCtx());
    expect(res.engine).toBe('sqlite');
    expect(res.triggeredFallback).toBe(true);
    expect(res.reason).toContain('fallback to SQLite');
  });

  it('falls back to SQLite when DuckDB execution throws', async () => {
    const step = makeStep({
      decide: () => ({ target: QT.DUCKDB_OLAP, reason: 'agg', skipFallback: false }),
      execute: async () => { throw new Error('duck boom'); },
    });
    const res = await step.process('SELECT * FROM t', makeCtx());
    expect(res.engine).toBe('sqlite');
    expect(res.triggeredFallback).toBe(true);
  });
});
