import { describe, it, expect } from 'vitest';
import { ScopedConnection } from '../query/ScopedConnection';
import { ColumnGrantChecker } from '../security/ColumnGrantChecker';

// ScopedConnection holds per-session user identity and column-grant state so
// concurrent sessions never share mutable user context.
describe('ScopedConnection', () => {
  it('defaults the user to "public" (lowercased)', () => {
    const sc = new ScopedConnection();
    expect(sc.user).toBe('public');
  });

  it('lowercases a provided user', () => {
    const sc = new ScopedConnection({ user: 'ADMIN' });
    expect(sc.user).toBe('admin');
  });

  it('defaults columnGrantChecker to null', () => {
    const sc = new ScopedConnection();
    expect(sc.columnGrantChecker).toBeNull();
  });

  it('accepts a provided column grant checker', () => {
    const checker = new ColumnGrantChecker();
    const sc = new ScopedConnection({ columnGrantChecker: checker });
    expect(sc.columnGrantChecker).toBe(checker);
  });

  it('setUser lowercases the new value', () => {
    const sc = new ScopedConnection();
    sc.setUser('Bob');
    expect(sc.user).toBe('bob');
  });

  it('isPrivilegedUser is false for public and true otherwise', () => {
    const sc = new ScopedConnection();
    expect(sc.isPrivilegedUser).toBe(false);
    sc.setUser('admin');
    expect(sc.isPrivilegedUser).toBe(true);
  });

  describe('hasColumnGrants', () => {
    it('is false without a checker', () => {
      const sc = new ScopedConnection({ user: 'alice' });
      expect(sc.hasColumnGrants).toBe(false);
    });

    it('is false when the checker is not ready', () => {
      const checker = new ColumnGrantChecker();
      checker.isReady = false;
      const sc = new ScopedConnection({ user: 'alice', columnGrantChecker: checker });
      expect(sc.hasColumnGrants).toBe(false);
    });

    it('is false for the public user even with a ready checker', () => {
      const checker = new ColumnGrantChecker();
      const sc = new ScopedConnection({ columnGrantChecker: checker });
      expect(sc.hasColumnGrants).toBe(false);
    });

    it('is true for a non-public user with a ready checker', () => {
      const checker = new ColumnGrantChecker();
      const sc = new ScopedConnection({ user: 'alice', columnGrantChecker: checker });
      expect(sc.hasColumnGrants).toBe(true);
    });
  });

  describe('clone', () => {
    it('preserves user and shares the column grant checker reference', () => {
      const checker = new ColumnGrantChecker();
      const sc = new ScopedConnection({ user: 'alice', columnGrantChecker: checker });
      const copy = sc.clone();
      expect(copy.user).toBe('alice');
      expect(copy.columnGrantChecker).toBe(checker);
    });

    it('produces an independent scope (mutating user does not affect the source)', () => {
      const sc = new ScopedConnection({ user: 'alice' });
      const copy = sc.clone();
      copy.setUser('bob');
      expect(sc.user).toBe('alice');
      expect(copy.user).toBe('bob');
    });
  });
});
