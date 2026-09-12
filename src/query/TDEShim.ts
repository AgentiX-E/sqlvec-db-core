/**
 * TDEShim — Transparent Data Encryption (TDE) compatibility shim for SQLite.
 *
 * These are intentional stubs: TDE is not implemented at the SQL-rewrite layer
 * yet. Every detector reports "no match" and every rewriter returns the input
 * unchanged, so QueryRouter's TDE branch stays inert until a real implementation
 * lands.
 */

export type TDEKind = 'pgcrypto' | 'file' | 'none';

export interface TDEResult {
  /** The (possibly rewritten) SQL. */
  sql: string;
  /** Whether the SQL was rewritten. */
  rewritten: boolean;
  /** The detected TDE key (if a SET tde.key statement was recognized). */
  key?: string;
}

export function detectTDE(_sql?: string): boolean {
  return false;
}

export function rewriteTDE(s: string): TDEResult {
  return { sql: s, rewritten: false };
}

export function detectTDESql(_sql?: string): boolean {
  return false;
}

/**
 * Detects and (in future) rewrites `SET tde.key = ...` statements.
 * Currently a stub that returns an inert result so QueryRouter can access
 * `rewritten`/`key`/`sql` without a TypeError.
 */
export function detectSetTDE(s: string): TDEResult {
  return { sql: s, rewritten: false };
}
