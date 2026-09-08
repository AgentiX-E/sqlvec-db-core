import { describe, it, expect, afterEach, vi } from 'vitest';
import { MVCCExecutor } from '../query/MVCCExecutor';

let exec: MVCCExecutor | null = null;
function makeExec(config?: Parameters<MVCCExecutor['constructor']>[0]): MVCCExecutor {
  const e = new MVCCExecutor(config);
  exec = e;
  return e;
}
afterEach(() => { exec?.dispose(); exec = null; });

describe('MVCCExecutor config default fallback when explicitly undefined', () => {
  it('commit uses ?? defaults when config fields explicitly undefined', () => {
    // Explicitly pass undefined to override DEFAULT_CONFIG fields → triggers
    // the nullish-coalescing fallback (maxRowVersions ?? 100_000, etc.).
    const e = makeExec({ maxRowVersions: undefined, rowVersionGcThreshold: undefined });
    e.begin('a', 'READ_COMMITTED', false);
    const r = e.commit('a');
    expect(r.success).toBe(true);
  });

  it('gcRowVersions uses ?? defaults when explicitly undefined', () => {
    const e = makeExec({ maxRowVersions: undefined, rowVersionGcThreshold: undefined });
    expect(e.gcRowVersions(true)).toBe(0);
  });

  it('getBackoffMs uses backoffBaseMs ?? 10 when explicitly undefined', () => {
    const e = makeExec({ backoffBaseMs: undefined });
    e.begin('a', 'READ_COMMITTED', false);
    (e as any).conflictStats.set('a', { totalRetries: 2 });
    expect((e as any).getBackoffMs('a')).toBe(20);
  });
});
