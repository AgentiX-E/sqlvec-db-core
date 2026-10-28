/**
 * Unit tests for the flexible-quorum helpers in types-raw.ts.
 *
 * `majorityQuorum` and `resolveFlexibleQuorumConfig` are pure functions whose
 * `??` fallbacks were previously untested — leaving several branch directions
 * uncovered. These tests exercise both sides of every `??` / optional-chain
 * branch and verify PostgreSQL-style majority semantics.
 */
import { describe, it, expect } from 'vitest';
import { majorityQuorum, resolveFlexibleQuorumConfig } from '../types/types-raw';

describe('majorityQuorum', () => {
  it('computes floor(n/2)+1 for odd node counts', () => {
    expect(majorityQuorum(1)).toBe(1);
    expect(majorityQuorum(3)).toBe(2);
    expect(majorityQuorum(5)).toBe(3);
    expect(majorityQuorum(7)).toBe(4);
  });

  it('computes floor(n/2)+1 for even node counts', () => {
    expect(majorityQuorum(2)).toBe(2);
    expect(majorityQuorum(4)).toBe(3);
    expect(majorityQuorum(6)).toBe(4);
  });

  it('handles zero nodes', () => {
    expect(majorityQuorum(0)).toBe(1);
  });
});

describe('resolveFlexibleQuorumConfig', () => {
  it('applies all defaults when config is undefined', () => {
    const cfg = resolveFlexibleQuorumConfig(undefined, 5);
    expect(cfg).toEqual({ writeQuorum: 3, readQuorum: 1, commitQuorum: 3 });
  });

  it('applies all defaults when config is an empty object', () => {
    const cfg = resolveFlexibleQuorumConfig({}, 3);
    expect(cfg).toEqual({ writeQuorum: 2, readQuorum: 1, commitQuorum: 2 });
  });

  it('overrides every field when fully specified', () => {
    const cfg = resolveFlexibleQuorumConfig(
      { writeQuorum: 4, readQuorum: 2, commitQuorum: 5 },
      3,
    );
    expect(cfg).toEqual({ writeQuorum: 4, readQuorum: 2, commitQuorum: 5 });
  });

  it('falls back per-field for a partial config', () => {
    // writeQuorum provided, readQuorum/commitQuorum fall back to defaults
    const cfg = resolveFlexibleQuorumConfig({ writeQuorum: 2 }, 4);
    expect(cfg).toEqual({ writeQuorum: 2, readQuorum: 1, commitQuorum: 3 });
  });

  it('defaults total to 5', () => {
    const cfg = resolveFlexibleQuorumConfig();
    expect(cfg).toEqual({ writeQuorum: 3, readQuorum: 1, commitQuorum: 3 });
  });
});
