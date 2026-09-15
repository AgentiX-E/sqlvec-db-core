import { describe, it, expect, beforeEach } from 'vitest';
import { GucSystem } from '../core/GucSystem';
import {
  QUERY_HINT_GUCS,
  detectQueryHint,
  rewriteQueryHint,
  detectQueryHintGuc,
  executeQueryHintGuc,
  getQueryHintGucValue,
  isPlannerMethodEnabled,
} from '../query/QueryHintShim';

describe('detectQueryHint', () => {
  it('detects a hint comment', () => {
    expect(detectQueryHint('SELECT /*+ SeqScan(t) */ * FROM t')).toBe(true);
  });

  it('returns false when no hint is present', () => {
    expect(detectQueryHint('SELECT * FROM t')).toBe(false);
  });

  it('returns false for a plain (non-hint) comment', () => {
    expect(detectQueryHint('SELECT /* regular */ * FROM t')).toBe(false);
  });

  it('returns false for non-string input', () => {
    expect(detectQueryHint(undefined as unknown as string)).toBe(false);
  });

  it('does not leak lastIndex across calls (BUG #115)', () => {
    // First call matches a hint and advances a shared `g` cursor; the second call has
    // its hint at the very start, before any stale cursor position would begin from.
    expect(detectQueryHint('SELECT /*+ SeqScan(t) */ * FROM t')).toBe(true);
    expect(detectQueryHint('/*+ HashJoin(a b) */ SELECT * FROM t')).toBe(true);
    expect(detectQueryHint('SELECT * FROM t')).toBe(false);
  });
});

describe('rewriteQueryHint', () => {
  it('strips hint comments, preserving surrounding SQL', () => {
    expect(rewriteQueryHint('SELECT /*+ SeqScan(t) */ * FROM t')).toEqual({
      sql: 'SELECT  * FROM t',
      rewritten: true,
    });
  });

  it('strips multiple hint comments', () => {
    const r = rewriteQueryHint('SELECT /*+ SeqScan(t) */ * /*+ HashJoin(a b) */ FROM t');
    expect(r.rewritten).toBe(true);
    expect(r.sql).not.toContain('/*+');
  });

  it('preserves non-hint comments', () => {
    const r = rewriteQueryHint('SELECT /* regular */ * FROM t');
    expect(r).toEqual({ sql: 'SELECT /* regular */ * FROM t', rewritten: false });
  });

  it('returns unchanged for no hints', () => {
    expect(rewriteQueryHint('SELECT * FROM t')).toEqual({
      sql: 'SELECT * FROM t',
      rewritten: false,
    });
  });

  it('returns unchanged for empty or non-string input', () => {
    expect(rewriteQueryHint('')).toEqual({ sql: '', rewritten: false });
    expect(rewriteQueryHint(undefined as unknown as string)).toEqual({
      sql: undefined,
      rewritten: false,
    });
  });
});

describe('detectQueryHintGuc', () => {
  it('detects SET of a supported GUC', () => {
    expect(detectQueryHintGuc('SET enable_hashjoin = off')).toBe(true);
  });

  it('detects SHOW of a supported GUC', () => {
    expect(detectQueryHintGuc('SHOW enable_hashjoin')).toBe(true);
  });

  it('rejects unsupported GUCs and unrelated statements', () => {
    expect(detectQueryHintGuc('SET work_mem = 64MB')).toBe(false);
    expect(detectQueryHintGuc('SELECT 1')).toBe(false);
  });

  it('returns false for empty and non-string input', () => {
    expect(detectQueryHintGuc('')).toBe(false);
    expect(detectQueryHintGuc(undefined as unknown as string)).toBe(false);
  });
});

describe('executeQueryHintGuc', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('SET registers a new GUC and rewrites to SELECT 1', () => {
    const r = executeQueryHintGuc('SET enable_hashjoin = off');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe('SELECT 1');
    expect(r.gucName).toBe('enable_hashjoin');
    expect(r.gucValue).toBe('off');
  });

  it('SET of an already-registered GUC updates via handleSet', () => {
    guc.registry.register({ name: 'enable_hashjoin', value: 'on' });
    const r = executeQueryHintGuc('SET enable_hashjoin = off');
    expect(r.rewritten).toBe(true);
    expect(guc.registry.get('enable_hashjoin')?.value).toBe('off');
  });

  it('SHOW reads the stored value', () => {
    executeQueryHintGuc('SET enable_hashjoin = off');
    const r = executeQueryHintGuc('SHOW enable_hashjoin');
    expect(r.rewritten).toBe(true);
    expect(r.sql).toBe("SELECT 'off' as enable_hashjoin");
    expect(r.gucValue).toBe('off');
  });

  it('SHOW defaults to on for an unset GUC', () => {
    const r = executeQueryHintGuc('SHOW enable_hashjoin');
    expect(r.rewritten).toBe(true);
    expect(r.gucValue).toBe('on');
  });

  it('rejects unsupported GUC names with pass-through', () => {
    const r = executeQueryHintGuc('SET work_mem = 64MB');
    expect(r.rewritten).toBe(false);
  });

  it('rejects a prefix-matching but unsupported GUC name', () => {
    // `enable_foobar` matches SET_GUC_RE's `enable_\w+` prefix but is not in
    // QUERY_HINT_GUCS, exercising the `isQueryHintGuc` guard inside SET.
    const r = executeQueryHintGuc('SET enable_foobar = on');
    expect(r.rewritten).toBe(false);
    expect(r.sql).toBe('SET enable_foobar = on');
    // Same for the SHOW guard.
    const s = executeQueryHintGuc('SHOW enable_foobar');
    expect(s.rewritten).toBe(false);
    expect(s.sql).toBe('SHOW enable_foobar');
  });

  it('returns unchanged for empty and non-string input', () => {
    expect(executeQueryHintGuc('')).toEqual({ sql: '', rewritten: false });
    expect(executeQueryHintGuc(undefined as unknown as string)).toEqual({
      sql: undefined,
      rewritten: false,
    });
  });

  it('accepts an injected GucSystem instance', () => {
    const other = new GucSystem();
    const r = executeQueryHintGuc('SET enable_seqscan = off', other);
    expect(r.rewritten).toBe(true);
    expect(other.registry.get('enable_seqscan')?.value).toBe('off');
  });
});

describe('getQueryHintGucValue', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('returns the stored value', () => {
    executeQueryHintGuc('SET enable_hashjoin = off');
    expect(getQueryHintGucValue('enable_hashjoin')).toBe('off');
  });

  it('returns on for an unsupported or unset name', () => {
    expect(getQueryHintGucValue('enable_hashjoin')).toBe('on');
    expect(getQueryHintGucValue('work_mem')).toBe('on');
  });
});

describe('isPlannerMethodEnabled', () => {
  let guc: GucSystem;

  beforeEach(() => {
    guc = GucSystem.getInstance();
    guc.registry.resetAllToDefaults();
  });

  it('returns true by default (unset = on)', () => {
    expect(isPlannerMethodEnabled('enable_hashjoin')).toBe(true);
  });

  it('returns false when explicitly off', () => {
    executeQueryHintGuc('SET enable_hashjoin = off');
    expect(isPlannerMethodEnabled('enable_hashjoin')).toBe(false);
  });

  it('returns true for unsupported names (default on)', () => {
    expect(isPlannerMethodEnabled('work_mem')).toBe(true);
  });
});

describe('QUERY_HINT_GUCS', () => {
  it('is a non-empty set of planner GUCs', () => {
    expect(QUERY_HINT_GUCS.length).toBeGreaterThan(0);
    expect(QUERY_HINT_GUCS).toContain('enable_hashjoin');
    expect(QUERY_HINT_GUCS).toContain('enable_seqscan');
  });
});
