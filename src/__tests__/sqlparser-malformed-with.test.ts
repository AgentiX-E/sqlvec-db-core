import { describe, it, expect } from 'vitest';
import { parseStatement } from '../query/SqlParser';

// A malformed WITH clause that lacks `AS (` (so no CTE body can be located)
// resolves to UNKNOWN rather than throwing, exercising extractMainQueryAfterWith's
// not-found guard.
describe('SqlParser malformed WITH clause', () => {
  it('returns UNKNOWN for a WITH with no AS (...) body', () => {
    expect((parseStatement('WITH c SELECT 1') as any).type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a WITH with AS but no parenthesized body', () => {
    expect((parseStatement('WITH c AS SELECT 1') as any).type).toBe('UNKNOWN');
  });

  it('returns UNKNOWN for a bare WITH RECURSIVE with no body', () => {
    expect((parseStatement('WITH RECURSIVE t') as any).type).toBe('UNKNOWN');
  });
});
