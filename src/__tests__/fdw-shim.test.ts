/**
 * fdw-shim.test.ts — Coverage tests for FdwShim (PostgreSQL Foreign Data
 * Wrapper compatibility shim).
 */

import { describe, it, expect } from 'vitest';
import { detectFdw, rewriteFdw } from '../query/FdwShim';

describe('detectFdw', () => {
  it('returns false for non-string input', () => {
    expect(detectFdw(undefined as unknown as string)).toBe(false);
    expect(detectFdw(null as unknown as string)).toBe(false);
    expect(detectFdw(42 as unknown as string)).toBe(false);
  });

  it('returns false for empty/whitespace string', () => {
    expect(detectFdw('')).toBe(false);
    expect(detectFdw('   ')).toBe(false);
  });

  it('returns false for unrelated SQL', () => {
    expect(detectFdw('SELECT * FROM users')).toBe(false);
    expect(detectFdw('CREATE TABLE users (id int)')).toBe(false);
  });

  it('detects all seven FDW statement families', () => {
    expect(detectFdw('CREATE FOREIGN DATA WRAPPER ldap')).toBe(true);
    expect(detectFdw('CREATE SERVER auth FOREIGN DATA WRAPPER ldap')).toBe(true);
    expect(detectFdw('CREATE FOREIGN TABLE users (id int) SERVER auth')).toBe(true);
    expect(detectFdw('ALTER SERVER auth VERSION "1.0"')).toBe(true);
    expect(detectFdw('DROP FOREIGN DATA WRAPPER ldap')).toBe(true);
    expect(detectFdw('DROP SERVER auth')).toBe(true);
    expect(detectFdw('DROP FOREIGN TABLE remote_users')).toBe(true);
  });
});

describe('rewriteFdw', () => {
  it('returns passthrough for non-string input', () => {
    expect(rewriteFdw(undefined as unknown as string)).toEqual({ sql: '', rewritten: false });
    expect(rewriteFdw(null as unknown as string)).toEqual({ sql: '', rewritten: false });
  });

  it('returns passthrough for empty string', () => {
    expect(rewriteFdw('')).toEqual({ sql: '', rewritten: false });
  });

  it('passes through unrelated SQL', () => {
    expect(rewriteFdw('SELECT 1')).toEqual({ sql: 'SELECT 1', rewritten: false });
  });

  it('rewrites CREATE FOREIGN DATA WRAPPER to SELECT 1', () => {
    expect(rewriteFdw('CREATE FOREIGN DATA WRAPPER ldap VALIDATOR ldap_fdw_validator')).toEqual({
      sql: 'SELECT 1',
      rewritten: true,
    });
  });

  it('rewrites DROP FOREIGN DATA WRAPPER to SELECT 1', () => {
    expect(rewriteFdw('DROP FOREIGN DATA WRAPPER ldap')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites CREATE SERVER to SELECT 1', () => {
    expect(rewriteFdw('CREATE SERVER auth FOREIGN DATA WRAPPER ldap')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites ALTER SERVER to SELECT 1', () => {
    expect(rewriteFdw('ALTER SERVER auth VERSION \'1.0\'')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites DROP SERVER to SELECT 1', () => {
    expect(rewriteFdw('DROP SERVER auth CASCADE')).toEqual({ sql: 'SELECT 1', rewritten: true });
  });

  it('rewrites CREATE FOREIGN TABLE to CREATE TABLE', () => {
    expect(rewriteFdw('CREATE FOREIGN TABLE users (id int, name text) SERVER auth')).toEqual({
      sql: 'CREATE TABLE users (id int, name text)',
      rewritten: true,
    });
  });

  it('strips column-level OPTIONS and trailing SERVER OPTIONS', () => {
    expect(
      rewriteFdw("CREATE FOREIGN TABLE t (uid int OPTIONS (secret 'val')) SERVER s OPTIONS (url 'ldap://')"),
    ).toEqual({
      sql: 'CREATE TABLE t (uid int)',
      rewritten: true,
    });
  });

  it('handles CREATE FOREIGN TABLE with only SERVER (no OPTIONS)', () => {
    expect(rewriteFdw('CREATE FOREIGN TABLE t (id int) SERVER s')).toEqual({
      sql: 'CREATE TABLE t (id int)',
      rewritten: true,
    });
  });

  it('rewrites DROP FOREIGN TABLE to DROP TABLE', () => {
    expect(rewriteFdw('DROP FOREIGN TABLE remote_users')).toEqual({
      sql: 'DROP TABLE remote_users',
      rewritten: true,
    });
  });

  it('preserves IF EXISTS in DROP FOREIGN TABLE', () => {
    expect(rewriteFdw('DROP FOREIGN TABLE IF EXISTS remote_users CASCADE')).toEqual({
      sql: 'DROP TABLE IF EXISTS remote_users CASCADE',
      rewritten: true,
    });
  });
});
