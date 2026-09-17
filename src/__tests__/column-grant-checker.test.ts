import { describe, it, expect, beforeEach } from 'vitest';
import { ColumnGrantChecker } from '../security/ColumnGrantChecker';

describe('ColumnGrantChecker', () => {
  let checker: ColumnGrantChecker;

  beforeEach(() => {
    checker = new ColumnGrantChecker();
  });

  describe('default state', () => {
    it('is ready by default (as a boolean field, not a method)', () => {
      expect(checker.isReady).toBe(true);
    });

    it('fails closed: an un-granted column is denied', () => {
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(false);
    });

    it('reports no grants initially', () => {
      expect(checker.hasAnyGrants()).toBe(false);
    });
  });

  describe('grant and check', () => {
    it('grants a single privilege on multiple columns', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email', 'phone']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(true);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'phone')).toBe(true);
    });

    it('does not leak a grant across privileges', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'INSERT', 'email')).toBe(false);
    });

    it('does not leak a grant across users', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.checkColumnPrivilege('bob', 'users', 'SELECT', 'email')).toBe(false);
    });

    it('does not leak a grant across tables', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'orders', 'SELECT', 'email')).toBe(false);
    });

    it('matches identifiers case-insensitively', () => {
      checker.grantColumnPrivilege('Alice', 'Users', 'select', ['Email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(true);
      expect(checker.checkColumnPrivilege('ALICE', 'USERS', 'SELECT', 'EMAIL')).toBe(true);
    });

    it('accumulates privileges for the same column across grants', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      checker.grantColumnPrivilege('alice', 'users', 'UPDATE', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(true);
      expect(checker.checkColumnPrivilege('alice', 'users', 'UPDATE', 'email')).toBe(true);
      expect(checker.checkColumnPrivilege('alice', 'users', 'INSERT', 'email')).toBe(false);
    });

    it('reports grants after recording', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.hasAnyGrants()).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('ignores an unsupported privilege keyword', () => {
      checker.grantColumnPrivilege('alice', 'users', 'DELETE', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'DELETE', 'email')).toBe(false);
      expect(checker.hasAnyGrants()).toBe(false);
    });

    it('ignores empty column names inside the list', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email', '', '  ', 'phone']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(true);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'phone')).toBe(true);
    });

    it('ignores an empty column list entirely', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', []);
      expect(checker.hasAnyGrants()).toBe(false);
    });

    it('denies an unsupported operation in checkColumnPrivilege', () => {
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'TRUNCATE', 'email')).toBe(false);
    });

    it('remains fail-closed when isReady is toggled off', () => {
      // `isReady` gates enforcement at the caller; the checker itself still
      // answers authoritatively here, but callers read the field to decide.
      checker.isReady = false;
      expect(checker.isReady).toBe(false);
      checker.grantColumnPrivilege('alice', 'users', 'SELECT', ['email']);
      expect(checker.checkColumnPrivilege('alice', 'users', 'SELECT', 'email')).toBe(true);
    });
  });
});
