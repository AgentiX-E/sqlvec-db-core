/**
 * Legacy error alias tests.
 *
 * `src/error/DatabaseError.ts` is a minimal compatibility shim that re-exports
 * a `DatabaseError` (and an alias `SqlVecError`) so that modules which imported
 * the singular `error/` path keep working after the move to `errors/`.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseError, SqlVecError } from '../error/DatabaseError';

describe('legacy error shim', () => {
  it('constructs a DatabaseError with a message', () => {
    const err = new DatabaseError('boom');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts an optional code argument without error', () => {
    const err = new DatabaseError('boom', 'XX000');
    expect(err.message).toBe('boom');
  });

  it('exposes SqlVecError as an alias of DatabaseError', () => {
    expect(SqlVecError).toBe(DatabaseError);
  });
});
