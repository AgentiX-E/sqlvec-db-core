import { describe, it, expect } from 'vitest';
import {
  parseStatement,
  extractWindowFunctions,
  rewriteFTS,
} from '../query/SqlParser';

// Cover defensive/boundary returns that are reachable but previously untested:
// empty SQL → UNKNOWN, unsupported statement type → UNKNOWN (switch default),
// parameterized LIMIT, fallback window extraction, and FTS no-op rewrite.
describe('SqlParser boundary returns', () => {
  it('empty SQL returns UNKNOWN', () => {
    const r = parseStatement('');
    expect(r.type).toBe('UNKNOWN');
  });

  it('unsupported statement (SET) falls through switch default to UNKNOWN', () => {
    const r = parseStatement('SET search_path TO x');
    expect(r.type).toBe('UNKNOWN');
  });

  it('parameterized LIMIT $1 yields undefined limit', () => {
    const r = parseStatement('SELECT * FROM t LIMIT $1') as any;
    expect(r.type).toBe('SELECT');
    expect(r.limit).toBeUndefined();
  });

  it('extractWindowFunctions falls back to [] on invalid SQL', () => {
    expect(extractWindowFunctions('SELECT FROM')).toEqual([]);
  });

  it('rewriteFTS returns SQL unchanged when no FTS present', () => {
    expect(rewriteFTS('SELECT * FROM t')).toBe('SELECT * FROM t');
  });
});
